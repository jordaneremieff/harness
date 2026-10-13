import { ProfiledListOutputSchema } from "./profile-discovery.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostPaths } from "./host-protocol.ts";
import { dashboardRecords, rosterLines } from "./dashboard-roster.ts";
import { theme } from "./dashboard-test-fixture.mts";
import { it } from "node:test";
import { AgentManager } from "./manager.ts";
import { StatusOutputSchema, StatusToolOutputSchema, structuredObservation } from "./observation-schema.ts";
import { buildStatusOverview, type StatusOverview } from "./status-overview.ts";

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
	assert.equal(page.coverage.complete, false, "the output limit excludes one record after the complete scan");
	assert.ok(page.coverage.nextCursor !== null, "the ranked remainder returns a cursor");
	assert.equal(page.coverage.storagesVisited, 321, "the scan ranks every initial record before the output limit");
	assert.equal(page.coverage.inventory?.returned, 320);
	assert.equal(page.coverage.inventory?.remaining, 1);
	assert.equal(page.coverage.inventory?.remainingRows, 1);
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

it("ranks filename-last live and caller-owned history before recent unowned records across roster consumers", async (t) => {
	const root = fixtureRoot(t);
	let acquires = 0;
	let observes = 0;
	const manager = new AgentManager({ root, agentDir: root, packageDir: root,
		acquire: async () => { acquires++; throw new Error("Roster launched a host"); },
		observe: async () => { observes++; throw new Error("Roster read native state"); } });
	t.after(() => manager.close());
	const records = Array.from({ length: 324 }, () => manager.catalog.create({ ...catalogInput(root), ownerId: "other" }))
		.sort((left, right) => left.storageId.localeCompare(right.storageId));
	const [newest, live, owned] = records.slice(-3);
	const publishIdle = (record: typeof newest, name: string, ownerId: string, time: number) => {
		writeFileSync(manager.catalog.path(record.storageId), JSON.stringify({ ...record, name, ownerId }));
		manager.catalog.updateView(record.storageId, { updatedAt: "2026-01-01T00:00:00.000Z", rows: [{ id: record.storageId, storageId: record.storageId, name, cwd: record.cwd, modifiedAt: 1, owner: "here", state: "idle", cost: 0, partial: false }], coverage: { complete: true, omitted: 0 } });
		utimesSync(manager.catalog.path(record.storageId), time, time);
	};
	for (const record of records) publishIdle(record, "Old history", "other", 100);
	publishIdle(newest, "Newest history", "other", 10_000);
	publishIdle(live, "Live history", "other", 2);
	publishIdle(owned, "Owned history", "owner-1", 1);
	const paths = hostPaths(live);
	mkdirSync(dirname(paths.claim), { recursive: true });
	writeFileSync(paths.claim, JSON.stringify({ token: "test", pid: process.pid, host: hostname(), sessionId: live.storageId, cwd: live.cwd, createdAt: new Date().toISOString() }));
	const page = await manager.dashboardPage({ ownerId: "owner-1" });
	const rows = dashboardRecords({ observedAt: 0, sessions: page.rows }, "");
	assert.deepEqual(rows.slice(0, 3).map((row) => row.id), [live.storageId, owned.storageId, newest.storageId]);
	const viewport = rosterLines(rows, live.storageId, 80, 10, 0, theme, false).join("\n");
	assert.match(viewport, /Live history/);
	assert.match(viewport, /Owned history/);
	assert.match(viewport, /Newest history/);
	assert.equal(page.coverage.inventory?.inspected, records.length);
	assert.equal(page.coverage.inventory?.remaining, 4);
	assert.equal(page.coverage.inventory?.priorityRemaining, 0);
	assert.equal(await manager.sessionFigures("owner-1"), "agents: 0/1+ active");
	const overview = structuredObservation(StatusToolOutputSchema, await manager.status(undefined, undefined, { id: "owner-1", cwd: root })) as StatusOverview;
	assert.deepEqual(overview.sessions.slice(0, 3).map((row) => row.id), [live.storageId, owned.storageId, newest.storageId]);
	assert.equal(overview.coverage.inventory?.remaining, 4);
	assert.equal(overview.coverage.omittedPriorityRows, 0);
	assert.equal(overview.sessions.some((row) => "rosterOrder" in row), false);
	assert.equal(acquires, 0);
	assert.equal(observes, 0);
});

it("keeps unknown host claims visible in roster and overview coverage", async (t) => {
	const root = fixtureRoot(t);
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(() => manager.close());
	const record = manager.catalog.create(catalogInput(root));
	const paths = hostPaths(record);
	mkdirSync(dirname(paths.claim), { recursive: true });
	writeFileSync(paths.claim, "invalid");
	const page = await manager.dashboardPage();
	assert.equal(page.coverage.inventory?.unknownClaims, 1);
	assert.equal(page.coverage.complete, false);
	assert.equal(page.rows[0].owner, "unavailable");
	const overview = structuredObservation(StatusOutputSchema, await manager.status()) as StatusOverview;
	assert.equal(overview.coverage.inventory?.unknownClaims, 1);
	assert.ok(overview.coverage.reasons.some((reason) => /live-host priority is not established/u.test(reason)));
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
	const found = structuredObservation(ProfiledListOutputSchema, await manager.list({ query: "WHALE" }));
	assert.equal(found.rows.length, 1, "the query matched the retained first message case-insensitively");
	assert.equal(found.rows[0]?.firstMessage, "find the whale");
	assert.equal(found.rows[0]?.sessionId, identity);
	const missing = structuredObservation(ProfiledListOutputSchema, await manager.list({ query: "unicorn" }));
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
