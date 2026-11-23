import { arr, bool, int, lit, num, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { domains, firstSentence, idPattern, scopes } from "./catalog.ts";
import { checkLines, type Finding, proseKinds, segment } from "./detect.ts";
import { type Collected, diffInput, fileInput } from "./input.ts";
import { type ReadOptions, readSettings } from "./settings.ts";
import {
	type CatalogEntry,
	compareStarter,
	type Identity,
	importEntries,
	promptCues,
	promptSection,
	readCatalog,
	readLexicon,
	removeEntry,
	saveEntry,
	setDisabled,
} from "./store.ts";

const Id = str({ pattern: idPattern, maxLength: 128 });
const scope = union(scopes.map((name) => lit(name)));
const kind = union(proseKinds.map((name) => lit(name)));
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
	text: opt(str()),
	kind: opt(kind),
	path: opt(nonempty),
	diff: opt(obj({ staged: opt(lit(true)), range: opt(nonempty), paths: opt(stringList) })),
	entries: opt(arr(Id, { minItems: 1 })),
});
export const CheckOutput = obj({ ok: bool(), findingCount: num(), skippedCount: num() });
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

export const VIEW_DESCRIPTION =
	"Read this machine's slop catalog: habits in prose, code and interfaces that read as generated, each with its repair. List or filter entries, read one, or compare the bundled starter set with the catalog.";
export const CHECK_DESCRIPTION =
	"Run the slop catalog's detectors on text, one file or a Git diff: uncommitted, staged, or a range with its commit messages. Run it on the staged diff before each commit, and on documents and messages written for someone else. Do not run it on ordinary chat replies. Repair the move a finding names, not its token.";
export const RECORD_DESCRIPTION =
	"Change this machine's slop catalog: save a new entry or update one, remove, disable or enable an entry, or import entries from the bundled starter set. The operator asks for these changes in chat.";

export const SNIPPETS = {
	slop: "Read or compare the machine's catalog of prose, code and interface habits",
	check: "Check text, a file or a Git diff against the slop catalog",
	record: "Record habits the operator flags as slop and maintain the catalog",
} as const;

export const RECORD_GUIDELINES = [
	"When the operator calls a reply, passage or piece of code slop, or objects to a writing or code habit in other words, record the habit with slop_record before you fix it.",
	"If a catalog entry already covers the flagged habit, update that entry with slop_record: add the flagged passage and your repair as examples and set prompt to true, so later sessions see its repair. Otherwise save a new entry.",
];

export function catalogSection(options: ReadOptions): string | undefined {
	const { values } = readSettings(options);
	if (values.prompt === "off") return undefined;
	try {
		return promptSection(readCatalog(values.dir));
	} catch {
		return undefined;
	} // A store error must not prevent a turn; catalog and check calls report it.
}

export const stateLabel = (entry: CatalogEntry) => (entry.disabled ? "off" : "active");
export const searchEntry = (entry: CatalogEntry, query: string) =>
	[entry.id, entry.title, entry.recognition].some((value) => value.toLowerCase().includes(query.toLowerCase()));
const textBlock = (text: string) => [{ type: "text" as const, text }];
export type ViewArgs = Static<typeof ViewParams>;
export type CheckArgs = Static<typeof CheckParams>;
export type RecordArgs = Static<typeof RecordParams>;

export const catalogPreviewRows = 5;

type CatalogListDetails = {
	kind: "catalog" | "starter";
	count: number;
	rows: string[];
	hasGuidance: boolean;
	fresh?: number;
	updated?: number;
};

type CatalogReceipt = {
	content: ReturnType<typeof textBlock>;
	details: { summary: string; list?: CatalogListDetails };
};

export function inspectStarter(comparison: ReturnType<typeof compareStarter>, id?: string): CatalogReceipt {
	if (id !== undefined) {
		const item = comparison.find(({ entry }) => entry.id === id);
		if (!item) throw new Error(`No starter entry named ${id}.`);
		const { entry, status } = item;
		return {
			content: textBlock(`${entry.id} · ${status}\n\n${entry.raw}`),
			details: { summary: `${entry.title} · ${status}` },
		};
	}
	const lines = comparison.map(({ entry, status }) => `- ${entry.id} · ${status} · ${entry.title}`);
	const list: CatalogListDetails = {
		kind: "starter",
		count: comparison.length,
		rows: lines.slice(0, catalogPreviewRows),
		hasGuidance: true,
	};
	lines.push(
		'Import new entries with slop_record action "import". For an updated entry, read both versions and decide.',
	);
	return { content: textBlock(lines.join("\n")), details: { summary: `${comparison.length} starter entries`, list } };
}

export function inspectCatalog(options: ReadOptions, args: ViewArgs): CatalogReceipt {
	if ((args.entry !== undefined || args.starter) && (args.scope !== undefined || args.query !== undefined))
		throw new Error("Use scope and query only to filter the catalog inventory.");
	const { dir, prompt } = readSettings(options).values;
	const entries = readCatalog(dir);
	if (args.entry !== undefined && !args.starter) {
		const entry = entries.find((item) => item.id === args.entry);
		if (!entry) throw new Error(`No slop entry named ${args.entry}.`);
		return {
			content: textBlock(`${entry.id} · ${entry.origin} · ${stateLabel(entry)}\n\n${entry.raw}`),
			details: { summary: `${entry.title} · ${stateLabel(entry)}` },
		};
	}
	const comparison = compareStarter(dir, entries);
	if (args.starter) return inspectStarter(comparison, args.entry);
	const cues = prompt === "on" ? promptCues(entries) : new Map<string, string>();
	const selected = entries.filter(
		(entry) =>
			(args.scope === undefined || entry.applies.includes(args.scope)) &&
			(args.query === undefined || searchEntry(entry, args.query)),
	);
	const rows: string[] = [];
	const lines = domains.flatMap((domain) => {
		const group = selected.filter((entry) => entry.domain === domain);
		if (!group.length) return [];
		return [`${domain}:`, ...group.map((entry) => catalogRow(entry, cues.has(entry.id), rows))];
	});
	if (!lines.length) lines.push("No matching slop entries.");
	const fresh = comparison.filter(({ status }) => status === "new").length;
	const updated = comparison.filter(({ status }) => status === "updated").length;
	if (fresh || updated)
		lines.unshift(`Starter set: ${fresh} new, ${updated} updated. Read with slop {"starter":true}.`);
	const list: CatalogListDetails = {
		kind: "catalog",
		count: selected.length,
		rows,
		hasGuidance: Boolean(fresh || updated),
		fresh,
		updated,
	};
	return { content: textBlock(lines.join("\n")), details: { summary: `${selected.length} slop entries`, list } };
}

function catalogRow(entry: CatalogEntry, prompt: boolean, preview: string[]): string {
	const title = `- ${entry.id} · ${entry.title}`;
	const origin = `${entry.origin} · ${stateLabel(entry)}${prompt ? " · prompt" : ""}`;
	const recognition = firstSentence(entry.recognition);
	const detectors = entry.detectors.length;
	if (preview.length < catalogPreviewRows) {
		const detectorFact = detectors ? ` · ${detectors} ${detectors === 1 ? "detector" : "detectors"}` : "";
		preview.push(`${title} · ${entry.domain} · ${origin}${detectorFact} · ${recognition}`);
	}
	return `${title} · ${origin} · ${detectors} detector(s) · ${recognition}`;
}

const closing = "Repair the underlying move: a synonym or punctuation swap keeps the tell.";
const maxReportBytes = 8192;
function* reportFindings(findings: Finding[]) {
	let previous = "";
	for (const finding of findings) {
		const group = previous === finding.id ? "" : `\n${finding.id} · ${finding.title}\n  Repair: ${finding.repair}\n`;
		yield `${group}  ${finding.detector}: ${finding.count} ${finding.count === 1 ? "match" : "matches"}, allowance ${finding.allowance}`;
		previous = finding.id;
		for (const location of finding.locations) {
			const name = location.path ?? (location.commit ? `commit ${location.commit.slice(0, 12)}` : undefined);
			yield `    ${name ? `${JSON.stringify(name)}:` : "line "}${location.line} ${JSON.stringify(location.match)} · ${location.excerpt}`;
		}
	}
}
function* reportSkipped(skipped: string[]) {
	if (!skipped.length) return;
	yield `\nSkipped ${skipped.length} input(s):`;
	for (const item of skipped) yield `- ${JSON.stringify(item)}`;
}
function formatReport(findings: Finding[], skipped: string[]) {
	const lines = [findings.length ? `${findings.length} slop detector finding(s):` : "No slop findings."];
	let bytes = Buffer.byteLength(lines[0]);
	let truncated = false;
	for (const section of [reportFindings(findings), reportSkipped(skipped)]) {
		for (const line of section) {
			const size = Buffer.byteLength(line) + 1;
			if (bytes + size > maxReportBytes - 200) {
				truncated = true;
				break;
			}
			lines.push(line);
			bytes += size;
		}
	}
	if (truncated) lines.push("Output limit reached; check fewer paths or entries to see more.");
	return { text: `${lines.join("\n")}\n${closing}`, truncated };
}

/** Longer lines are minified code or data; checking them costs time without finding prose or comments. */
const longestLine = 20_000;

export function runCheck(options: ReadOptions, input: Collected, ids?: string[]) {
	const { values } = readSettings(options);
	const catalog = readCatalog(values.dir);
	if (ids)
		for (const id of ids) if (!catalog.some((entry) => entry.id === id)) throw new Error(`No slop entry named ${id}.`);
	const entries = catalog.filter((entry) => !entry.disabled && (ids === undefined || ids.includes(entry.id)));
	const usesLexicon = entries.some((entry) => entry.detectors.some((detector) => detector.lexicon));
	const lines = input.lines.filter((line) => line.text.length <= longestLine);
	const skipped = [
		...input.skipped,
		...input.lines
			.filter((line) => line.text.length > longestLine)
			.map(
				(line) =>
					`${line.path ?? (line.commit ? `commit ${line.commit.slice(0, 12)}` : "text")}:${line.line}: line longer than ${longestLine} characters`,
			),
	];
	const findings = checkLines(entries, lines, readLexicon(usesLexicon ? values.lexicon : undefined));
	const report = formatReport(findings, skipped);
	const details = {
		ok: findings.length === 0,
		findingCount: findings.length,
		skippedCount: skipped.length,
		reportLimited: report.truncated,
		locationsLimited: findings.some((finding) => finding.count > finding.locations.length),
	};
	return { content: textBlock(report.text), details };
}

export async function check(options: ReadOptions, cwd: string, args: CheckArgs, signal?: AbortSignal) {
	if ([args.text, args.path, args.diff].filter((value) => value !== undefined).length !== 1)
		throw new Error("Choose exactly one of text, path or diff.");
	if (args.kind !== undefined && args.text === undefined) throw new Error("kind applies only to text.");
	const { text, path, diff, entries } = args;
	let input: Collected;
	if (text !== undefined) {
		if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("Text exceeds 8 MiB.");
		input = { lines: segment({ kind: args.kind ?? "reply", text }), skipped: [] };
	} else if (path !== undefined) input = fileInput(cwd, path);
	else if (diff !== undefined) {
		if (diff.staged && diff.range !== undefined) throw new Error("Choose staged or range, not both.");
		input = await diffInput(cwd, diff, signal);
	} else throw new Error("No input.");
	signal?.throwIfAborted();
	return runCheck(options, input, entries);
}

const actionFields = {
	save: [
		"id",
		"operator",
		"title",
		"domain",
		"applies",
		"recognition",
		"cost",
		"repair",
		"prompt",
		"excerpt",
		"note",
		"detectors",
		"examples",
	],
	remove: ["id", "reason"],
	disable: ["id", "reason"],
	enable: ["id", "reason"],
	import: ["ids"],
};

export function record(
	options: ReadOptions,
	args: RecordArgs,
	identity: Identity,
): {
	content: ReturnType<typeof textBlock>;
	details: { summary: string; id?: string; unmatchedCount?: number; importedCount?: number };
} {
	const { action, id, operator, reason } = args;
	const fields = actionFields[action];
	if (Object.keys(args).some((key) => key !== "action" && !fields.includes(key)))
		throw new Error(`${action} accepts only these fields besides action: ${fields.join(", ")}.`);
	const { dir, lexicon } = readSettings(options).values;
	if (action === "import") {
		const ids = importEntries(dir, args.ids);
		const summary = ids.length ? `Imported starter entries: ${ids.join(", ")}.` : "No new starter entries to import.";
		return { content: textBlock(summary), details: { summary, importedCount: ids.length } };
	}
	if (id === undefined) throw new Error(`${action} requires id.`);
	let summary: string;
	if (action === "save") {
		if (operator === undefined) throw new Error("Save requires operator: the operator's own words.");
		const { entry, unmatched } = saveEntry(dir, { ...args, id, operator }, identity, lexicon);
		summary = `Saved ${entry.id} (${stateLabel(entry)}).`;
		const content = unmatched.length ? `${summary}\nNo detector matched: ${unmatched.join(", ")}.` : summary;
		return { content: textBlock(content), details: { id, summary, unmatchedCount: unmatched.length } };
	}
	if (action === "remove") {
		removeEntry(dir, id, identity, reason);
		summary = `Removed ${id}.`;
	} else {
		setDisabled(dir, id, action === "disable", identity, reason);
		summary = `${id} is ${action === "disable" ? "off" : "active"}.`;
	}
	return { content: textBlock(summary), details: { id, summary } };
}
