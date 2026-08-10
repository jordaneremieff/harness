/**
 * Worker host: one PiServer, in the parent session's own process, listening on a
 * unix socket. Workers dispatched by the parent are registered here as real
 * protocol sessions: a client that speaks protocol v1 can list them, attach, and
 * drive the same session the parent is driving.
 *
 * No such client ships today. Pi's `server`/`client` CLI commands exist upstream
 * as parser composition that the shipping entrypoint does not call, and its TUI
 * drives one local session at a time. This surface is therefore unconsumed by
 * any operator workflow; it is covered by the colocated conformance test, and it
 * is the path an inline steerable worker console will take when upstream's TUI
 * learns to consume a remote session.
 *
 * There is no daemon. The host lives and dies with the parent session; a worker
 * still in flight when the parent dies is lost (owner_lost), and its completed
 * result stays in the store. That is the whole contract.
 */

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	PiServerError,
	toProtocolModelMetadata,
	type CreateSessionOptions,
	type PiServerService,
	type PiSessionRuntime,
} from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import type {
	ModelMetadata,
	SessionMetadata,
} from "@earendil-works/pi-protocol";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkerRuntime } from "./runtime.ts";

const SOCKET_HASH_HEX = 24;
const SOCKET_PATH_LIMIT = process.platform === "linux" ? 107 : 103;

function shortHash(kind: "agent" | "session", value: string): string {
	return createHash("sha256")
		.update(`pi-subagent-socket-v1\0${kind}\0${value}`, "utf-8")
		.digest("hex")
		.slice(0, SOCKET_HASH_HEX);
}

function productionRuntimeRoot(): string {
	const uid = process.getuid?.();
	if (uid === undefined)
		throw new Error("subagent worker sockets require a unix effective uid");
	// Do not use os.tmpdir(): its macOS /var/folders path can consume almost half
	// of sockaddr_un before the bounded socket name is added.
	return join("/tmp", `pi-${uid}`);
}

function ensureOwnerOnlyDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const before = lstatSync(path);
	if (before.isSymbolicLink() || !before.isDirectory()) {
		throw new Error(`worker socket directory is not a real directory: ${path}`);
	}
	const uid = process.getuid?.();
	if (uid !== undefined && before.uid !== uid) {
		throw new Error(
			`worker socket directory is not owned by the current user: ${path}`,
		);
	}
	chmodSync(path, 0o700);
	const after = statSync(path);
	if ((after.mode & 0o077) !== 0) {
		throw new Error(`worker socket directory is not owner-only: ${path}`);
	}
}

export function socketLocation(
	agentDir: string,
	ownerSession: string,
	runtimeRoot = productionRuntimeRoot(),
): { socketDir: string; path: string } {
	const socketDir = join(
		runtimeRoot,
		`a-${shortHash("agent", resolve(agentDir))}`,
	);
	const path = join(socketDir, `s-${shortHash("session", ownerSession)}.sock`);
	if (Buffer.byteLength(path, "utf-8") > SOCKET_PATH_LIMIT) {
		throw new Error(
			`worker socket path exceeds the platform limit of ${SOCKET_PATH_LIMIT} UTF-8 bytes`,
		);
	}
	return { socketDir, path };
}

export class WorkerHost implements PiServerService {
	private readonly runtimes = new Map<string, WorkerRuntime>();
	private readonly socketDir: string;
	private readonly path: string;
	private server: ReturnType<typeof createUnixServer> | null = null;
	private starting: Promise<void> | null = null;
	private modelsFrom: ExtensionContext | null = null;

	constructor(agentDir: string, ownerSession: string, runtimeRoot?: string) {
		const location = socketLocation(agentDir, ownerSession, runtimeRoot);
		this.socketDir = location.socketDir;
		this.path = location.path;
	}

	/** Socket path an observer attaches to. Valid whether or not the host started. */
	get socketPath(): string {
		return this.path;
	}

	/** Owner-only directory containing this agent directory's bounded endpoints. */
	get socketDirectory(): string {
		return this.socketDir;
	}

	/** Start on first dispatch; repeat calls await the same start. */
	async ensureStarted(ctx: ExtensionContext): Promise<void> {
		this.modelsFrom = ctx;
		if (this.server) return;
		if (this.starting) return this.starting;
		this.starting = (async () => {
			// Owner-only: the socket is a full control channel over live workers and
			// its filesystem permissions are the whole authorization story (protocol
			// hello carries no credentials — upstream made authorization a transport
			// responsibility). The socket file itself is created 0600 by the listener.
			ensureOwnerOnlyDirectory(this.socketDir);
			const server = createUnixServer(this, {
				path: this.path,
				onError: () => {
					// An observer's transport failure must not disturb the workers.
				},
			});
			try {
				// PiServer probes and identity-checks stale endpoints before removal.
				// Do not blindly unlink a path that a replacement listener may own.
				await server.start();
				this.server = server;
			} catch (error) {
				try {
					await server.close();
				} catch {
					// Preserve the startup failure.
				}
				throw error;
			}
		})();
		try {
			await this.starting;
		} finally {
			this.starting = null;
		}
	}

	register(runtime: WorkerRuntime): void {
		this.runtimes.set(runtime.id, runtime);
	}

	unregister(id: string): void {
		this.runtimes.delete(id);
	}

	get(id: string): WorkerRuntime | undefined {
		return this.runtimes.get(id);
	}

	get liveCount(): number {
		return this.runtimes.size;
	}

	async close(): Promise<void> {
		for (const runtime of this.runtimes.values()) {
			try {
				runtime.shutdown();
			} catch {
				// Continue closing the remaining runtime and transport owners.
			}
		}
		this.runtimes.clear();
		const server = this.server;
		this.server = null;
		if (server) {
			try {
				await server.close();
			} catch {
				// Shutting down anyway.
			}
		}
		try {
			rmdirSync(this.socketDir);
		} catch {
			// Shared agent namespace may still contain another live endpoint.
		}
	}

	// ------------------------------------------------------------ PiServerService

	async listSessions(): Promise<SessionMetadata[]> {
		return [...this.runtimes.values()].map((runtime) => ({
			id: runtime.id,
			createdAt: runtime.createdAt,
			sessionName: runtime.name,
			cwd: runtime.cwd,
		})) as SessionMetadata[];
	}

	async listModels(): Promise<ModelMetadata[]> {
		const ctx = this.modelsFrom;
		if (!ctx) return [];
		return ctx.modelRegistry
			.getAvailable()
			.map((model) =>
				toProtocolModelMetadata(
					model,
					ctx.modelRegistry.hasConfiguredAuth(model),
				),
			);
	}

	async createSession(
		_options: CreateSessionOptions,
	): Promise<PiSessionRuntime> {
		// Workers are dispatched by the parent, never created by an observer. An
		// attaching client can list and attach; it cannot open new work.
		throw new PiServerError(
			"invalid_request",
			"this server serves dispatched workers; it does not create sessions. Dispatch with the subagent tool.",
		);
	}

	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		const runtime = this.runtimes.get(sessionId);
		if (!runtime) {
			throw new PiServerError(
				"not_found",
				`no live worker with id ${sessionId}`,
			);
		}
		return runtime;
	}
}
