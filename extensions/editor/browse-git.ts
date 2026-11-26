import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { decode, EditorError, fileName, isWithin, MAX_FILE_BYTES } from "./store-files.ts";

const GIT_TIME = 1_500;
const STATUS_BYTES = 256 * 1024;
const STATUS_FILES = 400;
const DIFF_FILE_BYTES = 2 * 1024 * 1024;
const DIFF_BYTES = 128 * 1024;
const LIST_BYTES = 4 * 1024 * 1024;
const GIT_ENV = {
	HOME: "/var/empty",
	PATH: "/usr/bin:/bin",
	LC_ALL: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_NO_LAZY_FETCH: "1",
};

// Git can read config includes and object alternates, and even status can run a clean filter.
// The sandbox is the boundary for reads beyond the worktree, writes, network, and helpers.
const READ_ONLY = `(version 1)
(allow default)
(deny file-read-data)
(allow file-read-data (subpath (param "ROOT")) (literal (param "GIT"))
  (literal "/") (literal "/dev/null") (subpath "/System/Library") (subpath "/usr/lib"))
(deny file-write*)
(allow file-write* (literal "/dev/null"))
(deny network*)
(deny process-exec)
(allow process-exec (literal (param "GIT")))`;

// The linked checkout needs its registration, not the other registrations or the primary checkout.
const LINKED_METADATA = `
(define common (param "COMMON"))
(allow file-read-data
  (subpath (param "ADMIN"))
  (literal common)
  (literal (string-append common "/HEAD"))
  (literal (string-append common "/config"))
  (literal (string-append common "/packed-refs"))
  (literal (string-append common "/shallow"))
  (literal (string-append common "/info/attributes"))
  (literal (string-append common "/info/exclude"))
  (subpath (string-append common "/objects"))
  (subpath (string-append common "/refs"))
  (subpath (string-append common "/reftable")))`;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
type Repo = { worktree: string; metadata: string; externalCommon?: string };
type StatusFile = { path: string; status: string };
type Run = { output: Buffer; limited: boolean };
type Command = (args: string[], bytes: number, acceptOne?: boolean) => Promise<Run>;
const STATUS_FLAGS = [
	"--porcelain=v1",
	"-z",
	"--branch",
	"--no-ahead-behind",
	"--no-show-stash",
	"--no-renames",
	"--untracked-files=all",
	"--ignore-submodules=all",
];
const DIFF_FLAGS = [
	"--no-ext-diff",
	"--no-textconv",
	"--no-color",
	"--no-renames",
	"--diff-algorithm=myers",
	"--ignore-submodules=all",
	"--src-prefix=a/",
	"--dst-prefix=b/",
];

async function stat(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function readPointer(path: string): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid Git metadata pointer.");
		const buffer = Buffer.alloc(stat.size + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
		if (bytesRead !== stat.size) throw new Error("Git metadata changed on disk.");
		return decoder.decode(buffer.subarray(0, bytesRead)).replace(/\r?\n$/, "");
	} finally {
		await file.close();
	}
}

async function canonicalMetadata(path: string): Promise<void> {
	if (!(await stat(path))?.isDirectory() || (await realpath(path)) !== path) {
		throw new Error("Git metadata requires a directory without symlinks.");
	}
}

async function pointerPath(path: string, prefix = ""): Promise<string> {
	const record = await readPointer(path);
	const value = record.slice(prefix.length);
	if (!record.startsWith(prefix) || !value || /[\0\r\n]/.test(value)) {
		throw new Error("Invalid Git metadata pointer.");
	}
	return resolve(dirname(path), value);
}

async function linkedCommon(marker: string, metadata: string): Promise<string> {
	const registration = dirname(metadata);
	const common = dirname(registration);
	try {
		if (basename(registration) !== "worktrees") throw new Error("Invalid worktree registration path.");
		await canonicalMetadata(metadata);
		if ((await pointerPath(join(metadata, "gitdir"))) !== marker) throw new Error("Invalid Git worktree backlink.");
		if ((await pointerPath(join(metadata, "commondir"))) !== common) throw new Error("Invalid common Git directory.");
		if (!(await stat(join(common, "HEAD")))?.isFile() || !(await stat(join(common, "config")))?.isFile()) {
			throw new Error("Missing Git common repository metadata.");
		}
		await canonicalMetadata(join(common, "objects"));
		return common;
	} catch (cause) {
		throw new Error("Git metadata outside the selected folder is not registered to this worktree.", { cause });
	}
}

async function repoAt(root: string, worktree: string): Promise<Repo | undefined> {
	const marker = join(worktree, ".git");
	const entry = await stat(marker);
	if (!entry) return;
	if (!entry.isFile() && !entry.isDirectory()) throw new Error("Use Git metadata without symlinks.");
	const metadata = entry.isFile() ? await pointerPath(marker, "gitdir: ") : marker;
	if (!isWithin(root, metadata)) return { worktree, metadata, externalCommon: await linkedCommon(marker, metadata) };
	await canonicalMetadata(metadata);
	const commondir = join(metadata, "commondir");
	if (await stat(commondir)) {
		const common = await pointerPath(commondir);
		if (!isWithin(root, common)) throw new Error("Git common metadata is outside the selected folder.");
		await canonicalMetadata(common);
	}
	return { worktree, metadata };
}

async function selectedLocation(root: string, doc: string | undefined, signal?: AbortSignal) {
	const worktrees = [root];
	if (doc === undefined) return { worktrees, fileBytes: 0 };
	const parts = doc.split("/");
	const leaf = parts.pop() as string;
	let path = root;
	for (const part of parts) {
		signal?.throwIfAborted();
		path = join(path, part);
		const entry = await stat(path);
		if (!entry) return { worktrees, fileBytes: 0 };
		if (!entry.isDirectory() || (await realpath(path)) !== path) throw new Error("Use a file path without symlinks.");
		worktrees.push(path);
	}
	const selected = join(path, leaf);
	const entry = await stat(selected);
	if (entry && (!entry.isFile() || (await realpath(selected)) !== selected)) {
		throw new Error("Use a regular file path without symlinks.");
	}
	return { worktrees, fileBytes: entry?.size ?? 0 };
}

async function findRepo(root: string, worktrees: string[], signal?: AbortSignal): Promise<Repo | undefined> {
	for (let index = worktrees.length - 1; index >= 0; index--) {
		signal?.throwIfAborted();
		const repo = await repoAt(root, worktrees[index]);
		if (repo) return repo;
	}
}

function run(
	program: string,
	args: string[],
	cwd: string,
	end: number,
	maxBuffer: number,
	signal?: AbortSignal,
	acceptOne = false,
): Promise<Run> {
	signal?.throwIfAborted();
	const timeout = Math.ceil(end - performance.now());
	if (timeout <= 0 || maxBuffer <= 0) return Promise.resolve({ output: Buffer.alloc(0), limited: true });
	return new Promise((resolve, reject) => {
		execFile(
			program,
			args,
			{ cwd, env: GIT_ENV, encoding: "buffer", maxBuffer, timeout, killSignal: "SIGKILL", signal },
			(error, stdout, stderr) => {
				if (signal?.aborted) return reject(signal.reason);
				if (!error || (acceptOne && error.code === 1)) return resolve({ output: stdout, limited: false });
				if (error.killed || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
					return resolve({ output: stdout, limited: true });
				}
				const message = stderr.toString().trim().slice(0, 600);
				reject(new Error(message ? `Git unavailable: ${message}` : "Git or its read-only sandbox is unavailable."));
			},
		);
	});
}

function* completeRecords(output: Buffer): Generator<Buffer> {
	let start = 0;
	for (let end = output.indexOf(0); end >= 0; end = output.indexOf(0, start)) {
		yield output.subarray(start, end);
		start = end + 1;
	}
}

function branchName(record: string) {
	const label = record.slice(3);
	const initial = "No commits yet on ";
	const unborn = label.startsWith(initial);
	return { branch: unborn ? label.slice(initial.length) : label.split("...")[0], unborn };
}

function parseStatus(root: string, repo: Repo, result: Run) {
	const files: StatusFile[] = [];
	const parent = relative(root, repo.worktree);
	const prefix = parent ? `${parent}/` : "";
	let branch = { branch: "", unborn: false };
	let limited = result.limited;
	for (const bytes of completeRecords(result.output)) {
		try {
			const record = decoder.decode(bytes);
			if (record.startsWith("## ")) {
				branch = branchName(record);
				continue;
			}
			if (record[2] !== " " || record.endsWith("/")) continue;
			if (files.length === STATUS_FILES) {
				limited = true;
				break;
			}
			files.push({ path: fileName(prefix + record.slice(3)), status: record.slice(0, 2) });
		} catch {
			limited = true;
		}
	}
	return { ...branch, files, limited };
}

function diffText(result: Run): string | undefined {
	const bytes = result.limited ? result.output.subarray(0, result.output.lastIndexOf(10) + 1) : result.output;
	try {
		return decoder.decode(bytes);
	} catch {
		return;
	}
}

async function makePatch(command: Command, file: string, untracked: boolean, unborn: boolean): Promise<Run> {
	if (untracked) {
		// Force a relative operand even if the name begins with a dash or colon.
		return command(["diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", `./${file}`], DIFF_BYTES, true);
	}
	if (!unborn) return command(["diff", ...DIFF_FLAGS, "HEAD", "--", file], DIFF_BYTES);
	const staged = await command(["diff", ...DIFF_FLAGS, "--cached", "--", file], DIFF_BYTES);
	if (staged.limited) return staged;
	const unstaged = await command(["diff", ...DIFF_FLAGS, "--", file], DIFF_BYTES - staged.output.length);
	return { output: Buffer.concat([staged.output, unstaged.output]), limited: unstaged.limited };
}

async function gitCommand(root: string, repo: Repo, end: number, signal?: AbortSignal): Promise<Command | undefined> {
	const tool = await run("/usr/bin/xcrun", ["--no-cache", "--find", "git"], root, end, 4096, signal);
	if (tool.limited) return;
	const git = await realpath(tool.output.toString().trim());
	const profile = repo.externalCommon
		? ["-D", `ADMIN=${repo.metadata}`, "-D", `COMMON=${repo.externalCommon}`, "-p", READ_ONLY + LINKED_METADATA]
		: ["-p", READ_ONLY];
	return (args, bytes, acceptOne = false) =>
		run(
			"/usr/bin/sandbox-exec",
			[
				"-D",
				`ROOT=${root}`,
				"-D",
				`GIT=${git}`,
				...profile,
				git,
				"--no-optional-locks",
				"--no-replace-objects",
				"--literal-pathspecs",
				"--no-pager",
				`--git-dir=${repo.metadata}`,
				`--work-tree=${repo.worktree}`,
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.untrackedCache=false",
				"-c",
				"core.bigFileThreshold=2m",
				...args,
			],
			repo.worktree,
			end,
			bytes,
			signal,
			acceptOne,
		);
}

export async function gitFiles(root: string, end: number, maximum: number, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const repo = await repoAt(root, root);
	if (!repo) return;
	const command = await gitCommand(root, repo, end, signal);
	if (!command) return { files: [], limited: true };
	const list = await command(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], LIST_BYTES);
	const files = new Set<string>();
	let limited = list.limited;
	for (const bytes of completeRecords(list.output)) {
		try {
			const path = fileName(decoder.decode(bytes));
			if (files.has(path)) continue;
			if (files.size === maximum) {
				limited = true;
				break;
			}
			files.add(path);
		} catch {
			limited = true;
		}
	}
	return { files: [...files], limited };
}

async function headText(command: Command, file: string) {
	const empty = { repo: true, tracked: false, limited: false };
	const tree = await command(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], 512, true);
	if (tree.limited) return { ...empty, limited: true };
	const oid = tree.output.toString().trim();
	if (!oid) return empty;
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid))
		throw new EditorError("Git returned an invalid HEAD tree.", "invalid");
	const result = await command(["ls-tree", "-z", oid, "--", file], 8192);
	if (result.limited) return { ...empty, limited: true };
	// Read only regular files from HEAD; a symlink blob is just its target name.
	const match = /^100(?:644|755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t/u.exec(result.output.toString());
	if (!match) return empty;
	const blob = await command(["cat-file", "blob", match[1]], MAX_FILE_BYTES + 1);
	if (blob.limited || blob.output.length > MAX_FILE_BYTES) return { repo: true, tracked: true, limited: true };
	return { repo: true, tracked: true, limited: false, text: decode(blob.output).text };
}

export async function gitBrowse(
	root: string,
	inputDoc: unknown,
	signal?: AbortSignal,
	base = false,
): Promise<Record<string, unknown>> {
	if ((inputDoc !== undefined || base) && typeof inputDoc !== "string") {
		throw new EditorError("Use a folder-relative file path.", "invalid");
	}
	const doc = inputDoc === undefined ? undefined : fileName(inputDoc as string);
	const end = performance.now() + GIT_TIME;
	const { worktrees, fileBytes } = await selectedLocation(root, doc, signal);
	const repo = await findRepo(root, worktrees, signal);
	signal?.throwIfAborted();
	const empty = base ? { tracked: false } : { branch: "", files: [] };
	if (!repo) return { ...empty, repo: false, limited: false };
	const command = await gitCommand(root, repo, end, signal);
	if (!command) return { ...empty, repo: true, limited: true };
	if (base && doc !== undefined) return headText(command, relative(repo.worktree, join(root, doc)));
	return gitStatus(root, repo, command, doc, fileBytes);
}

async function gitStatus(root: string, repo: Repo, command: Command, doc: string | undefined, fileBytes: number) {
	const status = await command(["status", ...STATUS_FLAGS], STATUS_BYTES);
	const { branch, files, limited, unborn } = parseStatus(root, repo, status);
	const result = { repo: true, branch, files, limited };
	if (doc === undefined) return result;
	if (fileBytes > DIFF_FILE_BYTES) return { ...result, limited: true };
	const file = relative(repo.worktree, join(root, doc));
	let selected = files.find((entry) => entry.path === doc);
	let initial = unborn;
	if (!selected && limited) {
		const specific = parseStatus(root, repo, await command(["status", ...STATUS_FLAGS, "--", file], STATUS_BYTES));
		if (specific.limited) return result;
		result.branch ||= specific.branch;
		selected = specific.files[0];
		initial = specific.unborn;
	}
	const diff = await makePatch(command, file, selected?.status === "??", initial);
	const text = diffText(diff);
	return { ...result, limited: limited || diff.limited || text === undefined, diff: text };
}
