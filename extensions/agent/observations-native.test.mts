import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Check, Errors } from "typebox/value";
import type { TSchema } from "typebox";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "./native-fixture.mts";
import { AgentManager } from "./index.ts";
import { testModel } from "./test-runtime.mts";
import { InspectOutputSchema, ListOutputSchema, RunsOutputSchema, StatusOutputSchema } from "./observations.ts";

test("native codemode composes observations under hooks and keeps compaction model-only", { timeout: 30000 }, async () => {
	const f = await fixture(undefined, {}, { defaultTools: ["+codemode"], codemode: { mode: "only" } });
	await f.worker.close();
	const prior = { dir: process.env.PI_AGENT_DIR, sessions: process.env.PI_AGENT_SESSIONS_DIR };
	process.env.PI_AGENT_DIR = f.agentDir; process.env.PI_AGENT_SESSIONS_DIR = f.store.root;
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	try {
		const extensionPath = `${f.path}.observations.ts`;
		writeFileSync(extensionPath, `import register from ${JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url)))};
		import { Type } from "typebox";
		export default pi => {
			register(pi);
			pi.on("tool_call", event => event.toolName === "agent_list" && event.input.query === "blocked" ? { block: true, reason: "OBSERVATION_BLOCKED" } : undefined);
			pi.on("tool_result", event => event.toolName === "agent_runs" ? { structuredContent: { ...event.structuredContent, boundary: "NATIVE_RESULT_HOOK" } } : undefined);
			pi.registerTool({ name: "compact_probe", label: "Probe", description: "Exercise the native nested refusal", exposure: "model-only", parameters: Type.Object({sessionId: Type.String()}), async execute(id, args, signal, update, ctx) {
				const result = await ctx.executeTool("agent_compact", {sessionId:args.sessionId, summary:"Must not compact"}, {signal});
				return {content:[{type:"text",text:JSON.stringify({refused:result.isError})}], details:undefined};
			} });
		}`);
		const stored = SessionManager.create(f.cwd, f.store.nativeRoot);
		stored.appendMessage({ role: "user", content: "compose-target", timestamp: 1 });
		stored.appendCustomEntry("agent.operation", { operationId: "saved-operation" });
		const resultId = stored.appendCustomEntry("agent.result", { operationId: "saved-operation", status: "failed", error: { message: "SAVED_FAILURE" } });
		writeFileSync(join(f.store.nativeRoot, "zz-invalid.jsonl"), "invalid\n");
		const storedFile = stored.getSessionFile(); assert.ok(storedFile);
		appendFileSync(storedFile, '{"type":"message"');
		let self = "", requests = 0;
		let reloadCode = "";
		const code = `
			const listed = await tools.agent_list({query:"compose-target"});
			const row = listed.rows.find(row => row.sessionId === ${JSON.stringify(stored.getSessionId())});
			if (!row) throw new Error("missing exact session");
			const live = await tools.agent_status({sessionId:${"SELF_ID"}});
			const saved = await tools.agent_status({sessionId:row.sessionId});
			const result = await tools.agent_inspect({sessionId:row.sessionId,view:"result"});
			const runs = await tools.agent_runs({runId:"absent-run"});
			let refusal;
			try { await tools.agent_list({query:"blocked"}); } catch(error) { refusal=String(error); }
			return {id:row.sessionId, live:live.source, operation:live.sessions[0].operation, saved:saved.source,
				resultId:result.entryId,status:result.status,operationId:result.operationId,
				skipped:listed.coverage.skipped.length,partial:saved.sessions[0].capture.unfinishedTail,missingRun:runs.found,hook:runs.boundary,refusal,
				compactCallable:typeof tools.agent_compact === "function"};`;
		const stream = (_model: unknown, context: Parameters<NonNullable<ReturnType<typeof f.runtime.getRegisteredNativeProvider>>["stream"]>[1]) => {
			requests++;
			assert.ok(requests <= 5);
			const names = getCurrentTools(context.messages).map(tool => tool.name);
			assert.ok(names.includes("agent_compact")); assert.ok(names.includes("codemode")); assert.ok(!names.includes("agent_list"));
			const content: AssistantMessage["content"] = requests === 4 ? [{ type: "toolCall", id: "after-reload", name: "codemode", arguments: { code: reloadCode } }] : requests === 1 ? [
				{ type: "toolCall", id: "compose", name: "codemode", arguments: { code: code.replace("SELF_ID", JSON.stringify(self)) } },
				{ type: "toolCall", id: "probe", name: "compact_probe", arguments: { sessionId: self } },
			] : requests === 2 ? [{ type: "toolCall", id: "direct-compact", name: "agent_compact", arguments: { sessionId: self, summary: "OBSERVATION_CONTINUITY: preserve exact sources, incomplete evidence, and refusal. No publication authority." } }] : [{ type: "text", text: "DONE" }];
			const message: AssistantMessage = { role: "assistant", content, api: testModel.api, provider: testModel.provider, model: testModel.id, stopReason: requests < 3 || requests === 4 ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const events = createAssistantMessageEventStream(); events.push({ type: "start", partial: message }); events.push({ type: "done", reason: requests < 3 || requests === 4 ? "toolUse" : "stop", message }); events.end(message); return events;
		};
		const provider = f.runtime.getRegisteredNativeProvider(testModel.provider); assert.ok(provider);
		f.runtime.registerNativeProvider({ ...provider, stream, streamSimple: stream });
		self = (await manager.spawn({ cwd: f.cwd }, { cwd: f.cwd, model: testModel }, undefined, { extensionPaths: [extensionPath] })).sessionId;
		const workers = (manager as unknown as { sessions: Map<string, typeof f.worker> }).sessions;
		const worker = workers.get(self); assert.ok(worker);
		const schemas = new Map<string, TSchema>([["agent_list", ListOutputSchema], ["agent_status", StatusOutputSchema], ["agent_inspect", InspectOutputSchema], ["agent_runs", RunsOutputSchema]]);
		const failures: string[] = []; const seen = new Set<string>();
		worker.observe(event => {
			if (event.type !== "tool_execution_end" || event.isError || !schemas.has(event.toolName)) return;
			const schema = schemas.get(event.toolName); if (!schema) return;
			const value = (event.result as { structuredContent?: unknown }).structuredContent;
			seen.add(event.toolName);
			if (!Check(schema, value)) failures.push(JSON.stringify([...Errors(schema, value)]));
		});
		await manager.send(self, "Compose observations and preserve their evidence limits."); await worker.waitForIdle();
		assert.deepEqual(failures, []); assert.equal(seen.size, 4, JSON.stringify(worker.sessionManager().getEntries()));
		const entries = worker.sessionManager().getEntries();
		const result = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "compose");
		assert.ok(result?.type === "message" && result.message.role === "toolResult");
		assert.equal(result.message.isError, false, JSON.stringify(result));
		const output = JSON.stringify(result.message.content);
		for (const expected of [stored.getSessionId(), resultId, "saved-operation", "failed", "live-owner", "read-only-capture", "OBSERVATION_BLOCKED", "NATIVE_RESULT_HOOK"]) assert.ok(output.includes(expected), output);
		assert.match(output, /compactCallable[\\"\s:]*false/); assert.match(output, /missingRun[\\"\s:]*false/);
		assert.match(output, /partial[\\"\s:]*true/); assert.match(output, /skipped[\\"\s:]*1/);
		const probe = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "probe");
		assert.match(JSON.stringify(probe), /refused[\\"\s:]*true/);
		assert.equal(entries.filter(entry => entry.type === "compaction").length, 1);
		assert.equal(requests, 3);
		// Retain a source owner without callback support across actual native reload.
		const originalStatus = manager.status.bind(manager), originalRuns = manager.runs.bind(manager);
		manager.status = (id, signal) => originalStatus(id, signal);
		manager.runs = id => originalRuns(id);
		reloadCode = `const status = await tools.agent_status({}); const runs = await tools.agent_runs({runId:"absent-run"});
			return {source:status.source, statusComplete:status.coverage.complete, statusReason:status.unavailable,
				found:runs.found, runsComplete:runs.coverage.complete, runsReason:runs.unavailable};`;
		await worker.reload();
		await manager.send(self, "Read retained owner observations after reload."); await worker.waitForIdle();
		assert.equal(requests, 5); assert.deepEqual(failures, []);
		const reloaded = worker.sessionManager().getEntries().find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "after-reload");
		assert.ok(reloaded?.type === "message" && reloaded.message.role === "toolResult");
		assert.equal(reloaded.message.isError, false, JSON.stringify(reloaded));
		const reloadText = JSON.stringify(reloaded.message.content);
		assert.match(reloadText, /retained owner did not supply structured observation/);
		assert.match(reloadText, /statusComplete[\\"\s:]*false/);
		assert.match(reloadText, /runsComplete[\\"\s:]*false/);
		assert.match(reloadText, /found[\\"\s:]*null/);
	} finally {
		await manager.closeAll(); await f.close();
		if (prior.dir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = prior.dir;
		if (prior.sessions === undefined) delete process.env.PI_AGENT_SESSIONS_DIR; else process.env.PI_AGENT_SESSIONS_DIR = prior.sessions;
	}
});
