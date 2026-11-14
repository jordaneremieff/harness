import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesSchema } from "./schema-check.ts";
import { AgentManager } from "./manager.ts";
import { AgentConversationSummarySchema, StatusToolOutputSchema } from "./observation-schema.ts";
import { classifyListStorage, composeListRow, enrichDashboardRow, matchesListRow } from "./profile-discovery.ts";
import { boundCatalogView, type CatalogView } from "./catalog-view.ts";
import type { CatalogRecord } from "./catalog.ts";
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
	assert.ok(matchesSchema(AgentConversationSummarySchema, base));
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
	assert.ok(matchesSchema(StatusToolOutputSchema, status), "manager overview matches the tool status schema without composite profile fields");
	const empty = await manager.list({ query: "missing role" }) as { rows: unknown[]; coverage: { profileHints: { complete: boolean; omitted: number } } };
	assert.equal(empty.rows.length, 0);
	assert.equal(empty.coverage.profileHints.complete, false);
	assert.equal(empty.coverage.profileHints.omitted, 2);
});

it("classifies a storage for a query from its catalog record and writer claim", () => {
	const storageId = "11111111-1111-4111-8111-111111111111";
	const view: CatalogView = { updatedAt: "2026-01-02T00:00:00.000Z", storageId, rows: [row(storageId, { storageId, name: "Parser review", firstMessage: "Check the grammar" })], coverage: { complete: false, omitted: 0 },
		profiles: { rows: [{ ...hints.rows[0], identity: storageId }], coverage: { complete: false, omitted: 2 } } };
	const record = { storageId, cwd: "/work/site", name: "spawn label", recoveryDue: false, view } as CatalogRecord;
	const ended = { kind: "dead", label: "PID 1", writerId: "writer", endedAt: "2026-01-02T00:00:01.000Z" } as const;
	for (const query of ["PARSER", "grammar", "@history", "operator decisions", "spawn label", "/work/site", storageId.slice(0, 8)]) assert.equal(classifyListStorage(record, ended, query), "candidate", query);
	assert.equal(classifyListStorage(record, ended, ""), "candidate", "an unfiltered scan observes every storage");
	assert.equal(classifyListStorage(record, ended, "absent"), "settled", "trimmed display text and incomplete hints leave the published rows whole");
	for (const [name, patch] of Object.entries({
		"no publication": { view: undefined },
		"unavailable publication": { view: { ...view, rows: [], unavailable: "projection failed" } },
		"omitted rows": { view: { ...view, coverage: { complete: false, omitted: 1 } } },
		"no published row": { view: { ...view, rows: [], profiles: undefined } },
		"recovery due": { recoveryDue: true },
		"no recovery marker": { recoveryDue: undefined },
	})) assert.equal(classifyListStorage({ ...record, ...patch } as CatalogRecord, ended, "absent"), "candidate", name);
	for (const claim of [
		{ kind: "absent" },
		{ kind: "dead", label: "PID 1", writerId: "writer" },
		{ kind: "dead", label: "PID 1", writerId: "writer", endedAt: "2026-01-01T23:59:59.000Z" },
		{ kind: "live", label: "PID 1" },
		{ kind: "unknown", error: "Writer claim is unreadable" },
	] as const) assert.equal(classifyListStorage(record, claim, "absent"), "remainder", JSON.stringify(claim));
});
it("a publication at the publisher's 200-conversation scan bound always reports omitted rows", () => {
	const storageId = "11111111-1111-4111-8111-111111111111";
	const rows = Array.from({ length: 200 }, (_, index) => ({ id: index === 0 ? storageId : `${storageId}:${index + 1}`, storageId, cwd: "", modifiedAt: 0, owner: "here" as const, state: "new" as const, cost: 0, partial: false }));
	const view = boundCatalogView({ updatedAt: new Date().toISOString(), rows, storageId, rootId: storageId });
	assert.ok(view.coverage.omitted > 0);
});
