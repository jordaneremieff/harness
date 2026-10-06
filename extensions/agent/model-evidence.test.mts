import assert from "node:assert/strict";
import { it } from "node:test";
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { answerMessage } from "./durable-host-fixture.mts";
import { boundCatalogView, CATALOG_VIEW_BUDGET_BYTES, parseCatalogView, withModelEvidence, type CatalogViewRow } from "./catalog-view.ts";
import { AgentConversationSummarySchema } from "./observation-schema.ts";
import { boundModelEvidence, MODEL_EVIDENCE_BUDGET_BYTES, ModelEvidenceCollector, USAGE_ENTRY_LIMIT, USAGE_SAMPLE_LIMIT, USAGE_WEEK_MS } from "./model-evidence.ts";

const observedAt = "2026-01-01T00:00:00.000Z";
const row: CatalogViewRow = { id: "storage", storageId: "storage", cwd: "/work", owner: "here", state: "idle", modifiedAt: 1, cost: 100, partial: false, model: { provider: "fixture", modelId: "second", thinkingLevel: "high" } };
function usage(cost: number) { return { ...answerMessage().usage, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }; }
function entry(id: number, conversationId: number, model: string, timestamp: number, error?: string): EntryRecord {
	return { id: id as EntryRecord["id"], conversationId: conversationId as EntryRecord["conversationId"], kind: "pi.assistant", model: [{ ...structuredClone(answerMessage()), provider: "fixture", model, timestamp, ...(error ? { stopReason: "error", errorMessage: error } : {}) }] };
}

it("samples owned timestamped responses, not lifetime ledgers or inherited entries", () => {
	const now = Date.parse(observedAt);
	const evidence = new ModelEvidenceCollector(observedAt);
	const valid = entry(1, 1, "first", now);
	const future = entry(2, 1, "first", now + 1);
	const invalid = entry(3, 1, "first", now - 1);
	if (invalid.model?.[0]?.role === "assistant") invalid.model[0].usage.totalTokens = Number.NaN;
	evidence.observe(1, row, { models: { "fixture/first": usage(99) }, tools: {} }, [valid, future, invalid,
		entry(4, 1, "first", now - USAGE_WEEK_MS), entry(5, 1, "first", now - USAGE_WEEK_MS - 1), entry(6, 2, "first", now)]);
	assert.equal(evidence.value.sampling?.samples.length, 2);
	assert.equal(evidence.value.sampling?.invalidSamples, 2);
	assert.equal(evidence.value.sampling?.entriesVisited, 6);
	assert.deepEqual(evidence.value.sampling?.samples.map((sample) => sample.at), [now, now - USAGE_WEEK_MS]);
	assert.ok(evidence.value.sampling?.samples.every((sample) => sample.reportedCost === answerMessage().usage.cost.total));
});

it("bounds additional entry visits, message visits, retained samples, and publication bytes", (t) => {
	const now = Date.parse(observedAt);
	const evidence = new ModelEvidenceCollector(observedAt);
	const entries = Array.from({ length: USAGE_ENTRY_LIMIT + 20 }, (_, index) => entry(index + 1, 1, "first", now - index));
	evidence.observe(1, row, undefined, entries);
	evidence.observe(2, { ...row, id: "storage:2" }, undefined, [entry(9000, 2, "first", now)]);
	assert.equal(evidence.value.sampling?.entriesVisited, USAGE_ENTRY_LIMIT);
	assert.equal(evidence.value.sampling?.entriesOmitted, 21);
	assert.equal(evidence.value.sampling?.samples.length, USAGE_SAMPLE_LIMIT);
	assert.equal(evidence.value.sampling?.omittedSamples, USAGE_ENTRY_LIMIT - USAGE_SAMPLE_LIMIT);
	const bounded = boundModelEvidence(evidence.value);
	assert.ok(bounded?.sampling);
	assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= MODEL_EVIDENCE_BUDGET_BYTES);
	assert.ok(bounded.sampling.samples.length > 0);
	t.diagnostic(`Usage publication: ${bounded.sampling.entriesVisited} entry visits; ${bounded.sampling.samples.length} retained samples; ${bounded.sampling.omittedSamples} omitted samples; ${Buffer.byteLength(JSON.stringify(bounded))} bytes.`);
	assert.equal(bounded.sampling.samples.length + bounded.sampling.omittedSamples, USAGE_ENTRY_LIMIT);
	assert.ok(bounded.sampling.samples.every((sample, index, all) => index === 0 || sample.at <= all[index - 1].at));
	const manyMessages = new ModelEvidenceCollector(observedAt);
	manyMessages.observe(1, row, undefined, [{ ...entry(1, 1, "first", now), model: Array.from({ length: 70 }, () => ({ ...answerMessage(), timestamp: now })) }]);
	assert.equal(manyMessages.value.sampling?.messagesOmitted, 6);
	assert.equal(manyMessages.value.sampling?.samples.length, 64);
});

it("attributes cumulative usage to exact model buckets after a selection changes, with tool costs separate", () => {
	const evidence = new ModelEvidenceCollector(observedAt);
	const ledger: UsageState = { models: { "fixture/first": usage(2), "fixture/second": usage(3), "fixture/compaction": usage(4) }, tools: { read: usage(7) } };
	evidence.observe(1, row, ledger, [entry(1, 1, "first", 10), entry(2, 1, "second", 20)]);
	assert.deepEqual(evidence.value.models, [
		{ model: "fixture/first", reportedCost: 2, lastResponseAt: 10 },
		{ model: "fixture/second", reportedCost: 3, lastResponseAt: 20 },
		{ model: "fixture/compaction", reportedCost: 4 },
	]);
	assert.equal(evidence.value.toolReportedCost, 7);
	assert.equal(evidence.value.coverage.conversationsVisited, 1);
	assert.equal(evidence.value.coverage.incompleteHistory, 1);
	assert.equal(evidence.value.models.reduce((total, item) => total + item.reportedCost, 0), 9);
});

it("uses each conversation's own ledger and excludes inherited assistant entries", () => {
	const evidence = new ModelEvidenceCollector(observedAt);
	const inherited = entry(1, 1, "first", 500, "ancestor failure");
	evidence.observe(1, row, { models: { "fixture/first": usage(2) }, tools: {} }, [inherited]);
	evidence.observe(2, { ...row, id: "storage:2" }, { models: { "fixture/first": usage(3) }, tools: {} }, [inherited, entry(2, 2, "first", 100)]);
	assert.deepEqual(evidence.value.models, [{ model: "fixture/first", reportedCost: 5, lastResponseAt: 500 }]);
	assert.equal(evidence.value.failures.length, 1);
	assert.equal(evidence.value.failures[0].conversationId, "storage");
	assert.equal(evidence.value.coverage.conversationsVisited, 2);
});

it("keeps assistant-attributed failures distinct from current conversation warnings", () => {
	const evidence = new ModelEvidenceCollector(observedAt);
	evidence.observe(1, { ...row, error: "conversation stopped", health: { lastError: "host unavailable", autoRetry: { attempt: 1 } } }, undefined, [
		entry(1, 1, "first", 10, "usage limit"), entry(2, 1, "", 20, "no identity"), entry(3, 1, "first", Number.NaN, "no time"),
		{ ...entry(4, 1, "first", 30, "tool failure"), kind: "pi.tool-result" },
	]);
	assert.deepEqual(evidence.value.failures, [{ provider: "fixture", modelId: "first", at: 10, conversationId: "storage", entryId: 1, message: "usage limit" }]);
	assert.equal(evidence.value.coverage.unavailableUsage, 1);
	assert.deepEqual(evidence.value.models, [], "messages never manufacture zero-cost usage buckets");
	assert.deepEqual(evidence.value.warnings.map((warning) => warning.kind), ["error", "lastError", "autoRetry"]);
	assert.ok(evidence.value.warnings.every((warning) => warning.model?.modelId === "second" && warning.observedAt === observedAt));
});

it("bounds the envelope and counts every omitted model, failure, and warning", () => {
	const evidence = new ModelEvidenceCollector(observedAt);
	for (let index = 0; index < 40; index++) evidence.observe(index + 1, { ...row, id: `storage:${index + 1}`, error: "warning".repeat(100) }, { models: { [`fixture/model-${index}`]: usage(index) }, tools: {} }, [entry(index + 1, index + 1, `model-${index}`, index, "failure".repeat(100))]);
	const bounded = boundModelEvidence(evidence.value);
	assert.ok(bounded);
	assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= MODEL_EVIDENCE_BUDGET_BYTES);
	assert.equal(bounded.models.length + bounded.coverage.omittedModels, 40);
	assert.equal(bounded.failures.length + bounded.coverage.omittedFailures, 40);
	assert.equal(bounded.warnings.length + bounded.coverage.omittedWarnings, 40);
	assert.equal(bounded.failures[0].at, 39);
});

it("adds optional evidence without altering strict rows or evicting operational rows", () => {
	const source = new ModelEvidenceCollector(observedAt).value;
	for (const rows of [[row], Array.from({ length: 30 }, (_, index) => ({ ...row, id: `storage:${index}`, latestReply: "x".repeat(1900) }))]) {
		const base = boundCatalogView({ updatedAt: observedAt, rows });
		const view = withModelEvidence(base, source);
		assert.deepEqual(view.rows, base.rows);
		assert.deepEqual(view.coverage, base.coverage);
		assert.ok(Buffer.byteLength(JSON.stringify(view)) <= CATALOG_VIEW_BUDGET_BYTES);
		assert.ok(view.rows.every((item) => Value.Check(AgentConversationSummarySchema, item)));
		assert.equal(Value.Check(AgentConversationSummarySchema, { ...row, modelEvidence: source }), false);
		assert.deepEqual(parseCatalogView(view), view);
	}
});

it("leaves evidence absent when operational rows leave no room for its coverage header", () => {
	const base = boundCatalogView({ updatedAt: observedAt, rows: [row] });
	const padding = CATALOG_VIEW_BUDGET_BYTES - Buffer.byteLength(JSON.stringify(base)) - Buffer.byteLength(',"name":""');
	const full = parseCatalogView({ ...base, rows: [{ ...row, name: "x".repeat(padding) }] });
	assert.equal(Buffer.byteLength(JSON.stringify(full)), CATALOG_VIEW_BUDGET_BYTES);
	assert.equal(withModelEvidence(full, new ModelEvidenceCollector(observedAt).value), full);
});

it("refuses malformed or oversized evidence without loosening row validation", () => {
	const view = boundCatalogView({ updatedAt: observedAt, rows: [row] });
	const evidence = new ModelEvidenceCollector(observedAt).value;
	assert.throws(() => parseCatalogView({ ...view, modelEvidence: { ...evidence, toolReportedCost: -1 } }), /model evidence/u);
	assert.throws(() => parseCatalogView({ ...view, modelEvidence: { ...evidence, models: [{ model: "x".repeat(5000), reportedCost: 0 }] } }), /model evidence/u);
});
