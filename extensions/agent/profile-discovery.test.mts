import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesSchema } from "./schema-check.ts";
import { AgentManager } from "./manager.ts";
import { AgentConversationSummarySchema, StatusToolOutputSchema } from "./observation-schema.ts";
import {
	classifyListStorage,
	composeListRow,
	enrichDashboardRow,
	matchesListRow,
	ProfiledListOutputSchema,
} from "./profile-discovery.ts";
import { boundCatalogView, type CatalogView } from "./catalog-view.ts";
import type { CatalogRecord } from "./catalog.ts";
import type { ProfileHints } from "./profile-schema.ts";
import { row } from "./dashboard-test-fixture.mts";

const hints: ProfileHints = {
	rows: [
		{
			identity: "one",
			handle: "@history",
			role: "Review operator decisions",
			revision: "abc",
			hasExpertise: true,
			updatedAt: 1,
		},
	],
	coverage: { complete: false, omitted: 2 },
};
it("discovery joins retained hints by canonical identity and keeps missing coverage unknown", () => {
	const result = composeListRow({ identity: "one", name: "Expert", firstMessage: "Old task" }, hints, "/work", "one");
	assert.equal(result.handle, "@history");
	assert.equal(result.role, "Review operator decisions");
	assert.equal(result.profile?.source, "retained");
	assert.equal(Object.hasOwn(result, "expertise"), false);
	for (const query of ["@HISTORY", "operator DECISIONS", "Expert", "old task", "/work", "one"])
		assert.ok(matchesListRow(result, query), query);
	assert.ok(
		matchesListRow({ ...result, handle: "history" }, "@HISTORY"),
		"a leading @ does not require one in the retained handle",
	);
	const missing = composeListRow({ identity: "two" }, hints, "/work", "two");
	assert.equal(missing.profileCoverage, "unknown");
	assert.equal(missing.role, null);
	assert.equal(matchesListRow(missing, "history"), false);
	const base = row("one");
	assert.ok(matchesSchema(AgentConversationSummarySchema, base));
	assert.equal(enrichDashboardRow(base, hints).profile?.handle, "@history");
	assert.equal(base.profile, undefined, "base observation remains unmodified");
});
it("manager list searches handle and role through retained hints without acquiring a host", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "profile-discovery-"));
	const manager = new AgentManager({
		root,
		agentDir: join(root, "agent"),
		packageDir: root,
		connect: async () => {
			throw new Error("no live host");
		},
		acquire: async () => {
			throw new Error("discovery must not acquire a host");
		},
		observe: async (record) => ({ items: [{ identity: record.storageId, name: "Expert" }], next: null }),
	});
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const record = manager.catalog.create({
		cwd: root,
		agentDir: join(root, "agent"),
		packageDir: root,
		model: { provider: "fixture", modelId: "fixture" },
		thinkingLevel: "off",
	});
	manager.catalog.updateView(record.storageId, {
		updatedAt: new Date().toISOString(),
		rows: [row(record.storageId, { storageId: record.storageId, cwd: root })],
		coverage: { complete: true, omitted: 0 },
		profiles: { ...hints, rows: [{ ...hints.rows[0], identity: record.storageId }] },
	});
	for (const query of ["@HISTORY", "operator decisions"]) {
		const result = (await manager.list({ query })) as { rows: Array<{ handle: string; role: string }> };
		assert.equal(result.rows.length, 1);
		assert.equal(result.rows[0].handle, "@history");
		assert.equal(result.rows[0].role, hints.rows[0].role);
	}
	const dashboard = await manager.dashboardPage();
	assert.equal(dashboard.rows[0].profile?.handle, "@history");
	const status = await manager.status();
	assert.ok(
		matchesSchema(StatusToolOutputSchema, status),
		"manager overview matches the tool status schema without composite profile fields",
	);
	const empty = (await manager.list({ query: "missing role" })) as {
		rows: unknown[];
		coverage: { profileHints: { complete: boolean; omitted: number } };
	};
	assert.equal(empty.rows.length, 0);
	assert.equal(empty.coverage.profileHints.complete, false);
	assert.equal(empty.coverage.profileHints.omitted, 2);
});

it("classifies a storage for a query from its catalog record and writer claim", () => {
	const storageId = "11111111-1111-4111-8111-111111111111";
	const view: CatalogView = {
		updatedAt: "2026-01-02T00:00:00.000Z",
		storageId,
		rows: [row(storageId, { storageId, name: "Parser review", firstMessage: "Check the grammar" })],
		coverage: { complete: false, omitted: 0 },
		profiles: { rows: [{ ...hints.rows[0], identity: storageId }], coverage: { complete: false, omitted: 2 } },
	};
	const record = { storageId, cwd: "/work/site", name: "spawn label", recoveryDue: false, view } as CatalogRecord;
	const ended = { kind: "dead", label: "PID 1", writerId: "writer", endedAt: "2026-01-02T00:00:01.000Z" } as const;
	for (const query of [
		"PARSER",
		"grammar",
		"@history",
		"operator decisions",
		"spawn label",
		"/work/site",
		storageId.slice(0, 8),
	])
		assert.equal(classifyListStorage(record, ended, query), "candidate", query);
	assert.equal(classifyListStorage(record, ended, ""), "candidate", "an unfiltered scan observes every storage");
	assert.equal(
		classifyListStorage(record, ended, "absent"),
		"settled",
		"trimmed display text and incomplete hints leave the published rows whole",
	);
	for (const [name, patch] of Object.entries({
		"no publication": { view: undefined },
		"unavailable publication": { view: { ...view, rows: [], unavailable: "projection failed" } },
		"omitted rows": { view: { ...view, coverage: { complete: false, omitted: 1 } } },
		"no published row": { view: { ...view, rows: [], profiles: undefined } },
		"recovery due": { recoveryDue: true },
		"no recovery marker": { recoveryDue: undefined },
	}))
		assert.equal(classifyListStorage({ ...record, ...patch } as CatalogRecord, ended, "absent"), "candidate", name);
	for (const claim of [
		{ kind: "absent" },
		{ kind: "dead", label: "PID 1", writerId: "writer" },
		{ kind: "dead", label: "PID 1", writerId: "writer", endedAt: "2026-01-01T23:59:59.000Z" },
		{ kind: "live", label: "PID 1" },
		{ kind: "unknown", error: "Writer claim is unreadable" },
	] as const)
		assert.equal(classifyListStorage(record, claim, "absent"), "remainder", JSON.stringify(claim));
});
for (const query of ["session-history", "@session-history"]) {
	it(`lists the exact retained handle first for ${query} without losing earlier or later continuation rows`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "profile-query-order-"));
		const manager = new AgentManager({
			root,
			agentDir: join(root, "agent"),
			packageDir: root,
			acquire: async () => {
				throw new Error("discovery must not acquire a host");
			},
			observe: async (record, method, input) => {
				assert.equal(method, "list");
				const offset = Number((input.cursor as { offset?: number } | undefined)?.offset ?? 0);
				const items = [record.storageId, `${record.storageId}:2`].map((identity, index) => ({
					identity,
					conversationId: index + 1,
					busy: false,
					firstMessage: "Read session-history and @session-history findings",
				}));
				const end = Math.min(items.length, offset + Number(input.limit));
				return { items: items.slice(offset, end), next: end < items.length ? { offset: end } : null };
			},
		});
		t.after(async () => {
			await manager.close();
			rmSync(root, { recursive: true, force: true });
		});
		const records = Array.from({ length: 8 }, () =>
			manager.catalog.create({
				cwd: root,
				agentDir: join(root, "agent"),
				packageDir: root,
				model: { provider: "fixture", modelId: "fixture" },
				thinkingLevel: "off",
			}),
		).sort((a, b) => (a.storageId < b.storageId ? -1 : 1));
		const exact = records[5];
		for (const record of records) {
			manager.catalog.updateView(record.storageId, {
				updatedAt: "2026-01-01T00:00:00.000Z",
				rows: [record.storageId, `${record.storageId}:2`].map((identity) =>
					row(identity, {
						storageId: record.storageId,
						cwd: root,
						firstMessage: "Read session-history and @session-history findings",
					}),
				),
				coverage: { complete: true, omitted: 0 },
				profiles: {
					rows:
						record === exact
							? [
									{
										identity: record.storageId,
										handle: "session-history",
										role: "History",
										revision: "r1",
										hasExpertise: true,
										updatedAt: 1,
									},
								]
							: [],
					coverage: { complete: true, omitted: 0 },
				},
			});
			manager.catalog.markRecoveryDue(record.storageId, false);
			utimesSync(manager.catalog.path(record.storageId), 1, 1);
		}
		type Page = {
			rows: Array<{ identity: string; handle: string | null }>;
			nextCursor: string | null;
			coverage: {
				complete: boolean;
				storagesVisited: number;
				catalog: { pending: number; storages: number };
				next: { tool: string; query: string; limit: number; cursor: string } | null;
			};
		};
		const first = (await manager.list({ query, limit: 5 })) as Page;
		assert.ok(matchesSchema(ProfiledListOutputSchema, first));
		assert.equal(first.rows.length, 5);
		assert.equal(first.rows[0].identity, exact.storageId);
		assert.equal(first.rows[0].handle, "session-history");
		assert.equal(first.coverage.complete, false);
		assert.equal(first.coverage.catalog.storages, records.length);
		assert.equal(first.coverage.catalog.pending, 6);
		const pages: Page[] = [first];
		for (
			let next: Page["coverage"]["next"] = first.coverage.next;
			next && pages.length < 10;
			next = pages.at(-1)?.coverage.next ?? null
		) {
			const { tool, ...input } = next;
			assert.equal(tool, "agent_list");
			assert.equal(input.query, query);
			pages.push((await manager.list(input)) as Page);
		}
		const found = pages.flatMap((page) => page.rows.map((row) => row.identity));
		const expected = [exact, ...records.filter((record) => record !== exact)].flatMap((record) => [
			record.storageId,
			`${record.storageId}:2`,
		]);
		assert.deepEqual(found, expected);
		assert.equal(new Set(found).size, found.length);
		assert.ok(pages.every((page) => page.rows.length <= 5 && page.coverage.storagesVisited <= 32));
		assert.equal(pages.at(-1)?.coverage.complete, true);
		assert.equal(pages.at(-1)?.coverage.catalog.pending, 0);
		assert.equal(pages.at(-1)?.coverage.next, null);
		assert.equal(pages.at(-1)?.nextCursor, null);
	});
}

it("bounds unreadable list records and keeps their uncertainty after later observations", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "list-unavailable-"));
	const manager = new AgentManager({
		root,
		agentDir: root,
		packageDir: root,
		connect: async () => {
			throw new Error("no live host");
		},
		acquire: async () => {
			throw new Error("discovery must not acquire a host");
		},
		observe: async (record, method, input) => {
			assert.equal(method, "list");
			const first = input.cursor === undefined;
			return {
				items: [{ identity: first ? record.storageId : `${record.storageId}:2`, name: "needle" }],
				next: first ? { after: "root" } : null,
			};
		},
	});
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const ids = Array.from(
		{ length: 34 },
		() =>
			manager.catalog.create({
				cwd: root,
				agentDir: root,
				packageDir: root,
				model: { provider: "fixture", modelId: "fixture" },
				thinkingLevel: "off",
			}).storageId,
	).sort();
	const valid = ids.at(-1);
	assert.ok(valid);
	const unreadable = ids.slice(0, -1);
	for (const id of unreadable) writeFileSync(manager.catalog.path(id), "not a catalog record");
	utimesSync(manager.catalog.path(valid), 1, 1);

	type Page = {
		rows: Array<{ identity: string }>;
		coverage: {
			complete: boolean;
			storagesVisited: number;
			unavailable: Array<{ storageId: string }>;
			basis: string;
			next: { tool: string; query: string; limit: number; cursor: string } | null;
		};
	};
	const resume = async (page: Page) => {
		assert.ok(page.coverage.next);
		const { tool, ...input } = page.coverage.next;
		assert.equal(tool, "agent_list");
		return (await manager.list(input)) as Page;
	};
	const first = (await manager.list({ query: "needle", limit: 1 })) as Page;
	assert.deepEqual(first.rows, []);
	assert.equal(first.coverage.storagesVisited, 0);
	assert.equal(first.coverage.complete, false);
	assert.deepEqual(
		first.coverage.unavailable.map(({ storageId }) => storageId),
		unreadable.slice(0, 32),
	);

	const second = await resume(first);
	assert.deepEqual(
		second.rows.map(({ identity }) => identity),
		[valid],
	);
	assert.equal(second.coverage.storagesVisited, 1);
	assert.deepEqual(
		second.coverage.unavailable.map(({ storageId }) => storageId),
		unreadable.slice(32),
	);

	const last = await resume(second);
	assert.deepEqual(
		last.rows.map(({ identity }) => identity),
		[`${valid}:2`],
	);
	assert.equal(last.coverage.storagesVisited, 1);
	assert.equal(last.coverage.complete, true);
	assert.equal(last.coverage.next, null);
	assert.deepEqual(last.coverage.unavailable, []);
	assert.match(last.coverage.basis, /unavailable on this or an earlier page.*Missing matches remain unknown/u);

	writeFileSync(manager.catalog.path(valid), "not a catalog record");
	const interrupted = await resume(second);
	assert.deepEqual(interrupted.coverage.unavailable, [
		{ storageId: valid, reason: "Catalog record could not be read" },
	]);
	assert.equal(interrupted.coverage.storagesVisited, 0);
	assert.equal(interrupted.coverage.complete, true);
});

it("a publication at the publisher's 200-conversation scan bound always reports omitted rows", () => {
	const storageId = "11111111-1111-4111-8111-111111111111";
	const rows = Array.from({ length: 200 }, (_, index) => ({
		id: index === 0 ? storageId : `${storageId}:${index + 1}`,
		storageId,
		cwd: "",
		modifiedAt: 0,
		owner: "here" as const,
		state: "new" as const,
		cost: 0,
		partial: false,
	}));
	const view = boundCatalogView({ updatedAt: new Date().toISOString(), rows, storageId, rootId: storageId });
	assert.ok(view.coverage.omitted > 0);
});
