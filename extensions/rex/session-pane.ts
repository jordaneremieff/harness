import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boundedText, fullId } from "./ownership.ts";

/**
 * Where an ordinary interactive Pi session is shown: the Rex pane that its process was launched in. An agent without a
 * pane of its own takes the pane of the ordinary session at the top of its chain of creating owners as its inherited
 * launch context, so the panes it opens appear on that session's tab.
 */
export interface SessionPane {
	/** The `REX_SERVER` launch value of the session's process, when it had one. */
	readonly server?: string;
	readonly session: string;
	readonly block: string;
}

export type SessionPaneLookup =
	| { readonly ok: true; readonly pane: SessionPane }
	/** `unregistered`: no valid record names the session. `ended`: the recorded process no longer runs. */
	| { readonly ok: false; readonly reason: "unregistered" | "ended" };

interface SessionPaneRecord extends SessionPane {
	readonly version: 1;
	readonly sessionId: string;
	readonly pid: number;
	readonly updatedAt: string;
}

const RECORD_FIELDS = new Set(["version", "sessionId", "pid", "server", "session", "block", "updatedAt"]);
const RECORD_BYTES = 4096;
const RECORD_NAME = /^[a-f0-9]{64}\.json$/u;
const TEMPORARY_NAME = /^\.tmp-[a-f0-9-]{36}$/u;
/** Directory entries that one registration examines for records of ended processes. */
const PRUNE_SCAN = 512;
/** A temporary file this old belongs to a write that ended without its rename. */
const TEMPORARY_AGE_MS = 86_400_000;

export function sessionPaneDirectory(agentDir: string): string {
	return join(agentDir, "rex", "session-panes");
}

function recordPath(agentDir: string, sessionId: string): string {
	return join(sessionPaneDirectory(agentDir), `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

/** Whether a process exists. A process of another user counts as running. */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The pane that a process's Rex launch environment names, or undefined when it names no exact session and block. */
export function launchPane(env: Readonly<Record<string, string | undefined>>): SessionPane | undefined {
	const server = env.REX_SERVER || undefined;
	if (!fullId(env.REX_SESSION, "session") || !fullId(env.REX_BLOCK, "block")) return undefined;
	if (server !== undefined && !boundedText(server, 4096)) return undefined;
	return { ...(server === undefined ? {} : { server }), session: env.REX_SESSION, block: env.REX_BLOCK };
}

/** Record a process's pane for one ordinary session, replacing an earlier record, then remove records of ended processes. */
export function registerSessionPane(options: { agentDir: string; sessionId: string; pid: number; pane: SessionPane; now?: Date; alive?: (pid: number) => boolean }): void {
	if (!boundedText(options.sessionId, 512) || !Number.isSafeInteger(options.pid) || options.pid <= 0) throw new Error("A session pane needs a bounded session ID and a process ID.");
	const now = options.now ?? new Date();
	const directory = sessionPaneDirectory(options.agentDir);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const record: SessionPaneRecord = {
		version: 1, sessionId: options.sessionId, pid: options.pid,
		...(options.pane.server === undefined ? {} : { server: options.pane.server }),
		session: options.pane.session, block: options.pane.block, updatedAt: now.toISOString(),
	};
	const path = recordPath(options.agentDir, options.sessionId);
	const temporary = join(directory, `.tmp-${randomUUID()}`);
	try {
		writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		try { unlinkSync(temporary); } catch { /* The rename consumed it, or the write never created it. */ }
		throw error;
	}
	prune(directory, path, options.alive ?? processAlive, now);
}

/** Remove an ordinary session's record when it still names this process. */
export function releaseSessionPane(options: { agentDir: string; sessionId: string; pid: number }): void {
	const path = recordPath(options.agentDir, options.sessionId);
	const read = readRecord(path);
	if (read?.record === undefined || read.record.sessionId !== options.sessionId || read.record.pid !== options.pid) return;
	removeUnchanged(path, read);
}

/** The registered pane of an ordinary session whose process still runs. */
export function readSessionPane(agentDir: string, sessionId: string, alive: (pid: number) => boolean = processAlive): SessionPaneLookup {
	const read = readRecord(recordPath(agentDir, sessionId));
	const record = read?.record;
	if (record === undefined || record.sessionId !== sessionId) return { ok: false, reason: "unregistered" };
	if (!alive(record.pid)) return { ok: false, reason: "ended" };
	return { ok: true, pane: { ...(record.server === undefined ? {} : { server: record.server }), session: record.session, block: record.block } };
}

export interface SessionPaneRegistrar {
	/** Record the pane of an interactive session that runs in a Rex pane; other modes and terminals record nothing. */
	start(ctx: Pick<ExtensionContext, "mode" | "sessionManager">): void;
	/** Remove the record that `start` made. */
	shutdown(): void;
}

export interface SessionPaneRegistrarOptions {
	agentDir: string;
	env?: Readonly<Record<string, string | undefined>>;
	pid?: number;
	now?: () => Date;
}

export function createSessionPaneRegistrar(options: SessionPaneRegistrarOptions): SessionPaneRegistrar {
	const env = options.env ?? process.env;
	const pid = options.pid ?? process.pid;
	let registered: string | undefined;
	const release = () => {
		const sessionId = registered;
		registered = undefined;
		if (sessionId === undefined) return;
		try { releaseSessionPane({ agentDir: options.agentDir, sessionId, pid }); }
		catch { /* A later registration prunes the record once this process ends. */ }
	};
	return {
		start(ctx) {
			release();
			const pane = ctx.mode === "tui" ? launchPane(env) : undefined;
			if (pane === undefined) return;
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				registerSessionPane({ agentDir: options.agentDir, sessionId, pid, pane, ...(options.now ? { now: options.now() } : {}) });
				registered = sessionId;
			} catch { /* Without a record, this session's agents report that its pane is unknown. */ }
		},
		shutdown: release,
	};
}

/** A record file with its identity; `record` is absent when the file holds no valid record. */
interface ReadRecord {
	readonly record?: SessionPaneRecord;
	readonly dev: number;
	readonly ino: number;
}

function readRecord(path: string): ReadRecord | undefined {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ELOOP") return undefined;
		throw error;
	}
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > RECORD_BYTES) return { dev: info.dev, ino: info.ino };
		const buffer = Buffer.alloc(RECORD_BYTES + 1);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		const record = length > RECORD_BYTES ? undefined : parseRecord(buffer.subarray(0, length).toString("utf8"));
		return { ...(record === undefined ? {} : { record }), dev: info.dev, ino: info.ino };
	} finally {
		closeSync(fd);
	}
}

function parseRecord(text: string): SessionPaneRecord | undefined {
	let value: unknown;
	try { value = JSON.parse(text); } catch { return undefined; }
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !RECORD_FIELDS.has(key))) return undefined;
	if (record.version !== 1 || !boundedText(record.sessionId, 512) || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return undefined;
	if (record.server !== undefined && !boundedText(record.server, 4096)) return undefined;
	if (!fullId(record.session, "session") || !fullId(record.block, "block") || typeof record.updatedAt !== "string") return undefined;
	return record as unknown as SessionPaneRecord;
}

/** Unlink a file only while it is still the file that was read, so a record written since then stays. */
function removeUnchanged(path: string, read: ReadRecord): void {
	const current = lstatSync(path, { throwIfNoEntry: false });
	if (current?.dev === read.dev && current.ino === read.ino) unlinkSync(path);
}

function prune(directory: string, own: string, alive: (pid: number) => boolean, now: Date): void {
	let names: string[];
	try { names = readdirSync(directory).slice(0, PRUNE_SCAN); } catch { return; }
	for (const name of names) {
		try { pruneEntry(join(directory, name), name, own, alive, now); }
		catch { /* A record that cannot be read or removed now stays for a later registration. */ }
	}
}

function pruneEntry(path: string, name: string, own: string, alive: (pid: number) => boolean, now: Date): void {
	if (TEMPORARY_NAME.test(name)) {
		const info = lstatSync(path, { throwIfNoEntry: false });
		if (info?.isFile() && now.getTime() - info.mtimeMs > TEMPORARY_AGE_MS) unlinkSync(path);
		return;
	}
	if (path === own || !RECORD_NAME.test(name)) return;
	const read = readRecord(path);
	if (read === undefined || (read.record !== undefined && alive(read.record.pid))) return;
	removeUnchanged(path, read);
}
