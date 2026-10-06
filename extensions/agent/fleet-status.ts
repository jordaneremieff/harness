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
	type UsageSample,
	USAGE_WEEK_MS,
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
const UsageTotalSchema = object({ tokens: Type.Number({ minimum: 0 }), reportedCost: Type.Number({ minimum: 0 }), responses: count });
const UsageWindowsSchema = object({ last5h: UsageTotalSchema, last7d: UsageTotalSchema });
const FleetModelSchema = object({
	model: text,
	reportedCost: cost,
	lastResponseAt: Type.Optional(Type.Number({ minimum: 0 })),
	currentSelections: Type.Array(object({ thinkingLevel: text, count })),
	activeConversations: count,
	usage: Type.Optional(UsageWindowsSchema),
});

export interface FleetEffortScope {
	readonly callerId: string;
	readonly created?: readonly string[];
	readonly omitted?: number;
	readonly callerUsage?: { readonly reportedCost: number; readonly partial: boolean };
}

export const FleetStatusSchema = object({
	view: Type.Literal("fleet"),
	observedAt: text,
	models: Type.Array(FleetModelSchema, { maxItems: MODEL_LIMIT }),
	providers: Type.Array(object({ provider: text, usage: UsageWindowsSchema }), { maxItems: MODEL_LIMIT }),
	usageCoverage: object({
		status: Type.Literal("partial"), unknownStorages: count, publications: count,
		oldestPublicationAt: Type.Union([text, Type.Null()]), newestPublicationAt: Type.Union([text, Type.Null()]),
		sampledResponses: count, oldestSampleAt: cost, newestSampleAt: cost,
		entriesVisited: count, entriesOmitted: count, messagesOmitted: count, invalidSamples: count, omittedSamples: count,
	}),
	effort: object({
		status: Type.Union([Type.Literal("partial"), Type.Literal("observed"), Type.Literal("unavailable")]),
		scope: Type.Literal("caller-and-direct-created-lifetime"),
		membership: Type.Union([Type.Literal("creation-records"), Type.Literal("catalog-owner"), Type.Literal("unknown")]),
		members: count, observedMembers: count, missingMembers: count, partialMembers: count, omittedMembers: count,
		reportedCost: cost,
	}),
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
			omittedModels: count, omittedProviders: count, omittedFailures: count, omittedWarnings: count,
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

function initialStatus(now: number): FleetStatus {
	return {
		view: "fleet", observedAt: new Date(now).toISOString(), models: [], providers: [],
		usageCoverage: { status: "partial", unknownStorages: 0, publications: 0, oldestPublicationAt: null, newestPublicationAt: null,
			sampledResponses: 0, oldestSampleAt: null, newestSampleAt: null,
			entriesVisited: 0, entriesOmitted: 0, messagesOmitted: 0, invalidSamples: 0, omittedSamples: 0 },
		effort: { status: "unavailable", scope: "caller-and-direct-created-lifetime", membership: "unknown",
			members: 0, observedMembers: 0, missingMembers: 0, partialMembers: 0, omittedMembers: 0, reportedCost: null },
		conversations: { observed: 0, active: 0, unknownModel: 0 },
		toolReportedCost: null, failures: [], warnings: [],
		coverage: {
			catalog: { pages: 0, records: 0, visited: 0, skipped: 0, complete: false, hasMore: false,
				scanLimitReached: false, maxPages: MAX_PAGES, pageLimit: PAGE_LIMIT },
			unknownEvidenceStorages: 0, unknownOperationalStorages: 0,
			incompleteOperationalStorages: 0, omittedOperationalRows: 0,
			evidence: { conversationsVisited: 0, conversationsComplete: true, unavailableUsage: 0,
				incompleteHistory: 0, omittedModels: 0, omittedFailures: 0, omittedWarnings: 0 },
			output: { omittedModels: 0, omittedProviders: 0, omittedFailures: 0, omittedWarnings: 0,
				omittedSelections: 0, omittedActiveConversations: 0, byteLimitReached: false },
		},
		notes: [
			"Machine-local catalog observations, not live state. Active means starting or working.",
			"Reported costs sum published usage only; null means unknown. They are not invoices or remaining allowance. Past use is not preference.",
			"Failures retain the latest attributed sample per provider. Older and duplicate samples are intentionally replaced, not counted as output omissions.",
			"Evidence omissions come from publications. Output failure omissions count only latest-provider candidates excluded by bounds.",
			"Warnings are sampled observed conversation state, not provider faults.",
			"Every call restarts the scan; no continuation is available. Coverage separates source omissions from output bounds.",
			"Usage windows include only sampled owned assistant responses with message timestamps in [observedAt-duration, observedAt]. Compacted/inactive history, compaction usage, tools, ordinary sessions, and unpublished work are missing. Zero samples do not prove zero usage.",
			"Effort costs include earlier tasks of the caller and direct-created agents, not current-task spend. Missing/invalid/overflowing member costs and omitted creation records make the total partial.",
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
function boundOutput(value: FleetStatus, models: FleetModel[], failures: ModelFailure[], warnings: ModelWarning[], providers: FleetStatus["providers"]): void {
	const output = value.coverage.output;
	output.omittedModels = models.length;
	output.omittedProviders = providers.length;
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
	const providerBudget = (BYTE_LIMIT + Buffer.byteLength(JSON.stringify(value))) / 2;
	boundProviders(value, providers, () => fits() && Buffer.byteLength(JSON.stringify(value)) <= providerBudget);
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

function boundProviders(value: FleetStatus, providers: FleetStatus["providers"], fits: () => boolean): void {
	const output = value.coverage.output;
	for (const provider of providers) {
		if (value.providers.length === MODEL_LIMIT) break;
		value.providers.push(provider); output.omittedProviders--;
		if (!fits()) { value.providers.pop(); output.omittedProviders++; output.byteLimitReached = true; }
	}
}

function selections(model: FleetModel): number {
	return model.currentSelections.reduce((total, selection) => total + selection.count, 0);
}

function failureOrder(left: ModelFailure, right: ModelFailure): number {
	return compareFailures(left, right) || compareText(left.message, right.message);
}

function emptyWindows(): Static<typeof UsageWindowsSchema> {
	return { last5h: { tokens: 0, reportedCost: 0, responses: 0 }, last7d: { tokens: 0, reportedCost: 0, responses: 0 } };
}
function sampleFits(windows: Static<typeof UsageWindowsSchema>, sample: UsageSample): boolean {
	return Object.values(windows).every((total) => Number.isFinite(total.tokens + sample.tokens) && Number.isFinite(total.reportedCost + sample.reportedCost));
}
function addSample(windows: Static<typeof UsageWindowsSchema>, sample: UsageSample, now: number): void {
	for (const [key, duration] of [["last5h", 5 * 60 * 60 * 1000], ["last7d", USAGE_WEEK_MS]] as const) {
		if (sample.at < now - duration || sample.at > now) continue;
		windows[key].tokens += sample.tokens; windows[key].reportedCost += sample.reportedCost; windows[key].responses++;
	}
}

class FleetCollector {
	readonly value: FleetStatus;
	private readonly providers = new Map<string, FleetStatus["providers"][number]>();
	private readonly members = new Set<string>();
	private readonly memberRows = new Map<string, CatalogViewRow>();
	private readonly now: number;
	private readonly effort?: FleetEffortScope;
	constructor(now: number, effort?: FleetEffortScope) {
		this.now = now;
		this.effort = effort;
		this.value = initialStatus(now);
		if (effort) {
			this.members.add(effort.callerId);
			for (const id of effort.created ?? []) this.members.add(id);
			this.value.effort.membership = effort.created === undefined ? "catalog-owner" : "creation-records";
			this.value.effort.omittedMembers = effort.omitted ?? 0;
		}
	}
	private readonly models = new Map<string, FleetModel>();
	private readonly failures = new Map<string, ModelFailure>();
	private readonly warnings: ModelWarning[] = [];
	private readonly storages = new Set<string>();
	private readonly conversations = new Set<string>();

	observe(record: CatalogRecord): void {
		if (this.storages.has(record.storageId)) return;
		this.storages.add(record.storageId);
		this.value.coverage.catalog.records++;
		if (this.effort?.created === undefined && record.ownerId === this.effort?.callerId && this.effort) this.members.add(record.storageId);
		this.operational(record.view);
		this.usage(record.view?.modelEvidence);
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

	private usage(evidence: ModelEvidence | undefined): void {
		const sampling = evidence?.sampling;
		const coverage = this.value.usageCoverage;
		if (!sampling) { coverage.unknownStorages++; return; }
		const publishedAt = Date.parse(sampling.observedAt);
		if (!Number.isFinite(publishedAt)) { coverage.unknownStorages++; return; }
		const publication = new Date(publishedAt).toISOString();
		coverage.publications++;
		if (coverage.oldestPublicationAt === null || publication < coverage.oldestPublicationAt) coverage.oldestPublicationAt = publication;
		if (coverage.newestPublicationAt === null || publication > coverage.newestPublicationAt) coverage.newestPublicationAt = publication;
		for (const key of ["entriesVisited", "entriesOmitted", "messagesOmitted", "invalidSamples", "omittedSamples"] as const) coverage[key] += sampling[key];
		for (const sample of sampling.samples) this.usageSample(sample, publishedAt);
	}
	private usageSample(sample: UsageSample, publishedAt: number): void {
		const coverage = this.value.usageCoverage;
		if (sample.at > publishedAt || !/^[^/]+\/.+$/u.test(sample.model)) { coverage.invalidSamples++; return; }
		if (sample.at > this.now || sample.at < this.now - USAGE_WEEK_MS) return;
		const model = modelRow(this.models, sample.model);
		const modelUsage = model.usage ?? emptyWindows();
		const provider = sample.model.slice(0, sample.model.indexOf("/"));
		const row = this.providers.get(provider) ?? { provider, usage: emptyWindows() };
		if (!sampleFits(modelUsage, sample) || !sampleFits(row.usage, sample)) { coverage.invalidSamples++; return; }
		coverage.sampledResponses++;
		coverage.oldestSampleAt = Math.min(coverage.oldestSampleAt ?? sample.at, sample.at);
		coverage.newestSampleAt = Math.max(coverage.newestSampleAt ?? sample.at, sample.at);
		model.usage = modelUsage;
		this.providers.set(provider, row);
		addSample(modelUsage, sample, this.now);
		addSample(row.usage, sample, this.now);
	}
	private operational(view: CatalogView | undefined): void {
		this.value.coverage.omittedOperationalRows += view?.coverage.omitted ?? 0;
		if (!view || view.unavailable !== undefined) { this.value.coverage.unknownOperationalStorages++; return; }
		if (!view.coverage.complete) this.value.coverage.incompleteOperationalStorages++;
		for (const row of view.rows) {
			if (this.conversations.has(row.id)) continue;
			this.conversations.add(row.id);
			if (this.members.has(row.id)) this.memberRows.set(row.id, row);
			observeSelection(this.value, this.models, row);
		}
	}

	private finishEffort(): void {
		if (!this.effort) return;
		const summary = this.value.effort;
		summary.members = this.members.size;
		for (const id of this.members) {
			const row = this.memberRows.get(id);
			const usage = id === this.effort.callerId && this.effort.callerUsage ? this.effort.callerUsage : row && { reportedCost: row.cost, partial: row.partial };
			if (!usage || !Number.isFinite(usage.reportedCost) || usage.reportedCost < 0 || !Number.isFinite((summary.reportedCost ?? 0) + usage.reportedCost)) { summary.missingMembers++; continue; }
			summary.observedMembers++;
			if (usage.partial) summary.partialMembers++;
			summary.reportedCost = (summary.reportedCost ?? 0) + usage.reportedCost;
		}
		summary.status = summary.missingMembers || summary.partialMembers || summary.omittedMembers || !this.value.coverage.catalog.complete || this.value.coverage.catalog.skipped ? "partial" : "observed";
	}
	finish(): FleetStatus {
		this.finishEffort();
		const models = [...this.models.values()].sort((a, b) => compareText(a.model, b.model));
		for (const model of models) model.currentSelections.sort((a, b) => compareText(a.thinkingLevel, b.thinkingLevel));
		boundOutput(this.value, models, [...this.failures.values()].sort(failureOrder), this.warnings.sort(compareWarnings), [...this.providers.values()].sort((a, b) => compareText(a.provider, b.provider)));
		return this.value;
	}
}

/** Each call starts a bounded scan; cached costs never inherit a conversation's current selection. */
export async function readFleetStatus(catalog: AgentCatalog, options: { readonly effort?: FleetEffortScope; readonly now?: number } = {}): Promise<FleetStatus> {
	const collector = new FleetCollector(options.now ?? Date.now(), options.effort);
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
