/** Machine-local observations from bounded catalog publications, without host or transcript reads. */
import { Type, type Static } from "typebox";
import type { AgentCatalog, CatalogRecord } from "./catalog.ts";
import type { CatalogView, CatalogViewRow } from "./catalog-view.ts";
import {
	compareFailures,
	evidenceText,
	ModelEvidenceSchema,
	ModelFailureSchema,
	ModelWarningSchema,
	type ModelEvidence,
	type ModelFailure,
	type ModelWarning,
} from "./model-evidence.ts";

const BYTE_LIMIT = 4096;
const PAGE_LIMIT = 20;
const MAX_PAGES = 16;
const MODEL_LIMIT = 12;
const FAILURE_LIMIT = 4;
const WARNING_LIMIT = 4;
const count = Type.Integer({ minimum: 0 });
const text = Type.String({ minLength: 1 });
const cost = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
const object = <T extends Record<string, import("typebox").TSchema>>(fields: T) =>
	Type.Object(fields, { additionalProperties: false });
const FleetModelSchema = object({
	model: text,
	reportedCost: cost,
	lastResponseAt: Type.Optional(Type.Number({ minimum: 0 })),
	currentSelections: Type.Array(object({ thinkingLevel: text, count })),
	activeConversations: count,
});

export const FleetStatusSchema = object({
	view: Type.Literal("fleet"),
	observedAt: text,
	models: Type.Array(FleetModelSchema, { maxItems: MODEL_LIMIT }),
	conversations: object({ observed: count, active: count, unknownModel: count }),
	toolReportedCost: cost,
	failures: Type.Array(ModelFailureSchema, { maxItems: FAILURE_LIMIT }),
	warnings: Type.Array(ModelWarningSchema, { maxItems: WARNING_LIMIT }),
	coverage: object({
		catalog: object({
			pages: count, records: count, visited: count, skipped: count,
			complete: Type.Boolean(), hasMore: Type.Boolean(), scanLimitReached: Type.Boolean(),
			maxPages: Type.Literal(MAX_PAGES), pageLimit: Type.Literal(PAGE_LIMIT),
		}),
		unknownEvidenceStorages: count,
		unknownOperationalStorages: count,
		incompleteOperationalStorages: count,
		omittedOperationalRows: count,
		evidence: ModelEvidenceSchema.properties.coverage,
		output: object({
			omittedModels: count, omittedFailures: count, omittedWarnings: count,
			omittedSelections: count, omittedActiveConversations: count,
			byteLimitReached: Type.Boolean(),
		}),
	}),
	notes: Type.Array(text),
});
export type FleetStatus = Static<typeof FleetStatusSchema>;
type FleetModel = FleetStatus["models"][number];

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareWarnings(left: ModelWarning, right: ModelWarning): number {
	return compareText(right.observedAt, left.observedAt) ||
		compareText(left.conversationId, right.conversationId) || compareText(left.kind, right.kind) ||
		compareText(JSON.stringify(left.model) ?? "", JSON.stringify(right.model) ?? "") || compareText(left.message, right.message);
}

function initialStatus(): FleetStatus {
	return {
		view: "fleet", observedAt: new Date().toISOString(), models: [],
		conversations: { observed: 0, active: 0, unknownModel: 0 },
		toolReportedCost: null, failures: [], warnings: [],
		coverage: {
			catalog: { pages: 0, records: 0, visited: 0, skipped: 0, complete: false, hasMore: false,
				scanLimitReached: false, maxPages: MAX_PAGES, pageLimit: PAGE_LIMIT },
			unknownEvidenceStorages: 0, unknownOperationalStorages: 0,
			incompleteOperationalStorages: 0, omittedOperationalRows: 0,
			evidence: { conversationsVisited: 0, conversationsComplete: true, unavailableUsage: 0,
				incompleteHistory: 0, omittedModels: 0, omittedFailures: 0, omittedWarnings: 0 },
			output: { omittedModels: 0, omittedFailures: 0, omittedWarnings: 0,
				omittedSelections: 0, omittedActiveConversations: 0, byteLimitReached: false },
		},
		notes: [
			"Machine-local catalog observations, not live state. Active means starting or working.",
			"Reported costs sum published usage only; null means unknown. They are not invoices or remaining allowance. Past use is not preference.",
			"Failures retain the latest attributed sample per provider. Older and duplicate samples are intentionally replaced, not counted as output omissions.",
			"Evidence omissions come from publications. Output failure omissions count only latest-provider candidates excluded by bounds.",
			"Warnings are sampled observed conversation state, not provider faults.",
			"Every call restarts the scan; no continuation is available. Coverage separates source omissions from output bounds.",
		],
	};
}

function modelRow(models: Map<string, FleetModel>, model: string): FleetModel {
	let row = models.get(model);
	if (!row) {
		row = { model, reportedCost: null, currentSelections: [], activeConversations: 0 };
		models.set(model, row);
	}
	return row;
}

function observeSelection(value: FleetStatus, models: Map<string, FleetModel>, row: CatalogViewRow): void {
	const active = row.state === "starting" || row.state === "working";
	value.conversations.observed++;
	if (active) value.conversations.active++;
	if (!row.model) { value.conversations.unknownModel++; return; }
	const model = modelRow(models, `${row.model.provider}/${row.model.modelId}`);
	const group = model.currentSelections.find((selection) => selection.thinkingLevel === row.model?.thinkingLevel);
	if (group) group.count++;
	else model.currentSelections.push({ thinkingLevel: row.model.thinkingLevel, count: 1 });
	if (active) model.activeConversations++;
}

function observeEvidence(value: FleetStatus, models: Map<string, FleetModel>, evidence: ModelEvidence): void {
	for (const source of evidence.models) {
		const model = modelRow(models, source.model);
		model.reportedCost = (model.reportedCost ?? 0) + source.reportedCost;
		if (source.lastResponseAt !== undefined)
			model.lastResponseAt = Math.max(model.lastResponseAt ?? 0, source.lastResponseAt);
	}
	// An envelope with no available usage does not establish a zero tool cost.
	if (evidence.coverage.conversationsVisited > evidence.coverage.unavailableUsage || evidence.toolReportedCost > 0)
		value.toolReportedCost = (value.toolReportedCost ?? 0) + evidence.toolReportedCost;
	for (const key of ["conversationsVisited", "unavailableUsage", "incompleteHistory", "omittedModels", "omittedFailures", "omittedWarnings"] as const)
		value.coverage.evidence[key] += evidence.coverage[key];
	value.coverage.evidence.conversationsComplete &&= evidence.coverage.conversationsComplete;
}

/** Add whole rows only; oversized identities never become unusable shortened targets. */
function boundOutput(value: FleetStatus, models: FleetModel[], failures: ModelFailure[], warnings: ModelWarning[]): void {
	const output = value.coverage.output;
	output.omittedModels = models.length;
	output.omittedFailures = failures.length;
	output.omittedWarnings = warnings.length;
	output.omittedSelections = models.reduce((total, model) => total + selections(model), 0);
	output.omittedActiveConversations = models.reduce((total, model) => total + model.activeConversations, 0);
	const fits = () => Buffer.byteLength(JSON.stringify(value), "utf8") <= BYTE_LIMIT;
	for (const failure of failures) {
		if (value.failures.length === FAILURE_LIMIT) break;
		value.failures.push({ ...failure, message: evidenceText(failure.message, 160) });
		output.omittedFailures--;
		if (!fits()) { value.failures.pop(); output.omittedFailures++; output.byteLimitReached = true; }
	}
	for (const model of models) {
		if (value.models.length === MODEL_LIMIT) break;
		value.models.push(model);
		output.omittedModels--;
		output.omittedSelections -= selections(model);
		output.omittedActiveConversations -= model.activeConversations;
		if (!fits()) {
			value.models.pop(); output.omittedModels++; output.omittedSelections += selections(model);
			output.omittedActiveConversations += model.activeConversations; output.byteLimitReached = true;
		}
	}
	for (const warning of warnings) {
		if (value.warnings.length === WARNING_LIMIT) break;
		value.warnings.push({ ...warning, message: evidenceText(warning.message, 160) });
		output.omittedWarnings--;
		if (!fits()) { value.warnings.pop(); output.omittedWarnings++; output.byteLimitReached = true; }
	}
}

function selections(model: FleetModel): number {
	return model.currentSelections.reduce((total, selection) => total + selection.count, 0);
}

function failureOrder(left: ModelFailure, right: ModelFailure): number {
	return compareFailures(left, right) || compareText(left.message, right.message);
}

class FleetCollector {
	readonly value = initialStatus();
	private readonly models = new Map<string, FleetModel>();
	private readonly failures = new Map<string, ModelFailure>();
	private readonly warnings: ModelWarning[] = [];
	private readonly storages = new Set<string>();
	private readonly conversations = new Set<string>();

	observe(record: CatalogRecord): void {
		if (this.storages.has(record.storageId)) return;
		this.storages.add(record.storageId);
		this.value.coverage.catalog.records++;
		this.operational(record.view);
		const evidence = record.view?.modelEvidence;
		if (!evidence) {
			this.value.coverage.unknownEvidenceStorages++;
			this.value.coverage.evidence.conversationsComplete = false;
			return;
		}
		observeEvidence(this.value, this.models, evidence);
		for (const failure of evidence.failures) {
			const previous = this.failures.get(failure.provider);
			if (!previous || failureOrder(failure, previous) < 0) this.failures.set(failure.provider, failure);
		}
		this.warnings.push(...evidence.warnings);
	}

	private operational(view: CatalogView | undefined): void {
		this.value.coverage.omittedOperationalRows += view?.coverage.omitted ?? 0;
		if (!view || view.unavailable !== undefined) { this.value.coverage.unknownOperationalStorages++; return; }
		if (!view.coverage.complete) this.value.coverage.incompleteOperationalStorages++;
		for (const row of view.rows) {
			if (this.conversations.has(row.id)) continue;
			this.conversations.add(row.id);
			observeSelection(this.value, this.models, row);
		}
	}

	finish(): FleetStatus {
		const models = [...this.models.values()].sort((a, b) => compareText(a.model, b.model));
		for (const model of models) model.currentSelections.sort((a, b) => compareText(a.thinkingLevel, b.thinkingLevel));
		boundOutput(this.value, models, [...this.failures.values()].sort(failureOrder), this.warnings.sort(compareWarnings));
		return this.value;
	}
}

/** Each call starts a bounded scan; cached costs never inherit a conversation's current selection. */
export async function readFleetStatus(catalog: AgentCatalog): Promise<FleetStatus> {
	const collector = new FleetCollector();
	const coverage = collector.value.coverage.catalog;
	let cursor: string | undefined;
	for (let index = 0; index < MAX_PAGES; index++) {
		const page = await catalog.page({ limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
		coverage.pages++;
		coverage.visited += page.coverage.visited;
		coverage.skipped += page.coverage.skipped;
		coverage.hasMore = page.nextCursor !== null;
		coverage.complete = page.coverage.complete && !coverage.hasMore;
		for (const record of page.records) collector.observe(record);
		if (page.nextCursor === null) break;
		cursor = page.nextCursor;
	}
	coverage.scanLimitReached = coverage.hasMore && coverage.pages === MAX_PAGES;
	return collector.finish();
}
