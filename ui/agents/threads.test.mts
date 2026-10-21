import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { type AgentError, HostLink } from "./client.mts";
import { ContractError, decodeInput, decodeResponse, type JsonObject } from "./contract.mts";
import { CHILD, descriptor, FakeHost, type FakeHostOptions, STORAGE, THREAD, threadEvents, threadList, threadPage } from "./fake-host.mts";
import { type AgentCatalog, AgentService, type CatalogRecord, deriveEndpoint } from "./service-runtime.mts";
import type { RetainedReader } from "./retained-read.mts";

const code = (expected: string) => (error: unknown): boolean => {
	assert.equal((error as { code?: string }).code, expected);
	return true;
};
function refuse(fn: () => unknown): void {
	assert.throws(fn, (error: unknown) => error instanceof ContractError && error.code === "malformed");
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function page(mutate?: (value: JsonObject) => void, input: JsonObject = { threadId: THREAD }): JsonObject {
	const value = threadPage(input); mutate?.(value); return value;
}

test("thread list and read decode the current host shapes", () => {
	const list = decodeResponse("collaboration-list", threadList());
	assert.equal(list.items[0].id, THREAD);
	assert.equal(list.nextCursor, null);
	const read = decodeResponse("collaboration-read", threadPage({ threadId: THREAD }));
	assert.deepEqual(read.events.map(event => event.sequence), [1, 2, 3, 4, 5]);
	assert.equal(read.nextBefore, null);
	assert.equal(read.coverage.complete, true);
	const older = decodeResponse("collaboration-read", threadPage({ threadId: THREAD, limit: 2 }));
	assert.deepEqual(older.events.map(event => event.sequence), [4, 5]);
	assert.equal(older.nextBefore, 4);
	assert.equal(older.coverage.complete, false);
});

test("thread list refuses unknown fields, bad identities and disagreeing continuation", () => {
	const list = (mutate: (value: JsonObject) => void) => { const value = clone(threadList()); mutate(value); return value; };
	refuse(() => decodeResponse("collaboration-list", list(value => { value.extra = 1; })));
	refuse(() => decodeResponse("collaboration-list", list(value => { (value.items as JsonObject[])[0].id = "not-a-thread"; })));
	refuse(() => decodeResponse("collaboration-list", list(value => { (value.items as JsonObject[])[0].members = 65; })));
	refuse(() => decodeResponse("collaboration-list", list(value => { value.nextCursor = "x"; (value.coverage as JsonObject).complete = false; })));
	refuse(() => decodeResponse("collaboration-list", list(value => { value.nextCursor = "3"; })));
	refuse(() => decodeResponse("collaboration-list", list(value => { (value.coverage as JsonObject).visited = 65; })));
	refuse(() => decodeResponse("collaboration-list", list(value => { value.items = Array.from({ length: 21 }, () => (value.items as JsonObject[])[0]); })));
	decodeResponse("collaboration-list", list(value => { value.nextCursor = "64"; (value.coverage as JsonObject).complete = false; (value.items as JsonObject[]).length = 0; }));
});

test("thread read refuses pages that misstate order, ownership or continuation", () => {
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.thread as JsonObject).extra = 1; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.thread as JsonObject).id = "bad"; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.thread as JsonObject).integrator = "@name"; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.thread as JsonObject).updatedAt = 1; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.events as JsonObject[])[1].sequence = 9; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.events as JsonObject[])[0].threadId = `${STORAGE}/${"b".repeat(32)}`; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.events as JsonObject[])[0].origin = "agent"; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.events as JsonObject[])[2].replyTo = 3; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.events as JsonObject[])[0].revision = 3; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.events as JsonObject[])[0].notify = ["x"]; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { value.nextBefore = 3; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.coverage as JsonObject).complete = false; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.events as JsonObject[]).shift(); })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.events as JsonObject[]).push(clone(threadEvents()[4])); })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.coverage as JsonObject).bytes = 48 * 1024 + 1; })));
	refuse(() => decodeResponse("collaboration-read", page(value => { (value.events as JsonObject[])[0].message = ""; })));
});

test("thread requests accept exactly the documented parameters", () => {
	assert.deepEqual(decodeInput("collaboration-list", {}), {});
	assert.deepEqual(decodeInput("collaboration-list", { cursor: "0", limit: 20, query: "design" }), { cursor: "0", limit: 20, query: "design" });
	for (const bad of [{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { cursor: "01" }, { cursor: "-1" }, { cursor: "a" }, { query: "" }, { query: "  " },
		{ query: "x".repeat(257) }, { sessionId: STORAGE }, { before: 1 }]) refuse(() => decodeInput("collaboration-list", bad));
	assert.deepEqual(decodeInput("collaboration-read", { threadId: THREAD }), { threadId: THREAD });
	assert.deepEqual(decodeInput("collaboration-read", { threadId: THREAD, limit: 20, before: 7 }), { threadId: THREAD, limit: 20, before: 7 });
	for (const bad of [{}, { threadId: STORAGE }, { threadId: `${THREAD}/x` }, { threadId: THREAD, before: 0 }, { threadId: THREAD, limit: 21 },
		{ threadId: THREAD, sessionId: STORAGE }, { threadId: THREAD, cursor: "0" }]) refuse(() => decodeInput("collaboration-read", bad));
});

test("a link negotiates and pages threads through the exact host operations", async t => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	assert.equal(link.supports("collaboration-list"), true);
	assert.equal(link.supports("collaboration-read"), true);
	assert.equal(link.supports("task-submit"), true);
	assert.equal((await link.request("collaboration-list", { limit: 5 }) as { items: unknown[] }).items.length, 1);
	const newest = await link.request("collaboration-read", { threadId: THREAD, limit: 2 }) as { events: { sequence: number }[]; nextBefore: number };
	assert.deepEqual(newest.events.map(event => event.sequence), [4, 5]);
	const older = await link.request("collaboration-read", { threadId: THREAD, limit: 2, before: newest.nextBefore }) as { events: { sequence: number }[]; nextBefore: number };
	assert.deepEqual(older.events.map(event => event.sequence), [2, 3]);
	const first = await link.request("collaboration-read", { threadId: THREAD, before: older.nextBefore }) as { events: { sequence: number }[]; nextBefore: number | null };
	assert.deepEqual(first.events.map(event => event.sequence), [1]);
	assert.equal(first.nextBefore, null);
	assert.deepEqual(host.calls.map(call => call.member), ["collaboration-list", "collaboration-read", "collaboration-read", "collaboration-read"]);
	assert.deepEqual(host.calls[0].expected, { request: "collaboration-list/1.0.0", response: "collaboration-list/1.0.0" });
	assert.deepEqual(host.calls[1].params, { threadId: THREAD, limit: 2 });
});

test("a host without the thread operations refuses before any call and keeps other operations", async t => {
	const remote = await descriptor();
	const operations = remote.operations as Record<string, Record<string, unknown>>;
	delete operations["collaboration-list"];
	operations["collaboration-read"].response = "collaboration-read/2.0.0";
	const host = await FakeHost.start({ descriptor: remote as never });
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	assert.equal(link.supports("collaboration-list"), false);
	assert.equal(link.supports("collaboration-read"), false);
	assert.equal(link.supports("abort"), true);
	await assert.rejects(link.request("collaboration-list", {}), code("contract_mismatch"));
	await assert.rejects(link.request("collaboration-read", { threadId: THREAD }), code("contract_mismatch"));
	assert.equal(host.calls.length, 0);
});

test("a link refuses invalid thread input before dispatch and a mismatched answer disables the operation", async t => {
	const host = await FakeHost.start({ handler: call => {
		if (call.member !== "collaboration-read") return undefined;
		if (call.params?.before === 3) return { ...threadPage({ threadId: THREAD, before: 4 }) };
		if (call.params?.limit === 1) return { ...threadPage({ threadId: THREAD }) };
		const other = clone(threadPage({ threadId: THREAD })) as JsonObject;
		(other.thread as JsonObject).id = `${STORAGE}/${"b".repeat(32)}`;
		for (const event of other.events as JsonObject[]) event.threadId = (other.thread as JsonObject).id;
		return other;
	} });
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	await assert.rejects(link.request("collaboration-read", { threadId: "x" }), code("invalid_request"));
	assert.equal(host.calls.length, 0);
	await assert.rejects(link.request("collaboration-read", { threadId: THREAD, before: 3 }), code("protocol_error"));
	assert.equal(link.supports("collaboration-read"), false);
	assert.equal(link.supports("collaboration-list"), true);
});

test("pages that exceed the requested size or boundary are protocol errors", async t => {
	const host = await FakeHost.start({ handler: call => call.member === "collaboration-read" && call.params?.limit === 1 ? threadPage({ threadId: THREAD }) : undefined });
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	await assert.rejects(link.request("collaboration-read", { threadId: THREAD, limit: 1 }), code("protocol_error"));
});

async function service(t: test.TestContext, operations?: FakeHostOptions["handler"]) {
	const root = await fs.mkdtemp(join(tmpdir(), "ui-threads-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const record: CatalogRecord = { storageId: STORAGE, cwd: root, agentDir: root, packageDir: root, storagePath: join(root, "agent.sqlite"),
		model: { provider: "synthetic", modelId: "synthetic" }, thinkingLevel: "off", createdAt: "2026-01-01T00:00:00.000Z" };
	const endpoint = deriveEndpoint(record);
	await fs.mkdir(dirname(endpoint.socketPath), { recursive: true });
	await fs.mkdir(dirname(endpoint.claimPath), { recursive: true });
	await fs.writeFile(endpoint.claimPath, JSON.stringify({ sessionId: STORAGE, cwd: root, host: hostname(), createdAt: record.createdAt, pid: process.pid }));
	const host = await FakeHost.start({ endpoint, ...(operations ? { handler: operations } : {}) });
	t.after(() => host.close());
	let retained = 0;
	const agents = new AgentService({ store: root, stateDir: root, installationId: "synthetic" },
		() => ({ get: (id: string) => id === STORAGE ? record : undefined, close: async () => {} }) as unknown as AgentCatalog,
		() => ({ request: async () => { retained++; throw new Error("Unexpected retained read"); }, close: async () => {} }) as unknown as RetainedReader);
	t.after(() => agents.close());
	return { agents, host, get retained() { return retained; } };
}

test("the service reads the storage threads from its live host without a retained fallback", { timeout: 10000 }, async t => {
	const s = await service(t);
	const list = await s.agents.threads(CHILD, { limit: 3, query: "design" });
	assert.equal(list.items[0].id, THREAD);
	const read = await s.agents.thread(STORAGE, THREAD, { limit: 2 });
	assert.deepEqual(read.events.map(event => event.sequence), [4, 5]);
	assert.deepEqual(s.host.calls.map(call => [call.member, call.params]), [["collaboration-list", { limit: 3, query: "design" }], ["collaboration-read", { threadId: THREAD, limit: 2 }]]);
	assert.equal(s.host.connectionCount, 1);
	assert.equal(s.retained, 0);
	assert.equal(s.host.calls.some(call => call.member === "collaboration-mutate"), false);
});

test("the service refuses a thread that another storage owns and malformed options before any host call", { timeout: 10000 }, async t => {
	const s = await service(t);
	const foreign = `00000000-0000-4000-8000-000000000009/${"a".repeat(32)}`;
	await assert.rejects(s.agents.thread(STORAGE, foreign), code("invalid_request"));
	await assert.rejects(s.agents.thread(STORAGE, THREAD, { limit: 21 }), code("invalid_request"));
	await assert.rejects(s.agents.threads(STORAGE, { cursor: "x" }), code("invalid_request"));
	await assert.rejects(s.agents.threads("00000000-0000-4000-8000-000000000009"), code("host_unavailable"));
	assert.equal(s.host.calls.length, 0);
});

test('stopped storage threads use retained list and read without a host', async t => {
  const record: CatalogRecord = {storageId: STORAGE, cwd: '/project', agentDir: '/agent', packageDir: '/package', storagePath: '/missing.sqlite', model: {provider: 'sample', modelId: 'model'}, thinkingLevel: 'off', createdAt: '2026-01-01T00:00:00.000Z'};
  const calls: unknown[][] = [];
  const agents = new AgentService({store: '/missing-store', stateDir: '/state', installationId: 'sample'},
    () => ({get: () => record, close: async () => {}} as unknown as AgentCatalog),
    () => ({request: async (member: string, identity: string, params: JsonObject) => {calls.push([member, identity, params]); return member === 'collaboration-list' ? threadList() : threadPage(params);}, close: async () => {}} as unknown as RetainedReader));
  t.after(() => agents.close());
  assert.equal((await agents.threads(STORAGE)).source, 'retained');
  const page = await agents.thread(STORAGE, THREAD, {limit: 2});
  assert.equal(page.source, 'retained'); assert.deepEqual(page.events.map(event => event.sequence), [4, 5]);
  assert.deepEqual(calls, [['collaboration-list', STORAGE, {}], ['collaboration-read', STORAGE, {threadId: THREAD, limit: 2}]]);
});

test("a host error for an absent thread reaches the caller and the link stays usable", { timeout: 10000 }, async t => {
	const s = await service(t);
	await assert.rejects(s.agents.thread(STORAGE, `${STORAGE}/${"c".repeat(32)}`), /Thread not found/);
	assert.equal((await s.agents.threads(STORAGE)).items.length, 1);
});

test("cancelling a thread read releases its wait and keeps the connection", { timeout: 10000 }, async t => {
	const controller = new AbortController();
	const s = await service(t, call => call.member === "collaboration-list" && !controller.signal.aborted
		? new Promise<undefined>(resolve => call.signal.addEventListener("abort", () => resolve(undefined), { once: true })) : undefined);
	const pending = s.agents.threads(STORAGE, {}, controller.signal);
	const rejected = assert.rejects(pending, (error: unknown) => (error as AgentError).code === "cancelled");
	await s.host.waitForCall(call => call.member === "collaboration-list");
	controller.abort();
	await rejected;
	assert.equal((await s.agents.threads(STORAGE)).items.length, 1);
	assert.equal(s.host.connectionCount, 1);
});
