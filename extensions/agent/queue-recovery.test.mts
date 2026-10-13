import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { acquireHost, waitForHostRelease, type HostConnection } from "./host-client.ts";
import type { HostMetadata } from "./host-protocol.ts";
import type { AgentProfile } from "./profile-schema.ts";
import type { DeliveryReceipt } from "./durable-controls.ts";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
type Receipts = { receipts: DeliveryReceipt[]; pending: number };

it("recovers every native input without profile routes above the explicit-route admission limit", { timeout: 60000 }, async (t) => {
	const scratch = process.env.PROFILE_TEST_ROOT ?? tmpdir();
	mkdirSync(scratch, { recursive: true });
	const root = mkdtempSync(join(scratch, "queue-recovery-"));
	const metadata: HostMetadata = {
		storageId: randomUUID(), storagePath: join(root, "storage.sqlite"), cwd: root, agentDir: join(root, "agent"), packageDir: checkout,
		model: { provider: "agent-test", modelId: "model" }, thinkingLevel: "off", ownerId: "base-owner",
	};
	mkdirSync(metadata.agentDir);
	const keepAlive = createServer();
	let client: HostConnection | undefined;
	const stop = async () => {
		const current = client;
		client = undefined;
		if (!current) return;
		const released = waitForHostRelease(metadata);
		process.kill(current.pid, "SIGKILL");
		await released;
		await current.close();
	};
	t.after(async () => {
		try { await stop(); }
		finally {
			if (keepAlive.listening) await new Promise<void>((resolve) => keepAlive.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	});
	await new Promise<void>((resolve, reject) => { keepAlive.once("error", reject); keepAlive.listen(0, "127.0.0.1", resolve); });
	const messages = Array.from({ length: 129 }, (_, index) => `Retained base task ${index}`);
	const requestIds = messages.map((_, index) => index === messages.length - 1 ? "r".repeat(1025) : `queued-${index}`);
	const launch = (source: string, seed?: { messages: string[]; requestIds: string[] }) => acquireHost(metadata, {
		runner: fileURLToPath(new URL("./queue-recovery-runner.mts", import.meta.url)), runnerArgs: [source, JSON.stringify(seed ?? null)],
		env: { ...process.env, NODE_PATH: join(checkout, "node_modules"), PI_AGENT_DIR: metadata.agentDir, PI_AGENT_SESSIONS_DIR: join(root, "sessions"), PI_AGENT_IDLE_MINUTES: "0" },
	});
	client = await launch(fileURLToPath(new URL("./", import.meta.url)), { messages, requestIds });
	assert.equal(client.runtimeContract.operations["profile-read"].request, "profile-read/1.0.0");
	await assert.rejects(client.request("task-submit", { sessionId: metadata.storageId, requestId: "x".repeat(1025), requester: metadata.ownerId, origin: "operator", message: "Oversized explicit route", whenBusy: "followUp" }), /requestId/u);
	const seeded = JSON.parse(readFileSync(`${metadata.storagePath}.seed.json`, "utf8")) as Receipts;
	assert.equal(seeded.pending, messages.length, "native admission retains every input without an explicit profile route");
	await stop();
	client = await launch(fileURLToPath(new URL("./", import.meta.url)));
	assert.equal((await client.request("receipts", { ownerId: metadata.ownerId, wait: false }) as Receipts).pending, messages.length);
	const profile = await client.request("profile-read", { sessionId: metadata.storageId }) as AgentProfile;
	assert.equal(profile.requests.length, 128);
	assert.equal(profile.requestsOmitted, 1);
	assert.ok(profile.requests.every((route) => route.requester === metadata.ownerId && route.replyTo === metadata.ownerId));
	const changed = await client.request("profile-update", { sessionId: metadata.storageId, expectedRevision: profile.revision, requestId: "update-while-queued", senderIdentity: metadata.ownerId, role: "Retained queue worker" }) as { outcome: string };
	assert.equal(changed.outcome, "applied", "live mutation remains available while retained work exceeds the projection");
	const drained = await client.request("command", { sessionId: metadata.storageId, name: "drain" }) as { delivery: Receipts; seen: string[] };
	assert.equal(drained.delivery.pending, 0);
	assert.equal(drained.delivery.receipts.length, messages.length);
	assert.deepEqual(new Set(drained.delivery.receipts.map((receipt) => receipt.requestId)), new Set(requestIds));
	assert.ok(drained.delivery.receipts.every((receipt) => receipt.status === "done" && receipt.answer === "Recovered answer"));
	for (const message of messages) assert.ok(drained.seen.includes(message), `The resumed model did not receive ${message}`);
	const settled = await client.request("profile-read", { sessionId: metadata.storageId }) as AgentProfile;
	assert.deepEqual(settled.requests, []);
	assert.equal(settled.requestsOmitted ?? 0, 0);
});
