import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./index.ts";
import { fixture } from "./native-fixture.mts";
import { DetachedRuns } from "./detached.ts";
import { createDetachedControlServer, withDetachedControl } from "./detached-control.ts";

for (const action of ["abort", "compact", "command"]) {
	test(`the registered ${action} tool rejects its own session without an idle wait cycle`, { timeout: 15000 }, () => {
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
			import assert from "node:assert/strict";
			import { writeFileSync } from "node:fs";
			import { fixture } from ${JSON.stringify(new URL("./native-fixture.mts", import.meta.url).href)};
			import { AgentManager } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
			import { testModel } from ${JSON.stringify(new URL("./test-runtime.mts", import.meta.url).href)};
			import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
			import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
			const f = await fixture();
			await f.worker.close();
			process.env.PI_AGENT_DIR = f.agentDir;
			process.env.PI_AGENT_SESSIONS_DIR = f.store.root;
			const extensionPath = f.path + ".controls.ts";
			writeFileSync(extensionPath, 'import register from ' + ${JSON.stringify(JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url))))} + '; export default pi => { register(pi); pi.registerCommand("replace-self", {handler: async (_args, ctx) => { await ctx.newSession(); }}); };');
			let self = "", calls = 0;
			const stream = () => {
				calls++;
				assert.ok(calls <= 2);
				const first = calls === 1;
				const message = { role: "assistant", api: testModel.api, provider: testModel.provider, model: testModel.id,
					content: first ? [{type: "toolCall", id: "self-control", name: ${JSON.stringify(`agent_${action}`)}, arguments: {sessionId: self, ${action === "command" ? 'name: "replace-self"' : ""}}}] : [{type: "text", text: "Control refused"}],
					stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
					usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}} };
				const events = createAssistantMessageEventStream();
				events.push({type: "start", partial: message}); events.push({type: "done", reason: message.stopReason, message}); events.end(message); return events;
			};
			f.runtime.registerNativeProvider({...f.runtime.getRegisteredNativeProvider(testModel.provider), stream, streamSimple: stream});
			const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
			try {
				self = (await manager.spawn({cwd: f.cwd}, {cwd: f.cwd, model: testModel}, undefined, {extensionPaths: [extensionPath]})).sessionId;
				const worker = manager.sessions.get(self);
				await manager.send(self, "Exercise self control");
				await worker.waitForIdle();
				const results = worker.sessionManager().getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult");
				assert.equal(results.length, 1);
				assert.equal(results[0].message.isError, true);
				assert.match(JSON.stringify(results[0].message.content), /cannot target their calling session/);
				assert.equal(calls, 2);
				assert.equal(worker.sessionId(), self);
				assert.equal(manager.controls.size, 0);
			} finally { await manager.closeAll(); await f.close(); }
			console.log("self-control-refused");
		`], { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 12000, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 32768 });
		assert.equal(child.status, 0, JSON.stringify({ error: child.error?.message, signal: child.signal, stdout: child.stdout, stderr: child.stderr }));
		assert.match(child.stdout, /self-control-refused/u);
	});
}

test("owner-wait guards resolve detached route aliases before control admission", { timeout: 10000 }, async () => {
	const f = await fixture(`export default pi => pi.registerCommand("replace", { handler: async (_args, ctx) => ctx.newSession() });`);
	const runs = new DetachedRuns(f.store.root);
	const route = f.worker.sessionId();
	const runId = randomUUID();
	const request = { runId, sessionId: route, sessionsRoot: f.store.root, agentDir: f.agentDir, cwd: f.cwd, prompt: "work", logFile: runs.logFile(runId), startedAt: new Date().toISOString(), pid: process.pid, launchState: "started" as const };
	runs.writeRequest(request);
	f.worker.setOnUpdate((update) => {
		if (update.kind === "replaced") runs.writeProgress({ runId, currentSessionId: update.sessionId, entryCount: 0, updatedAt: new Date().toISOString() });
	});
	const server = await createDetachedControlServer({ request, metadata: f.worker.sessionMetadata(), worker: f.worker, canSteer: () => true, requestAbort: () => f.worker.abort() });
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	try {
		await withDetachedControl(request, (client) => client.command("replace", ""));
		const current = f.worker.sessionId();
		assert.notEqual(current, route);
		for (const id of [route, current]) {
			await assert.rejects(manager.abort(id, undefined, current), /cannot target their calling session/u);
			await assert.rejects(manager.compact(id, undefined, undefined, current), /cannot target their calling session/u);
			await assert.rejects(manager.runCommand(id, "replace", "", undefined, current), /cannot target their calling session/u);
		}
		assert.equal(f.worker.sessionId(), current);
		assert.match(await manager.abort(route, undefined, randomUUID()), /no active operation/u);
		assert.equal(f.requests.length, 0);
	} finally { await manager.closeAll(); await server.close(); await f.close(); }
});
