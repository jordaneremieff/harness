import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProjectTrustStore, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ASSOCIATION_ENTRY, type AssociationEntry } from "./associations.ts";
import { AgentManager } from "./index.ts";
import { fixture } from "./native-fixture.mts";
import { AgentWorkerSession } from "./worker.ts";

const storedTarget = async (options: Parameters<typeof AgentWorkerSession.create>[0]): Promise<string> => {
	const worker = await AgentWorkerSession.create(options);
	const sessionId = worker.sessionId();
	await worker.close();
	return sessionId;
};

const associationEntry = (value: AssociationEntry): SessionEntry =>
	({ type: "custom", customType: ASSOCIATION_ENTRY, data: value }) as unknown as SessionEntry;

const attachedFlags = (history: SessionEntry[]): boolean[] =>
	history.map((entry) => {
		if (entry.type !== "custom") throw new Error(`expected a custom entry, received ${entry.type}`);
		return (entry.data as AssociationEntry).attached;
	});

const openedWorker = (manager: AgentManager, sessionId: string): AgentWorkerSession | undefined =>
	(manager as unknown as { sessions: Map<string, AgentWorkerSession> }).sessions.get(sessionId);

const managerFor = async (f: Awaited<ReturnType<typeof fixture>>): Promise<AgentManager> =>
	new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);

describe("idle steer refusal", () => {
	it("refuses an idle stored session and leaves the manager able to wake it with send", { timeout: 20000 }, async () => {
		const f = await fixture();
		const targetId = await storedTarget(f.options);
		const manager = await managerFor(f);
		try {
			await assert.rejects(manager.steer(targetId, "idle steer"), /requires an active session.*agent send/u);
			assert.equal(openedWorker(manager, targetId), undefined);
			assert.match(await manager.send(targetId, "wake"), /prompt admitted|input handler/u);
			const worker = openedWorker(manager, targetId);
			assert.ok(worker);
			await worker.waitForIdle();
			assert.equal(f.requests.length, 1, "the wake turn reached the model");
		} finally { await manager.closeAll(); await f.close(); }
	});

	it("keeps an already held worker open across active and idle steer", { timeout: 20000 }, async () => {
		const f = await fixture();
		const targetId = await storedTarget(f.options);
		const manager = await managerFor(f);
		try {
			await manager.send(targetId, "wake");
			const worker = openedWorker(manager, targetId);
			assert.ok(worker);
			assert.match(await manager.steer(targetId, "active steer"), /steering message queued/u);
			await worker.waitForIdle();
			assert.match(await manager.steer(targetId, "held idle steer"), /steering message queued/u);
			assert.equal(openedWorker(manager, targetId), worker, "the held worker is not replaced or closed");
			assert.ok(await worker.status(), "the held worker still answers status");
		} finally { await manager.closeAll(); await f.close(); }
	});

	it("detaches only the parent edge the refused open created", { timeout: 20000 }, async () => {
		const f = await fixture();
		const targetId = await storedTarget(f.options);
		const manager = await managerFor(f);
		try {
			const fresh: SessionEntry[] = [];
			manager.bindAssociationParent({
				sessionId: "parent-fresh",
				entries: () => fresh,
				append: (entry) => { fresh.push(associationEntry(entry)); },
			});
			await assert.rejects(
				manager.withAssociationParent("parent-fresh", () => manager.steer(targetId, "steer")),
				/requires an active session/u,
			);
			assert.deepEqual(attachedFlags(fresh), [true, false], "the new edge is attached then detached");
			assert.equal(openedWorker(manager, targetId), undefined);

			const seeded: SessionEntry[] = [associationEntry({ version: 1, parentSessionId: "parent-existing", storeRoot: f.store.root, childSessionId: targetId, attached: true })];
			const seedCount = seeded.length;
			manager.bindAssociationParent({ sessionId: "parent-existing", entries: () => seeded, append: (entry) => { seeded.push(associationEntry(entry)); } });
			await assert.rejects(
				manager.withAssociationParent("parent-existing", () => manager.steer(targetId, "steer")),
				/requires an active session/u,
			);
			assert.equal(seeded.length, seedCount, "a pre-existing edge is preserved");
			assert.equal(openedWorker(manager, targetId), undefined);
		} finally { await manager.closeAll(); await f.close(); }
	});
});
