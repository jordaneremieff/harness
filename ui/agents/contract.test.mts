import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import {
	assertOperation, ContractError, decodeDescriptor, decodeFrame, decodeInput, decodeOperatorInput,
	decodePublication, decodeResponse, type JsonObject, type OperationName, supportedOperations,
} from "./contract.mts";

const docs = readFileSync(new URL("../../docs/agent-host-contract.md", import.meta.url), "utf8");
function fixture(name: string): JsonObject {
	const heading = `### Fixture: ${name}\n`;
	const section = docs.slice(docs.indexOf(heading) + heading.length);
	assert.ok(docs.includes(heading), `Missing documented fixture: ${name}`);
	const match = /^\s*```json\n(.*?)\n```/s.exec(section);
	assert.ok(match, `Missing JSON fixture: ${name}`);
	return JSON.parse(match[1]) as JsonObject;
}
const storageId = "00000000-0000-4000-8000-000000000001";
const requestId = "input-example";
const nativeMetadata = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("@earendil-works/pi-durable/package.json"), "utf8"));
const D = nativeMetadata.version as string;
function descriptor(): JsonObject {
	return {
		format: "pi.agent.contract/1", release: "1.0.0", upstream: { codingAgent: "1.0.3", durable: D },
		requires: { codingAgent: "1.0.0", durable: "1.0.0" }, operations: {
			dashboard: { request: "dashboard/1.0.0", response: "46dd1bdd919bd3093ad6a3c0a316b35fa05d491490a37c9879ef9a9cffc4f241" },
			snapshot: { request: "snapshot/1.0.0", response: "snapshot/1.0.0", durable: D },
			inspect: { request: "inspect/1.0.0", response: "98cbec841b6626155420cf582d77e318ea0c8e7607f113dffe04d94bf1b99736", durable: D },
			"observe-open": { request: "observe-open/1.0.0", response: "observe-open/1.0.0", durable: D },
			"observe-frame": { request: "observe-frame/1.0.0", response: "observe-frame/1.0.0", durable: D },
			"observe-close": { request: "observe-close/1.0.0", response: "observe-close/1.0.0" },
			changes: { request: "changes/1.0.0", response: "changes/1.0.0" },
			"task-submit": { request: "task-submit/1.0.0", response: "task-submit/1.1.0" },
			abort: { request: "abort/1.0.0", response: "abort/1.0.0" },
			configure: { request: "configure/1.2.0", response: "configure/1.2.0" },
		},
	};
}
function refusal(fn: () => unknown, code = "malformed"): void {
	assert.throws(fn, (error: unknown) => error instanceof ContractError && error.code === code);
}
const coverage = { complete: true, entries: 0, bytes: 0, hiddenExcluded: 0, entryLimitReached: false, byteLimitReached: false };
function frame(): JsonObject {
	return {
		scope: "conversation", storageId, conversationId: 1, revision: 0, observedAt: "2026-01-01T00:00:00.000Z",
		entries: [], live: [], nextBefore: null, coverage: { ...coverage },
		status: { conversationId: 1, identity: storageId, busy: false, lastText: null, live: null, inbox: [],
			agent: { thinkingLevel: "off", extensions: [], tools: [] }, tasks: [], submissions: [] },
	};
}
function row(): JsonObject {
	return { id: storageId, storageId, cwd: "/project", modifiedAt: 1, owner: "here", state: "idle", cost: 0, partial: false };
}
function inspectBase(view: string): JsonObject { return { view, sessionId: storageId, conversationId: 1 }; }

for (const member of Object.keys(supportedOperations) as OperationName[]) {
	test(`local contract identity: ${member}`, () => {
		const remote = decodeDescriptor(descriptor());
		if (member === "configure") refusal(() => assertOperation(remote, member), "unavailable");
		else assert.equal(assertOperation(remote, member), supportedOperations[member]);
	});
}

test("supported native identity comes from declared public metadata", () => {
	const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	assert.ok(pkg.dependencies["@earendil-works/pi-durable"]);
	assert.equal(supportedOperations.snapshot.durable, D);
	assert.ok(Object.isFrozen(supportedOperations)); assert.ok(Object.isFrozen(supportedOperations.snapshot));
});

test("operation mutations refuse only the affected operation", () => {
	for (const member of ["snapshot", "task-submit", "abort", "dashboard"] as OperationName[]) {
		for (const key of ["request", "response", "durable"]) {
			const value = descriptor(); const operations = value.operations as JsonObject;
			(operations[member] as JsonObject)[key] = key === "durable" ? "9.0.0" : "different/1.0.0";
			const remote = decodeDescriptor(value);
			refusal(() => assertOperation(remote, member), "incompatible");
			assertOperation(remote, member === "abort" ? "task-submit" : "abort");
		}
	}
	const missing = descriptor(); delete (missing.operations as JsonObject).snapshot;
	refusal(() => assertOperation(decodeDescriptor(missing), "snapshot"), "incompatible");
});

test("diagnostic release changes do not change operation compatibility", () => {
	const value = descriptor(); value.release = "99.2.1";
	(value.upstream as JsonObject).codingAgent = "99.0.0";
	assertOperation(decodeDescriptor(value), "task-submit");
});

test("malformed descriptors and unmet floors refuse", () => {
	for (const mutate of [
		(o: JsonObject) => { o.format = "pi.agent.contract/2"; },
		(o: JsonObject) => { o.release = "latest"; },
		(o: JsonObject) => { (o.requires as JsonObject).durable = "1.0.0-beta"; },
		(o: JsonObject) => { (o.requires as JsonObject).codingAgent = "99.0.0"; },
		(o: JsonObject) => { (o.operations as JsonObject)["BAD MEMBER"] = { request: "a", response: "b" }; },
		(o: JsonObject) => { (o.operations as JsonObject).abort = { request: "abort/1.0.0" }; },
		(o: JsonObject) => { (o.operations as JsonObject).abort = { request: "a", response: "b", extra: true }; },
		(o: JsonObject) => { o.operations = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`op-${i}`, { request: "a", response: "b" }])); },
	]) { const value = descriptor(); mutate(value); refusal(() => decodeDescriptor(value)); }
});

test("invalid version syntax and operation identities refuse descriptors", () => {
	for (const version of ["1.0.0-beta..1", "1.0.0-01", "1.0.0+bad..build", "01.0.0", "1.0.0-"]) {
		const value = descriptor(); value.release = version; refusal(() => decodeDescriptor(value));
	}
	const value = descriptor(); (value.operations as JsonObject).abort = { request: "abort /1.0.0", response: "abort/1.0.0" };
	refusal(() => decodeDescriptor(value));
});

test("unknown members never inherit an operation from object prototypes", () => {
	for (const name of ["constructor", "toString", "__proto__"]) {
		const member = name as unknown as OperationName;
		refusal(() => assertOperation(decodeDescriptor(descriptor()), member), "incompatible");
		refusal(() => decodeResponse(member, {}));
	}
});

test("operator-input documentation fixture validates as a text request", () => {
	const envelope = fixture("operator-input"); const args = envelope.args as JsonObject[];
	assert.equal(envelope.member, "task-submit"); assert.equal(envelope.serviceId, "pi.agent.host");
	assert.deepEqual(decodeOperatorInput(args[0]), args[0]);
	assert.deepEqual(decodeInput("task-submit", args[0], { identity: storageId, requestId }), args[0]);
	assert.deepEqual(supportedOperations["task-submit"], args[2]);
});

test("operator-input mutations refuse admission", () => {
	const input = (fixture("operator-input").args as JsonObject[])[0];
	for (const [key, value] of Object.entries({ origin: "model", requester: "", replyTo: "ui:foreign", message: [],
		sessionId: `${storageId}:0`, requestId: "", whenBusy: "interrupt", checkInMinutes: -1, senderIdentity: storageId })) {
		refusal(() => decodeOperatorInput({ ...input, [key]: value }));
	}
	for (const key of ["sessionId", "origin", "requester", "replyTo", "requestId", "message"]) {
		const changed = { ...input }; delete changed[key]; refusal(() => decodeOperatorInput(changed));
	}
	refusal(() => decodeInput("task-submit", input, { identity: `${storageId}:2` }));
	refusal(() => decodeInput("task-submit", input, { requestId: "changed" }));
});

test("admitted-input documentation fixture binds target and request", () => {
	const value = fixture("admitted-input");
	assert.deepEqual(decodeResponse("task-submit", value, { identity: storageId, requestId }), value);
	for (const key of ["submissionId", "conversationId", "deduped", "identity", "result"]) {
		const changed = { ...value }; delete changed[key]; refusal(() => decodeResponse("task-submit", changed));
	}
	refusal(() => decodeResponse("task-submit", value, { identity: `${storageId}:2` }));
	refusal(() => decodeResponse("task-submit", value, { requestId: "changed" }));
	refusal(() => decodeResponse("task-submit", { ...value, conversationId: 2 }));
	refusal(() => decodeResponse("task-submit", { ...value, result: { ...(value.result as JsonObject), submissionId: 8 } }));
	refusal(() => decodeResponse("task-submit", { ...value, result: { ...(value.result as JsonObject), sessionId: "foreign" } }));
});

test("empty-snapshot documentation fixture retains coverage and continuation", () => {
	const value = fixture("empty-snapshot"); assert.deepEqual(decodeResponse("snapshot", value), value);
	const partial = { ...value, nextBefore: null, partial: true, coverage: { ...coverage, complete: false, hiddenExcluded: 512 } };
	assert.deepEqual(decodeResponse("snapshot", partial), partial);
	for (const key of ["entries", "partial", "revision", "nextBefore", "coverage"]) {
		const changed = { ...value }; delete changed[key]; refusal(() => decodeResponse("snapshot", changed));
	}
});

test("oversized first selected entry remains decodable within transport bound", () => {
	const value = { ...fixture("empty-snapshot"), entries: [{ id: "1", kind: "custom", data: "x".repeat(1048577) }],
		coverage: { ...coverage, entries: 1, bytes: 1048700, byteLimitReached: true } };
	assert.equal(decodeResponse("snapshot", value).entries[0].id, "1");
	refusal(() => decodeResponse("snapshot", { ...value, entries: [{ id: "live:generation", kind: "assistant" }] }));
	refusal(() => decodeResponse("snapshot", { ...value, entries: [{ id: "1", kind: "system" }] }));
	refusal(() => decodeResponse("snapshot", { ...value, entries: [{ id: "2", kind: "custom" }, { id: "1", kind: "custom" }] }));
});

test("empty-publication fixture and native dashboard are different shapes", () => {
	const value = fixture("empty-publication"); assert.deepEqual(decodePublication(value, storageId), value);
	assert.deepEqual(decodeResponse("dashboard", [row()]), [row()]);
	refusal(() => decodeResponse("dashboard", value)); refusal(() => decodePublication(value, "other"));
	refusal(() => decodePublication({ ...value, rows: [{ ...row(), storageId: "other" }] }, storageId));
	refusal(() => decodePublication({ ...value, coverage: { complete: false, omitted: -1 } }, storageId));
	refusal(() => decodePublication({ ...value, updatedAt: "yesterday" }, storageId));
	refusal(() => decodePublication({ ...value, rows: [{ ...row(), state: "busy" }] }, storageId));
	refusal(() => decodePublication({ ...value, rows: [{ ...row(), owner: "remote" }] }, storageId));
});

test("change-state documentation fixture requires a correlated root replacement", () => {
	const value = fixture("change-state"); assert.deepEqual(decodeResponse("changes", value), value);
	for (const changed of [{ ...value, member: "frame" }, { ...value, sequence: 2 }, { ...value, ops: [["u", { revision: 1 }]] },
		{ ...value, ops: [["r", { revision: -1 }]] }, { ...value, ops: [] }]) refusal(() => decodeResponse("changes", changed));
});

test("conversation frames bind storage, conversation, token, and native status", () => {
	const value = frame(); assert.deepEqual(decodeFrame(value, { identity: storageId }), value);
	const opened = { token: "test:token", frame: value };
	assert.deepEqual(decodeResponse("observe-open", opened, { identity: storageId, token: "test:token" }), opened);
	assert.deepEqual(decodeResponse("observe-frame", value, { identity: storageId }), value);
	refusal(() => decodeResponse("observe-open", opened, { token: "other" }));
	refusal(() => decodeFrame(value, { identity: `${storageId}:2` }));
	refusal(() => decodeFrame({ ...value, conversationId: 2 }));
	refusal(() => decodeFrame({ ...value, live: [{ id: "1", kind: "assistant" }] }));
	refusal(() => decodeFrame({ ...value, revision: -1 }));
	for (const key of ["entries", "live", "status", "coverage", "nextBefore", "observedAt", "storageId"]) {
		const changed = { ...value }; delete changed[key]; refusal(() => decodeFrame(changed));
	}
	const live = { ...value, live: [{ id: "live:generation", kind: "assistant", model: [{ role: "assistant", content: [] }] }] };
	assert.deepEqual(decodeFrame(live), live);
});

test("tasks frames preserve task graph and refuse conversation replacement", () => {
	const value = { scope: "tasks", storageId, revision: 1, observedAt: "2026-01-01T00:00:00.000Z",
		tasks: [{ id: 1, kind: "run", conversationId: 1, background: false, abortRequested: false,
			status: "live", phase: "generation", waitsOn: [], conversations: [1] }],
		labels: [{ conversationId: 1, identity: storageId }], coverage: { complete: true, live: true } };
	assert.deepEqual(decodeFrame(value), value);
	refusal(() => decodeFrame(value, { identity: storageId }));
	refusal(() => decodeFrame({ ...value, labels: [{ conversationId: 1, identity: "other" }] }));
});

test("inspect supports each current view and keeps cursor kinds separate", () => {
	const compact = { id: 1, kind: "input", source: "user", text: "hello", truncated: false, format: "compact", nextOffset: null };
	const cursor = { opaque: [1, "two"] };
	const history = { ...inspectBase("history"), format: "compact", entries: [compact], nextCursor: cursor, order: "newestFirst", detail: "test" };
	const branch = { ...inspectBase("branch"), entries: [{ ...compact, format: undefined, nextOffset: 3 }], nextCursor: null, order: "newestFirst", detail: "test" };
	delete branch.entries[0].format;
	const exact = { ...inspectBase("exact"), entryId: 1, offset: 0, text: "{}", nextOffset: 2, truncated: true };
	const search = { ...inspectBase("search"), matches: [{ entryId: 1, kind: "input", source: "user", matchOffset: 0,
		excerpt: "hello", excerptText: "hello", truncated: false }], nextCursor: { cursor, skip: 1, scannedBytes: 12 },
		coverage: { scannedEntries: 1, scannedBytes: 12, complete: false }, detail: "test" };
	const result = { ...inspectBase("result"), submissionId: 7, status: "done", requestId, answer: "hello", usage: { models: {}, tools: {} } };
	const activity = { ...inspectBase("activity"), format: "compact", turns: [{ entries: [compact] }], nextCursor: cursor,
		metadata: { owner: "here", live: false, operation: null, pending: 0, runningTools: [] },
		coverage: { scannedEntries: 1, scannedBytes: 12, complete: true, entryLimitReached: false,
			scanByteLimitReached: false, byteLimitReached: false, bytes: 12, omittedEntries: 0, metadataTruncated: false }, detail: "test" };
	for (const value of [history, branch, exact, search, result, activity]) {
		assert.deepEqual(decodeResponse("inspect", value, { identity: storageId }), value);
		refusal(() => decodeResponse("inspect", value, { identity: "other" }));
	}
	refusal(() => decodeResponse("inspect", { ...exact, nextOffset: 0 }));
	refusal(() => decodeResponse("inspect", { ...history, nextCursor: 3 }));
	refusal(() => decodeResponse("inspect", result, { requestId: "wrong" }));
	refusal(() => decodeResponse("inspect", { ...inspectBase("unknown") }));
});

test("abort correlates target and validates native receipt", () => {
	const value = { conversationId: 1, identity: storageId, background: false };
	assert.deepEqual(decodeResponse("abort", value, { identity: storageId }), value);
	refusal(() => decodeResponse("abort", value, { identity: "other" }));
	refusal(() => decodeResponse("abort", { ...value, background: "false" }));
	refusal(() => decodeResponse("abort", { ...value, conversationId: 0 }));
});

test("configure is explicitly unavailable for descriptor, request, and response", () => {
	refusal(() => assertOperation(decodeDescriptor(descriptor()), "configure"), "unavailable");
	refusal(() => decodeInput("configure", { sessionId: storageId, requestId, name: "example" }), "unavailable");
	refusal(() => decodeResponse("configure", { sessionId: storageId, outcome: "applied" }), "unavailable");
});

test("request subsets reject unsupported targeting and fields", () => {
	assert.deepEqual(decodeInput("snapshot", { sessionId: storageId, limit: 200, maxBytes: 1048576 }), { sessionId: storageId, limit: 200, maxBytes: 1048576 });
	assert.deepEqual(decodeInput("dashboard", { conversationId: 1 }), { conversationId: 1 });
	assert.deepEqual(decodeInput("abort", { sessionId: storageId }), { sessionId: storageId });
	assert.deepEqual(decodeInput("inspect", { sessionId: storageId, cursor: { opaque: true } }), { sessionId: storageId, cursor: { opaque: true } });
	assert.deepEqual(decodeInput("observe-open", { token: "test", scope: "tasks" }), { token: "test", scope: "tasks" });
	assert.deepEqual(decodeInput("observe-close", { token: "test" }), { token: "test" });
	assert.deepEqual(decodeResponse("observe-close", { closed: true }), { closed: true });
	refusal(() => decodeInput("snapshot", { sessionId: storageId, limit: 201 }));
	refusal(() => decodeInput("dashboard", { sessionId: storageId }));
	refusal(() => decodeInput("abort", { sessionId: storageId, conversationId: 1 }));
	refusal(() => decodeInput("observe-open", { token: "bad token", scope: "conversation", sessionId: storageId }));
	refusal(() => decodeInput("observe-frame", { token: "test", sessionId: storageId }));
	refusal(() => decodeInput("observe-frame", { token: "test" }, { token: "wrong" }));
	refusal(() => decodeInput("changes", {}), "unavailable");
});

test("decoders copy JSON without trusting getters, native objects, or overlarge payloads", () => {
	const value = frame(); const decoded = decodeFrame(value);
	assert.notEqual(decoded, value); assert.notEqual(decoded.coverage, value.coverage);
	(value.coverage as JsonObject).complete = false; assert.equal((decoded.coverage as JsonObject).complete, true);
	refusal(() => decodeResponse("snapshot", { ...fixture("empty-snapshot"), entries: [{ id: "1", kind: "custom", data: Number.NaN }] }));
	refusal(() => decodePublication({ ...fixture("empty-publication"), updatedAt: new Date() }, storageId));
	refusal(() => decodeDescriptor(Object.defineProperty({}, "format", { get() { throw new Error("Getter must not run"); }, enumerable: true })));
	refusal(() => decodeResponse("snapshot", { ...fixture("empty-snapshot"), entries: [{ id: "1", kind: "custom", data: "x".repeat(16 * 1024 * 1024) }] }));
	let nested: JsonObject = {}; for (let i = 0; i < 65; i++) nested = { nested };
	refusal(() => decodePublication({ ...fixture("empty-publication"), profiles: nested }, storageId));
	refusal(() => decodePublication({ ...fixture("empty-publication"), profiles: new Array(250001) }, storageId));
	refusal(() => decodePublication({ ...fixture("empty-publication"), [Symbol("hidden")]: true }, storageId));
});

test("native dashboard text bounds differ from bounded publication text", () => {
	const value = { ...row(), firstMessage: "x".repeat(2001) };
	assert.deepEqual(decodeResponse("dashboard", [value]), [value]);
	refusal(() => decodePublication({ ...fixture("empty-publication"), rows: [value] }, storageId));
	refusal(() => decodePublication({ ...fixture("empty-publication"), profiles: "x".repeat(24 * 1024) }, storageId));
});
