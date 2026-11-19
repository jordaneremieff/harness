export const DEFAULT_PHRASES = [
	"the honest part",
	"to be honest",
	"honestly",
	"frankly",
	"nothing needed from you",
	"nothing for you",
	"nothing needs you",
	"nothing from you",
	"byte for byte",
	"byte-for-byte",
	"byte-identical",
	"load-bearing",
	"bottom line:",
	"in summary",
	"say the word",
	"for you to judge",
] as const;

export const RULES = {
	dashes: { limit: 0 },
	escapedBreaks: { limit: 0 },
	phrases: { limit: 0, phrases: DEFAULT_PHRASES },
	labelLines: { limit: 8 },
	coinages: { limit: 14, allow: [] as readonly string[] },
	identifiers: { limit: 8 },
	codeSpans: { perHundred: 12, minWords: 150 },
	processNarration: { limit: 2, share: 0.1 },
	opening: { limit: 0 },
	negations: { limit: 4 },
} as const;
export type Rule = keyof typeof RULES;
export const RULE_IDS = Object.keys(RULES) as Rule[];
type RuleOptions = { enabled?: boolean; limit?: number };
export type CheckOverrides = {
	rules?: Partial<Record<Rule, RuleOptions>> & {
		phrases?: RuleOptions & { phrases?: string[]; addPhrases?: string[]; removePhrases?: string[] };
		coinages?: RuleOptions & { allow?: string[] };
		codeSpans?: RuleOptions & { perHundred?: number; minWords?: number };
		processNarration?: RuleOptions & { share?: number };
	};
	lexicon?: string;
};

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "" && !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
const termList = (value: unknown): boolean =>
	Array.isArray(value) && value.length <= 128 && value.every((term: unknown) => text(term) && term.length <= 120);
const integer = (value: unknown, min = 0): boolean =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const rate = (value: unknown, max = Number.MAX_SAFE_INTEGER): boolean =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
const fields: Record<string, (value: unknown) => boolean> = {
	enabled: (value) => typeof value === "boolean",
	limit: integer,
	phrases: termList,
	addPhrases: termList,
	removePhrases: termList,
	allow: termList,
	minWords: integer,
	perHundred: rate,
	share: (value) => rate(value, 1),
};
const special: Partial<Record<Rule, string[]>> = {
	phrases: ["phrases", "addPhrases", "removePhrases"],
	coinages: ["allow"],
	codeSpans: ["perHundred", "minWords"],
	processNarration: ["share"],
};

/** Returns the first invalid field. Unknown names are not reflected into the agent's context. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validate nested rule fields in declaration order so the first diagnostic is stable.
export function invalidCheckField(value: unknown): string | undefined {
	if (!object(value)) return "checksRules";
	if (Object.keys(value).some((key) => key !== "rules" && key !== "lexicon")) return "checksRules (unknown field)";
	if (Object.hasOwn(value, "lexicon") && (!text(value.lexicon) || value.lexicon.length > 4096))
		return "checksRules.lexicon";
	if (!Object.hasOwn(value, "rules")) return undefined;
	if (!object(value.rules) || Object.keys(value.rules).some((key) => !Object.hasOwn(RULES, key)))
		return "checksRules.rules";
	for (const rule of RULE_IDS) {
		if (!Object.hasOwn(value.rules, rule)) continue;
		const options = value.rules[rule];
		const path = `checksRules.rules.${rule}`;
		if (!object(options)) return path;
		for (const [field, input] of Object.entries(options)) {
			if (field === "limit" && rule === "codeSpans") {
				if (!rate(input) || Object.hasOwn(options, "perHundred")) return `${path}.limit`;
			} else if (field === "limit" && rule === "processNarration") {
				if (!integer(input, 1)) return `${path}.limit`;
			} else if (field === "enabled" || field === "limit" || special[rule]?.includes(field)) {
				if (!fields[field](input)) return `${path}.${field}`;
			} else return `${path} (unknown field)`;
		}
	}
	return undefined;
}

export function effectiveRules(config: CheckOverrides = {}) {
	const values = config.rules;
	const phraseOptions = values?.phrases;
	const normalize = (term: string) => term.trim().toLowerCase().replace(/\s+/gu, " ");
	const removed = new Set(phraseOptions?.removePhrases?.map(normalize));
	const phrases = [
		...new Set([...(phraseOptions?.phrases ?? DEFAULT_PHRASES), ...(phraseOptions?.addPhrases ?? [])].map(normalize)),
	].filter((term) => !removed.has(term));
	const basic = (rule: Exclude<Rule, "codeSpans">) => ({
		enabled: values?.[rule]?.enabled ?? true,
		limit: values?.[rule]?.limit ?? RULES[rule].limit,
	});
	return {
		dashes: basic("dashes"),
		escapedBreaks: basic("escapedBreaks"),
		phrases: { ...basic("phrases"), phrases },
		labelLines: basic("labelLines"),
		coinages: { ...basic("coinages"), allow: values?.coinages?.allow ?? RULES.coinages.allow },
		identifiers: basic("identifiers"),
		codeSpans: {
			enabled: values?.codeSpans?.enabled ?? true,
			limit: values?.codeSpans?.perHundred ?? values?.codeSpans?.limit ?? RULES.codeSpans.perHundred,
			minWords: values?.codeSpans?.minWords ?? RULES.codeSpans.minWords,
		},
		processNarration: {
			...basic("processNarration"),
			share: values?.processNarration?.share ?? RULES.processNarration.share,
		},
		opening: basic("opening"),
		negations: basic("negations"),
	};
}

export function describeRules(mode: "off" | "warn" | "block", config: CheckOverrides = {}): string[] {
	if (mode === "off") return ["Publication checks are off."];
	const rules = effectiveRules(config);
	const descriptions: Record<Rule, string> = {
		dashes:
			"Join clauses with ordinary words such as because, so or but, or split them into sentences. Do not use dashes, and do not swap them for semicolons, colons, parentheses or spaced hyphens. Date and number ranges are fine.",
		escapedBreaks: "Send real line breaks and tabs.",
		phrases: "State each point in your own words, without stock phrases or labels that announce candour.",
		labelLines: "Write each point as a sentence instead of opening lines with a label.",
		coinages: "Name things in ordinary words instead of hyphenated terms made up for the occasion.",
		identifiers: "Keep a path, hash or identifier only when the reader needs it to act, and say what it is.",
		codeSpans: "Use inline code only for text the reader must type or match exactly.",
		processNarration:
			"Say what you found and why it matters. Mention a step or a check only when the reader needs it to trust the result.",
		opening:
			"Open with the answer, the result or the decision, not with a description of the document or of your work.",
		negations: "Say what a thing is instead of defining it by what it is not.",
	};
	const intro =
		mode === "block"
			? "Publication refuses a document that breaks these writing rules."
			: "Publication reports where a document breaks these writing rules, and still saves it.";
	return [intro, ...RULE_IDS.filter((rule) => rules[rule].enabled).map((rule) => descriptions[rule])];
}
