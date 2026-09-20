/**
 * agent/store: durable session placement for agent sessions.
 *
 * One JsonlSessionRepo (harness format-4 files) under a configurable root
 * (default <agentDir>/agent-sessions). Identity, fork, list, and open all come
 * from the public harness session repo; no parallel index is kept.
 *
 * Execution environments are per working directory: every agent session gets
 * an ExecutionEnv bound to its own cwd, so harness-native tools resolve
 * relative paths and run commands in the session's working directory.
 */

import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { Context, ExecutionEnv, Session } from "@earendil-works/pi-agent-core";
import {
	JsonlSessionRepo,
	type JsonlSessionMetadata,
} from "@earendil-works/pi-agent-core";
// The loader aliases the package root but not its subpaths. Resolve only the
// package's declared public import target; no private dist path is assumed.
export function corePublicImportUrl(subpath: "./harness/env/nodejs" | "./harness/session"): string {
	const require = createRequire(import.meta.url);
	const manifestPath = require.resolve("@earendil-works/pi-agent-core/package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { exports: Record<string, { import?: string }> };
	const target = manifest.exports[subpath]?.import;
	if (!target?.startsWith("./")) throw new Error(`agent core does not export ${subpath} for import`);
	return pathToFileURL(resolve(dirname(manifestPath), target)).href;
}
const { NodeExecutionEnv } = await import(corePublicImportUrl("./harness/env/nodejs")) as typeof import("@earendil-works/pi-agent-core/harness/env/nodejs");

export type AgentSessionMetadata = JsonlSessionMetadata;

export interface AgentStoreOptions {
	sessionsRoot: string;
}

export class AgentStore {
	readonly root: string;
	private readonly repo: JsonlSessionRepo;
	private readonly envs = new Map<string, ExecutionEnv>();
	private readonly sessions = new Map<string, Session<JsonlSessionMetadata>>();
	private readonly pending = new Set<Promise<Session<JsonlSessionMetadata>>>();
	private readonly sourceReads = new Map<string, Set<Promise<unknown>>>();
	private readonly closingSessions = new Set<string>();
	private closed = false;
	private closeTask: Promise<void> | undefined;

	constructor(options: AgentStoreOptions) {
		mkdirSync(options.sessionsRoot, { recursive: true });
		this.root = realpathSync(options.sessionsRoot);
		this.repo = new JsonlSessionRepo({ fileSystem: this.envFor(this.root), sessionsRoot: this.root });
	}

	/** One ExecutionEnv per working directory, shared by sessions with equal cwd. */
	envFor(cwd: string): ExecutionEnv {
		const key = resolve(cwd);
		let env = this.envs.get(key);
		if (!env) {
			env = new NodeExecutionEnv({ cwd: key, shellEnv: process.env });
			this.envs.set(key, env);
		}
		return env;
	}

	/** Exclusive local-filesystem claims remain after crashes; recovery requires an operator to establish that no writer survives. */
	private claim(cwd: string, id: string): () => void {
		const directory = join(this.root, ".claims");
		mkdirSync(directory, { recursive: true });
		const key = this.key(cwd, id);
		const path = join(directory, `${key}.lock`);
		const token = randomUUID();
		let fd: number;
		try { fd = openSync(path, "wx", 0o600); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error(`session ${id} has an exclusive writer claim at ${path}. Claims are never removed automatically; establish that no writer survives before manual removal.`, { cause: error });
			}
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

	private key(cwd: string, id: string): string {
		return createHash("sha256").update(JSON.stringify([resolve(cwd), id])).digest("hex");
	}

	private acquire(cwd: string, id: string, context: Context, factory: () => Promise<Session<JsonlSessionMetadata>>): Promise<Session<JsonlSessionMetadata>> {
		if (this.closed) return Promise.reject(new Error("agent store is closed"));
		const task = (async () => {
			const release = this.claim(cwd, id);
			let session: Session<JsonlSessionMetadata>;
			try { session = await factory(); } catch (error) {
				try { release(); } catch (cleanup) { throw new AggregateError([error, cleanup], "session acquisition failed; claim cleanup failed", { cause: error }); }
				throw error;
			}
			const key = this.key(cwd, id);
			const close = session.close.bind(session);
			let closeTask: Promise<void> | undefined;
			session.close = (closeContext) => {
				if (closeTask) return closeTask;
				this.closingSessions.add(key);
				closeTask ??= (async () => {
					await Promise.allSettled(this.sourceReads.get(key) ?? []);
					await close(closeContext);
					release();
					this.sessions.delete(key);
					this.closingSessions.delete(key);
				})();
				return closeTask;
			};
			this.sessions.set(key, session);
			if (this.closed) { await session.close(context); throw new Error("agent store is closed"); }
			return session;
		})();
		this.pending.add(task);
		void task.finally(() => this.pending.delete(task)).catch(() => undefined);
		return task;
	}

	create(cwd: string, context: Context, id: string = randomUUID()): Promise<Session<JsonlSessionMetadata>> {
		return this.acquire(cwd, id, context, () => this.repo.create({ cwd, id }, context));
	}

	open(metadata: AgentSessionMetadata, context: Context): Promise<Session<JsonlSessionMetadata>> {
		return this.acquire(metadata.cwd, metadata.id, context, () => this.repo.open(metadata, context));
	}

	async list(context: Context): Promise<AgentSessionMetadata[]> {
		return this.repo.list(undefined, context);
	}

	fork(
		source: AgentSessionMetadata,
		branch: string,
		context: Context,
		options: { entryId?: string; id?: string; position?: "before" | "at" } = {},
	): Promise<Session<JsonlSessionMetadata>> {
		const id = options.id ?? randomUUID();
		const sourceKey = this.key(source.cwd, source.id);
		if (this.closingSessions.has(sourceKey)) return Promise.reject(new Error(`session ${source.id} is closing`));
		const task = this.acquire(source.cwd, id, context, async () => {
			const releaseSource = this.sessions.has(sourceKey) ? undefined : this.claim(source.cwd, source.id);
			try { return await this.repo.fork(source, { scope: "branch", branch, ...options, id }, context); }
			finally { releaseSource?.(); }
		});
		const reads = this.sourceReads.get(sourceKey) ?? new Set<Promise<unknown>>();
		this.sourceReads.set(sourceKey, reads);
		reads.add(task);
		void task.finally(() => { reads.delete(task); if (!reads.size) this.sourceReads.delete(sourceKey); }).catch(() => undefined);
		return task;
	}

	close(context: Context): Promise<void> {
		if (this.closeTask) return this.closeTask;
		this.closed = true;
		this.closeTask = (async () => {
			await Promise.allSettled(this.pending);
			const results = await Promise.allSettled([...this.sessions.values()].map((session) => session.close(context)));
			await this.repo.close(context);
			for (const env of this.envs.values()) await env.cleanup(context).catch(() => undefined);
			this.envs.clear();
			const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
			if (errors.length) throw new AggregateError(errors, "agent store cleanup failed; writer claims retained");
		})();
		return this.closeTask;
	}
}
