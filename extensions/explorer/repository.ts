import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type ReviewScope =
	| { kind: "uncommitted" }
	| { kind: "commit"; commit: string }
	| { kind: "range"; base: string; head: string; mergeBase?: true }
	| { kind: "branch"; base?: string }
	| { kind: "since-review" };
export interface ResolvedScope {
	scope: ReviewScope;
	base: string | null;
	head: string;
	label: string;
	key: string;
}
export interface Repo {
	root: string;
	kind: "git" | "folder";
	identity: string;
	label: string;
	head: string | null;
	branch: string | null;
	defaultBranch: string | null;
	onDefaultBranch: boolean;
}
export interface Anchor {
	start: number;
	end: number;
	commit: string | null;
	quote: string;
}
export type Location = Pick<Anchor, "start" | "end"> & { location: "same" | "moved" | "outdated"; movedFrom?: number };
const sourceLimit = 4 * 1024 * 1024;
const validText = (value: string) => !/[\u0000\ud800-\udfff]/u.test(value);
const sha = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
const ref = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 512 &&
	!/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value) &&
	!value.startsWith("-");
export function isRelativePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Buffer.byteLength(value) <= 4096 &&
		validText(value) &&
		!isAbsolute(value) &&
		!value.includes("\\") &&
		value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
	);
}
export function validScope(value: unknown): value is ReviewScope {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const input = value as Record<string, unknown>;
	switch (input.kind) {
		case "uncommitted":
		case "since-review":
			return Object.keys(input).length === 1;
		case "branch":
			return input.base === undefined
				? Object.keys(input).length === 1
				: ref(input.base) && Object.keys(input).length === 2;
		case "commit":
			return ref(input.commit) && Object.keys(input).length === 2;
		case "range":
			return (
				ref(input.base) &&
				ref(input.head) &&
				(input.mergeBase === true ? Object.keys(input).length === 4 : Object.keys(input).length === 3)
			);
		default:
			return false;
	}
}
const localEnvironment = () => ({
	...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
	GIT_OPTIONAL_LOCKS: "0",
	GIT_TERMINAL_PROMPT: "0",
});
function gitBytes(root: string, args: string[], maxBuffer: number): Promise<Buffer> {
	return new Promise((accept, reject) => {
		execFile(
			"git",
			["-c", "core.fsmonitor=false", "--literal-pathspecs", "-C", root, ...args],
			{ env: localEnvironment(), encoding: "buffer", timeout: 2500, maxBuffer, killSignal: "SIGKILL" },
			(error, stdout) => (error ? reject(error) : accept(stdout)),
		);
	});
}
async function git(root: string, args: string[], maxBuffer = 65536) {
	return (await gitBytes(root, args, maxBuffer)).toString("utf8");
}
const optionalGit = (root: string, args: string[]) =>
	git(root, args).then(
		(result) => result.replace(/\n$/u, ""),
		() => null,
	);
async function commit(root: string, revision: string) {
	const result = await optionalGit(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
	if (!result || !sha(result)) throw new Error(`Git cannot resolve ${revision} to a commit.`);
	return result;
}
async function defaultBranchAt(root: string, branch: string | null): Promise<string | null> {
	const remote = await optionalGit(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
	const localName = remote?.startsWith("refs/remotes/origin/") ? remote.slice("refs/remotes/origin/".length) : null;
	if (localName) return localName;
	for (const name of ["main", "master", "trunk"])
		if (await optionalGit(root, ["show-ref", "--verify", `refs/heads/${name}`])) return name;
	const names = (
		await optionalGit(root, ["for-each-ref", "--count=2", "--format=%(refname:short)", "refs/heads"])
	)?.split("\n");
	return names?.length === 1 && names[0] ? names[0] : branch;
}
export async function resolveRepository(rootDirectory: string): Promise<Repo> {
	const directory = await realpath(rootDirectory);
	if (!(await stat(directory)).isDirectory()) throw new Error("The Explorer root must be a directory.");
	const found = await optionalGit(directory, ["rev-parse", "--show-toplevel"]);
	if (!found)
		return {
			root: directory,
			kind: "folder",
			identity: directory,
			label: basename(directory) || directory,
			head: null,
			branch: null,
			defaultBranch: null,
			onDefaultBranch: false,
		};
	const root = await realpath(found);
	const [common, head, branch] = await Promise.all([
		git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		optionalGit(root, ["rev-parse", "--verify", "HEAD"]),
		optionalGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
	]);
	const [identity, defaultBranch] = await Promise.all([
		realpath(common.replace(/\n$/u, "")),
		defaultBranchAt(root, branch),
	]);
	return {
		root,
		kind: "git",
		identity,
		label: basename(root) || root,
		head: head && sha(head) ? head : null,
		branch,
		defaultBranch,
		onDefaultBranch: branch !== null && branch === defaultBranch,
	};
}
function contained(root: string, file: string) {
	const path = relative(root, file);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
function targetPath(input: string | undefined, cwd: string): string {
	if (input === undefined) return resolve(cwd);
	if (!validText(input) || Buffer.byteLength(input) > 4096) throw new Error("Invalid Explorer path.");
	return resolve(cwd, input === "~" || input.startsWith("~/") ? `${homedir()}${input.slice(1)}` : input);
}
export async function resolveTarget(
	inputPath: string | undefined,
	cwd: string,
): Promise<{ repo: Repo; path?: string }> {
	const selected = targetPath(inputPath, cwd);
	const canonical = await realpath(selected);
	const info = await stat(canonical);
	if (!info.isFile() && !info.isDirectory()) throw new Error("Explorer opens only folders and regular files.");
	const parent = selected === resolve(selected, "..") ? selected : dirname(selected);
	const parentRepo = await resolveRepository(parent);
	if (parentRepo.kind === "git" && !contained(parentRepo.root, canonical))
		throw new Error("The path points outside its repository.");
	const repo = info.isDirectory() ? await resolveRepository(canonical) : parentRepo;
	if (!contained(repo.root, canonical)) throw new Error("The path points outside its root.");
	const selectedInRoot = resolve(await realpath(parent), basename(selected));
	const shown = contained(repo.root, selectedInRoot) ? selectedInRoot : canonical;
	const path = relative(repo.root, shown).split(sep).join("/");
	if (!path) return { repo };
	if (!isRelativePath(path)) throw new Error("Explorer cannot open this path relative to its root.");
	return { repo, path };
}

export async function resolveReviewTarget(input: string | undefined, cwd: string) {
	try {
		return await resolveTarget(input, cwd);
	} catch (error) {
		if (!input || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const { repo } = await resolveTarget(undefined, cwd);
		const selected = targetPath(input, await realpath(cwd));
		const path = relative(repo.root, selected).split(sep).join("/");
		if (repo.kind !== "git" || !isRelativePath(path)) throw error;
		return { repo, path };
	}
}

const short = (hash: string) => hash.slice(0, 8);
async function defaultBase(repo: Repo): Promise<string> {
	if (!repo.defaultBranch) throw new Error("The default branch is unavailable. Name a commit or range instead.");
	const name = repo.defaultBranch;
	const remote = await optionalGit(repo.root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
	if (remote === `refs/remotes/origin/${name}`) return commit(repo.root, remote);
	return commit(repo.root, `refs/heads/${name}`);
}
function review(scope: ReviewScope, base: string | null, head: string, label: string): ResolvedScope {
	return { scope, base, head, label, key: `${base ?? "empty"}..${head}` };
}
async function parentFor(repo: Repo, head: string, marker?: string | null): Promise<string | null> {
	if (marker && sha(marker)) {
		const retained = await optionalGit(repo.root, ["rev-parse", "--verify", "--end-of-options", `${marker}^{commit}`]);
		if (retained && sha(retained)) return retained;
	}
	const parent = await optionalGit(repo.root, ["rev-parse", "--verify", "--end-of-options", `${head}^1`]);
	return parent && sha(parent) ? parent : null;
}
async function branchReview(repo: Repo, scope: Extract<ReviewScope, { kind: "branch" }>, head: string) {
	const target = scope.base ? await commit(repo.root, scope.base) : await defaultBase(repo);
	const base = await optionalGit(repo.root, ["merge-base", target, head]);
	if (!base || !sha(base)) throw new Error("The branch and review base have no common ancestor.");
	return review(scope, base, head, `${repo.branch ?? short(head)} against ${scope.base ?? repo.defaultBranch}`);
}
export async function resolveScope(repo: Repo, scope: ReviewScope, marker?: string | null): Promise<ResolvedScope> {
	if (repo.kind !== "git") throw new Error("Reviews require a Git work tree.");
	if (!validScope(scope)) throw new Error("Invalid review scope.");
	if (scope.kind === "uncommitted")
		return {
			scope,
			base: repo.head,
			head: "worktree",
			label: "Uncommitted changes",
			key: `worktree@${repo.head ?? "empty"}`,
		};
	if (scope.kind === "range") {
		const [target, head] = await Promise.all([commit(repo.root, scope.base), commit(repo.root, scope.head)]);
		const base = scope.mergeBase ? await optionalGit(repo.root, ["merge-base", target, head]) : target;
		if (!base || !sha(base)) throw new Error("The review base and head have no common ancestor.");
		return review(scope, base, head, `${short(base)}..${short(head)}`);
	}
	const head = scope.kind === "commit" ? await commit(repo.root, scope.commit) : repo.head;
	if (!head) throw new Error("The Git work tree has no commits yet.");
	if (scope.kind === "branch") return branchReview(repo, scope, head);
	const parent = await parentFor(repo, head, scope.kind === "since-review" ? marker : null);
	return review(scope, parent, head, scope.kind === "commit" ? `Commit ${short(head)}` : "Since your last review");
}
export async function defaultScope(repo: Repo): Promise<ReviewScope> {
	if (repo.kind !== "git") throw new Error("Reviews require a Git work tree.");
	const changes = await git(
		repo.root,
		["status", "--porcelain=v1", "--untracked-files=normal", "-z"],
		16 * 1024 * 1024,
	);
	return changes || !repo.head ? { kind: "uncommitted" } : { kind: repo.onDefaultBranch ? "since-review" : "branch" };
}

function sourceLines(bytes: Uint8Array) {
	if (bytes.includes(0)) throw new Error("A note requires text, not binary data.");
	const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n/gu, "\n");
	return content === "" ? [] : (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n");
}
async function readLines(repo: Repo, path: string): Promise<string[]> {
	if (!isRelativePath(path)) throw new Error("Invalid relative file path.");
	const requested = resolve(repo.root, path);
	const file = await realpath(requested);
	if (!contained(repo.root, file) || !isRelativePath(relative(repo.root, file)))
		throw new Error("The file points outside its repository or into Git metadata.");
	const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await fd.stat();
		if (!info.isFile() || info.size > sourceLimit)
			throw new Error("A note requires a regular text file within the size limit.");
		const bytes = Buffer.alloc(Math.min(info.size + 1, sourceLimit + 1));
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await fd.read(bytes, length, bytes.length - length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		const current = await realpath(requested);
		const after = await stat(current);
		if (
			length !== info.size ||
			file !== current ||
			info.dev !== after.dev ||
			info.ino !== after.ino ||
			info.mtimeMs !== after.mtimeMs
		)
			throw new Error("The file changed during the read.");
		return sourceLines(bytes.subarray(0, length));
	} finally {
		await fd.close();
	}
}
async function committedBlob(repo: Repo, path: string, at: string): Promise<string | undefined> {
	if (repo.kind !== "git" || !sha(at) || !isRelativePath(path)) throw new Error("Invalid path or commit for the note.");
	const entry = await git(repo.root, ["ls-tree", "-z", at, "--", path]);
	const match = /^100(?:644|755) blob ([0-9a-f]+)\t([^\0]+)\0$/u.exec(entry);
	return match && sha(match[1]) && match[2] === path ? match[1] : undefined;
}
async function committedLines(repo: Repo, path: string, at: string) {
	const oid = await committedBlob(repo, path, at);
	if (!oid) throw new Error("The reviewed commit does not contain this regular file.");
	const bytes = await gitBytes(repo.root, ["cat-file", "blob", oid], sourceLimit).catch(() => {
		throw new Error("The reviewed file could not be read within the note size or time limit.");
	});
	return sourceLines(bytes);
}
export async function readAnchor(repo: Repo, path: string, start: number, end: number, at?: string): Promise<Anchor> {
	const lines = at ? await committedLines(repo, path, at) : await readLines(repo, path);
	return anchorLines(lines, start, end, at ?? repo.head);
}
export async function reviewAnchor(repo: Repo, path: string, start: number, end: number, review?: ResolvedScope) {
	const head = review?.head;
	if (!head || head === "worktree") {
		try {
			return { side: "head" as const, ...(await readAnchor(repo, path, start, end)) };
		} catch (error) {
			if (!review?.base || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return { side: "base" as const, ...(await readAnchor(repo, path, start, end, review.base)) };
		}
	}
	if (review.base && !(await committedBlob(repo, path, head))) {
		return { side: "base" as const, ...(await readAnchor(repo, path, start, end, review.base)) };
	}
	return { side: "head" as const, ...(await readAnchor(repo, path, start, end, head)) };
}
function mappedStart(diff: string, anchor: Anchor): number | undefined {
	let offset = 0;
	for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/gmu)) {
		const base = Number(match[1]);
		const removed = Number(match[2] ?? 1);
		const added = Number(match[3] ?? 1);
		if (removed === 0 ? base < anchor.start : base + removed <= anchor.start) offset += added - removed;
		else if (removed === 0 ? base < anchor.end : base <= anchor.end) return undefined;
		else break;
	}
	return anchor.start + offset;
}
function quotePrefix(needle: string[]) {
	const prefix = new Uint32Array(needle.length);
	for (let at = 1, matched = 0; at < needle.length; at++) {
		while (matched > 0 && needle[at] !== needle[matched]) matched = prefix[matched - 1];
		if (needle[at] === needle[matched]) matched++;
		prefix[at] = matched;
	}
	return prefix;
}
function uniqueQuote(lines: string[], needle: string[]): number {
	const prefix = quotePrefix(needle);
	let found = 0;
	for (let at = 0, matched = 0; at < lines.length; at++) {
		while (matched > 0 && lines[at] !== needle[matched]) matched = prefix[matched - 1];
		if (lines[at] === needle[matched]) matched++;
		if (matched !== needle.length) continue;
		if (found) return 0;
		found = at - needle.length + 2;
		matched = prefix[matched - 1];
	}
	return found;
}
export type ReviewSide = "head" | "base";

function reviewLines(repo: Repo, review: ResolvedScope, path: string, side: ReviewSide): Promise<string[]> {
	const ref = side === "base" ? review.base : review.head;
	if (ref === null) throw new Error("The review has no base file.");
	return ref === "worktree" ? readLines(repo, path) : committedLines(repo, path, ref);
}

function anchorLines(lines: string[], start: number, end: number, commit: string | null): Anchor {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
		throw new Error("Note lines must be ordered positive integers.");
	if (end > lines.length) throw new Error("The requested note lines are outside the file.");
	return { start, end, commit, quote: lines.slice(start - 1, end).join("\n") };
}

export async function readReviewAnchor(
	repo: Repo,
	review: ResolvedScope,
	path: string,
	side: ReviewSide,
	start: number,
	end: number,
): Promise<Anchor> {
	return anchorLines(
		await reviewLines(repo, review, path, side),
		start,
		end,
		side === "base" ? review.base : review.head === "worktree" ? repo.head : review.head,
	);
}

type Point = { old: number | null; new: number | null; kind: "added" | "deleted" | "context" };
export type Position = { oldPath: string; newPath: string; start: Point; end: Point; inDiff: boolean };
type Span = { start: number; end: number; point: Point };
type Shift = { base: number; head: number };
type FileDiff = {
	oldPath: string;
	newPath: string;
	spans: Record<ReviewSide, Span[]>;
	shifts: Shift[];
	unsupported: boolean;
	untracked?: true;
};
type ReviewDiff = Record<ReviewSide, Map<string, FileDiff>>;
const diffLimit = 16 * 1024 * 1024;
const diffSafety = ["--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all"];

async function withoutCleanFilters(root: string): Promise<string[]> {
	const keys = await git(
		root,
		["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"],
		sourceLimit,
	).catch((error: { code?: string | number }) => {
		if (Number(error.code) === 1) return "";
		throw error;
	});
	return [...new Set(keys.split("\0").filter(Boolean))].flatMap((key) => [
		"-c",
		`${key}=${key.endsWith(".required") ? "false" : ""}`,
	]);
}

function addSpan(spans: Span[], start: number, length: number, point: Point) {
	if (!length) return;
	const previous = spans.at(-1);
	const past = previous && pointAt(previous, start);
	if (previous?.end === start - 1 && past?.kind === point.kind && past.old === point.old && past.new === point.new)
		previous.end += length;
	else spans.push({ start, end: start + length - 1, point });
}

type Hunk = { oldLine: number; newLine: number; oldLeft: number; newLeft: number };

function parseHunkHeader(line: string): Hunk | undefined {
	const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
	if (!hunk) return undefined;
	return {
		oldLine: Number(hunk[1]),
		oldLeft: Number(hunk[2] ?? 1),
		newLine: Number(hunk[3]),
		newLeft: Number(hunk[4] ?? 1),
	};
}

function appendHunkLine(file: FileDiff, hunk: Hunk, prefix: string) {
	if (prefix !== " " && prefix !== "+" && prefix !== "-") throw new Error("Git returned an incomplete diff hunk.");
	const point: Point = {
		old: prefix === "+" ? null : hunk.oldLine,
		new: prefix === "-" ? null : hunk.newLine,
		kind: prefix === "+" ? "added" : prefix === "-" ? "deleted" : "context",
	};
	if (point.old !== null) {
		addSpan(file.spans.base, hunk.oldLine++, 1, point);
		hunk.oldLeft--;
	}
	if (point.new !== null) {
		addSpan(file.spans.head, hunk.newLine++, 1, point);
		hunk.newLeft--;
	}
	if (hunk.oldLeft < 0 || hunk.newLeft < 0) throw new Error("Git returned an invalid diff hunk.");
}

function unfinished(hunk: Hunk | undefined): hunk is Hunk {
	return hunk !== undefined && (hunk.oldLeft > 0 || hunk.newLeft > 0);
}

function parseHunks(file: FileDiff, patch: string) {
	let hunk: Hunk | undefined;
	for (const line of patch.split("\n")) {
		if (unfinished(hunk)) {
			if (!line.startsWith("\\ ")) appendHunkLine(file, hunk, line[0]);
			continue;
		}
		if (line.startsWith("Binary files ")) file.unsupported = true;
		hunk = parseHunkHeader(line);
		if (hunk) file.shifts.push({ base: hunk.oldLine + (hunk.oldLeft || 1), head: hunk.newLine + (hunk.newLeft || 1) });
	}
	if (unfinished(hunk)) throw new Error("Git returned an incomplete diff hunk.");
}

function addReviewFile(diff: ReviewDiff, file: FileDiff, status: string) {
	if (status !== "A") diff.base.set(file.oldPath, file);
	if (status !== "D") diff.head.set(file.newPath, file);
}

function parseReviewDiff(source: string): ReviewDiff {
	const diff: ReviewDiff = { base: new Map(), head: new Map() };
	if (!source) return diff;
	// The NUL-delimited raw records carry exact paths in patch order, including renames.
	const boundary = source.indexOf("\0\0");
	if (boundary < 0) throw new Error("Git returned incomplete review paths.");
	const raw = source.slice(0, boundary).split("\0");
	const patches = source
		.slice(boundary + 2)
		.split(/^diff --git /mu)
		.slice(1);
	let patch = 0;
	for (let index = 0; index < raw.length; ) {
		const status = /^:[^\n]+ ([A-Z])[0-9]*$/u.exec(raw[index++])?.[1];
		const oldPath = raw[index++];
		const newPath = status === "R" ? raw[index++] : oldPath;
		if (!status || oldPath === undefined || newPath === undefined)
			throw new Error("Git returned invalid review paths.");
		const file: FileDiff = { oldPath, newPath, spans: { base: [], head: [] }, shifts: [], unsupported: false };
		parseHunks(file, patches[patch++] ?? "");
		if (status === "T") parseHunks(file, patches[patch++] ?? "");
		addReviewFile(diff, file, status);
	}
	if (patch !== patches.length) throw new Error("Git returned mismatched review paths and patches.");
	return diff;
}

export async function readReviewDiff(repo: Repo, review: ResolvedScope): Promise<ReviewDiff> {
	const base = review.base ?? (await git(repo.root, ["hash-object", "-t", "tree", "/dev/null"])).trim();
	const worktree = review.head === "worktree";
	try {
		const config = worktree ? await withoutCleanFilters(repo.root) : [];
		const output = await git(
			repo.root,
			[
				...config,
				"-c",
				"diff.suppressBlankEmpty=false",
				"diff",
				...diffSafety,
				"--find-renames",
				"-l0",
				"--raw",
				"-z",
				"--patch",
				"--unified=3",
				"--inter-hunk-context=0",
				"--submodule=short",
				"--output-indicator-old=-",
				"--output-indicator-new=+",
				"--output-indicator-context= ",
				base,
				...(worktree ? [] : [review.head]),
				"--",
			],
			diffLimit,
		);
		const diff = parseReviewDiff(output);
		if (worktree) {
			const others = await git(repo.root, ["ls-files", "-z", "--others", "--exclude-standard", "--"], diffLimit);
			for (const path of others.split("\0")) {
				if (!path || diff.head.has(path)) continue;
				diff.head.set(path, {
					oldPath: path,
					newPath: path,
					spans: { base: [], head: [] },
					shifts: [],
					unsupported: false,
					untracked: true,
				});
			}
		}
		return diff;
	} catch {
		throw new Error("Git could not read the review diff within its size or time limit.");
	}
}

function pointAt(span: Span, line: number): Point {
	const offset = line - span.start;
	const { old, new: fresh, kind } = span.point;
	return { old: old === null ? null : old + offset, new: fresh === null ? null : fresh + offset, kind };
}

function diffPoint(spans: Span[], shifts: Shift[], side: ReviewSide, line: number): Point {
	for (const span of spans) {
		if (line < span.start) break;
		if (line <= span.end) return pointAt(span, line);
	}
	let offset = 0;
	for (const shift of shifts) {
		if (line < shift[side]) break;
		offset = shift.head - shift.base;
	}
	return side === "base"
		? { old: line, new: line + offset, kind: "context" }
		: { old: line - offset, new: line, kind: "context" };
}

function reviewQuoteStart(lines: string[], needle: string[], note: Pick<Anchor, "start" | "end">, anchor: Anchor) {
	const matches = (start: number, end: number) =>
		end - start + 1 === needle.length &&
		start >= 1 &&
		end <= lines.length &&
		needle.every((line, index) => lines[start - 1 + index] === line);
	return matches(note.start, note.end)
		? note.start
		: matches(anchor.start, anchor.end)
			? anchor.start
			: uniqueQuote(lines, needle);
}

function coversRange(spans: Span[], start: number, end: number) {
	let covered = start;
	for (const span of spans) {
		if (span.end < covered) continue;
		if (span.start > covered) break;
		covered = span.end + 1;
		if (covered > end) return true;
	}
	return false;
}

export async function locateReviewPosition(
	repo: Repo,
	review: ResolvedScope,
	diff: ReviewDiff,
	note: { path: string; side: ReviewSide; start: number; end: number; anchor: Anchor },
): Promise<{ start: number; end: number; position: Position | null; reason?: string }> {
	const { path, side, anchor } = note;
	const counterpart = diff[side === "base" ? "head" : "base"].get(path);
	const file = diff[side].get(path) ?? (counterpart?.oldPath !== counterpart?.newPath ? counterpart : undefined);
	const oldPath = file?.oldPath ?? path;
	const newPath = file?.newPath ?? path;
	const lines = await reviewLines(repo, review, side === "base" ? oldPath : newPath, side).catch(() => null);
	const missing = (reason: string) => ({ start: note.start, end: note.end, position: null, reason });
	if (!lines) return missing("The review side does not contain readable text at this path.");
	if (file?.unsupported) return missing("Git did not produce comparable text for this path.");
	const needle = anchor.quote.split("\n");
	const start = reviewQuoteStart(lines, needle, note, anchor);
	if (!start) return missing("The note quote does not match a unique location on this review side.");
	const end = start + needle.length - 1;
	let spans = file?.spans[side] ?? [];
	if (side === "head" && file?.untracked)
		spans = [{ start: 1, end: lines.length, point: { old: null, new: 1, kind: "added" } }];
	const shifts = file?.shifts ?? [];
	return {
		start,
		end,
		position: {
			oldPath,
			newPath,
			start: diffPoint(spans, shifts, side, start),
			end: diffPoint(spans, shifts, side, end),
			inDiff: coversRange(spans, start, end),
		},
	};
}

export async function resolveAnchor(repo: Repo, path: string, anchor: Anchor): Promise<Location> {
	const { start, end } = anchor;
	const outdated: Location = { start, end, location: "outdated" };
	const lines = await readLines(repo, path).catch(() => null);
	if (!lines) return outdated;
	const needle = anchor.quote.replace(/\r\n/gu, "\n").split("\n");
	const matches = (at: number) =>
		at >= 1 && at + needle.length - 1 <= lines.length && needle.every((line, index) => lines[at - 1 + index] === line);
	const moved = (at: number): Location => ({
		start: at,
		end: at + needle.length - 1,
		location: "moved",
		movedFrom: start,
	});
	if (end - start + 1 === needle.length && matches(start)) return { start, end, location: "same" };
	const atCommit = anchor.commit;
	if (repo.kind === "git" && atCommit && sha(atCommit)) {
		const diff = await withoutCleanFilters(repo.root)
			.then((config) =>
				git(repo.root, [...config, "diff", ...diffSafety, "--unified=0", atCommit, "--", path], sourceLimit),
			)
			.catch(() => null);
		const at = diff === null ? undefined : mappedStart(diff, anchor);
		if (at !== undefined && at !== start && matches(at)) return moved(at);
	}
	const found = uniqueQuote(lines, needle);
	return found && found !== start ? moved(found) : outdated;
}
