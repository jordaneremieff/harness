import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT, reduceLaneSnapshot, withAbortSignal, type LaneSnapshot } from "@earendil-works/pi-agent-core";
import { ModelRuntime, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { DetachedRuns } from "./detached.ts";
import { AgentManager } from "./index.ts";
import { planRewind } from "./rewind.ts";
import { AgentStore } from "./store.ts";
import { AgentWorkerSession } from "./worker.ts";

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 90000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = (): void => {
			void Promise.resolve(predicate()).then((done) => {
				if (done) return resolve();
				if (Date.now() - start > timeoutMs) return reject(new Error("live condition not met within timeout"));
				setTimeout(tick, 25);
			});
		};
		tick();
	});
}

describe("agent live lane observer", () => {
	it("streams real model events through watch+reduceLaneSnapshot and advances the tip", { skip: process.env.PI_AGENT_LIVE !== "1", timeout: 90000 }, async () => {
		const base = mkdtempSync(join(tmpdir(), "agent-live-"));
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot: join(base, "sessions") });
		const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
		const abort = new AbortController();
		const context = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
		const worker = await AgentWorkerSession.create({
			cwd,
			agentDir,
			model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
			extensionPaths: [],
			store,
			modelRuntime,
			rootContext: context,
		});
		try {
			const observer = await worker.observeLane();
			let folded = observer.snapshot as LaneSnapshot;
			const events: string[] = [];
			const seenTypes = new Set<string>();
			observer.subscribe((event) => {
				events.push(String((event as { type: string }).type));
				seenTypes.add(String((event as { type: string }).type));
				const reduction = reduceLaneSnapshot(folded, event as never);
				if (reduction === "rebase") {
					void observer.resnapshot().then((snapshot) => {
						folded = snapshot;
					});
				}
			});
			await worker.start("Reply with exactly LIVEOK.");
			await waitFor(async () => {
				return events.some((type) => type === "run_end") && folded.tipId !== null;
			});
			assert.ok(events.length >= 5, `raw events streamed (${events.length})`);
			assert.ok(seenTypes.has("message_start") && seenTypes.has("message_end"), "model message events observed");
			assert.ok(folded.tipId, "folded snapshot advanced to a real tip");
			const assistant = folded.transcript.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
			assert.ok(assistant?.type === "message" && assistant.message.role === "assistant");
			assert.equal(assistant.message.stopReason, "stop");
			assert.equal(assistant.message.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim(), "LIVEOK");
		} finally {
			await worker.close();
			await store.close(context);
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("agent live detached run", () => {
	it("finishes in its own process after the launcher releases the session", { skip: process.env.PI_AGENT_LIVE !== "1", timeout: 120000 }, async () => {
		const base = mkdtempSync(join(tmpdir(), "agent-live-detached-"));
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		const sessionsRoot = join(base, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot });
		const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
		const abort = new AbortController();
		const context = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
		const manager = new AgentManager(store, modelRuntime, new ProjectTrustStore(agentDir), abort, agentDir);
		try {
			const created = await manager.spawn({ cwd, model: "deepseek/deepseek-v4-flash" }, { cwd, model: null });
			const { runId } = await manager.detach({ sessionId: created.sessionId, prompt: "Reply with exactly LIVEOK." }, { cwd, model: null });
			assert.ok(runId, "the launcher reports the run id");
			const runs = new DetachedRuns(sessionsRoot);
			await waitFor(() => {
				const state = runs.get(runId)?.state;
				return state === "finished" || state === "failed" || state === "abandoned";
			}, 120000);
			const run = runs.get(runId);
			assert.equal(run?.state, "finished", run?.error);
			assert.match(run?.summary ?? "", /LIVEOK/u);
			const reopened = await manager.sessionEntries(created.sessionId);
			assert.ok(
				reopened.some((entry) => entry.type === "message" && entry.message.role === "assistant"),
				"the durable session carries the detached run's work",
			);
		} finally {
			await manager.closeAll();
			await store.close(context);
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("agent live rewind", () => {
	it("re-derives the work after the rewind point under the corrected decision", { skip: process.env.PI_AGENT_LIVE !== "1", timeout: 180000 }, async () => {
		const base = mkdtempSync(join(tmpdir(), "agent-live-rewind-"));
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot: join(base, "sessions") });
		const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
		const abort = new AbortController();
		const context = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
		const manager = new AgentManager(store, modelRuntime, new ProjectTrustStore(agentDir), abort, agentDir);
		try {
			const created = await manager.spawn(
				{ cwd, model: "deepseek/deepseek-v4-flash", prompt: "Name one fruit. Reply with the single word." },
				{ cwd, model: null },
			);
			await waitFor(async () => (await manager.sessionEntries(created.sessionId)).some((entry) => entry.type === "message" && entry.message.role === "assistant"), 120000);
			const entries = await manager.sessionEntries(created.sessionId);
			const wrong = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
			assert.ok(wrong);
			const plan = planRewind(entries, wrong.id, "Name one vegetable instead. Reply with the single word.");
			assert.equal(plan.retainedIntent.length, 0);
			const rewound = await manager.rewind(created.sessionId, wrong.id, "Name one vegetable instead. Reply with the single word.");
			assert.match(rewound.text, /rewound/u);
			await waitFor(async () => (await manager.sessionEntries(rewound.sessionId)).some((entry) => entry.type === "message" && entry.message.role === "assistant"), 120000);
			const forkEntries = await manager.sessionEntries(rewound.sessionId);
			assert.ok(
				!forkEntries.some((entry) => entry.id === wrong.id),
				"the fork drops the entry that carried the wrong decision",
			);
			assert.ok(
				forkEntries.some((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("Corrected decision")),
				"the fork receives the correction as its instruction",
			);
			const sourceEntries = await manager.sessionEntries(created.sessionId);
			assert.ok(sourceEntries.some((entry) => entry.id === wrong.id), "the source session keeps its transcript");
		} finally {
			await manager.closeAll();
			await store.close(context);
			rmSync(base, { recursive: true, force: true });
		}
	});
});
