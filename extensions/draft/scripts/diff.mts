// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).
import { type Analyzer, analyzeDocument, type DocResult } from "./analyze.mts";
import { type Kind, kindForPath, normalizeText } from "./extract.mts";

export interface DiffLine {
	newLine: number;
	text: string;
	added: boolean;
}

export interface DiffFile {
	path: string;
	deleted: boolean;
	hunks: DiffLine[][];
}

export interface ParsedDiff {
	commitMessage: string | null;
	files: DiffFile[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(path: string): string {
	const clean = path.replace(/\t.*$/, "").trim().replace(/^"|"$/g, "");
	return clean.replace(/^[ab]\//, "");
}

function patchCommit(lines: string[], subjectAt: number): string | null {
	const subject = (lines[subjectAt] ?? "").replace(/^Subject: (?:\[[^\]]*\]\s*)?/, "");
	const body: string[] = [];
	let i = subjectAt + 1;
	while (i < lines.length && /^\s+\S/.test(lines[i] ?? "")) {
		body.push((lines[i] ?? "").trim());
		i += 1;
	}
	while (i < lines.length && (lines[i] ?? "").trim() === "") i += 1;
	const rest: string[] = [];
	for (let j = i; j < lines.length && lines[j] !== "---"; j++) rest.push(lines[j] ?? "");
	const text = [[subject, ...body].join(" "), "", ...rest].join("\n").trimEnd();
	return text.trim() === "" ? null : text;
}

function commitFromPreamble(lines: string[]): string | null {
	const subjectAt = lines.findIndex((line) => /^Subject: /.test(line));
	if (subjectAt !== -1) return patchCommit(lines, subjectAt);
	const indented = lines.filter((line) => line.startsWith("    ")).map((line) => line.slice(4));
	return indented.length > 0 && indented[0]?.trim() !== "" ? indented.join("\n").trimEnd() : null;
}

/** Read one hunk body. Returns its lines and the index after it. */
function readHunk(lines: string[], from: number, header: RegExpExecArray): { body: DiffLine[]; next: number } {
	let oldLeft = Number(header[2] ?? 1);
	let newLeft = Number(header[4] ?? 1);
	let newLine = Number(header[3]);
	const body: DiffLine[] = [];
	let i = from;
	while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
		const entry = lines[i] ?? "";
		i += 1;
		const marker = entry[0] ?? " ";
		if (marker === "\\") continue;
		if (marker === "-") {
			oldLeft -= 1;
			continue;
		}
		body.push({ newLine, text: entry.slice(1), added: marker === "+" });
		newLine += 1;
		newLeft -= 1;
		if (marker !== "+") oldLeft -= 1;
	}
	return { body, next: i };
}

interface ParseState {
	files: DiffFile[];
	file: DiffFile | null;
	pendingOld: string | null;
	preamble: string[];
}

function startFile(state: ParseState, path: string, deleted: boolean): DiffFile {
	const created: DiffFile = { path, deleted, hunks: [] };
	state.files.push(created);
	state.file = created;
	return created;
}

function readTarget(state: ParseState, line: string): void {
	const target = line.slice(4).trim();
	if (target === "/dev/null") {
		const file = state.file ?? startFile(state, state.pendingOld ?? "", true);
		file.deleted = true;
	} else {
		const path = stripPrefix(target);
		const file = state.file;
		if (file === null || (file.hunks.length > 0 && file.path !== path)) startFile(state, path, false);
		else file.path = path;
	}
	state.pendingOld = null;
}

function readHeaderLine(state: ParseState, line: string): void {
	if (line.startsWith("diff --git ")) {
		startFile(state, / b\/(.+)$/.exec(line)?.[1] ?? "", false);
		state.pendingOld = null;
	} else if (line.startsWith("--- ")) {
		state.pendingOld = stripPrefix(line.slice(4));
	} else if (line.startsWith("+++ ") && (state.pendingOld !== null || state.file !== null)) {
		readTarget(state, line);
	} else if (state.file === null) {
		state.preamble.push(line);
	}
}

/** Parse a unified diff, keeping new-file line numbers for added and context lines. */
export function parseDiff(input: string): ParsedDiff {
	const lines = normalizeText(input).split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const state: ParseState = { files: [], file: null, pendingOld: null, preamble: [] };
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const hunk = HUNK.exec(line);
		if (hunk !== null && state.file !== null) {
			const read = readHunk(lines, i + 1, hunk);
			state.file.hunks.push(read.body);
			i = read.next;
		} else {
			readHeaderLine(state, line);
			i += 1;
		}
	}
	return { commitMessage: commitFromPreamble(state.preamble), files: state.files };
}

export interface DiffAnalysis {
	results: DocResult[];
	skipped: string[];
}

interface Synthetic {
	text: string;
	lineMap: number[];
	keep: Set<number>;
}

/** Join a file's hunks into one text, with a blank line between hunks, and remember which lines were added. */
function synthesize(file: DiffFile): Synthetic {
	const lines: string[] = [];
	const lineMap: number[] = [];
	const keep = new Set<number>();
	file.hunks.forEach((hunk, index) => {
		if (index > 0) {
			lines.push("");
			lineMap.push(0);
		}
		for (const entry of hunk) {
			lines.push(entry.text);
			lineMap.push(entry.newLine);
			if (entry.added) keep.add(lines.length);
		}
	});
	return { text: lines.join("\n"), lineMap, keep };
}

function analyzeFile(analyzer: Analyzer, file: DiffFile, kind: Kind): DocResult | null {
	const synthetic = synthesize(file);
	if (synthetic.keep.size === 0) return null;
	const result = analyzeDocument(analyzer, synthetic.text, kind, synthetic.keep);
	result.file = file.path;
	result.lineMap = (line) => synthetic.lineMap[line - 1] ?? line;
	return result;
}

/** Analyse the prose a diff adds. Findings and counts cover added lines only, reported at new-file line numbers. */
export function analyzeDiff(analyzer: Analyzer, diff: ParsedDiff): DiffAnalysis {
	const results: DocResult[] = [];
	const skipped: string[] = [];
	if (diff.commitMessage !== null) {
		const result = analyzeDocument(analyzer, diff.commitMessage, "commit");
		result.file = "(commit message)";
		results.push(result);
	}
	for (const file of diff.files) {
		const kind = file.deleted ? null : kindForPath(file.path);
		if (kind === null || kind === "commit") {
			skipped.push(file.path);
			continue;
		}
		const result = analyzeFile(analyzer, file, kind);
		if (result !== null) results.push(result);
	}
	return { results, skipped };
}
