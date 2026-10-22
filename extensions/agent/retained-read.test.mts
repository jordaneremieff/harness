import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createTransportServer } from "../../transport/index.ts";
import { connectHost } from "./host-client.ts";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { CollaborationEvents, CollaborationIndex, CollaborationReadError, CollaborationThreads, mutateCollaboration, type CollaborationList, type CollaborationPage } from "./collaboration.ts";
import { DurableHost } from "./durable-host.ts";
import { DurableObservation } from "./durable-observation.ts";
import { fixtureRegistry, fixtureRuntime, hostOptions } from "./durable-host-fixture.mts";
import { fixtureMetadata, eventLog, waitForProcessExit } from "./host-fixture.mts";
import { parseCommunicationView } from "./communication.ts";
import { hostPaths } from "./host-protocol.ts";
import { HOST_CONTRACT } from "./version-contract.ts";
import { retainedRead, retainedReadDescriptor, RETAINED_READ_VERSION, RETAINED_REQUEST_BYTES, type RetainedResponse } from "./retained-read.ts";
import { RetainedReadError } from "./retained-errors.ts";

// Fixed consumer expectations, not a contract discovered and echoed into a request.
const snapshotContract = { request: "snapshot/1.0.0", response: "snapshot/2.0.0", durable: HOST_CONTRACT.upstream.durable };
const inspectContract = { request: "inspect/1.1.0", response: "d38d5e5a297d6b3738547ab0154cd494602f01c4a898423a076d2d946e430a6b", durable: HOST_CONTRACT.upstream.durable };
const storageId = "00000000-0000-4000-8000-000000000001";
const cli = fileURLToPath(new URL("./retained-read.ts", import.meta.url));

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "retained-reader-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const catalog = new AgentCatalog(root);
	const { storageId: _id, storagePath: _path, ...metadata } = fixtureMetadata(root);
	const record = catalog.create(metadata);
	return { root, catalog, record };
}
function request(store = "/synthetic/store", target = storageId, method = "snapshot", params: Record<string, unknown> = {}) {
	return { version: RETAINED_READ_VERSION, id: "consumer-17", store, sessionId: target, method, expected: method === "inspect" ? inspectContract : snapshotContract, params };
}
function bytes(value: unknown): Buffer { return Buffer.from(JSON.stringify(value)); }
function success(response: RetainedResponse) { assert.equal(response.ok, true, JSON.stringify(response)); if (!response.ok) throw new Error("Expected success"); return response; }
function failure(response: RetainedResponse, code: string, retryable = false) {
	assert.equal(response.ok, false);
	if (response.ok) throw new Error("Expected failure");
	assert.equal(response.error.code, code);
	assert.equal(response.error.retryable, retryable);
	assert.deepEqual(Object.keys(response).sort(), ["error", "id", "ok", "version"]);
	assert.ok(response.error.message.length <= 2000);
}

async function invoke(input: string | Buffer, args: string[] = []) {
	const child = spawn(process.execPath, [cli, ...args], { stdio: ["pipe", "pipe", "pipe"] });
	const exited = waitForProcessExit(child, 30000);
	const output: Buffer[] = [];
	const diagnostics: Buffer[] = [];
	child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
	child.stderr.on("data", (chunk) => diagnostics.push(Buffer.from(chunk)));
	child.stdin.on("error", () => {});
	child.stdin.end(input);
	await exited;
	const stdout = Buffer.concat(output).toString("utf8");
	assert.equal(stdout.trim().split("\n").length, 1);
	return { response: JSON.parse(stdout), stdout, exitCode: child.exitCode, stderr: Buffer.concat(diagnostics).toString("utf8") };
}

type ThreadMethod = "collaboration-list" | "collaboration-read";
const threadContracts = {
	"collaboration-list": { request: "collaboration-list/1.0.0", response: "collaboration-list/1.0.0" },
	"collaboration-read": { request: "collaboration-read/1.0.0", response: "collaboration-read/1.0.0" },
};
const threadId = `${storageId}/${"a".repeat(32)}`;
const foreignThreadId = `00000000-0000-4000-8000-000000000002/${"b".repeat(32)}`;
function threadRequest(store = "/synthetic/store", target = storageId, method: ThreadMethod = "collaboration-list", params: Record<string, unknown> = {}) {
	return { ...request(store, target, "snapshot", params), method, expected: threadContracts[method] };
}
async function threadFixture(t: TestContext, count = 1) {
	const f = fixture(t);
	const harness = await Harness.open(await openNodeSqliteStorage(f.record.storagePath), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
	t.after(() => harness.close(BACKGROUND_CONTEXT));
	const ids: string[] = [];
	for (let index = 0; index < count; index++) {
		const created = await mutateCollaboration(harness, f.record.storageId, {
			action: "create", senderIdentity: f.record.storageId, origin: "model", requestId: `thread-${index}`,
			title: `Thread ${index}`, purpose: `${"p".repeat(160)} ${index === count - 1 ? "needle" : "scope"}`,
			authority: "Test authority", source: "Test source", restrictions: "Read only", acceptance: "Read the retained thread",
		}, BACKGROUND_CONTEXT);
		ids.push(created.threadId);
	}
	return { ...f, harness, ids };
}

function fileState(root: string): unknown {
	return readdirSync(root, { recursive: true }).map(String).sort().map((name) => {
		const path = join(root, name);
		const s = lstatSync(path, { bigint: true });
		return { name, dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeNs, ctime: s.ctimeNs, hash: s.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : null };
	});
}

it("validates identity, exact contracts, and parameters before retained I/O", async () => {
	let reads = 0;
	const hooks = { readCatalog: () => { reads++; throw new Error("must not read"); } };
	const base = request();
	const cases = [
		{ ...base, extra: true }, Object.fromEntries(Object.entries(base).filter(([key]) => key !== "version")), { ...base, id: "bad id" }, { ...base, store: "relative" },
		...[':1', ':02', ':0', ':9007199254740992', ':2:3'].map((suffix) => ({ ...base, sessionId: `${storageId}${suffix}` })),
		...['@handle', '/arbitrary/file', 'ABCDEF00-0000-4000-8000-000000000001'].map((sessionId) => ({ ...base, sessionId })),
		{ ...base, params: { sessionId: storageId } }, { ...base, params: { limit: 101 } },
		{ ...base, params: { before: "2" } }, { ...base, params: { maxBytes: 1048577 } },
		{ ...base, method: "history" }, { ...base, expected: { ...snapshotContract, extra: true } },
		...[
			{}, { view: "history", limit: "bad" }, { view: "history", limit: {} }, { view: "exact" }, { view: "search" }, { view: "result" }, { view: "history", requestId: "req" },
			{ view: "history", entryId: "1" }, { view: "history", query: "" }, { view: "history", cwd: "/x" },
			{ view: "history", cursor: { data: "x".repeat(4096) } }, { view: "result", requestId: "\u007f" },
		].map((params) => request(base.store, storageId, "inspect", params)),
	];
	for (const value of cases) failure(await retainedRead(bytes(value), undefined, hooks), "invalid_request");
	for (const value of [{ ...base, version: "retained-read/2.0.0" }, ...["request", "response", "durable"].map((key) => ({ ...base, expected: { ...snapshotContract, [key]: key === "durable" ? "1.0.0" : "wrong/1.0.0" } })), { ...base, expected: { ...snapshotContract, durable: "1.2.0" } }, { ...base, expected: { request: snapshotContract.request, response: snapshotContract.response } }]) failure(await retainedRead(bytes(value), undefined, hooks), "incompatible");
	assert.equal(reads, 0);
});

it("bounds and correlates errors for JSON, request, output, deadline, cancellation, and internal failures", async () => {
	failure(await retainedRead(Buffer.from("{bad")), "invalid_request");
	failure(await retainedRead(Buffer.from(`${JSON.stringify(request())} {}`)), "invalid_request");
	failure(await retainedRead(Buffer.from([0xff])), "invalid_request");
	failure(await retainedRead(Buffer.alloc(RETAINED_REQUEST_BYTES + 1)), "limit_exceeded");
	const controller = new AbortController(); controller.abort();
	failure(await retainedRead(bytes(request()), controller.signal), "cancelled");
	failure(await retainedRead(bytes(request()), undefined, { deadlineMs: 0 }), "timeout", true);
	let closed = 0;
	const hooks = { readCatalog: () => ({ storagePath: "/synthetic/private" }), open: async () => ({ conversation: async () => ({}) as never, request: async () => ({ value: "x".repeat(1000) }), close: async () => { closed++; } }), responseBytes: 500 };
	const bounded = await retainedRead(bytes(request()), undefined, hooks);
	failure(bounded, "limit_exceeded"); assert.equal(bounded.id, "consumer-17"); assert.equal(closed, 1);
	failure(await retainedRead(bytes(request()), undefined, { ...hooks, open: async () => { throw new RetainedReadError("source_changed"); } }), "source_changed", true);
	failure(await retainedRead(bytes(request()), undefined, { ...hooks, open: async () => { throw new Error("private secret path must not appear"); } }), "internal");
	failure(await retainedRead(bytes(request()), undefined, { ...hooks, open: async () => ({ conversation: async () => ({}) as never, request: async () => { throw new TypeError("Implementation failure"); }, close: async () => { closed++; } }) }), "internal");
	let opened = false;
	failure(await retainedRead(bytes(request()), undefined, { ...hooks, open: async () => { opened = true; throw new Error("Must not open"); } }, 0), "timeout", true);
	assert.equal(opened, false, "An expired shared deadline does not restart after stdin");
});

it("publishes only the two read contracts and emits one structured process response", async () => {
	const descriptor = retainedReadDescriptor();
	assert.deepEqual(descriptor, { version: RETAINED_READ_VERSION, upstream: HOST_CONTRACT.upstream, operations: { snapshot: snapshotContract, inspect: inspectContract } });
	const found = await invoke("", ["--contract"]);
	assert.equal(found.exitCode, 0); assert.deepEqual(found.response, descriptor);
	const malformed = await invoke("{} trailing");
	assert.equal(malformed.exitCode, 1); failure(malformed.response, "invalid_request");
	const args = await invoke("", ["--contract", "extra"]);
	failure(args.response, "invalid_request");
});

it("matches all documented retained-read fixtures without using Agent fixtures in a consumer", async () => {
	const doc = readFileSync(new URL("../../docs/agent-host-contract.md", import.meta.url), "utf8");
	const fixture = (name: string): Record<string, unknown> => {
		const match = doc.match(new RegExp(`### Fixture: ${name}\\n\\n\\x60\\x60\\x60json\\n([^\\n]+)\\n\\x60\\x60\\x60`, "u"));
		assert.ok(match, `Missing documented fixture ${name}`);
		return JSON.parse(match[1]);
	};
	assert.deepEqual(retainedReadDescriptor(), fixture("retained-read-descriptor"));
	const input = fixture("retained-read-request");
	const expected = fixture("retained-read-success");
	const hooks = { readCatalog: () => ({ storagePath: "/synthetic/private" }), open: async () => ({ conversation: async () => ({}) as never, request: async () => expected.result, close: async () => {} }) };
	assert.deepEqual(await retainedRead(bytes(input), undefined, hooks), expected);
	assert.deepEqual(await retainedRead(bytes(input), undefined, { ...hooks, open: async () => { throw new RetainedReadError("source_changed"); } }), fixture("retained-read-error"));
	let read = false;
	failure(await retainedRead(bytes(request("/synthetic/store", storageId, "inspect", { view: "search", query: "\u0000\n" })), undefined, { readCatalog: () => { read = true; throw new Error("No source"); } }), "source_unreadable");
	assert.equal(read, true, "Query control characters remain legal at the public grammar");
});

it("emits a cancelled envelope when the caller interrupts an incomplete stdin request", async (t) => {
	const bootstrap = `process.argv[1] = ${JSON.stringify(cli)}; process.stdin.once('resume', () => { process.send('reading'); process.disconnect(); }); await import(${JSON.stringify(new URL("./retained-read.ts", import.meta.url).href)});`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", bootstrap], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
	t.after(() => { child.kill("SIGKILL"); });
	const exited = waitForProcessExit(child, 30000);
	const output: Buffer[] = [];
	assert.ok(child.stdout, "Expected the configured stdout pipe");
	assert.ok(child.stderr, "Expected the configured stderr pipe");
	child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
	child.stderr.on("data", () => {});
	await new Promise<void>((resolve) => child.once("message", () => resolve()));
	child.kill("SIGTERM");
	await exited;
	const lines = Buffer.concat(output).toString("utf8").trim().split("\n");
	assert.equal(lines.length, 1);
	failure(JSON.parse(lines[0]), "cancelled");
	assert.equal(child.exitCode, 1);
});

it("distinguishes missing catalog, source, child, and wrong catalog identities", async (t) => {
	const f = fixture(t);
	failure(await retainedRead(bytes(request(f.root, storageId))), "not_found");
	failure(await retainedRead(bytes(request(f.root, f.record.storageId))), "not_found");
	const host = await DurableHost.open({ ...hostOptions(f.record.storagePath, await fixtureRuntime("answer"), fixtureRegistry()), storageId: f.record.storageId });
	await host.close();
	failure(await retainedRead(bytes(request(f.root, `${f.record.storageId}:2`))), "not_found");
	const original = readFileSync(f.catalog.path(f.record.storageId), "utf8");
	for (const patch of [{ storageId }, { storagePath: join(f.root, "arbitrary.sqlite") }]) {
		writeFileSync(f.catalog.path(f.record.storageId), JSON.stringify({ ...JSON.parse(original), ...patch }));
		failure(await retainedRead(bytes(request(f.root, f.record.storageId))), "source_unreadable");
	}
});

it("reads a stopped writer with unfinished tool work and queued input without any source or claim mutation", async (t) => {
	const f = fixture(t);
	const effects = join(f.root, "effects.log");
	const child = spawn(process.execPath, [fileURLToPath(new URL("./retained-read-fixture.mts", import.meta.url)), f.record.storagePath, f.record.storageId, effects], { stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => { child.kill("SIGKILL"); });
	const events = eventLog<string>();
	let accumulated = "";
	child.stdout.on("data", (chunk) => { accumulated += chunk.toString(); events.push(accumulated); });
	child.stderr.on("data", () => {});
	await events.waitFor((values) => values.some((value) => value.includes("TOOL\n") && value.includes("QUEUED\n")), 30000);
	const exited = waitForProcessExit(child, 30000);
	child.kill("SIGKILL"); await exited;
	const before = fileState(f.root);
	const snapshot = success((await invoke(JSON.stringify(request(f.root, f.record.storageId)))).response);
	const entries = (snapshot.result as { entries: { id: string }[] }).entries;
	assert.ok(entries.length > 0);
	const history = success((await invoke(JSON.stringify(request(f.root, f.record.storageId, "inspect", { view: "history" })))).response);
	assert.match(JSON.stringify(history.result), /unfinished tool input/u);
	const exact = success((await invoke(JSON.stringify(request(f.root, f.record.storageId, "inspect", { view: "exact", entryId: Number(entries[0].id) })))).response);
	assert.ok(exact.result);
	const missing = success((await invoke(JSON.stringify(request(f.root, f.record.storageId, "inspect", { view: "result", requestId: "absent-result" })))).response);
	assert.equal((missing.result as { status: string }).status, "unavailable");
	assert.deepEqual(fileState(f.root), before);
	assert.equal(readFileSync(effects, "utf8"), "model\ntool\n");
	assert.equal(existsSync(hostPaths(f.record).claim), false);
	assert.equal(existsSync(hostPaths(f.record).socket), false);
});

it("never calls resume, submission, wait, or a model when opening retained unfinished state", async (t) => {
	const f = fixture(t);
	const host = await DurableHost.open({ ...hostOptions(f.record.storagePath, await fixtureRuntime("answer"), fixtureRegistry()), storageId: f.record.storageId, resume: false });
	await host.submit({ message: "queued without execution", requestId: "never-run" });
	await host.close();
	const before = fileState(f.root);
	const original = Harness.open;
	let forbidden = 0;
	Harness.open = async (...args) => {
		const harness = await original(...args);
		return new Proxy(harness, { get(target, key) {
			if (["resume", "submit", "waitForIdle", "waitForTask", "createConversation", "root"].includes(String(key))) return () => { forbidden++; throw new Error("Forbidden writer call"); };
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		} });
	};
	try {
		const value = success(await retainedRead(bytes(request(f.root, f.record.storageId))));
		assert.equal(value.conversationId, 1);
		assert.equal(forbidden, 0);
	} finally { Harness.open = original; }
	assert.deepEqual(fileState(f.root), before);
});

it("ignores an incompatible live advertisement while existing negotiation still refuses it", async (t) => {
	const f = fixture(t);
	const host = await DurableHost.open({ ...hostOptions(f.record.storagePath, await fixtureRuntime("answer"), fixtureRegistry()), storageId: f.record.storageId, resume: false });
	t.after(() => host.close());
	await host.submit({ message: "live retained input", requestId: "live-retained" });
	const paths = hostPaths(f.record);
	mkdirSync(dirname(paths.claim), { recursive: true });
	writeFileSync(paths.claim, JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname(), sessionId: f.record.storageId, cwd: f.record.cwd, createdAt: new Date().toISOString() }));
	const altered = { ...HOST_CONTRACT, operations: { ...HOST_CONTRACT.operations, snapshot: { ...snapshotContract, response: "snapshot/9.0.0" } } };
	const calls: string[] = [];
	const server = createTransportServer({
		serverId: paths.serverId, path: paths.socket,
		request: async (request) => {
			calls.push(request.method);
			if (request.method === "runtime-contract") return altered;
			throw new Error("Unexpected retained reader connection");
		},
	});
	await server.start();
	t.after(() => server.close());
	const client = await connectHost(hostMetadata(f.record), { retryAttempts: 0 });
	try { await assert.rejects(client.request("snapshot"), /snapshot response contract/u); }
	finally { await client.close(); }
	assert.deepEqual(calls, ["runtime-contract"]);
	const before = fileState(f.root);
	const value = success((await invoke(JSON.stringify(request(f.root, f.record.storageId)))).response);
	assert.equal(value.sessionId, f.record.storageId);
	assert.deepEqual(calls, ["runtime-contract"]);
	assert.deepEqual(fileState(f.root), before);
});

it("preserves paged snapshot communication, inherited origins, hidden exclusion, and native inspection", async (t) => {
	const f = fixture(t);
	const host = await DurableHost.open({ ...hostOptions(f.record.storagePath, await fixtureRuntime("answer"), fixtureRegistry()), storageId: f.record.storageId });
	const communication = { format: "agent.communication/1", kind: "report", sender: { identity: storageId, name: "Peer" }, body: { text: "Source body", complete: false, redacted: false }, recordedAt: 0, metadata: { sourceId: "report:source", requestId: "origin" } };
	const submitted = await host.request("submit", { requestId: "retained-communication", message: "Retained input needle", communication }) as { submissionId: number };
	await host.wait(submitted.submissionId as never);
	const other = await host.submit({ message: "other retained input", requestId: "other-retained" });
	await host.wait(other.submissionId);
	const rootPage = await host.request("snapshot", { sessionId: f.record.storageId }) as { entries: { id: string; communication: unknown; kind: string }[] };
	const linked = rootPage.entries.find((entry) => parseCommunicationView(entry.communication)?.state === "ready");
	assert.ok(linked);
	const view = parseCommunicationView(linked.communication);
	assert.ok(view && view.state === "ready");
	const fork = await host.request("fork", { requestId: "retained-fork", entryId: Number(view.recordEntryId) }) as { conversationId: number };
	await host.close();
	for (const target of [f.record.storageId, `${f.record.storageId}:${fork.conversationId}`]) {
		const page = success(await retainedRead(bytes(request(f.root, target, "snapshot", { before: Number(rootPage.entries.at(-1)?.id) + 1, limit: 100 }))));
		const result = page.result as typeof rootPage & { coverage: { hiddenExcluded: number } };
		assert.deepEqual(result.entries.find((entry) => entry.id === linked.id)?.communication, linked.communication);
		assert.equal(result.entries.some((entry) => entry.kind === "agent.communication"), false);
		assert.equal(page.conversationId, target === f.record.storageId ? 1 : fork.conversationId);
		const history = success(await retainedRead(bytes(request(f.root, target, "inspect", { view: "history" }))));
		assert.match(JSON.stringify(history.result), /Retained input needle/u);
		const search = success(await retainedRead(bytes(request(f.root, target, "inspect", { view: "search", query: "needle" }))));
		assert.match(JSON.stringify(search.result), /needle/u);
	}
	const result = success(await retainedRead(bytes(request(f.root, f.record.storageId, "inspect", { view: "result", requestId: "retained-communication", submissionId: submitted.submissionId }))));
	assert.equal((result.result as { submissionId: number }).submissionId, submitted.submissionId);
	failure(await retainedRead(bytes(request(f.root, f.record.storageId, "inspect", { view: "result", requestId: "retained-communication", submissionId: other.submissionId }))), "invalid_request");
	failure(await retainedRead(bytes(request(f.root, `${f.record.storageId}:${fork.conversationId}`, "inspect", { view: "result", submissionId: submitted.submissionId }))), "invalid_request");
	failure(await retainedRead(bytes(request(f.root, f.record.storageId, "inspect", { view: "history", cursor: { after: "bad" } }))), "invalid_request");
	failure(await retainedRead(bytes(request(f.root, f.record.storageId, "inspect", { view: "search", query: "needle", cursor: { cursor: { after: 1, order: "bad" } } }))), "invalid_request");
	const observation = await DurableObservation.open({ backupFrom: f.record.storagePath, storageId: f.record.storageId, registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
	try { assert.deepEqual(await observation.request("snapshot", { sessionId: f.record.storageId }), rootPage); }
	finally { await observation.close(); }
});

it("publishes collaboration contracts only through the explicit selector without changing default bytes", async () => {
	const original = { version: RETAINED_READ_VERSION, upstream: HOST_CONTRACT.upstream, operations: { snapshot: snapshotContract, inspect: inspectContract } };
	const found = await invoke("", ["--contract"]);
	assert.equal(found.stdout, `${JSON.stringify(original)}\n`);
	const expected = { version: RETAINED_READ_VERSION, upstream: HOST_CONTRACT.upstream, operations: threadContracts };
	assert.deepEqual(retainedReadDescriptor("collaboration"), expected);
	const selected = await invoke("", ["--contract", "collaboration"]);
	assert.equal(selected.exitCode, 0); assert.equal(selected.stdout, `${JSON.stringify(expected)}\n`);
	failure((await invoke("", ["--contract", "collaboration", "extra"])).response, "invalid_request");
	failure((await invoke("", ["--contract", "unknown"])).response, "invalid_request");
});

it("rejects unscoped collaboration targets and closed-parameter violations before retained I/O", async () => {
	let reads = 0;
	const hooks = { readCatalog: () => { reads++; throw new Error("Must not read"); } };
	const base = threadRequest();
	const cases = [
		{ ...base, sessionId: `${storageId}:2` }, { ...base, sessionId: `${storageId}:1` }, { ...base, sessionId: `${storageId}\n` },
		...[{ threadId }, { action: "list" }, { sessionId: storageId }, { before: 1 }, { query: "" }, { query: "  " }, { query: "q".repeat(257) }, { query: [] },
			{ cursor: 0 }, { cursor: "00" }, { cursor: "-1" }, { cursor: "1e2" }, { cursor: "9007199254740992" }, { cursor: "0".repeat(17) },
			{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { limit: "1" }].map((params) => threadRequest(base.store, storageId, "collaboration-list", params)),
		...[{}, { threadId: "invalid" }, { threadId: foreignThreadId }, { threadId, query: "needle" }, { threadId, cursor: "0" },
			{ threadId, before: 0 }, { threadId, before: 1.5 }, { threadId, before: "2" }, { threadId, before: Number.MAX_SAFE_INTEGER + 1 },
			{ threadId, limit: 21 }, { threadId, action: "read" }].map((params) => threadRequest(base.store, storageId, "collaboration-read", params)),
	];
	for (const value of cases) failure(await retainedRead(bytes(value), undefined, hooks), "invalid_request");
	assert.equal(reads, 0);
});

it("requires exact existing collaboration operation identities without adding a Durable discriminator", async () => {
	let reads = 0;
	const hooks = { readCatalog: () => { reads++; throw new Error("Must not read"); } };
	for (const method of ["collaboration-list", "collaboration-read"] as const) {
		const base = threadRequest(undefined, undefined, method, method === "collaboration-read" ? { threadId } : {});
		for (const expected of [{ ...base.expected, request: "wrong/1.0.0" }, { ...base.expected, response: "wrong/1.0.0" }, { ...base.expected, durable: "1.3.0" }])
			failure(await retainedRead(bytes({ ...base, expected }), undefined, hooks), "incompatible");
		failure(await retainedRead(bytes({ ...base, expected: { ...base.expected, extra: true } }), undefined, hooks), "invalid_request");
	}
	assert.equal(reads, 0);
});

it("maps only source-owned collaboration errors and closes every opened observation", async () => {
	let closed = 0;
	for (const code of ["invalid_request", "not_found", "source_unreadable"] as const) {
		const hooks = { readCatalog: () => ({ storagePath: "/synthetic/private" }), open: async () => ({
			conversation: async () => { throw new Error("Thread reads are not conversation reads"); },
			request: async () => { throw new CollaborationReadError(code, "Private source details"); }, close: async () => { closed++; },
		}) };
		const response = await retainedRead(bytes(threadRequest(undefined, undefined, "collaboration-read", { threadId })), undefined, hooks);
		failure(response, code); assert.doesNotMatch(JSON.stringify(response), /Private source details/u);
		if (!response.ok && code === "not_found") assert.equal(response.error.message, "The retained thread does not exist.");
	}
	assert.equal(closed, 3);
	const hooks = { readCatalog: () => ({ storagePath: "/synthetic/private" }), open: async () => ({
		conversation: async () => undefined, request: async () => { throw new Error("Thread not found but this error has no source type"); }, close: async () => { closed++; },
	}) };
	failure(await retainedRead(bytes(threadRequest()), undefined, hooks), "internal"); assert.equal(closed, 4);
});

it("refuses collaboration results whose identities disagree with the selected storage or thread", async () => {
	const cases: [ThreadMethod, Record<string, unknown>, unknown][] = [
		["collaboration-list", {}, { items: [{ id: foreignThreadId }] }], ["collaboration-list", {}, { items: null }],
		["collaboration-read", { threadId }, { thread: { id: foreignThreadId } }],
		["collaboration-read", { threadId }, { thread: { id: `${storageId}/${"c".repeat(32)}` } }], ["collaboration-read", { threadId }, null],
	];
	for (const [method, params, result] of cases) {
		let closed = false;
		const hooks = { readCatalog: () => ({ storagePath: "/synthetic/private" }), open: async () => ({
			conversation: async () => undefined, request: async () => result, close: async () => { closed = true; },
		}) };
		failure(await retainedRead(bytes(threadRequest(undefined, undefined, method, params)), undefined, hooks), "source_unreadable");
		assert.equal(closed, true);
	}
});

it("lists and reads stopped collaboration storage without a root conversation or writer calls", async (t) => {
	const f = await threadFixture(t, 12);
	assert.equal(await f.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT), undefined);
	await f.harness.close(BACKGROUND_CONTEXT);
	const before = fileState(f.root);
	const original = Harness.open;
	let forbidden = 0;
	Harness.open = async (...args) => {
		const harness = await original(...args);
		return new Proxy(harness, { get(target, key) {
			if (["resume", "submit", "waitForIdle", "waitForTask", "createConversation", "root", "conversation", "commit"].includes(String(key))) return () => { forbidden++; throw new Error("Forbidden writer or conversation call"); };
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		} });
	};
	try {
		const first = success(await retainedRead(bytes(threadRequest(f.root, f.record.storageId))));
		const page = first.result as CollaborationList;
		assert.equal(first.conversationId, 1); assert.equal(page.items.length, 10); assert.equal(page.nextCursor, "10");
		assert.deepEqual(page.coverage, { complete: false, visited: 10, omitted: 0 });
		const last = success(await retainedRead(bytes(threadRequest(f.root, f.record.storageId, "collaboration-list", { cursor: page.nextCursor, limit: 20 })))).result as CollaborationList;
		assert.deepEqual([...page.items, ...last.items].map((row) => row.id), f.ids); assert.equal(last.nextCursor, null); assert.equal(last.coverage.complete, true);
		const found = success(await retainedRead(bytes(threadRequest(f.root, f.record.storageId, "collaboration-list", { query: "NEEDLE" })))).result as CollaborationList;
		assert.deepEqual(found.items.map((row) => row.id), [f.ids.at(-1)]); assert.equal(found.items[0].purpose.includes("needle"), false);
		const read = success(await retainedRead(bytes(threadRequest(f.root, f.record.storageId, "collaboration-read", { threadId: f.ids[0] })))).result as CollaborationPage;
		assert.equal(read.thread.id, f.ids[0]); assert.equal(read.events.length, 1); assert.equal(read.coverage.complete, true);
		assert.equal(forbidden, 0);
	} finally { Harness.open = original; }
	const cliRead = await invoke(JSON.stringify(threadRequest(f.root, f.record.storageId, "collaboration-read", { threadId: f.ids[0] })));
	assert.equal(cliRead.exitCode, 0); assert.equal(success(cliRead.response).storageId, f.record.storageId);
	assert.deepEqual(fileState(f.root), before);
	assert.equal(existsSync(hostPaths(f.record).claim), false); assert.equal(existsSync(hostPaths(f.record).socket), false);
});

it("keeps absent indices empty and reports missing requested threads without source mutation", async (t) => {
	const f = await threadFixture(t, 0); await f.harness.close(BACKGROUND_CONTEXT);
	const before = fileState(f.root);
	const result = success(await retainedRead(bytes(threadRequest(f.root, f.record.storageId)))).result as CollaborationList;
	assert.deepEqual(result, { items: [], nextCursor: null, coverage: { complete: true, visited: 0, omitted: 0 } });
	failure(await retainedRead(bytes(threadRequest(f.root, f.record.storageId, "collaboration-read", { threadId: `${f.record.storageId}/${"a".repeat(32)}` }))), "not_found");
	failure(await retainedRead(bytes(threadRequest(f.root, f.record.storageId, "collaboration-list", { cursor: "1" }))), "invalid_request");
	assert.deepEqual(fileState(f.root), before);
});

it("preserves closed frames and exact older-event boundaries within the retained page bound", async (t) => {
	const f = await threadFixture(t);
	for (let index = 0; index < 7; index++) await mutateCollaboration(f.harness, f.record.storageId, {
		action: "post", threadId: f.ids[0], senderIdentity: f.record.storageId, origin: "model", requestId: `event-${index}`, message: "x".repeat(8000),
	}, BACKGROUND_CONTEXT);
	await mutateCollaboration(f.harness, f.record.storageId, { action: "close", threadId: f.ids[0], senderIdentity: f.record.storageId, origin: "model", requestId: "close", message: "Done" }, BACKGROUND_CONTEXT);
	await f.harness.close(BACKGROUND_CONTEXT);
	const before = fileState(f.root);
	const read = (params: Record<string, unknown> = {}) => retainedRead(bytes(threadRequest(f.root, f.record.storageId, "collaboration-read", { threadId: f.ids[0], ...params })));
	const page = success(await read({ limit: 20 })).result as CollaborationPage;
	assert.equal(page.thread.closed, true); assert.ok(page.events.length < 9); assert.equal(page.coverage.complete, false);
	assert.ok(page.coverage.bytes <= 48 * 1024); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 48 * 1024);
	assert.equal(page.nextBefore, page.events[0].sequence);
	const older = success(await read({ before: page.nextBefore, limit: 20 })).result as CollaborationPage;
	assert.equal(older.events.at(-1)?.sequence, page.events[0].sequence - 1);
	assert.equal(older.coverage.complete, true); assert.equal(older.nextBefore, null); assert.equal(older.events[0].sequence, 1);
	failure(await read({ before: page.thread.sequence + 2 }), "invalid_request");
	assert.deepEqual(fileState(f.root), before);
});

it("reports corrupt present indices, frames, and events instead of successful empty retained data", async (t) => {
	const cases: { name: string; method: ThreadMethod; mutate: (tx: Tx, id: string) => Promise<void> }[] = [
		{ name: "null index", method: "collaboration-list", mutate: async (tx) => { Object.assign(await tx.doc(CollaborationIndex), { keys: null }); } },
		{ name: "missing keys", method: "collaboration-list", mutate: async (tx) => { Reflect.deleteProperty(await tx.doc(CollaborationIndex), "keys"); } },
		{ name: "non-array keys", method: "collaboration-list", mutate: async (tx) => { Object.assign(await tx.doc(CollaborationIndex), { keys: {} }); } },
		{ name: "missing indexed frame", method: "collaboration-list", mutate: async (tx, id) => { (await tx.doc(CollaborationThreads, id, null)).thread = null; } },
		{ name: "malformed frame", method: "collaboration-read", mutate: async (tx, id) => { const thread = (await tx.doc(CollaborationThreads, id, null)).thread; assert.ok(thread); Object.assign(thread, { members: null }); } },
		{ name: "missing event", method: "collaboration-read", mutate: async (tx, id) => { (await tx.doc(CollaborationEvents, `${id}:1`, null)).event = null; } },
		{ name: "malformed event", method: "collaboration-read", mutate: async (tx, id) => { const event = (await tx.doc(CollaborationEvents, `${id}:1`, null)).event; assert.ok(event); Object.assign(event, { threadId: foreignThreadId }); } },
	];
	for (const item of cases) await t.test(item.name, async (subtest) => {
		const f = await threadFixture(subtest); await f.harness.commit((tx) => item.mutate(tx, f.ids[0]), BACKGROUND_CONTEXT); await f.harness.close(BACKGROUND_CONTEXT);
		const before = fileState(f.root);
		const params = item.method === "collaboration-read" ? { threadId: f.ids[0] } : {};
		failure(await retainedRead(bytes(threadRequest(f.root, f.record.storageId, item.method, params))), "source_unreadable");
		assert.deepEqual(fileState(f.root), before);
	});
});

it("does not expose a foreign-storage frame retained under a selected store's canonical index key", async (t) => {
	const f = await threadFixture(t);
	await f.harness.commit(async (tx) => {
		const stored = await tx.doc(CollaborationThreads, f.ids[0], null); assert.ok(stored.thread);
		(await tx.doc(CollaborationThreads, foreignThreadId, null)).thread = { ...stored.thread, id: foreignThreadId };
		(await tx.doc(CollaborationIndex)).keys = [foreignThreadId];
	}, BACKGROUND_CONTEXT);
	await f.harness.close(BACKGROUND_CONTEXT);
	const before = fileState(f.root);
	failure(await retainedRead(bytes(threadRequest(f.root, f.record.storageId))), "source_unreadable");
	failure(await retainedRead(bytes(threadRequest(f.root, f.record.storageId, "collaboration-list", { query: "unmatched title" }))), "source_unreadable");
	assert.deepEqual(fileState(f.root), before);
});

it("keeps collaboration response bounds, cancellation, and source-change failures on the existing envelope", async () => {
	let closed = 0;
	const result = { items: [], padding: "x".repeat(1000) };
	const hooks = { readCatalog: () => ({ storagePath: "/synthetic/private" }), open: async () => ({
		conversation: async () => undefined, request: async () => result, close: async () => { closed++; },
	}), responseBytes: 100 };
	failure(await retainedRead(bytes(threadRequest()), undefined, hooks), "limit_exceeded"); assert.equal(closed, 1);
	const controller = new AbortController();
	const cancelled = { ...hooks, responseBytes: 10000, open: async () => ({ conversation: async () => undefined,
		request: async () => { controller.abort(); return result; }, close: async () => { closed++; },
	}) };
	failure(await retainedRead(bytes(threadRequest()), controller.signal, cancelled), "cancelled"); assert.equal(closed, 2);
	failure(await retainedRead(bytes(threadRequest()), undefined, { ...hooks, open: async () => { throw new RetainedReadError("source_changed"); } }), "source_changed", true);
});

it("uses one cooperative deadline through a collaboration read and closes its observation", async (t) => {
	let now = Date.now(); const deadline = now + 1000; let closed = false;
	t.mock.method(Date, "now", () => now);
	const hooks = { readCatalog: () => ({ storagePath: "/synthetic/private" }), open: async () => ({
		conversation: async () => undefined, request: async () => { now = deadline; return { items: [] }; }, close: async () => { closed = true; },
	}) };
	failure(await retainedRead(bytes(threadRequest()), undefined, hooks, deadline), "timeout", true);
	assert.equal(closed, true);
});
