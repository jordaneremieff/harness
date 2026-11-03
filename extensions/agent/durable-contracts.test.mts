import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry, type ConversationId, type TaskGraph, type TaskId } from "@earendil-works/pi-durable";
import { AgentMetaDoc, AgentForkDoc } from "./durable-controls.ts";
import { AwaitDoc } from "./awaited-results.ts";
import { ProfileDoc } from "./profile.ts";
import { taskGraphRows } from "./live-frames.ts";

it("keeps Agent document delta policies and explicit base policies through real commits", async (t) => {
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
	t.after(() => harness.close(BACKGROUND_CONTEXT));
	const root = await harness.root(BACKGROUND_CONTEXT);
	for (const name of ["first", "second"]) await harness.commit(async (tx) => {
		(await tx.doc(AgentMetaDoc, root.id)).name = name;
		(await tx.doc(ProfileDoc, root.id)).role = name;
		(await tx.doc(AwaitDoc)).communicationDiagnostic = name === "first" ? "invalid" : "unavailable";
		(await tx.doc(AgentForkDoc)).forks[name] = root.id;
	}, BACKGROUND_CONTEXT);
	for (const kind of ["agent.meta", "agent.profile", "agent.awaited-results"]) {
		const scope = kind === "agent.awaited-results" ? { kind: "session" as const } : { kind: "conversation" as const, conversationId: root.id };
		const record = await storage.findDocument({ kind, scope }, "current", BACKGROUND_CONTEXT);
		assert.ok(record);
		const document = await storage.document(record.id, "current", BACKGROUND_CONTEXT);
		assert.equal(document?.version, 1);
		assert.equal(document?.deltasSinceBase, 1, `${kind} preserves its delta policy after creation`);
	}
	const record = await storage.findDocument({ kind: "agent.forks", scope: { kind: "session" } }, "current", BACKGROUND_CONTEXT);
	assert.ok(record);
	assert.equal((await storage.document(record.id, "current", BACKGROUND_CONTEXT))?.deltasSinceBase, 0);
});

it("preserves sleeping deadlines and native blocked reasons in task rows", () => {
	const graph: TaskGraph = { tasks: { "1": { id: 1 as TaskId, kind: "fixture", conversationId: 1 as ConversationId, background: true, abortRequested: false,
		state: { status: "sleeping", phase: "wait", until: 5000 }, blocked: "missing_task", conversations: [] } } };
	assert.deepEqual(taskGraphRows(graph), [{ id: 1, kind: "fixture", conversationId: 1, background: true, abortRequested: false,
		status: "sleeping", until: 5000, blocked: "missing_task", phase: "wait", waitsOn: [], conversations: [] }]);
});
