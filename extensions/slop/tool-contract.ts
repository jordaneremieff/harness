import { arr, bool, int, lit, num, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { domains, idPattern, proseKinds, scopes } from "./vocabulary.ts";

const Id = str({ pattern: idPattern, maxLength: 128 });
const scope = union(scopes.map((name) => lit(name)));
const nonempty = str({ minLength: 1 });
const stringList = arr(nonempty, { minItems: 1 });
const scopesList = arr(scope, { minItems: 1 });

export const ViewParams = obj({
	entry: opt(Id),
	scope: opt(scope),
	query: opt(str()),
	starter: opt(bool({ description: "Compare the starter set with this catalog, or read one starter entry." })),
});
export const CheckParams = obj({
	text: opt(str({ description: "Inline prose, at most 8 MiB. Supply exactly one of text, path or diff." })),
	kind: opt(
		union(
			proseKinds.map((name) => lit(name)),
			{
				description:
					'For text, select reply (default), document or commit. For a prose file, set its scope; omit kind for recognised code. For a diff, omit to check all supported added lines and range commit messages. Use "document" for added document lines only or "commit" for range commit messages only (no paths).',
			},
		),
	),
	path: opt(
		str({
			minLength: 1,
			description:
				"One regular UTF-8 file, absolute or relative to the working directory, at most 8 MiB. The name selects document, code and comment checks. Supply a prose kind for a draft the name does not identify. Do not combine with text or diff.",
		}),
	),
	diff: opt(
		obj(
			{
				staged: opt(lit(true, { description: "Compare the index with HEAD. Do not combine with range." })),
				range: opt(str({ minLength: 1, description: "Two commit endpoints A..B. Do not combine with staged." })),
				paths: opt(
					arr(
						str({ minLength: 1, description: "A literal file or directory path relative to the working directory." }),
						{
							minItems: 1,
							description:
								"Limit changed files, not commit messages. No absolute paths, parent components or Git pathspec magic.",
						},
					),
				),
			},
			{
				description:
					"Git changes. Use {} for tracked worktree and index changes versus HEAD. Do not combine with text or path.",
			},
		),
	),
	entries: opt(
		arr(Id, { minItems: 1, description: "Limit checks to these catalog entry IDs. Omit to use all active detectors." }),
	),
});
export const CheckOutput = obj({
	ok: bool({ description: "True if no detector exceeded its allowance. This is not a prose review." }),
	findingCount: num({ description: "Number of detectors that exceeded their allowances." }),
	skippedCount: num({ description: "Number of inputs or lines explicitly skipped, as shown in the report." }),
});
const DetectorParams = obj({
	id: nonempty,
	in: scopesList,
	phrases: opt(stringList),
	pattern: opt(nonempty),
	limit: opt(int({ minimum: 0 })),
	per: opt(int({ minimum: 1 })),
	allow: opt(arr(nonempty)),
	lexicon: opt(bool()),
	caseSensitive: opt(bool()),
	distinct: opt(bool()),
	paths: opt(stringList),
});
const saveField = (text: string) => opt(str({ minLength: 1, description: `Required for a new entry: ${text}` }));
export const RecordParams = obj({
	action: union([lit("save"), lit("remove"), lit("disable"), lit("enable"), lit("import")]),
	id: opt(
		str({ pattern: idPattern, maxLength: 128, description: "Entry id in kebab-case. Required except for import." }),
	),
	ids: opt(
		arr(Id, {
			description: "Import only: replace these entries with starter copies. Omit to import new entries only.",
		}),
	),
	title: saveField("a short name for the habit itself, not for the topic of the reply."),
	domain: opt(
		union(
			domains.map((name) => lit(name)),
			{ description: "Required for a new entry: prose, code or ui." },
		),
	),
	applies: opt(
		arr(scope, {
			minItems: 1,
			description: "Required for a new entry: where the habit occurs: reply, document, commit, comment or code.",
		}),
	),
	recognition: saveField("how to spot the habit."),
	cost: saveField("what the habit costs the reader."),
	repair: saveField("how to fix the move behind the habit; the first sentence joins later prompts."),
	operator: opt(str({ minLength: 1, description: "Required for every save: the operator's own words." })),
	prompt: opt(
		bool({
			description: "Show the repair in later prompts. New entries default to true; existing entries keep their value.",
		}),
	),
	excerpt: opt(str({ description: "The flagged passage, when there is one." })),
	note: opt(str()),
	detectors: opt(
		arr(DetectorParams, {
			description:
				"Replace the detector list. Use [] to clear it. Each detector must match a Slop example and no Better examples.",
		}),
	),
	reason: opt(str({ description: "Only with remove, disable or enable: why the state changes." })),
	examples: opt(
		arr(
			obj({
				kind: str({
					minLength: 1,
					description: "reply, document or commit for prose, or a file extension such as ts for code.",
				}),
				verdict: union([lit("slop"), lit("better")], {
					description: "slop for the flagged passage, better for your repair.",
				}),
				text: str(),
			}),
			{ description: "Append examples that are not already in the entry." },
		),
	),
});

export type ViewArgs = Static<typeof ViewParams>;
export type CheckArgs = Static<typeof CheckParams>;
export type RecordArgs = Static<typeof RecordParams>;

export const catalogPreviewRows = 5;
