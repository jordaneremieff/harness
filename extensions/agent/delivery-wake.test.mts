import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { AgentCatalog } from "./catalog.ts";
import { DELIVERY_WAKE_RECIPIENT_LIMIT, deliveryWakePath, readDeliveryWake, writeDeliveryWake } from "./delivery-wake.ts";

function root(t: TestContext): string {
	const path = mkdtempSync(join(tmpdir(), "delivery-wake-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

it("writes only changed parked sets and removes an empty projection", t => {
	const path = root(t), source = randomUUID(), owner = randomUUID(), native = `${randomUUID()}:7`;
	assert.deepEqual(writeDeliveryWake(path, source, [owner, native, owner]), { changed: true, omitted: 0 });
	const before = statSync(deliveryWakePath(path, source));
	assert.equal(before.mode & 0o777, 0o600);
	assert.deepEqual(readDeliveryWake(path, source)?.recipients, [owner, native].sort());
	assert.deepEqual(writeDeliveryWake(path, source, [native, owner]), { changed: false, omitted: 0 });
	assert.equal(statSync(deliveryWakePath(path, source)).ino, before.ino);
	assert.equal(writeDeliveryWake(path, source, [native]).changed, true);
	assert.equal(writeDeliveryWake(path, source, []).changed, true);
	assert.equal(existsSync(deliveryWakePath(path, source)), false);
	assert.equal(writeDeliveryWake(path, source, []).changed, false);
});

it("bounds exact recipients and records every omitted identity", t => {
	const path = root(t), source = randomUUID(), owners = Array.from({ length: DELIVERY_WAKE_RECIPIENT_LIMIT + 2 }, () => randomUUID());
	const result = writeDeliveryWake(path, source, owners);
	const wake = readDeliveryWake(path, source);
	assert.equal(result.omitted, 2);
	assert.equal(wake?.recipients.length, DELIVERY_WAKE_RECIPIENT_LIMIT);
	assert.equal(wake?.omitted, 2);
	assert.deepEqual(wake?.recipients, owners.sort().slice(0, DELIVERY_WAKE_RECIPIENT_LIMIT));
});

it("keeps sidecars outside current catalogue scans and schema", async t => {
	const path = root(t), catalog = new AgentCatalog(path);
	const source = catalog.create({ cwd: path, agentDir: join(path, "agent"), packageDir: join(path, "package"), model: { provider: "fixture", modelId: "model" }, thinkingLevel: "off" });
	const before = await catalog.page();
	writeDeliveryWake(path, source.storageId, [randomUUID()]);
	const after = await catalog.page();
	assert.deepEqual(after.records, before.records);
	assert.deepEqual(after.coverage, before.coverage);
	assert.deepEqual(catalog.read(source.storageId), source);
});

it("refuses malformed, oversized and non-exact wake metadata", t => {
	const path = root(t), source = randomUUID();
	writeDeliveryWake(path, source, [randomUUID()]);
	const file = deliveryWakePath(path, source);
	writeFileSync(file, JSON.stringify({ format: "agent.delivery-wake/1", recipients: ["12345678"], omitted: 0 }));
	assert.throws(() => readDeliveryWake(path, source), /identity/u);
	writeFileSync(file, "x".repeat(32769));
	assert.throws(() => readDeliveryWake(path, source), /bounded regular file/u);
	assert.throws(() => deliveryWakePath(path, `${source}:7`), /exact storage/u);
});
