/**
 * agent/host-process: one exclusive durable host process per storage.
 *
 * `runHost` takes the writer claim for the storage before it creates the
 * runtime, serves requests from an authenticated Unix socket, and retires when
 * no client is attached and the runtime reports idle for
 * `PI_AGENT_IDLE_MINUTES`. The runtime owns Durable work; this module owns the
 * claim, the transport, and the lifecycle. It announces readiness on stdout so
 * a launching client can connect without polling.
 */
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { type ClaimFile, type ClaimIdentity, classifyClaim, readClaimFile } from "./claims.ts";
import {
	HostError,
	HostFrameDecoder,
	HOST_HELLO_TIMEOUT_MS,
	HOST_PROTOCOL_VERSION,
	encodeHostFrame,
	formatHostReady,
	hostPaths,
	hostTokensMatch,
	isCancelableHostWait,
	newHostToken,
	parseHostClientMessage,
	parseHostMetadata,
	type HostClientMessage,
	type HostEndpoint,
	type HostHello,
	type HostMetadata,
	type HostPaths,
	type HostReady,
	type HostRequestMessage,
	type HostServerMessage,
} from "./host-protocol.ts";

/** The host-side surface the parent runtime must supply. */
export interface HostRuntime {
	/**
	 * `requestId` is the transport request ID. `signal` is present only for a
	 * cancelable observational wait; it aborts on client cancel or socket close
	 * and must never cancel admitted Durable work.
	 */
	request(method: string, params: unknown, requestId: string, signal?: AbortSignal): Promise<unknown>;
	close(): Promise<void>;
	isIdle(): boolean;
}

/** Called once the claim is held; the runtime opens storage only after this point. */
export type HostRuntimeFactory = () => HostRuntime | Promise<HostRuntime>;

export interface RunHostOptions {
	readonly metadata: HostMetadata;
	/** Idle window in milliseconds. Defaults from `PI_AGENT_IDLE_MINUTES`. */
	readonly idleMs?: number;
	/** Environment used for the idle default; defaults to `process.env`. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Readiness announcement. Defaults to the stdout readiness line. */
	readonly announceReady?: (ready: HostReady) => void;
}

/** Owner of one storage for the process lifetime. */
export interface HostProcess {
	readonly pid: number;
	readonly socketPath: string;
	/** Resolves on clean retirement and rejects when shutdown fails. */
	readonly done: Promise<void>;
	close(): Promise<void>;
}

/** A claim that cannot be taken; `observation` distinguishes a live owner from an unusable claim. */
export class HostClaimRefusedError extends Error {
	readonly observation: "live" | "unknown";
	constructor(message: string, observation: "live" | "unknown", cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "HostClaimRefusedError";
		this.observation = observation;
	}
}

interface ClaimRecord {
	readonly token: string;
	readonly pid: number;
	readonly host: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly createdAt: string;
}

interface ClientLink {
	readonly decoder: HostFrameDecoder;
	readonly controllers: Map<string, AbortController>;
	helloReceived: boolean;
}

const IDLE_MINUTES_MAX = 35791;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reasonText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read `PI_AGENT_IDLE_MINUTES` with the same bounds as the ordinary agent host. */
export function resolveIdleMs(idleMs?: number, env: Readonly<Record<string, string | undefined>> = process.env): number {
	if (idleMs !== undefined) {
		if (!Number.isFinite(idleMs) || idleMs < 0 || idleMs > IDLE_MINUTES_MAX * 60_000) throw new Error(`idleMs must be a finite nonnegative number no greater than ${IDLE_MINUTES_MAX} minutes`);
		return idleMs;
	}
	const raw = env.PI_AGENT_IDLE_MINUTES;
	const minutes = raw === undefined ? 5 : Number(raw);
	if (!Number.isFinite(minutes) || minutes < 0 || minutes > IDLE_MINUTES_MAX || raw?.trim() === "") throw new Error("PI_AGENT_IDLE_MINUTES must be a finite nonnegative number no greater than 35791");
	return minutes * 60_000;
}

function createClaimFile(path: string, record: ClaimRecord): void {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(record));
	} catch (error) {
		closeSync(fd);
		rmSync(path, { force: true });
		throw error;
	}
	closeSync(fd);
}

function errnoCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Replace a same-host claim whose process is dead, with a dev/ino recheck so a
 * concurrent replacement cannot be overwritten.
 */
function replaceDeadClaim(path: string, identity: ClaimIdentity, record: ClaimRecord): HeldClaim {
	let file: ClaimFile;
	try {
		file = readClaimFile(path);
	} catch (error) {
		throw new HostClaimRefusedError("durable host writer claim is unreadable", "unknown", error);
	}
	const observation = classifyClaim(file.claim, identity);
	if (observation.kind === "live") throw new HostClaimRefusedError(`durable host writer claim is held by ${observation.label}`, "live");
	if (observation.kind === "unknown") throw new HostClaimRefusedError(`durable host writer claim cannot be replaced: ${observation.error}`, "unknown");
	const current = lstatSync(path, { throwIfNoEntry: false });
	if (current && (current.dev !== file.dev || current.ino !== file.ino)) throw new HostClaimRefusedError("durable host writer claim changed during replacement", "unknown");
	try {
		if (current) unlinkSync(path);
	} catch (error) {
		if (errnoCode(error) !== "ENOENT") throw error;
	}
	try {
		createClaimFile(path, record);
		return new HeldClaim(path, record.token);
	} catch (error) {
		if (errnoCode(error) === "EEXIST") throw new HostClaimRefusedError("another durable host replaced the dead claim first", "unknown", error);
		throw error;
	}
}

/**
 * Take the claim once, replacing only a same-host claim whose process is dead.
 * A live, foreign-host, unreadable, invalid, or concurrently changed claim
 * refuses, so two hosts never create schedulers for one storage.
 */
function takeClaim(path: string, identity: ClaimIdentity, record: ClaimRecord): HeldClaim {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try {
		createClaimFile(path, record);
		return new HeldClaim(path, record.token);
	} catch (error) {
		if (errnoCode(error) !== "EEXIST") throw error;
	}
	return replaceDeadClaim(path, identity, record);
}

class HeldClaim {
	private readonly path: string;
	readonly token: string;
	constructor(path: string, token: string) {
		this.path = path;
		this.token = token;
	}
	release(): void {
		let claim: unknown;
		try {
			claim = readClaimFile(this.path).claim;
		} catch (error) {
			if (errnoCode(error) === "ENOENT") return;
			throw new Error("durable host writer claim is unreadable; refused release", { cause: error });
		}
		if (!isRecord(claim) || claim.token !== this.token) throw new Error("durable host writer claim changed; refused release");
		unlinkSync(this.path);
	}
}

function writeEndpoint(path: string, endpoint: HostEndpoint): void {
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(endpoint), { mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

class HostProcessServer implements HostProcess {
	readonly pid = process.pid;
	readonly done: Promise<void>;
	private readonly runtime: HostRuntime;
	private readonly metadata: HostMetadata;
	private readonly paths: HostPaths;
	private readonly claim: HeldClaim;
	private readonly idleMs: number;
	private readonly links = new Map<Socket, ClientLink>();
	private readonly socketPathValue: string;
	private server: Server | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private closing = false;
	private closePromise: Promise<void> | undefined;
	private resolveDone: () => void = () => {};
	private rejectDone: (error: Error) => void = () => {};

	constructor(runtime: HostRuntime, metadata: HostMetadata, paths: HostPaths, claim: HeldClaim, idleMs: number) {
		this.runtime = runtime;
		this.metadata = metadata;
		this.paths = paths;
		this.claim = claim;
		this.idleMs = idleMs;
		this.socketPathValue = paths.socket;
		this.done = new Promise<void>((resolve, reject) => {
			this.resolveDone = resolve;
			this.rejectDone = reject;
		});
		// Retirement may reject `done` before a caller attaches to it; keep the
		// rejection observable for awaiters without an unhandled report.
		void this.done.catch(() => {});
	}

	get socketPath(): string {
		return this.socketPathValue;
	}

	async start(announce: (ready: HostReady) => void): Promise<void> {
		const socketDirectory = dirname(this.paths.socket);
		mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
		chmodSync(socketDirectory, 0o700);
		if (existsSync(this.paths.socket)) {
			const stat = lstatSync(this.paths.socket);
			if (!stat.isSocket()) throw new Error(`durable host socket path exists and is not a socket: ${this.paths.socket}`);
			unlinkSync(this.paths.socket);
		}
		const server = createServer((socket) => this.handleSocket(socket));
		this.server = server;
		try {
			await new Promise<void>((resolveListen, rejectListen) => {
				const onError = (error: Error) => {
					server.off("listening", onListening);
					rejectListen(error);
				};
				const onListening = () => {
					server.off("error", onError);
					resolveListen();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(this.paths.socket);
			});
			chmodSync(this.paths.socket, 0o600);
			writeEndpoint(this.paths.endpoint, { version: HOST_PROTOCOL_VERSION, pid: this.pid, socketPath: this.paths.socket, token: this.claim.token, createdAt: new Date().toISOString() });
			announce({ pid: this.pid, socketPath: this.paths.socket });
		} catch (error) {
			server.close();
			this.removeTransportFiles();
			throw error;
		}
		this.scheduleRetirement();
	}

	private handleSocket(socket: Socket): void {
		const link: ClientLink = { decoder: new HostFrameDecoder(), controllers: new Map(), helloReceived: false };
		this.links.set(socket, link);
		socket.setNoDelay(true);
		socket.setTimeout(HOST_HELLO_TIMEOUT_MS, () => socket.destroy());
		socket.on("data", (chunk: Buffer) => this.onData(socket, link, chunk));
		socket.on("error", () => socket.destroy());
		socket.on("close", () => this.onDisconnect(socket, link));
	}

	private onData(socket: Socket, link: ClientLink, chunk: Buffer): void {
		let messages: HostClientMessage[];
		try {
			messages = link.decoder.push(chunk).map((message) => parseHostClientMessage(message));
		} catch {
			socket.destroy();
			return;
		}
		for (const message of messages) this.onMessage(socket, link, message);
	}

	private onMessage(socket: Socket, link: ClientLink, message: HostClientMessage): void {
		if (!link.helloReceived) {
			if (message.kind !== "hello") {
				socket.destroy();
				return;
			}
			this.completeHello(socket, link, message);
			return;
		}
		if (message.kind === "cancel") {
			link.controllers.get(message.id)?.abort(new Error("durable host wait was cancelled by its client"));
			return;
		}
		if (message.kind !== "request") {
			socket.destroy();
			return;
		}
		void this.dispatch(socket, link, message);
	}

	private completeHello(socket: Socket, link: ClientLink, hello: HostHello): void {
		const matches = hello.version === HOST_PROTOCOL_VERSION
			&& hostTokensMatch(hello.token, this.claim.token)
			&& hello.metadata.storageId === this.metadata.storageId
			&& resolve(hello.metadata.cwd) === resolve(this.metadata.cwd);
		if (!matches) {
			socket.destroy();
			return;
		}
		link.helloReceived = true;
		socket.setTimeout(0);
		this.send(socket, { kind: "welcome", version: HOST_PROTOCOL_VERSION, pid: this.pid, storageId: this.metadata.storageId, socketPath: this.paths.socket });
	}

	private async dispatch(socket: Socket, link: ClientLink, request: HostRequestMessage): Promise<void> {
		const controller = new AbortController();
		const cancelable = isCancelableHostWait(request.method, request.params);
		if (cancelable) link.controllers.set(request.id, controller);
		let response: HostServerMessage;
		try {
			const result = await this.runtime.request(request.method, request.params, request.id, cancelable ? controller.signal : undefined);
			response = { kind: "response", id: request.id, ok: true, result };
		} catch (error) {
			response = { kind: "response", id: request.id, ok: false, error: { message: reasonText(error), code: error instanceof HostError ? error.code : "internal" } };
		} finally {
			if (cancelable) link.controllers.delete(request.id);
		}
		this.send(socket, response);
	}

	private send(socket: Socket, message: HostServerMessage): void {
		if (socket.destroyed) return;
		let frame: Buffer;
		try {
			frame = encodeHostFrame(message);
		} catch (error) {
			if (message.kind !== "response" || !message.ok) {
				socket.destroy();
				return;
			}
			const fallback: HostServerMessage = { kind: "response", id: message.id, ok: false, error: { message: `durable host response could not be encoded (${reasonText(error)})`, code: "internal" } };
			try {
				frame = encodeHostFrame(fallback);
			} catch {
				socket.destroy();
				return;
			}
		}
		socket.write(frame);
	}

	private onDisconnect(socket: Socket, link: ClientLink): void {
		this.links.delete(socket);
		for (const controller of link.controllers.values()) controller.abort(new Error("durable host client disconnected during an observational wait"));
		link.controllers.clear();
		if (link.helloReceived) this.scheduleRetirement();
	}

	private attached(): number {
		let count = 0;
		for (const link of this.links.values()) if (link.helloReceived) count += 1;
		return count;
	}

	private scheduleRetirement(): void {
		if (this.closing || this.idleMs === 0) return;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.onIdleCheck(), Math.max(1, this.idleMs));
	}

	private onIdleCheck(): void {
		this.idleTimer = undefined;
		if (this.closing || this.attached() > 0) return;
		if (!this.runtime.isIdle()) {
			this.scheduleRetirement();
			return;
		}
		void this.shutdown().catch(() => {});
	}

	close(): Promise<void> {
		return this.shutdown();
	}

	private shutdown(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.performShutdown();
		return this.closePromise;
	}

	private async performShutdown(): Promise<void> {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
		const server = this.server;
		let closed: Promise<void> | undefined;
		if (server) closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		for (const socket of [...this.links.keys()]) socket.destroy();
		this.links.clear();
		if (closed) await closed;
		try {
			await this.runtime.close();
			this.claim.release();
			this.removeTransportFiles();
			this.resolveDone();
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.rejectDone(failure);
			throw failure;
		}
	}

	private removeTransportFiles(): void {
		for (const path of [this.paths.endpoint, this.paths.socket]) {
			try {
				unlinkSync(path);
			} catch (error) {
				if (errnoCode(error) !== "ENOENT") throw error;
			}
		}
	}
}

function claimRecord(identity: ClaimIdentity, token: string): ClaimRecord {
	return { token, pid: process.pid, host: hostname(), sessionId: identity.sessionId, cwd: resolve(identity.cwd), createdAt: new Date().toISOString() };
}

function cleanupClaim(claim: HeldClaim): void {
	try {
		claim.release();
	} catch {
		// The claim is left in place when it changed; the next host replaces it by classification.
	}
}

/**
 * Take the storage claim, then create the runtime, then listen. Keeping the
 * claim ahead of runtime creation prevents a losing launch from opening
 * schedulers for a storage another host owns.
 */
export async function runHost(createRuntime: HostRuntimeFactory, options: RunHostOptions): Promise<HostProcess> {
	const metadata = parseHostMetadata(options.metadata);
	const idleMs = resolveIdleMs(options.idleMs, options.env ?? process.env);
	const paths = hostPaths(metadata);
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	chmodSync(paths.directory, 0o700);
	mkdirSync(dirname(paths.claim), { recursive: true, mode: 0o700 });
	const token = newHostToken();
	const claim = takeClaim(paths.claim, paths.identity, claimRecord(paths.identity, token));
	let runtime: HostRuntime | undefined;
	try {
		runtime = await createRuntime();
		const host = new HostProcessServer(runtime, metadata, paths, claim, idleMs);
		await host.start(options.announceReady ?? ((ready) => process.stdout.write(formatHostReady(ready))));
		return host;
	} catch (error) {
		if (runtime) {
			try {
				await runtime.close();
			} catch {
				// Retain the failure that stopped the host.
			}
		}
		cleanupClaim(claim);
		throw error;
	}
}
