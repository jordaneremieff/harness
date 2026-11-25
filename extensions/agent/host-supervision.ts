/**
 * Supervision of Durable host processes from outside the host.
 *
 * A host keeps the code it loaded until it ends, so a defect that keeps a host alive cannot be repaired in that host.
 * The agent manager of an ordinary Pi process lists this user's durable-runner processes at start and at an interval,
 * and ends only a host that cannot do useful work:
 *
 * - its storage file or catalog record is gone: nothing that the host could still write can be found again;
 * - its runner file is gone and no child process of its work runs: its code can no longer load a module;
 * - for hosts of this agent directory, it has work that can run but shows no storage write, almost no CPU time and no
 *   child process other than its stdio MCP servers for the whole stuck window: the process exits, and Durable recovery
 *   resumes the retained work on a fresh host. A host that publishes its own activity account and holds only sleeping
 *   or waiting tasks is idle by design and stays;
 * - for hosts of this agent directory, it runs code other than the configured package and has been idle for the idle
 *   window: it gets SIGTERM, which takes the host's own graceful shutdown, once per storage and code directory.
 *
 * Before every signal the PID must still hold the same process: the same start time, user and command line as in the
 * listing. A stuck or idle host must also be the writer that its claim record names, started before the record was
 * written. SIGKILL follows SIGTERM only for an ended orphan or stuck host that still runs after the host's own
 * shutdown deadline and a margin. Any missing evidence keeps the process.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readClaimFile, validClaim } from "./claims.ts";
import { readHostActivity } from "./host-activity.ts";
import { SHUTDOWN_GRACE_MS } from "./host-process.ts";
import { type HostMetadata, hostPaths, parseHostMetadata } from "./host-protocol.ts";
import { tryNativeWriterLease } from "./native-lease.ts";
import { lstartSeconds } from "./process-start.ts";

/** One row of the process table. */
export interface ProcessRow {
	readonly pid: number;
	readonly ppid: number;
	readonly uid: number;
	/** Cumulative user and system CPU time. */
	readonly cpuMs: number;
	/** Start time in whole seconds since the epoch, as `ps` prints it. */
	readonly start: number;
	readonly command: string;
}

/** The process table of this machine, or a fixed table in tests. */
export interface ProcessSource {
	/** Every process; throws when the table cannot be read. */
	list(): Promise<ProcessRow[]>;
	/** The process that holds `pid` now, or undefined when none does. */
	row(pid: number): Promise<ProcessRow | undefined>;
}

export type SupervisionActKind = "ended" | "killed" | "handed-over" | "kept";

/** One act of the check, reported once. */
export interface SupervisionAct {
	readonly at: string;
	readonly pid: number;
	readonly storageId: string;
	readonly act: SupervisionActKind;
	readonly reason: string;
}

/** The result of one check. */
export interface SupervisionRun {
	readonly checkedAt: string;
	/** Durable host processes of this user that the check saw. */
	readonly hosts: number;
	readonly acts: readonly SupervisionAct[];
	/** Storages whose host ended, for the caller's recovery scan. */
	readonly ended: readonly string[];
	/** The check did not run: another check held the lock, or the table could not be read. */
	readonly skipped?: string;
}

export interface SupervisionOptions {
	/** The agent directory of the calling manager. */
	readonly agentDir: string;
	/** A host with pending work that stays still this long is ended; zero keeps such hosts. */
	readonly stuckMs: number;
	/** An idle host on other code is handed over after this long; zero hands over none. */
	readonly idleMs: number;
	readonly processes?: ProcessSource;
	readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
	readonly now?: () => number;
	readonly wait?: (ms: number) => Promise<void>;
	/** The time a host has after SIGTERM before SIGKILL. */
	readonly terminationGraceMs?: number;
	/** The youngest host that the orphan rules may end; a host starts before its storage and record exist. */
	readonly minimumAgeMs?: number;
	/** The configured package root that holds the current runner, or undefined when it is not known. */
	readonly activeRoot?: string;
	/** Hosts that the check may consider; tests limit it to the processes they started. */
	readonly scope?: (row: ProcessRow) => boolean;
	/** Notable keeps already reported, by process and reason; the caller keeps it across checks. */
	readonly reported?: Set<string>;
}

const RUNNER_SUFFIX = `${join("extensions", "agent", "durable-runner.ts")}`;
const PS_FIELDS = "pid=,ppid=,uid=,time=,lstart=,command=";
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s(.*)$/u;
/** A start time from `ps` has one-second resolution; the claim record time is exact. */
const START_TOLERANCE_MS = 2_000;
const DEFAULT_MINIMUM_AGE_MS = 120_000;
/** Beyond the host's own shutdown deadline, the time for its exit to reach the process table. */
const TERMINATION_MARGIN_MS = 5_000;
const POLL_MS = 500;
/** A still host uses at most this share of the elapsed time as CPU time, and always this much. */
const QUIET_CPU_SHARE = 0.01;
const QUIET_CPU_FLOOR_MS = 1_000;
const STATE_FORMAT = "pi.agent.host-supervision/1";
const HANDED_OVER_LIMIT = 256;
const STATE_BYTES = 256 * 1024;

/** CPU time printed by `ps`: `[[dd-]hh:]mm:ss[.ss]`. */
export function cpuMilliseconds(text: string): number | undefined {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(text.trim());
	if (match === null) return undefined;
	const [, days, hours, minutes, seconds] = match;
	return Math.round(
		((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000,
	);
}

/** One `ps -o pid=,ppid=,uid=,time=,lstart=,command=` line in the C locale and UTC. */
export function parseProcessLine(line: string): ProcessRow | undefined {
	const match = PS_LINE.exec(line);
	if (match === null) return undefined;
	const cpuMs = cpuMilliseconds(match[4]);
	const start = lstartSeconds(match[5]);
	if (cpuMs === undefined || start === undefined) return undefined;
	return {
		pid: Number(match[1]),
		ppid: Number(match[2]),
		uid: Number(match[3]),
		cpuMs,
		start,
		command: match[6].trim(),
	};
}

function runPs(args: readonly string[]): Promise<{ code: number; stdout: string }> {
	return new Promise((done, fail) => {
		execFile(
			"ps",
			[...args],
			{ timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TZ: "UTC0", LC_ALL: "C" } },
			(error, stdout) => {
				const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
				// `ps -p` exits 1 when no process holds the PID; any other failure is no evidence.
				if (error !== null && code !== 1) fail(error);
				else done({ code, stdout: String(stdout) });
			},
		);
	});
}

function parseTable(stdout: string): ProcessRow[] {
	return stdout
		.split("\n")
		.map(parseProcessLine)
		.filter((row): row is ProcessRow => row !== undefined);
}

/** The process table through `ps`, on macOS and Linux. */
export const localProcesses: ProcessSource = {
	async list() {
		const { code, stdout } = await runPs(["-axww", "-o", PS_FIELDS]);
		if (code !== 0) throw new Error(`ps exited with ${code}`);
		return parseTable(stdout);
	},
	async row(pid) {
		const { stdout } = await runPs(["-ww", "-o", PS_FIELDS, "-p", String(pid)]);
		return parseTable(stdout).find((row) => row.pid === pid);
	},
};

/** A host process: its runner file and validated metadata. Cold-stop runs and other commands give undefined. */
export function parseRunnerCommand(command: string): { runner: string; metadata: HostMetadata } | undefined {
	const at = command.indexOf(`/${RUNNER_SUFFIX} {`);
	if (at < 0) return undefined;
	const runnerStart = command.lastIndexOf(" ", at) + 1;
	const runner = command.slice(runnerStart, at + RUNNER_SUFFIX.length + 1);
	const json = command.slice(at + RUNNER_SUFFIX.length + 2);
	if (!isAbsolute(runner)) return undefined;
	try {
		return { runner, metadata: parseHostMetadata(JSON.parse(json)) };
	} catch {
		return undefined;
	}
}

function realOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function packageRootOf(runner: string): string {
	return resolve(dirname(runner), "..", "..");
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function expandHome(value: string): string {
	return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

/** A local settings source as a real path, or undefined for a remote source. */
function localSource(source: unknown, agentDir: string): string | undefined {
	if (typeof source !== "string" || /^(npm:|git:|https?:|builtin:)/u.test(source)) return undefined;
	return realOrResolved(source.startsWith("~/") ? expandHome(source) : resolve(agentDir, source));
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * The package root that Pi settings in `agentDir` configure for the agent extension: a local package entry, or an
 * extension entry of `extensions/agent/index.ts`, whose directory holds the runner. Undefined when none or several do.
 */
export function configuredAgentRoot(agentDir: string): string | undefined {
	const settings = readJson(join(agentDir, "settings.json"));
	if (settings === null || typeof settings !== "object") return undefined;
	const { packages, extensions } = settings as { packages?: unknown; extensions?: unknown };
	const candidates = [
		...list(packages).map((entry) =>
			localSource(
				typeof entry === "object" && entry !== null ? (entry as { source?: unknown }).source : entry,
				agentDir,
			),
		),
		...list(extensions)
			.map((entry) => localSource(entry, agentDir))
			.map((source) =>
				source?.endsWith(join("extensions", "agent", "index.ts")) ? resolve(dirname(source), "..", "..") : undefined,
			),
	];
	const roots = new Set(
		candidates.filter((root): root is string => root !== undefined && existsSync(join(root, RUNNER_SUFFIX))),
	);
	return roots.size === 1 ? [...roots][0] : undefined;
}

/** One configured stdio server as its command and arguments, or undefined for another kind of entry. */
function serverCommand(config: unknown): string[] | undefined {
	if (config === null || typeof config !== "object") return undefined;
	const { command, args } = config as { command?: unknown; args?: unknown };
	if (typeof command !== "string" || command === "") return undefined;
	return [
		expandHome(command),
		...list(args)
			.filter((arg): arg is string => typeof arg === "string")
			.map(expandHome),
	];
}

/** The stdio MCP server commands that a host of `metadata` may start, from the user and project configuration. */
function mcpCommands(metadata: HostMetadata): string[][] {
	return [join(metadata.agentDir, "mcp.json"), join(metadata.cwd, ".pi", "mcp.json")].flatMap((path) => {
		const servers = (readJson(path) as { mcpServers?: unknown } | undefined)?.mcpServers;
		if (servers === null || typeof servers !== "object") return [];
		return Object.values(servers as object)
			.map(serverCommand)
			.filter((command): command is string[] => command !== undefined);
	});
}

/**
 * Whether a direct child of a host is one of its stdio MCP servers or their guardian. A server started from a script
 * runs under its interpreter, so its command line ends with the configured arguments after the script path.
 */
function serviceChild(row: ProcessRow, servers: readonly string[][]): boolean {
	if (row.command.startsWith("/bin/sh -c ") && row.command.includes('kill -KILL -- "-$pid"')) return true;
	return servers.some(([command, ...args]) => {
		const full = [command, ...args].join(" ");
		if (row.command === full || row.command.endsWith(` ${full}`)) return true;
		return args.length > 0 && row.command.endsWith(` ${args.join(" ")}`) && row.command.includes(basename(command));
	});
}

interface HostFacts {
	readonly row: ProcessRow;
	readonly runner: string;
	readonly metadata: HostMetadata;
	/** Direct children that are neither MCP servers nor their guardian. */
	readonly workingChildren: readonly ProcessRow[];
	/** CPU time of the host and every descendant. */
	readonly treeCpuMs: number;
}

function hostFacts(row: ProcessRow, runner: string, metadata: HostMetadata, table: readonly ProcessRow[]): HostFacts {
	const children = new Map<number, ProcessRow[]>();
	for (const item of table) {
		const list = children.get(item.ppid);
		if (list === undefined) children.set(item.ppid, [item]);
		else list.push(item);
	}
	let treeCpuMs = row.cpuMs;
	const visit = (pid: number, depth: number) => {
		if (depth > 64) return;
		for (const child of children.get(pid) ?? []) {
			treeCpuMs += child.cpuMs;
			visit(child.pid, depth + 1);
		}
	};
	visit(row.pid, 0);
	const servers = mcpCommands(metadata);
	const workingChildren = (children.get(row.pid) ?? []).filter((child) => !serviceChild(child, servers));
	return { row, runner, metadata, workingChildren, treeCpuMs };
}

function lastWrite(storagePath: string): number | undefined {
	let latest: number | undefined;
	for (const path of [storagePath, `${storagePath}-wal`]) {
		try {
			const mtime = statSync(path).mtimeMs;
			latest = latest === undefined ? mtime : Math.max(latest, mtime);
		} catch {
			/* A storage without a WAL file has only its main file. */
		}
	}
	return latest;
}

function catalogRecordPath(metadata: HostMetadata): string {
	return join(dirname(metadata.storagePath), `${metadata.storageId}.json`);
}

/** The catalog record's recovery marker, or undefined when the record cannot be read. */
function recoveryDue(metadata: HostMetadata): boolean | undefined {
	try {
		const record = JSON.parse(readFileSync(catalogRecordPath(metadata), "utf8")) as { recoveryDue?: unknown };
		return record.recoveryDue === true;
	} catch {
		return undefined;
	}
}

/** Whether the claim record names this process as the current writer, written after the process started. */
function claimNames(facts: HostFacts): boolean {
	try {
		const { claim } = readClaimFile(hostPaths(facts.metadata).claim);
		if (!validClaim(claim, { sessionId: facts.metadata.storageId, cwd: facts.metadata.cwd })) return false;
		const record = claim as unknown as { pid: number; createdAt: string; endedAt?: unknown };
		return (
			record.pid === facts.row.pid &&
			record.endedAt === undefined &&
			facts.row.start * 1000 <= Date.parse(record.createdAt) + START_TOLERANCE_MS
		);
	} catch {
		return false;
	}
}

interface QuietSample {
	readonly since: number;
	readonly cpuMs: number;
}
interface SupervisionState {
	quiet: Record<string, QuietSample>;
	handedOver: Record<string, string>;
}

function statePath(agentDir: string): string {
	return join(agentDir, "durable-hosts", "supervision.json");
}

function readState(path: string): SupervisionState {
	try {
		const text = readFileSync(path, "utf8");
		if (text.length > STATE_BYTES) throw new Error("oversized");
		const value = JSON.parse(text) as { format?: unknown; quiet?: unknown; handedOver?: unknown };
		if (value.format !== STATE_FORMAT) throw new Error("format");
		const quiet: Record<string, QuietSample> = {};
		for (const [key, sample] of Object.entries((value.quiet ?? {}) as Record<string, unknown>)) {
			const { since, cpuMs } = (sample ?? {}) as { since?: unknown; cpuMs?: unknown };
			if (Number.isFinite(since) && Number.isFinite(cpuMs)) quiet[key] = { since: Number(since), cpuMs: Number(cpuMs) };
		}
		const handedOver: Record<string, string> = {};
		for (const [key, root] of Object.entries((value.handedOver ?? {}) as Record<string, unknown>))
			if (typeof root === "string") handedOver[key] = root;
		return { quiet, handedOver };
	} catch {
		return { quiet: {}, handedOver: {} };
	}
}

function writeState(path: string, state: SupervisionState): void {
	const keys = Object.keys(state.handedOver);
	for (const key of keys.slice(0, Math.max(0, keys.length - HANDED_OVER_LIMIT))) delete state.handedOver[key];
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify({ format: STATE_FORMAT, ...state }), { mode: 0o600 });
	renameSync(temporary, path);
}

const sampleKey = (row: ProcessRow) => `${row.pid}:${row.start}`;

/** Advance the still-since sample of a host; any CPU beyond the quiet share starts it again. */
function quietSince(state: SupervisionState, facts: HostFacts, now: number): number {
	const key = sampleKey(facts.row);
	const sample = state.quiet[key];
	if (sample !== undefined) {
		const allowed = Math.max(QUIET_CPU_FLOOR_MS, (now - sample.since) * QUIET_CPU_SHARE);
		if (facts.treeCpuMs >= sample.cpuMs && facts.treeCpuMs - sample.cpuMs <= allowed) return sample.since;
	}
	state.quiet[key] = { since: now, cpuMs: facts.treeCpuMs };
	return now;
}

function sameProcess(current: ProcessRow | undefined, listed: ProcessRow): boolean {
	return (
		current !== undefined &&
		current.start === listed.start &&
		current.uid === listed.uid &&
		current.command === listed.command
	);
}

/** Every PID from the caller up to the first process: none of them is ever signalled. */
function ancestors(table: readonly ProcessRow[]): Set<number> {
	const parent = new Map(table.map((row) => [row.pid, row.ppid]));
	const chain = new Set<number>();
	let pid: number | undefined = process.pid;
	while (pid !== undefined && pid > 1 && !chain.has(pid)) {
		chain.add(pid);
		pid = parent.get(pid);
	}
	chain.add(process.ppid);
	return chain;
}

type Verdict =
	| { kind: "end"; force: boolean; reason: string; claim: boolean }
	| { kind: "hand-over"; reason: string; root: string }
	| { kind: "keep"; reason?: string };

/** The rules for any host of this user: its storage, record or code is gone. */
function orphanVerdict(facts: HostFacts, age: number, minimumAge: number): Verdict | undefined {
	const { runner, metadata } = facts;
	if (age < minimumAge) return undefined;
	if (!existsSync(metadata.storagePath))
		return { kind: "end", force: true, claim: false, reason: "its storage file was removed" };
	if (!existsSync(catalogRecordPath(metadata)))
		return { kind: "end", force: true, claim: false, reason: "its catalog record was removed" };
	if (existsSync(runner)) return undefined;
	if (facts.workingChildren.length > 0)
		return { kind: "keep", reason: "its code directory was removed, but a child process of its work runs" };
	return { kind: "end", force: true, claim: false, reason: "its code directory was removed" };
}

/** Whether every measure of a host's activity has been still for `windowMs`. */
function stillFor(windowMs: number, age: number, sinceWrite: number, sinceCpu: number): boolean {
	return windowMs > 0 && age >= windowMs && sinceWrite >= windowMs && sinceCpu >= windowMs;
}

/** The rules for a host of this agent directory: stuck with pending work, or idle on other code. */
function ownVerdict(
	facts: HostFacts,
	options: SupervisionOptions,
	state: SupervisionState,
	now: number,
	activeRoot: string | undefined,
): Verdict {
	const { row, runner, metadata } = facts;
	const age = now - row.start * 1000;
	const sinceCpu = now - quietSince(state, facts, now);
	const written = lastWrite(metadata.storagePath);
	const due = recoveryDue(metadata);
	if (written === undefined || due === undefined || facts.workingChildren.length > 0) return { kind: "keep" };
	// A host that publishes its own account counts as stuck only while it says work can run; one that only sleeps or
	// waits is idle by design. A host without the account is judged by its recovery marker alone.
	const activity = readHostActivity(metadata.storagePath, row.pid);
	const runnableFor = activity === undefined ? age : activity.runnable ? now - Date.parse(activity.since) : -1;
	if (due && stillFor(options.stuckMs, Math.min(age, runnableFor), now - written, sinceCpu)) {
		const minutes = Math.round(options.stuckMs / 60_000);
		return {
			kind: "end",
			force: true,
			claim: true,
			reason: `it had pending work but no storage write, CPU progress or working child process for ${minutes} minutes`,
		};
	}
	const root = realOrResolved(packageRootOf(runner));
	const otherCode = activeRoot !== undefined && root !== activeRoot && state.handedOver[metadata.storageId] !== root;
	if (!due && otherCode && stillFor(options.idleMs, age, now - written, Number.POSITIVE_INFINITY))
		return { kind: "hand-over", root, reason: "it was idle on code other than the configured package" };
	return { kind: "keep" };
}

function judge(
	facts: HostFacts,
	options: SupervisionOptions,
	state: SupervisionState,
	now: number,
	ownAgentDir: string,
	activeRoot: string | undefined,
): Verdict {
	const age = now - facts.row.start * 1000;
	const orphan = orphanVerdict(facts, age, options.minimumAgeMs ?? DEFAULT_MINIMUM_AGE_MS);
	if (orphan !== undefined) return orphan;
	if (realOrResolved(facts.metadata.agentDir) !== ownAgentDir) return { kind: "keep" };
	return ownVerdict(facts, options, state, now, activeRoot);
}

/** The services and the record of one check. */
interface Check {
	readonly options: SupervisionOptions;
	readonly processes: ProcessSource;
	readonly now: () => number;
	readonly kill: (pid: number, signal: NodeJS.Signals) => void;
	readonly wait: (ms: number) => Promise<void>;
	readonly state: SupervisionState;
	readonly acts: SupervisionAct[];
	readonly ended: string[];
}

function record(check: Check, facts: HostFacts, kind: SupervisionActKind, reason: string): void {
	check.acts.push({
		at: new Date(check.now()).toISOString(),
		pid: facts.row.pid,
		storageId: facts.metadata.storageId,
		act: kind,
		reason,
	});
}

/** A kept host is reported once per process and reason. */
function keep(check: Check, facts: HostFacts, reason: string): void {
	const key = `${sampleKey(facts.row)}\u0000${reason}`;
	if (check.options.reported?.has(key)) return;
	check.options.reported?.add(key);
	record(check, facts, "kept", reason);
}

/** Whether the process still runs, until the deadline. */
async function exits(check: Check, row: ProcessRow, withinMs: number): Promise<boolean> {
	const deadline = check.now() + withinMs;
	do {
		await check.wait(POLL_MS);
		if (!sameProcess(await check.processes.row(row.pid), row)) return true;
	} while (check.now() < deadline);
	return false;
}

/** Signal one host after its identity proof, and record what happened. */
async function actOn(check: Check, facts: HostFacts, verdict: Exclude<Verdict, { kind: "keep" }>): Promise<void> {
	const { row, metadata } = facts;
	if ((verdict.kind === "hand-over" || verdict.claim) && !claimNames(facts)) {
		if (verdict.kind === "end")
			keep(check, facts, `${verdict.reason}; its writer claim does not name this process, so it was left running`);
		return;
	}
	if (!sameProcess(await check.processes.row(row.pid), row)) return;
	check.kill(row.pid, "SIGTERM");
	if (verdict.kind === "hand-over") check.state.handedOver[metadata.storageId] = verdict.root;
	const grace = check.options.terminationGraceMs ?? SHUTDOWN_GRACE_MS + TERMINATION_MARGIN_MS;
	if (await exits(check, row, grace)) {
		record(check, facts, verdict.kind === "end" ? "ended" : "handed-over", verdict.reason);
		check.ended.push(metadata.storageId);
		return;
	}
	if (verdict.kind === "hand-over" || !verdict.force) {
		keep(check, facts, `${verdict.reason}; it did not exit after SIGTERM`);
		return;
	}
	await forceEnd(check, facts, `${verdict.reason}; it did not exit within ${grace / 1000} s of SIGTERM`);
}

/** SIGKILL for an orphan or stuck host that outlived its own shutdown deadline. */
async function forceEnd(check: Check, facts: HostFacts, reason: string): Promise<void> {
	const { row } = facts;
	if (!sameProcess(await check.processes.row(row.pid), row)) return;
	check.kill(row.pid, "SIGKILL");
	if (!(await exits(check, row, TERMINATION_MARGIN_MS))) {
		keep(check, facts, `${reason}, nor after SIGKILL`);
		return;
	}
	record(check, facts, "killed", reason);
	check.ended.push(facts.metadata.storageId);
}

/** Take the check lock where leases exist; undefined means another check holds it. */
function checkLock(path: string): { release(): void } | "busy" | undefined {
	if (process.platform !== "darwin") return undefined;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const attempt = tryNativeWriterLease(`${path}.lock`);
	return attempt.kind === "busy" ? "busy" : attempt.lease;
}

/**
 * Run one check. It acts at most once per host, waits for each signalled host to exit, and returns what it did. A
 * check that cannot read the process table or that finds another check running acts on nothing.
 */
export async function superviseHosts(options: SupervisionOptions): Promise<SupervisionRun> {
	const now = options.now ?? Date.now;
	const checkedAt = new Date(now()).toISOString();
	const path = statePath(options.agentDir);
	const lock = checkLock(path);
	if (lock === "busy") return { checkedAt, hosts: 0, acts: [], ended: [], skipped: "another check runs" };
	try {
		const processes = options.processes ?? localProcesses;
		let table: ProcessRow[];
		try {
			table = await processes.list();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { checkedAt, hosts: 0, acts: [], ended: [], skipped: `the process table could not be read: ${detail}` };
		}
		const check: Check = {
			options,
			processes,
			now,
			kill: options.kill ?? ((pid, signal) => process.kill(pid, signal)),
			wait: options.wait ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms).unref())),
			state: readState(path),
			acts: [],
			ended: [],
		};
		const hosts = await checkTable(check, table);
		for (const key of Object.keys(check.state.quiet)) if (!hosts.has(key)) delete check.state.quiet[key];
		try {
			writeState(path, check.state);
		} catch {
			/* A lost sample only starts the still window again. */
		}
		return { checkedAt, hosts: hosts.size, acts: check.acts, ended: check.ended };
	} finally {
		lock?.release();
	}
}

/** Judge and act on every host process of this user in the table; returns their sample keys. */
async function checkTable(check: Check, table: readonly ProcessRow[]): Promise<Set<string>> {
	const { options } = check;
	const uid = process.getuid?.();
	const protectedPids = ancestors(table);
	const ownAgentDir = realOrResolved(options.agentDir);
	const activeRoot = options.activeRoot === undefined ? undefined : realOrResolved(options.activeRoot);
	const hosts = new Set<string>();
	for (const row of table) {
		if (row.uid !== uid || protectedPids.has(row.pid)) continue;
		const parsed = parseRunnerCommand(row.command);
		if (parsed === undefined || (options.scope !== undefined && !options.scope(row))) continue;
		hosts.add(sampleKey(row));
		const facts = hostFacts(row, parsed.runner, parsed.metadata, table);
		const verdict = judge(facts, options, check.state, check.now(), ownAgentDir, activeRoot);
		if (verdict.kind !== "keep") await actOn(check, facts, verdict);
		else if (verdict.reason !== undefined) keep(check, facts, verdict.reason);
	}
	return hosts;
}
