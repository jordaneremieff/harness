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
	extensionProvider: boolean | null;
	inScope: boolean | null;
	scopeIndex?: number;
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
	scopeOrder: string[] | null;
}

type ModelRegistry = ExtensionContext["modelRegistry"];
type ModelInfo = ReturnType<ModelRegistry["getAll"]>[number];

interface CatalogRead {
	models: ModelInfo[];
	available: boolean;
}

function readModelCatalog(registry: ModelRegistry): CatalogRead {
	try {
		const models = registry.getAll();
		return { models: Array.isArray(models) ? models : [], available: Array.isArray(models) };
	} catch {
		/* An absent catalog is not an empty catalog. */
		return { models: [], available: false };
	}
}

function readAvailableNames(registry: ModelRegistry): { names: Set<string>; snapshot: boolean } {
	const names = new Set<string>();
	try {
		const models = registry.getAvailable();
		if (!Array.isArray(models)) return { names, snapshot: false };
		for (const model of models) names.add(`${model.provider}/${model.id}`);
		return { names, snapshot: true };
	} catch {
		/* Availability is independently unavailable. */
		return { names, snapshot: false };
	}
}

function readCatalogError(registry: ModelRegistry): boolean | null {
	try {
		return registry.getError() !== undefined;
	} catch {
		/* Raw errors can contain configuration values and are not returned. */
		return null;
	}
}

function readExtensionProviders(registry: ModelRegistry): Set<string> | null {
	try {
		return new Set(registry.getRegisteredProviderIds());
	} catch {
		/* Provider registration is independently unavailable. */
		return null;
	}
}

interface ModelBuildContext {
	registry: ModelRegistry;
	catalog: ModelInfo[];
	available: Set<string>;
	availableSnapshot: boolean;
	extensionProviders: Set<string> | null;
	scopedModels: ExtensionContext["scopedModels"];
	scopeConfigured: boolean | null;
	ctx: ExtensionContext;
	at: number;
}

function buildModelRecord(model: ModelInfo, context: ModelBuildContext): ModelRecord {
	const name = `${model.provider}/${model.id}`;
	const selected = model.provider === context.ctx.model?.provider && model.id === context.ctx.model.id;
	let configuredAuth: boolean | null = null;
	try {
		configuredAuth = context.registry.hasConfiguredAuth(model);
	} catch {
		/* Configuration presence is not remote auth health. */
	}
	const scopeIndex =
		context.scopedModels?.findIndex(
			(entry) => entry.model.provider === model.provider && entry.model.id === model.id,
		) ?? -1;
	const scope = context.scopedModels?.[scopeIndex];
	return {
		kind: "model",
		name,
		provider: model.provider,
		id: model.id,
		displayName: model.name,
		catalog: context.catalog.includes(model),
		selected,
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		supportedThinkingLevels: [...getSupportedThinkingLevels(model)],
		available: context.availableSnapshot ? context.available.has(name) : null,
		configuredAuth,
		extensionProvider: context.extensionProviders === null ? null : context.extensionProviders.has(model.provider),
		inScope: context.scopeConfigured === null ? null : !context.scopeConfigured || scope !== undefined,
		...(scopeIndex < 0 ? {} : { scopeIndex }),
		...(scope?.thinkingLevel === undefined ? {} : { scopeThinkingLevel: scope.thinkingLevel }),
		...(selected && context.ctx.thinkingLevel !== undefined ? { currentThinkingLevel: context.ctx.thinkingLevel } : {}),
		evidence: "registration",
		at: context.at,
	};
}

export function readModels(ctx: ExtensionContext, at: number): ModelSnapshot {
	const scopedModels = ctx.scopedModels;
	const scopeConfigured = Array.isArray(scopedModels) ? scopedModels.length > 0 : null;
	const registry = ctx.modelRegistry;
	const catalogRead = readModelCatalog(registry);
	const availableRead = readAvailableNames(registry);
	const result: ModelSnapshot = {
		records: [],
		catalogAvailable: catalogRead.available,
		availableSnapshot: availableRead.snapshot,
		catalogError: readCatalogError(registry),
		scopeConfigured,
		scopeOrder: scopeConfigured ? scopedModels.map(({ model }) => `${model.provider}/${model.id}`) : null,
	};
	const all = [...catalogRead.models];
	if (ctx.model && !all.some((model) => model.provider === ctx.model?.provider && model.id === ctx.model.id)) {
		all.push(ctx.model);
	}
	const context: ModelBuildContext = {
		registry,
		catalog: catalogRead.models,
		available: availableRead.names,
		availableSnapshot: availableRead.snapshot,
		extensionProviders: readExtensionProviders(registry),
		scopedModels,
		scopeConfigured,
		ctx,
		at,
	};
	for (const model of all) result.records.push(buildModelRecord(model, context));
	result.records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return result;
}
