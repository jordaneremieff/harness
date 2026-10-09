import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { compareRosterRows } from "./catalog-state.mts";
import { AgentService } from "./index.mts";
import type { AgentServiceOptions, CatalogPage, CatalogRow } from "./index.mts";

type Request = { id: number; member: string; args: unknown[] };
class FakeWorker extends EventEmitter {
	requests: Request[] = [];
	terminated = 0;
	closeResponse = true;
	cloneFailure = false;
	postMessage(request: Request): void {
		if (this.cloneFailure) throw new Error("Clone failed");
		this.requests.push(request);
		if (request.member === "close" && this.closeResponse) queueMicrotask(() => this.respond(request.id));
	}
	respond(id: number, result?: unknown): void {
		this.emit("message", { id, result });
	}
	callback(event: string, ...args: unknown[]): void {
		this.emit("message", { event, args });
	}
	async terminate(): Promise<number> {
		this.terminated++;
		this.emit("exit", 0);
		return 0;
	}
}
function fixture(t: { after: (fn: () => Promise<void>) => void }, callbacks: Partial<AgentServiceOptions> = {}) {
	const worker = new FakeWorker();
	const service = new AgentService(
		{ store: "/private-fixture", installationId: "fixture", ...callbacks },
		() => worker,
	);
	t.after(() => service.close());
	return { worker, service };
}
function row(id: string): CatalogRow {
	return {
		id,
		storageId: id,
		cwd: "/fixture",
		modifiedAt: 0,
		owner: "unknown",
		state: "idle",
		cost: 0,
		partial: false,
		claim: "absent",
	};
}
function page(changed: CatalogRow[] = [], removed: string[] = []): CatalogPage {
	return {
		rows: [],
		changed,
		removed,
		nextCursor: null,
		coverage: { complete: true, omitted: 0 },
		stale: false,
		observedAt: "2026-01-01T00:00:00.000Z",
		scan: { scanId: "scan", state: "ready", complete: true, visited: 50, skipped: 0, omitted: 0 },
	};
}
const input = { operationId: "operation", message: "Exact text", mode: "steer" as const };
function code(expected: string, uncertain = false) {
	return (error: unknown) => {
		assert.equal((error as { code: string }).code, expected);
		assert.equal((error as { uncertain: boolean }).uncertain, uncertain);
		return true;
	};
}

test("proxy has no startup scan and synchronous roster uses only callback deltas", async (t) => {
	const changes: CatalogPage[] = [];
	const { worker, service } = fixture(t, { onRoster: (item) => changes.push(item) });
	assert.equal(worker.requests.length, 0);
	assert.equal(service.roster().scan.state, "not-started");
	worker.callback("ready");
	assert.equal(worker.requests.length, 0);
	worker.callback("roster", page(Array.from({ length: 50 }, (_, index) => row(`row-${index}`))));
	assert.equal(changes[0]?.changed?.length, 50);
	assert.equal(service.roster().rows.length, 20);
	const first = service.roster({ limit: 30 });
	const cursor = first.nextCursor;
	assert.ok(cursor);
	assert.equal(service.roster({ cursor, limit: 30 }).rows.length, 20);
	assert.equal(worker.requests.length, 0);
	assert.equal(service.roster().changed, undefined);
	worker.callback("roster", page([row("replacement")], ["row-49"]));
	assert.deepEqual(changes.at(-1)?.removed, ["row-49"]);
	assert.equal(
		service.roster({ limit: 100 }).rows.some((item) => item.id === "row-49"),
		false,
	);
	assert.throws(() => service.roster({ cursor }), code("stale_revision"));
	const copy = service.roster().rows[0];
	assert.ok(copy);
	copy.cwd = "mutated";
	assert.equal(service.roster().rows[0]?.cwd, "/fixture");
});

test("prepare proxies exact identities without selection and worker failure is not mutation uncertainty", async (t) => {
  const callbacks: unknown[][] = [];
  const { worker, service } = fixture(t, { onAvailability: (...args) => callbacks.push(args) });
  const prepared = service.prepare("storage:2");
  const request = worker.requests[0]; assert.ok(request);
  assert.deepEqual(request, { id: request.id, member: "prepare", args: ["storage:2"] });
  const supported = { "task-submit": true, abort: false };
  worker.respond(request.id, supported);
  assert.deepEqual(await prepared, supported);
  const failed = assert.rejects(service.prepare("storage:3"), code("host_unavailable", false));
  worker.emit("exit", 1); await failed;
  assert.deepEqual(callbacks, []);
  assert.deepEqual(worker.requests.map(item => item.member), ["prepare", "prepare"]);
});

test("proxy correlates out-of-order responses and preserves serialized errors", async (t) => {
	const { worker, service } = fixture(t);
	const one = service.refresh(),
		two = service.hide("workspace");
	const [first, second] = worker.requests;
	assert.ok(first);
	assert.ok(second);
	worker.respond(second.id);
	worker.respond(first.id, page().scan);
	assert.equal((await one).scanId, "scan");
	await two;
	const mutation = service.abort("fixture");
	const rejected = assert.rejects(mutation, code("delivery_uncertain", true));
	const request = worker.requests.at(-1);
	assert.ok(request);
	worker.emit("message", {
		id: request.id,
		error: { code: "delivery_uncertain", message: "No receipt", uncertain: true },
	});
	await rejected;
});

test("same input keys return the same promise and changed content never crosses the worker", async (t) => {
	const { worker, service } = fixture(t);
	const one = service.submit("fixture", input);
	assert.equal(
		service.submit("fixture", { mode: "steer", message: input.message, operationId: input.operationId }),
		one,
	);
	await assert.rejects(service.submit("fixture", { ...input, message: "Changed" }), code("operation_conflict"));
	await assert.rejects(service.submit("other", input), code("operation_conflict"));
	assert.equal(worker.requests.length, 1);
	const request = worker.requests[0];
	assert.ok(request);
	worker.respond(request.id, { identity: "fixture" });
	await one;
	assert.equal(service.submit("fixture", input), one);
	const retry = service.retrySubmit("fixture", {
		mode: "steer",
		message: input.message,
		operationId: input.operationId,
	});
	assert.equal(worker.requests.at(-1)?.member, "retrySubmit");
	assert.deepEqual(worker.requests.at(-1)?.args, request.args);
	assert.equal(service.submit("fixture", input), retry);
	worker.respond(worker.requests.at(-1)?.id ?? 0, { identity: "fixture" });
	await retry;
});

test("worker exit rejects mutations as uncertain and reads as unavailable without replay", async (t) => {
	const { worker, service } = fixture(t);
	worker.callback("roster", page([row("fixture")]));
	const submitted = assert.rejects(service.submit("fixture", input), code("host_unavailable", true));
	const reading = assert.rejects(service.history("fixture"), code("host_unavailable"));
	worker.emit("exit", 1);
	await Promise.all([submitted, reading]);
	assert.equal(worker.requests.length, 2);
	assert.equal(service.roster().rows.length, 1);
	assert.equal(service.roster().stale, true);
	assert.throws(() => service.refresh(), code("not_ready"));
	await service.close();
});

test("pending requests cap at 64 and close rejects outstanding work before its own request", async (t) => {
	const { worker, service } = fixture(t);
	const pending = Array.from({ length: 64 }, () => service.history("fixture"));
	const all = Promise.allSettled(pending);
	await assert.rejects(service.history("fixture"), code("capacity"));
	assert.equal(worker.requests.length, 64);
	await service.close();
	const results = await all;
	assert.equal(results.filter((item) => item.status === "rejected").length, 64);
	assert.equal(worker.requests.length, 65);
	assert.equal(worker.requests.at(-1)?.member, "close");
	assert.equal(worker.terminated, 1);
});

test("close waits for its response, terminates once, and retains roster data", async (t) => {
	const { worker, service } = fixture(t);
	worker.closeResponse = false;
	worker.callback("roster", page([row("fixture")]));
	const rejected = assert.rejects(service.abort("fixture"), code("host_unavailable", true));
	const closing = service.close();
	assert.equal(service.close(), closing);
	assert.equal(worker.terminated, 0);
	const close = worker.requests.at(-1);
	assert.equal(close?.member, "close");
	worker.respond(close?.id ?? 0);
	await closing;
	await rejected;
	assert.equal(worker.terminated, 1);
	assert.equal(service.roster().rows[0]?.id, "fixture");
	assert.throws(() => service.refresh(), code("not_ready"));
	assert.equal(service.configure("fixture").available, false);
});

test("roster cache refuses overflow with visible omissions and bounded pages", async (t) => {
	const { worker, service } = fixture(t);
	for (let start = 0; start < 2048; start += 64)
		worker.callback("roster", page(Array.from({ length: 64 }, (_, i) => row(`row-${start + i}`))));
	worker.callback("roster", page([row("overflow")]));
	assert.equal(service.roster().coverage.complete, false);
	assert.equal(service.roster().coverage.omitted, 1);
	worker.callback("roster", page());
	assert.equal(service.roster().coverage.omitted, 1);
	const huge = { ...row("row-0"), latestReply: "x".repeat(8 * 1024 * 1024) };
	worker.callback("roster", page([huge]));
	assert.equal(service.roster().coverage.omitted, 2);
	assert.equal(service.roster().rows[0]?.latestReply, undefined);
	assert.ok(Buffer.byteLength(JSON.stringify(service.roster({ limit: 100 }))) <= 256 * 1024);
});

test("invalid input and serialization failures reject without uncertain admission", async (t) => {
	const { worker, service } = fixture(t);
	await assert.rejects(service.submit("fixture", { ...input, message: " " }), code("invalid_request"));
	assert.equal(worker.requests.length, 0);
	worker.cloneFailure = true;
	await assert.rejects(service.abort("fixture"), code("invalid_request"));
	worker.cloneFailure = false;
	await assert.rejects(
		service.inspect("fixture", { view: "history", cursor: { text: "x".repeat(128 * 1024) } }),
		code("invalid_request"),
	);
	assert.equal(worker.requests.length, 0);
});

test("frame and availability callbacks pass through, without extra worker actions", async (t) => {
	const frames: unknown[][] = [],
		availability: unknown[][] = [];
	const { worker } = fixture(t, {
		onFrame: (...args) => frames.push(args),
		onAvailability: (...args) => availability.push(args),
	});
	worker.callback("frame", "workspace", "fixture", 2, { revision: 3 });
	worker.callback("availability", "workspace", "fixture", "live", undefined, { snapshot: true });
	assert.deepEqual(frames, [["workspace", "fixture", 2, { revision: 3 }]]);
	assert.equal(availability[0]?.[2], "live");
	assert.equal(worker.requests.length, 0);
});

test("closed proxies suppress late roster, frame, and availability callbacks", async (t) => {
	const roster: CatalogPage[] = [],
		frames: unknown[][] = [],
		availability: unknown[][] = [];
	const { worker, service } = fixture(t, {
		onRoster: (value) => roster.push(value),
		onFrame: (...args) => frames.push(args),
		onAvailability: (...args) => availability.push(args),
	});
	worker.callback("roster", page([row("fixture")]));
	worker.callback("frame", "workspace", "fixture", 1, { revision: 1 });
	worker.callback("availability", "workspace", "fixture", "live");
	await service.close();
	worker.callback("roster", page([row("late")], ["fixture"]));
	worker.callback("frame", "workspace", "fixture", 2, { revision: 2 });
	worker.callback("availability", "workspace", "fixture", "live");
	assert.equal(roster.length, 1);
	assert.equal(frames.length, 1);
	assert.equal(availability.length, 1);
	assert.equal(service.roster().rows[0]?.id, "fixture");
});

test("worker failure marks each selected workspace unavailable exactly once", async (t) => {
	const availability: unknown[][] = [],
		frames: unknown[][] = [];
	const { worker, service } = fixture(t, {
		onAvailability: (...args) => availability.push(args),
		onFrame: (...args) => frames.push(args),
	});
	const selections = [service.select("one", "first"), service.select("two", "second")];
	for (const request of worker.requests) worker.respond(request.id);
	await Promise.all(selections);
	worker.callback("availability", "one", "first", "live");
	worker.callback("availability", "two", "second", "live");
	const reading = assert.rejects(service.history("first"), code("host_unavailable"));
	worker.emit("error", new Error("Failed"));
	await reading;
	worker.emit("exit", 1);
	const failed = availability.filter((args) => args[2] === "unavailable");
	assert.equal(failed.length, 2);
	assert.deepEqual(
		failed.map((args) => args.slice(0, 2)),
		[
			["one", "first"],
			["two", "second"],
		],
	);
	assert.deepEqual(
		failed.map((args) => args[4]),
		[{}, {}],
	);
	worker.callback("availability", "one", "first", "live");
	worker.callback("frame", "one", "first", 2, {});
	worker.callback("roster", page([row("late")]));
	assert.equal(availability.length, 4);
	assert.equal(frames.length, 0);
	assert.equal(service.roster().rows.length, 0);
	assert.equal(worker.requests.length, 3);
});

test("failed selection restores the old target unless a worker callback confirms the new target", async (t) => {
	for (const confirmed of [false, true]) {
		const availability: unknown[][] = [];
		const { worker, service } = fixture(t, { onAvailability: (...args) => availability.push(args) });
		const old = service.select("workspace", "old");
		worker.respond(worker.requests.at(-1)?.id ?? 0);
		await old;
		const next = assert.rejects(service.select("workspace", "new"), code(confirmed ? "stored" : "capacity"));
		if (confirmed) worker.callback("availability", "workspace", "new", "stored");
		worker.emit("message", {
			id: worker.requests.at(-1)?.id,
			error: { code: confirmed ? "stored" : "capacity", message: "Failed", uncertain: false },
		});
		await next;
		worker.emit("exit", 1);
		assert.equal(availability.at(-1)?.[1], confirmed ? "new" : "old");
		assert.equal(availability.at(-1)?.[2], "unavailable");
	}
});

test("cleared and hidden workspaces ignore late callbacks and do not retain live availability", async (t) => {
	const availability: unknown[][] = [];
	const { worker, service } = fixture(t, { onAvailability: (...args) => availability.push(args) });
	for (const workspace of ["cleared", "hidden", "detached"])
		worker.callback("availability", workspace, "fixture", "live");
	const cleared = service.select("cleared"),
		hidden = service.hide("hidden"),
		detached = service.disconnectWorkspace("detached");
	for (const request of worker.requests) worker.respond(request.id);
	await Promise.all([cleared, hidden, detached]);
	for (const workspace of ["cleared", "hidden", "detached"])
		worker.callback("availability", workspace, "fixture", "live");
	worker.emit("exit", 1);
	assert.equal(availability.length, 3);
});

test("exact cached roster rows remain readable beyond the first page and after close", async (t) => {
	const { worker, service } = fixture(t);
	const rows = Array.from({ length: 50 }, (_, index) => row(`row-${index}`));
	const selected = { ...row("row-49"), model: { provider: "fixture", modelId: "fixture", thinkingLevel: "off" } };
	rows[49] = selected;
	worker.callback("roster", page(rows));
	assert.equal(
		service.roster().rows.some((value) => value.id === "row-49"),
		false,
	);
	const copy = service.rosterRow("row-49");
	assert.ok(copy);
	assert.ok(copy.model);
	copy.cwd = "changed";
	copy.model.provider = "changed";
	assert.equal(service.rosterRow("row-49")?.cwd, "/fixture");
	assert.equal(service.rosterRow("row-49")?.model?.provider, "fixture");
	assert.equal(service.rosterRow("missing"), undefined);
	assert.equal(worker.requests.length, 0);
	worker.callback("roster", page([], ["row-49"]));
	assert.equal(service.rosterRow("row-49"), undefined);
	worker.callback("roster", page([selected]));
	assert.equal(worker.requests.length, 0);
	await service.close();
	const dispatched = worker.requests.length;
	assert.equal(service.rosterRow("row-49")?.model?.provider, "fixture");
	assert.equal(service.rosterRow("missing"), undefined);
	assert.equal(worker.requests.length, dispatched);
});

function cachedIdentities(service: AgentService): string[] {
	const identities: string[] = [];
	let cursor: string | undefined;
	for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
		const current = service.roster({ cursor, limit: 7 });
		identities.push(...current.rows.map(item => item.id));
		if (!current.nextCursor) return identities;
		cursor = current.nextCursor;
	}
	assert.fail("Cached pagination exceeded its fixture bound.");
}

test("roster pages and callback deltas use global newest activity with stable identity ties", (t) => {
	const callbacks: CatalogPage[] = [];
	const { service, worker } = fixture(t, { onRoster: value => callbacks.push(value) });
	const older = Array.from({ length: 25 }, (_, index) => ({ ...row(`old-${index}`), modifiedAt: index }));
	const recent = [{ ...row("recent-z"), modifiedAt: 200 }, { ...row("recent-a"), modifiedAt: 200 },
		{ ...row("latest"), modifiedAt: 300 }];
	worker.callback("roster", page([...older, ...recent]));
	const expected = ["latest", "recent-a", "recent-z", ...older.toReversed().map(item => item.id)];
	assert.deepEqual(service.roster().rows.map(item => item.id), expected.slice(0, 20));
	assert.deepEqual(cachedIdentities(service), expected);
	assert.deepEqual(callbacks[0].changed?.map(item => item.id), expected);
	assert.deepEqual(service.roster().rows.map(item => item.id), expected.slice(0, 20));
	assert.equal(service.rosterRow("old-0")?.modifiedAt, 0);
	assert.equal(worker.requests.length, 0);
});

test("activity-changing deltas expire old cursors and fresh paging has no skipped or duplicate rows", (t) => {
	const { service, worker } = fixture(t);
	const original = Array.from({ length: 28 }, (_, index) => ({ ...row(`agent-${index.toString().padStart(2, "0")}`), modifiedAt: index }));
	worker.callback("roster", page(original));
	const first = service.roster();
	assert.ok(first.nextCursor);
	worker.callback("roster", page([{ ...original[0], modifiedAt: 100 }, { ...original[1], modifiedAt: 100 }]));
	assert.throws(() => service.roster({ cursor: first.nextCursor ?? undefined }), code("stale_revision"));
	const expected = ["agent-00", "agent-01", ...original.slice(2).toReversed().map(item => item.id)];
	assert.deepEqual(cachedIdentities(service), expected);
	assert.equal(new Set(cachedIdentities(service)).size, original.length);
	assert.equal(service.rosterRow("agent-00")?.modifiedAt, 100);
	worker.callback("roster", page([{ ...original[1], modifiedAt: 100 }, { ...original[0], modifiedAt: 100 }]));
	assert.deepEqual(cachedIdentities(service), expected);
	assert.equal(worker.requests.length, 0);
});

test("equal-activity identities use stable code-unit order rather than locale or arrival order", (t) => {
	const { service, worker } = fixture(t);
	worker.callback("roster", page([row("z"), row("a"), row("A")]));
	assert.deepEqual(cachedIdentities(service), ["A", "a", "z"]);
	worker.callback("roster", page([row("a"), row("A"), row("z")]));
	assert.deepEqual(cachedIdentities(service), ["A", "a", "z"]);
});

test("bounded roster ordering measures update sorting separately from cached page reads", (t) => {
	const { service, worker } = fixture(t);
	const rows = Array.from({ length: 2048 }, (_, index) => ({ ...row(`agent-${index.toString().padStart(4, "0")}`),
		modifiedAt: index * 104729 % 2048 }));
	const sortMs: number[] = [], updateMs: number[] = [], pageMs: number[] = [];
	for (let sample = 0; sample < 5; sample++) {
		let started = performance.now();
		const sorted = [...rows].sort(compareRosterRows);
		sortMs.push(performance.now() - started);
		assert.equal(sorted[0].modifiedAt, 2047);
		for (let offset = 0; offset < rows.length; offset += 1024) {
			const delta = page(rows.slice(offset, offset + 1024));
			assert.ok(Buffer.byteLength(JSON.stringify(delta)) <= 256 * 1024);
			started = performance.now(); worker.callback("roster", delta);
			updateMs.push(performance.now() - started);
		}
		assert.deepEqual(service.roster().rows.map(item => item.id), sorted.slice(0, 20).map(item => item.id));
	}
	for (let sample = 0; sample < 100; sample++) {
		const started = performance.now(); service.roster(); pageMs.push(performance.now() - started);
	}
	const distribution = (values: number[]) => {
		const sorted = values.toSorted((a, b) => a - b);
		return { medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1) };
	};
	t.diagnostic(JSON.stringify({ rows: rows.length, sort: distribution(sortMs), callbackUpdate: distribution(updateMs),
		cachedPage: distribution(pageMs), pageReads: pageMs.length }));
	assert.equal(worker.requests.length, 0);
});

test("active workspace tracking caps at sixteen selections", async (t) => {
	const { worker, service } = fixture(t);
	const selections = Array.from({ length: 16 }, (_, i) => service.select(`workspace-${i}`, "fixture"));
	const outcomes = Promise.all(selections);
	for (const request of worker.requests) worker.respond(request.id);
	await outcomes;
	await assert.rejects(service.select("overflow", "fixture"), code("capacity"));
	assert.equal(worker.requests.length, 16);
});
