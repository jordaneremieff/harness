/**
 * Worker host: one PiServer, in the parent session's own process, listening on a
 * unix socket. Workers dispatched by the parent are registered here as real
 * protocol sessions: a client that speaks protocol v1 can list them, attach, and
 * drive the same session the parent is driving.
 *
 * Released Pi 0.84.2 ships no operator client for this socket. Unreleased
 * upstream server and client work is experimental and does not define this
 * extension's production contract. The socket remains unconsumed by an operator
 * workflow and is covered by the colocated conformance test.
 *
 * There is no daemon. The host lives and dies with the parent session; a worker
 * still in flight when the parent dies is lost (owner_lost), and its completed
 * result stays in the store. That is the whole contract.
 */

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelMetadata, SessionMetadata } from "@earendil-works/pi-protocol";
import {
	type CreateSessionOptions,
	PiServerError,
	type PiServerService,
	type PiSessionRuntime,
	toProtocolModelMetadata,
} from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";
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
	if (uid === undefined) throw new Error("subagent worker sockets require a unix effective uid");
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
		throw new Error(`worker socket directory is not owned by the current user: ${path}`);
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
	const socketDir = join(runtimeRoot, `a-${shortHash("agent", resolve(agentDir))}`);
	const path = join(socketDir, `s-${shortHash("session", ownerSession)}.sock`);
	if (Buffer.byteLength(path, "utf-8") > SOCKET_PATH_LIMIT) {
		throw new Error(`worker socket path exceeds the platform limit of ${SOCKET_PATH_LIMIT} UTF-8 bytes`);
	}
	return { socketDir, path };
}

export class WorkerHost implements PiServerService {
	private readonly runtimes = new Map<string, WorkerRuntime>();
	private readonly socketDir: string;
	private readonly path: string;
	private server: ReturnType<typeof createUnixServer> | null = null;
	private starting: Promise<void> | null = null;
	private closing: Promise<void> | null = null;
	private modelsFrom: ExtensionContext | null = null;
	private closed = false;

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
		if (this.closed) throw new Error("worker host is closed");
		this.modelsFrom = ctx;
		if (this.server) return;
		if (this.starting) return this.starting;
		this.starting = (async () => {
			// Owner-only: the socket is a full control channel over live workers and
			// its filesystem permissions are the whole authorization story (protocol
			// hello carries no credentials — upstream made authorization a transport
			// responsibility). Secure the runtime root as well as the hashed agent
			// directory so another user cannot replace the directory through a parent
			// they own. The socket file is created 0600 by the listener.
			ensureOwnerOnlyDirectory(dirname(this.socketDir));
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
		if (this.closed) throw new Error("worker host is closed");
		this.runtimes.set(runtime.id, runtime);
	}

	unregister(id: string): void {
		this.runtimes.delete(id);
	}

	async close(): Promise<void> {
		if (this.closing) return this.closing;
		if (this.closed) return;
		this.closed = true;
		this.closing = (async () => {
			const starting = this.starting;
			if (starting) {
				try {
					await starting;
				} catch {
					// Startup already owns its transport cleanup.
				}
			}
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
			this.modelsFrom = null;
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
		})();
		return this.closing;
	}

	// ------------------------------------------------------------ PiServerService

	async listSessions(): Promise<SessionMetadata[]> {
		return [...this.runtimes.values()].map((runtime) => ({
			id: runtime.id,
			createdAt: runtime.createdAt,
			sessionName: runtime.name,
			cwd: runtime.cwd,
		}));
	}

	async listModels(): Promise<ModelMetadata[]> {
		const ctx = this.modelsFrom;
		if (!ctx) return [];
		return ctx.modelRegistry
			.getAvailable()
			.map((model) => toProtocolModelMetadata(model, ctx.modelRegistry.hasConfiguredAuth(model)));
	}

	async createSession(_options: CreateSessionOptions): Promise<PiSessionRuntime> {
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
			throw new PiServerError("not_found", `no live worker with id ${sessionId}`);
		}
		return runtime;
	}
}
