import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { HostLink } from "./client.mts";
import { ContractError, decodeInput, decodeResponse, RESERVED_COMMANDS, type JsonObject } from "./contract.mts";
import { commandReply, descriptor, FakeHost, STORAGE, statusReply } from "./fake-host.mts";
import type { RetainedReader } from "./retained-read.mts";
import { type AgentCatalog, AgentService, type CatalogRecord, deriveEndpoint } from "./service-runtime.mts";

const code = (expected: string) => (error: unknown): boolean => {
	assert.equal((error as { code?: string }).code, expected);
	return true;
};
function refuse(fn: () => unknown): void {
	assert.throws(fn, (error: unknown) => error instanceof ContractError && error.code === "malformed");
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

test("status decodes the host inventory and keeps a not-live reply without one", () => {
	const reply = decodeResponse("status", statusReply());
	assert.equal(reply.inventory?.contributions[0].name, "fixture-contribution");
	assert.deepEqual(reply.inventory?.ordinaryOnly, ["fixture-ordinary"]);
	const stored = decodeResponse("status", { conversation: {}, live: false, storageId: STORAGE });
	assert.equal(stored.inventory, undefined);
	const failed = clone(statusReply()); (failed.inventory as JsonObject).failed = [{ path: "/x/extension.ts", error: "boom" }];
	assert.equal(decodeResponse("status", failed).inventory?.failed?.[0].path, "/x/extension.ts");
});

test("status refuses a malformed inventory", () => {
	const bad = (mutate: (value: JsonObject) => void) => { const value = clone(statusReply()); mutate(value.inventory as JsonObject); return value; };
	refuse(() => decodeResponse("status", bad(inventory => { inventory.contributions = {} as never; })));
	refuse(() => decodeResponse("status", bad(inventory => { (inventory.contributions as JsonObject[])[0].commands = [{ name: "x" }] as never; })));
	refuse(() => decodeResponse("status", bad(inventory => { (inventory.contributions as JsonObject[])[0].extra = 1; })));
	refuse(() => decodeResponse("status", bad(inventory => { inventory.ordinaryOnly = [1] as never; })));
	refuse(() => decodeResponse("status", bad(inventory => { inventory.failed = [{ path: "x" }] as never; })));
	refuse(() => decodeResponse("status", { storageId: STORAGE, inventory: {} }));
	refuse(() => decodeResponse("status", { conversation: {} }));
});

test("a command result names its target and shape", () => {
	const result = decodeResponse("command", commandReply(STORAGE, "ping", "pong"), { identity: STORAGE });
	assert.equal(result.text, "pong");
	assert.equal(decodeResponse("command", commandReply(STORAGE, "ping", ""), { identity: STORAGE }).text, "");
	refuse(() => decodeResponse("command", { ...commandReply(STORAGE, "ping", "pong"), extra: 1 }, { identity: STORAGE }));
	refuse(() => decodeResponse("command", commandReply(`${STORAGE}:2`, "ping", "pong"), { identity: STORAGE }));
	refuse(() => decodeResponse("command", { ...commandReply(STORAGE, "ping", "pong"), text: 3 }, { identity: STORAGE }));
});

test("command and status requests accept exactly the documented parameters", () => {
	assert.deepEqual(decodeInput("status", { sessionId: STORAGE }), { sessionId: STORAGE });
	refuse(() => decodeInput("status", { sessionId: STORAGE, conversationId: 1 }));
	const request = { sessionId: STORAGE, name: "ping", args: "a b", invocationId: "ui:operation" };
	assert.deepEqual(decodeInput("command", request), request);
	assert.deepEqual(decodeInput("command", { sessionId: STORAGE, name: "ping", invocationId: "ui:operation" }), { sessionId: STORAGE, name: "ping", invocationId: "ui:operation" });
	for (const name of RESERVED_COMMANDS) refuse(() => decodeInput("command", { ...request, name }));
	for (const bad of [{ name: "" }, { name: "has space" }, { name: "/ping" }, { name: "x".repeat(129) }, { args: 3 }, { args: "x".repeat(64 * 1024 + 1) },
		{ invocationId: "" }, { invocationId: "has space" }, { data: {} }, { sessionId: "bad id" }]) refuse(() => decodeInput("command", { ...request, ...bad }));
	refuse(() => decodeInput("command", { sessionId: STORAGE, name: "ping" }));
});

test("a link negotiates status and command and runs a command once through the exact operations", async t => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	assert.equal(link.supports("status"), true);
	assert.equal(link.supports("command"), true);
	const reply = await link.request("status", { sessionId: STORAGE }, { identity: STORAGE }) as { inventory: { contributions: unknown[] } };
	assert.equal(reply.inventory.contributions.length, 1);
	const result = await link.request("command", { sessionId: STORAGE, name: "ping", args: "", invocationId: "ui:op-1" }, { identity: STORAGE }) as { text: string };
	assert.equal(result.text, "pong");
	assert.deepEqual(host.calls.map(call => call.member), ["status", "command"]);
	assert.deepEqual(host.calls[0].expected, { request: "status/1.0.0", response: "d1f5f022e262aba18b6de135e891aef526cf9f0f62f114e51f3c132e624eb6cf", durable: (await descriptor() as { upstream: { durable: string } }).upstream.durable });
	assert.equal((host.calls[1].expected as { request: string; response: string }).request, "command/1.1.0");
	assert.equal((host.calls[1].expected as { request: string; response: string }).response, "command/1.0.0");
	assert.equal(host.calls[1].params?.invocationId, "ui:op-1");
});

test("a host without the command identities refuses before any call and keeps other operations", async t => {
	const remote = await descriptor();
	const operations = remote.operations as Record<string, Record<string, unknown>>;
	operations.command.request = "command/2.0.0";
	delete operations.status;
	const host = await FakeHost.start({ descriptor: remote as never });
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	assert.equal(link.supports("status"), false);
	assert.equal(link.supports("command"), false);
	assert.equal(link.supports("abort"), true);
	await assert.rejects(link.request("status", { sessionId: STORAGE }, { identity: STORAGE }), code("contract_mismatch"));
	await assert.rejects(link.request("command", { sessionId: STORAGE, name: "ping", invocationId: "ui:op" }, { identity: STORAGE }), code("contract_mismatch"));
	assert.equal(host.calls.length, 0);
});

test("a command is refused locally when reserved or malformed, before any call", async t => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	await assert.rejects(link.request("command", { sessionId: STORAGE, name: "reload", invocationId: "ui:op" }, { identity: STORAGE }), code("invalid_request"));
	await assert.rejects(link.request("command", { sessionId: STORAGE, name: "tree", args: "1", invocationId: "ui:op" }, { identity: STORAGE }), code("invalid_request"));
	assert.equal(host.calls.length, 0);
});

test("a result for another command name or a malformed result is an uncertain protocol error and disables the operation", async t => {
	const host = await FakeHost.start({ handler: call => {
		if (call.member !== "command") return undefined;
		return call.params?.name === "ping" ? commandReply(STORAGE, "other", "x") : { name: call.params?.name, text: 1 } as JsonObject;
	} });
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	await assert.rejects(link.request("command", { sessionId: STORAGE, name: "ping", invocationId: "ui:op" }, { identity: STORAGE }), (error: unknown) => {
		assert.equal((error as { code?: string }).code, "protocol_error");
		assert.equal((error as { uncertain?: boolean }).uncertain, true);
		return true;
	});
	assert.equal(link.supports("command"), false);
	assert.equal(link.supports("status"), true);
});

async function catalogService(t: test.TestContext, scan: (known: () => void) => Promise<void>, scanState?: string) {
	const root = await fs.mkdtemp(join(tmpdir(), "ui-commands-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const record: CatalogRecord = { storageId: STORAGE, cwd: root, agentDir: root, packageDir: root, storagePath: join(root, "agent.sqlite"),
		model: { provider: "synthetic", modelId: "synthetic" }, thinkingLevel: "off", createdAt: "2026-01-01T00:00:00.000Z" };
	const endpoint = deriveEndpoint(record);
	await fs.mkdir(dirname(endpoint.socketPath), { recursive: true });
	await fs.mkdir(dirname(endpoint.claimPath), { recursive: true });
	await fs.writeFile(endpoint.claimPath, JSON.stringify({ sessionId: STORAGE, cwd: root, host: hostname(), createdAt: record.createdAt, pid: process.pid }));
	const host = await FakeHost.start({ endpoint });
	t.after(() => host.close());
	let loaded = false, scans = 0;
	const agents = new AgentService({ store: root, stateDir: root, installationId: "synthetic" },
		() => ({ get: (id: string) => loaded && id === STORAGE ? record : undefined, scanState, refresh: async () => { scans++; await scan(() => { loaded = true; }); return {}; }, close: async () => {} }) as unknown as AgentCatalog,
		() => ({ request: async () => { throw new Error("Unexpected retained read"); }, close: async () => {} }) as unknown as RetainedReader);
	t.after(() => agents.close());
	return { agents, host, scans: () => scans };
}
test("a command list asked before the first catalog scan ends waits for that scan and then reads the host", { timeout: 10000 }, async t => {
	let release: () => void = () => {};
	const s = await catalogService(t, known => new Promise<void>(resolve => { release = () => { known(); resolve(); }; }));
	let settled = false;
	const pending = s.agents.inventory(STORAGE).finally(() => { settled = true; });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(settled, false); assert.equal(s.host.calls.length, 0);
	release();
	const inventory = await pending;
	assert.equal(inventory.contributions[0]?.name, "fixture-contribution");
	assert.equal(s.scans(), 1);
	await s.agents.inventory(STORAGE); assert.equal(s.scans(), 1, "a later read does not scan again");
});
test("an agent missing after the first scan is refused as before and does not trigger another scan", { timeout: 10000 }, async t => {
	const s = await catalogService(t, async () => {});
	await assert.rejects(s.agents.inventory(STORAGE), (error: unknown) => (error as { code?: string }).code === "host_unavailable" && /not in the retained catalog/.test((error as Error).message));
	await assert.rejects(s.agents.inventory(STORAGE), code("host_unavailable"));
	assert.equal(s.scans(), 1); assert.equal(s.host.calls.length, 0);
});

const refused = (error: unknown): boolean => (error as { code?: string }).code === "host_unavailable" && /not in the retained catalog/.test((error as Error).message);
test("two concurrent requests for an agent the catalog does not know yet cause exactly one scan", { timeout: 10000 }, async t => {
	let release: () => void = () => {};
	const s = await catalogService(t, known => new Promise<void>(resolve => { release = () => { known(); resolve(); }; }));
	const first = s.agents.inventory(STORAGE), second = s.agents.inventory(STORAGE);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(s.scans(), 1);
	release();
	assert.equal((await first).contributions.length, 1); assert.equal((await second).contributions.length, 1);
	assert.equal(s.scans(), 1);
});
test("after a failed first scan a later request for an unknown agent starts no scan and is refused", { timeout: 10000 }, async t => {
	const s = await catalogService(t, async () => { throw new Error("The store is unreadable."); });
	await assert.rejects(s.agents.inventory(STORAGE), refused);
	await assert.rejects(s.agents.inventory(STORAGE), refused);
	await assert.rejects(s.agents.inventory(`${STORAGE}:2`), refused);
	assert.equal(s.scans(), 1); assert.equal(s.host.calls.length, 0);
});
test("a request that arrives after the startup scan ended starts no scan", { timeout: 10000 }, async t => {
	const s = await catalogService(t, async known => { known(); });
	await s.agents.refresh(); assert.equal(s.scans(), 1);
	assert.equal((await s.agents.inventory(STORAGE)).contributions.length, 1);
	assert.equal(s.scans(), 1);
	const empty = await catalogService(t, async () => {});
	await empty.agents.refresh(); await assert.rejects(empty.agents.inventory(STORAGE), refused); assert.equal(empty.scans(), 1);
});
test("a catalog that reports a finished scan is not scanned again by a request", { timeout: 10000 }, async t => {
	for (const state of ["ready", "failed"]) {
		const s = await catalogService(t, async () => {}, state);
		await assert.rejects(s.agents.inventory(STORAGE), refused);
		assert.equal(s.scans(), 0, state);
	}
});
