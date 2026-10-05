import assert from "node:assert/strict";
import { it } from "node:test";
import { AwaitDoc, declareAwait, commitAwaitOutcome, classifyAwaitInput, reconcileInputRelease, boundedAwaitAnswer, forgetFailedAdmission, type AwaitState } from "./awaited-results.ts";
import { LiveDoc, InboxDoc, type Tx, type ConversationId, type TaskId } from "@earendil-works/pi-durable";

/** A serialized native transaction's read set, with controlled request placement. */
function fixture() {
	const state: AwaitState = { declarations: [], provenance: [] };
	const live = new Map<number, { run: { taskId: number; inputs: number[] }; tools: { taskId: number }[] }>();
	const inbox = new Map<number, { items: { id: number; mode: string }[] }>();
	const tasks = new Map<number, { state: { status: string; outcome?: { status: string } }; abortRequested?: boolean }>();
	const inputs = new Map<string, { id: number; conversationId?: number; type: string; status: string; requestId?: string; entry?: number; reason?: string }>();

	const tx = {
		async doc(kind: unknown, id?: number | string) {
			if (kind === AwaitDoc) return state;
			if (kind === LiveDoc) return live.get(id as number) ?? {};
			if (kind === InboxDoc) return inbox.get(id as number) ?? { items: [] };

			throw new Error("Unexpected document");
		},
		async task(id: number) { return tasks.get(id); },
		async submissionByRequest(id: number, requestId: string) { return inputs.get(`${id}/${requestId}`); },
	} as unknown as Tx;
	function owner(id: number, tool = id * 10) {
		live.set(id, { run: { taskId: id * 100, inputs: [id * 1000] }, tools: [{ taskId: tool }] });
		tasks.set(tool, { state: { status: "running" } });
		return { conversationId: id as ConversationId, taskId: tool as TaskId, callId: `call-${tool}` };
	}
	function result(id: number, known = true) {
		const requestId = `input-${id}`;
		inputs.set(`${id}/${requestId}`, { id: id * 1000, conversationId: id, type: "input", status: "placed", requestId });
		return { sessionId: id === 1 ? "store" : `store:${id}`, submissionId: id * 1000, ...(known ? { requestId } : {}) };
	}
	return { tx, state, live, inbox, tasks, inputs, owner, result };
}

for (const known of [true, false]) {
	it(`refuses self and local cycles through ${known ? "request lookup" : "live membership"}`, async () => {
		const f = fixture(); const a = f.owner(1); const b = f.owner(2); const c = f.owner(3);
		const ar = f.result(1, known); const br = f.result(2, known); const cr = f.result(3, known);
		await assert.rejects(declareAwait(f.tx, "store", a, [ar]), /self/u);
		await declareAwait(f.tx, "store", a, [br]);
		await declareAwait(f.tx, "store", b, [cr]);
		await assert.rejects(declareAwait(f.tx, "store", c, [ar]), /local result cycle/u);
		assert.equal(f.state.declarations.length, 2);
	});
	it(`refuses a cycle through queued ${known ? "named" : "bare"} requests`, async () => {
		const f = fixture(); const a = f.owner(1); const b = f.owner(2);
		const ar = f.result(1, known); const br = f.result(2, known);
		f.live.set(2, { run: { taskId: 200, inputs: [] }, tools: [{ taskId: 20 }] });
		f.inbox.set(2, { items: [{ id: br.submissionId, mode: "followUp" }] });
		await declareAwait(f.tx, "store", a, [br]);
		await assert.rejects(declareAwait(f.tx, "store", b, [ar]), /local result cycle/u);
	});
}
it("validates known identifiers but does not invent validity from absent bare membership", async () => {
	const f = fixture(); const a = f.owner(1); const br = f.result(2);
	await assert.rejects(declareAwait(f.tx, "store", a, [{ ...br, submissionId: 9 }]), /admitted input/u);
	const declaration = await declareAwait(f.tx, "store", a, [{ sessionId: "store:2", submissionId: 9 }]);
	assert.equal(declaration.decision, "awaiting");
});
it("retires terminal-owner edges and ends local traversal at a foreign result", async () => {
	const f = fixture(); const a = f.owner(1); const b = f.owner(2);
	await declareAwait(f.tx, "store", a, [f.result(2)]);
	f.tasks.set(a.taskId, { state: { status: "terminal", outcome: { status: "completed" } } });
	await declareAwait(f.tx, "store", b, [f.result(1), { sessionId: "foreign", submissionId: 8 }]);
	assert.equal(f.state.declarations.filter((item) => item.decision === "awaiting").length, 1);
});
it("releases every await in a parallel round on a failed dependency", async () => {
	const f = fixture(); const a = f.owner(1); const peer = { ...a, taskId: 11 as TaskId, callId: "parallel" };
	f.tasks.set(11, { state: { status: "running" } }); const live = f.live.get(1); assert.ok(live); live.tools.push({ taskId: 11 });
	const first = f.result(2); const second = f.result(3);
	await declareAwait(f.tx, "store", a, [first]); await declareAwait(f.tx, "store", peer, [second]);
	await commitAwaitOutcome(f.tx, a.taskId, { result: first, status: "unanswered", reason: "aborted" });
	assert.deepEqual(f.state.declarations.map((item) => item.decision), ["failed", "released"]);
	assert.deepEqual(f.state.declarations[1].outcomes, []);
});
for (const classification of ["explicit", "report", "automatic"] as const) it(`reconciles pre-admission ${classification} provenance on safe replay`, async () => {
	const f = fixture(); const a = f.owner(1); const result = f.result(2);
	await classifyAwaitInput(f.tx, { conversationId: 1, requestId: "incoming", classification, sender: result.sessionId, automaticKind: "timer" });
	f.inputs.set("1/incoming", { id: 90, type: "input", status: "queued" });
	f.inbox.set(1, { items: [{ id: 90, mode: "steer" }, { id: 91, mode: "write" }] });
	const declaration = await declareAwait(f.tx, "store", a, [result]);
	assert.equal(declaration.decision, classification === "automatic" ? "awaiting" : "released");
	await reconcileInputRelease(f.tx, a.conversationId, "incoming");
	assert.equal(f.state.declarations[0].decision, declaration.decision);
});
it("suppresses only check-ins for named results and defers other automatic input", async () => {
	const f = fixture(); const a = f.owner(1); const result = f.result(2); await declareAwait(f.tx, "store", a, [result]);
	const auto = { conversationId: 1, requestId: "check", classification: "automatic" as const, automaticKind: "checkIn" as const, sender: result.sessionId, producerRequestId: result.requestId };
	assert.deepEqual(await classifyAwaitInput(f.tx, auto), { suppress: true, defer: true, release: false });
	assert.equal(f.state.provenance.length, 0);
	assert.deepEqual(await classifyAwaitInput(f.tx, { ...auto, requestId: "different", producerRequestId: "unrelated" }), { suppress: false, defer: true, release: false });
	await classifyAwaitInput(f.tx, { conversationId: 1, requestId: "unrelated-report", classification: "report", sender: "another" });
	f.inputs.set("1/unrelated-report", { id: 92, type: "input", status: "queued" });
	await reconcileInputRelease(f.tx, a.conversationId, "unrelated-report");
	assert.equal(f.state.declarations[0].decision, "awaiting");
});
it("keeps a failed admission intact and refuses replay with changed provenance", async () => {
	const f = fixture(); const a = f.owner(1); await declareAwait(f.tx, "store", a, [f.result(2)]);
	await classifyAwaitInput(f.tx, { conversationId: 1, requestId: "failed-admission", classification: "explicit" });
	await reconcileInputRelease(f.tx, a.conversationId, "failed-admission");
	assert.equal(f.state.declarations[0].decision, "awaiting");
	await assert.rejects(classifyAwaitInput(f.tx, { conversationId: 1, requestId: "failed-admission", classification: "automatic" }), /different release provenance/u);
});
it("does not let a settled old input release a newer await", async () => {
	const f = fixture(); const a = f.owner(1); const result = f.result(2);
	await classifyAwaitInput(f.tx, { conversationId: 1, requestId: "old", classification: "explicit" });
	f.inputs.set("1/old", { id: 90, type: "input", status: "done", entry: 99 });
	await declareAwait(f.tx, "store", a, [result]);
	await reconcileInputRelease(f.tx, a.conversationId, "old");
	assert.equal(f.state.declarations[0].decision, "awaiting");
});
it("keeps a failed round decision for a delayed parallel declaration", async () => {
	const f = fixture(); const a = f.owner(1); const peer = { ...a, taskId: 11 as TaskId, callId: "delayed" };
	const live = f.live.get(1); assert.ok(live); live.tools.push({ taskId: 11 }); f.tasks.set(11, { state: { status: "running" } });
	const first = f.result(2); const second = f.result(3);
	await declareAwait(f.tx, "store", a, [first]);
	await commitAwaitOutcome(f.tx, a.taskId, { result: first, status: "unanswered", reason: "model_error" });
	f.tasks.set(a.taskId, { state: { status: "terminal", outcome: { status: "completed" } } });
	assert.equal((await declareAwait(f.tx, "store", peer, [second])).decision, "released");
});
it("does not exhaust active slots across repeated aborts and failed admissions", async () => {
	const f = fixture(); const result = f.result(2);
	for (let index = 0; index < 256; index++) {
		const a = f.owner(1, index + 10);
		await declareAwait(f.tx, "store", a, [result]);
		f.tasks.set(a.taskId, { abortRequested: true, state: { status: "running" } });
		await classifyAwaitInput(f.tx, { conversationId: 1, requestId: `failed-${index}`, classification: "explicit" });
		await forgetFailedAdmission(f.tx, a.conversationId, `failed-${index}`);
	}
	assert.equal(f.state.declarations.length, 0); assert.equal(f.state.provenance.length, 0);
});

it("provides an exact native continuation for capped and excerpt answers", () => {
	const result = { sessionId: "store:2", submissionId: 3 };
	const capped = boundedAwaitAnswer(result, `${"x".repeat(15999)}😀rest`, 8);
	assert.equal(capped.answer?.length, 15999); assert.equal(capped.truncated, true);
	assert.deepEqual(capped.continuation, { tool: "agent_inspect", sessionId: "store:2", view: "exact", entryId: 8, offset: 0 });
	assert.equal(boundedAwaitAnswer(result, "excerpt", 8, true).excerpt, true);
	assert.throws(() => boundedAwaitAnswer(result, "excerpt", undefined, true), /continuation/u);
});
