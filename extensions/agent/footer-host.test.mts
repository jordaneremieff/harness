import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./index.ts";
import { AgentStore } from "./store.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

// A real provider stream holds execution until the test supplies the final response.
test("manager publishes activity and price to every primary through settlement, forks, errors, and shutdown", async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-footer-host-"));
	const cwd = join(root, "work"); const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" }, retry: { enabled: false } }));
	const runtime = await createTestRuntime();
	const pending: Array<(cost: number, error?: boolean) => void> = [];
	let changed = () => {};
	const stream = () => {
		const output = createAssistantMessageEventStream();
		pending.push((cost, error) => {
			const response: AssistantMessage = { role: "assistant", api: testModel.api, provider: testModel.provider, model: testModel.id, content: [{ type: "text", text: "DONE" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }, stopReason: error ? "error" : "stop", ...(error ? { errorMessage: "controlled failure" } : {}), timestamp: Date.now() };
			output.push({ type: "start", partial: response });
			if (error) output.push({ type: "error", reason: "error", error: response });
			else output.push({ type: "done", reason: "stop", message: response });
			output.end(response);
		});
		changed();
		return output;
	};
	runtime.registerNativeProvider({ id: testModel.provider, name: "Footer test", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
	const store = new AgentStore({ sessionsRoot: join(root, "sessions") });
	const manager = new AgentManager(store, runtime, new ProjectTrustStore(agentDir), undefined, agentDir);
	const statuses: Array<string | undefined> = []; const mirror: Array<string | undefined> = [];
	const waitFor = async (predicate: () => boolean) => {
		while (!predicate()) await new Promise<void>((resolve) => { changed = resolve; });
	};
	manager.registerPrimary("first", cwd, () => {}, (text) => { statuses.push(text); changed(); });
	manager.registerPrimary("second", cwd, () => {}, (text) => mirror.push(text));
	try {
		const first = await manager.spawn({}, { cwd, model: { provider: testModel.provider, id: testModel.id } });
		assert.match(statuses.at(-1) ?? "", /agents: 0 active · \$0.00 local · subs 0\+\?\/\$0.00\+\?/u);
		await manager.send(first.sessionId, "one");
		assert.match(statuses.at(-1) ?? "", /agents: 1 active/u);
		await waitFor(() => pending.length === 1);
		pending.shift()?.(0.25);
		await waitFor(() => /agents: 0 active · \$0.25/u.test(statuses.at(-1) ?? ""));
		const fork = await manager.fork(first.sessionId);
		assert.match(statuses.at(-1) ?? "", /\$0.25 local/u, "fork history is not charged twice");
		await manager.send(fork.sessionId, "two");
		await waitFor(() => pending.length === 1);
		pending.shift()?.(0.125, true);
		await waitFor(() => /agents: 0 active · \$0.38/u.test(statuses.at(-1) ?? ""));
		assert.equal(statuses.at(-1), mirror.at(-1));
		await manager.unregisterPrimary("first");
		assert.equal(statuses.at(-1), undefined);
		assert.match(mirror.at(-1) ?? "", /\$0.38/u, "another primary retains the manager");
		await manager.unregisterPrimary("second");
		assert.equal(mirror.at(-1), undefined);
	} finally { await manager.closeAll(); await store.close(); rmSync(root, { recursive: true, force: true }); }
});
