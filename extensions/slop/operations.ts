import { arr, bool, int, lit, num, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { domains, firstSentence, idPattern, scopes } from "./catalog.ts";
import { checkLines, type Finding, proseKinds, segment } from "./detect.ts";
import { type Collected, diffInput, fileInput } from "./input.ts";
import { type ReadOptions, readSettings } from "./settings.ts";
import {
	type CatalogEntry,
	type Identity,
	promptSection,
	readCatalog,
	readLexicon,
	saveEntry,
	setDisabled,
} from "./store.ts";

const Id = str({ pattern: idPattern, maxLength: 128 });
const scope = union(scopes.map((name) => lit(name)));
const domain = union(domains.map((name) => lit(name)));
const kind = union(proseKinds.map((name) => lit(name)));
const nonempty = str({ minLength: 1 });
const stringList = arr(nonempty, { minItems: 1 });
const scopesList = arr(scope, { minItems: 1 });

export const ViewParams = obj({ entry: opt(Id), scope: opt(scope), query: opt(str()) });
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
export const RecordParams = obj({
	action: union([lit("save"), lit("disable"), lit("enable")]),
	id: Id,
	title: opt(nonempty),
	domain: opt(domain),
	applies: opt(scopesList),
	recognition: opt(nonempty),
	cost: opt(nonempty),
	repair: opt(nonempty),
	operator: opt(nonempty),
	prompt: opt(bool()),
	excerpt: opt(str()),
	note: opt(str()),
	detectors: opt(arr(DetectorParams)),
	reason: opt(str()),
	examples: opt(arr(obj({ kind: nonempty, verdict: union([lit("slop"), lit("better")]), text: str() }))),
});

export const VIEW_DESCRIPTION =
	"Read the slop catalog: habits in prose, code and interfaces that read as generated, each with its repair. List entries, filter by scope or query, or read one entry.";
export const CHECK_DESCRIPTION =
	"Run the slop catalog's detectors on text, one file or a Git diff: uncommitted, staged, or a range with its commit messages. Run it on the staged diff before each commit, and on documents and messages written for someone else. Do not run it on ordinary chat replies. Repair the move a finding names, not its token.";
export const RECORD_DESCRIPTION =
	"Save a local slop entry, or disable or enable an entry. When the operator flags a passage or habit as slop, save it with the flagged passage as a Slop example and your repair as a Better example.";

export function catalogSection(options: ReadOptions): string | undefined {
	const { values } = readSettings(options);
	if (values.prompt === "off") return undefined;
	try {
		return promptSection(readCatalog(values.dir));
	} catch {
		return undefined;
	} // A store error must not prevent a turn; catalog and check calls report it.
}

export const stateLabel = (entry: CatalogEntry) => (entry.disabled ? "disabled" : "active");
export const searchEntry = (entry: CatalogEntry, query: string) =>
	[entry.id, entry.title, entry.recognition].some((value) => value.toLowerCase().includes(query.toLowerCase()));
const textBlock = (text: string) => [{ type: "text" as const, text }];
export type ViewArgs = Static<typeof ViewParams>;
export type CheckArgs = Static<typeof CheckParams>;
export type RecordArgs = Static<typeof RecordParams>;

export function inspectCatalog(options: ReadOptions, args: ViewArgs) {
	const entries = readCatalog(readSettings(options).values.dir);
	if (args.entry !== undefined) {
		if (args.scope !== undefined || args.query !== undefined)
			throw new Error("Use entry alone, or use scope and query to filter the inventory.");
		const entry = entries.find((item) => item.id === args.entry);
		if (!entry) throw new Error(`No slop entry named ${args.entry}.`);
		return {
			content: textBlock(`${entry.id} · ${entry.source} · ${stateLabel(entry)}\n\n${entry.raw}`),
			details: { summary: `${entry.title} · ${stateLabel(entry)}` },
		};
	}
	const selected = entries.filter(
		(entry) =>
			(args.scope === undefined || entry.applies.includes(args.scope)) &&
			(args.query === undefined || searchEntry(entry, args.query)),
	);
	const lines = domains.flatMap((domain) => {
		const group = selected.filter((entry) => entry.domain === domain);
		return group.length
			? [
					`${domain}:`,
					...group.map(
						(entry) =>
							`- ${entry.id} · ${entry.title} · ${entry.source} · ${stateLabel(entry)} · ${entry.detectors.length} detector(s) · ${firstSentence(entry.recognition)}`,
					),
				]
			: [];
	});
	return {
		content: textBlock(lines.join("\n") || "No matching slop entries."),
		details: { summary: `${selected.length} slop entries` },
	};
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
export function formatReport(findings: Finding[], skipped: string[]): string {
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
	return `${lines.join("\n")}\n${closing}`;
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
	const details = { ok: findings.length === 0, findingCount: findings.length, skippedCount: skipped.length };
	return { content: textBlock(formatReport(findings, skipped)), details };
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

export function record(options: ReadOptions, args: RecordArgs, identity: Identity) {
	const { dir, lexicon } = readSettings(options).values;
	if (args.action === "save") {
		const { title, domain, applies, recognition, cost, repair, operator } = args;
		if (!title || !domain || !applies || !recognition || !cost || !repair || !operator || args.reason !== undefined) {
			throw new Error(
				"Save requires title, domain, applies, recognition, cost, repair and operator. Use reason only with enable or disable.",
			);
		}
		const entry = saveEntry(
			dir,
			{ ...args, title, domain, applies, recognition, cost, repair, operator },
			identity,
			readLexicon(args.detectors?.some((detector) => detector.lexicon) ? lexicon : undefined),
		);
		const summary = `Saved local entry ${entry.id} (${stateLabel(entry)}).`;
		return { content: textBlock(summary), details: { id: entry.id, summary } };
	}
	if (Object.keys(args).some((key) => !["action", "id", "reason"].includes(key)))
		throw new Error("Enable and disable accept only id and an optional reason.");
	setDisabled(dir, args.id, args.action === "disable", identity, args.reason);
	const summary = `${args.id} is ${args.action === "disable" ? "disabled" : "active"}.`;
	return { content: textBlock(summary), details: { id: args.id, summary } };
}
