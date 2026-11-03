import { arr, bool, int, lit, nul, obj, opt, str, union } from "@earendil-works/pi-schema";

const count = () => int({ minimum: 0 });
const digest = () => str({ pattern: "^[a-f0-9]{64}$" });
const date = () => str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const nullableDate = () => union([date(), nul()]);
const query = () => str({ minLength: 1, maxLength: 200 });
const cue = () => opt(str({ maxLength: 240 }));
const concern = union([
	obj(
		{ date: date(), reason: str({ maxLength: 600 }), sources: str({ maxLength: 1500 }) },
		{
			open: false,
		},
	),
	nul(),
]);
const matched = arr(
	obj(
		{
			term: str(),
			fields: arr(
				union([
					lit("slug"),
					lit("title"),
					lit("tags"),
					lit("frontmatter"),
					lit("body"),
				]),
				{ maxItems: 5 },
			),
		},
		{ open: false },
	),
	{ maxItems: 16 },
);
const missing = arr(str(), { maxItems: 16 });
const terms = arr(
	obj(
		{
			text: str(),
			kind: union([lit("word"), lit("compound"), lit("phrase")]),
			notes: count(),
		},
		{ open: false },
	),
	{ maxItems: 16 },
);

/** The bounded public page, not the scanner's source buffers or ranking state. */
export const memorySearchOutputSchema = obj(
	{
		ok: lit(true),
		kind: lit("index"),
		root: str({ maxLength: 1024 }),
		query: union([query(), arr(query(), { minItems: 1, maxItems: 3 }), nul()]),
		includeRetired: bool(),
		excludedRetired: count(),
		pageOffset: count(),
		countScope: lit("source-window"),
		coverage: obj(
			{
				traversedCandidates: count(),
				totalCandidates: count(),
				traversalComplete: bool(),
				frozenSnapshot: lit(false),
				meaning: str(),
			},
			{ open: false },
		),
		pageSize: int({ minimum: 1, maximum: 512 }),
		totalNotes: count(),
		totalMatches: count(),
		returned: count(),
		hasMore: bool(),
		nextCursor: union([str({ minLength: 1, maxLength: 1024 }), nul()], {
			description:
				"Repeat query and includeRetired with this cursor, including after empty pages. Null ends traversal.",
		}),
		corpusEmpty: union([bool(), nul()]),
		scan: obj(
			{
				complete: bool(),
				visited: count(),
				visitCap: count(),
				inventoryComplete: lit(true),
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
				issues: arr(
					obj(
						{ code: str(), message: str({ maxLength: 240 }) },
						{
							open: false,
						},
					),
					{ maxItems: 20 },
				),
				retiredNotes: count(),
				excludedRetired: count(),
			},
			{ open: false },
		),
		notes: arr(
			obj(
				{
					slug: str({ minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
					title: str({ maxLength: 160 }),
					lifecycle: obj(
						{
							status: union([
								lit("active"),
								lit("superseded"),
								lit("retired"),
								lit("unknown"),
							]),
							supersededBy: union([str({ maxLength: 120 }), nul()]),
							problem: cue(),
						},
						{ open: false },
					),
					freshness: obj(
						{
							evaluatedOn: date(),
							verified: union([bool(), nul()]),
							verifiedDate: nullableDate(),
							policy: union([
								lit("on-change"),
								lit("before-use"),
								lit("unclassified"),
								lit("unknown"),
							]),
							reviewAfter: nullableDate(),
							deadline: union([
								lit("due"),
								lit("not-due"),
								lit("unscheduled"),
								lit("unknown"),
							]),
							concern,
							lastReview: union([
								obj(
									{ date: date(), digest: digest(), sources: str({ maxLength: 1500 }) },
									{
										open: false,
									},
								),
								nul(),
							]),
							retirement: concern,
							problems: arr(str()),
						},
						{ open: false },
					),
					tags: cue(),
					status: cue(),
					supersedes: cue(),
					superseded_by: cue(),
					cueProblem: cue(),
					digest: opt(digest()),
					rank: opt(int({ minimum: 1 })),
					matched: opt(matched),
					missing: opt(missing),
					sourceMatch: opt(
						union([
							obj(
								{
									offset: count(),
									endOffset: count(),
									excerptOffset: count(),
									excerptEndOffset: count(),
									excerpt: str({ maxLength: 480 }),
								},
								{ open: false },
							),
							nul(),
						]),
					),
					formulations: opt(
						arr(
							obj(
								{
									query: query(),
									rank: union([int({ minimum: 1 }), nul()]),
									matched,
									missing,
								},
								{ open: false },
							),
							{ minItems: 1, maxItems: 3 },
						),
					),
				},
				{ open: false },
			),
			{
				maxItems: 512,
				description:
					"Cues have no digest or rank. Query hits include a source digest and window-local rank; neither establishes truth or freshness.",
			},
		),
		search: opt(
			obj(
				{
					complete: bool(),
					notesSearched: count(),
					unavailableNotes: count(),
					maxSourceBytes: count(),
					ranking: union([lit("lexical"), lit("best-rank-then-reciprocal-rank-fusion")]),
					terms: opt(terms),
					ignored: opt(arr(str())),
					formulations: opt(
						arr(
							obj(
								{
									query: query(),
									terms,
									ignored: arr(str()),
								},
								{ open: false },
							),
							{ minItems: 1, maxItems: 3 },
						),
					),
					excludedRetired: count(),
				},
				{ open: false },
			),
		),
		guidance: opt(str()),
	},
	{ open: false },
);
