export const DEFAULT_PHRASES = [
	"the honest part", "to be honest", "honestly", "frankly", "nothing needed from you", "nothing for you",
	"nothing needs you", "nothing from you", "byte for byte", "byte-for-byte", "byte-identical", "load-bearing",
	"bottom line:", "in summary", "say the word", "for you to judge",
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

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
const termList = (value: unknown): boolean => Array.isArray(value) && value.length <= 128 && value.every((term: unknown) => text(term) && term.length <= 120);
const integer = (value: unknown, min = 0): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const rate = (value: unknown, max = Number.MAX_SAFE_INTEGER): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
const fields: Record<string, (value: unknown) => boolean> = {
	enabled: (value) => typeof value === "boolean", limit: integer, phrases: termList, addPhrases: termList, removePhrases: termList,
	allow: termList, minWords: integer, perHundred: rate, share: (value) => rate(value, 1),
};
const special: Partial<Record<Rule, string[]>> = { phrases: ["phrases", "addPhrases", "removePhrases"], coinages: ["allow"], codeSpans: ["perHundred", "minWords"], processNarration: ["share"] };

/** Returns the first invalid field. Unknown names are not reflected into the agent's context. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validate nested rule fields in declaration order so the first diagnostic is stable.
export function invalidCheckField(value: unknown): string | undefined {
	if (!object(value)) return "checksRules";
	if (Object.keys(value).some((key) => key !== "rules" && key !== "lexicon")) return "checksRules (unknown field)";
	if (Object.hasOwn(value, "lexicon") && (!text(value.lexicon) || value.lexicon.length > 4096)) return "checksRules.lexicon";
	if (!Object.hasOwn(value, "rules")) return undefined;
	if (!object(value.rules) || Object.keys(value.rules).some((key) => !Object.hasOwn(RULES, key))) return "checksRules.rules";
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
	const phrases = [...new Set([...(phraseOptions?.phrases ?? DEFAULT_PHRASES), ...(phraseOptions?.addPhrases ?? [])].map(normalize))].filter((term) => !removed.has(term));
	const basic = (rule: Exclude<Rule, "codeSpans">) => ({ enabled: values?.[rule]?.enabled ?? true, limit: values?.[rule]?.limit ?? RULES[rule].limit });
	return {
		dashes: basic("dashes"), escapedBreaks: basic("escapedBreaks"), phrases: { ...basic("phrases"), phrases }, labelLines: basic("labelLines"),
		coinages: { ...basic("coinages"), allow: values?.coinages?.allow ?? RULES.coinages.allow }, identifiers: basic("identifiers"),
		codeSpans: { enabled: values?.codeSpans?.enabled ?? true, limit: values?.codeSpans?.perHundred ?? values?.codeSpans?.limit ?? RULES.codeSpans.perHundred, minWords: values?.codeSpans?.minWords ?? RULES.codeSpans.minWords },
		processNarration: { ...basic("processNarration"), share: values?.processNarration?.share ?? RULES.processNarration.share }, opening: basic("opening"), negations: basic("negations"),
	};
}

export function describeRules(mode: "off" | "warn" | "block", config: CheckOverrides = {}): string[] {
	if (mode === "off") return ["Publication checks are off."];
	const rules = effectiveRules(config);
	const { codeSpans } = rules;
	const cap = (limit: number, words: string) => limit === 0 ? `Use no ${words}.` : `Use at most ${limit} ${words}.`;
	const descriptions: Record<Rule, string> = {
		dashes: `Join clauses with words or split them into sentences. ${cap(rules.dashes.limit, "dashes or spaced hyphens between clauses")} Do not swap dashes for semicolons, colons or parentheses. Date and number ranges with an en dash are fine.`,
		escapedBreaks: `Send real line breaks and tabs.${rules.escapedBreaks.limit ? ` ${cap(rules.escapedBreaks.limit, "literal line break or tab escapes")}` : ""}`,
		phrases: `State the point in your own words. ${cap(rules.phrases.limit, "phrases from the stock phrase list")}`,
		labelLines: `State each point directly. ${cap(rules.labelLines.limit, "lines that open with a label and a colon")}`,
		coinages: `Use ordinary words. ${cap(rules.coinages.limit, "different unfamiliar hyphenated terms")}`,
		identifiers: `Keep paths and identifiers only when the reader needs them. ${cap(rules.identifiers.limit, "paths or identifiers outside inline code")}`,
		codeSpans: `Use inline code only when the exact text matters. In prose of ${codeSpans.minWords} words or more, use at most ${codeSpans.limit} spans per 100 words.`,
		processNarration: "Say what you found and why it matters. Include a step or check only if the reader needs it.",
		opening: "Start with the answer, result or decision, without announcing the document or listing what you did.",
		negations: `Say what the thing is. ${cap(rules.negations.limit, "contrasts that start with what it is not")}`,
	};
	const intro = mode === "block" ? "Fix these problems before you publish." : "Publication reports these problems but still saves the document.";
	return [intro, ...RULE_IDS.filter((rule) => rules[rule].enabled).map((rule) => descriptions[rule])];
}
