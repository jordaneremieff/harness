import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentCatalog } from "./catalog.ts";
import type { CollaborationSummary } from "./collaboration.ts";
import { discoverCollaboration, readRecentCollaboration, RECENT_COLLABORATION_LIMITS } from "./collaboration-discovery.ts";

function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "recent-collaboration-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const catalog = new AgentCatalog(root);
	mkdirSync(catalog.root, { recursive: true });
	const input = { cwd: root, agentDir: root, packageDir: root, model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off", ownerId: "owner" };
	return { root, catalog, input };
}
function publish(catalog: AgentCatalog, input: Parameters<AgentCatalog["create"]>[0], updates: number[], omitted = 0, closed = false, text = "thread"): CollaborationSummary[] {
	const record = catalog.create(input);
	const items = updates.map((updatedAt, index) => ({ id: `${record.storageId}/${index.toString(16).padStart(32, "0")}`, title: text, purpose: text, updatedAt, closed, members: 1 }));
	catalog.updateView(record.storageId, { updatedAt: "2026-10-04T10:00:00.000Z", storageId: record.storageId, rows: [], coverage: { complete: true, omitted: 0 } }, { items, omitted, updatedAt: "2026-10-04T10:00:00.000Z" });
	return items;
}

it("collects active threads across storage records newest-first with stable tie order", async (t) => {
	const { catalog, input } = fixture(t);
	const a = publish(catalog, input, [10, 40, 30]);
	const b = publish(catalog, input, [20, 40]);
	publish(catalog, input, [100], 0, true);
	const page = await readRecentCollaboration(catalog);
	const expected = [...a, ...b].sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : 1));
	assert.deepEqual(page.items, expected);
	assert.equal(page.coverage.complete, true);
	assert.equal(page.coverage.records, 3);
	assert.deepEqual(await readRecentCollaboration(catalog), page);
});

it("reports unreadable records, missing projections and omitted hints as unknown recency", async (t) => {
	const { catalog, input } = fixture(t);
	publish(catalog, input, [1], 7);
	catalog.create(input);
	writeFileSync(join(catalog.root, `${randomUUID()}.json`), "invalid JSON");
	const page = await readRecentCollaboration(catalog);
	assert.equal(page.coverage.records, 3);
	assert.equal(page.coverage.unreadable, 1);
	assert.equal(page.coverage.missingHints, 1);
	assert.equal(page.coverage.omittedHints, 7);
	assert.equal(page.coverage.complete, false);
	assert.equal(page.coverage.unvisited, false);
	assert.deepEqual(new Set(page.coverage.reasons), new Set(["unreadable-records", "missing-thread-hints", "omitted-thread-hints"]));
});

it("keeps only the newest result limit and reports every omitted active hint", async (t) => {
	const { catalog, input } = fixture(t);
	for (let index = 0; index < 3; index++) publish(catalog, input, Array.from({ length: 8 }, (_, offset) => index * 8 + offset));
	const page = await readRecentCollaboration(catalog);
	assert.deepEqual(page.items.map((item) => item.updatedAt), Array.from({ length: 12 }, (_, offset) => 23 - offset));
	assert.equal(page.coverage.omittedResults, 12);
	assert.equal(page.coverage.complete, false);
	assert.deepEqual(page.coverage.reasons, ["result-limit"]);
});

it("bounds serialized bytes including JSON escapes and preserves coverage", async (t) => {
	const { catalog, input } = fixture(t);
	for (let index = 0; index < 12; index++) publish(catalog, input, [index], 0, false, "\u0000".repeat(160));
	const page = await readRecentCollaboration(catalog);
	assert.ok(Buffer.byteLength(JSON.stringify(page)) <= RECENT_COLLABORATION_LIMITS.bytes);
	assert.equal(page.items.length + page.coverage.omittedResults, 12);
	assert.ok(page.coverage.reasons.includes("byte-limit"));
});

it("bounds directory visits without invoking the unbounded paged catalog listing", async (t) => {
	const { catalog, input } = fixture(t);
	for (let index = 0; index < 270; index++) publish(catalog, input, [index]);
	t.mock.method(catalog, "page", () => { throw new Error("Paged traversal is not bounded at the directory source"); });
	const read = t.mock.method(catalog, "read");
	const page = await readRecentCollaboration(catalog);
	assert.equal(page.coverage.visited, 256);
	assert.ok(read.mock.callCount() <= 256);
	assert.equal(page.coverage.unvisited, true);
	assert.equal(page.coverage.complete, false);
	assert.ok(page.coverage.reasons.includes("visit-limit"));
});

it("counts irrelevant directory entries against traversal and handles absent or unreadable roots", async (t) => {
	const { root, catalog } = fixture(t);
	for (let index = 0; index < 260; index++) writeFileSync(join(catalog.root, `irrelevant-${index}`), "");
	const page = await readRecentCollaboration(catalog);
	assert.equal(page.coverage.visited, 256);
	assert.equal(page.coverage.records, 0);
	assert.equal(page.coverage.unvisited, true);
	const absent = await readRecentCollaboration(new AgentCatalog(join(root, "absent")));
	assert.equal(absent.coverage.complete, true);
	const fileRoot = join(root, "not-a-directory");
	writeFileSync(fileRoot, "");
	const unavailable = await readRecentCollaboration(new AgentCatalog(fileRoot));
	assert.equal(unavailable.coverage.complete, false);
	assert.deepEqual(unavailable.coverage.reasons, ["directory-unreadable"]);
});

it("retains the existing paged discovery cursor and closed-thread behavior", async (t) => {
	const { catalog, input } = fixture(t);
	publish(catalog, input, [1, 2, 3], 0, true);
	const first = await discoverCollaboration(catalog, { limit: 1 });
	assert.equal(first.items[0]?.closed, true);
	assert.ok(first.nextCursor);
	const next = await discoverCollaboration(catalog, { limit: 2, cursor: first.nextCursor });
	assert.equal(next.items.length, 2);
	assert.equal(next.nextCursor, null);
	assert.equal(next.coverage.complete, true);
});
