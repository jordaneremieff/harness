import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { fixture } from "./native-fixture.mts";
import { testModel } from "./test-runtime.mts";
import { AgentWorkerSession } from "./worker.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("native worker status and activity expose a running tool and retain its failed outcome after settlement", { timeout: 15000 }, async () => {
	const f = await fixture();
	const entered = deferred(), release = deferred();
	let worker = f.worker;
	const key = `activity${randomUUID().replaceAll("-", "")}`;
	const globals = globalThis as unknown as Record<string, unknown>;
	globals[key] = async () => { entered.resolve(); await release.promise; return { content: [{ type: "text", text: `TOOL_FAILURE ${"x".repeat(2000)}` }], isError: true }; };
	try {
		writeFileSync(f.path, `import { Type } from "typebox";
		export default pi => pi.registerTool({name:"activity_probe",label:"Probe",description:"Controlled tool",parameters:Type.Object({}),execute:()=>globalThis[${JSON.stringify(key)}]()});`);
		await f.worker.close();
		let calls = 0;
		const stream = () => {
			calls++;
			const content: AssistantMessage["content"] = calls === 1 ? [{ type: "text", text: "Call the controlled tool." }, { type: "toolCall", id: "exact-call", name: "activity_probe", arguments: {} }] : [{ type: "text", text: "Tool failure observed." }];
			const message: AssistantMessage = { role: "assistant", content, api: testModel.api, provider: testModel.provider, model: testModel.id, stopReason: calls === 1 ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const events = createAssistantMessageEventStream();
			events.push({ type: "start", partial: message }); events.push({ type: "done", reason: calls === 1 ? "toolUse" : "stop", message }); events.end(message); return events;
		};
		const provider = f.runtime.getRegisteredNativeProvider(testModel.provider); assert.ok(provider);
		f.runtime.registerNativeProvider({ ...provider, stream, streamSimple: stream });
		worker = await AgentWorkerSession.create(f.options);
		await worker.reload();
		assert.ok((await worker.status()).tools.includes("activity_probe"));
		const activityState = worker as unknown as { toolsRunning: Map<string, { name: string; startedAt: number }> };
		activityState.toolsRunning.set("stale-call", { name: "stale_tool", startedAt: 1 });
		const operation = await worker.start("Check tool execution");
		await Promise.race([entered.promise, worker.waitForIdle().then(() => { throw new Error(`Tool was not reached: ${JSON.stringify(worker.sessionManager().getEntries()).slice(-6000)}`); })]);
		const live = await worker.status();
		assert.equal(live.activity?.state, "working");
		assert.equal(live.activity?.runningTools?.[0].toolCallId, "exact-call");
		assert.equal(live.activity?.runningTools?.some((tool) => tool.toolCallId === "stale-call"), false, "begin clears prior host activity independently of native end-event behavior");
		assert.equal(live.activity?.runningTools?.[0].name, "activity_probe");
		assert.ok((live.activity?.runningTools?.[0].elapsedMs ?? -1) >= 0);
		const current = await worker.inspect({ view: "activity" });
		assert.ok("turns" in current); assert.match(current.text, /\[running\]/); assert.match(current.text, /exact-call/);
		release.resolve(); await worker.waitForIdle();
		const settled = await worker.status();
		assert.equal(settled.activity?.state, "idle"); assert.deepEqual(settled.activity?.runningTools, []);
		assert.equal(settled.activity?.lastText, undefined);
		assert.equal(settled.activity?.result?.operationId, operation);
		const history = await worker.inspect({ view: "activity" });
		assert.ok("turns" in history); assert.match(history.text, /isError=true.*TOOL_FAILURE/);
		assert.match(history.text, /last saved result: completed/);
		assert.doesNotMatch(history.text, /streamed assistant text/);
	} finally { release.resolve(); await worker.close(); delete globals[key]; await f.close(); }
});
