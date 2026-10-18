import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { blockedResult, descriptor as fakeDescriptor } from "./fake-host.mts";
import {
	assertOperation, ContractError, decodeDescriptor, decodeFrame, decodeInput, decodeOperatorInput,
	decodePublication, decodeResponse, type JsonObject, type OperationName, supportedOperations,
} from "./contract.mts";

const docs = readFileSync(new URL("../../docs/agent-host-contract.md", import.meta.url), "utf8");
assert.ok(Buffer.byteLength(docs) <= 512 * 1024, "Documented contract byte bound");
function documentedOperation(member: string): { request: string; response: string; durable?: string } {
	const row = docs.split("\n").find(line => line.startsWith(`| ${member} |`));
	if (row === undefined) {
		const section = docs.slice(docs.indexOf("For every member in the following set"), docs.indexOf("Overrides and remaining members:"));
		const defaults = /```text\n([\s\S]*?)\n```/.exec(section);
		assert.ok(defaults?.[1].trim().split(/\s+/u).includes(member), `Missing documented operation: ${member}`);
		return { request: `${member}/1.0.0`, response: `${member}/1.0.0` };
	}
	const cells = row.split("|").map(cell => cell.trim());
	const response = cells[3];
	const hash = response.startsWith("H-") ? docs.split("\n").find(line => line.startsWith(`${response} `))?.trim().split(/\s+/u)[1] : response;
	assert.ok(hash, `Missing documented response: ${response}`);
	if (response.startsWith("H-")) assert.match(hash, /^[a-f0-9]{64}$/u);
	assert.ok(cells[4] === "D" || cells[4] === "absent");
	return { request: cells[2], response: hash, ...(cells[4] === "D" ? { durable: D } : {}) };
}
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
		format: "pi.agent.contract/1", release: "1.0.0", upstream: { codingAgent: "1.2.0", durable: D },
		requires: { codingAgent: "1.2.0", durable: "1.2.0" }, operations: {
			dashboard: { request: "dashboard/1.0.0", response: "a89f98f3eb28c78f115c0010581107073600bfb9ec44934ad622aeb5d1cffcd7" },
			snapshot: { request: "snapshot/1.0.0", response: "snapshot/2.0.0", durable: D },
			inspect: { request: "inspect/1.1.0", response: "d38d5e5a297d6b3738547ab0154cd494602f01c4a898423a076d2d946e430a6b", durable: D },
			"observe-open": { request: "observe-open/1.0.0", response: "observe-open/2.0.0", durable: D },
			"observe-frame": { request: "observe-frame/1.0.0", response: "observe-frame/2.0.0", durable: D },
			"observe-close": { request: "observe-close/1.0.0", response: "observe-close/1.0.0" },
			changes: { request: "changes/1.0.0", response: "changes/1.0.0" },
			"task-submit": { request: "task-submit/1.0.0", response: "task-submit/1.2.0" },
			abort: { request: "abort/1.0.0", response: "abort/1.0.0" },
			configure: { request: "configure/1.3.0", response: "configure/1.3.0" },
			"collaboration-list": { request: "collaboration-list/1.0.0", response: "collaboration-list/1.0.0" },
			"collaboration-read": { request: "collaboration-read/1.0.0", response: "collaboration-read/1.0.0" },
			status: { request: "status/1.0.0", response: "294bb95f3d60b9c9ae2976f291e4f8d41c11d00ec517c1aebcfd9c7af40a3087", durable: D },
			command: { request: "command/1.1.0", response: "command/1.0.0", durable: D },
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

test("literal consumer identities match the documented contract and reject superseded contracts", () => {
	for (const member of Object.keys(supportedOperations) as OperationName[]) {
		assert.deepEqual(supportedOperations[member], documentedOperation(member));
	}
	for (const member of ["snapshot", "observe-open", "observe-frame", "inspect"] as OperationName[]) {
		const value = descriptor(); const operation = (value.operations as JsonObject)[member] as JsonObject;
		operation.response = member === "inspect"
			? "d5921b17798451b298b92896cb9995c32df9402f2f4ddca7acc377639797a51f" : `${member}/1.0.0`;
		refusal(() => assertOperation(decodeDescriptor(value), member), "incompatible");
		assertOperation(decodeDescriptor(value), "task-submit");
	}
});

test("supported native identity comes from declared public metadata", () => {
	const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	assert.ok(pkg.dependencies["@earendil-works/pi-durable"]);
	for (const member of ["snapshot", "inspect", "observe-open", "observe-frame"] as const) {
		assert.equal(supportedOperations[member].durable, D);
		assert.ok(Object.isFrozen(supportedOperations[member]));
		const value = descriptor();
		((value.operations as JsonObject)[member] as JsonObject).durable = D === "1.0.3" ? "1.1.0" : "1.0.3";
		const remote = decodeDescriptor(value);
		refusal(() => assertOperation(remote, member), "incompatible");
		assertOperation(remote, "task-submit");
	}
	assert.ok(Object.isFrozen(supportedOperations));
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

test("inspect requires the supplied schema identity and current fake host operations", async () => {
	const remote = decodeDescriptor(await fakeDescriptor());
	for (const member of ["snapshot", "observe-open", "observe-frame", "inspect"] as const) assertOperation(remote, member);
	assert.equal(assertOperation(remote, "inspect").response, "d38d5e5a297d6b3738547ab0154cd494602f01c4a898423a076d2d946e430a6b");
	for (const response of ["3df10ec4515f4d6f8db33d0f63666d8ca68f5458143e69d088a80534483bb863", "inspect/2.0.0"]) {
		const changed = descriptor(); ((changed.operations as JsonObject).inspect as JsonObject).response = response;
		refusal(() => assertOperation(decodeDescriptor(changed), "inspect"), "incompatible");
		assertOperation(decodeDescriptor(changed), "snapshot");
	}
});

test("native request result selectors retain conversation scope and unavailable results", () => {
	const identity = `${storageId}:7`;
	const input = {sessionId: identity, view: "result", requestId: "native-request", operationId: "separate-operation", submissionId: 12, entryId: 30};
	assert.deepEqual(decodeInput("inspect", input, {identity}), input);
	for (const view of ["history", "activity", "exact"]) refusal(() => decodeInput("inspect", {...input, view}));
	for (const requestId of ["", "x".repeat(1025), 3]) refusal(() => decodeInput("inspect", {...input, requestId}));
	refusal(() => decodeInput("inspect", {sessionId: identity, view: "result", entryId: 30}));
	const unavailable = {view: "result", sessionId: identity, conversationId: 7, requestId: "native-request", status: "unavailable", reason: "Not retained", usage: {models: {}, tools: {}}};
	assert.deepEqual(decodeResponse("inspect", unavailable, {identity, requestId: "native-request"}), unavailable);
	assert.equal(Object.hasOwn(unavailable, "submissionId"), false);
	refusal(() => decodeResponse("inspect", {...unavailable, requestId: "another-request"}, {identity, requestId: "native-request"}));
	refusal(() => decodeResponse("inspect", {...unavailable, status: "done"}, {identity}));
	const old = descriptor(); ((old.operations as JsonObject).inspect as JsonObject).request = "inspect/1.0.0";
	refusal(() => assertOperation(decodeDescriptor(old), "inspect"), "incompatible");
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

test("current operator-input fixture validates as a text request", () => {
	const envelope = fixture("operator-input"); const input = envelope.params as JsonObject;
	assert.equal(envelope.method, "task-submit"); assert.equal(envelope.requestId, requestId);
	assert.deepEqual(decodeOperatorInput(input), input);
	assert.deepEqual(decodeInput("task-submit", input, { identity: storageId, requestId: envelope.requestId as string }), input);
	assert.deepEqual(supportedOperations["task-submit"], envelope.contract);
});

test("operator-input mutations refuse admission", () => {
	const input = fixture("operator-input").params as JsonObject;
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

test("change feed accepts a complete revision value without a transport envelope", () => {
	for (const revision of [0, 1, 7]) assert.deepEqual(decodeResponse("changes", {revision}), {revision});
	for (const changed of [{revision: -1}, {revision: 0.5}, {revision: "1"}, {revision: 1, sequence: 1}, {},
		{type: "state", member: "change", sequence: 1, ops: [["r", {revision: 1}]]}]) refusal(() => decodeResponse("changes", changed));
});

test("conversation frames bind storage, conversation, token, and native status", () => {
	const value = frame(); assert.deepEqual(decodeFrame(value, { identity: storageId }), value);
	const retry = frame(); (retry.status as JsonObject).live = {generation: {attempt: 2, retry: {at: 1700000060000, error: 'opaque'}}};
	assert.deepEqual(decodeFrame(retry), retry);
	for (const invalid of [{attempt: 0, retry: {at: 1, error: ''}}, {attempt: 1, retry: {at: -1, error: ''}}, {attempt: 1, retry: {at: 1, error: 3}}, {attempt: 1, retry: {at: 8640000000000001, error: ''}}]) {
		const changed = frame(); (changed.status as JsonObject).live = {generation: invalid}; refusal(() => decodeFrame(changed));
	}
	const invalidBlock = frame(); (invalidBlock.status as JsonObject).providerBlock = {error: 'not a complete block'}; refusal(() => decodeFrame(invalidBlock));
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

test("native timing fields survive frame and inspect decoding without elapsed substitution", () => {
	const value = frame();
	const message = { role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 900_000, durationMs: 7 };
	value.entries = [{ id: "1", kind: "pi.tool-result", model: [message] }];
	const nativeTask = { id: 1, kind: "pi.tool", status: "running", background: false, abortRequested: false, startedAt: 100, endedAt: 900_000 };
	(value.status as JsonObject).tasks = [nativeTask];
	assert.deepEqual(decodeFrame(value), value);
	for (const role of ["assistant", "toolResult"]) {
		for (const durationMs of [0, 7]) {
			value.entries = [{ id: "1", kind: "pi.assistant", model: [{ ...message, role, durationMs }] }];
			assert.deepEqual(decodeFrame(value), value);
		}
		for (const durationMs of [-1, 0.5, "7"]) {
			value.entries = [{ id: "1", kind: "pi.assistant", model: [{ ...message, role, durationMs }] }];
			refusal(() => decodeFrame(value));
		}
	}
	const { durationMs: _duration, ...untimed } = message;
	value.entries = [{ id: "1", kind: "pi.tool-result", model: [untimed] }];
	assert.deepEqual(decodeFrame(value), value);
	(value.status as JsonObject).tasks = [{ ...nativeTask, startedAt: "100" }];
	refusal(() => decodeFrame(value));
	const result = { name: "read", text: "done", isError: false, truncated: false, durationMs: 7 };
	const history = { ...inspectBase("history"), format: "compact", order: "newestFirst", nextCursor: null, detail: "",
		entries: [{ id: 1, kind: "pi.tool-result", source: "toolResult", text: "", truncated: false, format: "compact", nextOffset: null, toolResults: [result] }] };
	assert.deepEqual(decodeResponse("inspect", history), history);
	for (const durationMs of [-1, 0.5, "7"]) {
		const changed = { ...history, entries: [{ ...history.entries[0], toolResults: [{ ...result, durationMs }] }] };
		refusal(() => decodeResponse("inspect", changed));
	}
});

test("native nested tool and compaction fields preserve absent timing and reject malformed state", () => {
	const value = frame();
	const nested = {callId: "parent/child", name: "read", taskId: 3, parentCallId: "parent", parentTaskId: 2,
		arguments: {path: "document.md"}, status: "running", output: "partial", droppedBytes: 0, droppedLines: 0};
	const compaction = {taskId: 4, reason: "threshold", blocking: true, attempt: 1, retry: {at: 1000, error: "retry"}};
	const live = {nestedTools: [nested], compactions: [compaction], compactionFailure: {taskId: 5, reason: "manual", error: "failed"}};
	(value.status as JsonObject).live = live;
	value.live = [{id: "live:tool:parent/child", kind: "pi.tool-result", data: {live: true, nestedTool: nested}}];
	assert.deepEqual(decodeFrame(value), value);
	assert.equal(Object.hasOwn(live.compactionFailure, "at"), false);
	for (const change of [{taskId: 0}, {parentTaskId: "2"}, {parentCallId: 4}, {status: "working"}, {output: []}, {summary: {isError: "false"}}]) {
		refusal(() => decodeFrame({...value, status: {...value.status as JsonObject, live: {...live, nestedTools: [{...nested, ...change}]}}}));
	}
	for (const change of [{reason: "other"}, {blocking: 1}, {attempt: -1}, {retry: {at: "1000", error: "retry"}}]) {
		refusal(() => decodeFrame({...value, status: {...value.status as JsonObject, live: {...live, compactions: [{...compaction, ...change}]}}}));
	}
	refusal(() => decodeFrame({...value, live: [{id: "live:tool:wrong", kind: "pi.tool-result", data: {live: true, nestedTool: nested}}]}));
});

test("dashboard compaction failures accept an absent timestamp without substitution", () => {
	for (const compactionFailure of [{reason: "manual"}, {reason: "overflow", errorMessage: "failed"}, {reason: "threshold", at: "2026-01-01T00:00:00.000Z"}]) {
		const rows = [{...row(), health: {compactionFailure}}];
		assert.deepEqual(decodeResponse("dashboard", rows), rows);
		assert.deepEqual(decodePublication({...fixture("empty-publication"), rows}, storageId).rows, rows);
	}
	refusal(() => decodeResponse("dashboard", [{...row(), health: {compactionFailure: {reason: "manual", at: 0}}}]));
});

test("activity metadata keeps native nested task identities without inventing elapsed time", () => {
	const running = {toolCallId: "parent/child", name: "read", taskId: 3, parentTaskId: 2, parentToolCallId: "parent"};
	const value = {...inspectBase("activity"), format: "compact", turns: [], nextCursor: null, detail: "",
		metadata: {owner: "here", live: true, operation: 1, pending: null, runningTools: [running], compactionFailure: {reason: "manual", errorMessage: "failed"}},
		coverage: {scannedEntries: 0, scannedBytes: 0, complete: true, entryLimitReached: false, scanByteLimitReached: false, byteLimitReached: false, bytes: 0, omittedEntries: 0, metadataTruncated: false}};
	assert.deepEqual(decodeResponse("inspect", value), value);
	for (const change of [{taskId: 0}, {parentTaskId: "2"}, {parentToolCallId: 7}, {elapsedMs: -1}]) {
		refusal(() => decodeResponse("inspect", {...value, metadata: {...value.metadata, runningTools: [{...running, ...change}]}}));
	}
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


test("task-submit requires the current response identity without version tolerance", () => {
	const current = descriptor();
	assertOperation(decodeDescriptor(current), "task-submit");
	(current.operations as JsonObject)["task-submit"] = { request: "task-submit/1.0.0", response: "task-submit/1.1.0" };
	refusal(() => assertOperation(decodeDescriptor(current), "task-submit"), "incompatible");
	assertOperation(decodeDescriptor(current), "inspect");
});

test("current admissions retain deduped and bind child and root result references", () => {
	for (const identity of [storageId, `${storageId}:2`]) {
		for (const deduped of [false, true]) {
			const value = { identity, conversationId: identity === storageId ? 1 : 2, submissionId: 7, deduped,
				result: { sessionId: identity, submissionId: 7, requestId } };
			assert.deepEqual(decodeResponse("task-submit", value, { identity, requestId }), value);
			refusal(() => decodeResponse("task-submit", { ...value, deduped: "false" }));
			refusal(() => decodeResponse("task-submit", { ...value, result: { ...value.result, requestId: "different" } }, { identity, requestId }));
		}
	}
	refusal(() => decodeResponse("task-submit", { suppressed: true }));
});

test("the documented missing-request result decodes without a fabricated submission ID", () => {
	const params = { sessionId: storageId, view: "result", requestId: "missing-native-request" };
	assert.deepEqual(decodeInput("inspect", params), params);
	const documented = fixture("unavailable-result");
	assert.equal(documented.status, "unavailable");
	assert.equal(documented.requestId, params.requestId);
	assert.equal(Object.hasOwn(documented, "submissionId"), false);
	assert.deepEqual(decodeResponse("inspect", documented, { identity: storageId, requestId: params.requestId }), documented);
	for (const changed of [{ ...documented, submissionId: 0 }, { ...documented, status: "done" }, { ...documented, answer: "fabricated" }]) refusal(() => decodeResponse("inspect", changed));
	const { reason: _reason, ...withoutReason } = documented;
	refusal(() => decodeResponse("inspect", withoutReason));
	refusal(() => decodeResponse("inspect", documented, { requestId: "different" }));
});

test("result request selectors validate current shapes without forbidding matching combined selectors", () => {
	const params = { sessionId: storageId, view: "result", requestId: "exact-request" };
	for (const selectors of [{}, { submissionId: 7 }, { operationId: "exact-operation" }]) assert.deepEqual(decodeInput("inspect", { ...params, ...selectors }), { ...params, ...selectors });
	for (const changed of [{ ...params, requestId: "" }, { ...params, requestId: 7 }, { ...params, view: "history" }, { ...params, submissionId: 0 }]) refusal(() => decodeInput("inspect", changed));
	refusal(() => decodeInput("inspect", { sessionId: storageId, view: "result" }));
});

test("current inspect result validates optional provider facts and recovery references", () => {
	const value = blockedResult(storageId, requestId);
	assert.deepEqual(decodeResponse("inspect", value, { identity: storageId, requestId }), value);
	const block = value.providerBlock as JsonObject;
	for (const [key, changed] of Object.entries({ blockId: "", conversationId: 0, providerSessionId: "", epoch: -1,
		model: { provider: "fixture", modelId: 7 }, error: "x".repeat(4097), errorRedacted: "false", errorTruncated: null,
		source: "unknown", timestamp: 0.5, originalResults: [{ sessionId: storageId, submissionId: 0 }], omittedOriginalResults: -1 })) {
		refusal(() => decodeResponse("inspect", { ...value, providerBlock: { ...block, [key]: changed } }));
	}
	for (const key of Object.keys(block)) {
		const changed = { ...block }; delete changed[key];
		refusal(() => decodeResponse("inspect", { ...value, providerBlock: changed }));
	}
	for (const reference of [{ sessionId: "@fixture", submissionId: 7 }, { sessionId: storageId, submissionId: 7, requestId: "" },
		{ sessionId: storageId, submissionId: 7, extra: true }]) {
		refusal(() => decodeResponse("inspect", { ...value, providerBlock: { ...block, originalResults: [reference] } }));
	}
	refusal(() => decodeResponse("inspect", { ...value, providerBlock: { ...block, originalResults: Array(17).fill({ sessionId: storageId, submissionId: 7 }) } }));
	refusal(() => decodeResponse("inspect", { ...value, recoveryOf: 7 }));
	const absent = { ...value }; delete absent.providerBlock; delete absent.recoveryOf;
	assert.deepEqual(decodeResponse("inspect", absent), absent);
});
