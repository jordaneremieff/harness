import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Value } from "typebox/value";
import { AgentManager } from "./manager.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRuntime, fixtureRegistry, hostOptions } from "./durable-host-fixture.mts";
import { disposeColdStorage } from "./cold-observation.ts";
import { AgentProfileSchema, type AgentProfile } from "./profile-schema.ts";
import { hostPaths } from "./host-protocol.ts";

it("a cold profile read returns retained native expertise without host acquisition or a model turn", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "profile-cold-"));
	let acquisitions = 0;
	const manager = new AgentManager({ root, agentDir: join(root, "agent"), packageDir: root,
		connect: async () => { throw new Error("no live host"); },
		acquire: async () => { acquisitions++; throw new Error("a profile read must not start a host"); },
	});
	const record = manager.catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: root, model: { provider: "fixture", modelId: "fixture" }, thinkingLevel: "off" });
	t.after(async () => { await manager.close(); await disposeColdStorage(record.storagePath); rmSync(root, { recursive: true, force: true }); });
	const host = await DurableHost.open({ ...hostOptions(record.storagePath, await fixtureRuntime("answer"), fixtureRegistry(), root), storageId: record.storageId, profileSeed: { handle: "history", role: "Review decisions" } });
	try {
		const initial = await host.request("profile-read", { sessionId: record.storageId }) as AgentProfile;
		await host.request("profile-update", { sessionId: record.storageId, expectedRevision: initial.revision, expertise: "Sources: reference.md, checked 2026-01-01", requestId: "knowledge", senderIdentity: "author" });
	} finally { await host.close(); }
	const result = await manager.control("profile-read", { sessionId: record.storageId }, { id: "reader", cwd: root });
	assert.ok(Value.Check(AgentProfileSchema, result));
	assert.equal(result.live, false);
	assert.equal(result.handle, "@history");
	assert.equal(result.role, "Review decisions");
	assert.equal(result.expertise, "Sources: reference.md, checked 2026-01-01");
	assert.equal(acquisitions, 0);
	assert.equal(existsSync(hostPaths(record).socket), false);
	const snapshot = await manager.snapshot(record.storageId);
	assert.equal(snapshot.entries.some((entry) => entry.kind === "pi.assistant"), false);
});
