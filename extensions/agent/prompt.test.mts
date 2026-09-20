import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { AgentStore } from "./store.ts";
import { AgentWorkerSession } from "./worker.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

for (const recovery of ["resume", "forced", "missing"]) test(`a new process handles ${recovery} prompt state without repeating extension hooks`, { timeout: 30000 }, () => {
	const root = mkdtempSync(join(tmpdir(), "agent-prompt-recovery-"));
	mkdirSync(join(root, "work")); mkdirSync(join(root, "agent"));
	writeFileSync(join(root, "work", "AGENTS.md"), "RECOVERY_CONTEXT");
	const counter = join(root, "hooks.txt");
	writeFileSync(join(root, "extension.ts"), `import { appendFileSync } from "node:fs";
		export default function(pi) { pi.on("before_agent_start", event => {
			appendFileSync(${JSON.stringify(counter)}, "hook\\n");
			event.systemPromptOptions.sections.recovery = "RECORDED_SECTION";
			event.systemPromptOptions.selectedTools = ["read"];
			event.systemPromptOptions.toolSnippets.read = "RECORDED_SNIPPET";
			${recovery === "forced" ? 'return { systemPrompt: "RECORDED_FORCED_PROMPT" };' : ""}
		}); }`);
	try {
		const child = join(import.meta.dirname, "prompt-recovery-child.mts");
		const start = JSON.parse(execFileSync(process.execPath, [child, root, "start"], { encoding: "utf8", timeout: 12000, maxBuffer: 128000 }));
		const resumed = JSON.parse(execFileSync(process.execPath, [child, root, recovery === "missing" ? "missing" : "resume"], { encoding: "utf8", timeout: 12000, maxBuffer: 128000 }));
		assert.equal(start.length, 1);
		if (recovery === "missing") assert.deepEqual(resumed, []);
		else {
			assert.deepEqual(resumed, start);
			if (recovery === "forced") assert.equal(resumed[0].prompt, "RECORDED_FORCED_PROMPT");
			else {
				assert.match(resumed[0].prompt, /RECOVERY_CONTEXT/u);
				assert.match(resumed[0].prompt, /RECORDED_SECTION/u);
				assert.match(resumed[0].prompt, /RECORDED_SNIPPET/u);
			}
			assert.deepEqual(resumed[0].tools, ["read"]);
		}
		assert.equal(readFileSync(counter, "utf8"), "hook\n");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("worker preserves structured prompt mutations and executable tool selection across runs and reopen", async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-prompt-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_CONTEXT_MARKER");
	const extensionPath = join(root, "prompt-extension.ts");
	writeFileSync(extensionPath, `export default function(pi) {
		let lastPrompt;
		pi.on("before_agent_start", (event, ctx) => {
			if (!event.systemPromptOptions.contextFiles.some(file => file.content.includes("PROJECT_CONTEXT_MARKER"))) throw new Error("Missing structured context");
			lastPrompt = event.prompt;
			event.systemPromptOptions.sections.run_rule = event.prompt;
			event.systemPromptOptions.toolSnippets.read = "HOOK_SNIPPET";
			event.systemPromptOptions.toolGuidelines.read = ["HOOK_GUIDELINE"];
			if (event.prompt === "structured") { pi.setActiveTools(["bash"]); event.systemPromptOptions.selectedTools = ["read", "unknown", "read"]; }
			if (event.prompt === "action") pi.setActiveTools(["bash"]);
			if (event.prompt === "empty") event.systemPromptOptions.selectedTools = [];
			if (event.prompt === "forced") return { systemPrompt: "EXACT_FORCED_PROMPT" };
		});
		pi.on("context", (_event, ctx) => {
			const prompt = ctx.getSystemPrompt();
			if (lastPrompt === "forced" && prompt !== "EXACT_FORCED_PROMPT") throw new Error("Stale forced getter");
			if (lastPrompt !== "forced" && !prompt.includes(lastPrompt)) throw new Error("Stale prompt getter");
		});
	}`);
	const runtime = await createTestRuntime();
	const seen: TranscriptContext[] = [];
	const stream = (_model: unknown, context: TranscriptContext) => {
		seen.push(context);
		const response: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "done" }], api: testModel.api, provider: testModel.provider, model: testModel.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial: response });
		events.push({ type: "done", reason: "stop", message: response });
		events.end(response);
		return events;
	};
	runtime.registerNativeProvider({ id: testModel.provider, name: "Prompt test", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
	const store = new AgentStore({ sessionsRoot: join(root, "sessions") });
	const options = { cwd, agentDir, extensionPaths: [extensionPath], store, modelRuntime: runtime, model: { provider: testModel.provider, modelId: testModel.id }, rootContext: BACKGROUND_CONTEXT };
	let worker = await AgentWorkerSession.create({ ...options, setup: async (session) => {
		session.appendMessage({ role: "system", content: "OLD_PROMPT", toolsAdded: [{ name: "old_tool", description: "Source tool", parameters: { type: "object", properties: {} } }], timestamp: 1 });
		session.appendMessage({ role: "user", content: "Source conversation", timestamp: 2 });
	} });
	try {
		for (const prompt of ["structured", "action", "forced", "restored"]) {
			await worker.start(prompt);
			await worker.waitForIdle();
			assert.equal(worker.lastErrorMessage(), undefined);
			const request = seen.at(-1);
			assert.ok(request);
			assert.doesNotMatch(getCurrentSystemPrompt(request.messages), /OLD_PROMPT/u);
			assert.deepEqual(getCurrentTools(request.messages).map(tool => tool.name), prompt === "structured" ? ["read"] : ["bash"]);
			assert.deepEqual((await worker.status()).activeTools, prompt === "structured" ? ["read"] : ["bash"]);
			if (prompt === "forced") assert.equal(getCurrentSystemPrompt(request.messages), "EXACT_FORCED_PROMPT");
			else {
				assert.match(getCurrentSystemPrompt(request.messages), /PROJECT_CONTEXT_MARKER/u);
				assert.ok(getCurrentSystemPrompt(request.messages).includes(`<run_rule>\n${prompt}\n</run_rule>`));
				assert.doesNotMatch(getCurrentSystemPrompt(request.messages), /EXACT_FORCED_PROMPT/u);
				if (prompt === "structured") {
					assert.match(getCurrentSystemPrompt(request.messages), /HOOK_SNIPPET/u);
					assert.match(getCurrentSystemPrompt(request.messages), /HOOK_GUIDELINE/u);
				}
			}
		}
		const metadata = worker.sessionMetadata();
		await worker.close();
		worker = await AgentWorkerSession.open(metadata, options);
		assert.deepEqual((await worker.status()).activeTools, ["bash"], "reopen preserves the durable tool selection");
		await worker.start("structured");
		await worker.waitForIdle();
		assert.equal(worker.lastErrorMessage(), undefined);
		const structuredRequest = seen.at(-1);
		assert.ok(structuredRequest, "structured prompt reached the provider");
		assert.deepEqual(getCurrentTools(structuredRequest.messages).map(tool => tool.name), ["read"]);
		await worker.start("empty");
		await worker.waitForIdle();
		const emptyRequest = seen.at(-1);
		assert.ok(emptyRequest, "empty tool selection reached the provider");
		assert.deepEqual(getCurrentTools(emptyRequest.messages), []);
		await worker.close();
		worker = await AgentWorkerSession.open(metadata, options);
		assert.deepEqual((await worker.status()).activeTools, [], "reopen does not reactivate disabled tools");
	} finally {
		await worker.close(); await store.close(BACKGROUND_CONTEXT); rmSync(root, { recursive: true, force: true });
	}
});
