import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Value } from "typebox/value";
import { AgentCatalog, type CatalogPage, type CatalogRecord } from "./catalog.ts";
import type { CatalogView, CatalogViewRow } from "./catalog-view.ts";
import { FleetStatusSchema, readFleetStatus, type FleetStatus } from "./fleet-status.ts";
import { USAGE_WEEK_MS, type ModelEvidence, type ModelFailure, type ModelWarning, type UsageSample } from "./model-evidence.ts";

const observedAt = "2026-10-01T00:00:00.000Z";
function sampled(samples: UsageSample[], at = observedAt): ModelEvidence {
	return evidence({ sampling: { observedAt: at, samples, entriesVisited: samples.length, entriesOmitted: 0,
		messagesOmitted: 0, invalidSamples: 0, omittedSamples: 0 } });
}

it("uses exact inclusive rolling cutoffs at read time, not publication time", async () => {
	const now = Date.parse(observedAt);
	const hour = 60 * 60 * 1000;
	const samples = [now, now - 5 * hour, now - 5 * hour - 1, now - USAGE_WEEK_MS, now - USAGE_WEEK_MS - 1, now + 1]
		.map((at) => ({ model: "sample/a", at, tokens: 10, reportedCost: 0.1 }));
	const input = record("storage-a", [], sampled(samples));
	const catalog = new FixtureCatalog([page([input, input])]);
	const result = await readFleetStatus(catalog, { now }); check(result);
	assert.deepEqual(result.models[0].usage, { last5h: { tokens: 20, reportedCost: 0.2, responses: 2 }, last7d: { tokens: 40, reportedCost: 0.4, responses: 4 } });
	assert.deepEqual(result.providers[0].usage, result.models[0].usage);
	assert.equal(result.usageCoverage.publications, 1, "duplicate storage is counted once");
	const later = await readFleetStatus(catalog, { now: now + USAGE_WEEK_MS + 1 }); check(later);
	assert.equal(later.models[0]?.usage?.last7d.responses ?? 0, 0, "expired and publication-future samples stay excluded");
	assert.equal(later.usageCoverage.oldestPublicationAt, observedAt);
	assert.equal(later.usageCoverage.status, "partial");
});

it("aggregates exact models into providers while distinguishing unknown publications", async () => {
	const now = Date.parse(observedAt);
	const records = [record("a", [], sampled([{ model: "sample/a", at: now, tokens: 10, reportedCost: 1 }])),
		record("b", [], sampled([{ model: "sample/b", at: now, tokens: 20, reportedCost: 2 }])), record("unknown")];
	const result = await readFleetStatus(new FixtureCatalog([page(records)]), { now }); check(result);
	assert.equal(result.providers[0].usage.last7d.tokens, 30);
	assert.equal(result.models.reduce((sum, model) => sum + (model.usage?.last7d.tokens ?? 0), 0), 30);
	assert.equal(result.usageCoverage.unknownStorages, 1);
	assert.equal(result.usageCoverage.publications, 2);
	assert.match(result.notes.join(" "), /Zero samples do not prove zero usage/u);
});

it("reserves bounded output for both provider and model windows with truthful omissions", async () => {
	const now = Date.parse(observedAt);
	const samples = Array.from({ length: 16 }, (_, index) => ({ model: `p${index}/m`, at: now, tokens: 1, reportedCost: 1 }));
	const result = await readFleetStatus(new FixtureCatalog([page([record("a", [], sampled(samples))])]), { now }); check(result);
	assert.ok(result.models.length > 0);
	assert.ok(result.providers.length > 0);
	assert.equal(result.models.length + result.coverage.output.omittedModels, 16);
	assert.equal(result.providers.length + result.coverage.output.omittedProviders, 16);
	assert.equal(result.usageCoverage.sampledResponses, 16);
	assert.equal(result.usageCoverage.oldestSampleAt, now);
	assert.equal(result.usageCoverage.newestSampleAt, now);
	assert.equal(result.coverage.output.byteLimitReached, true);
});

it("omits malformed model identities without inventing provider attribution", async () => {
	const now = Date.parse(observedAt);
	const samples = ["broken", "b", "/model", "provider/", "provider/model/variant"].map((model) => ({ model, at: now, tokens: 1, reportedCost: 1 }));
	const result = await readFleetStatus(new FixtureCatalog([page([record("a", [], sampled(samples))])]), { now }); check(result);
	assert.equal(result.usageCoverage.invalidSamples, 4);
	assert.equal(result.usageCoverage.sampledResponses, 1);
	assert.deepEqual(result.providers.map((item) => item.provider), ["provider"]);
	assert.deepEqual(result.models.map((item) => item.model), ["provider/model/variant"]);
});

it("omits overflowing sample contributions and member costs without invalid JSON totals", async () => {
	const now = Date.parse(observedAt);
	const samples = ["sample/a", "sample/a", "sample/b"].map((model) => ({ model, at: now, tokens: Number.MAX_VALUE, reportedCost: Number.MAX_VALUE }));
	const source = record("a", [row("a", { cost: Number.MAX_VALUE }), row("a:2", { cost: Number.MAX_VALUE })], sampled(samples));
	const result = await readFleetStatus(new FixtureCatalog([page([source])]), { now, effort: { callerId: "a", created: ["a:2"] } }); check(result);
	assert.equal(result.usageCoverage.invalidSamples, 2);
	assert.equal(result.usageCoverage.sampledResponses, 1);
	assert.equal(result.providers[0].usage.last5h.tokens, Number.MAX_VALUE);
	assert.equal(result.providers[0].usage.last7d.reportedCost, Number.MAX_VALUE);
	assert.equal(result.effort.reportedCost, Number.MAX_VALUE);
	assert.equal(result.effort.status, "partial");
	assert.equal(result.effort.missingMembers, 1);
});

it("normalizes publication timestamps and treats malformed publication time as unknown", async () => {
	const now = Date.parse(observedAt);
	const sample = { model: "sample/a", at: now, tokens: 1, reportedCost: 1 };
	const padded = `${" ".repeat(1500)}October 1, 2026 GMT`;
	const result = await readFleetStatus(new FixtureCatalog([page([record("a", [], sampled([sample], padded)), record("b", [], sampled([sample], "invalid"))])]), { now }); check(result);
	assert.equal(result.usageCoverage.unknownStorages, 1);
	assert.equal(result.usageCoverage.oldestPublicationAt, observedAt);
	assert.equal(result.usageCoverage.newestPublicationAt, observedAt);
	assert.equal(result.usageCoverage.sampledResponses, 1);
});

it("totals caller and explicit direct-created identities once, with missing and partial membership", async () => {
	const records = [record("parent", [row("parent", { cost: 1 }), row("parent:2", { cost: 2 }), row("parent:3", { cost: 90 })]),
		record("foreign", [row("foreign", { cost: 3, partial: true }), row("foreign:2", { cost: 80 })])];
	const result = await readFleetStatus(new FixtureCatalog([page(records)]), { effort: { callerId: "parent", created: ["parent:2", "foreign", "foreign", "missing"], omitted: 2 } }); check(result);
	assert.deepEqual(result.effort, { status: "partial", scope: "caller-and-direct-created-lifetime", membership: "creation-records",
		members: 4, observedMembers: 3, missingMembers: 1, partialMembers: 1, omittedMembers: 2, reportedCost: 6 });
});

it("uses catalog creation owners for ordinary callers without assuming storage or cwd membership", async () => {
	const child = { ...record("child", [row("child", { cost: 2 }), row("child:2", { cost: 50 })]), ownerId: "primary" };
	const unrelated = { ...record("unrelated", [row("unrelated", { cost: 90 })]), ownerId: "other" };
	const catalog = new FixtureCatalog([page([child, unrelated])]);
	const known = await readFleetStatus(catalog, { effort: { callerId: "primary", callerUsage: { reportedCost: 3, partial: false } } }); check(known);
	assert.deepEqual(known.effort, { status: "observed", scope: "caller-and-direct-created-lifetime", membership: "catalog-owner",
		members: 2, observedMembers: 2, missingMembers: 0, partialMembers: 0, omittedMembers: 0, reportedCost: 5 });
	const missing = await readFleetStatus(catalog, { effort: { callerId: "primary" } }); check(missing);
	assert.equal(missing.effort.reportedCost, 2);
	assert.equal(missing.effort.missingMembers, 1);
	assert.equal(missing.effort.status, "partial");
});
const selected = (modelId = "selected", thinkingLevel = "high") => ({ provider: "sample", modelId, thinkingLevel });
function row(id: string, fields: Partial<CatalogViewRow> = {}): CatalogViewRow {
	return { id, storageId: "storage-a", cwd: "/work", modifiedAt: 1, owner: "here", state: "idle", cost: 0, partial: false, ...fields };
}
function evidence(fields: Partial<ModelEvidence> = {}): ModelEvidence {
	return { models: [], failures: [], warnings: [], toolReportedCost: 0,
		coverage: { conversationsVisited: 1, conversationsComplete: true, unavailableUsage: 0,
			incompleteHistory: 0, omittedModels: 0, omittedFailures: 0, omittedWarnings: 0 }, ...fields };
}
function record(storageId: string, rows: CatalogViewRow[] = [], modelEvidence?: ModelEvidence, viewFields: Partial<CatalogView> = {}): CatalogRecord {
	return { storageId, storagePath: `/work/${storageId}.sqlite`, cwd: "/work", agentDir: "/work", packageDir: "/work",
		model: { provider: "creation", modelId: "not-current" }, thinkingLevel: "off", createdAt: observedAt,
		view: { updatedAt: observedAt, rows, coverage: { complete: true, omitted: 0 },
			...(modelEvidence === undefined ? {} : { modelEvidence }), ...viewFields } };
}
function page(records: CatalogRecord[], nextCursor: string | null = null, fields: Partial<CatalogPage["coverage"]> = {}): CatalogPage {
	return { records, recordCursors: records.map((_, index) => `record-${index}`), nextCursor, observedAt,
		coverage: { visited: records.length, skipped: 0, complete: nextCursor === null, ...fields } };
}
class FixtureCatalog extends AgentCatalog {
	readonly pages: CatalogPage[];
	readonly calls: Parameters<AgentCatalog["page"]>[0][] = [];
	constructor(pages: CatalogPage[]) { super("/work/fleet"); this.pages = pages; }
	override async page(options: Parameters<AgentCatalog["page"]>[0] = {}): Promise<CatalogPage> {
		this.calls.push(options);
		const index = options.cursor === undefined ? 0 : Number(options.cursor);
		assert.equal(options.limit, 20);
		assert.ok(this.pages[index], `unexpected catalog page ${index}`);
		return this.pages[index];
	}
}
async function read(records: CatalogRecord[]): Promise<FleetStatus> {
	const result = await readFleetStatus(new FixtureCatalog([page(records)]));
	check(result);
	return result;
}
function check(value: FleetStatus): void {
	assert.equal(Value.Check(FleetStatusSchema, value), true, JSON.stringify([...Value.Errors(FleetStatusSchema, value)]));
	assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") <= 4096);
	assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
	assert.equal(value.view, "fleet");
	assert.equal(new Date(value.observedAt).toISOString(), value.observedAt);
	assert.equal("nextCursor" in value.coverage.catalog, false);
}
function failure(provider: string, at: number, fields: Partial<ModelFailure> = {}): ModelFailure {
	return { provider, modelId: "model", at, conversationId: "storage-a:1", entryId: 1, message: "sample failure", ...fields };
}
function warning(conversationId: string, fields: Partial<ModelWarning> = {}): ModelWarning {
	return { conversationId, observedAt, kind: "error", message: "observed warning", ...fields };
}

it("keeps reconfigured selections separate from model and tool usage", async () => {
	const result = await read([
		record("storage-a", [row("storage-a:1", { model: selected("new"), state: "working", cost: 900 })], evidence({
			models: [{ model: "sample/old/path", reportedCost: 3, lastResponseAt: 10 }], toolReportedCost: 5,
		})),
		record("storage-b", [row("storage-b:1", { model: selected("new", "low"), cost: 700 })], evidence({
			models: [{ model: "sample/old/path", reportedCost: 7, lastResponseAt: 20 }, { model: "sample/free", reportedCost: 0, lastResponseAt: 0 }],
			toolReportedCost: 2,
		})),
	]);
	assert.deepEqual(result.models, [
		{ model: "sample/free", reportedCost: 0, lastResponseAt: 0, currentSelections: [], activeConversations: 0 },
		{ model: "sample/new", reportedCost: null, currentSelections: [{ thinkingLevel: "high", count: 1 }, { thinkingLevel: "low", count: 1 }], activeConversations: 1 },
		{ model: "sample/old/path", reportedCost: 10, lastResponseAt: 20, currentSelections: [], activeConversations: 0 },
	]);
	assert.equal(result.toolReportedCost, 7);
	assert.match(result.notes.join(" "), /not invoices or remaining allowance/u);
	assert.match(result.notes.join(" "), /Past use is not preference/u);
});

it("counts missing evidence as unknown and ignores creation defaults and operational row costs", async () => {
	const absent = record("storage-b"); delete absent.view;
	const result = await read([record("storage-a", [row("a", { model: selected(), cost: 44 })]), absent]);
	assert.equal(result.toolReportedCost, null);
	assert.equal(result.models[0].reportedCost, null);
	assert.equal(result.models[0].lastResponseAt, undefined);
	assert.equal(result.models.length, 1);
	assert.equal(result.coverage.unknownEvidenceStorages, 2);
	assert.equal(result.coverage.unknownOperationalStorages, 1);
	assert.equal(result.coverage.evidence.conversationsVisited, 0);
	assert.equal(result.coverage.evidence.conversationsComplete, false);
});

it("does not turn unavailable usage into a known zero tool cost", async () => {
	const missing = evidence(); missing.coverage.unavailableUsage = 1;
	const result = await read([record("storage-a", [], missing)]);
	assert.equal(result.toolReportedCost, null);
	assert.equal(result.coverage.evidence.unavailableUsage, 1);
	const known = await read([record("storage-a", [], evidence())]);
	assert.equal(known.toolReportedCost, 0);
});

it("groups current selections by thinking level and counts active conversations without identities", async () => {
	const rows = [
		row("a", { model: selected(), state: "working" }), row("b", { model: selected(), state: "starting" }),
		row("c", { model: selected(), state: "idle" }), row("d", { model: selected("selected", "off"), state: "failed" }),
		row("e", { model: selected("selected", "off"), state: "interrupted" }), row("f", { state: "working" }),
	];
	const result = await read([record("storage-a", [...rows, rows[0]])]);
	assert.deepEqual(result.conversations, { observed: 6, active: 3, unknownModel: 1 });
	assert.deepEqual(result.models[0].currentSelections, [{ thinkingLevel: "high", count: 3 }, { thinkingLevel: "off", count: 2 }]);
	assert.equal(result.models[0].activeConversations, 2);
	assert.equal(JSON.stringify(result.models).includes("conversationId"), false);
	assert.match(result.notes.join(" "), /Active means starting or working/u);
});

it("selects only the latest failure per provider with deterministic ties and newest-first order", async () => {
	const candidates = [
		failure("zeta", 30), failure("alpha", 40, { modelId: "z-model" }),
		failure("alpha", 40, { modelId: "a-model", conversationId: "storage-a:2" }),
		failure("alpha", 40, { modelId: "a-model", conversationId: "storage-a:1", entryId: 3 }),
		failure("alpha", 40, { modelId: "a-model", conversationId: "storage-a:1", entryId: 8 }),
		failure("beta", 40), failure("zeta", 1), failure("delta", 50), failure("epsilon", 20),
	];
	const firstEvidence = evidence({ failures: [...candidates, candidates[4]] });
	firstEvidence.coverage.omittedFailures = 2;
	const secondEvidence = evidence({ failures: [...candidates].reverse() });
	secondEvidence.coverage.omittedFailures = 3;
	const first = record("storage-a", [], firstEvidence);
	const second = record("storage-b", [], secondEvidence);
	const result = await read([first, second]);
	assert.deepEqual(result.failures.map(({ provider }) => provider), ["delta", "alpha", "beta", "zeta"]);
	assert.equal(result.failures[1].entryId, 8);
	assert.equal(result.failures[1].modelId, "a-model");
	assert.equal(result.coverage.evidence.omittedFailures, 5, "source omissions remain separate from sample reduction");
	assert.equal(result.coverage.output.omittedFailures, 1, "only latest-provider candidates face output bounds");
	assert.match(result.notes.join(" "), /Older and duplicate samples are intentionally replaced, not counted as output omissions/u);
	assert.match(result.notes.join(" "), /Output failure omissions count only latest-provider candidates excluded by bounds/u);
	assert.deepEqual((await read([second, first])).failures, result.failures);
});

it("samples warnings as observed conversation state, separate from provider failures", async () => {
	const warnings = Array.from({ length: 7 }, (_, index) => warning(`storage-a:${index}`, { kind: "autoRetry", model: selected() }));
	warnings[6].observedAt = "2026-10-02T00:00:00.000Z";
	const result = await read([record("storage-a", [], evidence({ warnings }))]);
	assert.equal(result.failures.length, 0);
	assert.equal(result.warnings.length, 4);
	assert.deepEqual(result.warnings.map((entry) => entry.conversationId), ["storage-a:6", "storage-a:0", "storage-a:1", "storage-a:2"]);
	assert.equal(result.coverage.output.omittedWarnings, 3);
	assert.match(result.notes.join(" "), /sampled observed conversation state, not provider faults/u);
	assert.deepEqual(result.warnings[0].model, selected());
});

it("sums all source coverage independently of output omissions across empty and populated pages", async () => {
	const first = evidence({ models: [{ model: "sample/a", reportedCost: 1 }] });
	first.coverage = { conversationsVisited: 5, conversationsComplete: true, unavailableUsage: 2, incompleteHistory: 3,
		omittedModels: 4, omittedFailures: 5, omittedWarnings: 6 };
	const second = evidence();
	second.coverage = { conversationsVisited: 7, conversationsComplete: false, unavailableUsage: 3, incompleteHistory: 4,
		omittedModels: 8, omittedFailures: 9, omittedWarnings: 10 };
	const a = record("storage-a", [], first, { coverage: { complete: false, omitted: 11 } });
	const b = record("storage-b", [], second, { coverage: { complete: false, omitted: 12 } });
	const unavailable = record("storage-c", [], undefined, { unavailable: "sample unavailable", coverage: { complete: false, omitted: 2 } });
	const catalog = new FixtureCatalog([page([], "1", { visited: 256, skipped: 3 }), page([a], "2", { visited: 4, skipped: 1 }), page([a, b, unavailable], null, { visited: 5 })]);
	const result = await readFleetStatus(catalog); check(result);
	assert.deepEqual(result.coverage.catalog, { pages: 3, records: 3, visited: 265, skipped: 4, complete: true,
		hasMore: false, scanLimitReached: false, maxPages: 16, pageLimit: 20 });
	assert.deepEqual(result.coverage.evidence, { conversationsVisited: 12, conversationsComplete: false,
		unavailableUsage: 5, incompleteHistory: 7, omittedModels: 12, omittedFailures: 14, omittedWarnings: 16 });
	assert.equal(result.coverage.omittedOperationalRows, 25);
	assert.equal(result.coverage.incompleteOperationalStorages, 2);
	assert.equal(result.coverage.unknownOperationalStorages, 1);
	assert.equal(result.coverage.unknownEvidenceStorages, 1);
	assert.equal(result.coverage.output.omittedModels, 0);
	assert.deepEqual(catalog.calls, [{ limit: 20 }, { limit: 20, cursor: "1" }, { limit: 20, cursor: "2" }]);
});

it("stops at sixteen pages, hides unusable cursors, and restarts on the next call", async () => {
	const catalog = new FixtureCatalog(Array.from({ length: 17 }, (_, index) => page([], String(index + 1), { visited: 256, skipped: 1 })));
	const result = await readFleetStatus(catalog); check(result);
	assert.equal(catalog.calls.length, 16);
	assert.equal(result.coverage.catalog.pages, 16);
	assert.equal(result.coverage.catalog.visited, 4096);
	assert.equal(result.coverage.catalog.skipped, 16);
	assert.equal(result.coverage.catalog.complete, false);
	assert.equal(result.coverage.catalog.hasMore, true);
	assert.equal(result.coverage.catalog.scanLimitReached, true);
	assert.equal(JSON.stringify(result).includes("cursor"), false);
	assert.match(result.notes.join(" "), /restarts the scan; no continuation/u);
	await readFleetStatus(catalog);
	assert.deepEqual(catalog.calls[16], { limit: 20 });
});

it("orders exact model keys alphabetically and caps rows with selection omissions", async () => {
	const keys = Array.from({ length: 18 }, (_, index) => `sample/m${String(index).padStart(2, "0")}`);
	const rows = keys.map((_, index) => row(`row-${index}`, { model: selected(`m${String(index).padStart(2, "0")}`, "off"), state: "working" }));
	const result = await read([record("storage-a", rows.reverse(), evidence({ models: keys.toReversed().map((model) => ({ model, reportedCost: 0 })) }))]);
	assert.deepEqual(result.models.map((model) => model.model), keys.slice(0, 12));
	assert.equal(result.coverage.output.omittedModels, 6);
	assert.equal(result.coverage.output.omittedSelections, 6);
	assert.equal(result.coverage.output.omittedActiveConversations, 6);
	assert.equal(result.conversations.active, 18);
});

it("bounds escaped UTF-8 JSON, omits whole targets, and preserves input snapshots", async () => {
	const oversized = `a/${"🧭".repeat(1100)}`;
	const source = evidence({
		models: [{ model: oversized, reportedCost: 1 }, ...Array.from({ length: 20 }, (_, index) => ({ model: `sample/${"🧭".repeat(90)}-${index}`, reportedCost: index }))],
		failures: [failure("oversized", 900, { conversationId: "🧭".repeat(1200) }),
			...Array.from({ length: 8 }, (_, index) => failure(`p${index}`, 100 - index, { message: "😀\n\"".repeat(200) }))],
		warnings: [warning("🧭".repeat(1200)), ...Array.from({ length: 8 }, (_, index) => warning(`w${index}`, { message: "😀\n\"".repeat(200) }))],
	});
	const rows = [row("row-big", { model: { provider: "a", modelId: "🧭".repeat(1100), thinkingLevel: "high" }, state: "working" })];
	const input = record("storage-a", rows, source);
	const before = JSON.stringify(input);
	const result = await read([input]);
	assert.equal(JSON.stringify(input), before);
	assert.equal(result.coverage.output.byteLimitReached, true);
	assert.ok(!result.models.some((model) => model.model === oversized));
	assert.equal(result.models.length + result.coverage.output.omittedModels, 21);
	assert.equal(result.failures.length + result.coverage.output.omittedFailures, 9);
	assert.equal(result.warnings.length + result.coverage.output.omittedWarnings, 9);
	assert.equal(result.coverage.output.omittedSelections, 1);
	assert.equal(result.coverage.output.omittedActiveConversations, 1);
	for (const model of result.models) assert.ok(source.models.some((candidate) => candidate.model === model.model));
	for (const entry of result.failures) {
		assert.ok(source.failures.some((candidate) => candidate.provider === entry.provider && candidate.conversationId === entry.conversationId));
		assert.ok([...entry.message].length <= 160);
		assert.ok(!entry.message.includes("\uFFFD"));
	}
	assert.ok(result.failures.length > 0);
	assert.ok(result.failures[0].message.endsWith("…"));
});

it("reads an empty catalog and a stored publication without opening storage or hosts", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "fleet-status-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const catalog = new AgentCatalog(root);
	const empty = await readFleetStatus(catalog); check(empty);
	assert.deepEqual(empty.models, []);
	assert.deepEqual(empty.failures, []);
	assert.deepEqual(empty.warnings, []);
	assert.equal(empty.toolReportedCost, null);
	assert.equal(empty.coverage.catalog.complete, true);
	assert.equal(empty.coverage.unknownEvidenceStorages, 0);
	const stored = catalog.create({ cwd: root, agentDir: root, packageDir: root, model: { provider: "sample", modelId: "selected" }, thinkingLevel: "off" });
	catalog.updateView(stored.storageId, { updatedAt: observedAt, storageId: stored.storageId,
		rows: [row(`${stored.storageId}:1`, { storageId: stored.storageId, model: selected(), cost: 900 })],
		coverage: { complete: true, omitted: 0 }, modelEvidence: evidence({ models: [{ model: "sample/past", reportedCost: 3 }] }) });
	const result = await readFleetStatus(catalog); check(result);
	assert.deepEqual(result.models.map(({ model, reportedCost }) => ({ model, reportedCost })), [
		{ model: "sample/past", reportedCost: 3 }, { model: "sample/selected", reportedCost: null },
	]);
	assert.deepEqual(readdirSync(catalog.root), [`${stored.storageId}.json`]);
	assert.equal(Value.Check(FleetStatusSchema, { ...result, extra: true }), false);
});
