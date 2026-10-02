import assert from "node:assert/strict";
import { it } from "node:test";
import {
	boundCatalogView,
	CATALOG_VIEW_BUDGET_BYTES,
	CATALOG_VIEW_TEXT_LIMIT,
	type CatalogViewRow,
	isCatalogView,
	parseCatalogView,
} from "./catalog-view.ts";

function row(id: string, overrides: Partial<CatalogViewRow> = {}): CatalogViewRow {
	return {
		id,
		storageId: "storage",
		cwd: "/work",
		modifiedAt: 1,
		owner: "here",
		state: "idle",
		cost: 0,
		partial: false,
		...overrides,
	};
}

it("bounds rows to the view budget with truthful coverage", () => {
	const rows = Array.from({ length: 200 }, (_, index) => row(`row-${index}`, { latestReply: "x".repeat(1500) }));
	const view = boundCatalogView({ updatedAt: "2026-01-01T00:00:00.000Z", rows });
	assert.ok(
		Buffer.byteLength(JSON.stringify(view), "utf8") <= CATALOG_VIEW_BUDGET_BYTES,
		"the serialized view stays within its budget",
	);
	assert.ok(view.rows.length < rows.length, "some rows are omitted");
	assert.equal(view.coverage.omitted, rows.length - view.rows.length);
	assert.equal(view.coverage.complete, false);
	assert.ok(isCatalogView(view));
});

it("trims long display texts and keeps the other fields", () => {
	const view = boundCatalogView({
		updatedAt: "2026-01-01T00:00:00.000Z",
		rows: [
			row("root", {
				latestReply: "y".repeat(CATALOG_VIEW_TEXT_LIMIT + 500),
				currentTool: { name: "read", argument: "z".repeat(CATALOG_VIEW_TEXT_LIMIT + 500) },
				name: "kept",
				cost: 3,
			}),
		],
		rootId: "root",
	});
	assert.equal(view.rows.length, 1);
	assert.equal(view.rows[0]?.name, "kept");
	assert.equal(view.rows[0]?.cost, 3);
	assert.ok((view.rows[0]?.latestReply ?? "").length <= CATALOG_VIEW_TEXT_LIMIT + 10);
	assert.match(view.rows[0]?.latestReply ?? "", /\[…\]/u);
	assert.ok((view.rows[0]?.currentTool?.argument ?? "").length <= CATALOG_VIEW_TEXT_LIMIT + 10);
	assert.equal(view.coverage.complete, false, "a trimmed row reports partial coverage");
});

it("emits the root first and keeps it when it fits", () => {
	const view = boundCatalogView({
		updatedAt: "2026-01-01T00:00:00.000Z",
		rows: [row("other"), row("root")],
		rootId: "root",
	});
	assert.equal(view.rows[0]?.id, "root");
	assert.equal(view.coverage.complete, true);
});

it("omits a root row that cannot fit", () => {
	const view = boundCatalogView({
		updatedAt: "2026-01-01T00:00:00.000Z",
		rows: [row("root", { name: "n".repeat(CATALOG_VIEW_BUDGET_BYTES) }), row("other")],
		rootId: "root",
	});
	assert.equal(view.rows[0]?.id, "other");
	assert.equal(view.coverage.omitted, 1);
	assert.equal(view.coverage.complete, false);
});

it("reports an unavailable projection explicitly", () => {
	const view = boundCatalogView({
		updatedAt: "2026-01-01T00:00:00.000Z",
		rows: [row("root")],
		unavailable: "host scan failed",
	});
	assert.deepEqual(view.rows, []);
	assert.equal(view.unavailable, "host scan failed");
	assert.equal(view.coverage.complete, false);
	assert.ok(isCatalogView(view));
});

it("rejects malformed row fields and invalid publication times", () => {
	const view = { updatedAt: "2026-01-01T00:00:00.000Z", rows: [row("a")], coverage: { complete: true, omitted: 0 } };
	for (const bad of [{ state: "invented" }, { owner: "invented" }, { cost: Number.NaN }, { modifiedAt: Infinity }, { partial: "yes" }, { health: { autoRetry: { attempt: -1 } } }]) {
		assert.throws(() => parseCatalogView({ ...view, rows: [{ ...row("a"), ...bad }] }), /invalid row/u);
	}
	assert.throws(() => parseCatalogView({ ...view, updatedAt: "yesterday" }), /updatedAt/u);
	assert.throws(() => parseCatalogView({ ...view, storageId: "other" }), /storageId/u);
});

it("bounds complete metadata and final omission counts", () => {
	const updatedAt = "2026-01-01T00:00:00.000Z";
	assert.throws(() => boundCatalogView({ updatedAt, rows: [], unavailable: "x".repeat(CATALOG_VIEW_BUDGET_BYTES) }), /budget/u);
	assert.throws(() => boundCatalogView({ updatedAt, rows: [], storageId: "x".repeat(CATALOG_VIEW_BUDGET_BYTES) }), /budget/u);
	const rows = [row("root", { name: "x".repeat(CATALOG_VIEW_BUDGET_BYTES - 300) }), ...Array.from({ length: 1000 }, (_, index) => row(String(index)))];
	const result = boundCatalogView({ updatedAt, rows });
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= CATALOG_VIEW_BUDGET_BYTES);
	assert.equal(result.coverage.omitted, rows.length - result.rows.length);
});

it("refuses malformed and oversized views", () => {
	assert.throws(() => parseCatalogView({ updatedAt: "x", rows: "no" }), /rows/u);
	assert.throws(
		() => parseCatalogView({ updatedAt: "x", rows: [], coverage: { complete: false, omitted: -1 } }),
		/coverage/u,
	);
	assert.throws(
		() =>
			parseCatalogView({ updatedAt: "x", rows: [{ id: "a" }], coverage: { complete: true, omitted: 0 }, storageId: 1 }),
		/storageId/u,
	);
	const oversized = {
		updatedAt: "x",
		rows: [row("a", { latestReply: "x".repeat(CATALOG_VIEW_BUDGET_BYTES) })],
		coverage: { complete: true, omitted: 0 },
	};
	assert.throws(() => parseCatalogView(oversized), /budget/u);
	assert.equal(isCatalogView(oversized), false);
});
