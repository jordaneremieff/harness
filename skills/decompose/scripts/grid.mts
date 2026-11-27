import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const TEXT_ROWS = 40;
const JSON_HISTORY_ROWS = 200;
const GIT_TIMEOUT = 120_000;
const NODE_ID = /^[a-z0-9][a-z0-9-]*$/;
const COMMIT_ID = /^[a-f0-9]{7,40}$/i;
const HISTORY_DEFAULTS = { maxCommits: 2000, bulk: 50, top: 15 };

export const help = `Usage: node skills/decompose/scripts/grid.mts <command> [options] <grid.json> [options]

Commands:
  assess              Validate a grid and print its order, changes and candidate findings
  history             Measure how often commits change the same parts together (code mode only)

Options:
  --repo <dir>         Repository root (required by history; adds evidence and commit checks to assess)
  --format text|json   Output format (default text)
  --since <date>       history: pass this date to git unchanged
  --max-commits <n>    history: read at most the newest n commits (default 2000, maximum 20000)
  --bulk <n>           history: set aside commits that touch more than n files (default 50)
  --top <n>            history: rows for pairs and widest commits in text (default 15, cap 40)
                       JSON summary: keep up to 200 pairs and widest commits each, or n if larger
  --skip <ids>         history: set aside comma-separated commit ids or prefixes (7 to 40 hex characters each)
  --pair <a>,<b>       history: list commits that changed both of these part ids
  -h, --help           Show this help

Code evidence: <path>[:<lines>][ <note>]. Use repository-relative paths and
one-based lines or ranges separated by commas without spaces, for example
src/store/record.ts:8-21,40 field list. Use a line number to cite a path with
spaces, and a trailing slash to cite a directory.

History sets aside shallow clone boundary commits. Assess rejects them as
named commit evidence until you fetch more history.

Exit codes: 0 success, 1 invalid grid or unreadable named commit, 2 usage, file or Git error.`;

type Mode = "code" | "plan";
type Marks = Record<string, string>;
type Part = { id: string; name: string; paths: string[]; hides: string | null };
type Decision = { id: string; name: string; knownBy: Marks };
type Reliance = Record<string, string | string[]>;
type Requirement = { id: string; text: string; source: string; owners: Marks; relies: Reliance; unknown: string[] };
type Change = { id: string; text: string; source: string; edits: Marks; unknown: string[]; commits: string[] };
export type Grid = {
	subject: string;
	mode: Mode;
	parts: Part[];
	decisions: Decision[];
	requirements: Requirement[];
	changes: Change[];
	skip?: string[];
};

type Problem = { location: string; message: string };
type Failure = { ok: false; errors: Problem[] };
type ParseResult = { ok: true; grid: Grid } | Failure;
type Command = "assess" | "history";
type ParseOptions = { command?: Command; repo?: string };

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function sortId(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function normalPath(path: string): string {
	return posix.normalize(path).replace(/^\.\/?$/, "");
}

function relativePath(path: string): boolean {
	return (
		nonempty(path) &&
		!path.startsWith("/") &&
		!/^[a-z]:/i.test(path) &&
		!path.includes("\\") &&
		!path.includes("\0") &&
		!path.split("/").includes("..")
	);
}

function* possiblePrefixes(raw: string): Generator<string> {
	const path = normalPath(raw);
	if (!path) {
		if (raw.endsWith("/")) yield "";
		return;
	}
	if (!path.endsWith("/")) yield path;
	for (let slash = path.lastIndexOf("/"); slash !== -1; slash = path.lastIndexOf("/", slash - 1)) {
		yield path.slice(0, slash + 1);
		if (slash === 0) break;
	}
	yield "";
}

type PathMatch = { part: string; prefix: string };

function pathMatcher(parts: readonly Pick<Part, "id" | "paths">[]): (path: string) => PathMatch | undefined {
	const prefixes = new Map<string, PathMatch>();
	for (const { id, paths } of parts) {
		for (const path of paths) {
			const prefix = normalPath(path);
			prefixes.set(prefix, { part: id, prefix });
		}
	}
	return (path) => {
		for (const prefix of possiblePrefixes(path)) {
			const match = prefixes.get(prefix);
			if (match) return match;
		}
	};
}

/** Select the longest matching prefix. A directory citation ends in a slash. */
export function partMapper(
	parts: readonly Pick<Part, "id" | "paths">[],
): ((path: string) => string | undefined) & { spaced: boolean } {
	const matchPath = pathMatcher(parts);
	const spaced = parts.some(({ paths }) => paths.some((path) => path.includes(" ")));
	return Object.assign((path: string) => matchPath(path)?.part, { spaced });
}

type Citation = { path: string; ends: number[] };

function rangeEnd(value: string): number | undefined {
	const match = /^(\d+)(?:-(\d+))?$/.exec(value);
	if (!match) return undefined;
	const line = Number(match[1]);
	const end = Number(match[2] ?? match[1]);
	if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(end) || end < line) return undefined;
	return end;
}

type CitationText = { path: string; lines?: string; note?: string };

/** A path ends at its first space or colon. Only a grid that declares a path with a space reads a path up to its line specification. */
function splitCitation(evidence: string, spaced: boolean): CitationText | undefined {
	const location = spaced ? /:([\d,-]+)(?= |$)/u.exec(evidence) : null;
	if (location) {
		const note = evidence.slice(location.index + location[0].length);
		return { path: evidence.slice(0, location.index), lines: location[1], note: note.length > 0 ? note : undefined };
	}
	const plain = /^([^:\s]+)(?::([\d,-]+))?(?: ([\s\S]+))?$/u.exec(evidence);
	return plain ? { path: plain[1], lines: plain[2], note: plain[3] } : undefined;
}

function evidenceLocation(evidence: string, spaced = false): Citation | undefined {
	const text = splitCitation(evidence, spaced);
	if (!text || !relativePath(text.path)) return undefined;
	if (text.note !== undefined && !nonempty(text.note)) return undefined;
	const ends: number[] = [];
	for (const value of text.lines?.split(",") ?? []) {
		const end = rangeEnd(value);
		if (end === undefined) return undefined;
		ends.push(end);
	}
	return { path: text.path, ends };
}

function fileLineCount(path: string): number {
	const fd = openSync(path, "r");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let count = 0;
	let last = 10;
	try {
		for (let size = readSync(fd, buffer); size > 0; size = readSync(fd, buffer)) {
			for (let index = buffer.indexOf(10); index !== -1 && index < size; index = buffer.indexOf(10, index + 1)) count++;
			last = buffer[size - 1];
		}
	} finally {
		closeSync(fd);
	}
	return count + Number(last !== 10);
}

function evidenceEntry(repo: string, path: string): { real: string; file: boolean; lines?: number } | undefined {
	try {
		const real = realpathSync(resolve(repo, path));
		const inside = relative(repo, real);
		if (inside === ".." || inside.startsWith(`..${sep}`)) return undefined;
		const stats = statSync(real);
		if (stats.isFile() || stats.isDirectory()) return { real, file: stats.isFile() };
	} catch {
		return undefined;
	}
}

function workingTreeCheck(root: string) {
	const repo = realpathSync(root);
	if (!statSync(repo).isDirectory()) throw new Error(`--repo needs a directory: ${root}`);
	const paths = new Map<string, ReturnType<typeof evidenceEntry>>();
	const evidence = ({ path, ends }: Citation): { missing?: true; message: string } | undefined => {
		if (!paths.has(path)) paths.set(path, evidenceEntry(repo, path));
		const entry = paths.get(path);
		if (!entry)
			return {
				missing: true,
				message: `Use a path to an existing file or directory inside --repo; cannot check ${JSON.stringify(path)}.`,
			};
		if (!ends.length) return undefined;
		if (!entry.file)
			return { message: `Remove the line number from the directory ${JSON.stringify(path)}, or cite a file.` };
		try {
			entry.lines ??= fileLineCount(entry.real);
		} catch {
			return { message: `Use a readable file to check the cited lines of ${JSON.stringify(path)}.` };
		}
		const count = entry.lines;
		const end = ends.find((line) => line > count);
		if (end !== undefined)
			return { message: `Cite an existing line or range; ${JSON.stringify(path)} has ${count} lines, not ${end}.` };
	};
	const prefix = (path: string): string | undefined => {
		const stats = statSync(resolve(repo, path), { throwIfNoEntry: false });
		if (!stats) return undefined;
		if (stats.isDirectory() && !path.endsWith("/")) return 'End a directory prefix with "/".';
		if (stats.isFile() && path.endsWith("/")) return 'Remove the trailing "/" from a file path.';
	};
	return { evidence, prefix };
}

class Validator {
	readonly errors: Problem[] = [];
	readonly parts = new Set<string>();
	readonly nodes = new Set<string>();
	readonly decisions = new Map<string, Decision>();
	readonly prefixes = new Map<string, { part: string; location: string }>();
	readonly mode: Mode;
	readonly repoCheck?: ReturnType<typeof workingTreeCheck>;
	mapPart: ReturnType<typeof partMapper> = partMapper([]);
	spaceHint = "";

	constructor(mode: Mode, repo?: string) {
		this.mode = mode;
		this.repoCheck = mode === "code" && repo !== undefined ? workingTreeCheck(repo) : undefined;
	}

	fail(location: string, message: string): void {
		this.errors.push({ location, message });
	}

	text(input: unknown, at: string): string {
		if (nonempty(input)) return input;
		this.fail(at, "Supply a non-empty string.");
		return "";
	}

	rows<T>(input: unknown, at: string, minimum: number, read: (row: Record<string, unknown>, at: string) => T): T[] {
		if (input === undefined && minimum === 0) return [];
		if (!Array.isArray(input)) {
			this.fail(at, minimum ? `Supply an array with at least ${minimum} entries.` : "Supply an array.");
			return [];
		}
		if (input.length < minimum) this.fail(at, `Add entries to reach at least ${minimum}.`);
		return input.flatMap((value: unknown, index) => {
			const location = `${at}[${index}]`;
			if (object(value)) return [read(value, location)];
			this.fail(location, "Supply an object.");
			return [];
		});
	}

	id(value: unknown, at: string, seen: Set<string>, node = false): string {
		if (!nonempty(value) || (node && !NODE_ID.test(value))) {
			this.fail(
				at,
				node
					? "Use an id that starts with a lowercase letter or digit and contains only lowercase letters, digits and hyphens."
					: "Supply a non-empty id string.",
			);
			return "";
		}
		if (seen.has(value))
			this.fail(
				at,
				`Choose a unique id; ${JSON.stringify(value)} is already in use${node ? " by a part or decision" : " in this list"}.`,
			);
		seen.add(value);
		return value;
	}

	readParts(input: unknown): Part[] {
		const parts = this.rows(input, "parts", 2, (row, at) => this.part(row, at));
		this.mapPart = partMapper(parts);
		if (parts.some(({ paths }) => paths.some((path) => path.includes(" "))))
			this.spaceHint = ' A path with a space needs a line number after it, as in "src/my dir/a.ts:1".';
		return parts;
	}

	part(row: Record<string, unknown>, at: string): Part {
		const id = this.id(row.id, `${at}.id`, this.nodes, true);
		if (id) this.parts.add(id);
		const name = this.text(row.name, `${at}.name`);
		const hides = nonempty(row.hides) ? row.hides : null;
		if (hides === null && row.hides !== null)
			this.fail(`${at}.hides`, "Describe the hidden decision as a non-empty string, or use null.");
		const paths: string[] = [];
		if (Array.isArray(row.paths) && (this.mode === "plan" || row.paths.length > 0)) {
			row.paths.forEach((path: unknown, index) => {
				const place = `${at}.paths[${index}]`;
				if (typeof path !== "string" || !relativePath(path)) {
					this.fail(
						place,
						'Use a repository-relative prefix with no ".." segments or backslashes. End a directory prefix with "/".',
					);
					return;
				}
				const problem = this.repoCheck?.prefix(path);
				if (problem) this.fail(place, problem);
				const normal = normalPath(path);
				const prior = this.prefixes.get(normal);
				if (prior && prior.part !== at) {
					this.fail(place, `Assign this prefix to only one part; it already appears at ${prior.location}.`);
					return;
				}
				if (!prior) this.prefixes.set(normal, { part: at, location: place });
				paths.push(path);
			});
		} else if (row.paths !== undefined || this.mode === "code") {
			this.fail(
				`${at}.paths`,
				this.mode === "code"
					? "Supply a non-empty array of repository-relative path prefixes."
					: "Omit paths or supply an array of repository-relative path prefixes.",
			);
		}
		return { id, name, paths, hides };
	}

	evidence(value: unknown, at: string, placement: string[], target?: string): string {
		const evidence = this.text(value, at);
		if (!evidence || this.mode === "plan") return evidence;
		const cited = evidenceLocation(evidence, this.mapPart.spaced);
		if (!cited) {
			this.fail(
				at,
				`Invalid citation ${JSON.stringify(evidence)}. Use <path>[:<lines>][ <note>], for example src/store/record.ts:8-21,40 field list. Use one-based lines and end each range at or after its first line.`,
			);
			return evidence;
		}
		const part = this.mapPart(cited.path);
		if (part !== undefined && part === target) {
			this.fail(at, "A part cannot rely on itself. Cite the place of use in the other owner part.");
		} else if (placement.length > 0 && (part === undefined || !placement.includes(part))) {
			this.fail(
				at,
				`Cite a path inside ${placement.length === 1 ? `part ${placement[0]}` : `one of the owner parts: ${placement.join(", ")}`}; this path ${part ? `belongs to ${part}` : "belongs to no part"}.${this.spaceHint}`,
			);
		}
		const problem = this.repoCheck?.evidence(cited);
		if (problem) this.fail(at, problem.message + (problem.missing ? this.spaceHint : ""));
		return evidence;
	}

	marks(value: unknown, at: string, minimum: number): Marks {
		if (!object(value)) {
			this.fail(at, "Supply an object with part ids as keys and evidence as values.");
			return {};
		}
		const entries = Object.entries(value);
		if (entries.length < minimum) {
			this.fail(
				at,
				minimum === 2
					? "List at least two parts; put a decision known by one part in that part's hides field."
					: "List at least one owner part with evidence.",
			);
		}
		return Object.fromEntries(
			entries.map(([id, evidence]) => {
				const place = `${at}.${id}`;
				const declared = this.parts.has(id);
				if (!declared) this.fail(place, "Use a declared part id.");
				return [id, this.evidence(evidence, place, declared ? [id] : [])];
			}),
		);
	}

	unknown(value: unknown, at: string, partsOnly: boolean, marked: (Marks | Reliance)[]): string[] {
		if (value === undefined) return [];
		const allowed = partsOnly ? this.parts : this.nodes;
		if (!Array.isArray(value)) {
			this.fail(
				at,
				`Supply an array of ${partsOnly ? "part ids" : "part or decision ids"}; use [] if no cell is unknown.`,
			);
			return [];
		}
		const seen = new Set<string>();
		value.forEach((id: unknown, index) => {
			const place = `${at}[${index}]`;
			if (typeof id !== "string" || !allowed.has(id)) {
				this.fail(place, `Use a declared ${partsOnly ? "part id" : "part or decision id"}.`);
				return;
			}
			if (seen.has(id)) this.fail(place, `List ${id} only once.`);
			if (marked.some((marks) => Object.hasOwn(marks, id)))
				this.fail(place, `Remove ${id} from unknown or remove its other mark.`);
			seen.add(id);
		});
		return [...seen];
	}

	decision(row: Record<string, unknown>, at: string): Decision {
		const id = this.id(row.id, `${at}.id`, this.nodes, true);
		const decision = {
			id,
			name: this.text(row.name, `${at}.name`),
			knownBy: this.marks(row.knownBy, `${at}.knownBy`, 2),
		};
		if (id) this.decisions.set(id, decision);
		return decision;
	}

	requirement(row: Record<string, unknown>, at: string, seen: Set<string>): Requirement {
		const id = this.id(row.id, `${at}.id`, seen);
		const text = this.text(row.text, `${at}.text`);
		const source = this.text(row.source, `${at}.source`);
		const owners = this.marks(row.owners, `${at}.owners`, 1);
		const relies = this.reliance(row.relies, `${at}.relies`, Object.keys(owners));
		const unknown = this.unknown(row.unknown, `${at}.unknown`, false, [owners, relies]);
		return { id, text, source, owners, relies, unknown };
	}

	reliance(value: unknown, at: string, owners: string[]): Reliance {
		if (value === undefined) return {};
		if (!object(value)) {
			this.fail(at, "Supply an object with part or decision ids as keys and evidence as values.");
			return {};
		}
		return Object.fromEntries(
			Object.entries(value).map(([target, cites]) => {
				const place = `${at}.${target}`;
				if (!this.nodes.has(target)) this.fail(place, "Use a declared part or decision id.");
				if (!Array.isArray(cites)) return [target, this.placeOfUse(cites, place, owners, target)];
				if (!cites.length) this.fail(place, "Supply one evidence string or a non-empty array of evidence strings.");
				return [
					target,
					cites.map((cite: unknown, index) => this.placeOfUse(cite, `${place}[${index}]`, owners, target)),
				];
			}),
		);
	}

	placeOfUse(value: unknown, at: string, owners: string[], target: string): string {
		const evidence = this.evidence(value, at, owners, target);
		if (!evidence) return evidence;
		const owner = relyingOwner(this.mode, owners, evidence, this.mapPart);
		if (this.mode === "plan") {
			const form = 'Use "<owner-id>: <evidence>" and name an owner of this row other than the relied part.';
			if (owner === target)
				this.fail(
					at,
					owners.length === 1
						? "A part cannot rely on itself. Mark a different part or decision."
						: `A part cannot rely on itself. ${form}`,
				);
			else if (!owner && owners.length > 1) this.fail(at, form);
		}
		const decision = this.decisions.get(target);
		if (decision && owner && !Object.hasOwn(decision.knownBy, owner)) {
			this.fail(at, `List ${owner} in decision ${target}'s knownBy with evidence, or correct this reliance.`);
		}
		return evidence;
	}

	skip(value: unknown): string[] {
		if (!Array.isArray(value)) {
			this.fail("skip", "Supply an array of commit ids, or omit skip.");
			return [];
		}
		const seen = new Set<string>();
		return value.flatMap((id: unknown, index) => {
			const at = `skip[${index}]`;
			if (typeof id !== "string" || !COMMIT_ID.test(id)) {
				this.fail(at, "Use 7 to 40 hexadecimal characters from a commit id.");
				return [];
			}
			const key = id.toLowerCase();
			if (seen.has(key)) this.fail(at, `List ${id} only once in skip.`);
			seen.add(key);
			return [id];
		});
	}

	change(row: Record<string, unknown>, at: string, seen: Set<string>): Change {
		const id = this.id(row.id, `${at}.id`, seen);
		const text = this.text(row.text, `${at}.text`);
		const source = this.text(row.source, `${at}.source`);
		const edits = this.marks(row.edits, `${at}.edits`, 0);
		const unknown = this.unknown(row.unknown, `${at}.unknown`, true, [edits]);
		const noUnknown = row.unknown === undefined || (Array.isArray(row.unknown) && row.unknown.length === 0);
		if (object(row.edits) && Object.keys(row.edits).length === 0 && noUnknown) {
			this.fail(at, "Add at least one part to edits or unknown.");
		}
		const commits: string[] = [];
		if (Array.isArray(row.commits)) {
			row.commits.forEach((commit: unknown, index) => {
				if (typeof commit === "string" && COMMIT_ID.test(commit)) commits.push(commit);
				else this.fail(`${at}.commits[${index}]`, "Use 7 to 40 hexadecimal characters from a commit id.");
			});
		} else if (row.commits !== undefined) {
			this.fail(`${at}.commits`, "Omit commits or supply an array of commit ids.");
		}
		return { id, text, source, edits, unknown, commits };
	}
}

/** Validate evidence form and placement before any assessment uses the grid. */
export function parseGrid(text: string, options: ParseOptions = {}): ParseResult {
	let value: unknown;
	try {
		value = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		return { ok: false, errors: [{ location: "$", message: `Supply valid JSON. ${errorMessage(error)}` }] };
	}
	if (!object(value)) return { ok: false, errors: [{ location: "$", message: "Supply one JSON object." }] };
	const history = options.command === "history";
	const mode: Mode = value.mode === "plan" ? "plan" : "code";
	const validator = new Validator(mode, options.repo);
	const subject = validator.text(value.subject, "subject");
	if (value.mode !== undefined && value.mode !== "code" && value.mode !== "plan") {
		validator.fail("mode", 'Use "code" or "plan", or omit mode to use "code".');
	} else if (history && mode === "plan") {
		validator.fail("mode", "Use a code grid for history; plan grids have no paths to map.");
	}
	const parts = validator.readParts(value.parts);
	const grid: Grid = { subject, mode, parts, decisions: [], requirements: [], changes: [] };
	if (value.skip !== undefined) grid.skip = validator.skip(value.skip);
	if (!history) {
		for (const key of Object.keys(value)) {
			if (!["subject", "mode", "parts", "decisions", "requirements", "changes", "skip"].includes(key))
				validator.fail(key, "Remove this unknown top-level field.");
		}
		grid.decisions = validator.rows(value.decisions, "decisions", 0, (row, at) => validator.decision(row, at));
		const reqIds = new Set<string>();
		grid.requirements = validator.rows(value.requirements, "requirements", 1, (row, at) =>
			validator.requirement(row, at, reqIds),
		);
		const changeIds = new Set<string>();
		grid.changes = validator.rows(value.changes, "changes", 0, (row, at) => validator.change(row, at, changeIds));
	}
	return validator.errors.length > 0 ? { ok: false, errors: validator.errors } : { ok: true, grid };
}

function relyingOwner(mode: Mode, owners: string[], evidence: string, mapPart: MapPart): string | undefined {
	if (mode === "plan") {
		if (owners.length === 1) return owners[0];
		const delimiter = evidence.indexOf(": ");
		if (delimiter === -1 || !nonempty(evidence.slice(delimiter + 2))) return undefined;
		const prefix = evidence.slice(0, delimiter);
		return owners.includes(prefix) ? prefix : undefined;
	}
	const cited = evidenceLocation(evidence, mapPart.spaced);
	const part = cited ? mapPart(cited.path) : undefined;
	return part !== undefined && owners.includes(part) ? part : undefined;
}

type Label = ({ kind: "requirement"; requirement: string } | { kind: "knows" }) & { evidence: string };
type Edge = { from: string; to: string; labels: Label[] };
type Graph = Map<string, Map<string, Edge>>;
type Tangle = { parts: string[]; edges: Edge[] };

type NodeResult = {
	id: string;
	name: string;
	kind: "part" | "decision";
	layer: number;
	usedBy: string[];
	leanedOnBy: string[];
	reliesOn: string[];
	owns?: string[];
	hides?: string | null;
	landings?: number;
	editedBy?: string[];
};

type CommitCheck = { observed: string[]; reasonedOnly: string[]; unmarked: string[]; unmappedFiles: number };
type Row = Pick<Change, "id" | "text" | "edits" | "unknown"> & {
	kind: "declared" | "decision";
	source?: string;
	commits?: string[];
	width: number;
	totalParts: number;
	cells: Record<string, string>;
	observed: string[];
	reasonedOnly: string[];
	unmarked: string[];
	unmappedFiles: number;
	commitChecked: boolean;
};

type Homes = {
	scattered: { requirement: string; owners: string[] }[];
	sharedHomes: { part: string; requirements: string[] }[];
	noSecret: string[];
	idle: string[];
};

type Candidate = {
	kind: "tangle" | "shared-decision" | "wide-change" | "no-secret" | "unplaced-decision" | "unmarked" | "idle";
	ids: string[];
	count: number;
};

type Assessment = {
	ok: true;
	subject: string;
	mode: Mode;
	evidenceChecked: boolean;
	order: "independent" | "layered" | "tangled";
	layers: { layer: number; nodes: string[] }[];
	tangles: Tangle[];
	nodes: NodeResult[];
	requirements: (Requirement & { cells: Record<string, string> })[];
	homes: Homes;
	changes: Row[];
	candidates: Candidate[];
};

function graphFor(grid: Grid, mapPart: ReturnType<typeof partMapper>): Graph {
	const graph: Graph = new Map([...grid.parts, ...grid.decisions].map(({ id }) => [id, new Map()]));
	const add = (from: string | undefined, to: string, label: Label) => {
		if (from === undefined) return;
		const outgoing = graph.get(from);
		if (!outgoing) return;
		const edge = outgoing.get(to);
		if (edge) edge.labels.push(label);
		else outgoing.set(to, { from, to, labels: [label] });
	};
	for (const req of grid.requirements) {
		const owners = Object.keys(req.owners);
		for (const [to, cites] of Object.entries(req.relies)) {
			for (const evidence of typeof cites === "string" ? [cites] : cites) {
				const from = relyingOwner(grid.mode, owners, evidence, mapPart);
				add(from, to, { kind: "requirement", requirement: req.id, evidence });
			}
		}
	}
	for (const { id, knownBy } of grid.decisions) {
		for (const [from, evidence] of Object.entries(knownBy)) add(from, id, { kind: "knows", evidence });
	}
	return graph;
}

function reverseGraph(graph: Graph): Map<string, string[]> {
	const incoming = new Map<string, string[]>([...graph.keys()].map((id) => [id, []]));
	for (const [from, edges] of graph) {
		for (const to of edges.keys()) incoming.get(to)?.push(from);
	}
	return incoming;
}

function finishOrder(graph: Graph): string[] {
	const seen = new Set<string>();
	const finished: string[] = [];
	for (const id of graph.keys()) {
		if (seen.has(id)) continue;
		seen.add(id);
		const stack = [{ id, targets: graph.get(id)?.keys() }];
		while (stack.length) {
			const node = stack[stack.length - 1];
			const next = node.targets?.next();
			if (next === undefined || next.done) {
				finished.push(node.id);
				stack.pop();
			} else if (!seen.has(next.value)) {
				seen.add(next.value);
				stack.push({ id: next.value, targets: graph.get(next.value)?.keys() });
			}
		}
	}
	return finished;
}

/** Use finish order and the reversed graph to find strongly connected components. */
function componentsOf(graph: Graph, incoming: Map<string, string[]>): string[][] {
	const seen = new Set<string>();
	const components: string[][] = [];
	for (const id of finishOrder(graph).reverse()) {
		if (seen.has(id)) continue;
		const component = [id];
		seen.add(id);
		for (const next of component) {
			for (const from of incoming.get(next) ?? []) {
				if (seen.has(from)) continue;
				component.push(from);
				seen.add(from);
			}
		}
		components.push(component.sort(sortId));
	}
	return components;
}

function componentLayers(graph: Graph, components: string[][]): Map<string, number> {
	const index = new Map(components.flatMap((group, i) => group.map((id) => [id, i] as const)));
	const usedBy = components.map(() => new Set<number>());
	const reliesOn = components.map(() => new Set<number>());
	for (const [id, edges] of graph) {
		const from = index.get(id) as number;
		for (const target of edges.keys()) {
			const to = index.get(target) as number;
			if (from === to) continue;
			usedBy[to].add(from);
			reliesOn[from].add(to);
		}
	}
	const layers = components.map(() => 0);
	const ready = reliesOn.flatMap((targets, i) => (targets.size === 0 ? [i] : []));
	for (const to of ready) {
		for (const from of usedBy[to]) {
			layers[from] = Math.max(layers[from], layers[to] + 1);
			reliesOn[from].delete(to);
			if (reliesOn[from].size === 0) ready.push(from);
		}
	}
	return new Map([...index].map(([id, i]) => [id, layers[i]]));
}

function reachers(id: string, incoming: Map<string, string[]>): string[] {
	const seen = new Set(incoming.get(id));
	for (const next of seen) {
		for (const from of incoming.get(next) ?? []) seen.add(from);
	}
	seen.delete(id);
	return [...seen].sort(sortId);
}

function gridOrder(grid: Grid, graph: Graph) {
	const incoming = reverseGraph(graph);
	const components = componentsOf(graph, incoming);
	const nodeLayer = componentLayers(graph, components);
	const tangles = components
		.filter((members) => members.length > 1)
		.map(
			(parts): Tangle => ({
				parts,
				edges: parts.flatMap((id) =>
					[...(graph.get(id)?.values() ?? [])]
						.filter(({ to }) => parts.includes(to))
						.sort((a, b) => sortId(a.to, b.to)),
				),
			}),
		)
		.sort((a, b) => sortId(a.parts[0], b.parts[0]));
	const order =
		tangles.length > 0 ? "tangled" : [...graph.values()].some((edges) => edges.size > 0) ? "layered" : "independent";
	const describe = ({ id, name }: Part | Decision, kind: NodeResult["kind"]): NodeResult => ({
		id,
		name,
		kind,
		layer: nodeLayer.get(id) ?? 0,
		usedBy: [...(incoming.get(id) ?? [])].sort(sortId),
		leanedOnBy: reachers(id, incoming),
		reliesOn: [...(graph.get(id)?.keys() ?? [])].sort(sortId),
	});
	const owned = new Map(grid.parts.map(({ id }) => [id, [] as string[]]));
	for (const req of grid.requirements) for (const owner of Object.keys(req.owners)) owned.get(owner)?.push(req.id);
	const edited = new Map(grid.parts.map(({ id }) => [id, [] as string[]]));
	for (const change of grid.changes) for (const id of Object.keys(change.edits)) edited.get(id)?.push(change.id);
	const nodes = [
		...grid.parts.map((part): NodeResult => {
			const editedBy = edited.get(part.id) ?? [];
			return {
				...describe(part, "part"),
				owns: owned.get(part.id) ?? [],
				hides: part.hides,
				landings: editedBy.length,
				editedBy,
			};
		}),
		...grid.decisions.map((decision) => describe(decision, "decision")),
	].sort((a, b) => a.layer - b.layer || b.leanedOnBy.length - a.leanedOnBy.length);
	const layers: Assessment["layers"] = [];
	for (const node of nodes) {
		const layer = layers[node.layer] ?? { layer: node.layer, nodes: [] };
		layer.nodes.push(node.id);
		layers[node.layer] = layer;
	}
	return { order, layers, tangles, nodes } as const;
}

function requirementRows(grid: Grid, nodes: NodeResult[]): Assessment["requirements"] {
	const positions = new Map(nodes.map(({ id }, index) => [id, index]));
	const rows = grid.requirements.map((req) => {
		let first = nodes.length;
		for (const owner of Object.keys(req.owners)) first = Math.min(first, positions.get(owner) ?? nodes.length);
		const unknown = new Set(req.unknown);
		const cells = Object.fromEntries(
			nodes.map(({ id }) => [
				id,
				`${Object.hasOwn(req.owners, id) ? "O" : ""}${Object.hasOwn(req.relies, id) ? "x" : ""}` ||
					(unknown.has(id) ? "?" : ""),
			]),
		);
		return { first, row: { ...req, cells } };
	});
	return rows.sort((a, b) => a.first - b.first).map(({ row }) => row);
}

function homesFor(grid: Grid, nodes: NodeResult[]): Homes {
	const parts = nodes.filter(({ kind }) => kind === "part");
	const byId = new Map(parts.map((part) => [part.id, part]));
	return {
		scattered: grid.requirements.flatMap(({ id, owners }) =>
			Object.keys(owners).length < 2 ? [] : [{ requirement: id, owners: Object.keys(owners).sort(sortId) }],
		),
		sharedHomes: grid.parts
			.flatMap(({ id }) => {
				const owns = byId.get(id)?.owns;
				return owns && owns.length >= 2 ? [{ part: id, requirements: owns }] : [];
			})
			.sort((a, b) => b.requirements.length - a.requirements.length),
		noSecret: parts
			.filter(({ hides }) => hides === null)
			.map(({ id }) => id)
			.sort(sortId),
		idle: parts
			.filter(
				({ owns, landings, usedBy, reliesOn }) => !owns?.length && !landings && !usedBy.length && !reliesOn.length,
			)
			.map(({ id }) => id)
			.sort(sortId),
	};
}

export type CommitReader = (id: string) => readonly string[] | Promise<readonly string[]>;
type AssessOptions = { evidenceChecked?: boolean; readCommit?: CommitReader };

type MapPart = ReturnType<typeof partMapper>;

function compareCommitFiles(files: Set<string>, row: Change, mapPart: MapPart): CommitCheck {
	const parts = new Set<string>();
	let unmappedFiles = 0;
	for (const file of files) {
		const part = mapPart(file);
		if (part === undefined) unmappedFiles++;
		else parts.add(part);
	}
	const observed = [...parts].sort(sortId);
	return {
		observed,
		unmappedFiles,
		reasonedOnly: Object.keys(row.edits)
			.filter((id) => !parts.has(id))
			.sort(sortId),
		unmarked: observed.filter((id) => !Object.hasOwn(row.edits, id) && !row.unknown.includes(id)),
	};
}

async function checkCommits(grid: Grid, mapPart: MapPart, read: CommitReader) {
	const errors: Problem[] = [];
	const checked = new Map<string, CommitCheck>();
	const cache = new Map<string, Promise<readonly string[]>>();
	for (const [index, row] of grid.changes.entries()) {
		if (row.commits.length === 0) continue;
		const files = new Set<string>();
		for (const [n, commit] of row.commits.entries()) {
			try {
				const key = commit.toLowerCase();
				const pending = cache.get(key) ?? Promise.resolve().then(() => read(commit));
				cache.set(key, pending);
				for (const path of await pending) files.add(path);
			} catch (error) {
				errors.push({
					location: `changes[${index}].commits[${n}]`,
					message: `Use a readable commit id; cannot read ${commit}: ${errorMessage(error)}`,
				});
			}
		}
		checked.set(row.id, compareCommitFiles(files, row, mapPart));
	}
	return { errors, checked };
}

function changeRows(grid: Grid, nodes: NodeResult[], checked: Map<string, CommitCheck>): Row[] {
	const partIds = nodes.filter(({ kind }) => kind === "part").map(({ id }) => id);
	const make = (kind: Row["kind"], change: Pick<Change, "id" | "text" | "edits" | "unknown">): Row => {
		const check = kind === "declared" ? checked.get(change.id) : undefined;
		const cells = Object.fromEntries(partIds.map((id) => [id, ""]));
		for (const id of change.unknown) cells[id] = "?";
		for (const id of Object.keys(change.edits)) cells[id] = check?.observed.includes(id) ? "H" : "E";
		for (const id of check?.unmarked ?? []) cells[id] = "!";
		return {
			...change,
			kind,
			width: Object.keys(change.edits).length,
			totalParts: partIds.length,
			cells,
			commitChecked: check !== undefined,
			...(check ?? { observed: [], reasonedOnly: [], unmarked: [], unmappedFiles: 0 }),
		};
	};
	return [
		...grid.changes.map((change) => make("declared", change)),
		...grid.decisions.map(({ id, name, knownBy }) => make("decision", { id, text: name, edits: knownBy, unknown: [] })),
	].sort(
		(a, b) =>
			b.width - a.width ||
			Number(b.kind === "declared") - Number(a.kind === "declared") ||
			sortId(a.id, b.id) ||
			sortId(a.kind, b.kind),
	);
}

function candidatesFor(grid: Grid, tangles: Tangle[], homes: Homes, changes: Row[]): Candidate[] {
	const lead = (kind: Candidate["kind"], ids: string[], count: number): Candidate => ({ kind, ids, count });
	const declared = changes.filter(({ kind }) => kind === "declared");
	const reliedOn = new Set(grid.requirements.flatMap(({ relies }) => Object.keys(relies)));
	return [
		...tangles.map(({ parts }) => lead("tangle", parts, parts.length)),
		...grid.decisions
			.map(({ id, knownBy }) =>
				lead("shared-decision", [id, ...Object.keys(knownBy).sort(sortId)], Object.keys(knownBy).length),
			)
			.sort((a, b) => b.count - a.count || sortId(a.ids[0], b.ids[0])),
		...declared
			.filter(({ width }) => width >= 3)
			.map(({ id, width, edits }) => lead("wide-change", [id, ...Object.keys(edits).sort(sortId)], width)),
		...homes.noSecret.map((id) => lead("no-secret", [id], 1)),
		...grid.decisions
			.map(({ id }) => id)
			.filter((id) => !reliedOn.has(id))
			.sort(sortId)
			.map((id) => lead("unplaced-decision", [id], 0)),
		...declared
			.filter(({ unmarked }) => unmarked.length > 0)
			.map(({ id, unmarked }) => lead("unmarked", [id, ...unmarked], unmarked.length)),
		...homes.idle.map((id) => lead("idle", [id], 1)),
	];
}

/** Assess a validated grid; a supplied commit reader enables code-mode commit checks. */
export async function assess(grid: Grid, options: AssessOptions = {}): Promise<Assessment | Failure> {
	const mapPart = partMapper(grid.parts);
	const { readCommit } = options;
	const read = grid.mode === "code" && readCommit ? await checkCommits(grid, mapPart, readCommit) : undefined;
	if (read?.errors.length) return { ok: false, errors: read.errors };
	const structure = gridOrder(grid, graphFor(grid, mapPart));
	const { nodes, tangles } = structure;
	const requirements = requirementRows(grid, nodes);
	const homes = homesFor(grid, nodes);
	const changes = changeRows(grid, nodes, read?.checked ?? new Map());
	return {
		ok: true,
		subject: grid.subject,
		mode: grid.mode,
		evidenceChecked: grid.mode === "code" && options.evidenceChecked === true,
		...structure,
		requirements,
		homes,
		changes,
		candidates: candidatesFor(grid, tangles, homes, changes),
	};
}

export type HistoryOptions = {
	since?: string;
	maxCommits: number;
	bulk: number;
	top: number;
	skip?: readonly string[];
};
export type HistoryCommit = { id: string; date: string; subject: string; files: readonly string[] };
type CommitDetails = Omit<HistoryCommit, "files">;
type Widest = CommitDetails & { width: number; parts: string[] };
type PairGrid = { relies: [string, string][]; decisions: string[] };
type PartPair = [string, string];
type HistoryScanOptions = Partial<HistoryOptions> & { shallow?: ReadonlySet<string>; pairsNote?: string };
type HistoryPair = {
	ok: true;
	subject: string;
	window: HistorySummary["window"] & {
		skipped: number;
		bulkCommits: number;
		mapping: MappingCounts;
	};
	pair: { parts: PartPair; total: number; commits: (CommitDetails & { otherParts: string[] })[] };
};
type MappingCounts = { mappedFiles: number; unmappedFiles: number; commitsWithNoPart: number };
type HistorySummary = {
	ok: true;
	subject: string;
	window: Omit<HistoryOptions, "skip"> & {
		commits: number;
		oldest: string | null;
		newest: string | null;
		shallow: boolean;
		boundaryCommits: number;
	};
	skipped: { commits: CommitDetails[]; unmatched: string[] };
	bulk: { commits: number; largest: { id: string; date: string; files: number; parts: number; subject: string }[] };
	mapping: MappingCounts & {
		unmappedDirectories: { directory: string; files: number }[];
		topUnmappedFiles: { path: string; commits: number }[];
		unmatchedPaths: { part: string; path: string }[];
	};
	parts: { id: string; name: string; commits: number; alone: number; together: number; leanedOnBy: number | null }[];
	spread: { one: number; two: number; three: number; fourOrMore: number };
	pairs: { parts: [string, string]; count: number; shares: [number, number]; grid: PairGrid | null }[];
	pairsCompared: boolean;
	pairsNote?: string;
	widest: Widest[];
};

function increment<K>(counts: Map<K, number>, key: K): void {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

function comparePairs(grid: Grid, graph: Graph): (a: string, b: string) => PairGrid {
	const decisions = [...grid.decisions].sort((a, b) => sortId(a.id, b.id));
	return (a, b) => {
		const relies: PairGrid["relies"] = [];
		if (graph.get(a)?.has(b)) relies.push([a, b]);
		if (graph.get(b)?.has(a)) relies.push([b, a]);
		const shared = decisions.filter(({ knownBy }) => Object.hasOwn(knownBy, a) && Object.hasOwn(knownBy, b));
		return { relies, decisions: shared.map(({ id }) => id) };
	};
}

function skipTracker(prefixes: readonly string[]) {
	const supplied = new Set(prefixes.map((prefix) => prefix.toLowerCase()));
	const lengths = [...new Set(prefixes.map((prefix) => prefix.length))];
	const matched = new Set<string>();
	const commits: CommitDetails[] = [];
	return {
		record(commit: CommitDetails): boolean {
			const id = commit.id.toLowerCase();
			const matches = lengths.map((length) => id.slice(0, length)).filter((prefix) => supplied.has(prefix));
			if (!matches.length) return false;
			for (const prefix of matches) matched.add(prefix);
			commits.push(commit);
			return true;
		},
		result: () => ({ commits, unmatched: prefixes.filter((prefix) => !matched.has(prefix.toLowerCase())) }),
	};
}

type CommitStream = Iterable<HistoryCommit> | AsyncIterable<HistoryCommit>;

function scanHistory(
	matchPath: ReturnType<typeof pathMatcher>,
	commits: CommitStream,
	options: HistoryScanOptions,
	gridSkip: readonly string[] = [],
	observeFile?: (path: string, match: PathMatch | undefined) => void,
) {
	const { skip = [], shallow, ...limits } = { ...HISTORY_DEFAULTS, ...options };
	const skipped = skipTracker([...gridSkip, ...skip]);
	const window: HistorySummary["window"] = {
		...limits,
		since: limits.since,
		commits: 0,
		oldest: null,
		newest: null,
		shallow: shallow !== undefined,
		boundaryCommits: 0,
	};
	const bulk: HistorySummary["bulk"] = { commits: 0, largest: [] };
	const mapping: MappingCounts = { mappedFiles: 0, unmappedFiles: 0, commitsWithNoPart: 0 };
	const updateWindow = (date: string) => {
		window.commits++;
		if (window.oldest === null || Date.parse(date) < Date.parse(window.oldest)) window.oldest = date;
		if (window.newest === null || Date.parse(date) > Date.parse(window.newest)) window.newest = date;
	};
	const recordBulk = (id: string, date: string, subject: string, files: Set<string>) => {
		bulk.commits++;
		const parts = new Set<string>();
		for (const file of files) {
			const match = matchPath(file);
			if (match) parts.add(match.part);
		}
		bulk.largest.push({ id, date, files: files.size, parts: parts.size, subject });
		bulk.largest.sort((a, b) => b.files - a.files);
		if (bulk.largest.length > 10) bulk.largest.pop();
	};
	const mapFiles = (files: Set<string>): string[] => {
		const touched = new Set<string>();
		for (const file of files) {
			const match = matchPath(file);
			observeFile?.(file, match);
			if (!match) mapping.unmappedFiles++;
			else {
				mapping.mappedFiles++;
				touched.add(match.part);
			}
		}
		return [...touched].sort(sortId);
	};
	async function* read() {
		for await (const { id, date, subject, files: names } of commits) {
			if (shallow?.has(id)) {
				window.boundaryCommits++;
				continue;
			}
			updateWindow(date);
			if (skipped.record({ id, date, subject })) continue;
			const files = new Set(names);
			if (files.size > limits.bulk) {
				recordBulk(id.slice(0, 7), date, [...subject].slice(0, 100).join(""), files);
				continue;
			}
			const ids = mapFiles(files);
			if (ids.length === 0) mapping.commitsWithNoPart += Number(files.size > 0);
			else yield { id: id.slice(0, 7), date, subject: [...subject].slice(0, 100).join(""), ids };
		}
	}
	return { window, mapping, bulk, skipped, read };
}

function pathCoverage(parts: readonly Part[]) {
	const declarations = parts.flatMap(({ id, paths }) => paths.map((path) => ({ part: id, path })));
	const unmatched = new Set(declarations.map(({ path }) => normalPath(path)));
	const directories = new Map<string, number>();
	const files = new Map<string, number>();
	function mostFrequent(counts: Map<string, number>): [string, number][] {
		return [...counts].sort(([a, x], [b, y]) => y - x || sortId(a, b)).slice(0, 10);
	}
	return {
		observe(path: string, match: PathMatch | undefined) {
			if (match) {
				unmatched.delete(match.prefix);
				return;
			}
			const slash = path.indexOf("/");
			increment(directories, slash === -1 ? "." : path.slice(0, slash));
			increment(files, path);
		},
		result: () => ({
			unmappedDirectories: mostFrequent(directories).map(([directory, files]) => ({ directory, files })),
			topUnmappedFiles: mostFrequent(files).map(([path, commits]) => ({ path, commits })),
			unmatchedPaths: declarations.filter(({ path }) => unmatched.has(normalPath(path))),
		}),
	};
}

/** Summarise without retaining the changed files by commit. Shares are fractions. */
export async function summariseHistory(
	grid: Grid | Pick<Grid, "parts" | "subject" | "skip">,
	commits: CommitStream,
	options: HistoryScanOptions = {},
): Promise<HistorySummary> {
	const matchPath = pathMatcher(grid.parts);
	const full = "requirements" in grid && grid.requirements.length > 0 ? grid : undefined;
	const graph = full && graphFor(full, partMapper(grid.parts));
	const compare = full && graph ? comparePairs(full, graph) : undefined;
	const incoming = graph && reverseGraph(graph);
	const parts = grid.parts.map(({ id, name }) => ({
		id,
		name,
		commits: 0,
		alone: 0,
		together: 0,
		leanedOnBy: incoming ? reachers(id, incoming).length : null,
	}));
	const stats = new Map(parts.map((part) => [part.id, part]));
	const coverage = pathCoverage(grid.parts);
	const { window, mapping, bulk, skipped, read } = scanHistory(
		matchPath,
		commits,
		options,
		grid.skip,
		coverage.observe,
	);
	const spread = { one: 0, two: 0, three: 0, fourOrMore: 0 };
	const pairCounts = new Map<string, Map<string, number>>();
	const widest: Widest[] = [];
	const recordSpread = (ids: string[]) => {
		const width = ids.length;
		const bucket = ["one", "two", "three"] as const;
		spread[bucket[width - 1] ?? "fourOrMore"]++;
		const outcome = width === 1 ? "alone" : "together";
		for (const id of ids) {
			const part = stats.get(id);
			if (!part) continue;
			part.commits++;
			part[outcome]++;
		}
		for (const [i, id] of ids.slice(0, -1).entries()) {
			const counts = pairCounts.get(id) ?? new Map<string, number>();
			pairCounts.set(id, counts);
			for (let j = i + 1; j < ids.length; j++) increment(counts, ids[j]);
		}
	};
	for await (const { id, date, subject, ids } of read()) {
		recordSpread(ids);
		if (ids.length >= 2) widest.push({ id, date, width: ids.length, parts: ids, subject });
	}
	const pairs: HistorySummary["pairs"] = [];
	for (const [a, peers] of pairCounts) {
		for (const [b, count] of peers) {
			pairs.push({
				parts: [a, b],
				count,
				shares: [count / (stats.get(a)?.commits ?? 1), count / (stats.get(b)?.commits ?? 1)],
				grid: compare?.(a, b) ?? null,
			});
		}
	}
	parts.sort((a, b) => b.commits - a.commits || sortId(a.id, b.id));
	pairs.sort((a, b) => b.count - a.count || sortId(a.parts[0], b.parts[0]) || sortId(a.parts[1], b.parts[1]));
	widest.sort((a, b) => b.width - a.width);
	return {
		ok: true,
		subject: grid.subject,
		window,
		skipped: skipped.result(),
		bulk,
		mapping: { ...mapping, ...coverage.result() },
		parts,
		spread,
		pairs,
		pairsCompared: compare !== undefined,
		pairsNote: options.pairsNote,
		widest,
	};
}

async function summarisePair(
	grid: Grid,
	commits: CommitStream,
	parts: PartPair,
	options: HistoryScanOptions,
): Promise<HistoryPair> {
	const [a, b] = parts;
	for (const id of parts) {
		if (!grid.parts.some((part) => part.id === id))
			throw new Error(`Use declared part ids for --pair; ${id} is not a part.`);
	}
	const { window, mapping, bulk, skipped, read } = scanHistory(pathMatcher(grid.parts), commits, options, grid.skip);
	const matches: HistoryPair["pair"]["commits"] = [];
	for await (const { id, date, subject, ids } of read()) {
		if (ids.includes(a) && ids.includes(b))
			matches.push({ id, date, subject, otherParts: ids.filter((part) => part !== a && part !== b) });
	}
	matches.sort((x, y) => Date.parse(y.date) - Date.parse(x.date));
	const { mappedFiles, unmappedFiles, commitsWithNoPart } = mapping;
	return {
		ok: true,
		subject: grid.subject,
		window: {
			...window,
			skipped: skipped.result().commits.length,
			bulkCommits: bulk.commits,
			mapping: { mappedFiles, unmappedFiles, commitsWithNoPart },
		},
		pair: { parts, total: matches.length, commits: matches },
	};
}

async function* nulFields(stream: AsyncIterable<string>): AsyncGenerator<string> {
	let tail = "";
	for await (const chunk of stream) {
		const fields = chunk.split("\0");
		tail += fields[0];
		if (fields.length === 1) continue;
		yield tail;
		const end = fields.length - 1;
		for (let index = 1; index < end; index++) yield fields[index];
		tail = fields[end];
	}
	if (tail) throw new Error("Git returned an incomplete log field.");
}

async function nextLogField(fields: AsyncGenerator<string>): Promise<string> {
	const field = await fields.next();
	if (field.done) throw new Error("Git returned an incomplete log header.");
	return field.value;
}

async function* parseLog(stream: AsyncIterable<string>): AsyncGenerator<HistoryCommit> {
	const fields = nulFields(stream);
	let record: { id: string; date: string; subject: string; files: string[] } | undefined;
	for await (const value of fields) {
		if (value === "") {
			if (record) yield record;
			record = {
				id: await nextLogField(fields),
				date: await nextLogField(fields),
				subject: await nextLogField(fields),
				files: [],
			};
		} else {
			if (!record) throw new Error("Git returned a log record without a header.");
			// Git inserts one newline before the first path, even with NUL-separated paths.
			record.files.push(record.files.length === 0 ? value.replace(/^\n/, "") : value);
		}
	}
	if (record) yield record;
}

async function* logRecords(repo: string, args: string[]): AsyncGenerator<HistoryCommit> {
	const signal = AbortSignal.timeout(GIT_TIMEOUT);
	const git = spawn(
		"git",
		[
			"-C",
			repo,
			"-c",
			"core.quotepath=off",
			"log",
			"--name-only",
			"-z",
			"--format=%x00%H%x00%cI%x00%s",
			"--no-decorate",
			"--no-notes",
			"--no-show-signature",
			"--no-color",
			"--no-relative",
			"--no-follow",
			"--no-renames",
			"--root",
			"--encoding=UTF-8",
			...args,
			"--",
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
			signal,
			killSignal: "SIGKILL",
		},
	);
	let diagnostic = "";
	let failure: Error | undefined;
	git.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		diagnostic = (diagnostic + chunk).slice(0, 4096);
	});
	git.on("error", (error) => {
		failure = error;
	});
	const status = new Promise<number | null>((done) => git.once("close", done));
	try {
		yield* parseLog(git.stdout.setEncoding("utf8"));
		const exit = await status;
		if (exit !== 0 || failure)
			throw new Error(diagnostic.trim() || failure?.message || `Git exited with status ${exit}.`);
	} catch (error) {
		if (signal.aborted) throw new Error("Git exceeded the 120 second limit.");
		throw error;
	} finally {
		if (git.exitCode === null && git.signalCode === null) git.kill("SIGKILL");
		await status;
	}
}

/** Read one Git log and yield one commit at a time without splitting filenames at newlines. */
export function readGitLog(repo: string, options: Partial<HistoryOptions> = {}): AsyncGenerator<HistoryCommit> {
	const { since, maxCommits = HISTORY_DEFAULTS.maxCommits } = options;
	return logRecords(repo, [
		"--no-merges",
		"--date-order",
		`--max-count=${maxCommits}`,
		...(since === undefined ? [] : [`--since=${since}`]),
	]);
}

function shallowBoundaries(repo: string): ReadonlySet<string> | undefined {
	const revParse = (flag: string, ...args: string[]) =>
		execFileSync("git", ["-C", repo, "rev-parse", flag, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: GIT_TIMEOUT,
			killSignal: "SIGKILL",
		}).trimEnd();
	if (revParse("--is-shallow-repository") !== "true") return undefined;
	const path = resolve(repo, revParse("--git-path", "shallow"));
	return new Set(readFileSync(path, "utf8").trim().split(/\s+/u));
}

function gitCommitReader(repo: string): CommitReader {
	let boundaries: ReadonlySet<string> | undefined;
	let checked = false;
	return async (id) => {
		if (!checked) {
			boundaries = shallowBoundaries(repo);
			checked = true;
		}
		const prefix = id.toLowerCase();
		let files: readonly string[] | undefined;
		for await (const commit of logRecords(repo, ["-1", "-m", "--first-parent", prefix])) {
			if (!commit.id.startsWith(prefix)) continue;
			if (boundaries?.has(commit.id)) {
				throw new Error(
					"A shallow clone has no changes to read for this boundary commit. Fetch more history or remove the id.",
				);
			}
			files = commit.files;
		}
		if (!files) throw new Error("The id does not identify a commit.");
		return files;
	};
}

function singleLine(value: string, newline: string): string {
	return value
		.replace(/\r\n|[\n\r\u2028\u2029]/g, newline)
		.replace(/\p{Cc}/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function escapeCell(value: string): string {
	return singleLine(
		value
			.replaceAll("\\", "\\\\")
			.replaceAll("|", "\\|")
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;"),
		"<br>",
	);
}

function tableRow(values: string[]): string {
	return `| ${values.map(escapeCell).join(" | ")} |`;
}

function omitted(count: number): string {
	return `… ${count} more ${count === 1 ? "row" : "rows"} omitted.`;
}

function list<T>(items: readonly T[], render: (item: T) => string, limit = TEXT_ROWS): string[] {
	const visible = items.slice(0, limit).map(render);
	if (items.length > limit) visible.push(omitted(items.length - limit));
	return visible;
}

function table(header: string[], rows: string[][], limit = TEXT_ROWS, trailer = omitted): string[] {
	const shown = rows.slice(0, limit).map(tableRow);
	return [
		tableRow(header),
		tableRow(header.map(() => "---")),
		...shown,
		...(rows.length > limit ? ["", trailer(rows.length - limit)] : []),
	];
}

function candidateText({ kind, ids, count }: Candidate, partCount: number): string {
	const [id, ...others] = ids.map((value) => singleLine(value, "\\n"));
	const names = others.join(", ");
	switch (kind) {
		case "tangle":
			return `tangle: ${[id, ...others].join(", ")} rely on each other in a loop`;
		case "shared-decision":
			return `shared-decision ${id}: known by ${count} of ${partCount} parts (${names}), owned by none`;
		case "wide-change":
			return `wide-change ${id}: edits ${count} of ${partCount} parts (${names})`;
		case "no-secret":
			return `no-secret ${id}: states no hidden decision`;
		case "unplaced-decision":
			return `unplaced-decision ${id}: no requirement row relies on it`;
		case "unmarked":
			return `unmarked ${id}: the named commits changed ${names}, which the row does not mark`;
		case "idle":
			return `idle ${id}: no mark and no reliance`;
	}
}

function renderHomes({ scattered, sharedHomes }: Homes, total: number): string[] {
	const lines: string[] = [];
	if (scattered.length) {
		const ids = singleLine(scattered.map(({ requirement }) => requirement).join(", "), "\\n");
		const label = total === 1 ? "requirement has" : "requirements have";
		lines.push(`Homes: ${scattered.length} of ${total} ${label} several owners (${ids}).`);
	}
	const [first, ...rest] = sharedHomes;
	if (first) {
		const counts = [
			`${first.part} owns ${first.requirements.length} requirements`,
			...rest.map(({ part, requirements }) => `${part} ${requirements.length}`),
		];
		lines.push(`Homes: ${counts.join(", ")}.`);
	}
	return lines;
}

function renderAssessment(result: Assessment): string {
	const { subject, mode, evidenceChecked, order, layers, tangles, nodes, requirements, changes, candidates } = result;
	const parts = nodes.filter(({ kind }) => kind === "part");
	const declared = changes.filter(({ kind }) => kind === "declared");
	const shared = new Set(nodes.filter(({ kind }) => kind === "decision").map(({ id }) => id));
	const column = (id: string) => (shared.has(id) ? `shared: ${id}` : id);
	const lines = [
		`Subject: ${singleLine(subject, "\\n")} (${parts.length} parts, ${nodes.length - parts.length} decisions, ${requirements.length} requirements, ${declared.length} declared changes)`,
		evidenceChecked
			? "Evidence: Paths and line numbers checked against --repo."
			: mode === "plan"
				? "Evidence: Plan mode; repository checks do not apply."
				: "Evidence: Paths and line numbers not checked against a repository; use --repo to check them.",
		`Order: ${order}`,
		...list(
			layers,
			({ layer, nodes }) => `Layer ${layer}: ${nodes.map((id) => (shared.has(id) ? `${id} (shared)` : id)).join(", ")}`,
		),
	];
	lines.push(...renderHomes(result.homes, requirements.length));
	for (const tangle of tangles.slice(0, TEXT_ROWS)) {
		lines.push("", `Tangle: ${tangle.parts.join(", ")}`);
		lines.push(
			...list(
				tangle.edges.flatMap(({ from, to, labels }) => labels.map((label) => ({ from, to, label }))),
				({ from, to, label }) =>
					`- ${from} → ${to}: ${label.kind === "knows" ? "knows" : singleLine(label.requirement, "\\n")} (${singleLine(label.evidence, "\\n")})`,
			),
		);
	}
	if (tangles.length > TEXT_ROWS) lines.push(omitted(tangles.length - TEXT_ROWS));
	lines.push(
		"",
		...table(
			["Requirement", ...nodes.map(({ id }) => column(id))],
			requirements.map(({ id, text, cells }) => [`${id}: ${text}`, ...nodes.map((node) => cells[node.id])]),
		),
	);
	lines.push(
		"",
		...table(
			["Node", "Name", "Layer", "Used by", "Leaned on by", "Owns", "Edited by", "Hides"],
			nodes.map((node) => [
				column(node.id),
				node.name,
				String(node.layer),
				node.usedBy.join(", "),
				node.leanedOnBy.length ? `${node.leanedOnBy.length}: ${node.leanedOnBy.join(", ")}` : "0",
				node.owns?.join(", ") ?? "",
				node.editedBy?.join(", ") ?? "",
				node.hides ?? "",
			]),
		),
	);
	lines.push(
		"",
		...table(
			["Change", ...parts.map(({ id }) => id), "Width"],
			changes.map(({ id, kind, text, cells, width, totalParts }) => [
				`${kind === "declared" ? id : `${kind} ${id}`}: ${text}`,
				...parts.map((part) => cells[part.id]),
				`${width} of ${totalParts}`,
			]),
		),
	);
	lines.push(
		"",
		"Requirements legend: O owns the requirement, x is relied on by an owner, Ox both, ? not settled.",
		"Changes legend: E edit reasoned from the code, H edit also seen in the named commits, ! changed by the named commits but not marked, ? not settled. A decision row is a change to that shared decision.",
	);
	lines.push(
		"",
		"Candidates to verify:",
		...(candidates.length ? list(candidates, (candidate) => candidateText(candidate, parts.length)) : ["none"]),
	);
	return lines.join("\n");
}

function historyTable(header: string[], rows: string[][], limit = TEXT_ROWS, trailer = omitted): string[] {
	return rows.length ? table(header, rows, limit, trailer) : ["none"];
}

function pairText(grid: PairGrid): string {
	const reasons = grid.relies.map(([from, to]) => `${from} relies on ${to}`);
	if (grid.decisions.length) reasons.push(`shared: ${grid.decisions.join(", ")}`);
	return reasons.join("; ") || "not explained";
}

function renderSkipped(skipped: HistorySummary["skipped"]): string[] {
	const rows = skipped.commits.map(({ id, date, subject }) => [id.slice(0, 7), date.slice(0, 10), subject]);
	const lines = historyTable(["Commit", "Date", "Subject"], rows, rows.length);
	if (skipped.unmatched.length) lines.push(`Unmatched ids: ${skipped.unmatched.join(", ")}.`);
	return lines;
}

function historyWindow(
	window: HistorySummary["window"],
	skipped: number,
	bulk: number,
	mapping: MappingCounts,
): string {
	const reached = window.maxCommits > 0 && window.commits + window.boundaryCommits >= window.maxCommits;
	const shallow = window.shallow
		? ` Shallow clone: ${window.boundaryCommits} boundary commits set aside; older history is not present.`
		: "";
	return `Window: ${window.commits} non-merge commits read (limit ${window.maxCommits}${reached ? " reached, older commits not read" : ""}${window.since === undefined ? "" : `, since ${singleLine(window.since, "\\n")}`}), committed ${window.oldest?.slice(0, 10) ?? "on no dates"}${window.newest === null ? "" : ` to ${window.newest.slice(0, 10)}`}; skipped by request: ${skipped}; bulk: set aside ${bulk} commits over ${window.bulk} files; mapping: ${mapping.mappedFiles} mapped, ${mapping.unmappedFiles} unmapped file changes, ${mapping.commitsWithNoPart} commits with no part.${shallow}`;
}

function renderPair({ subject, window, pair }: HistoryPair): string {
	const [a, b] = pair.parts;
	return [
		`Subject: ${singleLine(subject, "\\n")}`,
		historyWindow(window, window.skipped, window.bulkCommits, window.mapping),
		`Commits that changed both ${a} and ${b}: ${pair.total}`,
		...historyTable(
			["Commit", "Date", "Other parts", "Subject"],
			pair.commits.map(({ id, date, otherParts, subject }) => [id, date.slice(0, 10), otherParts.join(", "), subject]),
			Math.min(TEXT_ROWS, window.top),
			(count) => `… ${count} more ${count === 1 ? "commit" : "commits"} changed both ${a} and ${b}.`,
		),
	].join("\n");
}

function renderHistory(result: HistorySummary): string {
	const { subject, window, skipped, bulk, mapping, parts, spread, pairs, pairsCompared, widest } = result;
	const limit = Math.min(TEXT_ROWS, window.top);
	const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
	return [
		`Subject: ${singleLine(subject, "\\n")}`,
		historyWindow(window, skipped.commits.length, bulk.commits, mapping),
		...(mapping.unmatchedPaths.length
			? [
					`Paths that matched no changed file: ${mapping.unmatchedPaths.map(({ part, path }) => `${singleLine(path, "\\n")} (${part})`).join(", ")}`,
				]
			: []),
		"",
		"Skipped by request:",
		...renderSkipped(skipped),
		"",
		"Per part:",
		...table(
			["Part", "Commits", "Only this part", "With other parts", ...(pairsCompared ? ["Leaned on by"] : [])],
			parts.map(({ id, name, commits, alone, together, leanedOnBy }) => [
				`${name} (${id})`,
				String(commits),
				String(alone),
				String(together),
				...(leanedOnBy === null ? [] : [String(leanedOnBy)]),
			]),
		),
		"",
		"Spread:",
		...table(
			["Parts changed", "Commits"],
			[
				["1", String(spread.one)],
				["2", String(spread.two)],
				["3", String(spread.three)],
				["4 or more", String(spread.fourOrMore)],
			],
		),
		"",
		"Pairs:",
		...(pairsCompared
			? []
			: [`Pairs were not compared with the grid: ${result.pairsNote ?? "the grid file does not pass assess yet"}.`]),
		...historyTable(
			["Part A", "Part B", "Commits together", "Share of A", "Share of B", ...(pairsCompared ? ["In the grid"] : [])],
			pairs.map(({ parts, count, shares, grid }) => [
				...parts,
				String(count),
				percent(shares[0]),
				percent(shares[1]),
				...(grid ? [pairText(grid)] : []),
			]),
			limit,
		),
		"",
		"Widest commits:",
		...historyTable(
			["Commit", "Date", "Width", "Parts", "Subject"],
			widest.map(({ id, date, width, parts, subject }) => [
				id,
				date.slice(0, 10),
				String(width),
				parts.join(", "),
				subject,
			]),
			limit,
			(count) => `… ${count} more commits changed two or more parts.`,
		),
		"",
		"Largest bulk commits:",
		...historyTable(
			["Commit", "Date", "Files", "Parts", "Subject"],
			bulk.largest.map(({ id, date, files, parts, subject }) => [
				id,
				date.slice(0, 10),
				String(files),
				String(parts),
				subject,
			]),
		),
		"",
		"Top unmapped directories:",
		...historyTable(
			["Directory", "File changes"],
			mapping.unmappedDirectories.map(({ directory, files }) => [
				directory === "." ? ". (repository root)" : directory,
				String(files),
			]),
		),
		"",
		"Top unmapped files:",
		...historyTable(
			["Path", "Commits"],
			mapping.topUnmappedFiles.map(({ path, commits }) => [path, String(commits)]),
		),
	].join("\n");
}

/** Render a complete structured result or a row-bounded Markdown report. */
export function renderText(result: Assessment | HistorySummary | HistoryPair | Failure): string {
	if (!result.ok)
		return result.errors.map(({ location, message }) => singleLine(`${location}: ${message}`, "\\n")).join("\n");
	if ("pair" in result) return renderPair(result);
	return "window" in result ? renderHistory(result) : renderAssessment(result);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type CliOptions = {
	command: Command;
	file: string;
	repo?: string;
	format: "text" | "json";
	history: HistoryOptions;
	pair?: PartPair;
};

function parsePair(value: string): PartPair {
	const ids = value.split(",").map((id) => id.trim());
	if (ids.length !== 2 || ids.some((id) => !NODE_ID.test(id)) || ids[0] === ids[1]) {
		throw new Error("Use --pair <a>,<b> with two different part ids.");
	}
	return [ids[0], ids[1]];
}

function nonnegativeInteger(value: string, flag: string, max = Number.MAX_SAFE_INTEGER): number {
	const number = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number > max) {
		throw new Error(
			max === Number.MAX_SAFE_INTEGER
				? `Use a non-negative integer for ${flag}.`
				: `Use an integer from 0 to ${max} for ${flag}.`,
		);
	}
	return number;
}

function applyOption(options: CliOptions, flag: string, value: string): void {
	if (flag === "--repo") {
		options.repo = value;
		return;
	}
	if (flag === "--format") {
		if (value !== "text" && value !== "json") throw new Error("Use text or json for --format.");
		options.format = value;
		return;
	}
	if (!["--since", "--max-commits", "--bulk", "--top", "--skip", "--pair"].includes(flag))
		throw new Error(`Unknown option ${flag}.`);
	if (options.command !== "history") throw new Error(`Use ${flag} only with history.`);
	switch (flag) {
		case "--since":
			options.history.since = value;
			break;
		case "--max-commits":
			options.history.maxCommits = nonnegativeInteger(value, flag, 20000);
			break;
		case "--bulk":
			options.history.bulk = nonnegativeInteger(value, flag);
			break;
		case "--top":
			options.history.top = nonnegativeInteger(value, flag);
			break;
		case "--pair":
			options.pair = parsePair(value);
			break;
		case "--skip": {
			const ids = value.split(",").map((id) => id.trim());
			if (ids.some((id) => !COMMIT_ID.test(id)))
				throw new Error("Use comma-separated commit ids of 7 to 40 hexadecimal characters for --skip.");
			options.history.skip = ids;
			break;
		}
	}
}

function optionValue(flag: string, value: string | undefined): string {
	if (!value || value.startsWith("--")) throw new Error(`Supply a value after ${flag}.`);
	return value;
}

function parseArgs(args: string[]): CliOptions {
	const [command, ...tail] = args;
	if (command !== "assess" && command !== "history") throw new Error("Choose the assess or history command.");
	const options: CliOptions = { command, file: "", format: "text", history: { ...HISTORY_DEFAULTS } };
	const seen = new Set<string>();
	for (let i = 0; i < tail.length; i++) {
		const arg = tail[i];
		if (!arg.startsWith("-")) {
			if (options.file) throw new Error(`Supply one grid file; unexpected argument ${arg}.`);
			options.file = arg;
			continue;
		}
		if (seen.has(arg)) throw new Error(`Use ${arg} only once.`);
		seen.add(arg);
		applyOption(options, arg, optionValue(arg, tail[++i]));
	}
	if (!options.file) throw new Error(`Supply a grid file after ${command}.`);
	if (command === "history" && options.repo === undefined) throw new Error("Supply --repo for history.");
	return options;
}

function print(result: Assessment | HistorySummary | HistoryPair | Failure, format: CliOptions["format"]): number {
	if (format === "json" && "widest" in result) {
		const { pairs, widest, window } = result;
		const limit = Math.max(JSON_HISTORY_ROWS, window.top);
		console.log(
			JSON.stringify(
				{
					...result,
					pairs: pairs.slice(0, limit),
					pairsTotal: pairs.length,
					widest: widest.slice(0, limit),
					widestTotal: widest.length,
				},
				null,
				2,
			),
		);
	} else if (format === "json") console.log(JSON.stringify(result, null, 2));
	else if (result.ok) console.log(renderText(result));
	else console.error(renderText(result));
	return result.ok ? 0 : 1;
}

/** Use the whole grid for the pair comparison when it validates; otherwise say why it was left out. */
function historyGrid(text: string, parts: Grid): { grid: Grid; pairsNote?: string } {
	const full = parseGrid(text);
	if (full.ok) return { grid: full.grid };
	const rows: unknown = JSON.parse(text.replace(/^\uFEFF/, "")).requirements;
	const empty = !Array.isArray(rows) || rows.length === 0;
	return {
		grid: parts,
		pairsNote: empty
			? "the grid file has no requirements yet"
			: "the grid file does not pass assess yet; run assess to see why",
	};
}

async function main(argv: string[]): Promise<number> {
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		console.log(help);
		return argv.length ? 0 : 2;
	}
	let options: CliOptions;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(`${singleLine(errorMessage(error), "\\n")}\n\n${help}`);
		return 2;
	}
	try {
		const bytes = readFileSync(options.file);
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			return print({ ok: false, errors: [{ location: "$", message: "Save the grid as UTF-8 JSON." }] }, options.format);
		}
		const { command, repo, format, history, pair } = options;
		const parsed = parseGrid(text, { command, repo });
		if (!parsed.ok) return print(parsed, format);
		if (command === "history" && repo !== undefined) {
			const scan = { ...history, shallow: shallowBoundaries(repo) };
			const commits = readGitLog(repo, history);
			if (pair) return print(await summarisePair(parsed.grid, commits, pair, scan), format);
			const { grid, pairsNote } = historyGrid(text, parsed.grid);
			return print(await summariseHistory(grid, commits, { ...scan, pairsNote }), format);
		}
		return print(
			await assess(parsed.grid, {
				evidenceChecked: repo !== undefined,
				readCommit: repo === undefined ? undefined : gitCommitReader(repo),
			}),
			format,
		);
	} catch (error) {
		console.error(singleLine(errorMessage(error), "\\n"));
		return 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = await main(process.argv.slice(2));
}
