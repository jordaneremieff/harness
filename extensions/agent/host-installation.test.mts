import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { hostMetadata } from "./catalog.ts";
import { runtimeFixture, trackHost } from "./durable-runtime-fixture.mts";
import { acquireHost, type HostConnection } from "./host-client.ts";
import { AgentManager } from "./manager.ts";

it("starts a retained host with the caller installation and attaches from another installation", { timeout: 60000 }, async (t) => {
	const f = runtimeFixture(t);
	const packageDir = getPackageDir();
	let launched: HostConnection | undefined;
	const manager = new AgentManager({
		root: f.root, agentDir: f.agentDir, packageDir,
		acquire: async (metadata, options) => {
			assert.equal(metadata.packageDir, packageDir);
			launched = await acquireHost(metadata, { ...options, env: {
				...f.env("answer"), PI_AGENT_DIR: f.agentDir, PI_AGENT_SESSIONS_DIR: f.root,
			} });
			trackHost(t, launched.pid);
			return launched;
		},
	});
	t.after(() => manager.close());
	const record = manager.catalog.create({
		cwd: f.cwd, agentDir: f.agentDir, packageDir: join(f.root, "removed-installation"),
		model: f.metadata.model, thinkingLevel: "off", trust: true, ownerId: f.ownerId,
	});
	assert.equal(existsSync(record.packageDir), false);
	const attached = await manager.control("attach", { sessionId: record.storageId }, { id: f.ownerId, cwd: f.cwd }) as { sessionId: string };
	assert.equal(attached.sessionId, record.storageId);
	assert.ok(launched);
	assert.ok(launched.pid > 0);
	assert.deepEqual(hostMetadata(manager.catalog.read(record.storageId)), hostMetadata(record), "startup retains creation metadata");

	const otherPackageDir = join(f.root, "other-installation");
	let peer: HostConnection | undefined;
	const other = new AgentManager({
		root: f.root, agentDir: f.agentDir, packageDir: otherPackageDir,
		acquire: async (metadata, options) => {
			assert.equal(metadata.packageDir, otherPackageDir);
			peer = await acquireHost(metadata, options);
			return peer;
		},
	});
	t.after(() => other.close());
	const reused = await other.control("attach", { sessionId: record.storageId }, { id: "another-primary", cwd: f.cwd }) as { sessionId: string };
	assert.equal(reused.sessionId, record.storageId);
	assert.ok(peer);
	assert.equal(peer.pid, launched.pid, "a different caller installation never replaces the live writer");
	assert.equal(peer.metadata.packageDir, otherPackageDir, "a future link recovery retains this caller installation");
	assert.deepEqual(hostMetadata(manager.catalog.read(record.storageId)), hostMetadata(record));
});
