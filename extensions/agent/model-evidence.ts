import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import type { CatalogViewRow } from "./catalog-view.ts";

export const MODEL_EVIDENCE_BUDGET_BYTES = 4 * 1024;
const count = Type.Integer({ minimum: 0 });
const text = Type.String({ minLength: 1 });
const cost = Type.Number({ minimum: 0 });
const object = <T extends Record<string, import("typebox").TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
export const ModelCostEvidenceSchema = object({ model: text, reportedCost: cost, lastResponseAt: Type.Optional(cost) });
export const ModelFailureSchema = object({ provider: text, modelId: text, at: cost, conversationId: text, entryId: count, message: text });
export const ModelWarningSchema = object({
	conversationId: text,
	model: Type.Optional(object({ provider: text, modelId: text, thinkingLevel: text })),
	observedAt: text,
	kind: Type.Union([Type.Literal("error"), Type.Literal("lastError"), Type.Literal("autoRetry")]),
	message: text,
});
export const ModelEvidenceSchema = object({
	models: Type.Array(ModelCostEvidenceSchema), failures: Type.Array(ModelFailureSchema), warnings: Type.Array(ModelWarningSchema),
	toolReportedCost: cost,
	coverage: object({ conversationsVisited: count, conversationsComplete: Type.Boolean(), unavailableUsage: count, incompleteHistory: count, omittedModels: count, omittedFailures: count, omittedWarnings: count }),
});
export type ModelEvidence = Static<typeof ModelEvidenceSchema>;
export type ModelFailure = Static<typeof ModelFailureSchema>;
export type ModelWarning = Static<typeof ModelWarningSchema>;

export function evidenceText(value: string, limit = 256): string {
	const points = [...value];
	return points.length <= limit ? value : `${points.slice(0, limit - 1).join("")}…`;
}
export function compareFailures(left: ModelFailure, right: ModelFailure): number {
	return right.at - left.at || left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId) || left.conversationId.localeCompare(right.conversationId) || right.entryId - left.entryId;
}

/** Collect from the documents and active entries already read for operational rows. */
export class ModelEvidenceCollector {
	readonly value: ModelEvidence = {
		models: [], failures: [], warnings: [], toolReportedCost: 0,
		coverage: { conversationsVisited: 0, conversationsComplete: true, unavailableUsage: 0, incompleteHistory: 0, omittedModels: 0, omittedFailures: 0, omittedWarnings: 0 },
	};
	private readonly models = new Map<string, ModelEvidence["models"][number]>();
	readonly observedAt: string;
	constructor(observedAt: string) { this.observedAt = observedAt; }
	observe(conversationId: number, row: CatalogViewRow, usage: UsageState | undefined, entries: readonly EntryRecord[]): void {
		this.value.coverage.conversationsVisited++;
		// Mounted active entries do not establish coverage of compacted or inactive history.
		this.value.coverage.incompleteHistory++;
		if (usage === undefined) this.value.coverage.unavailableUsage++;
		else {
			for (const [model, bucket] of Object.entries(usage.models)) this.model(model).reportedCost += bucket.cost.total;
			for (const bucket of Object.values(usage.tools)) this.value.toolReportedCost += bucket.cost.total;
		}
		for (const entry of entries) {
			if (entry.conversationId !== conversationId || entry.kind !== "pi.assistant") continue;
			this.messages(row.id, entry);
		}
		this.warnings(row);
	}
	private model(key: string): ModelEvidence["models"][number] {
		let row = this.models.get(key);
		if (!row) { row = { model: key, reportedCost: 0 }; this.models.set(key, row); this.value.models.push(row); }
		return row;
	}
	private messages(conversationId: string, entry: EntryRecord): void {
		for (const message of entry.model ?? []) {
			if (message.role !== "assistant" || !message.provider || !message.model || !Number.isFinite(message.timestamp) || message.timestamp < 0) continue;
			const model = this.models.get(`${message.provider}/${message.model}`);
			if (model) model.lastResponseAt = Math.max(model.lastResponseAt ?? 0, message.timestamp);
			if (message.stopReason !== "error" || !message.errorMessage) continue;
			this.value.failures.push({ provider: message.provider, modelId: message.model, at: message.timestamp, conversationId, entryId: entry.id, message: evidenceText(message.errorMessage) });
		}
	}
	private warnings(row: CatalogViewRow): void {
		const health = row.health as { lastError?: string; autoRetry?: unknown } | undefined;
		const samples = { error: row.error, lastError: health?.lastError, autoRetry: health?.autoRetry === undefined ? undefined : JSON.stringify(health.autoRetry) };
		for (const kind of ["error", "lastError", "autoRetry"] as const) {
			const message = samples[kind];
			if (message) this.value.warnings.push({ conversationId: row.id, ...(row.model ? { model: row.model } : {}), observedAt: this.observedAt, kind, message: evidenceText(message) });
		}
	}
}

/** Retain complete identities, count dropped samples, and prefer recent attributed failures. */
export function boundModelEvidence(source: ModelEvidence, budget = MODEL_EVIDENCE_BUDGET_BYTES): ModelEvidence | undefined {
	const value: ModelEvidence = { ...source, models: [], failures: [], warnings: [], coverage: { ...source.coverage,
		omittedModels: source.coverage.omittedModels + source.models.length,
		omittedFailures: source.coverage.omittedFailures + source.failures.length,
		omittedWarnings: source.coverage.omittedWarnings + source.warnings.length,
	} };
	const fits = () => Buffer.byteLength(JSON.stringify(value)) <= budget;
	if (!fits()) return undefined;
	const providers = new Set<string>();
	for (const failure of [...source.failures].sort(compareFailures)) {
		if (providers.has(failure.provider)) continue;
		providers.add(failure.provider);
		value.failures.push(failure); value.coverage.omittedFailures--;
		if (!fits()) { value.failures.pop(); value.coverage.omittedFailures++; }
	}
	for (const model of [...source.models].sort((a, b) => a.model.localeCompare(b.model))) {
		value.models.push(model); value.coverage.omittedModels--;
		if (!fits()) { value.models.pop(); value.coverage.omittedModels++; }
	}
	for (const warning of source.warnings) {
		value.warnings.push(warning); value.coverage.omittedWarnings--;
		if (!fits()) { value.warnings.pop(); value.coverage.omittedWarnings++; }
	}
	return value;
}
