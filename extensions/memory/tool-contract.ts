import { arr, bool, int, num, obj, opt, str, type Schema, type Static } from "@earendil-works/pi-schema";
import { REVISION_PATTERN } from "./history.ts";
import { preflightRetrievalArguments } from "./retrieval.ts";
import { DIGEST, preflightMutationArguments, SLUG, WRITE_REVIEW_POLICY_HELP, type WriteReceipt } from "./store.ts";

/**
 * Tool schemas, model-facing text, and result framing shared by the ordinary
 * Pi factory and the durable contribution. Both entrypoints offer the same
 * seven memory tools against the same corpus; this module keeps their public
 * contract single-sourced.
 */

const StringEnum = <const T extends readonly string[]>(values: T): Schema<T[number]> => ({
	type: "string",
	enum: [...values],
});
const booleanLiteral = (value: true): Schema<true> => ({ type: "boolean", const: value });
const slug = () => str({ pattern: SLUG.source, minLength: 1, maxLength: 120 });
const digest = () => str({ pattern: DIGEST.source });
const reviewAfter = (): Schema<string | null> => ({ type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const reviewSources = () => str({ minLength: 1, maxLength: 1500 });
const reviewReason = () => str({ minLength: 1, maxLength: 600 });
const QUERY_DESCRIPTION =
	"Exact tokens or quoted literals; case-insensitive, no stemming or camelCase splitting. Up to 16 terms.";
const query = () => str({ maxLength: 200 });
const queryOrList: Schema<string | string[]> = {
	type: ["string", "array"],
	maxLength: 200,
	description: QUERY_DESCRIPTION,
	items: query(),
	minItems: 1,
	maxItems: 3,
};
const reviewPolicyOrNull: Schema<"on-change" | "before-use" | null> = {
	type: ["string", "null"],
	enum: ["on-change", "before-use", null],
};

export const memorySearchParameters = obj(
	{
		query: opt(queryOrList),
		includeRetired: opt(bool()),
		detail: opt(bool({ description: "Include full cues, freshness and search diagnostics." })),
		limit: opt(
			int({
				minimum: 1,
				maximum: 512,
				description: "Query: 1–25 (default 5). Browse: up to 512 cues within the byte limit.",
			}),
		),
		cursor: opt(
			str({
				minLength: 1,
				maxLength: 1024,
				description: "Returned nextCursor; repeat query and includeRetired.",
			}),
		),
	},
	{ open: true },
);

export const memoryReadParameters = obj(
	{
		slug: str({ minLength: 1, maxLength: 120, description: "Note slug, or README for the corpus contract." }),
		digest: opt(digest()),
		revision: opt(
			str({
				pattern: REVISION_PATTERN.source,
				maxLength: 121,
				description: "From memory_history. Omit for the current note.",
			}),
		),
		offset: opt(
			int({
				minimum: 0,
				maximum: 1000000000,
				description: "Returned nextOffset in code points; null ends the read.",
			}),
		),
	},
	{ open: true },
);

export const memoryHistoryParameters = obj(
	{
		slug: slug(),
		cursor: opt(str({ minLength: 1, maxLength: 1024 })),
		limit: opt(int({ minimum: 1, maximum: 100, description: "Revisions examined per page; default 25." })),
		plan: opt(
			obj(
				{
					capturedBefore: str({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }),
					keepNewest: num({ minimum: 0, maximum: 16384, multipleOf: 1 }),
				},
				{ open: true },
			),
		),
	},
	{ open: true },
);

export const memoryWriteParameters = obj(
	{
		slug: slug(),
		title: str({ minLength: 1, maxLength: 160 }),
		tags: arr(str({ minLength: 1, maxLength: 80 }), { maxItems: 16, uniqueItems: true }),
		summary: str({ minLength: 1, maxLength: 4000 }),
		details: str({ minLength: 1, maxLength: 24000 }),
		sources: str({
			minLength: 1,
			maxLength: 8000,
			description: "Sources, dates and scope of evidence.",
		}),
		verified: bool(),
		reviewPolicy: { ...StringEnum(["on-change", "before-use"]), description: WRITE_REVIEW_POLICY_HELP },
		reviewAfter: opt(reviewAfter()),
		expectedDigest: opt(digest()),
		supersedes: opt(arr(obj({ slug: slug(), digest: digest() }, { open: true }), { maxItems: 16 })),
	},
	{ open: true },
);

export const memoryEditParameters = obj(
	{
		slug: slug(),
		expectedDigest: digest(),
		verified: bool({ description: "Attest to the whole result; false clears verification." }),
		title: opt(str({ minLength: 1, maxLength: 160, description: "New single-line title; required without edits." })),
		edits: opt(
			arr(
				obj(
					{
						oldText: str({ minLength: 1, maxLength: 24000 }),
						newText: str({ maxLength: 24000, description: "Empty deletes the match." }),
					},
					{ open: true },
				),
				{ minItems: 1, maxItems: 32, description: "Exact replacements against the original body." },
			),
		),
	},
	{ open: true },
);

export const memoryReviewParameters = obj(
	{
		slug: slug(),
		expectedDigest: digest(),
		outcome: StringEnum(["confirmed", "unresolved"]),
		sources: reviewSources(),
		reason: opt(str({ minLength: 1, maxLength: 600, description: "Required for unresolved only." })),
		reviewPolicy: opt(reviewPolicyOrNull),
		reviewAfter: opt(reviewAfter()),
		reactivate: opt(booleanLiteral(true)),
	},
	{ open: true },
);

export const memoryRetireParameters = obj(
	{
		slug: slug(),
		expectedDigest: digest(),
		reason: reviewReason(),
		sources: reviewSources(),
	},
	{ open: true },
);

function withArgumentPreflight<S extends object>(parameters: S, check: (args: unknown) => void) {
	return {
		parameters,
		prepareArguments(args: unknown): Static<S> {
			check(args);
			return args as Static<S>;
		},
	};
}

// Pi validates types after preparation; check raw keys first so a typo in a required key gets a safe diagnostic.
export const memoryToolArguments = {
	search: withArgumentPreflight(memorySearchParameters, (args) => preflightRetrievalArguments("search", args)),
	read: withArgumentPreflight(memoryReadParameters, (args) => preflightRetrievalArguments("read", args)),
	history: withArgumentPreflight(memoryHistoryParameters, (args) => preflightRetrievalArguments("history", args)),
	write: withArgumentPreflight(memoryWriteParameters, (args) => preflightMutationArguments("write", args)),
	edit: withArgumentPreflight(memoryEditParameters, (args) => preflightMutationArguments("edit", args)),
	review: withArgumentPreflight(memoryReviewParameters, (args) => preflightMutationArguments("review", args)),
	retire: withArgumentPreflight(memoryRetireParameters, (args) => preflightMutationArguments("retire", args)),
};

export const MEMORY_TOOL_DESCRIPTIONS = {
	search:
		"Find durable operator knowledge; omit query to browse. Try short alternatives or exact identifiers. Read selected notes from offset 0 with their digests. Rank is not confidence. Follow nextCursor even after empty pages; rank and counts are per window, not a corpus snapshot. Unavailable sources remain unknown. Retired notes require includeRetired:true.",
	read: "Read exact note bytes as text, with lifecycle and freshness. Use a search digest on the first page and the same digest and revision on continuation. On a changed current source, restart at offset 0 without the old digest; search if the slug is absent. Historical revisions are not current authority.",
	history:
		"List prior captures for a subject; read a revision with memory_read. Captures do not prove a write succeeded. Continue with nextCursor. A retention plan lists metadata only; it neither verifies bytes nor authorises removal.",
	write:
		"Create a note or rewrite one with its current digest. Use memory_edit for targeted changes. Name subjects this note replaces in supersedes with their current digests. On partial publication, inspect written and notWritten before retry.",
	edit: "Correct a note's title, make exact nonoverlapping body edits, or both. Supply its current digest and attest to the whole result. verified:true clears a concern.",
	review:
		"Review a current note by digest. Confirmed attests to the whole note against sources inspected now and clears a concern. Unresolved records a concern with reason and sources, without renewing verification. Omit policy or deadline to preserve; null clears. Reactivation requires confirmed and reactivate:true.",
	retire:
		"Withdraw an active note without a replacement, by current digest, reason and sources. Age or an unresolved concern alone does not justify retirement. The note remains readable.",
} as const;

export const MEMORY_SEARCH_GUIDELINES: readonly string[] = [
	'Consult memory before a choice depends on prior operator preferences, decisions, corrections, environment, providers, models or recurring lessons, even without a memory request. Standalone "memo" also triggers consultation. Skip general questions and repository-defined facts.',
	"Read a matching index subject or search when none fits. Check lifecycle, replacements and freshness before use. Current instructions control; notes never grant fresh authority. Recheck on-change notes after contrary evidence or scope changes. Check before-use sources even if verified today; the check needs no write. Due is not expiry. A concern qualifies only the disputed claim.",
];

export const MEMORY_WRITE_GUIDELINES: readonly string[] = [
	"Store durable operator preferences, confirmed decisions and reasons, authoritative environment facts or verified recurring lessons. High confidence: store automatically when explicit or verified, future-useful, concise, sourced and not already stored. Medium confidence: ask only if the future value matters. Low confidence or silence: do not infer or store.",
	"Never store task state, handovers, TODOs, logs, repository-defined facts, secrets, sensitive personal data or speculation. Search before creation or if the target is unknown. Read the corpus README before the first write if it exists. Use memory_edit for targeted changes, not ordinary file edits. Set verified:true only after a whole-result check against an operator statement about their own facts or preferences, or an authoritative source inspected now. Choose reviewPolicy on creation or full rewrite. Justify any reviewAfter date in sources. Report Memory updated: <file>. Delete only on explicit request. Check dependants; forgetting includes retained history and external archives within scope.",
];

export const MEMORY_REVIEW_GUIDELINES: readonly string[] = [
	"Persist reviews for durable verification or concerns. A failed check is not confirmation; cite the unavailable source and record unresolved only for a durable concern. Reactivation requires authority and new evidence for a retired note; it never reverses supersession.",
];

/** Ordinary rules order: the registered tools in factory order. */
export const MEMORY_GUIDELINES: readonly string[] = [
	...MEMORY_SEARCH_GUIDELINES,
	...MEMORY_WRITE_GUIDELINES,
	...MEMORY_REVIEW_GUIDELINES,
];

/** Model-visible text shared by the ordinary mutation result and the durable tool content. */
export function memoryMutationText(root: string, details: WriteReceipt): string {
	const notice = details.written
		.filter((file) => file !== "README.md")
		.map((file) => `Memory updated: ${file}`)
		.join("\n");
	return `${details.initialized ? `Memory initialized: ${root}\n` : ""}${notice}\n${JSON.stringify(details)}`;
}

/** Ordinary Pi result envelope for one corpus mutation. */
export function memoryMutationResult(root: string, details: WriteReceipt) {
	return {
		content: [{ type: "text" as const, text: memoryMutationText(root, details) }],
		details,
	};
}
