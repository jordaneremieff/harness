import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import type { EffortAwareness } from "./effort-awareness.ts";
import { runtimeFixture, waitForReceipt } from "./durable-runtime-fixture.mts";
import { acquireHost, waitForHostRelease, type HostConnection } from "./host-client.ts";
import { installSourceRoutes } from "./source-route.ts";

const sourceRoot = dirname(dirname(fileURLToPath(new URL("./", import.meta.url))));
const claim = (purpose: string) => ({ action: "publish", purpose, integration: "Run the authorised gate", authority: "Synthetic operator authority", scope: { paths: ["extensions/agent"], branches: ["feature/native-intent"], fullGate: true } });
const observer = "native-intent-fixture-observer";
async function run(client: HostConnection, sessionId: string, input: unknown, requestId: string) {
	const admission = await client.request("submit", { sessionId, message: `INTENT_INPUT:${JSON.stringify({ requestId, input })}`, origin: "operator", ownerId: observer, requestId }) as { submissionId: number };
	const receipt = await waitForReceipt(client, observer, admission.submissionId, 10000).catch(async error => {
		const status = await client.request("status", { sessionId });
		throw new Error(`Intent fixture input ${requestId}: ${String(error)}; ${JSON.stringify(status)}`);
	});
	assert.equal(receipt.status, "done");
	await client.request("acknowledge", { ownerId: observer, submissionIds: [admission.submissionId] });
	return admission.submissionId;
}
async function published(client: HostConnection, read: () => boolean): Promise<void> {
	assert.ok(client.subscribeChanges);
	const signal = AbortSignal.timeout(10000);
	let resolve!: () => void, reject!: (error: unknown) => void;
	const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	const abort = () => reject(new Error("Native intent catalogue publication did not arrive"));
	signal.addEventListener("abort", abort, { once: true });
	const stop = await client.subscribeChanges(() => { try { if (read()) resolve(); } catch (error) { reject(error); } }, signal);
	try { await ready; } finally { stop(); signal.removeEventListener("abort", abort); }
}
function providerCalls(directory: string): number {
	const path = join(directory, "session-options.jsonl");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0;
}
function lastToolRecord(directory: string) {
	const line = readFileSync(join(directory, "intent-returns.jsonl"), "utf8").trim().split("\n").at(-1);
	assert.ok(line);
	return JSON.parse(line);
}
function lastToolResult(directory: string): unknown {
	const result = lastToolRecord(directory);
	assert.equal(result.isError, false, JSON.stringify(result));
	const text = typeof result.content === "string" ? result.content : result.content.flatMap((part: { type: string; text?: string }) => part.type === "text" ? [part.text] : []).join("\n");
	return JSON.parse(text);
}
async function awareness(client: HostConnection, directory: string, requestId: string): Promise<EffortAwareness> {
	await run(client, client.storageId, "DISCOVER", requestId);
	const value = lastToolResult(directory) as { awareness: EffortAwareness };
	assert.ok(value.awareness);
	return value.awareness;
}
async function close(client: HostConnection): Promise<void> {
	if (client.closed) return;
	const closing = client.request("close");
	await waitForHostRelease(client.metadata, { after: closing, signal: AbortSignal.timeout(10000) });
	await client.close();
}

test("native intent has a live writer, retained-root peer discovery, exact cwd, persistent clear and no unsolicited peer turn", { timeout: 60000 }, async t => {
	const cleanup: (() => void)[] = [];
	const f = runtimeFixture({ after: fn => cleanup.push(fn) }, { withAgentExtension: true });
	const create = (namespace: string) => {
		const root = join(f.root, namespace), catalog = new AgentCatalog(root);
		const record = catalog.create({ cwd: f.cwd, agentDir: f.agentDir, packageDir: f.metadata.packageDir, model: f.metadata.model, thinkingLevel: "off", trust: true });
		return { root, catalog, record, metadata: hostMetadata(record) };
	};
	const a = create("previous-managed"), b = create("current"), bControl = join(f.root, "peer-control");
	mkdirSync(bControl);
	const aEnv = { ...f.env("intent"), PI_AGENT_IDLE_MINUTES: "2" }, bEnv = { ...aEnv, DURABLE_TEST_DIR: bControl };
	let aClient = await acquireHost(a.metadata, { env: aEnv });
	const bClient = await acquireHost(b.metadata, { env: bEnv });
	t.after(async () => { try { await close(bClient); await close(aClient); } finally { for (const fn of cleanup.reverse()) fn(); } });
	const originalSettings = readFileSync(join(f.agentDir, "settings.json"), "utf8");
	await run(aClient, a.record.storageId, claim("Native gate plan"), "publish-root");
	await published(aClient, () => a.catalog.read(a.record.storageId).view?.intentClaims?.rows[a.record.storageId]?.claim?.purpose === "Native gate plan");
	assert.equal(providerCalls(bControl), 0);
	const saved = a.catalog.read(a.record.storageId).view?.intentClaims?.rows[a.record.storageId]; assert.ok(saved?.claim);
	assert.equal(saved.cwd, f.cwd);
	assert.equal(a.catalog.read(a.record.storageId).view?.rows[0]?.cwd, f.cwd);
	const originalClaim = JSON.stringify(saved.claim);
	const child = await aClient.request("fork", { sessionId: a.record.storageId, name: "native intent child" }) as { identity: string };
	assert.ok(child.identity.startsWith(`${a.record.storageId}:`));
	await run(aClient, child.identity, claim("Child gate plan"), "publish-child");
	await published(aClient, () => a.catalog.read(a.record.storageId).view?.intentClaims?.rows[child.identity]?.claim?.purpose === "Child gate plan");
	await run(aClient, child.identity, { action: "clear", sessionId: a.record.storageId }, "reject-owner-spoof");
	const rejected = lastToolRecord(f.testDir);
	assert.equal(rejected.isError, true);
	assert.equal(JSON.stringify(a.catalog.read(a.record.storageId).view?.intentClaims?.rows[a.record.storageId]?.claim), originalClaim);
	assert.equal(a.catalog.read(a.record.storageId).view?.intentClaims?.rows[child.identity]?.claim?.purpose, "Child gate plan");
	const beforeDiscovery = await aClient.request("inspect", { sessionId: a.record.storageId, view: "history", limit: 50 }) as { entries: unknown[] };
	assert.ok(Array.isArray(beforeDiscovery.entries));
	let view = await awareness(bClient, bControl, "peer-without-route");
	assert.equal(view.presence.efforts.some(row => row.id === a.record.storageId), false);
	await installSourceRoutes(b.root, [{ root: a.root, sourceRoot, packageDir: f.metadata.packageDir }]);
	view = await awareness(bClient, bControl, "peer-with-route");
	assert.deepEqual(view.presence.efforts.find(row => row.id === a.record.storageId)?.intentClaim, saved.claim, JSON.stringify(view));
	assert.equal(view.presence.efforts.find(row => row.id === a.record.storageId)?.liveness, "live");
	assert.equal(view.presence.efforts.find(row => row.id === child.identity)?.intentClaim?.purpose, "Child gate plan");
	const afterDiscovery = await aClient.request("inspect", { sessionId: a.record.storageId, view: "history", limit: 50 }) as { entries: unknown[] };
	assert.deepEqual(afterDiscovery.entries, beforeDiscovery.entries, "peer discovery admits no input to the publisher");
	assert.equal(JSON.stringify(a.catalog.read(a.record.storageId).view?.intentClaims?.rows[a.record.storageId]?.claim), originalClaim);
	let peerCalls = providerCalls(bControl);
	const ownerCalls = providerCalls(f.testDir);
	await close(aClient);
	view = await awareness(bClient, bControl, "peer-after-writer-release");
	assert.equal(view.presence.efforts.some(row => row.id === a.record.storageId || row.id === child.identity), false);
	assert.ok(view.presence.coverage.dead >= 2);
	peerCalls = providerCalls(bControl);
	aClient = await acquireHost(a.metadata, { env: aEnv });
	await published(aClient, () => a.catalog.read(a.record.storageId).view?.intentClaims?.rows[a.record.storageId]?.claim?.purpose === "Native gate plan");
	assert.equal(providerCalls(f.testDir), ownerCalls, "reopen does not submit another model input");
	assert.equal(JSON.stringify(a.catalog.read(a.record.storageId).view?.intentClaims?.rows[a.record.storageId]?.claim), originalClaim);
	await run(aClient, a.record.storageId, { action: "clear" }, "clear-root");
	await published(aClient, () => a.catalog.read(a.record.storageId).view?.intentClaims?.rows[a.record.storageId] === null);
	assert.equal(providerCalls(bControl), peerCalls, "publication and clear do not wake the peer");
	view = await awareness(bClient, bControl, "peer-after-clear");
	assert.equal(view.presence.efforts.some(row => row.id === a.record.storageId), false);
	assert.equal(view.presence.efforts.find(row => row.id === child.identity)?.intentClaim?.purpose, "Child gate plan");
	await run(aClient, child.identity, { action: "clear" }, "clear-child");
	await published(aClient, () => a.catalog.read(a.record.storageId).view?.intentClaims?.rows[child.identity] === null);
	view = await awareness(bClient, bControl, "peer-after-child-clear");
	assert.equal(view.presence.efforts.some(row => row.id === child.identity), false);
	await close(aClient);
	aClient = await acquireHost(a.metadata, { env: aEnv });
	await published(aClient, () => a.catalog.read(a.record.storageId).view?.intentClaims?.rows[a.record.storageId] === null);
	assert.equal(readFileSync(join(f.agentDir, "settings.json"), "utf8"), originalSettings);
});
