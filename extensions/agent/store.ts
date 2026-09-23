/** Ordinary Pi JSONL sessions with exclusive local writer claims. */
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@earendil-works/pi-agent-core";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";

export interface AgentSessionMetadata {
	id: string;
	cwd: string;
	path: string;
	createdAt: number;
	modifiedAt: number;
}
export interface StoredAgentSession {
	manager: SessionManager;
	metadata: AgentSessionMetadata;
	close(context?: Context): Promise<void>;
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
			const metadata = { id: row.id, cwd: row.cwd, path: row.path, createdAt: row.created.getTime(), modifiedAt: row.modified.getTime() };
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
