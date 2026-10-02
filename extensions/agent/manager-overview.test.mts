import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentManager } from "./manager.ts";
import { ListOutputSchema, StatusOutputSchema, structuredObservation } from "./observation-schema.ts";
import { buildStatusOverview } from "./status-overview.ts";

function fixtureRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "manager-overview-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function catalogInput(root: string): { cwd: string; agentDir: string; packageDir: string; model: { provider: string; modelId: string }; thinkingLevel: string; ownerId: string } {
	return { cwd: "/work", agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: "test", modelId: "model" }, thinkingLevel: "off", ownerId: "owner-1" };
}

it("returns a partial dashboard page with a cursor at the storage bound instead of throwing", async (t) => {
	const root = fixtureRoot(t);
	let observes = 0;
	const manager = new AgentManager({
		root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		observe: async () => {
			observes += 1;
			return [];
		},
	});
	t.after(() => manager.close());
	for (let index = 0; index < 321; index++) manager.catalog.create(catalogInput(root));
	const page = await manager.dashboardPage();
	assert.equal(observes, 0, "the board reads catalog metadata, not native host state");
	assert.equal(page.coverage.complete, false, "the catalog scan did not reach its end");
	assert.ok(page.coverage.nextCursor !== null, "the unscanned remainder returns a cursor");
	assert.equal(page.coverage.storagesVisited, 320, "the page bound visits sixteen pages of twenty storages");
	const continuation = await manager.dashboardPage({ cursor: page.coverage.nextCursor ?? undefined });
	assert.equal(continuation.rows.length, 1);
	assert.equal(continuation.coverage.complete, true);
	assert.equal(continuation.coverage.nextCursor, null);
	assert.equal(continuation.rows.some((row) => page.rows.some((previous) => previous.id === row.id)), false);
	assert.equal(observes, 0);
	const overview = structuredObservation(StatusOutputSchema, buildStatusOverview(page, [], [])) as { coverage: { byteLimitReached: boolean; complete: boolean } };
	assert.equal(overview.coverage.byteLimitReached, true, "unavailable metadata rows reach the status byte bound");
	assert.equal(overview.coverage.complete, false);
	assert.ok(Buffer.byteLength(JSON.stringify(overview), "utf8") <= 48 * 1024);
});

it("matches a list query against the first message", async (t) => {
	const root = fixtureRoot(t);
	let identity = "";
	const manager = new AgentManager({
		root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		observe: async (_metadata, method) =>
			method === "list" ? { items: [{ conversationId: 1, identity, busy: false, firstMessage: "find the whale" }], next: undefined } : [],
	});
	t.after(() => manager.close());
	const record = manager.catalog.create(catalogInput(root));
	identity = `${record.storageId}:1`;
	const found = structuredObservation(ListOutputSchema, await manager.list({ query: "WHALE" }));
	assert.equal(found.rows.length, 1, "the query matched the retained first message case-insensitively");
	assert.equal(found.rows[0]?.firstMessage, "find the whale");
	assert.equal(found.rows[0]?.sessionId, identity);
	const missing = structuredObservation(ListOutputSchema, await manager.list({ query: "unicorn" }));
	assert.equal(missing.rows.length, 0);
});

it("re-reads 50 published views without observation or launch", async (t) => {
	const root = fixtureRoot(t);
	let acquires = 0;
	let observes = 0;
	const manager = new AgentManager({
		root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		acquire: async () => {
			acquires += 1;
			throw new Error("the board launched a host");
		},
		observe: async () => {
			observes += 1;
			throw new Error("the board observed native state");
		},
	});
	t.after(() => manager.close());
	const storageIds: string[] = [];
	for (let index = 0; index < 50; index++) {
		const record = manager.catalog.create(catalogInput(root));
		storageIds.push(record.storageId);
		manager.catalog.updateView(record.storageId, {
			updatedAt: new Date().toISOString(),
			rows: [{ id: `${record.storageId}:1`, storageId: record.storageId, cwd: record.cwd, modifiedAt: 1, owner: "here", state: index === 0 ? "working" : "idle", cost: 0, partial: false }],
			coverage: { complete: true, omitted: 0 },
		});
	}
	const first = await manager.dashboardPage();
	assert.equal(acquires, 0);
	assert.equal(observes, 0);
	assert.deepEqual(first.rows.map((row) => row.storageId).sort(), storageIds.slice().sort());
	const interrupted = first.rows.find((row) => row.storageId === storageIds[0]) as { state?: string; owner?: string; ownerLabel?: string } | undefined;
	assert.equal(interrupted?.state, "interrupted", "an absent claim interrupts a working row");
	assert.equal(interrupted?.owner, "unknown");
	assert.match(interrupted?.ownerLabel ?? "", /^Host metadata at /u);
	const second = await manager.dashboardPage();
	assert.deepEqual(second.rows, first.rows, "an unchanged cold catalog returns the same rows");
	assert.equal(acquires, 0);
	assert.equal(observes, 0);
});
