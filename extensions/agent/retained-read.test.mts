import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue, ServiceCall } from "@earendil-works/chord";
import { ServerError, type ServerHost } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { connectHost } from "./host-client.ts";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
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
const snapshotContract = { request: "snapshot/1.0.0", response: "snapshot/2.0.0", durable: "1.1.0" };
const inspectContract = { request: "inspect/1.1.0", response: "9619e4000b74259b8b63a83bd1e009003d01682365adfbed3147eb650f304a8a", durable: "1.1.0" };
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
	return { response: JSON.parse(stdout), exitCode: child.exitCode, stderr: Buffer.concat(diagnostics).toString("utf8") };
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
	for (const value of [{ ...base, version: "retained-read/2.0.0" }, ...["request", "response", "durable"].map((key) => ({ ...base, expected: { ...snapshotContract, [key]: key === "durable" ? "1.0.0" : "wrong/1.0.0" } })), { ...base, expected: { request: snapshotContract.request, response: snapshotContract.response } }]) failure(await retainedRead(bytes(value), undefined, hooks), "incompatible");
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
	const endpoint: ServerHost = {
		serverServices: { attachClient: () => ({ invokeService: async (call: ServiceCall) => {
			calls.push(call.member);
			if (call.member === "runtime-contract") return altered as unknown as JsonValue;
			throw new ServerError("service_invalid_value", "Unexpected retained reader connection");
		}, release: () => {} }) },
		resolveSession: async () => { throw new ServerError("session_not_found", "No routed session"); },
		openSession: async () => { throw new ServerError("session_not_found", "No routed session"); },
	};
	const server = createUnixServer(endpoint, { serverId: paths.serverId, path: paths.socket, mode: 0o600 });
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
