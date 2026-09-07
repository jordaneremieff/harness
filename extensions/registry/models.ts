import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Safe projections of synchronous registry snapshots, never resolved credentials. */
export interface ModelRecord {
	kind: "model";
	name: string;
	provider: string;
	id: string;
	displayName: string;
	catalog: boolean;
	selected: boolean;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	supportedThinkingLevels: string[];
	available: boolean | null;
	configuredAuth: boolean | null;
	inScope: boolean | null;
	scopeThinkingLevel?: string;
	currentThinkingLevel?: string;
	evidence: "registration";
	at: number;
}

export interface ModelSnapshot {
	records: ModelRecord[];
	catalogAvailable: boolean;
	availableSnapshot: boolean;
	catalogError: boolean | null;
	scopeConfigured: boolean | null;
}

export function readModels(ctx: ExtensionContext, at: number): ModelSnapshot {
	const result: ModelSnapshot = { records: [], catalogAvailable: false, availableSnapshot: false,
		catalogError: null, scopeConfigured: Array.isArray(ctx.scopedModels) ? ctx.scopedModels.length > 0 : null };
	const registry = ctx.modelRegistry;
	let catalog: ReturnType<typeof registry.getAll> = [];
	try {
		catalog = registry.getAll();
		result.catalogAvailable = Array.isArray(catalog);
		if (!result.catalogAvailable) catalog = [];
	} catch { /* An absent catalog is not an empty catalog. */ }
	const available = new Set<string>();
	try {
		const models = registry.getAvailable();
		if (Array.isArray(models)) {
			for (const model of models) available.add(`${model.provider}/${model.id}`);
			result.availableSnapshot = true;
		}
	} catch { /* Availability is independently unavailable. */ }
	try { result.catalogError = registry.getError() !== undefined; }
	catch { /* Raw errors can contain configuration values and are not returned. */ }
	const all = [...catalog];
	if (ctx.model && !all.some((model) => model.provider === ctx.model?.provider && model.id === ctx.model.id)) all.push(ctx.model);
	for (const model of all) {
		const name = `${model.provider}/${model.id}`;
		const selected = model.provider === ctx.model?.provider && model.id === ctx.model.id;
		let configuredAuth: boolean | null = null;
		try { configuredAuth = registry.hasConfiguredAuth(model); }
		catch { /* Configuration presence is not remote auth health. */ }
		const scope = ctx.scopedModels?.find((entry) => entry.model.provider === model.provider && entry.model.id === model.id);
		result.records.push({
			kind: "model", name, provider: model.provider, id: model.id, displayName: model.name,
			catalog: catalog.includes(model), selected, reasoning: model.reasoning,
			input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
			supportedThinkingLevels: [...getSupportedThinkingLevels(model)],
			available: result.availableSnapshot ? available.has(name) : null,
			configuredAuth,
			inScope: result.scopeConfigured === null ? null : !result.scopeConfigured || scope !== undefined,
			...(scope?.thinkingLevel === undefined ? {} : { scopeThinkingLevel: scope.thinkingLevel }),
			...(selected && ctx.thinkingLevel !== undefined ? { currentThinkingLevel: ctx.thinkingLevel } : {}),
			evidence: "registration", at,
		});
	}
	result.records.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	return result;
}
