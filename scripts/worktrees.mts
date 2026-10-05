#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface RunOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	inherit?: boolean;
	accept?: readonly number[];
}

interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
}

interface WorktreePorcelainRecord {
	path: string;
	branch?: string;
	detached?: boolean;
}

type SliceKindName = "extension" | "skill" | "prompt" | "feature";

interface SliceKind {
	name: SliceKindName;
	/** Branch prefix, including the trailing slash. */
	branchPrefix: string;
	/** Entrypoint path inside the worktree; null means the kind has no entrypoint. */
	entrypoint: (worktreePath: string, name: string) => string | null;
	/** Dev-record root relative to the repository root; null means no dev records. */
	devRecordRoot: (name: string) => string | null;
}

interface WorktreeRecord {
	kind: SliceKindName;
	name: string;
	branch: string;
	path: string;
	entrypoint: string | null;
	devRecordRoot: string | null;
}

interface HarnessContext {
	repoRoot: string;
	worktreeRoot: string;
	settingsPath: string;
}

interface ReconcilePackageOptions {
	settingsDir: string;
	repoRoot: string;
	worktreeRoot: string;
	mainExtensionNames: readonly string[];
	entrypoints: ReadonlyMap<string, string>;
	forceActive?: readonly string[];
	forceInactive?: readonly string[];
}

interface ReconcileSettingsOptions {
	forceActive?: readonly string[];
	forceInactive?: readonly string[];
}

interface Settings {
	packages?: unknown[];
	[key: string]: unknown;
}

interface PromoteOptions {
	push: boolean;
	gates: boolean;
	json: boolean;
	dryRun: boolean;
}

type PromoteOptionName = keyof PromoteOptions;
type GateStatus = "pass" | "fail";
type GateResults = Record<string, GateStatus>;

interface GateCommand {
	name: string;
	command: [string, ...string[]];
}

interface PromotionPlanEntry {
	sha: string;
	subject: string;
	ships: string[];
	dropped: string[];
}

interface HeldPlanEntry {
	sha: string;
	subject: string;
}

interface SlicePromotionReport {
	name: string;
	kind: SliceKindName;
	branch: string;
	promoted: string[];
	held: Array<string | HeldPlanEntry>;
	wouldPromote?: PromotionPlanEntry[];
	gates: GateResults;
}

interface PromotionReport {
	slices?: SlicePromotionReport[];
	failedSlice?: string;
	ok: boolean;
	name?: string;
	kind?: SliceKindName;
	stage?: string;
	reason?: string;
	promoted?: string[];
	held?: Array<string | HeldPlanEntry>;
	recover?: string | null;
	dryRun?: boolean;
	wouldPromote?: PromotionPlanEntry[];
	wouldRunGates?: boolean;
	wouldPush?: boolean;
	mainBefore?: string;
	mainAfter?: string;
	gates?: GateResults;
	pushed?: boolean;
	syncOk?: boolean;
	branchFailures?: string[];
	/** Worktrees left at their commit because uncommitted tracked changes block a rebase; never a failure. */
	deferred?: string[];
}

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");
const hookMarker = "# managed by scripts/worktrees.mts";

const sliceKinds: SliceKind[] = [
	{
		name: "extension",
		branchPrefix: "extension/",
		entrypoint: (worktreePath, name) => join(worktreePath, "extensions", name, "index.ts"),
		devRecordRoot: (name) => `extensions/${name}`,
	},
	{
		name: "skill",
		branchPrefix: "skill/",
		entrypoint: (worktreePath, name) => join(worktreePath, "skills", name, "SKILL.md"),
		devRecordRoot: (name) => `skills/${name}`,
	},
	{
		name: "prompt",
		branchPrefix: "prompt/",
		entrypoint: (worktreePath, name) => join(worktreePath, "prompts", `${name}.md`),
		devRecordRoot: () => null,
	},
	{
		name: "feature",
		branchPrefix: "feature/",
		entrypoint: () => null,
		devRecordRoot: (name) => name,
	},
];

/** True when a hook file carries the current installer's ownership marker. */
export function hookIsManaged(content: string): boolean {
	return content.includes(hookMarker);
}

function sliceKindForBranch(branch: string): SliceKind | undefined {
	return sliceKinds.find((kind) => branch.startsWith(kind.branchPrefix));
}

function sliceKindForName(name: SliceKindName): SliceKind {
	const kind = sliceKinds.find((candidate) => candidate.name === name);
	if (!kind) throw new Error(`Unknown slice kind: ${name}`);
	return kind;
}

const sliceNamePattern = /^[a-z0-9][a-z0-9-]*$/;

/** Parse a `<kind>/<name>` slice reference; a bare `<name>` leaves the kind unresolved. */
export function parseSliceReference(reference: string): { kind?: SliceKindName; name: string } {
	const slash = reference.indexOf("/");
	const name = slash < 0 ? reference : reference.slice(slash + 1);
	if (!sliceNamePattern.test(name)) {
		throw new Error(`Slice name must use lowercase letters, numbers, and hyphens: ${name}`);
	}
	if (slash < 0) return { name };
	const kindName = reference.slice(0, slash);
	const kind = sliceKinds.find((candidate) => candidate.name === kindName);
	if (!kind) {
		const known = sliceKinds.map((candidate) => candidate.name).join(", ");
		throw new Error(`Unknown slice kind: ${kindName} (known kinds: ${known})`);
	}
	return { kind: kind.name, name };
}

/** Hook body. It resolves the main checkout at run time, so a moved repository keeps working. */
export function hookContent(): string {
	const branchPattern = ["main", ...sliceKinds.map((kind) => `${kind.branchPrefix}*`)].join("|");
	return `${[
		"#!/bin/sh",
		hookMarker,
		"branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)",
		'case "$branch" in',
		`  ${branchPattern}) ;;`,
		"  *) exit 0 ;;",
		"esac",
		"common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)",
		'case "$common" in',
		"  */.git) ;;",
		"  *) exit 0 ;;",
		"esac",
		'script="$(dirname "$common")/scripts/worktrees.mts"',
		'[ -f "$script" ] || exit 0',
		'exec node "$script" sync --hook',
	].join("\n")}\n`;
}

function branchExists(repoRoot: string, branch: string): boolean {
	return (
		git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
			accept: [0, 1],
		}).status === 0
	);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function devRecordPatterns(root: string): RegExp[] {
	const base = escapeRegExp(root);
	return [
		new RegExp(`^${base}/(?:AGENTS|LOG|PLAN|REWRITE-SPEC|SOLUTION)\\.md$`),
		new RegExp(`^${base}/[^/]*FINDINGS\\.md$`),
	];
}

export function isDevRecordPath(path: string, devRecordRoot: string | null): boolean {
	if (devRecordRoot === null) return false;
	return devRecordPatterns(devRecordRoot).some((pattern) => pattern.test(path));
}

export function classifyCommitFiles(
	files: readonly string[],
	devRecordRoot: string | null,
): {
	kind: "held" | "ship" | "filter";
	devRecords: string[];
	shipped: string[];
} {
	const devRecords = files.filter((file) => isDevRecordPath(file, devRecordRoot));
	const shipped = files.filter((file) => !isDevRecordPath(file, devRecordRoot));
	if (shipped.length === 0) return { kind: "held", devRecords, shipped };
	if (devRecords.length === 0) return { kind: "ship", devRecords, shipped };
	return { kind: "filter", devRecords, shipped };
}

const localGitEnvironmentKeys = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_CONFIG",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
	"GIT_DIR",
	"GIT_GRAFT_FILE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_REPLACE_REF_BASE",
	"GIT_SHALLOW_FILE",
	"GIT_WORK_TREE",
];

export function cleanGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const clean = { ...environment };
	for (const key of localGitEnvironmentKeys) delete clean[key];
	return clean;
}

function run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env ?? process.env,
		stdio: options.inherit ? "inherit" : "pipe",
	});
	const accepted = options.accept ?? [0];
	if (!accepted.includes(result.status ?? 1)) {
		const detail = (result.stderr || result.stdout || "").trim();
		throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
	}
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function git(repoRoot: string, args: readonly string[], options: RunOptions = {}): RunResult {
	return run("git", args, {
		cwd: options.cwd ?? repoRoot,
		env: cleanGitEnvironment(process.env),
		...options,
	});
}

export function parseWorktreePorcelain(text: string): WorktreePorcelainRecord[] {
	const records: WorktreePorcelainRecord[] = [];
	let current: WorktreePorcelainRecord | undefined;
	for (const line of text.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = { path: line.slice("worktree ".length) };
			records.push(current);
		} else if (current && line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length);
		} else if (current && line === "detached") {
			current.detached = true;
		}
	}
	return records;
}

export function worktreeExtensionName(path: string, worktreeRoot: string): string | undefined {
	const parts = relative(worktreeRoot, path).split(sep);
	if (parts.length === 4 && parts[1] === "extensions" && parts[0] === parts[2] && parts[3] === "index.ts") {
		return parts[0];
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function packageSource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (isRecord(entry) && typeof entry.source === "string") return entry.source;
	return undefined;
}

function resolveLocalSource(source: string | undefined, settingsDir: string): string | undefined {
	if (!source || /^(?:npm:|git:|https?:|ssh:|git@)/.test(source)) return undefined;
	return resolve(settingsDir, source);
}

function settingsSource(path: string, settingsDir: string): string {
	const value = relative(settingsDir, path).split(sep).join("/");
	return value.startsWith(".") ? value : `./${value}`;
}

function activePackageNames(
	packages: readonly unknown[],
	mainEntry: unknown,
	options: ReconcilePackageOptions,
): Set<string> {
	const { settingsDir, worktreeRoot, mainExtensionNames, entrypoints, forceActive = [], forceInactive = [] } = options;
	const active = new Set(forceActive);
	for (const entry of packages) {
		const source = packageSource(entry);
		const resolved = resolveLocalSource(source, settingsDir);
		const name = resolved ? worktreeExtensionName(resolved, worktreeRoot) : undefined;
		if (name) active.add(name);
	}

	const mainLoadsAll = typeof mainEntry === "string" || (isRecord(mainEntry) && mainEntry.extensions === undefined);
	if (mainLoadsAll) {
		for (const name of mainExtensionNames) active.add(name);
	}
	for (const name of forceInactive) active.delete(name);

	for (const name of active) {
		if (!entrypoints.has(name)) {
			throw new Error(`Active extension has no worktree entrypoint: ${name}`);
		}
	}

	return active;
}

function mainPackageWithoutExtensions(entry: unknown): Record<string, unknown> {
	if (typeof entry === "string") return { source: entry, extensions: [] };
	if (isRecord(entry)) return { ...entry, extensions: [] };
	throw new Error(`Invalid harness package entry: ${String(entry)}`);
}

export function reconcilePackageEntries(
	packages: readonly unknown[],
	options: ReconcilePackageOptions,
): { packages: unknown[]; activeNames: string[] } {
	const { settingsDir, repoRoot, worktreeRoot, entrypoints } = options;
	const mainIndex = packages.findIndex((entry) => resolveLocalSource(packageSource(entry), settingsDir) === repoRoot);
	if (mainIndex < 0) throw new Error(`Pi settings do not contain the harness package: ${repoRoot}`);
	const mainEntry = packages[mainIndex];
	const active = activePackageNames(packages, mainEntry, options);
	const normalizedMain = mainPackageWithoutExtensions(mainEntry);
	const managed = [...active].sort().map((name) => {
		const entrypoint = entrypoints.get(name);
		if (entrypoint === undefined) {
			throw new Error(`Active extension has no worktree entrypoint: ${name}`);
		}
		return settingsSource(entrypoint, settingsDir);
	});

	const next: unknown[] = [];
	for (let index = 0; index < packages.length; index += 1) {
		const entry = packages[index];
		if (index === mainIndex) {
			next.push(normalizedMain, ...managed);
			continue;
		}
		const source = packageSource(entry);
		const resolved = resolveLocalSource(source, settingsDir);
		if (resolved && worktreeExtensionName(resolved, worktreeRoot)) continue;
		next.push(entry);
	}

	return { packages: next, activeNames: [...active].sort() };
}

function ensureSliceWorktree(
	repoRoot: string,
	worktreeRoot: string,
	branch: string,
	byBranch: ReadonlyMap<string, string>,
	nameOwners: Map<string, string>,
): WorktreeRecord {
	const kind = sliceKindForBranch(branch);
	if (!kind) throw new Error(`branch has no recognized slice kind: ${branch}`);
	const name = branch.slice(kind.branchPrefix.length);
	if (!sliceNamePattern.test(name)) {
		throw new Error(`slice name must use lowercase letters, numbers, and hyphens: ${name}`);
	}
	const owner = nameOwners.get(name);
	if (owner !== undefined && owner !== branch) {
		throw new Error(`worktree name collision across kinds: ${name} (${owner} and ${branch})`);
	}
	nameOwners.set(name, branch);
	let path = byBranch.get(`refs/heads/${branch}`);
	if (!path) {
		path = join(worktreeRoot, name);
		if (existsSync(path) && readdirSync(path).length > 0) {
			throw new Error(`expected worktree path is not empty: ${path}`);
		}
		git(repoRoot, ["-c", "core.hooksPath=/dev/null", "worktree", "add", path, branch], { inherit: true });
	}
	return {
		kind: kind.name,
		name,
		branch,
		path,
		entrypoint: kind.entrypoint(path, name),
		devRecordRoot: kind.devRecordRoot(name),
	};
}

function repositoryState(repoRoot: string, worktreeRoot: string): { records: WorktreeRecord[]; problems: string[] } {
	const problems: string[] = [];
	const branches: string[] = [];
	for (const kind of sliceKinds) {
		const refs = git(repoRoot, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${kind.branchPrefix}*`])
			.stdout.trim()
			.split("\n")
			.filter(Boolean);
		branches.push(...refs);
	}
	branches.sort();
	const worktrees = parseWorktreePorcelain(git(repoRoot, ["worktree", "list", "--porcelain"]).stdout);
	const byBranch = new Map<string, string>();
	for (const entry of worktrees) {
		if (entry.branch !== undefined) byBranch.set(entry.branch, entry.path);
	}
	const records: WorktreeRecord[] = [];
	const nameOwners = new Map<string, string>();

	mkdirSync(worktreeRoot, { recursive: true });
	for (const branch of branches) {
		try {
			records.push(ensureSliceWorktree(repoRoot, worktreeRoot, branch, byBranch, nameOwners));
		} catch (error) {
			const message = error instanceof Error ? error.message : undefined;
			problems.push(`${branch}: ${message}`);
		}
	}
	return { records, problems };
}

function mainExtensionNames(repoRoot: string): string[] {
	const root = join(repoRoot, "extensions");
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "index.ts")))
		.map((entry) => entry.name)
		.sort();
}

function readSettings(settingsPath: string): Settings {
	return JSON.parse(readFileSync(settingsPath, "utf8"));
}

function writeSettings(settingsPath: string, settings: Settings): boolean {
	const content = `${JSON.stringify(settings, null, 2)}\n`;
	if (readFileSync(settingsPath, "utf8") === content) return false;
	const temporary = `${settingsPath}.worktrees-${process.pid}`;
	const mode = statSync(settingsPath).mode;
	writeFileSync(temporary, content, { mode });
	renameSync(temporary, settingsPath);
	return true;
}

function reconcileSettings(
	context: HarnessContext,
	records: readonly WorktreeRecord[],
	options: ReconcileSettingsOptions = {},
): { changed: boolean; activeNames: string[] } {
	const settings = readSettings(context.settingsPath);
	const entrypoints = new Map(
		records
			.filter(
				(record): record is WorktreeRecord & { entrypoint: string } =>
					record.kind === "extension" && record.entrypoint !== null && existsSync(record.entrypoint),
			)
			.map((record) => [record.name, record.entrypoint]),
	);
	const result = reconcilePackageEntries(settings.packages ?? [], {
		settingsDir: dirname(context.settingsPath),
		repoRoot: context.repoRoot,
		worktreeRoot: context.worktreeRoot,
		mainExtensionNames: mainExtensionNames(context.repoRoot),
		entrypoints,
		forceActive: options.forceActive,
		forceInactive: options.forceInactive,
	});
	settings.packages = result.packages;
	return { changed: writeSettings(context.settingsPath, settings), activeNames: result.activeNames };
}

function branchHasBase(repoRoot: string, branch: string): boolean {
	return (
		git(repoRoot, ["merge-base", "--is-ancestor", "main", branch], {
			accept: [0, 1],
		}).status === 0
	);
}

function branchHasCommonHistory(repoRoot: string, branch: string): boolean {
	return git(repoRoot, ["merge-base", "main", branch], { accept: [0, 1] }).status === 0;
}

function isDirty(path: string): boolean {
	return git(path, ["status", "--porcelain"], { cwd: path }).stdout.trim().length > 0;
}

function hasTrackedChanges(path: string): boolean {
	return git(path, ["status", "--porcelain", "--untracked-files=no"], { cwd: path }).stdout.trim().length > 0;
}

interface SyncOutcome {
	changed: boolean;
	deferred?: true;
	failure?: string;
}

interface SyncResult {
	changed: string[];
	deferred: string[];
	failures: string[];
}

/**
 * A worktree holding uncommitted tracked changes while main has advanced is deferred: its branch
 * stays at its commit. Deferral preserves the owner's changes and is not a sync failure.
 */
function syncBranch(context: HarnessContext, record: WorktreeRecord): SyncOutcome {
	let changed = false;
	let rebasing = false;
	try {
		if (!branchHasCommonHistory(context.repoRoot, record.branch)) {
			throw new Error("branch has no common base with main");
		}
		if (!branchHasBase(context.repoRoot, record.branch)) {
			if (hasTrackedChanges(record.path)) return { changed, deferred: true };
			rebasing = true;
			git(context.repoRoot, noHooks(["rebase", "main"]), { cwd: record.path });
			rebasing = false;
			changed = true;
		}
		if (record.entrypoint !== null && !existsSync(record.entrypoint)) {
			throw new Error(`entrypoint is absent: ${record.entrypoint}`);
		}
		return { changed };
	} catch (error) {
		if (rebasing) {
			git(context.repoRoot, noHooks(["rebase", "--abort"]), { cwd: record.path, accept: [0, 1, 128] });
		}
		const message = error instanceof Error ? error.message : undefined;
		return { changed, failure: `${record.name}: ${message}` };
	}
}

function syncBranches(context: HarnessContext, records: readonly WorktreeRecord[]): SyncResult {
	const changed: string[] = [];
	const deferred: string[] = [];
	const failures: string[] = [];
	for (const record of records) {
		const result = syncBranch(context, record);
		if (result.changed) changed.push(record.name);
		if (result.deferred) deferred.push(record.name);
		if (result.failure !== undefined) failures.push(result.failure);
	}
	return { changed, deferred, failures };
}

function devRecordPathsAt(repoRoot: string, ref: string, devRecordRoot: string | null): string[] {
	if (devRecordRoot === null) return [];
	return git(repoRoot, ["ls-tree", "-r", "--name-only", "-z", ref])
		.stdout.split("\0")
		.filter((path) => path !== "" && isDevRecordPath(path, devRecordRoot));
}

function rebuildPromotedBranch(context: HarnessContext, record: WorktreeRecord, originalHead: string): void {
	const originalPaths = devRecordPathsAt(context.repoRoot, originalHead, record.devRecordRoot);
	const mainPaths = devRecordPathsAt(context.repoRoot, "main", record.devRecordRoot);
	const allPaths = [...new Set([...originalPaths, ...mainPaths])].sort();
	const originalSet = new Set(originalPaths);

	git(context.repoRoot, noHooks(["reset", "--hard", "main"]), { cwd: record.path });
	if (originalPaths.length > 0) {
		git(context.repoRoot, noHooks(["checkout", originalHead, "--", ...originalPaths]), {
			cwd: record.path,
		});
	}
	const removed = mainPaths.filter((path) => !originalSet.has(path));
	if (removed.length > 0) {
		git(context.repoRoot, ["rm", "-f", "--quiet", "--", ...removed], {
			cwd: record.path,
			accept: [0, 1, 128],
		});
	}
	if (allPaths.length === 0) return;
	const staged = git(context.repoRoot, ["diff", "--cached", "--quiet"], {
		cwd: record.path,
		accept: [0, 1],
	});
	if (staged.status === 0) return;
	git(context.repoRoot, noHooks(["commit", "-m", `docs(${record.name}): retain development records`]), {
		cwd: record.path,
	});
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Resolve the main checkout that owns a linked worktree. */
export function mainCheckoutRoot(candidateRoot: string): string {
	try {
		const common = git(candidateRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			accept: [0, 1, 128],
		});
		if (common.status !== 0) return candidateRoot;
		const commonDir = resolve(candidateRoot, common.stdout.trim());
		return basename(commonDir) === ".git" ? dirname(commonDir) : candidateRoot;
	} catch {
		return candidateRoot;
	}
}

export function promoteNameFromCwd(cwd: string, worktreeRoot: string): string | undefined {
	const parts = relative(worktreeRoot, cwd).split(sep);
	if (parts.length === 0 || parts[0] === "" || parts[0] === ".." || isAbsolute(parts[0])) {
		return undefined;
	}
	return parts[0];
}

export function parsePromoteArguments(args: readonly string[]): {
	names: string[];
	options: PromoteOptions;
} {
	const options: PromoteOptions = { push: true, gates: true, json: false, dryRun: false };
	const flags = new Map<string, PromoteOptionName>([
		["--no-push", "push"],
		["--no-gates", "gates"],
		["--json", "json"],
		["--dry-run", "dryRun"],
	]);
	const seen = new Set<string>();
	const names: string[] = [];
	for (const arg of args) {
		if (arg.startsWith("--")) {
			const key = flags.get(arg);
			if (!key) throw new Error(`Unknown promote flag: ${arg}`);
			if (seen.has(arg)) throw new Error(`Repeated promote flag: ${arg}`);
			seen.add(arg);
			options[key] = !(arg === "--no-push" || arg === "--no-gates");
			continue;
		}
		names.push(arg);
	}
	return { names, options };
}

function noHooks(args: readonly string[]): string[] {
	return ["-c", "core.hooksPath=/dev/null", ...args];
}

function commitFiles(repoRoot: string, sha: string): string[] {
	return git(repoRoot, ["show", "--pretty=format:", "--name-only", "--no-renames", sha])
		.stdout.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function runLoadGate(repoRoot: string, entrypoint: string): { status: "pass" } | { status: "fail"; detail: string } {
	const checker = join(dirname(scriptPath), "extension-load-check.mts");
	const result = run(process.execPath, [checker, entrypoint], {
		cwd: repoRoot,
		accept: [0, 1],
	});
	if (result.status === 0) return { status: "pass" };
	return { status: "fail", detail: (result.stderr || result.stdout).trim() };
}

function promoteGates(context: HarnessContext): { results: GateResults; failure?: { gate: string; detail: string } } {
	const override = process.env.PI_PROMOTE_GATES;
	const commands: GateCommand[] = override
		? JSON.parse(override)
		: [
				{ name: "test", command: ["npm", "test"] },
				{ name: "typecheck", command: ["npm", "run", "typecheck"] },
				{ name: "check", command: ["npm", "run", "check"] },
				{ name: "lint", command: ["npm", "run", "lint"] },
			];
	const results: GateResults = {};
	for (const entry of commands) {
		const [command, ...args] = entry.command;
		const outcome = run(command, args, { cwd: context.repoRoot, accept: [0, 1, 2] });
		results[entry.name] = outcome.status === 0 ? "pass" : "fail";
		if (outcome.status !== 0) {
			return { results, failure: { gate: entry.name, detail: (outcome.stdout + outcome.stderr).trim().slice(-2000) } };
		}
	}
	return { results };
}

function promoteResourceGate(
	context: HarnessContext,
	record: WorktreeRecord,
): { results: GateResults; failure?: { gate: string; detail: string } } {
	const results: GateResults = {};
	if (record.kind === "extension") {
		const entrypoint = join(context.repoRoot, "extensions", record.name, "index.ts");
		const load = runLoadGate(context.repoRoot, entrypoint);
		results.load = load.status;
		if (load.status === "fail") {
			return { results, failure: { gate: "load", detail: load.detail } };
		}
	} else if (record.kind === "skill") {
		const validator = join(dirname(scriptPath), "..", "skills", "harness", "scripts", "validate-skill.mts");
		const outcome = run(process.execPath, [validator, join(context.repoRoot, "skills", record.name)], {
			cwd: context.repoRoot,
			accept: [0, 1],
		});
		results.skill = outcome.status === 0 ? "pass" : "fail";
		if (outcome.status !== 0) {
			return { results, failure: { gate: "skill", detail: (outcome.stderr || outcome.stdout).trim().slice(-2000) } };
		}
	}
	return { results };
}

function remoteMainState(context: HarnessContext): {
	present: boolean;
	behindRemote?: boolean;
	ahead?: boolean;
} {
	const remotes = git(context.repoRoot, ["remote"]).stdout.trim().split("\n").filter(Boolean);
	if (!remotes.includes("origin")) return { present: false };
	git(context.repoRoot, ["fetch", "origin", "main"], { accept: [0, 1, 128] });
	const exists =
		git(context.repoRoot, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], {
			accept: [0, 1],
		}).status === 0;
	if (!exists) return { present: false };
	const behindRemote =
		git(context.repoRoot, ["merge-base", "--is-ancestor", "origin/main", "main"], {
			accept: [0, 1],
		}).status !== 0;
	const ahead = git(context.repoRoot, ["rev-list", "--count", "origin/main..main"]).stdout.trim() !== "0";
	return { present: true, behindRemote, ahead };
}

function resolveSliceBranch(repoRoot: string, name: string): string | undefined {
	const matches: string[] = [];
	for (const kind of sliceKinds) {
		const branch = `${kind.branchPrefix}${name}`;
		if (branchExists(repoRoot, branch)) matches.push(branch);
	}
	if (matches.length === 0) return undefined;
	if (matches.length > 1) {
		throw new Error(`Slice name is ambiguous across kinds: ${name} (${matches.join(", ")})`);
	}
	return matches[0];
}

type ReplayCommit = ReturnType<typeof classifyCommitFiles> & { sha: string; full: string; subject: string };

interface PreparedPromotion {
	name: string;
	branch: string;
	kind: SliceKind;
	devRecordRoot: string | null;
	shipping: ReplayCommit[];
	held: ReplayCommit[];
	mainBefore: string;
}

function requestedPromotionBranch(
	repoRoot: string,
	requested: ReturnType<typeof parseSliceReference>,
): string | undefined {
	if (!requested.kind) return resolveSliceBranch(repoRoot, requested.name);
	const candidate = `${sliceKindForName(requested.kind).branchPrefix}${requested.name}`;
	return branchExists(repoRoot, candidate) ? candidate : undefined;
}

function pausedGitOperation(path: string): string | undefined {
	for (const name of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"]) {
		const location = git(path, ["rev-parse", "--path-format=absolute", "--git-path", name]).stdout.trim();
		if (existsSync(location)) return `unfinished Git operation in ${path}: ${name}`;
	}
	return undefined;
}

function promotionReadiness(context: HarnessContext, branch: string): string | undefined {
	const head = git(context.repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
		accept: [0, 1],
	}).stdout.trim();
	if (head !== "main") {
		return `main must be checked out at ${context.repoRoot} (found: ${head || "detached"})`;
	}
	const paused = pausedGitOperation(context.repoRoot);
	if (paused) return paused;
	if (hasTrackedChanges(context.repoRoot)) return `uncommitted tracked changes in ${context.repoRoot}`;
	if (!branchHasCommonHistory(context.repoRoot, branch)) return `${branch} shares no history with main`;
	return undefined;
}

function failedPromotion(
	name: string | undefined,
	stage: string,
	reason: string,
	extra: Partial<PromotionReport> = {},
): PromotionReport {
	return { ok: false, name, stage, reason, promoted: [], held: [], recover: null, ...extra };
}

function preparePromotion(
	context: HarnessContext,
	requestedReference: string | undefined,
): PreparedPromotion | PromotionReport {
	const reference =
		requestedReference ?? promoteNameFromCwd(canonicalPath(process.cwd()), canonicalPath(context.worktreeRoot));
	let name = reference;
	const fail = (reason: string) => failedPromotion(name, "preflight", reason);

	if (!reference) {
		return fail("no slice name given and the working directory is not a worktree");
	}
	let requested: { kind?: SliceKindName; name: string };
	try {
		requested = parseSliceReference(reference);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	name = requested.name;
	let branch: string | undefined;
	try {
		branch = requestedPromotionBranch(context.repoRoot, requested);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	if (!branch) return fail(`branch does not exist: ${reference}`);
	const kind = sliceKindForBranch(branch);
	if (!kind) return fail(`branch has no recognized slice kind: ${branch}`);
	const problem = promotionReadiness(context, branch);
	if (problem) return fail(problem);

	const merges = git(context.repoRoot, ["rev-list", "--merges", `main..${branch}`]).stdout.trim();
	if (merges) return fail(`${branch} contains merge commits; promote cannot replay them`);

	const devRecordRoot = kind.devRecordRoot(name);
	const plan = promotionCommits(context.repoRoot, branch, [devRecordRoot]);
	const shipping = plan.filter((entry) => entry.kind !== "held");
	const held = plan.filter((entry) => entry.kind === "held");
	const mainBefore = git(context.repoRoot, ["rev-parse", "main"]).stdout.trim();
	return { name, branch, kind, shipping, held, mainBefore, devRecordRoot };
}

function promotionCommits(repoRoot: string, branch: string, roots: Array<string | null>): ReplayCommit[] {
	const shas = git(repoRoot, ["rev-list", "--reverse", "--topo-order", `main..${branch}`])
		.stdout.trim()
		.split("\n")
		.filter(Boolean);
	return shas.map((sha) => {
		const files = commitFiles(repoRoot, sha);
		const devRecords = files.filter((path) => roots.some((root) => isDevRecordPath(path, root)));
		const shipped = files.filter((path) => !devRecords.includes(path));
		const kind = shipped.length === 0 ? "held" : devRecords.length === 0 ? "ship" : "filter";
		return {
			sha: sha.slice(0, 7),
			full: sha,
			subject: git(repoRoot, ["log", "-1", "--format=%s", sha]).stdout.trim(),
			kind,
			devRecords,
			shipped,
		};
	});
}

function replayPromotionCommit(repoRoot: string, entry: ReplayCommit): { committed: boolean; reason?: string } {
	const pick = git(repoRoot, noHooks(["cherry-pick", "-n", entry.full]), { accept: [0, 1, 128] });
	if (pick.status !== 0) {
		const unmerged = git(repoRoot, ["diff", "--name-only", "--diff-filter=U", "-z"]).stdout.split("\0").filter(Boolean);
		const developmentRecords = new Set(entry.devRecords);
		if (unmerged.length === 0 || unmerged.some((path) => !developmentRecords.has(path))) {
			return { committed: false, reason: `${entry.sha} (${entry.subject}): ${(pick.stderr || pick.stdout).trim()}` };
		}
	}
	for (const path of entry.devRecords) {
		const inHead = git(repoRoot, ["cat-file", "-e", `HEAD:${path}`], { accept: [0, 1, 128] }).status === 0;
		if (inHead) git(repoRoot, noHooks(["checkout", "HEAD", "--", path]));
		else git(repoRoot, ["rm", "-f", "--quiet", "--", path], { accept: [0, 1, 128] });
	}
	const unresolved = git(repoRoot, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim();
	if (unresolved)
		return { committed: false, reason: `${entry.sha} left unresolved development records: ${unresolved}` };
	const staged = git(repoRoot, ["diff", "--cached", "--quiet"], { accept: [0, 1] });
	if (staged.status === 0) {
		git(repoRoot, ["cherry-pick", "--quit"], { accept: [0, 1, 128] });
		return { committed: false };
	}
	const commit = git(repoRoot, noHooks(["commit", "--no-verify", "-C", entry.full]), { accept: [0, 1] });
	if (commit.status !== 0)
		return { committed: false, reason: `${entry.sha}: ${(commit.stderr || commit.stdout).trim()}` };
	return { committed: true };
}

function replayPromotion(repoRoot: string, shipping: ReplayCommit[]): { promoted: string[]; reason?: string } {
	const promoted: string[] = [];
	for (const entry of shipping) {
		const result = replayPromotionCommit(repoRoot, entry);
		if (result.reason !== undefined) return { promoted, reason: result.reason };
		if (result.committed) promoted.push(entry.sha);
	}
	return { promoted };
}

function completePromotion(
	context: HarnessContext,
	report: PromotionReport,
	options: PromoteOptions,
	remote: ReturnType<typeof remoteMainState>,
): PromotionReport {
	const completed = { ...report, mainAfter: git(context.repoRoot, ["rev-parse", "main"]).stdout.trim(), pushed: false };
	if (options.push && remote.present) {
		const push = git(context.repoRoot, noHooks(["push", "origin", "main"]), { accept: [0, 1, 128] });
		if (push.status !== 0) {
			return {
				...completed,
				ok: false,
				stage: "push",
				reason: (push.stderr || push.stdout).trim(),
				recover: `Inspect git -C ${context.repoRoot} diff origin/main..${completed.mainAfter}; then git -C ${context.repoRoot} push origin main && npm run worktrees:sync`,
			};
		}
		completed.pushed = true;
	}
	try {
		const { records, problems } = repositoryState(context.repoRoot, context.worktreeRoot);
		const branchResult = syncBranches(context, records);
		branchResult.failures.unshift(...problems);
		reconcileSettings(context, records);
		return {
			...completed,
			syncOk: branchResult.failures.length === 0,
			branchFailures: branchResult.failures,
			deferred: branchResult.deferred,
		};
	} catch (error) {
		return { ...completed, syncOk: false, branchFailures: [error instanceof Error ? error.message : String(error)] };
	}
}

function promotionBoundary(repoRoot: string, branch: string, roots: Array<string | null>): string[] {
	return git(repoRoot, ["diff", "--name-only", "--no-renames", "-z", "main", branch])
		.stdout.split("\0")
		.filter((path) => path !== "" && !roots.some((root) => isDevRecordPath(path, root)));
}

interface PromotionSelection {
	prepared: PreparedPromotion;
	record: WorktreeRecord;
	before: string;
}

function preparePromotions(
	context: HarnessContext,
	requestedReferences: string[],
): PromotionSelection[] | PromotionReport {
	const prepared: PreparedPromotion[] = [];
	for (const reference of requestedReferences.length > 0 ? requestedReferences : [undefined]) {
		const selection = preparePromotion(context, reference);
		if ("ok" in selection) return selection;
		if (prepared.some((entry) => entry.branch === selection.branch)) {
			return failedPromotion(selection.name, "preflight", `duplicate slice selection: ${selection.branch}`);
		}
		prepared.push(selection);
	}
	const roots = prepared.map((entry) => entry.devRecordRoot);
	const worktrees = parseWorktreePorcelain(git(context.repoRoot, ["worktree", "list", "--porcelain"]).stdout);
	const selected: PromotionSelection[] = [];
	for (const entry of prepared) {
		const worktree = worktrees.find((candidate) => candidate.branch === `refs/heads/${entry.branch}`);
		if (!worktree) return failedPromotion(entry.name, "preflight", `worktree does not exist for ${entry.branch}`);
		const paused = pausedGitOperation(worktree.path);
		if (paused) return failedPromotion(entry.name, "preflight", paused);
		if (isDirty(worktree.path)) {
			return failedPromotion(
				entry.name,
				"preflight",
				`uncommitted tracked changes or untracked files in ${worktree.path}`,
			);
		}
		const record: WorktreeRecord = {
			name: entry.name,
			kind: entry.kind.name,
			branch: entry.branch,
			path: worktree.path,
			entrypoint: entry.kind.entrypoint(worktree.path, entry.name),
			devRecordRoot: entry.devRecordRoot,
		};
		const plan = promotionCommits(context.repoRoot, entry.branch, roots);
		entry.shipping = plan.filter((commit) => commit.kind !== "held");
		entry.held = plan.filter((commit) => commit.kind === "held");
		selected.push({
			prepared: entry,
			record,
			before: git(context.repoRoot, ["rev-parse", entry.branch]).stdout.trim(),
		});
	}
	return selected;
}

function promote(context: HarnessContext, requestedReferences: string[], options: PromoteOptions): PromotionReport {
	const selected = preparePromotions(context, requestedReferences);
	if (!Array.isArray(selected)) return selected;
	const prepared = selected.map((selection) => selection.prepared);
	const { mainBefore } = prepared[0];
	const slices: SlicePromotionReport[] = prepared.map((entry) => ({
		name: entry.name,
		kind: entry.kind.name,
		branch: entry.branch,
		promoted: [],
		held: entry.held.map((commit) => (options.dryRun ? { sha: commit.sha, subject: commit.subject } : commit.sha)),
		gates: {},
		...(options.dryRun
			? {
					wouldPromote: entry.shipping.map((commit) => ({
						sha: commit.sha,
						subject: commit.subject,
						ships: commit.shipped,
						dropped: commit.devRecords,
					})),
				}
			: {}),
	}));
	const report: PromotionReport = {
		ok: true,
		slices,
		...(slices.length === 1 ? { name: slices[0].name, kind: slices[0].kind } : {}),
		promoted: [],
		held: slices.flatMap((slice) => slice.held),
		gates: {},
		mainBefore,
		mainAfter: mainBefore,
		pushed: false,
	};
	const remote = remoteMainState(context);
	if (remote.present && remote.behindRemote) {
		return {
			...report,
			ok: false,
			stage: "preflight",
			reason: "origin/main has commits that main does not; sync before promoting",
			recover: null,
		};
	}
	if (options.push && remote.present && remote.ahead) {
		return {
			...report,
			ok: false,
			stage: "preflight",
			reason: "main has unpublished commits; inspect and publish them separately before promotion",
			recover: null,
		};
	}
	if (options.dryRun) {
		return {
			...report,
			dryRun: true,
			wouldPromote: slices.flatMap((slice) => slice.wouldPromote ?? []),
			wouldRunGates: options.gates,
			wouldPush: options.push,
		};
	}
	if (prepared.every((entry) => entry.shipping.length === 0)) return report;

	const result = applyPromotions(context, selected, report, options);
	if (!result.ok) return result;
	return completePromotion(context, result, options, remote);
}

function restorePromotionBranch(selection: PromotionSelection, rebasing: boolean): string | undefined {
	const { path, branch } = selection.record;
	let abort = rebasing;
	try {
		abort = rebasing && Boolean(pausedGitOperation(path)?.includes("rebase-"));
		if (abort) git(path, noHooks(["rebase", "--abort"]));
		git(path, noHooks(["reset", "--hard", selection.before]));
		if (
			pausedGitOperation(path) ||
			git(path, ["symbolic-ref", "--short", "HEAD"]).stdout.trim() !== branch ||
			git(path, ["rev-parse", branch]).stdout.trim() !== selection.before
		)
			throw new Error("incomplete rollback");
		return undefined;
	} catch {
		return `${abort ? `git -C ${path} rebase --abort && ` : ""}git -C ${path} switch ${branch} && git -C ${path} reset --hard ${selection.before}`;
	}
}

function assertPromotionBoundary(context: HarnessContext, branch: string, roots: Array<string | null>): void {
	const leaked = promotionBoundary(context.repoRoot, branch, roots);
	if (leaked.length) throw new Error(`${branch} still differs from main outside dev records: ${leaked.join(", ")}`);
}

function promotionResourceGates(
	context: HarnessContext,
	selected: PromotionSelection[],
	slices: SlicePromotionReport[],
	gates: GateResults,
): { branch: string; reason: string } | undefined {
	for (const [index, selection] of selected.entries()) {
		const resource = promoteResourceGate(context, selection.record);
		slices[index].gates = resource.results;
		if (slices.length === 1) Object.assign(gates, resource.results);
		if (resource.failure)
			return { branch: selection.record.branch, reason: `${resource.failure.gate} failed: ${resource.failure.detail}` };
	}
	return undefined;
}

function applyPromotions(
	context: HarnessContext,
	selected: PromotionSelection[],
	report: PromotionReport,
	options: PromoteOptions,
): PromotionReport {
	const mainBefore = selected[0].prepared.mainBefore;
	const roots = selected.map((selection) => selection.prepared.devRecordRoot);
	const slices = report.slices ?? [];
	const changed = new Set<PromotionSelection>();
	let stage = "cherry-pick";
	let failedSlice: string | undefined;
	let rebasing: PromotionSelection | undefined;
	const abandon = (reason: string): PromotionReport => {
		const recovery: string[] = [];
		for (const selection of changed) {
			const instruction = restorePromotionBranch(selection, rebasing === selection);
			if (instruction) recovery.push(instruction);
		}
		try {
			git(context.repoRoot, noHooks(["cherry-pick", "--quit"]));
			git(context.repoRoot, noHooks(["reset", "--hard", mainBefore]));
			if (
				pausedGitOperation(context.repoRoot) ||
				git(context.repoRoot, ["rev-parse", "main"]).stdout.trim() !== mainBefore
			) {
				throw new Error("incomplete rollback");
			}
		} catch {
			recovery.push(
				`git -C ${context.repoRoot} cherry-pick --quit && git -C ${context.repoRoot} reset --hard ${mainBefore}`,
			);
		}
		return {
			...report,
			ok: false,
			stage,
			reason,
			failedSlice,
			promoted: [],
			slices: slices.map((slice) => ({ ...slice, promoted: [] })),
			mainAfter: git(context.repoRoot, ["rev-parse", "main"]).stdout.trim(),
			recover: recovery.length ? recovery.join(" && ") : null,
		};
	};
	try {
		for (const [index, selection] of selected.entries()) {
			const { record, prepared: entry } = selection;
			failedSlice = entry.branch;
			if (index > 0) {
				stage = "rebase";
				changed.add(selection);
				rebasing = selection;
				git(context.repoRoot, noHooks(["rebase", "main"]), { cwd: record.path });
				rebasing = undefined;
			}
			stage = "cherry-pick";
			const shipping = promotionCommits(context.repoRoot, entry.branch, roots).filter(
				(commit) => commit.kind !== "held",
			);
			const replay = replayPromotion(context.repoRoot, shipping);
			if (replay.reason !== undefined) return abandon(replay.reason);
			slices[index].promoted = replay.promoted;
			stage = "verify";
			assertPromotionBoundary(context, entry.branch, roots);
		}
		failedSlice = undefined;
		stage = "gates";
		if (options.gates) {
			const outcome = promoteGates(context);
			report.gates = outcome.results;
			if (outcome.failure) return abandon(`${outcome.failure.gate} failed: ${outcome.failure.detail}`);
			const failure = promotionResourceGates(context, selected, slices, outcome.results);
			if (failure) {
				failedSlice = failure.branch;
				return abandon(failure.reason);
			}
		}
		for (const selection of selected) {
			failedSlice = selection.record.branch;
			stage = "sync";
			changed.add(selection);
			rebuildPromotedBranch(context, selection.record, selection.before);
			stage = "verify";
			assertPromotionBoundary(context, selection.record.branch, [selection.record.devRecordRoot]);
		}
	} catch (error) {
		return abandon(error instanceof Error ? error.message : String(error));
	}
	return { ...report, promoted: slices.flatMap((slice) => slice.promoted) };
}

function printPromotionPlan(report: PromotionReport): void {
	if (report.slices && report.slices.length > 1) {
		for (const slice of report.slices) printPromotionPlan({ ...report, ...slice, slices: undefined });
		return;
	}
	console.log(`promote ${report.name} (dry run)`);
	const wouldPromote = report.wouldPromote ?? [];
	for (const entry of wouldPromote) {
		const dropped = entry.dropped.length > 0 ? ` (dropping ${entry.dropped.join(", ")})` : "";
		console.log(`  ship ${entry.sha} ${entry.subject}${dropped}`);
	}
	for (const entry of report.held ?? []) {
		if (typeof entry !== "string") console.log(`  hold ${entry.sha} ${entry.subject}`);
	}
	if (wouldPromote.length === 0) console.log("  nothing to promote");
	console.log(`  gates: ${report.wouldRunGates ? "yes" : "no"}  push: ${report.wouldPush ? "yes" : "no"}`);
}

function printSliceOutcomes(slices: SlicePromotionReport[]): void {
	if (slices.length < 2) return;
	for (const slice of slices)
		console.log(
			`${slice.branch}: promoted ${slice.promoted.join(", ") || "none"}; held ${slice.held.join(", ") || "none"}`,
		);
}

function printPromotionOutcome(report: PromotionReport): void {
	const promoted = report.promoted ?? [];
	const held = report.held ?? [];
	printSliceOutcomes(report.slices ?? []);
	if (promoted.length === 0)
		console.log(`Nothing to promote from ${report.slices?.map((slice) => slice.branch).join(", ") ?? report.name}`);
	else console.log(`Promoted to main: ${promoted.join(", ")}`);
	if (held.length > 0) console.log(`Held on the branch: ${held.join(", ")}`);
	if (report.mainAfter && report.mainBefore && report.mainAfter !== report.mainBefore) {
		console.log(`main ${report.mainBefore.slice(0, 7)} -> ${report.mainAfter.slice(0, 7)}`);
	}
	console.log(`Pushed: ${report.pushed ? "yes" : "no"}`);
	for (const failure of report.branchFailures ?? []) console.error(failure);
	if (report.syncOk === false) {
		console.error("Promotion landed. A sibling worktree did not update. Resolve it, then run npm run worktrees:sync.");
	}
}

function reportPromotion(report: PromotionReport, json: boolean): number {
	const status = report.ok && report.syncOk !== false ? 0 : 1;
	if (json) {
		console.log(JSON.stringify(report, null, 2));
		return status;
	}
	if (report.dryRun) {
		printPromotionPlan(report);
		return 0;
	}
	if (!report.ok) {
		console.error(`promote ${report.failedSlice ?? report.name ?? ""} failed at ${report.stage}: ${report.reason}`);
		if (report.recover) console.error(`recover: ${report.recover}`);
		else console.error(`main is unchanged at ${report.mainAfter ?? report.mainBefore ?? "its original commit"}`);
		return 1;
	}
	printPromotionOutcome(report);
	return status;
}

function activeNamesFromSettings(context: HarnessContext): Set<string> {
	const settings = readSettings(context.settingsPath);
	const names = [];
	for (const entry of settings.packages ?? []) {
		const source = packageSource(entry);
		const resolved = resolveLocalSource(source, dirname(context.settingsPath));
		const name = resolved ? worktreeExtensionName(resolved, context.worktreeRoot) : undefined;
		if (name) names.push(name);
	}
	return new Set(names);
}

function showStatus(context: HarnessContext, records: readonly WorktreeRecord[], problems: readonly string[]): void {
	const active = activeNamesFromSettings(context);
	for (const record of records) {
		const base = branchHasBase(context.repoRoot, record.branch) ? "current" : "behind";
		const tree = isDirty(record.path) ? "dirty" : "clean";
		const load = record.kind === "extension" ? (active.has(record.name) ? "active" : "provisional") : "branch";
		console.log(`${record.kind}\t${record.name}\t${base}\t${tree}\t${load}\t${record.path}`);
	}
	for (const problem of problems) {
		console.error(`broken\t${problem}`);
	}
}

function installHooks(context: HarnessContext): void {
	const common = git(context.repoRoot, ["rev-parse", "--git-common-dir"]).stdout.trim();
	const commonDir = isAbsolute(common) ? common : resolve(context.repoRoot, common);
	const hooksDir = join(commonDir, "hooks");
	mkdirSync(hooksDir, { recursive: true });
	const events = ["post-checkout", "post-commit", "post-merge", "post-rewrite"];
	const content = hookContent();
	for (const event of events) {
		const path = join(hooksDir, event);
		if (existsSync(path)) {
			const current = readFileSync(path, "utf8");
			if (!hookIsManaged(current)) {
				throw new Error(`Refusing to replace an unmanaged hook: ${path}`);
			}
		}
		writeFileSync(path, content);
		chmodSync(path, 0o755);
	}
	console.log(`Installed worktree hooks in ${hooksDir}`);
}

function contextFromEnvironment(): HarnessContext {
	if (process.env.PI_EXTENSION_WORKTREE_ROOT !== undefined) {
		throw new Error("PI_EXTENSION_WORKTREE_ROOT is retired; use PI_WORKTREE_ROOT for the worktree root");
	}
	const repoRoot = process.env.PI_HARNESS_ROOT
		? resolve(process.env.PI_HARNESS_ROOT)
		: mainCheckoutRoot(defaultRepoRoot);
	const worktreeRoot = resolve(process.env.PI_WORKTREE_ROOT ?? `${repoRoot}.worktrees`);
	const agentDir = resolve(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	const settingsPath = resolve(process.env.PI_SETTINGS_PATH ?? join(agentDir, "settings.json"));
	return { repoRoot, worktreeRoot, settingsPath };
}

function addSlice(context: HarnessContext, reference: string | undefined): void {
	if (!reference) throw new Error("Slice reference is required: add <kind>/<name>");
	const requested = parseSliceReference(reference);
	if (!requested.kind) throw new Error(`Slice kind is required: add <kind>/${requested.name}`);
	const kind = sliceKindForName(requested.kind);
	const branch = `${kind.branchPrefix}${requested.name}`;
	if (!branchExists(context.repoRoot, branch)) git(context.repoRoot, ["branch", branch, "main"]);
	const state = repositoryState(context.repoRoot, context.worktreeRoot);
	const record = state.records.find((candidate) => candidate.branch === branch);
	if (record === undefined) {
		const problem = state.problems.find((entry) => entry.startsWith(`${branch}:`));
		throw new Error(problem ?? `Worktree was not created for slice: ${branch}`);
	}
	console.log(record.path);
}

class WorktreeBusyError extends Error {}

function withWorktreeLock(context: HarnessContext, operation: () => void): void {
	const commonDir = git(context.repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim();
	const lockPath = join(commonDir, "worktrees.lock");
	let descriptor: number;
	try {
		descriptor = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		if (isRecord(error) && error.code === "EEXIST") {
			throw new WorktreeBusyError(
				`Another worktree command holds ${lockPath}. Retry after it exits; inspect an interrupted owner before manual recovery.`,
			);
		}
		throw error;
	}
	try {
		writeFileSync(descriptor, `${process.pid}\n`);
		operation();
	} finally {
		closeSync(descriptor);
		unlinkSync(lockPath);
	}
}

function main(): void {
	const context = contextFromEnvironment();
	const args = process.argv.slice(2);
	try {
		withWorktreeLock(context, () => executeCommand(context, args));
	} catch (error) {
		if (!(error instanceof WorktreeBusyError)) throw error;
		const command = args.find((arg) => !arg.startsWith("--")) ?? "sync";
		if (command === "promote" && args.includes("--json")) {
			const parsed = parsePromoteArguments(args.slice(args.indexOf(command) + 1));
			process.exitCode = reportPromotion(
				{
					ok: false,
					name: parsed.names.join(", "),
					stage: "coordination",
					reason: error.message,
					recover: null,
				},
				true,
			);
		} else {
			const hook = command === "sync" && args.includes("--hook");
			console.error(hook ? `Worktree sync skipped: ${error.message}` : error.message);
			process.exitCode = hook ? 0 : 1;
		}
	}
}

function setExtensionActive(
	context: HarnessContext,
	records: WorktreeRecord[],
	command: "activate" | "deactivate",
	name: string | undefined,
): void {
	if (!name) throw new Error(`${command} requires a slice name`);
	const record = records.find((candidate) => candidate.name === name);
	if (!record) throw new Error(`No slice worktree is named ${name}`);
	if (record.kind !== "extension") {
		throw new Error(
			`${command} applies to extensions only; ${name} is a ${record.kind} slice that Pi loads from main after promotion`,
		);
	}
	reconcileSettings(context, records, {
		forceActive: command === "activate" ? [name] : [],
		forceInactive: command === "deactivate" ? [name] : [],
	});
	console.log(`${name} is ${command === "activate" ? "active" : "provisional"}`);
}

/** The worktree that contains the invocation directory, when the command runs inside one. */
function worktreeContaining(records: readonly WorktreeRecord[], cwd: string): WorktreeRecord | undefined {
	const target = canonicalPath(cwd);
	return records.find((record) => {
		if (!existsSync(record.path)) return false;
		const path = canonicalPath(record.path);
		return target === path || target.startsWith(`${path}${sep}`);
	});
}

function reportReconciliation(
	context: HarnessContext,
	branchResult: SyncResult,
	settingsResult: ReturnType<typeof reconcileSettings>,
	problems: string[],
	quiet: boolean,
	ownDeferred: string | undefined,
): void {
	if (!quiet && ownDeferred !== undefined) {
		console.log(`Deferred: ${ownDeferred} has uncommitted tracked changes and is behind main; commit them, then sync.`);
	}
	if (!quiet || branchResult.changed.length > 0 || settingsResult.changed || branchResult.failures.length > 0) {
		if (branchResult.changed.length > 0) {
			console.log(`Updated from main: ${branchResult.changed.join(", ")}`);
		}
		if (settingsResult.changed) {
			console.log(`Updated Pi settings: ${context.settingsPath}`);
		}
		console.log(`Active worktree extensions: ${settingsResult.activeNames.join(", ") || "none"}`);
	}
	const allFailures = [...branchResult.failures, ...problems];
	if (allFailures.length > 0) {
		for (const failure of allFailures) console.error(failure);
		process.exitCode = 1;
	}
}

function executeCommand(context: HarnessContext, args: string[]): void {
	const command = args.find((arg) => !arg.startsWith("--")) ?? "sync";
	const commandIndex = args.indexOf(command);
	const name = args.slice(commandIndex + 1).find((arg) => !arg.startsWith("--"));
	const quiet = args.includes("--hook");

	if (command === "add") {
		addSlice(context, name);
		return;
	}
	if (command === "install-hooks") {
		installHooks(context);
		return;
	}
	if (command === "promote") {
		const parsed = parsePromoteArguments(args.slice(commandIndex + 1));
		const report = promote(context, parsed.names, parsed.options);
		process.exitCode = reportPromotion(report, parsed.options.json);
		return;
	}

	const state = repositoryState(context.repoRoot, context.worktreeRoot);
	const records = state.records;
	const problems = state.problems;
	if (command === "status") {
		showStatus(context, records, problems);
		if (problems.length > 0) process.exitCode = 1;
		return;
	}
	if (command === "activate" || command === "deactivate") {
		setExtensionActive(context, records, command, name);
		return;
	}
	if (command !== "sync" && command !== "configure") {
		throw new Error(`Unknown command: ${command}`);
	}

	let branchResult: SyncResult = { changed: [], deferred: [], failures: [] };
	if (command === "sync") branchResult = syncBranches(context, records);
	const settingsResult = reconcileSettings(context, records);
	const own = worktreeContaining(records, process.cwd());
	const ownDeferred = own !== undefined && branchResult.deferred.includes(own.name) ? own.name : undefined;
	reportReconciliation(context, branchResult, settingsResult, problems, quiet, ownDeferred);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : undefined);
		process.exitCode = 1;
	}
}
