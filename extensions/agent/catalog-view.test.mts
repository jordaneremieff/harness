import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { AgentMetaDoc, recordAdmissionMeta, publishConversationIntent, projectConversationIntents, type NativeIntentMetadata } from "./durable-controls.ts";
import { AgentConversationSummarySchema } from "./observation-schema.ts";
import type { CatalogAttentionHints } from "./catalog-attention.ts";
import {
	boundCatalogView,
	CATALOG_VIEW_BUDGET_BYTES,
	CATALOG_VIEW_TEXT_LIMIT,
	type CatalogViewRow,
	isCatalogView,
	parseCatalogView,
	withAttentionHints,
	withIntentClaims,
	withProfileHints,
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

it("keeps catalogue row validation equal to the schema for malformed field values", () => {
	const base = row("root");
	const fields = [...Object.keys(base), "name", "latestReply", "currentTool", "model", "toolCalls", "durationMs"];
	const values = [undefined, null, false, true, -1, 0, Number.NaN, Number.POSITIVE_INFINITY, "", "text", [], {}, { name: "read", argument: "file" }];
	for (const field of fields) for (const value of values) {
		const candidate = { ...base, [field]: value };
		const view = { updatedAt: "2026-01-01T00:00:00.000Z", rows: [candidate], coverage: { complete: true, omitted: 0 } };
		assert.equal(isCatalogView(view), Value.Check(AgentConversationSummarySchema, candidate), `${field}: ${String(value)}`);
	}
});

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
	assert.ok((view.rows[0]?.latestReply ?? "").length <= CATALOG_VIEW_TEXT_LIMIT);
	assert.match(view.rows[0]?.latestReply ?? "", /\[…\]/u);
	assert.ok((view.rows[0]?.currentTool?.argument ?? "").length <= CATALOG_VIEW_TEXT_LIMIT);
	assert.equal(view.coverage.complete, false, "a trimmed row reports partial coverage");
});

it("includes the truncation marker within the text limit without splitting surrogate pairs", () => {
	for (const prefixLength of [CATALOG_VIEW_TEXT_LIMIT - 6, CATALOG_VIEW_TEXT_LIMIT - 5]) {
		const prefix = "x".repeat(prefixLength);
		const text = `${prefix}😀${"y".repeat(100)}`;
		const view = boundCatalogView({
			updatedAt: "2026-01-01T00:00:00.000Z",
			rows: [row("root", { latestReply: text, currentTool: { name: "read", argument: text } })],
		});
		const expected = `${prefix}${prefixLength === CATALOG_VIEW_TEXT_LIMIT - 6 ? "😀" : ""} […]`;
		assert.equal(view.rows[0]?.latestReply, expected);
		assert.equal(view.rows[0]?.currentTool?.argument, expected);
		assert.ok(expected.length <= CATALOG_VIEW_TEXT_LIMIT);
		assert.doesNotMatch(expected, /[\ud800-\udfff]/u);
		assert.equal(view.coverage.complete, false);
	}
});

it("preserves text at the exact limit, including a final surrogate pair", () => {
	const text = `${"x".repeat(CATALOG_VIEW_TEXT_LIMIT - 2)}😀`;
	const view = boundCatalogView({
		updatedAt: "2026-01-01T00:00:00.000Z",
		rows: [row("root", { latestReply: text, currentTool: { name: "read", argument: text } })],
	});
	assert.equal(view.rows[0]?.latestReply, text);
	assert.equal(view.rows[0]?.currentTool?.argument, text);
	assert.equal(view.coverage.complete, true);
});

it("captures first-message metadata at valid surrogate boundaries before catalog publication", async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	t.after(() => harness.close(context));
	await harness.root(context);
	for (const [text, expected] of [
		[`${"x".repeat(1199)}😀tail`, "x".repeat(1199)],
		[`${"x".repeat(1198)}😀tail`, `${"x".repeat(1198)}😀`],
		[`${"x".repeat(1198)}😀`, `${"x".repeat(1198)}😀`],
		[`${"x".repeat(1200)}😀`, "x".repeat(1200)],
	] as const) {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		await harness.commit((tx) => recordAdmissionMeta(tx, conversation.id, text), context);
		const meta = await harness.snapshot(AgentMetaDoc, conversation.id, context);
		assert.equal(meta?.firstMessage, expected);
		const view = boundCatalogView({ updatedAt: "2026-01-01T00:00:00.000Z", rows: [row("root", { firstMessage: meta?.firstMessage ?? undefined })] });
		assert.equal(view.rows[0]?.firstMessage, expected);
		assert.ok((view.rows[0]?.firstMessage ?? "").length <= 1200);
		assert.doesNotMatch(view.rows[0]?.firstMessage ?? "", /[\ud800-\udfff]/u);
	}
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

it("publishes attention as top-level hints without changing native rows", () => {
	const base = boundCatalogView({ updatedAt: "2026-01-01T00:00:00.000Z", rows: [row("root")] });
	const hints: CatalogAttentionHints = { rows: [{ identity: "root", kind: "provider-blocked", blockId: "block-a" }], coverage: { complete: true, omitted: 0 } };
	const view = withAttentionHints(base, hints);
	assert.deepEqual(view.attention, hints);
	assert.deepEqual(view.rows, base.rows);
	assert.ok(view.rows.every((candidate) => Value.Check(AgentConversationSummarySchema, candidate)));
	assert.deepEqual(parseCatalogView(JSON.parse(JSON.stringify(view))), view);
	assert.deepEqual(withAttentionHints(view, { rows: [], coverage: { complete: true, omitted: 0 } }).attention?.rows, []);
});

it("omits attention hints before operational rows and reports the omitted hints", () => {
	const updatedAt = "2026-01-01T00:00:00.000Z";
	const base = boundCatalogView({ updatedAt, rows: [row("root", { name: "" }), row("child")] });
	const first = { identity: "root", kind: "failed-turn" as const };
	const second = { identity: "child", kind: "failed-turn" as const };
	const single = withAttentionHints(base, { rows: [first], coverage: { complete: false, omitted: 1 } });
	const padding = CATALOG_VIEW_BUDGET_BYTES - Buffer.byteLength(JSON.stringify(single));
	const padded = boundCatalogView({ updatedAt, rows: [row("root", { name: "x".repeat(padding) }), row("child")] });
	const view = withAttentionHints(padded, { rows: [first, second], coverage: { complete: true, omitted: 0 } });
	assert.deepEqual(view.rows, padded.rows);
	assert.deepEqual(view.coverage, padded.coverage);
	assert.deepEqual(view.attention, { rows: [first], coverage: { complete: false, omitted: 1 } });
	assert.ok(Buffer.byteLength(JSON.stringify(view)) <= CATALOG_VIEW_BUDGET_BYTES);
	const fullPadding = CATALOG_VIEW_BUDGET_BYTES - Buffer.byteLength(JSON.stringify(base)) - 1;
	const full = boundCatalogView({ updatedAt, rows: [row("root", { name: "x".repeat(fullPadding) }), row("child")] });
	assert.equal(full.rows.length, base.rows.length);
	assert.equal(full.coverage.complete, true);
	assert.equal(Buffer.byteLength(JSON.stringify(full)), CATALOG_VIEW_BUDGET_BYTES - 1);
	const withoutHints = withAttentionHints(full, { rows: [first], coverage: { complete: true, omitted: 0 } });
	assert.deepEqual(withoutHints.rows, full.rows);
	assert.equal(withoutHints.attention, undefined, "no space for hint coverage leaves attention unknown");
});

it("validates a closed attention schema and unique retained row identities", () => {
	const base = boundCatalogView({ updatedAt: "2026-01-01T00:00:00.000Z", rows: [row("root")] });
	const hint = { identity: "root", kind: "failed-turn" };
	for (const rows of [
		[{ ...hint, extra: true }],
		[{ identity: "root", kind: "provider-retry" }],
		[{ identity: "root", kind: "task-blocked", taskId: 1, reason: "awaiting_input" }],
		[{ identity: "other", kind: "failed-turn" }],
		[hint, hint],
	]) {
		assert.throws(() => parseCatalogView({ ...base, attention: { rows, coverage: { complete: true, omitted: 0 } } }), /attention/u);
	}
	assert.throws(() => parseCatalogView({ ...base, rows: [{ ...row("root"), attention: hint }] }), /invalid row/u);
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

function nativeIntent(overrides: Partial<NativeIntentMetadata> = {}): NativeIntentMetadata {
	return { cwd: "/work", repository: null, repositoryState: "outside-git", hostname: "fixture-host", startedAt: "2026-01-01T00:00:00.000Z", taskId: 2,
		claim: { purpose: "Native plan", integration: "i".repeat(2048), authority: "a".repeat(2048), scope: { paths: ["extensions/agent"], branches: ["topic"], fullGate: true }, updatedAt: "2026-01-01T00:00:00.000Z" }, ...overrides };
}

it("keeps profiles, attention and operational rows before whole native claims under budget pressure", () => {
	const rows = Array.from({ length: 18 }, (_, index) => row(index === 0 ? "storage" : `storage:${index + 1}`, { latestReply: "x".repeat(500) }));
	const base = boundCatalogView({ updatedAt: "2026-01-01T00:00:00.000Z", storageId: "storage", rows });
	const profiles = withProfileHints(base, { rows: rows.slice(0, 6).map(candidate => ({ identity: candidate.id, handle: null, role: "r".repeat(128), revision: "a".repeat(64), hasExpertise: false, updatedAt: null })), coverage: { complete: true, omitted: 0 } });
	const attentive = withAttentionHints(profiles, { rows: [{ identity: "storage", kind: "failed-turn" }], coverage: { complete: true, omitted: 0 } });
	const metadata = nativeIntent();
	const view = withIntentClaims(attentive, { rows: Object.fromEntries(rows.map(candidate => [candidate.id, metadata])), coverage: { complete: true, omitted: 0 } });
	assert.deepEqual(view.rows, attentive.rows);
	assert.deepEqual(view.profiles, attentive.profiles);
	assert.deepEqual(view.attention, attentive.attention);
	assert.ok(view.intentClaims);
	const kept = Object.values(view.intentClaims.rows);
	assert.ok(kept.length > 0 && kept.length < rows.length);
	for (const item of kept) assert.deepEqual(item, metadata);
	assert.deepEqual(view.intentClaims?.coverage, { complete: false, omitted: rows.length - kept.length });
	assert.ok(Buffer.byteLength(JSON.stringify(view)) <= CATALOG_VIEW_BUDGET_BYTES);
	assert.deepEqual(parseCatalogView(JSON.parse(JSON.stringify(view))).intentClaims, JSON.parse(JSON.stringify(view.intentClaims)));
});

it("rejects foreign identities, stale cwd, corrupt claims and contradictory native coverage", () => {
	const base = boundCatalogView({ updatedAt: "2026-01-01T00:00:00.000Z", storageId: "storage", rows: [row("storage")] });
	const hints = { rows: { storage: nativeIntent() }, coverage: { complete: true, omitted: 0 } };
	assert.equal(parseCatalogView({ ...base, intentClaims: { ...hints, rows: { storage: null } } }).intentClaims?.rows.storage, null);
	for (const rows of [{ foreign: nativeIntent() }, { storage: nativeIntent({ cwd: "/elsewhere" }) }, { storage: { ...nativeIntent(), taskId: "bad" } }]) assert.throws(() => parseCatalogView({ ...base, intentClaims: { ...hints, rows } }), /Native intent/u);
	assert.throws(() => parseCatalogView({ ...base, rows: [row("foreign:2")], intentClaims: { ...hints, rows: { "foreign:2": nativeIntent() } } }), /different storage/u);
	assert.throws(() => parseCatalogView({ ...base, intentClaims: { ...hints, coverage: { complete: true, omitted: 2 } } }), /coverage/u);
	const omitted = withIntentClaims(base, { ...hints, rows: { missing: nativeIntent() } });
	assert.deepEqual(omitted.intentClaims?.coverage, { complete: false, omitted: 1 });
});

it("orders native writes by tool task, isolates documents and omits only known stale claims", async t => {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	t.after(() => harness.close(context));
	const root = await harness.root(context), child = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	await harness.commit(tx => publishConversationIntent(tx, root.id, nativeIntent({ taskId: 20 })), context);
	await harness.commit(tx => publishConversationIntent(tx, root.id, nativeIntent({ claim: null, taskId: 21 })), context);
	await harness.commit(tx => publishConversationIntent(tx, root.id, nativeIntent({ taskId: 20 })), context);
	assert.equal((await harness.snapshot(AgentMetaDoc, root.id, context))?.intent?.claim, null);
	await harness.commit(async tx => { const doc = await tx.doc(AgentMetaDoc, child.id); delete doc.intent; }, context);
	const rows = [row("storage"), row(`storage:${child.id}`)];
	assert.deepEqual(JSON.parse(JSON.stringify(await projectConversationIntents(harness, "storage", rows, context))), { rows: { storage: null }, coverage: { complete: true, omitted: 0 } });
	await harness.commit(tx => publishConversationIntent(tx, child.id, nativeIntent({ taskId: 22, cwd: "/stale" })), context);
	const projection = await projectConversationIntents(harness, "storage", rows, context);
	assert.equal(projection.rows.storage, null);
	assert.deepEqual(projection.coverage, { complete: false, omitted: 1 });
});
