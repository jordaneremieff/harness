import { execFile as execFileCallback } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileKind, type ProseKind, type ScopedLine, segment } from "./detect.ts";
import { readRegular } from "./files.ts";

const execFile = promisify(execFileCallback);
const utf8 = new TextDecoder("utf-8", { fatal: true });
const inputLimit = 8 * 1024 * 1024;
export type Collected = { lines: ScopedLine[]; skipped: string[] };
type DiffRequest = { staged?: true; range?: string; paths?: string[]; kind?: ProseKind };

function decode(bytes: Buffer): string | undefined {
	try {
		const text = utf8.decode(bytes);
		return text.includes("\u0000") ? undefined : text;
	} catch {
		return undefined;
	}
}

export function fileInput(cwd: string, path: string, kind?: ProseKind): Collected {
	const full = resolve(cwd, path);
	const name = relative(cwd, full) || ".";
	const inferred = fileKind(name);
	if (kind !== undefined && inferred !== undefined && inferred !== "document")
		throw new Error("Omit kind for recognised code files; their extension selects code and comment checks.");
	if (!kind && !inferred) {
		if (!statSync(full).isFile()) throw new Error(`${path}: not a regular file`);
		return { lines: [], skipped: [`${name}: unsupported file kind`] };
	}
	const bytes = readRegular(full, inputLimit);
	if (!bytes) throw new Error(`${path}: file does not exist`);
	const text = decode(bytes);
	return text === undefined
		? { lines: [], skipped: [`${name}: not UTF-8 text`] }
		: { lines: segment({ kind: kind ?? "file", path: name, text }), skipped: [] };
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
	try {
		const { stdout } = await execFile(
			"git",
			[
				"--no-pager",
				"-c",
				"core.quotePath=false",
				"-c",
				"color.ui=false",
				"-c",
				"diff.suppressBlankEmpty=false",
				...args,
			],
			{
				cwd,
				encoding: "buffer",
				maxBuffer: 2 * inputLimit,
				timeout: 30_000,
				signal,
			},
		);
		return stdout;
	} catch (error) {
		const failure = error as Error & { stderr?: Buffer; code?: string | number };
		const message =
			failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
				? "output exceeds 16 MiB"
				: failure.stderr?.toString().trim().slice(0, 500) || failure.message;
		throw new Error(`git ${args[0]}: ${message}`, { cause: error });
	}
}

function hunkRange(row: string) {
	const match = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
	if (!match) throw new Error("Unrecognised git patch hunk.");
	return { oldRemaining: Number(match[1] ?? 1), newLine: Number(match[2]), remaining: Number(match[3] ?? 1) };
}

function hunkLines(rows: string[], start: number, after: string[], added: Set<number>) {
	let { oldRemaining, newLine, remaining } = hunkRange(rows[start]);
	for (let i = start + 1; i < rows.length && (remaining > 0 || oldRemaining > 0); i++) {
		const row = rows[i];
		if (!" +-".includes(row[0] ?? "\u0000")) continue;
		if (row[0] !== "+") oldRemaining--;
		if (row[0] !== "-") {
			after[newLine - 1] = row.slice(1);
			if (row[0] === "+") added.add(newLine);
			newLine++;
			remaining--;
		}
	}
	if (remaining || oldRemaining) throw new Error("Incomplete git patch hunk.");
}

function parseFilePatch(patch: Buffer, path: string): Collected {
	const rows = patch.toString("latin1").split("\n");
	const start = rows.findIndex((row) => row.startsWith("@@ "));
	if (start < 0) {
		const binary = rows.some((row) => row.startsWith("Binary files "));
		return { lines: [], skipped: binary ? [`${path}: binary file`] : [] };
	}
	const after: string[] = [];
	const added = new Set<number>();
	hunkLines(rows, start, after, added);
	if (!added.size) return { lines: [], skipped: [] };
	const bytes = Buffer.from(after.join("\n"), "latin1");
	if (bytes.length > inputLimit) return { lines: [], skipped: [`${path}: new content exceeds 8 MiB`] };
	const text = decode(bytes);
	return text === undefined
		? { lines: [], skipped: [`${path}: not UTF-8 text`] }
		: {
				lines: segment({ kind: "file", path, text }).filter((line) => added.has(line.line)),
				skipped: [],
			};
}

type Change = { path: string; previous?: string };
function changedFiles(output: Buffer, documentsOnly: boolean): Change[] {
	const fields = output.toString().split("\0");
	const files: Change[] = [];
	for (let i = 0; i + 1 < fields.length; ) {
		const status = fields[i++];
		const rename = status[0] === "R";
		const previous = rename ? fields[i++] : undefined;
		const path = fields[i++];
		const kind = fileKind(path);
		if (documentsOnly ? kind === "document" : kind !== undefined) files.push({ path, previous });
	}
	return files;
}

async function fileDiff(root: string, comparison: string[], file: Change, signal?: AbortSignal): Promise<Collected> {
	const paths = (file.previous === undefined ? [file.path] : [file.previous, file.path]).map(
		(path) => `:(top,literal)${path}`,
	);
	try {
		const patch = await git(
			root,
			[
				"diff",
				"--patch",
				"--no-ext-diff",
				"--no-textconv",
				"--find-renames",
				"--no-relative",
				// Keep new-file lexical context, then discard all rows that the patch did not add.
				"--unified=16777216",
				...comparison,
				"--",
				...paths,
			],
			signal,
		);
		return parseFilePatch(patch, file.path);
	} catch (error) {
		signal?.throwIfAborted();
		return { lines: [], skipped: [`${file.path}: ${error instanceof Error ? error.message : String(error)}`] };
	}
}

async function diffFiles(
	cwd: string,
	comparison: string[],
	paths: string[],
	documentsOnly: boolean,
	signal?: AbortSignal,
): Promise<Collected> {
	const root = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).toString().replace(/\n$/, "");
	const list = await git(
		cwd,
		[
			"--literal-pathspecs",
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--name-status",
			"-z",
			"--find-renames",
			"--no-relative",
			"--diff-filter=AMRTUXB",
			...comparison,
			"--",
			...paths,
		],
		signal,
	);
	const files = changedFiles(list, documentsOnly);
	const result: Collected = { lines: [], skipped: [] };
	for (let i = 0; i < files.length; i += 8) {
		const batch = await Promise.all(files.slice(i, i + 8).map((file) => fileDiff(root, comparison, file, signal)));
		for (const source of batch) {
			for (const line of source.lines) result.lines.push(line);
			result.skipped.push(...source.skipped);
		}
	}
	return result;
}

async function head(cwd: string, signal?: AbortSignal): Promise<string> {
	try {
		return (await git(cwd, ["rev-parse", "--verify", "HEAD"], signal)).toString().trim();
	} catch (error) {
		signal?.throwIfAborted();
		if (!(error instanceof Error) || !error.message.includes("Needed a single revision")) throw error;
		return (await git(cwd, ["hash-object", "-t", "tree", "/dev/null"], signal)).toString().trim();
	}
}

function validateDiff({ staged, range, paths = [], kind }: DiffRequest) {
	if (staged && range !== undefined) throw new Error("Choose staged or range, not both.");
	if (kind === "reply") throw new Error('A diff accepts kind "document" or "commit", not "reply".');
	if (kind === "commit" && (range === undefined || paths.length))
		throw new Error('Use kind "commit" with a range and without paths.');
	if (paths.some((path) => !path || isAbsolute(path) || path.startsWith(":") || path.split(sep).includes("..")))
		throw new Error(
			"Diff paths must be relative to the working directory, without parent components or Git pathspec magic.",
		);
}

async function resolveRange(cwd: string, range: string, signal?: AbortSignal) {
	const match = /^([^\s]+?)\.\.([^\s.][^\s]*)$/.exec(range);
	if (!match || match[1].includes("..") || match[2].includes("..")) throw new Error("Use a two-endpoint range A..B.");
	return Promise.all(
		match
			.slice(1)
			.map(async (ref) =>
				(await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal)).toString().trim(),
			),
	);
}

async function appendCommitLines(cwd: string, range: string, lines: ScopedLine[], signal?: AbortSignal) {
	const log = await git(cwd, ["log", "-z", "--format=%H%x00%B", range, "--"], signal);
	const records = log.toString().split("\0");
	for (let i = 0; i + 1 < records.length; i += 2) {
		const commit = records[i];
		for (const line of segment({ kind: "commit", text: records[i + 1] })) lines.push({ ...line, commit });
	}
}

export async function diffInput(cwd: string, request: DiffRequest, signal?: AbortSignal): Promise<Collected> {
	validateDiff(request);
	const { staged, range, paths = [], kind } = request;
	const revisions = range === undefined ? [await head(cwd, signal)] : await resolveRange(cwd, range, signal);
	const result: Collected =
		kind === "commit"
			? { lines: [], skipped: [] }
			: await diffFiles(cwd, [...(staged ? ["--cached"] : []), ...revisions], paths, kind === "document", signal);
	if (range !== undefined && kind !== "document")
		await appendCommitLines(cwd, revisions.join(".."), result.lines, signal);
	return result;
}
