import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
export const CONFIGURATION_LIMITS = { name: 256, model: 512, sessionId: 256 } as const;
export const CONFIGURATION_SYNTAX = "/agent configure <session> name [text] | model <provider/model> [level] | thinking <level>";

export interface ConfigurationPatch {
	name?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}
export interface ConfigurationModel { provider: string; modelId: string }
export interface ConfigurationCommand { sessionId: string; patch: ConfigurationPatch }
export interface ConfigurationState { name: string; model: string | null; thinkingLevel: ThinkingLevel | null }
export interface ConfigurationResult {
	sessionId: string;
	outcome: "applied" | "failed";
	before: ConfigurationState;
	beforeSource: "live" | "retained";
	requested: ConfigurationPatch;
	after: ConfigurationState;
	afterSource: "live" | "retained";
	reasoning?: { requested: ThinkingLevel; effective: ThinkingLevel | null; clamped: boolean | null };
	hookErrors: { count: number; events: string[]; omitted: number; observation: string };
	persistence: { nativeWrites: "completed" | "uncertain" | "not-attempted"; fileExists: boolean; note: string };
	error?: string;
	truncated?: string[];
}

/** Older native values need not satisfy the input limits. Mark every clipped result field. */
export function boundedConfigurationResult(result: ConfigurationResult): ConfigurationResult {
	const truncated: string[] = [];
	const state = (value: ConfigurationState, label: string): ConfigurationState => {
		const bound = (text: string | null, field: "name" | "model") => {
			if (text === null || text.length <= CONFIGURATION_LIMITS[field]) return text;
			truncated.push(`${label}.${field}`);
			return text.slice(0, CONFIGURATION_LIMITS[field]).replace(/[\ud800-\udbff]$/u, "");
		};
		return { name: bound(value.name, "name") ?? "", model: bound(value.model, "model"), thinkingLevel: value.thinkingLevel };
	};
	const before = state(result.before, "before");
	const after = state(result.after, "after");
	return { ...result, before, after, ...(truncated.length ? { truncated } : {}) };
}

export function formatConfiguration(result: ConfigurationResult): string { return JSON.stringify(result, null, 2); }

const fields = ["name", "model", "thinkingLevel"] as const;
const invalidText = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/u;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function boundedText(value: unknown, field: keyof typeof CONFIGURATION_LIMITS): string {
	if (typeof value !== "string" || value.length > CONFIGURATION_LIMITS[field] || invalidText.test(value)) {
		throw new Error(`${field} must be well-formed, single-line text of at most ${CONFIGURATION_LIMITS[field]} UTF-16 code units, without control characters`);
	}
	return value;
}

/** Explicit identities keep configuration independent of current-provider and fuzzy defaults. */
export function configurationModel(value: unknown): ConfigurationModel {
	const text = boundedText(value, "model");
	const separator = text.indexOf("/");
	if (separator < 1 || separator === text.length - 1 || /\s/u.test(text)) {
		throw new Error("model requires an exact provider/model identity without whitespace");
	}
	return { provider: text.slice(0, separator), modelId: text.slice(separator + 1) };
}

/** Undefined fields are absent; an empty or whitespace-only name explicitly clears the name. */
export function validateConfigurationPatch(value: unknown): ConfigurationPatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("configuration must be an object");
	if (Object.keys(value).some((key) => !(fields as readonly string[]).includes(key))) {
		throw new Error("unsupported configuration field; use name, model, or thinkingLevel");
	}
	const input = value as Record<string, unknown>;
	const patch: ConfigurationPatch = {};
	if (Object.hasOwn(input, "name") && input.name !== undefined) patch.name = boundedText(input.name, "name").trim();
	if (Object.hasOwn(input, "model") && input.model !== undefined) {
		configurationModel(input.model);
		patch.model = input.model as string;
	}
	if (Object.hasOwn(input, "thinkingLevel") && input.thinkingLevel !== undefined) {
		if (!isThinkingLevel(input.thinkingLevel)) throw new Error(`thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
		patch.thinkingLevel = input.thinkingLevel;
	}
	if (!Object.keys(patch).length) throw new Error("configuration requires at least one of name, model, or thinkingLevel");
	return patch;
}

/** Pi clamps this requested level after the model setter; global defaults do not select it. */
export function configurationThinkingLevel(patch: ConfigurationPatch, current: unknown): ThinkingLevel | undefined {
	if (patch.thinkingLevel !== undefined) return patch.thinkingLevel;
	if (patch.model === undefined) return undefined;
	if (!isThinkingLevel(current)) throw new Error("the session has no retained reasoning level; supply thinkingLevel with the model");
	return current;
}

function commandPatch(field: string | undefined, args: readonly string[]): ConfigurationPatch {
	if (field === "name") return validateConfigurationPatch({ name: args.join(" ") });
	if (field === "model" && (args.length === 1 || args.length === 2)) {
		return validateConfigurationPatch({ model: args[0], thinkingLevel: args[1] });
	}
	if (field === "thinking" && args.length === 1) return validateConfigurationPatch({ thinkingLevel: args[0] });
	throw new Error(`Use ${CONFIGURATION_SYNTAX}`);
}

export function configurationSessionId(value: unknown): string {
	const id = boundedText(value, "sessionId");
	if (!id || /\s/u.test(id)) throw new Error("sessionId requires one exact session ID without whitespace");
	return id;
}

export function parseConfigurationArguments(args: readonly string[]): ConfigurationCommand {
	const [id, field, ...values] = args;
	if (!id) throw new Error(`Use ${CONFIGURATION_SYNTAX}`);
	return { sessionId: configurationSessionId(id), patch: commandPatch(field, values) };
}
