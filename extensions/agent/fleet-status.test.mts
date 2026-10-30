import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Value } from "typebox/value";
import { AgentCatalog, type CatalogPage, type CatalogRecord } from "./catalog.ts";
import type { CatalogView, CatalogViewRow } from "./catalog-view.ts";
import { FleetStatusSchema, readFleetStatus, validateFleetSelection, type FleetStatus } from "./fleet-status.ts";
import { ModelEvidenceSchema, USAGE_WEEK_MS, type ModelEvidence, type ModelFailure, type ModelWarning, type UsageSample } from "./model-evidence.ts";

const observedAt = "2026-10-01T00:00:00.000Z";
function sampled(samples: UsageSample[], at = observedAt): ModelEvidence {
	return evidence({ sampling: { observedAt: at, samples, entriesVisited: samples.length, entriesOmitted: 0,
		messagesOmitted: 0, invalidSamples: 0, omittedSamples: 0 } });
}

it("exposes selected candidate facts from the same publication snapshot when broad output omits them", async () => {
	const now = Date.parse(observedAt);
	const distractors = Array.from({ length: 18 }, (_, index) => `alpha/m${String(index).padStart(2, "0")}`);
	const candidates = ["zulu/model-a", "zulu/model-b"];
	const records = [record("distractors", [], sampled(distractors.map((model) => ({ model, at: now, tokens: 1000, reportedCost: 10 })))),
		...candidates.map((model, index) => record(`candidate-${index}`, [row(`candidate-${index}`, { model: { provider: "zulu", modelId: `model-${index ? "b" : "a"}`, thinkingLevel: "high" }, state: "working", cost: 7 + index })],
			{ ...sampled([{ model, at: now, tokens: 10 + index, reportedCost: 1 + index }]), models: [{ model, reportedCost: 3 + index, lastResponseAt: now }],
				failures: [failure("zulu", now - index, { modelId: `model-${index ? "b" : "a"}`, message: `candidate-${index} failure` })] })),
		record("unknown", [row("unknown-model", { state: "working" })])];
	const snapshot = JSON.stringify(records);
	const catalog = new FixtureCatalog([page(records)]);
	const effort = { callerId: "candidate-0", created: ["candidate-1"] };
	const broad = await readFleetStatus(catalog, { now, effort }); check(broad);
	assert.equal(broad.selection, undefined);
	assert.equal(broad.coverage.output.byteLimitReached, true);
	assert.ok(candidates.every((model) => !broad.models.some((row) => row.model === model)));
	for (const [index, model] of candidates.entries()) {
		const result = await readFleetStatus(catalog, { now, effort, model }); check(result);
		assert.deepEqual(result.models.map((row) => row.model), [model]);
		assert.equal(result.models[0].usage?.last7d.tokens, 10 + index);
		assert.equal(result.providers[0].usage.last7d.tokens, 10 + index, "same-provider siblings do not enter exact-model totals");
		assert.equal(result.failures[0]?.message, `candidate-${index} failure`);
		assert.deepEqual(result.selection?.matched, { models: 1, failures: 1, warnings: 0 });
		assert.equal(result.selection?.outcome, "matched");
		assert.equal(result.selection?.scope, "models-providers-failures-warnings");
		assert.equal(result.selection?.globalScope, "source-coverage-usageCoverage-conversations-toolReportedCost-effort");
		assert.deepEqual(result.usageCoverage, broad.usageCoverage);
		assert.deepEqual(result.conversations, broad.conversations);
		assert.deepEqual(result.effort, broad.effort);
		assert.deepEqual({ ...result.coverage, output: undefined }, { ...broad.coverage, output: undefined });
		assert.equal(result.coverage.output.omittedModels, 0);
	}
	assert.equal(JSON.stringify(records), snapshot);
	assert.deepEqual(catalog.calls, [{ limit: 20 }, { limit: 20 }, { limit: 20 }]);
});

it("prioritises selected usable model facts over crowded matching failure details", async () => {
	const now = Date.parse(observedAt);
	const modelId = "m".repeat(500);
	const model = `sample/${modelId}`;
	const records = Array.from({ length: 4 }, (_, index) => record(`source-${index}`, [], {
		...sampled([{ model, at: now, tokens: 10, reportedCost: 1 }]), models: [{ model, reportedCost: 2 }],
	}));
	const reference = await readFleetStatus(new FixtureCatalog([page(records)]), { now }); check(reference);
	assert.equal(reference.models.length, 1);
	const metadata = structuredClone(reference);
	metadata.models = []; metadata.providers = [];
	metadata.coverage.output.omittedModels = 1;
	metadata.coverage.output.omittedProviders = 1;
	metadata.coverage.output.omittedFailures = 1;
	const detail = failure("sample", now, { modelId, conversationId: "source-0:", message: "f".repeat(160) });
	const padding = 4096 - Buffer.byteLength(JSON.stringify(metadata)) - Buffer.byteLength(JSON.stringify(detail)) - 64;
	assert.ok(padding > 0);
	for (const [index, record] of records.entries()) {
		assert.ok(record.view?.modelEvidence);
		record.view.modelEvidence.failures = [{ ...detail, at: now - index, conversationId: `source-${index}:${"x".repeat(padding)}` }];
		assert.equal(Value.Check(ModelEvidenceSchema, record.view.modelEvidence), true);
		assert.ok(Buffer.byteLength(JSON.stringify(record.view.modelEvidence)) <= 4096);
	}
	const snapshot = JSON.stringify(records);
	const frozenRecords: CatalogRecord[] = JSON.parse(snapshot, (_key, value: unknown) => value !== null && typeof value === "object" ? Object.freeze(value) : value);
	const catalog = new FixtureCatalog([page(frozenRecords)]);
	const broad = await readFleetStatus(catalog, { now }); check(broad);
	const result = await readFleetStatus(catalog, { now, model }); check(result);
	assert.equal(broad.failures.length, 1, "the broad failure-first order stays unchanged");
	assert.equal(broad.models.length, 0);
	assert.equal(broad.coverage.output.omittedModels, 1);
	assert.equal(result.failures.length, 0);
	assert.equal(result.models[0]?.model, model);
	assert.equal(result.models[0].usage?.last7d.tokens, 40);
	assert.equal(result.selection?.matched.failures, 1, "latest-per-provider reduction precedes the byte cap");
	assert.equal(result.coverage.output.omittedFailures, 1);
	assert.equal(result.coverage.output.omittedModels, 0);
	assert.equal(result.coverage.output.byteLimitReached, true);
	assert.equal(JSON.stringify(frozenRecords), snapshot);
	assert.deepEqual(catalog.calls, [{ limit: 20 }, { limit: 20 }]);
});

it("uses exact provider intersection and preserves nested model paths", async () => {
	const now = Date.parse(observedAt);
	const records = [record("source", [], sampled(["sample/vendor/model", "sample/sibling", "sample-extra/vendor/model"].map((model, index) => ({ model, at: now, tokens: index + 1, reportedCost: 1 }))))];
	const catalog = new FixtureCatalog([page(records)]);
	const provider = await readFleetStatus(catalog, { now, provider: "sample" }); check(provider);
	assert.deepEqual(provider.models.map((model) => model.model), ["sample/sibling", "sample/vendor/model"]);
	assert.equal(provider.providers[0].usage.last7d.tokens, 3);
	const exact = await readFleetStatus(catalog, { now, provider: "sample", model: "sample/vendor/model" }); check(exact);
	assert.deepEqual(exact.models.map((model) => model.model), ["sample/vendor/model"]);
	assert.equal(exact.providers[0].usage.last7d.tokens, 1);
	const conflict = await readFleetStatus(catalog, { now, provider: "different", model: "sample/vendor/model" }); check(conflict);
	assert.equal(conflict.selection?.outcome, "no-match");
	assert.deepEqual(conflict.providers, []);
});

it("does not attribute malformed published identities to a selected provider", async () => {
	const source = evidence({ models: ["providerX", "provider/", "/model", "provider/valid"].map((model) => ({ model, reportedCost: 1 })) });
	assert.equal(Value.Check(ModelEvidenceSchema, source), true, "the source envelope admits malformed model text");
	const catalog = new FixtureCatalog([page([record("source", [], source)])]);
	const broad = await readFleetStatus(catalog); check(broad);
	const result = await readFleetStatus(catalog, { provider: "provider" }); check(result);
	assert.equal(broad.models.length, 4, "unfiltered source interpretation remains unchanged");
	assert.deepEqual(result.models.map((model) => model.model), ["provider/valid"]);
	assert.equal(result.selection?.filter, "provider");
	assert.deepEqual(result.selection?.matched, { models: 1, failures: 0, warnings: 0 });
	assert.deepEqual(result.coverage.evidence, broad.coverage.evidence);
});

it("retains global unknowns and source omissions when selected evidence does not match", async () => {
	const source = evidence({ models: [{ model: "sample/other", reportedCost: 2 }], toolReportedCost: 3,
		failures: [failure("sample", 1, { modelId: "other" })], warnings: [warning("unknown"), warning("other", { model: selected("other") })] });
	source.coverage.omittedFailures = 9;
	const records = [record("source", [row("unknown")], source), record("unavailable")];
	const result = await readFleetStatus(new FixtureCatalog([page(records)]), { model: "sample/missing" }); check(result);
	assert.equal(result.selection?.outcome, "no-match");
	assert.deepEqual(result.selection?.matched, { models: 0, failures: 0, warnings: 0 });
	assert.equal(result.conversations.unknownModel, 1);
	assert.equal(result.coverage.unknownEvidenceStorages, 1);
	assert.equal(result.coverage.evidence.omittedFailures, 9);
	assert.equal(result.toolReportedCost, 3, "tool accounting remains global");
	assert.deepEqual(result.failures, []);
	assert.deepEqual(result.warnings, []);
	assert.match(result.notes.join(" "), /absence does not establish health/u);
	assert.match(result.notes.join(" "), /No match does not establish no use/u);
});

it("matches failure-only evidence and excludes unattributed warnings under selection", async () => {
	const source = evidence({ failures: [failure("sample", 1, { modelId: "target" })], warnings: [warning("unknown"), warning("target", { model: selected("target") })] });
	const result = await readFleetStatus(new FixtureCatalog([page([record("source", [], source)])]), { model: "sample/target" }); check(result);
	assert.equal(result.selection?.outcome, "matched");
	assert.deepEqual(result.selection?.matched, { models: 0, failures: 1, warnings: 1 });
	assert.equal(result.models.length, 0);
	assert.equal(result.warnings[0]?.conversationId, "target");
});

it("keeps global overflow coverage independent of selected samples", async () => {
	const now = Date.parse(observedAt);
	const samples = ["sample/other", "sample/target"].map((model) => ({ model, at: now, tokens: Number.MAX_VALUE, reportedCost: Number.MAX_VALUE }));
	const catalog = new FixtureCatalog([page([record("source", [], sampled(samples))])]);
	const broad = await readFleetStatus(catalog, { now }); check(broad);
	const selected = await readFleetStatus(catalog, { now, model: "sample/target" }); check(selected);
	assert.deepEqual(selected.usageCoverage, broad.usageCoverage);
	assert.equal(selected.usageCoverage.invalidSamples, 1);
	assert.equal(selected.models[0]?.model, "sample/target");
	assert.equal(selected.models[0]?.usage, undefined);
	assert.equal(selected.models[0]?.reportedCost, null);
});

it("rejects malformed selectors before traversal and filters outside the fleet view", async () => {
	for (const model of ["", "missing-provider", "/model", "provider/", "provider/model name", "provider/model\n", "p/\ud800", `p/${"x".repeat(511)}`, 12, null]) {
		assert.throws(() => validateFleetSelection({ view: "fleet", model }), /Fleet model/u);
	}
	for (const provider of ["", "provider/model", "provider name", "p\u0000", "x".repeat(201), false]) {
		assert.throws(() => validateFleetSelection({ view: "fleet", provider }), /Fleet provider/u);
	}
	assert.throws(() => validateFleetSelection({ model: "sample/model" }), /require view: fleet/u);
	assert.throws(() => validateFleetSelection({ view: "fleet", sessionId: "target", model: "sample/model" }), /omit sessionId/u);
	assert.deepEqual(validateFleetSelection({ view: "fleet", model: "sample/vendor/model", provider: "sample" }), { model: "sample/vendor/model", provider: "sample" });
	const catalog = new FixtureCatalog([page([])]);
	await assert.rejects(readFleetStatus(catalog, { model: "invalid" }), /Fleet model/u);
	assert.equal(catalog.calls.length, 0);
});

it("returns usable model facts with plain and escaped combined selectors at their identity limits", async () => {
	const now = Date.parse(observedAt);
	for (const escaped of [false, true]) {
		const provider = (escaped ? "\\" : "p").repeat(200);
		const modelId = (escaped ? "\\" : "m").repeat(311);
		const model = `${provider}/${modelId}`;
		const source = { ...sampled([{ model, at: now, tokens: 10, reportedCost: 1 }]), models: [{ model, reportedCost: 1, lastResponseAt: now }] };
		assert.equal(Value.Check(ModelEvidenceSchema, source), true);
		const catalog = new FixtureCatalog([page([record("source", [row("source", { model: { provider, modelId, thinkingLevel: "high" }, state: "working" })], source)])]);
		const result = await readFleetStatus(catalog, { now, model, provider }); check(result);
		assert.equal(result.selection?.filter, "model-and-provider");
		assert.equal("model" in (result.selection ?? {}), false, "exact query identities remain in the tool arguments");
		assert.equal("provider" in (result.selection ?? {}), false);
		assert.equal(result.models[0]?.model, model);
		assert.deepEqual(result.models[0]?.currentSelections, [{ thinkingLevel: "high", count: 1 }]);
		assert.equal(result.models[0]?.usage?.last7d.tokens, 10);
		assert.equal(result.coverage.output.omittedModels, 0);
		assert.deepEqual(catalog.calls, [{ limit: 20 }]);
	}
});

it("bounds selected identities without a wider scan or shortened targets", async () => {
	const model = `sample/${"🧭".repeat(120)}`;
	const source = evidence({ models: [{ model, reportedCost: 1 }], failures: [failure("sample", 1, { modelId: model.slice(7), message: "failure" })] });
	const catalog = new FixtureCatalog([page([record("source", [], source)])]);
	const result = await readFleetStatus(catalog, { model }); check(result);
	assert.equal(result.selection?.filter, "model");
	assert.equal(result.selection?.matched.models, 1);
	assert.equal(result.models.length + result.coverage.output.omittedModels, 1);
	if (result.models.length) assert.equal(result.models[0].model, model);
	assert.deepEqual(catalog.calls, [{ limit: 20 }]);
});

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
