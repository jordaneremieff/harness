import assert from "node:assert/strict";
import { it } from "node:test";
import { BROWSERS, type AccessMap } from "./browsers.ts";
import {
	type BrowserDeps,
	type BrowserResult,
	browserAct,
	browserCapture,
	browserEvaluate,
	browserInspect,
	browserTabs,
	type CaptureDeps,
} from "./operations.ts";
import { type OsaReply, type OsaRequest, TransportError } from "./osa.ts";
import { decodeRect } from "./session.ts";

type RunOptions = { signal?: AbortSignal; timeoutMs: number };
type Run = (request: OsaRequest, options: RunOptions) => Promise<OsaReply>;
type Handler = (request: OsaRequest) => OsaReply | Promise<OsaReply>;

interface Fixture {
	deps: BrowserDeps;
	requests: OsaRequest[];
}

interface FakeOptions {
	access?: AccessMap;
	platform?: string;
	processArgs?: (pid: number, signal?: AbortSignal) => Promise<string | null>;
	capture?: CaptureDeps["capture"];
	resize?: CaptureDeps["resize"];
	save?: CaptureDeps["save"];
	now?: () => number;
}

function fakes(run: Run, options: FakeOptions = {}): Fixture {
	const requests: OsaRequest[] = [];
	const deps: BrowserDeps = {
		run: (request, runOptions) => {
			requests.push(request);
			return run(request, runOptions);
		},
		readAccess: () => options.access ?? {},
		platform: options.platform ?? "darwin",
		processArgs: options.processArgs ?? (async () => null),
		capture: options.capture ?? (async () => Buffer.from("png")),
		resize:
			options.resize ??
			(async () => ({
				data: "aW1hZ2U=",
				mimeType: "image/png",
				width: 2,
				height: 1,
				originalWidth: 4,
				originalHeight: 2,
			})),
		save: options.save ?? (async () => undefined),
		now: options.now ?? (() => Date.now()),
	};
	return { deps, requests };
}

function runFrom(handlers: Partial<Record<string, Handler>>): Run {
	return async (request) => {
		const handler = handlers[request.op];
		if (!handler) throw new Error(`unexpected op ${request.op}`);
		return handler(request);
	};
}

const ok = (value: unknown): OsaReply => ({ ok: true, value });
const fail = (
	code: string | null,
	number: number | null = null,
	message = `failure ${code ?? String(number)}`,
): OsaReply => ({
	ok: false,
	error: { code, number, message, extra: null },
});
const inventoryOf = (instances: Array<{ pid: number }>): OsaReply =>
	ok({ installed: null, instances: instances.map((item) => ({ hidden: false, active: false, ...item })) });
const windowsOf = (windows: unknown[]): OsaReply => ok({ windows });
const executed = (envelopeValue: unknown): OsaReply =>
	ok({ window: "1", url: "https://a.example/page", title: "Example", result: JSON.stringify(envelopeValue) });

const PAGE = { doc: "d1", url: "https://a.example/page", title: "Example", origin: "https://a.example" };

function scriptKind(request: OsaRequest): string {
	if (request.op !== "execute") return request.op;
	const script = String(request.script ?? "");
	if (script.includes("__pbRun")) return "start";
	if (script.includes("S.runs.get(id)")) return "evaluation-poll";
	if (script.includes("S.runs.delete(")) return "forget";
	if (script.includes("const O = ")) return "inspect";
	if (script.includes("const A = ")) return "action";
	if (script.includes("const P = ")) return "poll";
	return "other";
}

function obj(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map((item) => obj(item)) : [];
}

function reportOf(result: BrowserResult): Record<string, unknown> {
	return obj(result.details.report);
}

function blockedReason(result: BrowserResult): unknown {
	return obj(reportOf(result).blocked).reason;
}

function pollRequests(requests: OsaRequest[]): OsaRequest[] {
	return requests.filter((request) => scriptKind(request) === "poll");
}

/* ---------------------------------------------------------------- preconditions */

it("refuses before any Apple Event when access is not configured", async () => {
	const { deps, requests } = fakes(async () => inventoryOf([{ pid: 1 }]), { access: {} });
	const results = await Promise.all([
		browserInspect({ browser: "chrome", pid: 5, tab: "1" }, undefined, deps),
		browserAct(
			{ browser: "chrome", pid: 5, tab: "1", origin: "https://a.example", action: "click", selector: "#a" },
			undefined,
			deps,
		),
		browserEvaluate(
			{ browser: "chrome", pid: 5, tab: "1", origin: "https://a.example", expression: "1 + 1" },
			undefined,
			deps,
		),
		browserCapture({ browser: "chrome", pid: 5, tab: "1" }, undefined, deps),
	]);
	for (const result of results) {
		assert.equal(result.details.status, "blocked");
		assert.equal(blockedReason(result), "access-not-configured");
		assert.equal(result.isError, true);
	}
	assert.equal(requests.length, 0);
});

it("refuses on a non-macOS platform before any Apple Event", async () => {
	const { deps, requests } = fakes(async () => inventoryOf([{ pid: 1 }]), {
		platform: "linux",
		access: { chrome: "interact" },
	});
	const results = await Promise.all([
		browserTabs({ browser: "chrome" }, undefined, deps),
		browserInspect({ browser: "chrome", pid: 1, tab: "1" }, undefined, deps),
		browserAct(
			{ browser: "chrome", pid: 1, tab: "1", origin: "https://a.example", action: "click", selector: "#a" },
			undefined,
			deps,
		),
	]);
	for (const result of results) assert.equal(blockedReason(result), "unsupported-platform");
	assert.equal(requests.length, 0);
});

it("refuses an origin with a path before any Apple Event", async () => {
	const { deps, requests } = fakes(async () => inventoryOf([{ pid: 1 }]), { access: { chrome: "interact" } });
	const inspect = await browserInspect(
		{ browser: "chrome", pid: 1, tab: "1", origin: "https://a.example/path" },
		undefined,
		deps,
	);
	const capture = await browserCapture(
		{ browser: "chrome", pid: 1, tab: "1", origin: "https://a.example/path" },
		undefined,
		deps,
	);
	assert.equal(blockedReason(inspect), "invalid-origin");
	assert.equal(blockedReason(capture), "invalid-origin");
	assert.equal(requests.length, 0);
});

/* ---------------------------------------------------------------- process inventory */

it("refuses when the browser is not running and sends only an inventory read", async () => {
	const { deps, requests } = fakes(async () => inventoryOf([]), { access: { chrome: "interact" } });
	const result = await browserInspect({ browser: "chrome", pid: 1, tab: "1" }, undefined, deps);
	assert.equal(result.details.status, "blocked");
	assert.equal(blockedReason(result), "not-running");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].op, "inventory");
	assert.equal(requests[0].bundleId, BROWSERS.chrome.bundleId);
});

it("refuses an ambiguous process and lists both pids with their user data directories", async () => {
	const processArgs = async (pid: number) => (pid === 10 ? "--user-data-dir=/tmp/x --flag" : null);
	const { deps } = fakes(async () => inventoryOf([{ pid: 10 }, { pid: 11 }]), {
		access: { chrome: "interact" },
		processArgs,
	});
	const result = await browserTabs({ browser: "chrome" }, undefined, deps);
	assert.equal(blockedReason(result), "ambiguous-process");
	assert.deepEqual(list(obj(reportOf(result).blocked).instances), [
		{ pid: 10, userDataDir: "/tmp/x" },
		{ pid: 11, userDataDir: null },
	]);
});

it("refuses a pid that the inventory does not list", async () => {
	const { deps } = fakes(async () => inventoryOf([{ pid: 10 }]), { access: { chrome: "interact" } });
	const result = await browserInspect({ browser: "chrome", pid: 99, tab: "1" }, undefined, deps);
	assert.equal(blockedReason(result), "not-running");
	assert.deepEqual(obj(reportOf(result).blocked).running, [10]);
});

it("refuses every targeted operation when another process now owns the tab id", async () => {
	let running = [5];
	const run = runFrom({
		inventory: () => inventoryOf(running.map((pid) => ({ pid }))),
		windows: () =>
			windowsOf([
				{
					id: "1",
					index: 1,
					title: "Window",
					mode: "normal",
					minimized: false,
					visible: true,
					activeTabIndex: 1,
					tabs: [{ id: "42", url: "https://a.example/page", title: "Example", loading: false }],
				},
			]),
	});
	const captured: number[] = [];
	const saves: string[] = [];
	const { deps, requests } = fakes(run, {
		access: { chrome: "interact" },
		capture: async (windowNumber) => {
			captured.push(windowNumber);
			return Buffer.from("png");
		},
		save: async (path) => {
			saves.push(path);
		},
	});

	const first = await browserTabs({ browser: "chrome" }, undefined, deps);
	assert.equal(obj(reportOf(first)).pid, 5);
	const discovered = list(list(reportOf(first).windows)[0].tabs)[0];
	assert.equal(discovered.tab, "42");

	running = [9];
	const second = await browserTabs({ browser: "chrome" }, undefined, deps);
	assert.equal(obj(reportOf(second)).pid, 9, "the same tab id now belongs to another process");

	const before = requests.length;
	const target = { browser: "chrome" as const, pid: 5, tab: String(discovered.tab), origin: "https://a.example" };
	const results = [
		await browserInspect(target, undefined, deps),
		await browserAct({ ...target, action: "click", selector: "#save" }, undefined, deps),
		await browserEvaluate({ ...target, expression: "1 + 1" }, undefined, deps),
		await browserCapture({ ...target, savePath: "/tmp/browser-target-must-not-save.png" }, undefined, deps),
	];
	for (const result of results) {
		assert.equal(result.details.status, "blocked");
		assert.equal(blockedReason(result), "not-running");
		assert.deepEqual(obj(reportOf(result).blocked).running, [9]);
		assert.equal(obj(reportOf(result).target).pid, 5);
	}
	const after = requests.slice(before);
	assert.equal(
		after.filter(
			(request) =>
				request.op === "execute" || request.op === "window" || request.op === "windows" || request.op === "navigate",
		).length,
		0,
	);
	assert.deepEqual(captured, []);
	assert.deepEqual(saves, []);
});

/* ---------------------------------------------------------------- Apple Events failures */

it("maps a tab-not-found reply to a refusal", async () => {
	const run = runFrom({
		inventory: () => inventoryOf([{ pid: 5 }]),
		execute: () => fail("tab-not-found", null, "no such tab"),
	});
	const { deps, requests } = fakes(run, { access: { chrome: "inspect" } });
	const result = await browserInspect({ browser: "chrome", pid: 5, tab: "7" }, undefined, deps);
	assert.equal(result.details.status, "blocked");
	assert.equal(blockedReason(result), "tab-not-found");
	assert.equal(requests.length, 2);
});

it("maps Apple Events error 12 to the JavaScript setting with menu guidance", async () => {
	const run = runFrom({
		inventory: () => inventoryOf([{ pid: 5 }]),
		execute: () => fail(null, 12, "The command cannot be executed."),
	});
	const { deps } = fakes(run, { access: { chrome: "inspect" } });
	const result = await browserInspect({ browser: "chrome", pid: 5, tab: "7" }, undefined, deps);
	const blocked = obj(reportOf(result).blocked);
	assert.equal(blocked.reason, "javascript-from-apple-events-off");
	assert.match(String(blocked.message), /View > Developer/);
});

it("maps an automation-denied reply to a refusal", async () => {
	const run = runFrom({
		inventory: () => inventoryOf([{ pid: 5 }]),
		execute: () => fail("automation-denied", -1743, "denied"),
	});
	const { deps } = fakes(run, { access: { chrome: "inspect" } });
	const result = await browserInspect({ browser: "chrome", pid: 5, tab: "7" }, undefined, deps);
	assert.equal(blockedReason(result), "automation-denied");
	assert.equal(result.isError, true);
});

/* ---------------------------------------------------------------- act */

function actRunner(
	poll: Handler,
	action: Handler = () => executed({ kind: "scheduled", mark: 1000, element: { selector: "#save" }, page: PAGE }),
): Run {
	return runFrom({
		inventory: () => inventoryOf([{ pid: 5 }]),
		execute: (request) => {
			const kind = scriptKind(request);
			if (kind === "action") return action(request);
			if (kind === "poll") return poll(request);
			throw new Error(`unexpected script ${kind}`);
		},
	});
}

const ACT_PARAMS = {
	browser: "chrome" as const,
	pid: 5,
	tab: "7",
	origin: "https://a.example",
	action: "click" as const,
	selector: "#save",
};

it("refuses a page origin mismatch before the wait starts", async () => {
	const run = actRunner(
		() => {
			throw new Error("poll must not be sent");
		},
		() => executed({ kind: "origin-mismatch", page: { doc: "d1", origin: "https://other.example" } }),
	);
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct(ACT_PARAMS, undefined, deps);
	assert.equal(result.details.status, "blocked");
	assert.equal(blockedReason(result), "origin-mismatch");
	assert.equal(pollRequests(requests).length, 0);
});

it("verifies a dispatched click and keeps a 401 response as an application observation", async () => {
	const run = actRunner(() =>
		executed({
			kind: "ok",
			page: PAGE,
			action: { state: "dispatched", error: null },
			condition: { met: true, checks: [] },
			responses: [{ url: "https://a.example/api", initiator: "fetch", status: 401 }],
			navigation: null,
		}),
	);
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...ACT_PARAMS, waitFor: { selector: "#done", timeoutMs: 300 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "ok");
	assert.equal(obj(report.dispatch).status, "dispatched");
	assert.equal(obj(report.postcondition).status, "verified");
	assert.equal(obj(report.transport).status, "ok");
	assert.equal(list(obj(report.application).responses)[0].status, 401);
});

it("reports a failed postcondition with the observed 500 response", async () => {
	const run = actRunner(() =>
		executed({
			kind: "ok",
			page: PAGE,
			action: { state: "dispatched", error: null },
			condition: { met: false, checks: [{ check: "selector", met: false, observed: { count: 0, visible: false } }] },
			responses: [{ url: "https://a.example/api", initiator: "fetch", status: 500 }],
			navigation: null,
		}),
	);
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...ACT_PARAMS, waitFor: { selector: "#done", timeoutMs: 150 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.details.status, "postcondition-failed");
	assert.equal(obj(report.postcondition).status, "failed");
	assert.equal(list(obj(report.application).responses)[0].status, 500);
	assert.equal(obj(report.dispatch).status, "dispatched");
});

it("reports an unknown dispatch after a transport timeout and never replays the action", async () => {
	const run = runFrom({
		inventory: () => inventoryOf([{ pid: 5 }]),
		execute: () => {
			throw new TransportError("timeout", "unknown", "No reply within 300 ms.");
		},
	});
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct(ACT_PARAMS, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.isError, true);
	assert.equal(obj(report.dispatch).status, "unknown");
	assert.equal(typeof report.replay, "string");
	assert.equal(requests.filter((request) => scriptKind(request) === "action").length, 1);
});

it("treats an Apple Event timeout on the action as an unknown dispatch, not a refusal", async () => {
	const run = actRunner(
		() => {
			throw new Error("poll must not be sent");
		},
		() => ({ ok: false, error: { code: null, number: -1712, message: "timed out", extra: null } }),
	);
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct(ACT_PARAMS, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.details.status, "transport-failed");
	assert.equal(obj(report.dispatch).status, "unknown");
	assert.equal(obj(report.transport).delivery, "unknown");
	assert.equal(requests.filter((request) => scriptKind(request) === "action").length, 1);
});

it("leaves the postcondition unknown when the last page read gets no answer", async () => {
	const run = actRunner(() => {
		throw new TransportError("timeout", "unknown", "No reply.");
	});
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...ACT_PARAMS, waitFor: { text: "Saved", timeoutMs: 150 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(obj(report.postcondition).status, "unknown");
	assert.equal(obj(report.dispatch).status, "unknown");
	assert.ok(Number(obj(report.transport).unansweredReads) >= 1);
});

it("reports a dispatch that was known not to happen when delivery is none", async () => {
	const run = runFrom({
		inventory: () => inventoryOf([{ pid: 5 }]),
		execute: () => {
			throw new TransportError("spawn", "none", "osascript is not available on this system.");
		},
	});
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct(ACT_PARAMS, undefined, deps);
	assert.equal(obj(reportOf(result).dispatch).status, "not-dispatched");
	assert.equal(result.isError, true);
});

it("refuses an ambiguous selector with its candidates", async () => {
	const run = actRunner(
		() => {
			throw new Error("poll must not be sent");
		},
		() =>
			executed({
				kind: "ambiguous",
				matched: 2,
				candidates: [{ selector: "#a" }, { selector: "#b" }],
				page: PAGE,
			}),
	);
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct(ACT_PARAMS, undefined, deps);
	const blocked = obj(reportOf(result).blocked);
	assert.equal(blocked.reason, "ambiguous-element");
	assert.equal(list(blocked.candidates).length, 2);
	assert.equal(pollRequests(requests).length, 0);
});

it("reports an action whose target already had the requested state", async () => {
	const run = actRunner(
		() => {
			throw new Error("poll must not be sent");
		},
		() => executed({ kind: "unchanged", element: { selector: "#save" }, page: PAGE }),
	);
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct(ACT_PARAMS, undefined, deps);
	assert.equal(result.isError, false);
	assert.equal(obj(reportOf(result).dispatch).status, "not-needed");
	assert.equal(pollRequests(requests).length, 0);
	assert.equal(requests.filter((request) => scriptKind(request) === "action").length, 1);
});

const CHECK_PARAMS = { ...ACT_PARAMS, action: "check" as const };
const UNCHECK_PARAMS = { ...ACT_PARAMS, action: "uncheck" as const };
const UNCHANGED_ACTION = () => executed({ kind: "unchanged", element: { selector: "#save", checked: true }, page: PAGE });

function conditionPoll(met: boolean): Handler {
	return () =>
		executed({
			kind: "ok",
			page: PAGE,
			action: null,
			condition: { met, checks: [{ check: "selector", met, observed: { count: met ? 1 : 0, visible: met } }] },
			responses: [],
			navigation: null,
		});
}

/** One unchanged read, then only read-only polls: no event is sent and no second action script runs. */
function assertNoSecondMutation(requests: OsaRequest[]): void {
	assert.equal(requests.filter((request) => scriptKind(request) === "action").length, 1);
	for (const request of pollRequests(requests)) assert.equal(String(request.script).includes("dispatchEvent"), false);
}

it("verifies an unchanged check whose condition already holds without dispatching", async () => {
	const run = actRunner(conditionPoll(true), UNCHANGED_ACTION);
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...CHECK_PARAMS, waitFor: { selector: "#done", timeoutMs: 500 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.details.status, "ok");
	assert.equal(result.isError, false);
	assert.equal(obj(report.dispatch).status, "not-needed");
	assert.equal(obj(report.postcondition).status, "verified");
	assert.ok(pollRequests(requests).length >= 1);
	assertNoSecondMutation(requests);
});

it("verifies an unchanged uncheck when the condition becomes true later", async () => {
	let polls = 0;
	const run = actRunner(
		(request) => {
			polls += 1;
			return conditionPoll(polls >= 2)(request);
		},
		() => executed({ kind: "unchanged", element: { selector: "#save", checked: false }, page: PAGE }),
	);
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...UNCHECK_PARAMS, waitFor: { selector: "#done", timeoutMs: 1000 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(obj(report.dispatch).status, "not-needed");
	assert.equal(obj(report.postcondition).status, "verified");
	assert.ok(polls >= 2);
	assertNoSecondMutation(requests);
});

it("fails an unchanged check whose condition never holds", async () => {
	const run = actRunner(conditionPoll(false), UNCHANGED_ACTION);
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...CHECK_PARAMS, waitFor: { selector: "#done", timeoutMs: 120 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.details.status, "postcondition-failed");
	assert.equal(obj(report.dispatch).status, "not-needed");
	assert.equal(obj(report.postcondition).status, "failed");
	assertNoSecondMutation(requests);
});

it("reports a closed tab while waiting on an unchanged check", async () => {
	const run = actRunner(() => fail("tab-not-found", -1728, "no such tab"), UNCHANGED_ACTION);
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...CHECK_PARAMS, waitFor: { selector: "#done", timeoutMs: 1000 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.details.status, "target-closed");
	assert.equal(obj(report.dispatch).status, "not-needed");
	assert.equal(obj(report.postcondition).status, "unknown");
	assert.match(String(obj(report.postcondition).note), /closed/);
});

it("reports unavailable page reads while waiting on an unchanged check", async () => {
	const run = actRunner(() => fail(null, 12, "The command cannot be executed."), UNCHANGED_ACTION);
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...CHECK_PARAMS, waitFor: { selector: "#done", timeoutMs: 1000 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.details.status, "observation-failed");
	assert.equal(obj(report.dispatch).status, "not-needed");
	assert.equal(obj(report.observation).reason, "javascript-from-apple-events-off");
	assert.equal(obj(report.postcondition).status, "unknown");
});

it("marks the dispatch unknown when the document is replaced before the action state is read", async () => {
	const run = actRunner(() =>
		executed({
			kind: "ok",
			page: { ...PAGE, doc: "d2" },
			action: null,
			condition: null,
			responses: [],
			navigation: null,
		}),
	);
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...ACT_PARAMS, observeMs: 60 }, undefined, deps);
	const report = reportOf(result);
	assert.equal(obj(report.dispatch).status, "unknown");
	assert.equal(obj(report.application).documentReplaced, true);
	assert.equal(obj(report.postcondition).status, "unknown");
});

it("reports cancellation with a note that page-side effects may continue", async () => {
	const controller = new AbortController();
	const run = actRunner(() => {
		controller.abort();
		return executed({
			kind: "ok",
			page: PAGE,
			action: { state: "dispatched", error: null },
			condition: { met: false, checks: [] },
			responses: [],
			navigation: null,
		});
	});
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct(
		{ ...ACT_PARAMS, waitFor: { selector: "#done", timeoutMs: 1000 } },
		controller.signal,
		deps,
	);
	const postcondition = obj(reportOf(result).postcondition);
	assert.equal(result.details.status, "cancelled");
	assert.equal(postcondition.status, "unknown");
	assert.match(String(postcondition.note), /may continue/);
});

it("reports a target that closes during the wait", async () => {
	const run = actRunner(() => fail("tab-not-found", -1728, "no such tab"));
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...ACT_PARAMS, waitFor: { selector: "#done", timeoutMs: 1000 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.details.status, "target-closed");
	assert.equal(obj(report.postcondition).status, "unknown");
	assert.match(String(obj(report.postcondition).note), /closed/);
});

it("keeps the scheduled action when the browser exits during the wait", async () => {
	const run = actRunner(() => fail("not-running", -600, "The process exited."));
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...ACT_PARAMS, waitFor: { selector: "#done", timeoutMs: 1000 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.details.status, "target-closed");
	assert.equal(result.isError, true);
	assert.equal(blockedReason(result), undefined);
	assert.equal(obj(report.observation).status, "failed");
	assert.equal(obj(report.observation).reason, "not-running");
	assert.equal(obj(report.dispatch).status, "unknown");
	assert.match(String(obj(report.postcondition).note), /browser process exited/);
	assert.equal(requests.filter((request) => scriptKind(request) === "action").length, 1);
});

it("keeps the scheduled action when automation permission is lost during the wait", async () => {
	const run = actRunner(() => fail("automation-denied", -1743, "denied"));
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...ACT_PARAMS, waitFor: { selector: "#done", timeoutMs: 1000 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.details.status, "observation-failed");
	assert.equal(obj(report.observation).reason, "automation-denied");
	assert.equal(obj(report.dispatch).status, "unknown");
	assert.equal(requests.filter((request) => scriptKind(request) === "action").length, 1);
});

it("keeps the scheduled action when a page read returns no result", async () => {
	const run = actRunner(() => ok({ window: "1", url: "https://a.example/page", title: "Example", result: null }));
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...ACT_PARAMS, waitFor: { selector: "#done", timeoutMs: 120 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(blockedReason(result), undefined);
	assert.equal(obj(report.dispatch).status, "unknown");
	assert.equal(obj(report.postcondition).status, "unknown");
	assert.ok(Number(obj(report.transport).unansweredReads) >= 1);
	assert.equal(requests.filter((request) => scriptKind(request) === "action").length, 1);
});

it("keeps the action unknown when its own page reply has no readable result", async () => {
	const run = actRunner(
		() => {
			throw new Error("poll must not be sent");
		},
		() => ok({ window: "1", url: "https://a.example/page", title: "Example", result: null }),
	);
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct({ ...ACT_PARAMS, waitFor: { selector: "#done", timeoutMs: 500 } }, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.details.status, "observation-failed");
	assert.equal(result.isError, true);
	assert.equal(obj(report.dispatch).status, "unknown");
	assert.equal(obj(report.observation).reason, "no-page-result");
	assert.equal(typeof report.replay, "string");
	assert.equal(requests.filter((request) => scriptKind(request) === "action").length, 1);
});

it("navigates with the expected origin and refuses a page origin mismatch", async () => {
	const run = runFrom({
		inventory: () => inventoryOf([{ pid: 5 }]),
		execute: () => executed({ kind: "ok", page: PAGE }),
		navigate: () => fail("origin-mismatch", null, "The tab shows another origin."),
	});
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct(
		{ ...ACT_PARAMS, action: "navigate", selector: undefined, url: "https://a.example/next" },
		undefined,
		deps,
	);
	const navigate = requests.find((request) => request.op === "navigate");
	assert.ok(navigate);
	assert.equal(navigate.url, "https://a.example/next");
	assert.equal(navigate.expectOrigin, "https://a.example");
	assert.equal(result.details.status, "blocked");
	assert.equal(blockedReason(result), "origin-mismatch");
});

it("keeps a dispatched navigation when page reads are unavailable before and after it", async () => {
	const run = runFrom({
		inventory: () => inventoryOf([{ pid: 5 }]),
		execute: () => fail(null, 12, "The command cannot be executed."),
		navigate: () => ok({ window: "1", before: "https://a.example/page" }),
	});
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct(
		{
			...ACT_PARAMS,
			action: "navigate",
			selector: undefined,
			url: "https://a.example/next",
			waitFor: { selector: "#done", timeoutMs: 200 },
		},
		undefined,
		deps,
	);
	const report = reportOf(result);
	assert.equal(result.details.status, "observation-failed");
	assert.equal(result.isError, true);
	assert.equal(blockedReason(result), undefined);
	assert.equal(obj(report.dispatch).status, "dispatched");
	assert.equal(obj(report.dispatch).from, "https://a.example/page");
	assert.equal(obj(report.observation).reason, "javascript-from-apple-events-off");
	assert.equal(obj(report.postcondition).status, "unknown");
	assert.equal(requests.filter((request) => request.op === "navigate").length, 1);
});

it("reports a navigation as not dispatched when the read before it gets no answer", async () => {
	const run = runFrom({
		inventory: () => inventoryOf([{ pid: 5 }]),
		execute: () => {
			throw new TransportError("timeout", "unknown", "No reply.");
		},
		navigate: () => {
			throw new Error("navigate must not be sent");
		},
	});
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserAct(
		{ ...ACT_PARAMS, action: "navigate", selector: undefined, url: "https://a.example/next" },
		undefined,
		deps,
	);
	const report = reportOf(result);
	assert.equal(result.details.status, "transport-failed");
	assert.equal(obj(report.dispatch).status, "not-dispatched");
	assert.equal(requests.filter((request) => request.op === "navigate").length, 0);
});

/* ---------------------------------------------------------------- evaluate */

function evaluateRunner(start: Handler, poll?: Handler, forget?: Handler): Run {
	return runFrom({
		inventory: () => inventoryOf([{ pid: 5 }]),
		execute: (request) => {
			const kind = scriptKind(request);
			if (kind === "start") return start(request);
			if (kind === "evaluation-poll") return poll ? poll(request) : executed({ kind: "pending", page: PAGE });
			if (kind === "forget") return forget ? forget(request) : executed({ kind: "ok", page: PAGE });
			throw new Error(`unexpected script ${kind}`);
		},
	});
}

const EVALUATE_PARAMS = {
	browser: "chrome" as const,
	pid: 5,
	tab: "7",
	origin: "https://a.example",
	expression: "1 + 1",
};

it("refuses an expression that does not parse before any Apple Event", async () => {
	const { deps, requests } = fakes(async () => inventoryOf([{ pid: 5 }]), { access: {} });
	const result = await browserEvaluate({ ...EVALUATE_PARAMS, expression: "1 +" }, undefined, deps);
	assert.equal(result.details.status, "syntax-error");
	assert.equal(result.isError, true);
	assert.equal(requests.length, 0);
});

it("returns a synchronous settled value", async () => {
	const run = evaluateRunner(() =>
		executed({
			kind: "settled",
			page: PAGE,
			outcome: { state: "fulfilled", awaited: false, valueType: "number", value: 2 },
		}),
	);
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserEvaluate(EVALUATE_PARAMS, undefined, deps);
	const execution = obj(reportOf(result).execution);
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "fulfilled");
	assert.equal(execution.status, "fulfilled");
	assert.equal(execution.value, 2);
});

it("returns an awaited settled value after a pending start", async () => {
	const run = evaluateRunner(
		() => executed({ kind: "pending", page: PAGE }),
		() =>
			executed({
				kind: "settled",
				page: PAGE,
				outcome: { state: "fulfilled", awaited: true, valueType: "string", value: "done" },
			}),
	);
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserEvaluate({ ...EVALUATE_PARAMS, timeoutMs: 400 }, undefined, deps);
	const execution = obj(reportOf(result).execution);
	assert.equal(result.details.status, "fulfilled");
	assert.equal(execution.awaited, true);
	assert.equal(execution.value, "done");
});

it("times out a pending evaluation and forgets exactly one run", async () => {
	const run = evaluateRunner(() => executed({ kind: "pending", page: PAGE }));
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserEvaluate({ ...EVALUATE_PARAMS, timeoutMs: 120 }, undefined, deps);
	assert.equal(result.details.status, "timeout");
	assert.equal(result.isError, true);
	assert.equal(requests.filter((request) => scriptKind(request) === "forget").length, 1);
});

it("reports a missing run as a replaced document", async () => {
	const run = evaluateRunner(
		() => executed({ kind: "pending", page: PAGE }),
		() => executed({ kind: "missing", page: PAGE }),
	);
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserEvaluate({ ...EVALUATE_PARAMS, timeoutMs: 400 }, undefined, deps);
	assert.equal(result.details.status, "document-replaced");
	assert.equal(result.isError, true);
});

it("reports an unreadable evaluation start as an unknown execution, not a refusal", async () => {
	const run = evaluateRunner(() =>
		ok({
			window: "1",
			url: null,
			title: null,
			result: null,
			metadataError: { number: -1728, message: "Can't get tab." },
		}),
	);
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserEvaluate(EVALUATE_PARAMS, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.details.status, "observation-failed");
	assert.equal(result.isError, true);
	assert.equal(blockedReason(result), undefined);
	assert.equal(obj(report.execution).status, "unknown");
	assert.equal(typeof report.replay, "string");
	assert.equal(requests.filter((request) => scriptKind(request) === "start").length, 1);
});

it("reports a browser exit during an evaluation wait as target-closed", async () => {
	const run = evaluateRunner(
		() => executed({ kind: "pending", page: PAGE }),
		() => fail("not-running", -600, "The process exited."),
	);
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserEvaluate({ ...EVALUATE_PARAMS, timeoutMs: 400 }, undefined, deps);
	const execution = obj(reportOf(result).execution);
	assert.equal(result.details.status, "target-closed");
	assert.match(String(execution.note), /browser process exited/);
	assert.equal(requests.filter((request) => scriptKind(request) === "start").length, 1);
});

it("reports a fulfilled value that has no JSON form as unserializable", async () => {
	const run = evaluateRunner(() =>
		executed({
			kind: "settled",
			page: PAGE,
			outcome: {
				state: "fulfilled",
				awaited: false,
				valueType: "object",
				unserializable: { path: "$", reason: "Circular reference." },
			},
		}),
	);
	const { deps } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserEvaluate(EVALUATE_PARAMS, undefined, deps);
	assert.equal(result.details.status, "unserializable");
	assert.equal(result.isError, true);
	assert.equal(obj(obj(reportOf(result).execution).unserializable).path, "$");
});

it("keeps the error name and message of a rejected promise and of a thrown value", async () => {
	const rejected = evaluateRunner(() =>
		executed({
			kind: "settled",
			page: PAGE,
			outcome: { state: "rejected", error: { name: "TypeError", message: "rejected badly" } },
		}),
	);
	const first = fakes(rejected, { access: { chrome: "interact" } });
	const rejectedResult = await browserEvaluate(EVALUATE_PARAMS, undefined, first.deps);
	const rejectedError = obj(obj(reportOf(rejectedResult).execution).error);
	assert.equal(rejectedResult.details.status, "rejected");
	assert.equal(rejectedError.name, "TypeError");
	assert.equal(rejectedError.message, "rejected badly");

	const threw = evaluateRunner(() =>
		executed({
			kind: "settled",
			page: PAGE,
			outcome: { state: "threw", error: { name: "RangeError", message: "thrown" } },
		}),
	);
	const second = fakes(threw, { access: { chrome: "interact" } });
	const threwResult = await browserEvaluate(EVALUATE_PARAMS, undefined, second.deps);
	const threwError = obj(obj(reportOf(threwResult).execution).error);
	assert.equal(threwResult.details.status, "threw");
	assert.equal(threwResult.isError, true);
	assert.equal(threwError.name, "RangeError");
	assert.equal(threwError.message, "thrown");
});

it("reports an unknown start after a transport failure and never starts the expression twice", async () => {
	const run = runFrom({
		inventory: () => inventoryOf([{ pid: 5 }]),
		execute: () => {
			throw new TransportError("timeout", "unknown", "No reply within 400 ms.");
		},
	});
	const { deps, requests } = fakes(run, { access: { chrome: "interact" } });
	const result = await browserEvaluate(EVALUATE_PARAMS, undefined, deps);
	const report = reportOf(result);
	assert.equal(result.details.status, "transport-failed");
	assert.equal(obj(report.execution).status, "unknown");
	assert.equal(typeof report.replay, "string");
	assert.equal(requests.filter((request) => scriptKind(request) === "start").length, 1);
});

/* ---------------------------------------------------------------- capture */

function qdrect(top: number, left: number, bottom: number, right: number): string {
	const bytes = Buffer.alloc(8);
	bytes.writeInt16LE(top, 0);
	bytes.writeInt16LE(left, 2);
	bytes.writeInt16LE(bottom, 4);
	bytes.writeInt16LE(right, 6);
	return bytes.toString("base64");
}

const FRAME = { x: 0, y: 0, width: 1200, height: 800 };
const WINDOW = {
	window: "9",
	title: "Example",
	bounds: { qdrect: qdrect(0, 0, 800, 1200) },
	minimized: false,
	visible: true,
	activeTab: "42",
	url: "https://a.example/page",
	tabTitle: "Example",
	hidden: false,
	windows: [{ id: 77, onScreen: true, name: "Example", bounds: FRAME }],
	screenRecording: true,
};

const windowReply =
	(overrides: Record<string, unknown> = {}): Handler =>
	() =>
		ok({ ...WINDOW, ...overrides });

function captureFixture(
	facts: Handler,
	options: FakeOptions = {},
): Fixture & { captured: number[]; events: string[] } {
	const captured: number[] = [];
	const events: string[] = [];
	const handler = runFrom({ inventory: () => inventoryOf([{ pid: 5 }]), window: facts });
	const fixture = fakes(
		async (request, runOptions) => {
			if (request.op === "window") events.push("window-read");
			return handler(request, runOptions);
		},
		{
			access: { chrome: "interact" },
			...options,
			capture: async (windowNumber) => {
				events.push("capture");
				captured.push(windowNumber);
				return Buffer.from("png");
			},
		},
	);
	return { ...fixture, captured, events };
}

function hasImage(result: BrowserResult): boolean {
	return result.content.some((item) => item.type === "image");
}

const CAPTURE_PARAMS = { browser: "chrome" as const, pid: 5, tab: "42", origin: "https://a.example" };

it("refuses capture without screen recording permission and never captures", async () => {
	const fixture = captureFixture(windowReply({ screenRecording: false }));
	const result = await browserCapture(CAPTURE_PARAMS, undefined, fixture.deps);
	assert.equal(result.details.status, "blocked");
	assert.equal(blockedReason(result), "screen-recording-not-granted");
	assert.equal(fixture.captured.length, 0);
	assert.equal(
		fixture.requests.some((request) => request.op === "screenRecording"),
		false,
	);
});

it("refuses capture when the tab is not the active tab", async () => {
	const fixture = captureFixture(windowReply({ activeTab: "41" }));
	const result = await browserCapture(CAPTURE_PARAMS, undefined, fixture.deps);
	assert.equal(blockedReason(result), "tab-not-active");
	assert.equal(fixture.captured.length, 0);
});

it("refuses capture of a minimized window", async () => {
	const fixture = captureFixture(windowReply({ minimized: true }));
	const result = await browserCapture(CAPTURE_PARAMS, undefined, fixture.deps);
	assert.equal(blockedReason(result), "window-minimized");
	assert.equal(fixture.captured.length, 0);
});

it("refuses capture of a window that is not on screen", async () => {
	const fixture = captureFixture(
		windowReply({ windows: [{ id: 77, onScreen: false, name: "Example", bounds: FRAME }] }),
	);
	const result = await browserCapture(CAPTURE_PARAMS, undefined, fixture.deps);
	assert.equal(blockedReason(result), "window-not-on-screen");
	assert.equal(fixture.captured.length, 0);
});

it("refuses capture when two equal-bounds windows do not match by name", async () => {
	const fixture = captureFixture(
		windowReply({
			windows: [
				{ id: 77, onScreen: true, name: "One", bounds: FRAME },
				{ id: 78, onScreen: true, name: "Two", bounds: FRAME },
			],
		}),
	);
	const result = await browserCapture(CAPTURE_PARAMS, undefined, fixture.deps);
	assert.equal(blockedReason(result), "window-not-matched");
	assert.equal(fixture.captured.length, 0);
});

it("refuses capture when no window-server window has the scripting bounds", async () => {
	const fixture = captureFixture(
		windowReply({
			windows: [{ id: 77, onScreen: true, name: "Example", bounds: { x: 40, y: 40, width: 800, height: 600 } }],
		}),
	);
	const result = await browserCapture(CAPTURE_PARAMS, undefined, fixture.deps);
	assert.equal(blockedReason(result), "window-not-matched");
	assert.equal(fixture.captured.length, 0);
});

it("captures the equal-bounds window whose name matches the title", async () => {
	const fixture = captureFixture(
		windowReply({
			windows: [
				{ id: 76, onScreen: true, name: "Other", bounds: FRAME },
				{ id: 78, onScreen: true, name: "Example", bounds: FRAME },
			],
		}),
	);
	const result = await browserCapture(CAPTURE_PARAMS, undefined, fixture.deps);
	assert.equal(result.details.status, "ok");
	assert.deepEqual(fixture.captured, [78]);
	assert.equal(obj(reportOf(result).window).windowNumber, 78);
});

it("decodes a QuickDraw rectangle by its corners", () => {
	assert.deepEqual(decodeRect({ qdrect: qdrect(10, 20, 310, 620) }), { x: 20, y: 10, width: 600, height: 300 });
	assert.equal(decodeRect({ qdrect: Buffer.alloc(4).toString("base64") }), null);
	assert.equal(decodeRect({}), null);
	assert.equal(decodeRect(null), null);
});

it("captures the matched window and returns the resized image", async () => {
	const saved: string[] = [];
	const fixture = captureFixture(windowReply(), {
		resize: async () => ({
			data: "ZmFrZQ==",
			mimeType: "image/png",
			width: 800,
			height: 500,
			originalWidth: 1200,
			originalHeight: 800,
		}),
		save: async (path) => {
			saved.push(path);
		},
	});
	const result = await browserCapture({ ...CAPTURE_PARAMS, savePath: "/captures/example.png" }, undefined, fixture.deps);
	const report = reportOf(result);
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "ok");
	assert.deepEqual(fixture.captured, [77]);
	assert.deepEqual(fixture.events, ["window-read", "capture", "window-read"]);
	assert.equal(
		fixture.requests.filter((request) => request.op === "window").length,
		2,
	);
	assert.deepEqual(saved, ["/captures/example.png"]);
	assert.equal(report.savedPath, "/captures/example.png");
	assert.equal(obj(report.identity).status, "unchanged");
	assert.equal(obj(report.window).windowNumber, 77);
	assert.deepEqual(obj(report.window).bounds, FRAME);
	assert.match(String(report.method), /screencapture/);
	assert.equal(result.content.length, 2);
	const image = result.content[1];
	assert.equal(image.type, "image");
	if (image.type === "image") {
		assert.equal(image.data, "ZmFrZQ==");
		assert.equal(image.mimeType, "image/png");
	}
});

it("discards the capture when the active tab changes during pixel acquisition", async () => {
	const saved: string[] = [];
	let reads = 0;
	const fixture = captureFixture(
		() => {
			reads += 1;
			return ok(reads === 1 ? { ...WINDOW } : { ...WINDOW, activeTab: "43" });
		},
		{
			save: async (path) => {
				saved.push(path);
			},
		},
	);
	const result = await browserCapture({ ...CAPTURE_PARAMS, savePath: "/captures/switched.png" }, undefined, fixture.deps);
	assert.equal(result.details.status, "blocked");
	assert.equal(blockedReason(result), "capture-changed");
	assert.equal(result.isError, true);
	assert.equal(hasImage(result), false);
	assert.deepEqual(saved, []);
	assert.deepEqual(fixture.captured, [77]);
	assert.deepEqual(fixture.events, ["window-read", "capture", "window-read"]);
	assert.deepEqual(obj(reportOf(result).blocked).changed, ["active tab"]);
});

it("discards the capture when the selected tab navigates during pixel acquisition", async () => {
	const saved: string[] = [];
	let reads = 0;
	const navigated = { ...WINDOW, url: "https://b.example/other", tabTitle: "Other" };
	const fixture = captureFixture(
		() => {
			reads += 1;
			return ok(reads === 1 ? { ...WINDOW } : navigated);
		},
		{
			save: async (path) => {
				saved.push(path);
			},
		},
	);
	const result = await browserCapture({ ...CAPTURE_PARAMS, savePath: "/captures/navigated.png" }, undefined, fixture.deps);
	assert.equal(result.details.status, "blocked");
	assert.equal(blockedReason(result), "capture-changed");
	assert.equal(hasImage(result), false);
	assert.deepEqual(saved, []);
	assert.deepEqual(fixture.captured, [77]);
	assert.deepEqual(fixture.events, ["window-read", "capture", "window-read"]);
	assert.deepEqual(obj(reportOf(result).blocked).changed, ["URL"]);
});

it("discards the capture when the window is minimized during pixel acquisition", async () => {
	let reads = 0;
	const fixture = captureFixture(() => {
		reads += 1;
		return ok(reads === 1 ? { ...WINDOW } : { ...WINDOW, minimized: true });
	});
	const result = await browserCapture(CAPTURE_PARAMS, undefined, fixture.deps);
	assert.equal(blockedReason(result), "capture-changed");
	assert.equal(hasImage(result), false);
	assert.deepEqual(fixture.events, ["window-read", "capture", "window-read"]);
});

it("discards the capture when the subject cannot be read after pixel acquisition", async () => {
	const saved: string[] = [];
	let reads = 0;
	const fixture = captureFixture(
		() => {
			reads += 1;
			return reads === 1 ? ok({ ...WINDOW }) : fail(null, -1728, "No open tab has this id in the selected browser process.");
		},
		{
			save: async (path) => {
				saved.push(path);
			},
		},
	);
	const result = await browserCapture({ ...CAPTURE_PARAMS, savePath: "/captures/closed.png" }, undefined, fixture.deps);
	assert.equal(result.details.status, "blocked");
	assert.equal(blockedReason(result), "capture-unverified");
	assert.equal(hasImage(result), false);
	assert.deepEqual(saved, []);
	assert.deepEqual(fixture.events, ["window-read", "capture", "window-read"]);
});

it("refuses a relative save path before any Apple Event", async () => {
	const { deps, requests } = fakes(async () => inventoryOf([{ pid: 5 }]), { access: { chrome: "interact" } });
	const result = await browserCapture({ ...CAPTURE_PARAMS, savePath: "capture.png" }, undefined, deps);
	assert.equal(result.details.status, "blocked");
	assert.equal(blockedReason(result), "invalid-arguments");
	assert.equal(requests.length, 0);
});

/* ---------------------------------------------------------------- tabs */

it("reports every browser and asks for permission only where access and a process exist", async () => {
	const run = runFrom({
		inventory: (request) => {
			if (request.bundleId === BROWSERS.chrome.bundleId) return inventoryOf([{ pid: 1 }]);
			if (request.bundleId === BROWSERS.brave.bundleId) return inventoryOf([{ pid: 2 }]);
			return inventoryOf([]);
		},
		permission: () => ok({ automation: "granted" }),
	});
	const { deps, requests } = fakes(run, { access: { chrome: "inspect", "chrome-for-testing": "interact" } });
	const result = await browserTabs({}, undefined, deps);
	const browsers = list(reportOf(result).browsers);
	assert.equal(result.isError, false);
	assert.deepEqual(
		browsers.map((entry) => entry.browser),
		["chrome", "brave", "chrome-for-testing"],
	);
	assert.equal(browsers[0].access, "inspect");
	assert.equal(browsers[0].automation, "granted");
	assert.equal(browsers[1].access, "none");
	assert.equal(browsers[1].automation, "not-checked");
	assert.equal(browsers[2].automation, "not-checked");
	const permissions = requests.filter((request) => request.op === "permission");
	assert.equal(permissions.length, 1);
	assert.equal(permissions[0].bundleId, BROWSERS.chrome.bundleId);
	assert.equal(
		requests.every((request) => request.op === "inventory" || request.op === "permission"),
		true,
	);
});

it("lists only matching tabs and derives the active flag from activeTabIndex", async () => {
	const run = runFrom({
		inventory: () => inventoryOf([{ pid: 7 }]),
		windows: () =>
			windowsOf([
				{
					id: "1",
					index: 1,
					title: "Window",
					mode: "normal",
					minimized: false,
					visible: true,
					activeTabIndex: 3,
					tabs: [
						{ id: "t1", url: "https://a.example/one", title: "One", loading: false },
						{ id: "t2", url: "https://b.example/two", title: "Two", loading: true },
						{ id: "t3", url: "https://a.example/three", title: "Three", loading: false },
					],
				},
			]),
	});
	const { deps } = fakes(run, { access: { chrome: "inspect" } });
	const result = await browserTabs({ browser: "chrome", match: "a.example" }, undefined, deps);
	const report = reportOf(result);
	const rows = list(report.windows);
	assert.equal(rows.length, 1);
	const tabs = list(rows[0].tabs);
	assert.deepEqual(
		tabs.map((tab) => tab.tab),
		["t1", "t3"],
	);
	assert.deepEqual(
		tabs.map((tab) => tab.active),
		[false, true],
	);
	assert.equal(report.tabCount, 2);
	assert.equal(report.userDataDir, null);
});
