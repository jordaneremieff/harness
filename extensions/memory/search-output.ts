import { Type } from "@earendil-works/pi-ai";

const count = () => Type.Integer({ minimum: 0 });
const digest = () => Type.String({ pattern: "^[a-f0-9]{64}$" });
const date = () => Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const nullableDate = () => Type.Union([date(), Type.Null()]);
const query = () => Type.String({ minLength: 1, maxLength: 200 });
const cue = () => Type.Optional(Type.String({ maxLength: 240 }));
const concern = Type.Union([
	Type.Object(
		{ date: date(), reason: Type.String({ maxLength: 600 }), sources: Type.String({ maxLength: 1500 }) },
		{
			additionalProperties: false,
		},
	),
	Type.Null(),
]);
const matched = Type.Array(
	Type.Object(
		{
			term: Type.String(),
			fields: Type.Array(
				Type.Union([
					Type.Literal("slug"),
					Type.Literal("title"),
					Type.Literal("tags"),
					Type.Literal("frontmatter"),
					Type.Literal("body"),
				]),
				{ maxItems: 5 },
			),
		},
		{ additionalProperties: false },
	),
	{ maxItems: 16 },
);
const missing = Type.Array(Type.String(), { maxItems: 16 });
const terms = Type.Array(
	Type.Object(
		{
			text: Type.String(),
			kind: Type.Union([Type.Literal("word"), Type.Literal("compound"), Type.Literal("phrase")]),
			notes: count(),
		},
		{ additionalProperties: false },
	),
	{ maxItems: 16 },
);

/** The bounded public page, not the scanner's source buffers or ranking state. */
export const memorySearchOutputSchema = Type.Object(
	{
		ok: Type.Literal(true),
		kind: Type.Literal("index"),
		root: Type.String({ maxLength: 1024 }),
		query: Type.Union([query(), Type.Array(query(), { minItems: 1, maxItems: 3 }), Type.Null()]),
		includeRetired: Type.Boolean(),
		excludedRetired: count(),
		pageOffset: count(),
		countScope: Type.Literal("source-window"),
		coverage: Type.Object(
			{
				traversedCandidates: count(),
				totalCandidates: count(),
				traversalComplete: Type.Boolean(),
				frozenSnapshot: Type.Literal(false),
				meaning: Type.String(),
			},
			{ additionalProperties: false },
		),
		pageSize: Type.Integer({ minimum: 1, maximum: 512 }),
		totalNotes: count(),
		totalMatches: count(),
		returned: count(),
		hasMore: Type.Boolean(),
		nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 1024 }), Type.Null()], {
			description:
				"Repeat query and includeRetired with this cursor, including after empty pages. Null ends traversal.",
		}),
		corpusEmpty: Type.Union([Type.Boolean(), Type.Null()]),
		scan: Type.Object(
			{
				complete: Type.Boolean(),
				visited: count(),
				visitCap: count(),
				inventoryComplete: Type.Literal(true),
				inventoryDigest: digest(),
				totalCandidates: count(),
				windowStart: count(),
				windowEnd: count(),
				windowNotes: count(),
				windowNoteCap: count(),
				sourceBytes: count(),
				windowByteCap: count(),
				issueCount: count(),
				unavailableNotes: count(),
				issuesShown: count(),
				issues: Type.Array(
					Type.Object(
						{ code: Type.String(), message: Type.String({ maxLength: 240 }) },
						{
							additionalProperties: false,
						},
					),
					{ maxItems: 20 },
				),
				retiredNotes: count(),
				excludedRetired: count(),
			},
			{ additionalProperties: false },
		),
		notes: Type.Array(
			Type.Object(
				{
					slug: Type.String({ minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
					title: Type.String({ maxLength: 160 }),
					lifecycle: Type.Object(
						{
							status: Type.Union([
								Type.Literal("active"),
								Type.Literal("superseded"),
								Type.Literal("retired"),
								Type.Literal("unknown"),
							]),
							supersededBy: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
							problem: cue(),
						},
						{ additionalProperties: false },
					),
					freshness: Type.Object(
						{
							evaluatedOn: date(),
							verified: Type.Union([Type.Boolean(), Type.Null()]),
							verifiedDate: nullableDate(),
							policy: Type.Union([
								Type.Literal("on-change"),
								Type.Literal("before-use"),
								Type.Literal("unclassified"),
								Type.Literal("unknown"),
							]),
							reviewAfter: nullableDate(),
							deadline: Type.Union([
								Type.Literal("due"),
								Type.Literal("not-due"),
								Type.Literal("unscheduled"),
								Type.Literal("unknown"),
							]),
							concern,
							lastReview: Type.Union([
								Type.Object(
									{ date: date(), digest: digest(), sources: Type.String({ maxLength: 1500 }) },
									{
										additionalProperties: false,
									},
								),
								Type.Null(),
							]),
							retirement: concern,
							problems: Type.Array(Type.String()),
						},
						{ additionalProperties: false },
					),
					tags: cue(),
					status: cue(),
					supersedes: cue(),
					superseded_by: cue(),
					cueProblem: cue(),
					digest: Type.Optional(digest()),
					rank: Type.Optional(Type.Integer({ minimum: 1 })),
					matched: Type.Optional(matched),
					missing: Type.Optional(missing),
					sourceMatch: Type.Optional(
						Type.Union([
							Type.Object(
								{
									offset: count(),
									endOffset: count(),
									excerptOffset: count(),
									excerptEndOffset: count(),
									excerpt: Type.String({ maxLength: 480 }),
								},
								{ additionalProperties: false },
							),
							Type.Null(),
						]),
					),
					formulations: Type.Optional(
						Type.Array(
							Type.Object(
								{
									query: query(),
									rank: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
									matched,
									missing,
								},
								{ additionalProperties: false },
							),
							{ minItems: 1, maxItems: 3 },
						),
					),
				},
				{ additionalProperties: false },
			),
			{
				maxItems: 512,
				description:
					"Cues have no digest or rank. Query hits include a source digest and window-local rank; neither establishes truth or freshness.",
			},
		),
		search: Type.Optional(
			Type.Object(
				{
					complete: Type.Boolean(),
					notesSearched: count(),
					unavailableNotes: count(),
					maxSourceBytes: count(),
					ranking: Type.Union([Type.Literal("lexical"), Type.Literal("best-rank-then-reciprocal-rank-fusion")]),
					terms: Type.Optional(terms),
					ignored: Type.Optional(Type.Array(Type.String())),
					formulations: Type.Optional(
						Type.Array(
							Type.Object(
								{
									query: query(),
									terms,
									ignored: Type.Array(Type.String()),
								},
								{ additionalProperties: false },
							),
							{ minItems: 1, maxItems: 3 },
						),
					),
					excludedRetired: count(),
				},
				{ additionalProperties: false },
			),
		),
		guidance: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
