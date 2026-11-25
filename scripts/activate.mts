#!/usr/bin/env node

// Switches the snapshot checkout that Pi's settings file lists as the harness
// package. The new snapshot must hold a commit of its repository's local main
// branch. The read, check and write run under Pi's settings lock so two
// sessions cannot overwrite each other's switch, and only the one package
// source is rewritten. Each switch is recorded in an activation log beside the
// settings file; afterwards the script removes the snapshots beside the new one
// that no running process can use, and keeps any whose use it cannot rule out.

import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

export interface SwitchOptions {
	settingsPath: string;
	expect: string;
	to: string;
	rollback?: boolean;
	isAncestor?: (ancestorDir: string, descendantDir: string) => boolean;
}

const remotePrefixes = ["npm:", "git:", "http://", "https://", "builtin:"];
const lockAttempts = 10;
const lockWaitMs = 20;
// Synchronous waiting without a timer: Atomics.wait blocks the thread briefly between lock attempts.
const lockWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const usage = "Usage: activate.mts [--rollback] --expect <current-snapshot-dir> <new-snapshot-dir>";
const mainRef = "refs/heads/main";
const mainRemedy = "Land the commit on main, then make the snapshot with git worktree add --detach <dir> main.";

type Settings = Record<string, unknown>;
type Match = { index: number; source: string };
type GitResult = { status: number | null; stdout: string; detail: string };

let repositoryVariables: string[] | undefined;

function resolvedPath(path: string): string {
	const absolute = resolve(path);
	return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function spawnGit(args: string[], env: NodeJS.ProcessEnv): GitResult {
	const result = spawnSync("git", args, { encoding: "utf8", env });
	if (result.error !== undefined)
		return { status: null, stdout: "", detail: `git did not run: ${result.error.message}` };
	const detail = result.stderr.trim() || `git exited with ${result.status ?? result.signal}`;
	return { status: result.status, stdout: result.stdout, detail };
}

/** Runs git without Git's repository-selecting variables, so it reads the repository that holds `directory`. */
function runGit(directory: string, args: string[]): GitResult {
	if (repositoryVariables === undefined) {
		const listed = spawnGit(["rev-parse", "--local-env-vars"], process.env);
		if (listed.status !== 0) return listed;
		repositoryVariables = listed.stdout.split("\n").filter(Boolean);
	}
	const env = { ...process.env };
	for (const name of repositoryVariables) delete env[name];
	return spawnGit(["-C", directory, ...args], env);
}

function gitHead(directory: string): string {
	const result = runGit(directory, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (result.status !== 0) throw new Error(`Could not read the commit of ${directory}: ${result.detail}`);
	return result.stdout.trim();
}

function mainEvidenceFailure(directory: string, detail: string): Error {
	return new Error(
		`Could not establish that the new snapshot's commit is on ${mainRef} of its repository: ${directory}: ${detail}.`,
	);
}

function mainEvidence(directory: string, args: string[]): string {
	const result = runGit(directory, args);
	if (result.status !== 0) throw mainEvidenceFailure(directory, result.detail);
	return result.stdout;
}

/**
 * The new snapshot must be the root of a work tree whose commit `refs/heads/main` of the same repository reaches.
 * A directory below a work-tree root would report the enclosing checkout's commit instead of its own.
 */
function assertOnMain(directory: string): void {
	const [inside, prefix] = mainEvidence(directory, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]).split("\n");
	if (inside !== "true" || prefix !== "") {
		throw mainEvidenceFailure(
			directory,
			"the directory is not the root of a Git work tree. Make the snapshot with git worktree add --detach <dir> main",
		);
	}
	const commit = mainEvidence(directory, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	// show-ref --verify reads only the exact ref; rev-parse would also resolve refs/tags/refs/heads/main.
	const mainCommit = mainEvidence(directory, ["show-ref", "--verify", "--hash", mainRef]).trim();
	const reach = runGit(directory, ["merge-base", "--is-ancestor", commit, mainCommit]);
	if (reach.status === 0) return;
	if (reach.status === 1) {
		throw new Error(
			`The new snapshot's commit ${commit} is not on ${mainRef} of its repository: ${directory}. ${mainRemedy}`,
		);
	}
	throw mainEvidenceFailure(directory, `commit ${commit}: ${reach.detail}`);
}

/** Default ancestry check: the descendant worktree must contain the ancestor commit. */
function gitAncestor(ancestorDir: string, descendantDir: string): boolean {
	const ancestor = gitHead(ancestorDir);
	const descendant = gitHead(descendantDir);
	return runGit(descendantDir, ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

function assertNewSnapshot(directory: string): void {
	if (!existsSync(directory) || !statSync(directory).isDirectory()) {
		throw new Error(`The new snapshot is not a directory: ${directory}`);
	}
	if (!existsSync(join(directory, "package.json"))) {
		throw new Error(`The new snapshot has no package.json: ${directory}`);
	}
}

function parseSettings(text: string, settingsPath: string): Settings {
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`The settings file is not a JSON object: ${settingsPath}`);
	}
	return value as Settings;
}

function sourceOf(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
	if ("source" in entry && typeof entry.source === "string") return entry.source;
	return undefined;
}

function isLocalSource(source: string): boolean {
	return !remotePrefixes.some((prefix) => source.startsWith(prefix));
}

function localSourcePath(source: string, settingsDir: string): string {
	if (isAbsolute(source)) return source;
	if (source.startsWith("~/")) return join(homedir(), source.slice(2));
	return resolve(settingsDir, source);
}

function matchesFor(packages: unknown[], settingsDir: string, expectReal: string): Match[] {
	const matches: Match[] = [];
	for (const [index, entry] of packages.entries()) {
		const source = sourceOf(entry);
		if (source === undefined || !isLocalSource(source)) continue;
		if (resolvedPath(localSourcePath(source, settingsDir)) === expectReal) matches.push({ index, source });
	}
	return matches;
}

/** Keeps the new source in the same form as the one it replaces. */
function replacementSource(oldSource: string, toReal: string, settingsDir: string): string {
	if (isAbsolute(oldSource) || oldSource.startsWith("~/")) return toReal;
	const path = relative(settingsDir, toReal).split(sep).join("/");
	return path.startsWith(".") ? path : `./${path}`;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function acquireSettingsLock(settingsPath: string): () => void {
	for (let attempt = 1; attempt <= lockAttempts; attempt += 1) {
		try {
			return lockfile.lockSync(settingsPath, { realpath: false });
		} catch (error) {
			if (errorCode(error) !== "ELOCKED") throw error;
			if (attempt === lockAttempts) break;
			Atomics.wait(lockWait, 0, 0, lockWaitMs);
		}
	}
	throw new Error(`The settings file is locked: ${settingsPath}`);
}

function withSource(entry: unknown, source: string): unknown {
	if (typeof entry === "string") return source;
	if (typeof entry === "object" && entry !== null) return { ...entry, source };
	return entry;
}

function restoredSettings(settings: Settings, index: number, source: string): Settings {
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const restored = packages.map((entry, position) => (position === index ? withSource(entry, source) : entry));
	return { ...settings, packages: restored };
}

function replaceSourceText(text: string, match: Match, newSource: string, settingsPath: string): string {
	const quoted = JSON.stringify(match.source);
	if (text.split(quoted).length !== 2) {
		throw new Error(`The settings file does not contain exactly one ${quoted} entry: ${settingsPath}`);
	}
	return text.replace(quoted, () => JSON.stringify(newSource));
}

/** Replaces the file through a flushed sibling, so a failed write leaves the original bytes in place. */
function replaceFile(path: string, text: string): void {
	const temporary = `${path}.activate-${process.pid}.tmp`;
	const descriptor = openSync(temporary, "wx");
	let renamed = false;
	try {
		try {
			fchmodSync(descriptor, statSync(path).mode & 0o777);
			writeFileSync(descriptor, text, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, path);
		renamed = true;
	} finally {
		if (!renamed) rmSync(temporary, { force: true });
	}
}

/** A duplicate key or an escaped twin can leave the effective source unchanged after a text replacement. */
function assertSelected(
	updated: Settings,
	index: number,
	settingsDir: string,
	toReal: string,
	settingsPath: string,
): void {
	const selected = Array.isArray(updated.packages) ? sourceOf(updated.packages[index]) : undefined;
	if (selected === undefined || resolvedPath(localSourcePath(selected, settingsDir)) !== toReal) {
		throw new Error(`The replacement would not select the new snapshot; the entry is ambiguous: ${settingsPath}`);
	}
}

function switchLocked(settingsPath: string, expectReal: string, toReal: string): { from: string; to: string } {
	const text = readFileSync(settingsPath, "utf8");
	const settings = parseSettings(text, settingsPath);
	if (!Array.isArray(settings.packages)) throw new Error(`The settings file has no packages array: ${settingsPath}`);
	const settingsDir = realpathSync(dirname(resolve(settingsPath)));
	const matches = matchesFor(settings.packages, settingsDir, expectReal);
	if (matches.length === 0) {
		throw new Error(
			`The harness package entry no longer names the expected snapshot (another activation may have moved it): ${expectReal}`,
		);
	}
	if (matches.length > 1) throw new Error(`More than one package entry names the expected snapshot: ${expectReal}`);
	const match = matches[0];
	const newSource = replacementSource(match.source, toReal, settingsDir);
	const next = replaceSourceText(text, match, newSource, settingsPath);
	const updated = parseSettings(next, settingsPath);
	assertSelected(updated, match.index, settingsDir, toReal, settingsPath);
	if (JSON.stringify(restoredSettings(updated, match.index, match.source)) !== JSON.stringify(settings)) {
		throw new Error(`The settings file could not be updated without changing other entries: ${settingsPath}`);
	}
	replaceFile(settingsPath, next);
	return { from: match.source, to: newSource };
}

/**
 * Replaces the one harness package entry after confirming that the new snapshot's commit is on its repository's
 * local main branch and that the entry still names `expect`. `rollback` skips only the ancestry check; the expected
 * snapshot itself needs no main commit, so a rollback can leave any active entry.
 */
export function switchHarnessPackage(options: SwitchOptions): { from: string; to: string } {
	const expectReal = resolvedPath(options.expect);
	const toReal = resolvedPath(options.to);
	assertNewSnapshot(toReal);
	assertOnMain(toReal);
	const isAncestor = options.isAncestor ?? gitAncestor;
	if (options.rollback !== true && !isAncestor(expectReal, toReal)) {
		throw new Error(
			`The new snapshot's commit does not descend from the current one: ${toReal}; --rollback selects an earlier snapshot.`,
		);
	}
	const release = acquireSettingsLock(options.settingsPath);
	try {
		return switchLocked(options.settingsPath, expectReal, toReal);
	} finally {
		release();
	}
}

/** The activation log beside the settings file: one JSON record per switch. */
export function activationLogPath(settingsPath: string): string {
	return join(dirname(resolve(settingsPath)), "harness-activations.jsonl");
}

interface ActivationRecord {
	at: string;
	from: string;
	to: string;
}

/** Appends one switch record with the real paths of both snapshots. */
export function recordActivation(logPath: string, from: string, to: string, at = new Date()): void {
	const record: ActivationRecord = { at: at.toISOString(), from: resolvedPath(from), to: resolvedPath(to) };
	appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

/** The valid records of the log in file order, or undefined when the log is missing or unreadable. */
function readActivations(logPath: string): ActivationRecord[] | undefined {
	let text: string;
	try {
		text = readFileSync(logPath, "utf8");
	} catch {
		return undefined;
	}
	const records: ActivationRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const value = JSON.parse(line) as Partial<ActivationRecord>;
			if (
				typeof value.at === "string" &&
				Number.isFinite(Date.parse(value.at)) &&
				typeof value.from === "string" &&
				typeof value.to === "string"
			)
				records.push({ at: value.at, from: value.from, to: value.to });
		} catch {
			/* A torn line holds no record. */
		}
	}
	return records;
}

/** One running process: its start, command line and working directory where known. */
export interface ProcessInfo {
	pid: number;
	startedAt: number;
	command: string;
	cwd?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PS_LINE = /^\s*(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s(.*)$/u;

function parseProcessTable(text: string): Map<number, ProcessInfo> {
	const processes = new Map<number, ProcessInfo>();
	for (const line of text.split("\n")) {
		const match = PS_LINE.exec(line);
		if (match === null) continue;
		const [, pid, month, day, hours, minutes, seconds, year, command] = match;
		const startedAt = Date.UTC(
			Number(year),
			MONTHS.indexOf(month),
			Number(day),
			Number(hours),
			Number(minutes),
			Number(seconds),
		);
		processes.set(Number(pid), { pid: Number(pid), startedAt, command: command.trim() });
	}
	return processes;
}

/** Working directories from `lsof -Fpn` output: `p<pid>` then `n<path>` lines. */
function addLsofDirectories(text: string, processes: Map<number, ProcessInfo>): void {
	let current: ProcessInfo | undefined;
	for (const line of text.split("\n")) {
		if (line.startsWith("p")) current = processes.get(Number(line.slice(1)));
		else if (line.startsWith("n") && current !== undefined) current.cwd = line.slice(1);
	}
}

function addProcDirectories(processes: Map<number, ProcessInfo>): void {
	for (const info of processes.values()) {
		try {
			info.cwd = realpathSync(`/proc/${info.pid}/cwd`);
		} catch {
			/* A process of another user or one that ended keeps no readable cwd. */
		}
	}
}

/** This machine's processes with `ps`, and their working directories with `lsof` or `/proc`; throws without them. */
export function localProcesses(): ProcessInfo[] {
	const env = { ...process.env, TZ: "UTC0", LC_ALL: "C" };
	const ps = spawnSync("ps", ["-axww", "-o", "pid=,lstart=,command="], { encoding: "utf8", env, maxBuffer: 64 << 20 });
	if (ps.status !== 0) throw new Error(`ps failed: ${ps.stderr.trim() || ps.status}`);
	const processes = parseProcessTable(ps.stdout);
	if (process.platform === "darwin") {
		const lsof = spawnSync("lsof", ["-a", "-d", "cwd", "-Fpn"], { encoding: "utf8", env, maxBuffer: 64 << 20 });
		if (lsof.error !== undefined || lsof.stdout.trim() === "") throw new Error("lsof listed no working directories");
		addLsofDirectories(lsof.stdout, processes);
	} else if (process.platform === "linux") addProcDirectories(processes);
	else throw new Error(`no working-directory source on ${process.platform}`);
	return [...processes.values()];
}

/** Pi sets its process title to `pi`; a process started through the package entry names it. */
function isPiProcess(command: string): boolean {
	const trimmed = command.trim();
	return trimmed === "pi" || trimmed.startsWith("pi ") || trimmed.includes("pi-coding-agent");
}

export interface PruneOptions {
	/** The directory that holds the snapshots: the parent of the new one. */
	releasesDir: string;
	active: string;
	previous: string;
	logPath: string;
	processes?: () => ProcessInfo[];
	now?: () => number;
}

export interface PruneResult {
	removed: string[];
	kept: { path: string; reasons: string[] }[];
	freedBytes: number;
	skipped?: string;
}

/** Disk use of one directory in bytes, or zero when `du` cannot measure it. */
function diskBytes(directory: string): number {
	const du = spawnSync("du", ["-sk", directory], { encoding: "utf8" });
	const kilobytes = Number.parseInt(du.stdout, 10);
	return du.status === 0 && Number.isFinite(kilobytes) ? kilobytes * 1024 : 0;
}

function createdAt(directory: string): number {
	const stat = statSync(directory);
	return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
}

/** The repository's worktrees from `git worktree list --porcelain`; the first is the main worktree. */
function worktrees(directory: string): string[] {
	const listed = runGit(directory, ["worktree", "list", "--porcelain"]);
	if (listed.status !== 0) throw new Error(`git worktree list failed: ${listed.detail}`);
	return listed.stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => resolvedPath(line.slice("worktree ".length)));
}

/** Snapshots that were active at any time since `since`, or undefined when the log does not reach back that far. */
function activeSince(logPath: string, since: number, active: string): Set<string> | undefined {
	const records = readActivations(logPath);
	if (records === undefined || records.length === 0 || Date.parse(records[0].at) > since) return undefined;
	const result = new Set([active]);
	let before: string | undefined;
	for (const record of records) {
		if (Date.parse(record.at) <= since) before = record.to;
		else {
			result.add(resolvedPath(record.from));
			result.add(resolvedPath(record.to));
		}
	}
	if (before !== undefined) result.add(resolvedPath(before));
	return result;
}

function within(path: string, directory: string): boolean {
	return path === directory || path.startsWith(`${directory}${sep}`);
}

/** What every candidate is judged against. */
interface KeepContext {
	active: string;
	previous: string;
	newest: readonly string[];
	processes: readonly ProcessInfo[];
	mainCommit: string;
	/** Snapshots active since the oldest running Pi process started, when the log covers that start. */
	since: Set<string> | undefined;
	oldestPi: number;
	newestBefore: string | undefined;
	created: Map<string, number>;
}

function usedByProcess(candidate: string, processes: readonly ProcessInfo[]): boolean {
	return processes.some(
		(info) => info.command.includes(candidate) || (info.cwd !== undefined && within(resolvedPath(info.cwd), candidate)),
	);
}

function mainReason(candidate: string, mainCommit: string): string | undefined {
	const head = runGit(candidate, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (head.status !== 0) return "commit check failed";
	const reach = runGit(candidate, ["merge-base", "--is-ancestor", head.stdout.trim(), mainCommit]).status;
	return reach === 0 ? undefined : reach === 1 ? "commit not on main" : "commit check failed";
}

function reasonsFor(candidate: string, context: KeepContext): string[] {
	const reasons: string[] = [];
	if (candidate === context.active) reasons.push("active");
	if (candidate === context.previous) reasons.push("previous entry");
	if (context.newest.includes(candidate)) reasons.push("among the newest 3");
	if (usedByProcess(candidate, context.processes)) reasons.push("used by a running process");
	const main = mainReason(candidate, context.mainCommit);
	if (main !== undefined) reasons.push(main);
	if (context.since?.has(candidate)) reasons.push("active since the oldest running Pi process started");
	const created = context.created.get(candidate) ?? 0;
	if (context.since === undefined && (created > context.oldestPi || candidate === context.newestBefore))
		reasons.push("possibly loaded by a running Pi process (no activation log covers its start)");
	return reasons;
}

/** The reasons to keep each snapshot candidate; an empty list allows removal. */
function keepReasons(
	candidates: readonly string[],
	options: PruneOptions,
	processes: readonly ProcessInfo[],
	mainCommit: string,
	now: number,
): Map<string, string[]> {
	const created = new Map(candidates.map((candidate) => [candidate, createdAt(candidate)]));
	const byAge = [...candidates].sort((a, b) => (created.get(b) ?? 0) - (created.get(a) ?? 0));
	const active = resolvedPath(options.active);
	const piStarts = processes.filter((info) => isPiProcess(info.command)).map((info) => info.startedAt);
	const oldestPi = piStarts.length === 0 ? now : Math.min(...piStarts);
	const context: KeepContext = {
		active,
		previous: resolvedPath(options.previous),
		newest: byAge.slice(0, 3),
		processes,
		mainCommit,
		since: activeSince(options.logPath, oldestPi, active),
		oldestPi,
		newestBefore: byAge.find((candidate) => (created.get(candidate) ?? 0) <= oldestPi),
		created,
	};
	return new Map(candidates.map((candidate) => [candidate, reasonsFor(candidate, context)]));
}

/**
 * Removes the snapshot worktrees beside the new snapshot that nothing can use. A snapshot stays when it is the active
 * or previous entry, among the newest three, named by a running process's command line or working directory, holds
 * a commit that main does not contain, or was active at any time since the oldest running Pi process started. Without
 * an activation log that reaches back to that start, every snapshot made after it stays, and so does the newest one
 * made before it. Removal uses `git worktree remove` without force, so a snapshot with untracked or changed files
 * stays as well. Missing process evidence removes nothing.
 */
export function pruneSnapshots(options: PruneOptions): PruneResult {
	const releasesDir = resolvedPath(options.releasesDir);
	const result: PruneResult = { removed: [], kept: [], freedBytes: 0 };
	let processes: ProcessInfo[];
	try {
		processes = (options.processes ?? localProcesses)();
	} catch (error) {
		return {
			...result,
			skipped: `process evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const listed = worktrees(options.active);
	const mainWorktree = listed[0];
	const mainCommit = mainEvidence(options.active, ["show-ref", "--verify", "--hash", mainRef]).trim();
	const entries = new Set(readdirSync(releasesDir).map((name) => resolvedPath(join(releasesDir, name))));
	const candidates = listed.slice(1).filter((path) => entries.has(path) && dirname(path) === releasesDir);
	const reasons = keepReasons(candidates, options, processes, mainCommit, (options.now ?? Date.now)());
	for (const candidate of candidates) {
		const kept = reasons.get(candidate) ?? [];
		if (kept.length > 0) {
			result.kept.push({ path: candidate, reasons: kept });
			continue;
		}
		const bytes = diskBytes(candidate);
		const removed = runGit(mainWorktree, ["worktree", "remove", candidate]);
		if (removed.status === 0) {
			result.removed.push(candidate);
			result.freedBytes += bytes;
		} else result.kept.push({ path: candidate, reasons: [`git worktree remove refused: ${removed.detail}`] });
	}
	if (result.removed.length > 0) runGit(mainWorktree, ["worktree", "prune"]);
	return result;
}

/** One line for the operator: what was removed and freed, and what stayed and why. */
export function describePrune(result: PruneResult): string {
	if (result.skipped !== undefined) return `Removed no snapshots: ${result.skipped}`;
	const megabytes = Math.round(result.freedBytes / (1024 * 1024));
	const kept = result.kept.map((item) => `${basename(item.path)} (${item.reasons.join("; ")})`).join(", ");
	return `Removed ${result.removed.length} unused snapshots (${megabytes} MB freed); kept ${result.kept.length}${kept === "" ? "" : `: ${kept}`}`;
}

function parseArguments(args: string[]): { rollback: boolean; expect: string; to: string } {
	const rollback = args[0] === "--rollback";
	const rest = rollback ? args.slice(1) : args;
	if (rest.length !== 3 || rest[0] !== "--expect") throw new Error(usage);
	return { rollback, expect: rest[1], to: rest[2] };
}

function main(): void {
	const { rollback, expect, to } = parseArguments(process.argv.slice(2));
	const settingsPath = join(getAgentDir(), "settings.json");
	const result = switchHarnessPackage({ settingsPath, expect, to, rollback });
	console.log(`Switched harness package: ${result.from} -> ${result.to}`);
	// The switch stands whatever follows; the log and the clean-up report their own failures.
	const logPath = activationLogPath(settingsPath);
	try {
		recordActivation(logPath, expect, to);
	} catch (error) {
		console.error(`The activation log was not written, so no snapshot was removed: ${errorText(error)}`);
		return;
	}
	try {
		const toReal = resolvedPath(to);
		console.log(
			describePrune(
				pruneSnapshots({ releasesDir: dirname(toReal), active: toReal, previous: resolvedPath(expect), logPath }),
			),
		);
	} catch (error) {
		console.error(`Snapshot clean-up failed: ${errorText(error)}`);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
