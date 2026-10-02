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
	const manager = new AgentManager({ root, agentDir: join(root, "agent"), packageDir: join(root, "package"), observe: async () => [] });
	t.after(() => manager.close());
	for (let index = 0; index < 321; index++) manager.catalog.create(catalogInput(root));
	const page = await manager.dashboardPage();
	assert.equal(page.coverage.complete, false, "the catalog scan did not reach its end");
	assert.ok(page.coverage.nextCursor !== null, "the unscanned remainder returns a cursor");
	assert.equal(page.coverage.storagesVisited, 320, "the page bound visits sixteen pages of twenty storages");
	const overview = structuredObservation(StatusOutputSchema, buildStatusOverview(page, [], [])) as { coverage: { byteLimitReached: boolean; complete: boolean } };
	assert.equal(overview.coverage.byteLimitReached, false, "the empty rows fit the byte bound");
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
