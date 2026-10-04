import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { formatDurableFooter, sessionFigures } from "./footer.ts";
import { AgentManager } from "./manager.ts";

function row(id = "a", overrides: Partial<AgentConversationSummary> = {}): AgentConversationSummary {
	return {
		id,
		storageId: "storage",
		cwd: "/work",
		owner: "here",
		modifiedAt: 1,
		state: "idle",
		cost: 0,
		partial: false,
		...overrides,
	};
}

test("coverage uncertainty qualifies cost without changing the complete status format", () => {
	const rows = [row("working", { state: "working", cost: 0.25 })];
	const complete = { complete: true, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: null };
	assert.equal(formatDurableFooter(rows, complete), "agents: 1/1 active (session) · $0.25");
	for (const coverage of [
		{ ...complete, complete: false },
		{ ...complete, nextCursor: "more" },
		{ ...complete, skipped: 1 },
		{ ...complete, omitted: 1 },
	]) {
		assert.equal(formatDurableFooter(rows, coverage), "agents: 1/1 active (session) · ≥$0.25");
		assert.equal(formatDurableFooter([row("working", { state: "working", cost: 0.25, partial: true })], coverage), "agents: 1/1 active (session) · ≥$0.25+?", "inventory and cost uncertainty keep distinct markers");
		assert.equal(formatDurableFooter([], coverage), "");
	}
});
test("counts only working conversations and keeps the empty footer", () => {
	assert.equal(formatDurableFooter([]), "");
	const rows = [
		row("working", { state: "working", cost: 0.25 }),
		row("idle", { state: "idle", cost: 1 }),
		row("done", { state: "done", cost: 2 }),
		row("failed", { state: "failed", cost: 4 }),
		row("unavailable", { owner: "unavailable", state: "unavailable", cost: 8 }),
	];
	assert.equal(formatDurableFooter(rows), "agents: 1/5 active (session) · $15.25");
});

test("sums native conversation costs and keeps sub-cent totals readable", () => {
	assert.equal(formatDurableFooter([row("a", { cost: 0.1 }), row("b", { cost: 0.2 })]), "agents: 0/2 active (session) · $0.30");
	assert.equal(formatDurableFooter([row("a", { cost: 0.0001 })]), "agents: 0/1 active (session) · $0.0001");
	assert.equal(formatDurableFooter([row("a", { cost: 0 })]), "agents: 0/1 active (session) · $0.00");
});

test("marks incomplete native cost with +? and never reports detached work", () => {
	assert.equal(formatDurableFooter([row("a", { cost: 0.25, partial: true })]), "agents: 0/1 active (session) · $0.25+?");
	assert.equal(
		formatDurableFooter([row("a", { cost: 0.25 }), row("b", { cost: 0.75, partial: true })]),
		"agents: 0/2 active (session) · $1.00+?",
	);
	assert.equal(formatDurableFooter([row("a", { cost: Number.NaN }), row("b", { cost: -1 })]), "agents: 0/2 active (session) · $0.00+?");
	assert.doesNotMatch(formatDurableFooter([row("a", { state: "working" })]), /detached/);
});

test("each primary counts only its created agents and descendants through conversation owners", () => {
	const rows = [
		row("first", { storageId: "first", state: "working", cost: 1 }),
		row("first:7", { storageId: "first", state: "idle", cost: 2 }),
		row("child", { storageId: "child", state: "working", cost: 3 }),
		row("grandchild:2", { storageId: "grandchild", state: "done", cost: 4 }),
		row("second", { storageId: "second", state: "working", cost: 8 }),
	];
	const owners = new Map([
		["first", "primary-a"], ["child", "first:7"], ["grandchild", "child:2"], ["second", "primary-b"],
	]);
	const reads: string[] = [];
	const readOwner = (storageId: string) => { reads.push(storageId); return owners.get(storageId); };
	assert.equal(sessionFigures(rows, "primary-a", readOwner), "agents: 2/4 active (session) · $10.00");
	assert.equal(reads.filter((id) => id === "first").length, 1, "forks reuse one creating-owner read");
	assert.equal(sessionFigures(rows, "primary-b", readOwner), "agents: 1/1 active (session) · $8.00");
	assert.equal(sessionFigures(rows, "empty-primary", readOwner), "");
});

test("owner traversal reads ancestors absent from the roster and preserves exact conversation identity", () => {
	const rows = [row("descendant", { storageId: "descendant", cost: 0.5 })];
	const owners = new Map([["descendant", "ancestor:5"], ["ancestor", "primary:2"]]);
	const readOwner = (storageId: string) => owners.get(storageId);
	assert.equal(sessionFigures(rows, "primary:2", readOwner), "agents: 0/1 active (session) · $0.50");
	assert.equal(sessionFigures(rows, "primary:3", readOwner), "");
	assert.equal(sessionFigures(rows, "primary", readOwner), "");
});

test("cycles terminate without importing unrelated agents into a primary scope", () => {
	const rows = [
		row("a", { storageId: "a", state: "working", cost: 1 }),
		row("b:2", { storageId: "b", cost: 2 }),
		row("self", { storageId: "self", cost: 4 }),
		row("owned", { storageId: "owned", cost: 8 }),
	];
	const owners = new Map([["a", "b:2"], ["b", "a"], ["self", "self:9"], ["owned", "primary"]]);
	let reads = 0;
	const text = sessionFigures(rows, "primary", (storageId) => { reads++; return owners.get(storageId); });
	assert.equal(text, "agents: 0/1 active (session) · $8.00");
	assert.equal(reads, 4);
});

test("owner traversal stops at a fixed depth and qualifies known totals", () => {
	let reads = 0;
	const text = sessionFigures([
		row("owned", { storageId: "owned", cost: 1 }), row("0", { storageId: "0", cost: 2 }),
	], "primary", (storageId) => {
		reads++;
		return storageId === "owned" ? "primary" : String(Number(storageId) + 1);
	});
	assert.equal(reads, 65);
	assert.equal(text, "agents: 0/1 active (session) · ≥$1.00");
});

test("owner reads have a total bound across unrelated chains", () => {
	let reads = 0;
	const rows = Array.from({ length: 1100 }, (_, index) => row(String(index), { storageId: String(index) }));
	const text = sessionFigures(rows, "primary", () => { reads++; return "primary"; });
	assert.equal(reads, 1024);
	assert.equal(text, "agents: 0/1024 active (session) · ≥$0.00");
});

test("manager supplies distinct primary footers and the same UI-local figures without host reads", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-session-footer-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const manager = new AgentManager({
		root, agentDir: join(root, "agent"), packageDir: join(root, "package"),
		createPrimary: async (options) => ({
			id: options.id, socketPath: "unused",
			info: () => { throw new Error("No primary channel read is required"); },
			update: () => {}, close: async () => {},
		}),
		acquire: async () => { throw new Error("A footer read must not launch a host"); },
		observe: async () => { throw new Error("A footer read must not observe native storage"); },
	});
	t.after(() => manager.close());
	function create(ownerId: string, costs: number[]) {
		const record = manager.catalog.create({
			cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"),
			model: { provider: "test", modelId: "model" }, thinkingLevel: "off", ownerId,
		});
		manager.catalog.updateView(record.storageId, {
			updatedAt: new Date().toISOString(), coverage: { complete: true, omitted: 0 },
			rows: costs.map((cost, index) => row(index === 0 ? record.storageId : `${record.storageId}:${index + 1}`, { storageId: record.storageId, cost })),
		});
		return record.storageId;
	}
	const first = create("primary-a", [1, 2]);
	create(`${first}:2`, [3]);
	create("primary-b", [8]);
	const statuses = new Map<string, string | undefined>();
	for (const ownerId of ["primary-a", "primary-b", "empty-primary"]) {
		await manager.registerPrimary(ownerId, {
			signal: new AbortController().signal, send: () => {}, status: (text) => { statuses.set(ownerId, text); },
		});
	}
	assert.equal(statuses.get("primary-a"), "agents: 0/3 active (session) · $6.00");
	assert.equal(statuses.get("primary-b"), "agents: 0/1 active (session) · $8.00");
	assert.equal(statuses.has("empty-primary"), true, "the empty primary receives an explicit status clear");
	assert.equal(statuses.get("empty-primary"), undefined);
	const page = await manager.dashboardPage();
	for (const ownerId of statuses.keys()) {
		const expected = statuses.get(ownerId) ?? "";
		assert.equal(await manager.sessionFigures(ownerId), expected);
		assert.equal(await manager.sessionFigures(ownerId, page), expected);
	}
});
