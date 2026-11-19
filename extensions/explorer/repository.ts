import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type ReviewScope =
	| { kind: "uncommitted" }
	| { kind: "commit"; commit: string }
	| { kind: "range"; base: string; head: string }
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
			return ref(input.base) && ref(input.head) && Object.keys(input).length === 3;
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
		const [base, head] = await Promise.all([commit(repo.root, scope.base), commit(repo.root, scope.head)]);
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
	return (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n");
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
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
		throw new Error("Note lines must be ordered positive integers.");
	const lines = at ? await committedLines(repo, path, at) : await readLines(repo, path);
	if (end > lines.length) throw new Error("The requested note lines are outside the file.");
	return { start, end, commit: at ?? repo.head, quote: lines.slice(start - 1, end).join("\n") };
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
	if (repo.kind === "git" && anchor.commit && sha(anchor.commit)) {
		const diff = await git(
			repo.root,
			["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0", anchor.commit, "--", path],
			sourceLimit,
		).catch(() => null);
		const at = diff === null ? undefined : mappedStart(diff, anchor);
		if (at !== undefined && at !== start && matches(at)) return moved(at);
	}
	const found = uniqueQuote(lines, needle);
	return found && found !== start ? moved(found) : outdated;
}
