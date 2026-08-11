import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerHerdr, { registerHerdrWithDeps, type SyncDeps } from "./index.ts";
import type { HerdrClient } from "./socket.ts";

interface RecordedCall {
	method: string;
	params: Record<string, unknown>;
}

/** A client stand-in: records sends and serves canned list results. */
function fakeClient(responses: Record<string, unknown> = {}) {
	const calls: RecordedCall[] = [];
	const client = {
		calls,
		async send(method: string, params: Record<string, unknown>) {
			calls.push({ method, params });
		},
		async request(method: string, params: Record<string, unknown>) {
			calls.push({ method, params });
			if (method in responses) return responses[method];
			throw new Error(`unexpected request ${method}`);
		},
		nextSeq: (() => {
			let seq = 0;
			return () => ++seq;
		})(),
	};
	return { client: client as unknown as HerdrClient, calls };
}

interface FakePi {
	handlers: Map<string, (event: any, ctx: any) => unknown>;
	sessionName: string | undefined;
}

function fakePi(name: string | undefined): FakePi {
	return {
		handlers: new Map(),
		sessionName: name,
	};
}

function piApi(fake: FakePi): ExtensionAPI {
	return {
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			fake.handlers.set(event, handler);
		},
		getSessionName() {
			return fake.sessionName;
		},
	} as unknown as ExtensionAPI;
}

function ctx(model?: string, mode = "tui"): ExtensionContext {
	return { mode, model: model ? { name: model } : undefined } as unknown as ExtensionContext;
}

function depsWith(client: HerdrClient): SyncDeps {
	return { client, paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", maxName: 60 };
}

const autoTabs = { tabs: [{ tab_id: "w1:t1", label: "1" }] };

function fire(fake: FakePi, event: string, payload: unknown, context: ExtensionContext): Promise<void> {
	const handler = fake.handlers.get(event);
	assert.ok(handler, `handler registered for ${event}`);
	return handler(payload, context) as Promise<void>;
}

describe("registerHerdr gating", () => {
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const key of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID"]) {
			saved[key] = process.env[key];
		}
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("registers nothing outside herdr", () => {
		delete process.env.HERDR_ENV;
		const fake = fakePi("alpha");
		registerHerdr(piApi(fake));
		assert.equal(fake.handlers.size, 0);
	});

	it("registers nothing without a socket path", () => {
		process.env.HERDR_ENV = "1";
		delete process.env.HERDR_SOCKET_PATH;
		const fake = fakePi("alpha");
		registerHerdr(piApi(fake));
		assert.equal(fake.handlers.size, 0);
	});

	it("registers all four handlers inside herdr", () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = "/nonexistent/herdr.sock";
		process.env.HERDR_PANE_ID = "w1:p1";
		const fake = fakePi("alpha");
		registerHerdr(piApi(fake));
		assert.deepEqual([...fake.handlers.keys()].sort(), [
			"model_select",
			"session_info_changed",
			"session_shutdown",
			"session_start",
		]);
	});
});

describe("identity sync", () => {
	it("reports the model token and renames an auto tab", async () => {
		const { client, calls } = fakeClient({ "tab.list": autoTabs });
		const fake = fakePi("alpha");
		registerHerdrWithDeps(piApi(fake), depsWith(client));

		await fire(fake, "session_start", { reason: "startup" }, ctx("Opus"));

		const report = calls.find((c) => c.method === "pane.report_metadata");
		assert.ok(report);
		assert.deepEqual(report.params.tokens, { model: "Opus" });
		assert.equal(report.params.title, undefined);
		assert.equal(report.params.display_agent, undefined);
		assert.equal(report.params.pane_id, "w1:p1");
		assert.equal(report.params.agent, "pi");

		const rename = calls.find((c) => c.method === "tab.rename");
		assert.ok(rename);
		assert.deepEqual(rename.params, { tab_id: "w1:t1", label: "alpha" });
	});

	it("skips every socket call outside TUI mode", async () => {
		const { client, calls } = fakeClient({ "tab.list": autoTabs });
		const fake = fakePi("alpha");
		registerHerdrWithDeps(piApi(fake), depsWith(client));

		const handler = fake.handlers.get("session_start");
		assert.ok(handler);
		const result = handler({ reason: "startup" }, ctx("Opus", "rpc"));
		assert.equal(result, undefined);
		assert.equal(calls.length, 0);
	});

	it("renames the tab from the session_info_changed name", async () => {
		const ownedTabs = { tabs: [{ tab_id: "w1:t1", label: "alpha" }] };
		const { client, calls } = fakeClient({ "tab.list": ownedTabs });
		const fake = fakePi("alpha");
		registerHerdrWithDeps(piApi(fake), depsWith(client));

		await fire(fake, "session_start", { reason: "startup" }, ctx("Opus"));
		await fire(fake, "session_info_changed", { name: "event-name" }, ctx("Opus"));

		const rename = calls.filter((c) => c.method === "tab.rename").at(-1);
		assert.deepEqual(rename?.params, { tab_id: "w1:t1", label: "event-name" });
	});

	it("reports only the model token and skips the tab rename when unnamed", async () => {
		const { client, calls } = fakeClient({ "tab.list": autoTabs });
		const fake = fakePi(undefined);
		registerHerdrWithDeps(piApi(fake), depsWith(client));

		await fire(fake, "session_start", { reason: "startup" }, ctx("Opus"));

		const report = calls.find((c) => c.method === "pane.report_metadata");
		assert.ok(report);
		assert.deepEqual(report.params.tokens, { model: "Opus" });
		assert.equal(calls.some((c) => c.method === "tab.rename"), false);
	});

	it("refreshes the model token on model changes", async () => {
		const { client, calls } = fakeClient({ "tab.list": autoTabs });
		const fake = fakePi("alpha");
		registerHerdrWithDeps(piApi(fake), depsWith(client));

		await fire(fake, "session_start", { reason: "startup" }, ctx("Opus"));
		await fire(fake, "model_select", { source: "set" }, ctx("Sonnet"));

		const report = calls.filter((c) => c.method === "pane.report_metadata").at(-1);
		assert.deepEqual(report?.params.tokens, { model: "Sonnet" });
	});

	it("restores the numeric tab label when the name clears", async () => {
		const ownedTabs = { tabs: [{ tab_id: "w1:t1", label: "alpha" }] };
		const { client, calls } = fakeClient({ "tab.list": ownedTabs });
		const fake = fakePi("alpha");
		registerHerdrWithDeps(piApi(fake), depsWith(client));

		await fire(fake, "session_start", { reason: "startup" }, ctx("Opus"));
		fake.sessionName = undefined;
		await fire(fake, "session_info_changed", { name: undefined }, ctx("Opus"));
		const rename = calls.find((c) => c.method === "tab.rename");
		assert.deepEqual(rename?.params, { tab_id: "w1:t1", label: "1" });
	});

	it("clears the token and restores the tab on quit, and does nothing on reload", async () => {
		const ownedTabs = { tabs: [{ tab_id: "w1:t1", label: "alpha" }] };
		const { client, calls } = fakeClient({ "tab.list": ownedTabs });
		const fake = fakePi("alpha");
		registerHerdrWithDeps(piApi(fake), depsWith(client));

		await fire(fake, "session_start", { reason: "startup" }, ctx("Opus"));
		calls.length = 0;

		await fire(fake, "session_shutdown", { reason: "reload" }, ctx("Opus"));
		assert.equal(calls.length, 0);

		await fire(fake, "session_shutdown", { reason: "quit" }, ctx("Opus"));
		const report = calls.find((c) => c.method === "pane.report_metadata");
		assert.ok(report);
		assert.deepEqual(report.params.tokens, { model: null });
		const rename = calls.find((c) => c.method === "tab.rename");
		assert.deepEqual(rename?.params, { tab_id: "w1:t1", label: "1" });
	});

	it("serializes rapid events", async () => {
		const { client, calls } = fakeClient({ "tab.list": autoTabs });
		const fake = fakePi("alpha");
		registerHerdrWithDeps(piApi(fake), depsWith(client));

		await fire(fake, "session_start", { reason: "startup" }, ctx("Opus"));
		fake.sessionName = "beta";
		const second = fire(fake, "session_info_changed", { name: "beta" }, ctx("Opus"));
		fake.sessionName = "gamma";
		const third = fire(fake, "session_info_changed", { name: "gamma" }, ctx("Opus"));
		await Promise.all([second, third]);

		const reports = calls.filter((c) => c.method === "pane.report_metadata");
		const seqs = reports.map((c) => c.params.seq as number);
		assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
		const rename = calls.filter((c) => c.method === "tab.rename").at(-1);
		assert.deepEqual(rename?.params, { tab_id: "w1:t1", label: "gamma" });
	});

	it("survives a dead socket", async () => {
		const { client } = fakeClient({});
		const fake = fakePi("alpha");
		registerHerdrWithDeps(piApi(fake), depsWith(client));
		await fire(fake, "session_start", { reason: "startup" }, ctx("Opus"));
		await fire(fake, "session_info_changed", { name: "beta" }, ctx("Opus"));
	});
});
