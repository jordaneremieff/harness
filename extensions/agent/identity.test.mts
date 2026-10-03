import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { acquireHost, type HostConnection } from "./host-client.ts";
import { fixtureMetadata, readFixtureState } from "./host-fixture.mts";
import { handleStorageId, targetIdentity } from "./identity.ts";
import { AgentManager } from "./manager.ts";

it("isolates the same handle across stores sharing cwd and agent directory", { timeout: 30000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "handle-stores-"));
	const connections: HostConnection[] = [];
	const managers: AgentManager[] = [];
	t.after(async () => {
		await Promise.all(managers.map((manager) => manager.close()));
		await Promise.all(connections.map((connection) => connection.close()));
		for (const connection of connections) { try { process.kill(connection.pid, "SIGKILL"); } catch { /* Already retired. */ } }
		rmSync(root, { recursive: true, force: true });
	});
	const metadata = { ...fixtureMetadata(root), agentDir: join(root, "agent"), packageDir: join(root, "package") };
	mkdirSync(metadata.agentDir, { recursive: true });
	const catalogs = [new AgentCatalog(join(root, "a")), new AgentCatalog(join(root, "b"))];
	const records = catalogs.map((catalog) => catalog.createHandled(metadata, "history", "Read sources").record);
	assert.notEqual(records[0].storageId, records[1].storageId);
	for (const [index, catalog] of catalogs.entries()) {
		const record = records[index];
		assert.equal(handleStorageId("history", `${catalog.root}/.`), record.storageId, "canonical directory aliases share one namespace");
		assert.equal(targetIdentity("@history", catalog.root), record.storageId);
		assert.equal(catalog.createHandled(metadata, "history", "Ignored defaults").record.storageId, record.storageId);
		const manager = new AgentManager({ root: join(root, index === 0 ? "a" : "b"), agentDir: metadata.agentDir, packageDir: metadata.packageDir });
		managers.push(manager);
		assert.equal(await manager.resolveTarget("@history"), record.storageId);
		const connection = await acquireHost(hostMetadata(record), {
			runner: fileURLToPath(new URL("./host-fixture.mts", import.meta.url)),
			env: { ...process.env, PI_AGENT_DIR: metadata.agentDir, PI_AGENT_SESSIONS_DIR: join(root, index === 0 ? "a" : "b") },
		});
		connections.push(connection);
	}
	assert.notEqual(connections[0].pid, connections[1].pid);
	await connections[1].request("configure", { name: "Store B only" });
	assert.equal(readFixtureState(join(catalogs[0].root, "state.json")).effects, undefined);
	assert.equal(readFixtureState(join(catalogs[1].root, "state.json")).effects, 1);
	assert.equal(targetIdentity(records[0].storageId), records[0].storageId);
	assert.throws(() => targetIdentity("@history"), /catalog namespace/u);
});
