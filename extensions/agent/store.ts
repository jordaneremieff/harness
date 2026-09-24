/** Ordinary Pi JSONL sessions with exclusive local writer claims. */
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@earendil-works/pi-agent-core";
import { CURRENT_SESSION_VERSION, parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";

export interface AgentSessionMetadata {
	id: string;
	cwd: string;
	path: string;
	createdAt: number;
	modifiedAt: number;
	/** Native display name and first message text, when the stored session records them. */
	name?: string;
	firstMessage?: string;
}
export interface StoredAgentSession {
	manager: SessionManager;
	metadata: AgentSessionMetadata;
	close(context?: Context): Promise<void>;
}

/** Largest native session file a read-only observation will capture. */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

/** True only when the final bytes are an incomplete entry that `parseSessionEntries` drops. */
function hasUnfinishedTail(content: string): boolean {
	if (!content || content.endsWith("\n")) return false;
	const finalLine = content.slice(content.lastIndexOf("\n") + 1);
	if (!finalLine.trim()) return false;
	try { JSON.parse(finalLine); return false; } catch { return true; }
}

/**
 * A point-in-time snapshot of a native session file, read without a writer claim.
 * `manager` holds the parsed entries; `unavailable` names a bound that refused the capture.
 */
export interface ReadOnlySessionCapture {
	manager: SessionManager;
	cwd: string;
	bytes: number;
	unfinishedTail: boolean;
	unavailable?: string;
}
export class AgentStore {
	readonly root: string;
	readonly nativeRoot: string;
	private readonly sessions = new Map<string, StoredAgentSession>();
	private closed = false;
	constructor(options: { sessionsRoot: string }) {
		mkdirSync(options.sessionsRoot, { recursive: true });
		this.root = realpathSync(options.sessionsRoot);
		this.nativeRoot = join(this.root, "native");
		mkdirSync(this.nativeRoot, { recursive: true });
	}

	private claim(cwd: string, id: string): () => void {
		const directory = join(this.nativeRoot, ".claims");
		mkdirSync(directory, { recursive: true });
		const key = createHash("sha256").update(JSON.stringify([resolve(cwd), id])).digest("hex");
		const path = join(directory, `${key}.lock`);
		const token = randomUUID();
		let fd: number;
		try { fd = openSync(path, "wx", 0o600); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`session ${id} has an exclusive writer claim at ${path}. Claims are never removed automatically; establish that no writer survives before manual removal.`, { cause: error });
			throw error;
		}
		try { writeFileSync(fd, JSON.stringify({ token, pid: process.pid, host: hostname(), sessionId: id, cwd: resolve(cwd), createdAt: new Date().toISOString() })); }
		catch (error) { closeSync(fd); unlinkSync(path); throw error; }
		closeSync(fd);
		return () => {
			const owner = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
			if (owner.token !== token) throw new Error(`session ${id} writer claim changed; refused release`);
			unlinkSync(path);
		};
	}

	/** Runtime-created sessions enter the same ownership boundary as direct opens. */
	adopt(manager: SessionManager): StoredAgentSession {
		if (this.closed) throw new Error("agent store is closed");
		const id = manager.getSessionId();
		const held = this.sessions.get(id);
		if (held?.manager === manager) return held;
		const release = this.claim(manager.getCwd(), id);
		try {
			const path = manager.getSessionFile();
			if (!path || resolve(dirname(path)) !== this.nativeRoot) throw new Error("agent session must use the native session directory");
			// Pi defers initial persistence until an assistant response. Opening a
			// new file with the public native header and entries enables idle
			// persistence without a fabricated assistant response.
			if (!existsSync(path)) {
				const leaf = manager.getLeafId();
				writeFileSync(path, `${[manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
				manager.setSessionFile(path);
				if (leaf) manager.branch(leaf);
			}
			const metadata = this.metadata(manager);
			let closed = false;
			const session: StoredAgentSession = { manager, metadata, close: async () => {
				if (closed) return;
				release();
				closed = true;
				this.sessions.delete(id);
			} };
			this.sessions.set(id, session);
			return session;
		} catch (error) { release(); throw error; }
	}

	metadata(manager: SessionManager): AgentSessionMetadata {
		const path = manager.getSessionFile();
		const header = manager.getHeader();
		if (!path || !header) throw new Error("agent session has no file or header");
		return { id: manager.getSessionId(), cwd: manager.getCwd(), path, createdAt: Date.parse(header.timestamp), modifiedAt: existsSync(path) ? statSync(path).mtimeMs : Date.now() };
	}

	async create(cwd: string, _context?: Context, id?: string): Promise<StoredAgentSession> {
		return this.adopt(SessionManager.create(cwd, this.nativeRoot, id ? { id } : undefined));
	}

	/** Validate location and current native header before Pi's write-capable open. */
	private validate(metadata: AgentSessionMetadata): void {
		if (resolve(dirname(metadata.path)) !== this.nativeRoot) throw new Error("not a native agent session path");
		if (!existsSync(metadata.path)) throw new Error(`session file does not exist: ${metadata.path}`);
		const fd = openSync(metadata.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			if (!fstatSync(fd).isFile()) throw new Error("native session path is not a regular file");
			const buffer = Buffer.alloc(16384);
			let bytes = 0;
			let newline = -1;
			while (bytes < buffer.length && newline < 0) {
				const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
				if (!count) break;
				bytes += count; newline = buffer.indexOf(10, 0);
			}
			if (newline < 0) throw new Error("native session header exceeds its limit or is unfinished");
			const header = JSON.parse(buffer.toString("utf8", 0, newline));
			if (header?.type !== "session" || header.version !== CURRENT_SESSION_VERSION || header.id !== metadata.id || header.cwd !== metadata.cwd || !Number.isFinite(Date.parse(header.timestamp))) throw new Error("not a current ordinary Pi agent session");
		} finally { closeSync(fd); }
	}

	/** Read only the bounded first header line of a native session file; repairs nothing. */
	private readHeader(path: string): { id?: unknown; cwd?: unknown; timestamp?: unknown; version?: unknown } | undefined {
		let fd: number;
		try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
		catch { return undefined; }
		try {
			if (!fstatSync(fd).isFile()) return undefined;
			const buffer = Buffer.alloc(16384);
			let bytes = 0;
			let newline = -1;
			while (bytes < buffer.length && newline < 0) {
				const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
				if (!count) break;
				bytes += count;
				newline = buffer.indexOf(10, 0);
			}
			if (newline < 0) return undefined;
			return JSON.parse(buffer.toString("utf8", 0, newline)) as { id?: unknown; cwd?: unknown; timestamp?: unknown; version?: unknown };
		} catch { return undefined; } finally { closeSync(fd); }
	}

	/**
	 * Locate one native session by id without loading transcript bodies.
	 *
	 * This reads headers only, so a session too large to capture is still
	 * discoverable and reported through `readOnly` instead of being loaded.
	 */
	locate(id: string): AgentSessionMetadata | undefined {
		let files: string[];
		try { files = readdirSync(this.nativeRoot); } catch { return undefined; }
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const path = join(this.nativeRoot, file);
			const header = this.readHeader(path);
			if (!header || header.id !== id) continue;
			const stat = statSync(path, { throwIfNoEntry: false });
			if (!stat?.isFile()) continue;
			const metadata: AgentSessionMetadata = { id, cwd: String(header.cwd), path, createdAt: Date.parse(String(header.timestamp)), modifiedAt: stat.mtimeMs };
			try { this.validate(metadata); } catch { continue; }
			return metadata;
		}
		return undefined;
	}

	/**
	 * Read one native session file as a point-in-time snapshot.
	 *
	 * This path takes no writer claim and calls no `SessionManager.open`, so it
	 * never repairs, rewrites, or truncates another owner's file. A file above
	 * the byte bound is reported unavailable instead of being loaded, and an
	 * unfinished tail is skipped and reported.
	 */
	readOnly(metadata: AgentSessionMetadata): ReadOnlySessionCapture {
		const unavailable = (reason: string): ReadOnlySessionCapture => ({ manager: SessionManager.inMemory(metadata.cwd), cwd: metadata.cwd, bytes: 0, unfinishedTail: false, unavailable: reason });
		if (resolve(dirname(metadata.path)) !== this.nativeRoot) return unavailable("not a native agent session path");
		let fd: number;
		try { fd = openSync(metadata.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
		catch (error) { return unavailable(`session file is not readable (${(error as NodeJS.ErrnoException).code ?? String(error)})`); }
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile()) return unavailable("native session path is not a regular file");
			if (stat.size > MAX_CAPTURE_BYTES) return unavailable(`session file exceeds the ${MAX_CAPTURE_BYTES}-byte read-only capture bound`);
			const buffer = Buffer.alloc(stat.size);
			let bytes = 0;
			while (bytes < buffer.length) {
				const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
				if (!count) break;
				bytes += count;
			}
			const content = buffer.toString("utf8", 0, bytes);
			return { manager: SessionManager.inMemory(metadata.cwd, undefined, parseSessionEntries(content)), cwd: metadata.cwd, bytes, unfinishedTail: hasUnfinishedTail(content) };
		} finally { closeSync(fd); }
	}

	async open(metadata: AgentSessionMetadata, _context?: Context): Promise<StoredAgentSession> {
		if (this.closed) throw new Error("agent store is closed");
		this.validate(metadata);
		// Claim before open: SessionManager repairs unfinished tails.
		const release = this.claim(metadata.cwd, metadata.id);
		try {
			const manager = SessionManager.open(metadata.path, this.nativeRoot);
			let closed = false;
			const session: StoredAgentSession = { manager, metadata: this.metadata(manager), close: async () => {
				if (closed) return;
				release(); closed = true; this.sessions.delete(metadata.id);
			} };
			this.sessions.set(metadata.id, session);
			return session;
		} catch (error) { release(); throw error; }
	}

	/** Replace a reserved manager after the native runtime opens the same file. */
	rebind(held: StoredAgentSession, manager: SessionManager): StoredAgentSession {
		if (held.metadata.id !== manager.getSessionId() || held.metadata.path !== manager.getSessionFile()) throw new Error("session reservation does not match runtime replacement");
		held.manager = manager;
		return held;
	}

	async list(_context?: Context): Promise<AgentSessionMetadata[]> {
		const rows = await SessionManager.listAll(this.nativeRoot);
		return rows.flatMap((row) => {
			const metadata: AgentSessionMetadata = {
				id: row.id, cwd: row.cwd, path: row.path, createdAt: row.created.getTime(), modifiedAt: row.modified.getTime(),
				...(row.name ? { name: row.name } : {}),
				...(row.firstMessage ? { firstMessage: row.firstMessage } : {}),
			};
			try { this.validate(metadata); return [metadata]; } catch { return []; }
		});
	}

	async fork(source: AgentSessionMetadata, context: Context, options: { entryId?: string; position?: "before" | "at"; requireModel?: boolean } = {}): Promise<StoredAgentSession> {
		const held = this.sessions.get(source.id);
		const reservation = held ?? await this.open(source, context);
		try {
			const manager = SessionManager.open(source.path, this.nativeRoot);
			let tip = options.entryId ?? manager.getLeafId();
			if (options.entryId && options.position === "before") {
				const entry = manager.getEntry(options.entryId);
				if (!entry) throw new Error(`no entry ${options.entryId}`);
				tip = entry.parentId;
			}
			const branch = tip ? manager.getBranch(tip) : [];
			if (options.requireModel && !branch.some((entry) => entry.type === "model_change")) throw new Error("fork requires a retained native model entry");
			if (tip) manager.createBranchedSession(tip);
			else manager.newSession({ parentSession: source.path });
			return this.adopt(manager);
		} finally { if (!held) await reservation.close(); }
	}

	async close(_context?: Context): Promise<void> {
		this.closed = true;
		const results = await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
		const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
		if (errors.length) throw new AggregateError(errors, "agent store cleanup failed; writer claims retained");
	}
}
