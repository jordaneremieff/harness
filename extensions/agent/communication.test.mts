import assert from "node:assert/strict";
import { test } from "node:test";
import { boundCommunicationViews, communicationFingerprint, communicationIdentity, communicationSerializedBytes, parseCommunication, parseCommunicationCompanion, parseCommunicationPassive, parseCommunicationView, type Communication, type CommunicationView } from "./communication.ts";

const storageId = "00000000-0000-4000-8000-000000000071";
const report = (): Extract<Communication, { kind: "report" }> => ({ format: "agent.communication/1", sender: { identity: storageId }, body: { text: "A retained contribution.\n", complete: true, redacted: false }, recordedAt: 123, kind: "report", metadata: { sourceId: "report:one", requestId: "one" } });
const ready = (value: Communication = report()): CommunicationView => ({ state: "ready", recordEntryId: "3", target: { mode: "input", storageId, conversationId: 1, entryId: "2", submissionId: 1, requestId: "one" }, value });

test("communication accepts exactly one closed variant and preserves absent facts", () => {
	const value = parseCommunication(report());
	assert.deepEqual(value, report());
	assert.equal(value?.sender.name, undefined);
	assert.equal(parseCommunication({ ...report(), extra: true }), undefined);
	assert.equal(parseCommunication({ ...report(), sender: { identity: storageId, role: "owner" } }), undefined);
	assert.equal(parseCommunication({ ...report(), metadata: { sourceId: "report:one", requestId: "one", event: 4 } }), undefined);
	assert.equal(parseCommunication({ ...report(), recordedAt: -1 }), undefined);
	assert.equal(parseCommunication({ ...report(), recordedAt: 1.5 }), undefined);
});

test("canonical communication identities do not rewrite a selected source", () => {
	assert.equal(communicationIdentity(storageId), true);
	assert.equal(communicationIdentity(`${storageId}:2`), true);
	for (const value of [`${storageId}:1`, `${storageId}:02`, `${storageId}:+2`, `${storageId}:2.0`, `${storageId}:9007199254740992`, "@peer", "a sender label", `${storageId}:2:3`]) assert.equal(communicationIdentity(value), false, value);
});

test("body and metadata limits use bytes and reject broken Unicode", () => {
	assert.ok(parseCommunication({ ...report(), body: { text: "🙂".repeat(4096), complete: false, redacted: false } }));
	assert.equal(parseCommunication({ ...report(), body: { text: "🙂".repeat(4097), complete: false, redacted: false } }), undefined);
	assert.equal(parseCommunication({ ...report(), body: { text: "\ud800", complete: false, redacted: false } }), undefined);
	assert.equal(parseCommunication({ ...report(), body: { text: "\u0000", complete: false, redacted: false } }), undefined);
	assert.equal(parseCommunication({ ...report(), sender: { identity: storageId, name: "🙂".repeat(41) } }), undefined);
	assert.ok(parseCommunication({ ...report(), body: { text: "\tA\nB\r\n", complete: false, redacted: true } }));
});

test("result references preserve groups and require bounded canonical entry IDs", () => {
	const value = { ...report(), kind: "result", metadata: { status: "done", references: [{ submissionId: 3, requestId: "one", entryId: "2", answerEntryId: "4" }], omittedReferences: 0 } };
	assert.ok(parseCommunication(value));
	assert.equal(parseCommunication({ ...value, metadata: { ...value.metadata, references: [] } }), undefined);
	assert.equal(parseCommunication({ ...value, metadata: { ...value.metadata, references: Array.from({ length: 17 }, () => ({ submissionId: 3 })) } }), undefined);
	for (const entryId of ["0", "02", "9007199254740992"]) assert.equal(parseCommunication({ ...value, metadata: { ...value.metadata, references: [{ submissionId: 3, entryId }] } }), undefined);
});

test("passive communication is a notice with an explicit passive fact", () => {
	const value: Communication = { ...report(), kind: "notice", metadata: { threadId: "thread:one", passive: true } };
	assert.ok(parseCommunicationPassive({ format: "agent.communication-passive/1", requestId: "notice:one", value }));
	assert.equal(parseCommunicationPassive({ format: "agent.communication-passive/1", requestId: "notice:one", value: report() }), undefined);
	assert.equal(parseCommunicationPassive({ format: "agent.communication-passive/1", requestId: "notice:one", value: { ...value, metadata: { threadId: "thread:one" } } }), undefined);
});

test("companion and view shapes do not admit synthetic model or submission fields", () => {
	const view = ready();
	assert.equal(view.state, "ready");
	if (view.state !== "ready") throw Error("Invalid fixture");
	const companion = { format: "agent.communication-link/1", target: view.target, value: view.value };
	assert.ok(parseCommunicationCompanion(companion));
	assert.equal(parseCommunicationCompanion({ ...companion, model: [] }), undefined);
	assert.deepEqual(parseCommunicationView(view), view);
	assert.equal(parseCommunicationView({ ...view, recordEntryId: "03" }), undefined);
	assert.equal(parseCommunicationView({ state: "unavailable", reason: "unknown" }), undefined);
	assert.deepEqual(parseCommunicationView({ state: "unresolved" }), { state: "unresolved" });
});

test("stable fingerprints ignore object key order but retain reference order", () => {
	const a = report();
	const b = { ...a, metadata: { requestId: "one", sourceId: "report:one" } };
	assert.equal(communicationFingerprint(a), communicationFingerprint(b));
	const first: Communication = { ...a, kind: "result", metadata: { status: "done", references: [{ submissionId: 1 }, { submissionId: 2 }], omittedReferences: 0 } };
	const second: Communication = { ...first, metadata: { ...first.metadata, references: [...first.metadata.references].reverse() } };
	assert.notEqual(communicationFingerprint(first), communicationFingerprint(second));
});

test("added views reserve remaining markers and allocate in returned order", () => {
	const large = ready({ ...report(), body: { text: "x".repeat(16_384), complete: false, redacted: false } });
	const values = [large, large, large, large, ...Array.from({ length: 196 }, (): CommunicationView => ({ state: "unresolved" }))];
	const bounded = boundCommunicationViews(values);
	assert.equal(bounded.length, 200);
	assert.equal(bounded[0]?.state, "ready");
	assert.equal(bounded[1]?.state, "ready");
	assert.equal(bounded[2]?.state, "ready");
	assert.deepEqual(bounded[3], { state: "unavailable", reason: "limit" });
	assert.ok(bounded.reduce((sum, value) => sum + communicationSerializedBytes(value), 0) <= 65_536);
});
