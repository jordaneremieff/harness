export const MAX_FALLBACK_MODELS = 4;
const CLASS_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MODEL_PATTERN = /^[^\s/]+\/\S+$/;

export type AvailabilityReason = "no-auth" | "authentication" | "quota" | "rate-limit";
export interface ModelFallback {
	requested: string;
	candidates: string[];
	index: number;
	taskClass?: string;
	thinkingExplicit: boolean;
	exhausted: boolean;
	events: { model: string; phase: "preflight" | "runtime"; reason: AvailabilityReason }[];
}

function validateModels(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > MAX_FALLBACK_MODELS) {
		throw new Error(`fallbackModels must be an array with at most ${MAX_FALLBACK_MODELS} models`);
	}
	if (value.some((model) => typeof model !== "string" || model.length > 256 || !MODEL_PATTERN.test(model))) {
		throw new Error("fallbackModels requires exact provider/model identities without whitespace");
	}
	if (new Set(value).size !== value.length) throw new Error("fallbackModels contains duplicate identities");
	return [...value];
}

/** Explicit lists, including [], replace configured rosters. No catalog preference is implicit. */
export function fallbackModelsFor(
	explicit: string[] | undefined,
	taskClass: string | undefined,
	configuration: string | undefined,
): string[] {
	if (taskClass !== undefined && !CLASS_PATTERN.test(taskClass)) throw new Error("invalid fallback taskClass");
	if (explicit !== undefined) return validateModels(explicit);
	if (configuration === undefined) {
		if (taskClass !== undefined) throw new Error(`no fallback roster configured for taskClass "${taskClass}"`);
		return [];
	}
	const rosters = configuredRosters(configuration);
	const selected = taskClass ?? "default";
	if (taskClass !== undefined && !rosters.has(selected))
		throw new Error(`no fallback roster for taskClass "${selected}"`);
	return rosters.get(selected) ?? [];
}

function configuredRosters(configuration: string): Map<string, string[]> {
	if (Buffer.byteLength(configuration, "utf8") > 16_384) throw new Error("PI_SUBAGENT_FALLBACK_MODELS exceeds 16KiB");
	let parsed: unknown;
	try {
		parsed = JSON.parse(configuration);
	} catch {
		throw new Error("PI_SUBAGENT_FALLBACK_MODELS must be a JSON object of task classes to model arrays");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("PI_SUBAGENT_FALLBACK_MODELS must be an object");
	}
	const entries = Object.entries(parsed);
	if (entries.length > 32) throw new Error("PI_SUBAGENT_FALLBACK_MODELS permits at most 32 task classes");
	const rosters = new Map<string, string[]>();
	for (const [name, models] of entries) {
		if (!CLASS_PATTERN.test(name)) throw new Error("PI_SUBAGENT_FALLBACK_MODELS contains an invalid task class");
		rosters.set(name, validateModels(models));
	}
	return rosters;
}

/** Pi exposes provider errors as text. Unrecognized errors stay failures, never substitutions. */
export function availabilityFailure(message: string): AvailabilityReason | null {
	if (
		/^(?:error[: ]+|http\s+)?429\b/i.test(message) ||
		/\brate[_ -]limit(?:ed| exceeded| reached|_exceeded)?\b/i.test(message)
	)
		return "rate-limit";
	if (
		/^(?:error[: ]+|http\s+)?402\b/i.test(message) ||
		/\binsufficient[_ ]quota\b|\bquota (?:exceeded|exhausted)\b|\byou exceeded your current quota\b|\byou have hit your [^\r\n]{0,80}usage limit\b|\binsufficient (?:credits?|funds|balance)\b|\bcredit balance (?:is )?(?:too low|insufficient|exhausted)\b/i.test(
			message,
		)
	)
		return "quota";
	if (
		/^(?:error[: ]+|http\s+)?401\b/i.test(message) ||
		/\b(?:invalid|incorrect)[_ ]api[_ ]key\b|\bauthentication[_ ](?:failed|required|error)\b|\bno api key\b|\b(?:token|credentials?) (?:expired|revoked)\b/i.test(
			message,
		)
	)
		return "authentication";
	return null;
}

export function normalizeFallback(value: unknown): ModelFallback | undefined {
	if (!value || typeof value !== "object") return undefined;
	const plan = value as ModelFallback;
	if (
		!Array.isArray(plan.candidates) ||
		plan.candidates.length < 2 ||
		plan.candidates.length > MAX_FALLBACK_MODELS + 1 ||
		plan.candidates.some((model) => typeof model !== "string" || model.length > 256 || !MODEL_PATTERN.test(model)) ||
		new Set(plan.candidates).size !== plan.candidates.length ||
		plan.requested !== plan.candidates[0] ||
		!Number.isInteger(plan.index) ||
		plan.index < 0 ||
		plan.index > plan.candidates.length ||
		typeof plan.exhausted !== "boolean" ||
		typeof plan.thinkingExplicit !== "boolean" ||
		(plan.taskClass !== undefined && (typeof plan.taskClass !== "string" || !CLASS_PATTERN.test(plan.taskClass))) ||
		!Array.isArray(plan.events) ||
		plan.events.length > plan.candidates.length ||
		plan.events.some(
			(event) =>
				!event ||
				typeof event.model !== "string" ||
				event.model.length > 256 ||
				!MODEL_PATTERN.test(event.model) ||
				!["preflight", "runtime"].includes(event.phase) ||
				!["no-auth", "authentication", "quota", "rate-limit"].includes(event.reason),
		)
	)
		return undefined;
	return {
		requested: plan.requested,
		candidates: [...plan.candidates],
		index: plan.index,
		taskClass: plan.taskClass,
		thinkingExplicit: plan.thinkingExplicit,
		exhausted: plan.exhausted,
		events: plan.events.map(({ model, phase, reason }) => ({ model, phase, reason })),
	};
}

export function fallbackSummary(plan: ModelFallback | undefined, actual: string): string {
	if (!plan) return "";
	const events = plan.events.map((event) => `${event.model}: ${event.phase}/${event.reason}`).join("; ") || "none";
	return `Model fallback: requested ${plan.requested}; actual ${actual}; roster ${plan.candidates.join(" → ")}; failures ${events}${plan.exhausted ? "; exhausted" : ""}`;
}
