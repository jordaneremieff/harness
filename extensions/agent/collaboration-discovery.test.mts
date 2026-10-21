import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Session } from "@earendil-works/pi-durable";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentCatalog } from "./catalog.ts";
import { CollaborationIndex, CollaborationThreads, type CollaborationSummary, type CollaborationThread, listCollaboration, projectCollaboration } from "./collaboration.ts";
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

it("reads priority contacts outside the directory sample without expanding its visit bound", async (t) => {
	const { catalog, input } = fixture(t);
	const records = Array.from({ length: 270 }, () => catalog.create(input));
	const sampled = new Set<string>();
	const directory = await opendir(catalog.root, { bufferSize: 1 });
	try {
		for (let visit = 0; visit < RECENT_COLLABORATION_LIMITS.visits; visit++) {
			const entry = await directory.read();
			if (entry === null) break;
			sampled.add(entry.name);
		}
	} finally { await directory.close(); }
	const contact = records.find((record) => !sampled.has(`${record.storageId}.json`));
	assert.ok(contact, "the contact owner lies outside the unprioritized directory prefix");
	const thread: CollaborationSummary = { id: `${contact.storageId}/${"0".repeat(32)}`, title: "Active contact", purpose: "Current collaboration", updatedAt: 100, closed: false, members: 1 };
	const originalRead = catalog.read.bind(catalog);
	const read = t.mock.method(catalog, "read", (identity: string) => {
		const record = originalRead(identity);
		return identity === contact.storageId ? { ...record, threads: { items: [thread], omitted: 0, updatedAt: "2026-10-04T10:00:00.000Z" } } : record;
	});
	const page = await readRecentCollaboration(catalog, [contact.storageId]);
	assert.deepEqual(page.items, [thread]);
	assert.equal(page.coverage.visited, RECENT_COLLABORATION_LIMITS.visits);
	assert.equal(page.coverage.unvisited, true);
	assert.equal(read.mock.calls[0].arguments[0], contact.storageId);
	assert.ok(read.mock.callCount() <= RECENT_COLLABORATION_LIMITS.visits);
});

it("counts duplicate directory encounters without duplicate hints and ignores absent optional priorities", async (t) => {
	const { catalog, input } = fixture(t);
	const [thread] = publish(catalog, input, [10]);
	const storageId = thread.id.split("/")[0];
	const baseline = await readRecentCollaboration(catalog);
	const read = t.mock.method(catalog, "read");
	const page = await readRecentCollaboration(catalog, [`${storageId}:2`, storageId, randomUUID()]);
	assert.deepEqual(page.items, baseline.items);
	assert.equal(page.coverage.records, 1);
	assert.equal(page.coverage.visited, baseline.coverage.visited + 2);
	assert.equal(page.coverage.unreadable, 0);
	assert.equal(page.coverage.missingHints, 0);
	assert.equal(page.coverage.complete, true);
	assert.equal(read.mock.callCount(), 2);
});

it("keeps old active threads ahead of newer closed hints with activity and stable ID ordering", async () => {
	const storageId = randomUUID();
	const keys = Array.from({ length: 256 }, (_, index) => `${storageId}/${index.toString(16).padStart(32, "0")}`);
	const threads = new Map(keys.map((id, index): [string, CollaborationThread] => [id, {
		id, title: "Thread", purpose: "Purpose", authority: "Authority", source: "Source", restrictions: "Restrictions", acceptance: "Acceptance", integrator: storageId,
		creator: storageId, createdAt: index, updatedAt: index < 3 ? index === 0 ? 50 : 100 : 1000 + index, revision: 1, sequence: 1, closed: index >= 3, members: [],
	}]));
	const reads: string[] = [];
	const session = { async snapshot(doc: unknown, key: unknown) {
		if (doc === CollaborationIndex) return { keys };
		assert.equal(doc, CollaborationThreads);
		assert.equal(typeof key, "string");
		reads.push(key as string);
		return { thread: threads.get(key as string) };
	} } as unknown as Session;
	const projection = await projectCollaboration(session, BACKGROUND_CONTEXT);
	assert.deepEqual(projection.items.map((item) => item.id), [keys[1], keys[2], keys[0], ...keys.slice(-5).reverse()]);
	assert.equal(projection.omitted, 248);
	assert.equal(reads.length, 256);
	assert.ok(Buffer.byteLength(JSON.stringify(projection.items)) <= 4000);
	const first = await listCollaboration(session, { limit: 1 }, BACKGROUND_CONTEXT);
	assert.equal(first.items[0].id, keys[0]);
	assert.equal(first.nextCursor, "1");
	assert.equal(first.coverage.visited, 1);
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
