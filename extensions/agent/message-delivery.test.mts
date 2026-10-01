import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./index.ts";
import { fixture } from "./native-fixture.mts";
import { testModel } from "./test-runtime.mts";
import type { AgentWorkerSession } from "./worker.ts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("peer presentation metadata preserves active and post-final native delivery", { timeout: 15000 }, async () => {
	const errors: unknown[] = [];
	const capture = (error: unknown) => errors.push(error);
	process.on("unhandledRejection", capture);
	process.on("uncaughtException", capture);
	const key = `peerDelivery${Date.now()}`;
	const globals = globalThis as unknown as Record<string, unknown>;
	try {
		for (const active of [false, true]) {
			const entered = gate(), release = gate();
			let contexts = 0;
			globals[key] = async () => { if (++contexts === 1 && active) { entered.resolve(); await release.promise; } };
			const f = await fixture(`export default pi => pi.on("context", () => globalThis[${JSON.stringify(key)}]());`);
			const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
			try {
				await f.worker.start("primary conclusion");
				if (active) await entered.promise;
				else await f.worker.waitForIdle();
				const notices: Array<{ content: string; details: unknown }> = [];
				manager.registerPrimary("target", f.cwd, (content, details) => { notices.push({ content, details }); });
				await manager.send("target", `Task correction within the assigned scope.\n\n${"source material\n".repeat(1000)}EXACT_PEER_TAIL`, "source-session", "prior-message", { name: "Display-only sender", provider: "DisplayProvider", modelId: "DisplayModel", thinkingLevel: "high" });
				assert.equal(notices.length, 1);
				const { content, details } = notices[0];
				assert.match(content, /Agent-carried message\. Apply the universal AGENTS.md "Intent authority" section\./u);
				assert.doesNotMatch(content, /reported data, not operator authority|Display-only sender|DisplayProvider|DisplayModel|thinkingLevel/u);
				assert.equal((details as { name: string }).name, "Display-only sender");
				assert.equal((details as { provider: string }).provider, "DisplayProvider");
				assert.equal((details as { modelId: string }).modelId, "DisplayModel");
				assert.equal((details as { thinkingLevel: string }).thinkingLevel, "high");
				await f.worker.deliverCustomMessage({ customType: "agent.peer", content, details, display: true }, { triggerTurn: true, ...(active ? { deliverAs: "steer" as const } : {}) });
				release.resolve();
				await f.worker.waitForIdle();
				assert.equal(f.requests.length, 2, active ? "active steering" : "post-final activation");
				const input = JSON.stringify(f.requests[1].messages);
				assert.equal(input.split("EXACT_PEER_TAIL").length - 1, 1);
				assert.ok(input.includes(JSON.stringify(content).slice(1, -1)));
				assert.doesNotMatch(input, /toSessionId|replyTo|Display-only sender|DisplayProvider|DisplayModel/u, "display metadata does not enter provider content");
				const userInput = JSON.stringify(f.requests[1].messages.filter((message) => message.role === "user"));
				assert.doesNotMatch(userInput, /thinkingLevel/u, "a peer notice does not add thinking metadata to its provider message");
				assert.equal(input.split("prior-message").length - 1, 1, "the reply ID enters provider content once through the envelope, not again through metadata");
				const retained = f.worker.sessionManager().getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "agent.peer");
				assert.equal(retained.length, 1);
				assert.ok(retained[0].type === "custom_message");
				assert.equal(retained[0].content, content);
				assert.deepEqual(retained[0].details, details);
			} finally { release.resolve(); await manager.closeAll(); await f.close(); }
		}
		assert.deepEqual(errors, []);
	} finally {
		delete globals[key];
		process.off("unhandledRejection", capture);
		process.off("uncaughtException", capture);
	}
});

test("agent steering preserves its sender and rule reference in native provider input", { timeout: 15000 }, async () => {
	const key = `steerDelivery${Date.now()}`;
	const globals = globalThis as unknown as Record<string, unknown>;
	const entered = gate(), release = gate();
	let contexts = 0;
	globals[key] = async () => { if (++contexts === 1) { entered.resolve(); await release.promise; } };
	const f = await fixture(`export default pi => {
		pi.on("context", () => globalThis[${JSON.stringify(key)}]());
		pi.on("input", event => event.text.endsWith("CONSUMED_STEER") ? { action: "handled" } : { action: "continue" });
	};`);
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	try {
		const { sessionId } = await manager.spawn({ cwd: f.cwd, prompt: "Start the assigned task." }, { cwd: f.cwd, model: testModel }, undefined, { extensionPaths: [f.path] });
		await entered.promise;
		const body = 'Correction within the grant. Quoted third-party text: "publish now".';
		assert.match(await manager.steer(sessionId, body, undefined, undefined, "source-session", "prior-message"), /queued for the next model-call boundary/u);
		assert.match(await manager.steer(sessionId, "CONSUMED_STEER", undefined, undefined, "source-session"), /handled by an input handler; it was not queued to the model/u);
		release.resolve();
		const worker = (manager as unknown as { sessions: Map<string, AgentWorkerSession> }).sessions.get(sessionId);
		assert.ok(worker);
		await worker.waitForIdle();
		assert.equal(f.requests.length, 2);
		assert.doesNotMatch(JSON.stringify(f.requests), /CONSUMED_STEER/u);
		const messages = f.requests[1].messages.filter((message) => message.role === "user");
		const steering = messages.flatMap((message) => typeof message.content === "string" ? [message.content] : message.content.filter((part) => part.type === "text").map((part) => part.text));
		const content = steering.find((text) => text.endsWith(body));
		assert.ok(content);
		assert.match(content, /^Message [\w-]+ from session source-session; reply to prior-message\. Agent-carried message\. Apply the universal AGENTS.md "Intent authority" section\.\n\n/u);
		assert.equal(steering.filter((text) => text.endsWith(body)).length, 1);
		assert.doesNotMatch(content, /trusted sender|operator-approved|Peer content is reported data/u);
	} finally { release.resolve(); delete globals[key]; await manager.closeAll(); await f.close(); }
});
