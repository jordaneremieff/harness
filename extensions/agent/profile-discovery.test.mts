import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { AgentManager } from "./manager.ts";
import { AgentConversationSummarySchema, StatusOutputSchema } from "./observation-schema.ts";
import { composeListRow, enrichDashboardRow, matchesListRow } from "./profile-discovery.ts";
import type { ProfileHints } from "./profile-schema.ts";
import { row } from "./dashboard-test-fixture.mts";

const hints: ProfileHints = { rows: [{ identity: "one", handle: "@history", role: "Review operator decisions", revision: "abc", hasExpertise: true, updatedAt: 1 }], coverage: { complete: false, omitted: 2 } };
it("discovery joins retained hints by canonical identity and keeps missing coverage unknown", () => {
	const result = composeListRow({ identity: "one", name: "Expert", firstMessage: "Old task" }, hints, "/work", "one");
	assert.equal(result.handle, "@history");
	assert.equal(result.role, "Review operator decisions");
	assert.equal(result.profile?.source, "retained");
	assert.equal(Object.hasOwn(result, "expertise"), false);
	for (const query of ["@HISTORY", "operator DECISIONS", "Expert", "old task", "/work", "one"]) assert.ok(matchesListRow(result, query), query);
	const missing = composeListRow({ identity: "two" }, hints, "/work", "two");
	assert.equal(missing.profileCoverage, "unknown"); assert.equal(missing.role, null);
	assert.equal(matchesListRow(missing, "history"), false);
	const base = row("one");
	assert.ok(Value.Check(AgentConversationSummarySchema, base));
	assert.equal(enrichDashboardRow(base, hints).profile?.handle, "@history");
	assert.equal(base.profile, undefined, "base observation remains unmodified");
});
it("manager list searches handle and role through retained hints without acquiring a host", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "profile-discovery-"));
	const manager = new AgentManager({ root, agentDir: join(root, "agent"), packageDir: root,
		connect: async () => { throw new Error("no live host"); },
		acquire: async () => { throw new Error("discovery must not acquire a host"); },
		observe: async (record) => ({ items: [{ identity: record.storageId, name: "Expert" }], next: null }),
	});
	t.after(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }); });
	const record = manager.catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: root, model: { provider: "fixture", modelId: "fixture" }, thinkingLevel: "off" });
	manager.catalog.updateView(record.storageId, { updatedAt: new Date().toISOString(), rows: [row(record.storageId, { storageId: record.storageId, cwd: root })], coverage: { complete: true, omitted: 0 }, profiles: { ...hints, rows: [{ ...hints.rows[0], identity: record.storageId }] } });
	for (const query of ["@HISTORY", "operator decisions"]) {
		const result = await manager.list({ query }) as { rows: Array<{ handle: string; role: string }> };
		assert.equal(result.rows.length, 1);
		assert.equal(result.rows[0].handle, "@history");
		assert.equal(result.rows[0].role, hints.rows[0].role);
	}
	const dashboard = await manager.dashboardPage();
	assert.equal(dashboard.rows[0].profile?.handle, "@history");
	const status = await manager.status();
	assert.ok(Value.Check(StatusOutputSchema, status), "composite profile does not leak into the base status schema");
	const empty = await manager.list({ query: "missing role" }) as { rows: unknown[]; coverage: { profileHints: { complete: boolean; omitted: number } } };
	assert.equal(empty.rows.length, 0);
	assert.equal(empty.coverage.profileHints.complete, false);
	assert.equal(empty.coverage.profileHints.omitted, 2);
});
