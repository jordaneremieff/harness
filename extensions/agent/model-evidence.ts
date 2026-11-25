import { str, num, int, bool, lit, union, arr, opt, obj, type Static } from "@earendil-works/pi-schema";
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";
import type { CatalogViewRow } from "./catalog-view.ts";

export const MODEL_EVIDENCE_BUDGET_BYTES = 4 * 1024;
export const USAGE_SAMPLE_LIMIT = 128;
export const USAGE_ENTRY_LIMIT = 4096;
export const USAGE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const count = int({ minimum: 0 });
const text = str({ minLength: 1 });
const cost = num({ minimum: 0 });
export const ModelCostEvidenceSchema = obj({ model: text, reportedCost: cost, lastResponseAt: opt(cost) });
export const ModelFailureSchema = obj({
	provider: text,
	modelId: text,
	at: cost,
	conversationId: text,
	entryId: count,
	message: text,
});
export const ModelWarningSchema = obj({
	conversationId: text,
	model: opt(obj({ provider: text, modelId: text, thinkingLevel: text })),
	observedAt: text,
	kind: union([lit("error"), lit("lastError"), lit("autoRetry")]),
	message: text,
});
export const UsageSampleSchema = obj({ model: text, at: cost, tokens: cost, reportedCost: cost });
export const UsageSamplingSchema = obj({
	observedAt: text,
	samples: arr(UsageSampleSchema, { maxItems: USAGE_SAMPLE_LIMIT }),
	entriesVisited: count,
	entriesOmitted: count,
	messagesOmitted: count,
	invalidSamples: count,
	omittedSamples: count,
});
export type UsageSample = Static<typeof UsageSampleSchema>;
export const ModelEvidenceProperties = {
	models: arr(ModelCostEvidenceSchema),
	failures: arr(ModelFailureSchema),
	warnings: arr(ModelWarningSchema),
	toolReportedCost: cost,
	sampling: opt(UsageSamplingSchema),
	coverage: obj({
		conversationsVisited: count,
		conversationsComplete: bool(),
		unavailableUsage: count,
		incompleteHistory: count,
		omittedModels: count,
		omittedFailures: count,
		omittedWarnings: count,
	}),
};
export const ModelEvidenceSchema = obj(ModelEvidenceProperties);
export type ModelEvidence = Static<typeof ModelEvidenceSchema>;
export type ModelFailure = Static<typeof ModelFailureSchema>;
export type ModelWarning = Static<typeof ModelWarningSchema>;

export function evidenceText(value: string, limit = 256): string {
	const points = [...value];
	return points.length <= limit ? value : `${points.slice(0, limit - 1).join("")}…`;
}
export function compareFailures(left: ModelFailure, right: ModelFailure): number {
	return (
		right.at - left.at ||
		left.provider.localeCompare(right.provider) ||
		left.modelId.localeCompare(right.modelId) ||
		left.conversationId.localeCompare(right.conversationId) ||
		right.entryId - left.entryId
	);
}

/** The fields of one assistant message that evidence reads; message content is not retained. */
interface EvidenceMessage {
	readonly provider?: string;
	readonly model?: string;
	readonly timestamp: number;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly usage?: { readonly totalTokens: number; readonly cost?: { readonly total: number } };
}

/**
 * What evidence reads from the active entries of one conversation: their count, and the assistant entries among the
 * newest `covered` entries with their position. A publication keeps this for a conversation that did not change, so
 * the next publication counts the same evidence without another read of its entries.
 *
 * A collector visits `USAGE_ENTRY_LIMIT` entries of one storage, not of one conversation. The reduction of each
 * conversation covers only the entries that the collector takes from it, so the reductions of one storage together
 * cover no more than that limit.
 */
export interface EvidenceEntries {
	readonly length: number;
	/** The count of newest entries that this reduction covers; an assistant entry before them is absent. */
	readonly covered: number;
	readonly assistants: readonly {
		readonly index: number;
		readonly id: number;
		/** All model messages of the entry; only the first 64 are sampled. */
		readonly messages: number;
		readonly sampled: readonly (EvidenceMessage | undefined)[];
	}[];
}

type ModelMessage = NonNullable<EntryRecord["model"]>[number];

function evidenceMessage(message: ModelMessage): EvidenceMessage | undefined {
	if (message.role !== "assistant") return undefined;
	const usage = message.usage
		? {
				totalTokens: message.usage.totalTokens,
				...(message.usage.cost ? { cost: { total: message.usage.cost.total } } : {}),
			}
		: undefined;
	return {
		provider: message.provider,
		model: message.model,
		timestamp: message.timestamp,
		stopReason: message.stopReason,
		...(message.errorMessage ? { errorMessage: evidenceText(message.errorMessage) } : {}),
		...(usage ? { usage } : {}),
	};
}

/** Reduce the newest `window` active entries to the fields that evidence reads. */
export function evidenceEntries(
	conversationId: number,
	entries: readonly EntryRecord[],
	window: number = USAGE_ENTRY_LIMIT,
): EvidenceEntries {
	const covered = Math.max(0, Math.min(entries.length, window, USAGE_ENTRY_LIMIT));
	const assistants: EvidenceEntries["assistants"][number][] = [];
	for (let index = entries.length - covered; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.conversationId !== conversationId || entry.kind !== "pi.assistant") continue;
		const messages = entry.model ?? [];
		assistants.push({
			index,
			id: entry.id,
			messages: messages.length,
			sampled: messages.slice(0, 64).map(evidenceMessage),
		});
	}
	return { length: entries.length, covered, assistants };
}

/** The same reduction over no more than the newest `window` entries; an unchanged reduction is returned as is. */
export function trimEvidenceEntries(entries: EvidenceEntries, window: number): EvidenceEntries {
	const covered = Math.max(0, Math.min(entries.covered, window));
	if (covered === entries.covered) return entries;
	const first = entries.length - covered;
	return { length: entries.length, covered, assistants: entries.assistants.filter((entry) => entry.index >= first) };
}

/** Collect from the documents and active entries already read for operational rows. */
export class ModelEvidenceCollector {
	readonly value: ModelEvidence = {
		models: [],
		failures: [],
		warnings: [],
		toolReportedCost: 0,
		coverage: {
			conversationsVisited: 0,
			conversationsComplete: true,
			unavailableUsage: 0,
			incompleteHistory: 0,
			omittedModels: 0,
			omittedFailures: 0,
			omittedWarnings: 0,
		},
	};
	private readonly models = new Map<string, ModelEvidence["models"][number]>();
	readonly observedAt: string;
	private readonly sampling: Static<typeof UsageSamplingSchema>;
	constructor(observedAt: string) {
		this.observedAt = observedAt;
		this.sampling = {
			observedAt,
			samples: [],
			entriesVisited: 0,
			entriesOmitted: 0,
			messagesOmitted: 0,
			invalidSamples: 0,
			omittedSamples: 0,
		};
		this.value.sampling = this.sampling;
	}
	observe(
		conversationId: number,
		row: CatalogViewRow,
		usage: UsageState | undefined,
		entries: readonly EntryRecord[],
	): void {
		this.observeRetained(row, usage, evidenceEntries(conversationId, entries, this.remainingEntries()));
	}
	/** The count of newest entries that this collector takes from the next conversation. */
	remainingEntries(): number {
		return USAGE_ENTRY_LIMIT - this.sampling.entriesVisited;
	}
	/** Count one conversation from the reduced form of its entries, which covers the entries this collector takes. */
	observeRetained(row: CatalogViewRow, usage: UsageState | undefined, entries: EvidenceEntries): void {
		if (entries.covered < Math.min(entries.length, this.remainingEntries()))
			throw new Error("The retained evidence of a conversation covers fewer entries than the collector takes");
		this.value.coverage.conversationsVisited++;
		// Mounted active entries do not establish coverage of compacted or inactive history.
		this.value.coverage.incompleteHistory++;
		if (usage === undefined) this.value.coverage.unavailableUsage++;
		else {
			for (const [model, bucket] of Object.entries(usage.models)) this.model(model).reportedCost += bucket.cost.total;
			for (const bucket of Object.values(usage.tools)) this.value.toolReportedCost += bucket.cost.total;
		}
		const sampling = this.sampling;
		const start = Math.max(0, entries.length - this.remainingEntries());
		sampling.entriesOmitted += start;
		sampling.entriesVisited += entries.length - start;
		for (let position = entries.assistants.length - 1; position >= 0; position--) {
			const entry = entries.assistants[position];
			if (entry.index < start) break;
			this.messages(row.id, entry);
		}
		this.warnings(row);
	}
	private model(key: string): ModelEvidence["models"][number] {
		let row = this.models.get(key);
		if (!row) {
			row = { model: key, reportedCost: 0 };
			this.models.set(key, row);
			this.value.models.push(row);
		}
		return row;
	}
	private messages(conversationId: string, entry: EvidenceEntries["assistants"][number]): void {
		this.sampling.messagesOmitted += Math.max(0, entry.messages - 64);
		for (const message of entry.sampled) {
			if (!message) continue;
			this.sample(message);
			if (!message.provider || !message.model || !Number.isFinite(message.timestamp) || message.timestamp < 0) continue;
			const model = this.models.get(`${message.provider}/${message.model}`);
			if (model) model.lastResponseAt = Math.max(model.lastResponseAt ?? 0, message.timestamp);
			if (message.stopReason !== "error" || !message.errorMessage) continue;
			this.value.failures.push({
				provider: message.provider,
				modelId: message.model,
				at: message.timestamp,
				conversationId,
				entryId: entry.id,
				message: message.errorMessage,
			});
		}
	}
	private sample(message: EvidenceMessage): void {
		const sampling = this.sampling;
		const now = Date.parse(this.observedAt);
		const usage = message.usage;
		if (
			!message.provider ||
			!message.model ||
			!Number.isFinite(message.timestamp) ||
			message.timestamp < 0 ||
			message.timestamp > now ||
			!usage ||
			!Number.isFinite(usage.totalTokens) ||
			usage.totalTokens < 0 ||
			usage.cost === undefined ||
			!Number.isFinite(usage.cost.total) ||
			usage.cost.total < 0
		) {
			sampling.invalidSamples++;
			return;
		}
		if (message.timestamp < now - USAGE_WEEK_MS) return;
		sampling.samples.push({
			model: `${message.provider}/${message.model}`,
			at: message.timestamp,
			tokens: usage.totalTokens,
			reportedCost: usage.cost.total,
		});
		sampling.samples.sort((a, b) => b.at - a.at || a.model.localeCompare(b.model));
		if (sampling.samples.length > USAGE_SAMPLE_LIMIT) {
			sampling.samples.pop();
			sampling.omittedSamples++;
		}
	}
	private warnings(row: CatalogViewRow): void {
		const health = row.health as { lastError?: string; autoRetry?: unknown } | undefined;
		const samples = {
			error: row.error,
			lastError: health?.lastError,
			autoRetry: health?.autoRetry === undefined ? undefined : JSON.stringify(health.autoRetry),
		};
		for (const kind of ["error", "lastError", "autoRetry"] as const) {
			const message = samples[kind];
			if (message)
				this.value.warnings.push({
					conversationId: row.id,
					...(row.model ? { model: row.model } : {}),
					observedAt: this.observedAt,
					kind,
					message: evidenceText(message),
				});
		}
	}
}

function boundUsageSamples(source: ModelEvidence, value: ModelEvidence, budget: number): void {
	if (!source.sampling || !value.sampling) return;
	// Reserve at most half the envelope for recent usage; failures and lifetime totals share the rest.
	for (const sample of source.sampling.samples) {
		value.sampling.samples.push(sample);
		value.sampling.omittedSamples--;
		if (
			Buffer.byteLength(JSON.stringify(value.sampling)) > budget / 2 ||
			Buffer.byteLength(JSON.stringify(value)) > budget
		) {
			value.sampling.samples.pop();
			value.sampling.omittedSamples++;
		}
	}
}

/** Retain complete identities, count dropped samples, and prefer recent attributed failures. */
export function boundModelEvidence(
	source: ModelEvidence,
	budget = MODEL_EVIDENCE_BUDGET_BYTES,
): ModelEvidence | undefined {
	const value: ModelEvidence = {
		...source,
		...(source.sampling
			? {
					sampling: {
						...source.sampling,
						samples: [],
						omittedSamples: source.sampling.omittedSamples + source.sampling.samples.length,
					},
				}
			: {}),
		models: [],
		failures: [],
		warnings: [],
		coverage: {
			...source.coverage,
			omittedModels: source.coverage.omittedModels + source.models.length,
			omittedFailures: source.coverage.omittedFailures + source.failures.length,
			omittedWarnings: source.coverage.omittedWarnings + source.warnings.length,
		},
	};
	const fits = () => Buffer.byteLength(JSON.stringify(value)) <= budget;
	if (!fits()) return undefined;
	boundUsageSamples(source, value, budget);
	const providers = new Set<string>();
	for (const failure of [...source.failures].sort(compareFailures)) {
		if (providers.has(failure.provider)) continue;
		providers.add(failure.provider);
		value.failures.push(failure);
		value.coverage.omittedFailures--;
		if (!fits()) {
			value.failures.pop();
			value.coverage.omittedFailures++;
		}
	}
	for (const model of [...source.models].sort((a, b) => a.model.localeCompare(b.model))) {
		value.models.push(model);
		value.coverage.omittedModels--;
		if (!fits()) {
			value.models.pop();
			value.coverage.omittedModels++;
		}
	}
	for (const warning of source.warnings) {
		value.warnings.push(warning);
		value.coverage.omittedWarnings--;
		if (!fits()) {
			value.warnings.pop();
			value.coverage.omittedWarnings++;
		}
	}
	return value;
}
