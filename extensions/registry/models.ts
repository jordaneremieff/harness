import { getSupportedThinkingLevels, type ModelCost, type ModelCostRates } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const AUTH_SOURCES = ["stored", "runtime", "environment", "fallback", "models_json_key", "models_json_command"] as const;
type AuthSource = (typeof AUTH_SOURCES)[number];

/** Configuration evidence, never a resolved session cycle or preference. */
export interface SettingsScopeEvidence {
	status: "available" | "absent" | "unavailable";
	patterns: string[] | null;
	observedAt: number;
}

export function readSettingsScope(cwd: string, agentDir: string, at: number, projectTrusted: boolean): SettingsScopeEvidence {
	const unavailable: SettingsScopeEvidence = { status: "unavailable", patterns: null, observedAt: at };
	try {
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
		if (settings.drainErrors().length > 0) return unavailable;
		const patterns = settings.getEnabledModels();
		if (patterns === undefined) return { status: "absent", patterns: null, observedAt: at };
		if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string")) return unavailable;
		return { status: "available", patterns: [...patterns], observedAt: at };
	} catch {
		return unavailable;
	}
}

/** Literal settings evidence only: no glob expansion, fuzzy matching, or model resolution. */
function settingsProviders(scope: SettingsScopeEvidence): Set<string> | null {
	if (scope.status !== "available" || scope.patterns === null) return null;
	const providers = new Set<string>();
	for (const pattern of scope.patterns) {
		const slash = pattern.indexOf("/");
		if (slash <= 0) continue;
		const provider = pattern.slice(0, slash);
		if (!/[\s*?[\]{}()!+@~^$|\\:]/.test(provider)) providers.add(provider);
	}
	return providers;
}

function readBoolean(read: () => boolean): boolean | null {
	try {
		const value = read();
		return typeof value === "boolean" ? value : null;
	} catch {
		return null;
	}
}

function readAuthSource(read: () => { source?: string }): AuthSource | null {
	try {
		const source = read().source;
		return AUTH_SOURCES.find((candidate) => candidate === source) ?? null;
	} catch {
		return null;
	}
}

function costRates(value: ModelCostRates): ModelCostRates | null {
	const { input, output, cacheRead, cacheWrite } = value;
	return [input, output, cacheRead, cacheWrite].every((rate) => Number.isFinite(rate) && rate >= 0)
		? { input, output, cacheRead, cacheWrite } : null;
}

/** Select price fields only; a malformed price stays unknown rather than zero. */
function catalogCost(model: ModelInfo): ModelCost | null {
	try {
		const base = costRates(model.cost);
		if (base === null) return null;
		if (model.cost.tiers === undefined) return base;
		const tiers = model.cost.tiers.map((tier) => {
			const rates = costRates(tier);
			return rates !== null && Number.isFinite(tier.inputTokensAbove) && tier.inputTokensAbove >= 0
				? { ...rates, inputTokensAbove: tier.inputTokensAbove } : null;
		});
		return tiers.every((tier) => tier !== null) ? { ...base, tiers } : null;
	} catch {
		return null;
	}
}

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
	oauth: boolean | null;
	subscriptionRecognized: boolean | null;
	authSource: AuthSource | null;
	catalogCost: ModelCost | null;
	catalogCostHasTiers: boolean | null;
	providerHasScopedModels: boolean | null;
	providerNamedInSettings: boolean | null;
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
	settingsScope?: SettingsScopeEvidence;
}

type ModelRegistry = ExtensionContext["modelRegistry"];
type ModelInfo = ReturnType<ModelRegistry["getAll"]>[number];
type ScopedModels = ExtensionContext["scopedModels"];

/**
 * Synchronous model facts a Pi Durable host exposes. `ModelRuntime` satisfies
 * this shape; `getAvailableSnapshot` is its synchronous availability read.
 */
export interface DurableModelReader {
	getModels(): readonly ModelInfo[];
	getModel(provider: string, modelId: string): ModelInfo | undefined;
	getAvailableSnapshot(): readonly ModelInfo[];
	getError(): string | undefined;
	getRegisteredProviderIds(): readonly string[];
	hasConfiguredAuth(providerId: string): boolean;
	isUsingOAuth(providerId: string): boolean;
	isUsingSubscription(providerId: string): boolean;
	getProviderAuthStatus(providerId: string): { source?: string };
}

/** The agent's model choice, independent of the process-wide catalog. */
export interface DurableAgentModel {
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel?: string;
}

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

interface ModelBuildInput {
	/** Every row to project: the catalog plus a selected model outside it. */
	models: ModelInfo[];
	catalog: ModelInfo[];
	catalogAvailable: boolean;
	available: Set<string>;
	availableSnapshot: boolean;
	catalogError: boolean | null;
	extensionProviders: Set<string> | null;
	scopedModels: ScopedModels | undefined;
	settingsProviders: Set<string> | null;
	scopeConfigured: boolean | null;
	scopeOrder: string[] | null;
	selectedRef: { provider: string; modelId: string } | undefined;
	thinkingLevel: string | undefined;
	hasConfiguredAuth: (model: ModelInfo) => boolean | null;
	billing: (model: ModelInfo) => Pick<ModelRecord, "oauth" | "subscriptionRecognized" | "authSource">;
	settingsScope?: SettingsScopeEvidence;
	at: number;
}

function buildModelRecord(model: ModelInfo, input: ModelBuildInput): ModelRecord {
	const name = `${model.provider}/${model.id}`;
	const selected =
		input.selectedRef !== undefined && model.provider === input.selectedRef.provider && model.id === input.selectedRef.modelId;
	const scopeIndex =
		input.scopedModels?.findIndex(
			(entry) => entry.model.provider === model.provider && entry.model.id === model.id,
		) ?? -1;
	const scope = input.scopedModels?.[scopeIndex];
	const cost = catalogCost(model);
	return {
		kind: "model",
		name,
		provider: model.provider,
		id: model.id,
		displayName: model.name,
		catalog: input.catalog.includes(model),
		selected,
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		supportedThinkingLevels: [...getSupportedThinkingLevels(model)],
		available: input.availableSnapshot ? input.available.has(name) : null,
		configuredAuth: input.hasConfiguredAuth(model),
		...input.billing(model),
		catalogCost: cost,
		catalogCostHasTiers: cost === null ? null : (cost.tiers?.length ?? 0) > 0,
		providerHasScopedModels: input.scopeConfigured === true
			? input.scopedModels?.some((entry) => entry.model.provider === model.provider) ?? null : null,
		providerNamedInSettings: input.settingsProviders?.has(model.provider) ?? null,
		extensionProvider: input.extensionProviders === null ? null : input.extensionProviders.has(model.provider),
		inScope: input.scopeConfigured === null ? null : !input.scopeConfigured || scope !== undefined,
		...(scopeIndex < 0 ? {} : { scopeIndex }),
		...(scope?.thinkingLevel === undefined ? {} : { scopeThinkingLevel: scope.thinkingLevel }),
		...(selected && input.thinkingLevel !== undefined ? { currentThinkingLevel: input.thinkingLevel } : {}),
		evidence: "registration",
		at: input.at,
	};
}

function modelGroup(record: ModelRecord): number {
	if (record.available === true) {
		return record.providerHasScopedModels === true || record.providerNamedInSettings === true ? 0 : 1;
	}
	return record.configuredAuth === true ? 2 : 3;
}

function buildModelSnapshot(input: ModelBuildInput): ModelSnapshot {
	const result: ModelSnapshot = {
		records: [],
		catalogAvailable: input.catalogAvailable,
		availableSnapshot: input.availableSnapshot,
		catalogError: input.catalogError,
		scopeConfigured: input.scopeConfigured,
		scopeOrder: input.scopeOrder,
		...(input.settingsScope === undefined ? {} : { settingsScope: input.settingsScope }),
	};
	for (const model of input.models) result.records.push(buildModelRecord(model, input));
	result.records.sort((a, b) => modelGroup(a) - modelGroup(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return result;
}

export function readModels(ctx: ExtensionContext, at: number): ModelSnapshot {
	const scopedModels = ctx.scopedModels;
	const scopeConfigured = Array.isArray(scopedModels) ? scopedModels.length > 0 : null;
	const registry = ctx.modelRegistry;
	const catalogRead = readModelCatalog(registry);
	const availableRead = readAvailableNames(registry);
	const models = [...catalogRead.models];
	if (ctx.model && !models.some((model) => model.provider === ctx.model?.provider && model.id === ctx.model.id)) {
		models.push(ctx.model);
	}
	return buildModelSnapshot({
		models,
		catalog: catalogRead.models,
		catalogAvailable: catalogRead.available,
		available: availableRead.names,
		availableSnapshot: availableRead.snapshot,
		catalogError: readCatalogError(registry),
		extensionProviders: readExtensionProviders(registry),
		scopedModels,
		settingsProviders: null,
		scopeConfigured,
		scopeOrder: scopeConfigured ? scopedModels.map(({ model }) => `${model.provider}/${model.id}`) : null,
		selectedRef: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
		thinkingLevel: ctx.thinkingLevel,
		billing: (model) => {
			const oauth = readBoolean(() => registry.isUsingOAuth(model));
			return {
				oauth,
				subscriptionRecognized: oauth === null ? null : readBoolean(() => oauth && registry.getProvider(model.provider)?.auth.oauth?.isSubscription === true),
				authSource: readAuthSource(() => registry.getProviderAuthStatus(model.provider)),
			};
		},
		hasConfiguredAuth: (model) => {
			try {
				return registry.hasConfiguredAuth(model);
			} catch {
				/* Configuration presence is not remote auth health. */
				return null;
			}
		},
		at,
	});
}

/**
 * Project the Durable host's model runtime. A Durable conversation stores one
 * model choice and has no Pi session model scope, so scope stays unavailable
 * rather than empty.
 */
export function readDurableModels(reader: DurableModelReader, agent: DurableAgentModel, at: number, settingsScope: SettingsScopeEvidence): ModelSnapshot {
	let catalog: ModelInfo[] = [];
	let catalogAvailable = false;
	try {
		const models = reader.getModels();
		if (Array.isArray(models)) {
			catalog = [...models];
			catalogAvailable = true;
		}
	} catch {
		/* An absent catalog is not an empty catalog. */
	}
	const available = new Set<string>();
	let availableSnapshot = false;
	try {
		const models = reader.getAvailableSnapshot();
		if (Array.isArray(models)) {
			for (const model of models) available.add(`${model.provider}/${model.id}`);
			availableSnapshot = true;
		}
	} catch {
		/* Availability is independently unavailable. */
	}
	let catalogError: boolean | null = null;
	try {
		catalogError = reader.getError() !== undefined;
	} catch {
		/* Raw errors can contain configuration values and are not returned. */
	}
	let extensionProviders: Set<string> | null = null;
	try {
		extensionProviders = new Set(reader.getRegisteredProviderIds());
	} catch {
		/* Provider registration is independently unavailable. */
	}
	let selectedModel: ModelInfo | undefined;
	if (agent.model) {
		try {
			selectedModel = reader.getModel(agent.model.provider, agent.model.modelId);
		} catch {
			/* The selected model stays absent from the projected rows. */
		}
	}
	const models = [...catalog];
	if (selectedModel && !models.some((model) => model.provider === selectedModel.provider && model.id === selectedModel.id)) {
		models.push(selectedModel);
	}
	return buildModelSnapshot({
		models,
		catalog,
		catalogAvailable,
		available,
		availableSnapshot,
		catalogError,
		extensionProviders,
		scopedModels: undefined,
		settingsProviders: settingsProviders(settingsScope),
		scopeConfigured: null,
		scopeOrder: null,
		settingsScope,
		selectedRef: agent.model,
		thinkingLevel: agent.thinkingLevel,
		billing: (model) => ({
			oauth: readBoolean(() => reader.isUsingOAuth(model.provider)),
			subscriptionRecognized: readBoolean(() => reader.isUsingSubscription(model.provider)),
			authSource: readAuthSource(() => reader.getProviderAuthStatus(model.provider)),
		}),
		hasConfiguredAuth: (model) => {
			try {
				return reader.hasConfiguredAuth(model.provider);
			} catch {
				/* Configuration presence is not remote auth health. */
				return null;
			}
		},
		at,
	});
}
