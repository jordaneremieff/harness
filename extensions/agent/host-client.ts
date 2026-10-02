/**
 * agent/host-client: launch, attach, and call one durable host process.
 *
 * `acquireHost` attaches when a live writer claim exists and launches the
 * detached runner when the claim is absent, stale, or dead. A connection
 * authenticates with the endpoint token, addresses requests by stable ID, and
 * resends only retry-safe methods after a link failure. Aborting a call drops
 * the client-side promise; the host keeps working.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { observeClaim } from "./claims.ts";
import {
	HOST_PROTOCOL_VERSION,
	HostError,
	HostFrameDecoder,
	encodeHostFrame,
	hostPaths,
	parseHostEndpoint,
	parseHostMetadata,
	parseHostReadyLine,
	parseHostServerMessage,
	isCancelableHostWait,
	isRetrySafeHostMethod,
	type HostClientMessage,
	type HostEndpoint,
	type HostMetadata,
	type HostPaths,
	type HostRequestMessage,
	type HostReady,
	type HostServerMessage,
	type HostWelcome,
} from "./host-protocol.ts";

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_ATTEMPTS = 1;
const STDIO_CAPTURE_LIMIT = 64 * 1024;
const ENDPOINT_READ_LIMIT = 64 * 1024;
const ENDPOINT_WAIT_INTERVAL_MS = 25;
const ENDPOINT_WAIT_LIMIT_MS = 5000;

export interface HostRequestOptions {
	/** Transport request ID. Resends reuse it; for `submit` the runtime maps it to the Durable request ID. */
	readonly requestId?: string;
	readonly signal?: AbortSignal;
}

export interface HostLaunchOptions {
	/** Runner entry path. Defaults to the sibling `durable-runner.ts`. */
	readonly runner?: string;
	/** Arguments between the runner entry and the metadata argument. */
	readonly runnerArgs?: readonly string[];
	/** Extra child environment; merged over the current environment. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Bound for spawn, readiness, connect, and handshake. Default 30000 ms. */
	readonly launchTimeoutMs?: number;
	/** Safe-method resend attempts after link loss. Default 1. */
	readonly retryAttempts?: number;
}

/** One authenticated client link to a durable host. */
export interface HostConnection {
	readonly pid: number;
	readonly socketPath: string;
	readonly storageId: string;
	readonly metadata: HostMetadata;
	readonly closed: boolean;
	request(method: string, params?: unknown, options?: HostRequestOptions): Promise<unknown>;
	/** Called once when this connection closes permanently; returns an unsubscribe function. */
	onClose(callback: () => void): () => void;
	close(): Promise<void>;
}

interface Link {
	readonly socket: Socket;
	readonly endpoint: HostEndpoint;
	readonly welcome: HostWelcome;
}

interface PendingCall {
	readonly id: string;
	readonly method: string;
	readonly params: unknown;
	resends: number;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	removeAbort: () => void;
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function abortReason(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	const error = new Error(reason === undefined ? "the durable host request was aborted" : String(reason));
	error.name = "AbortError";
	return error;
}

function appendBounded(buffer: Buffer, chunk: Buffer): Buffer {
	const next = Buffer.concat([buffer, chunk]);
	return next.length > STDIO_CAPTURE_LIMIT ? next.subarray(next.length - STDIO_CAPTURE_LIMIT) : next;
}

const INVALID_REQUEST_TEXT = /[\u0000-\u001f\u007f-\u009f]/u;

function isWellFormedRequestText(value: string): boolean {
	return value.length > 0 && value.length <= 128 && !INVALID_REQUEST_TEXT.test(value);
}

function connectSocket(path: string, timeoutMs: number): Promise<Socket> {
	return new Promise((resolveConnect, rejectConnect) => {
		const socket = connect(path);
		const timer = setTimeout(() => {
			socket.destroy();
			rejectConnect(new Error(`timed out connecting to durable host socket ${path}`));
		}, Math.max(1, timeoutMs));
		const onError = (error: Error) => {
			clearTimeout(timer);
			socket.destroy();
			rejectConnect(error);
		};
		socket.once("error", onError);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.off("error", onError);
			resolveConnect(socket);
		});
	});
}

/** Perform the hello handshake on a fresh socket and remove its temporary listeners. */
function handshake(metadata: HostMetadata, endpoint: HostEndpoint, socket: Socket, timeoutMs: number): Promise<HostWelcome> {
	return new Promise<HostWelcome>((resolveWelcome, rejectWelcome) => {
		const decoder = new HostFrameDecoder();
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("close", onClose);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			rejectWelcome(error);
		};
		const onData = (chunk: Buffer) => {
			let messages: HostServerMessage[];
			try {
				messages = decoder.push(chunk).map((message) => parseHostServerMessage(message));
			} catch {
				fail(new Error("durable host handshake frame is invalid"));
				return;
			}
			for (const message of messages) {
				if (message.kind !== "welcome" || message.version !== HOST_PROTOCOL_VERSION || message.storageId !== metadata.storageId) {
					fail(new Error("durable host handshake is invalid"));
					return;
				}
				if (settled) return;
				settled = true;
				cleanup();
				resolveWelcome(message);
				return;
			}
		};
		const onError = (error: Error) => fail(error);
		const onClose = () => fail(new Error("durable host closed during the handshake"));
		socket.on("data", onData);
		socket.on("error", onError);
		socket.on("close", onClose);
		timer = setTimeout(() => fail(new Error("durable host did not answer the handshake")), Math.max(1, timeoutMs));
		const hello: HostClientMessage = { kind: "hello", version: HOST_PROTOCOL_VERSION, token: endpoint.token, metadata };
		try {
			socket.write(encodeHostFrame(hello));
		} catch (error) {
			fail(toError(error));
		}
	});
}

class HostConnectionImpl implements HostConnection {
	readonly metadata: HostMetadata;
	readonly storageId: string;
	private socket: Socket;
	private endpoint: HostEndpoint;
	private decoder = new HostFrameDecoder();
	private readonly pending = new Map<string, PendingCall>();
	private readonly launchOptions: HostLaunchOptions;
	private readonly retryAttempts: number;
	private pidValue: number;
	private socketPathValue: string;
	private closedValue = false;
	private closeNotified = false;
	private readonly closeListeners = new Set<() => void>();
	private recovery: Promise<void> | undefined;

	private constructor(metadata: HostMetadata, endpoint: HostEndpoint, socket: Socket, welcome: HostWelcome, launchOptions: HostLaunchOptions) {
		this.metadata = metadata;
		this.storageId = metadata.storageId;
		this.endpoint = endpoint;
		this.socket = socket;
		this.pidValue = welcome.pid;
		this.socketPathValue = welcome.socketPath;
		this.launchOptions = launchOptions;
		this.retryAttempts = launchOptions.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
		this.installSocket(socket);
	}

	static fromLink(metadata: HostMetadata, link: Link, launchOptions: HostLaunchOptions): HostConnection {
		return new HostConnectionImpl(metadata, link.endpoint, link.socket, link.welcome, launchOptions);
	}

	get pid(): number {
		return this.pidValue;
	}

	get socketPath(): string {
		return this.socketPathValue;
	}

	get closed(): boolean {
		return this.closedValue;
	}

	onClose(callback: () => void): () => void {
		if (this.closeNotified) {
			queueMicrotask(callback);
			return () => {};
		}
		this.closeListeners.add(callback);
		return () => {
			this.closeListeners.delete(callback);
		};
	}

	private notifyClosed(): void {
		if (this.closeNotified) return;
		this.closeNotified = true;
		for (const listener of [...this.closeListeners]) listener();
		this.closeListeners.clear();
	}

	private installSocket(socket: Socket): void {
		socket.on("data", (chunk: Buffer) => {
			if (socket === this.socket) this.onData(chunk);
		});
		socket.on("error", () => {
			// 'close' follows and owns link loss.
		});
		socket.on("close", () => {
			if (socket === this.socket) this.onLinkClose();
		});
	}

	private onData(chunk: Buffer): void {
		let messages: HostServerMessage[];
		try {
			messages = this.decoder.push(chunk).map((message) => parseHostServerMessage(message));
		} catch {
			this.socket.destroy();
			return;
		}
		for (const message of messages) this.onMessage(message);
	}

	private onMessage(message: HostServerMessage): void {
		if (message.kind !== "response") {
			this.socket.destroy();
			return;
		}
		const call = this.pending.get(message.id);
		if (!call) return;
		this.pending.delete(message.id);
		if (message.ok) call.resolve(message.result);
		else call.reject(new HostError(message.error.message, message.error.code ?? "internal"));
	}

	private onLinkClose(): void {
		if (this.closedValue) return;
		const cause = new Error("durable host connection was lost");
		if (this.pending.size === 0) {
			this.closedValue = true;
			this.notifyClosed();
			return;
		}
		if (this.recovery) return;
		this.recovery = this.recover(cause).finally(() => {
			this.recovery = undefined;
		});
	}

	private async recover(cause: Error): Promise<void> {
		const calls = [...this.pending.values()];
		if (!calls.some((call) => isRetrySafeHostMethod(call.method) && call.resends < this.retryAttempts)) {
			this.shutdownLocal(cause);
			return;
		}
		let link: Link;
		try {
			link = await acquireLink(this.metadata, this.launchOptions);
		} catch (error) {
			this.shutdownLocal(toError(error));
			return;
		}
		this.socket = link.socket;
		this.endpoint = link.endpoint;
		this.decoder = new HostFrameDecoder();
		this.pidValue = link.welcome.pid;
		this.socketPathValue = link.welcome.socketPath;
		this.installSocket(link.socket);
		for (const call of calls) {
			if (!isRetrySafeHostMethod(call.method) || call.resends >= this.retryAttempts) {
				this.pending.delete(call.id);
				call.reject(cause);
				continue;
			}
			call.resends += 1;
			try {
				this.sendCall(call);
			} catch (error) {
				this.pending.delete(call.id);
				call.reject(toError(error));
			}
		}
	}

	private sendCall(call: PendingCall): void {
		const message: HostRequestMessage = { kind: "request", id: call.id, method: call.method, ...(call.params === undefined ? {} : { params: call.params }) };
		this.socket.write(encodeHostFrame(message));
	}

	/** Withdraw one observational wait; never touches admitted Durable work. */
	private sendCancel(id: string): void {
		if (this.closedValue || this.socket.destroyed) return;
		try {
			this.socket.write(encodeHostFrame({ kind: "cancel", id }));
		} catch {
			// The local rejection already settles the caller.
		}
	}

	private shutdownLocal(error: Error): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.rejectAll(error);
		this.socket.destroy();
		this.notifyClosed();
	}

	private rejectAll(error: Error): void {
		for (const call of [...this.pending.values()]) {
			this.pending.delete(call.id);
			call.reject(error);
		}
	}

	request(method: string, params?: unknown, options: HostRequestOptions = {}): Promise<unknown> {
		if (this.closedValue) return Promise.reject(new Error("durable host connection is closed"));
		if (!isWellFormedRequestText(method)) return Promise.reject(new HostError("host request method must be 1..128 well-formed characters", "invalid"));
		if (options.requestId !== undefined && !isWellFormedRequestText(options.requestId)) return Promise.reject(new HostError("host requestId must be 1..128 well-formed characters", "invalid"));
		const signal = options.signal;
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		const id = options.requestId ?? randomUUID();
		return new Promise<unknown>((resolveCall, rejectCall) => {
			const call: PendingCall = {
				id,
				method,
				params,
				resends: 0,
				resolve: (value) => {
					call.removeAbort();
					resolveCall(value);
				},
				reject: (error) => {
					call.removeAbort();
					rejectCall(error);
				},
				removeAbort: () => {},
			};
			if (signal) {
				const onAbort = () => {
					if (!this.pending.delete(id)) return;
					call.removeAbort();
					if (isCancelableHostWait(call.method, call.params)) this.sendCancel(id);
					rejectCall(abortReason(signal));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				call.removeAbort = () => signal.removeEventListener("abort", onAbort);
			}
			this.pending.set(id, call);
			const recovery = this.recovery;
			if (!recovery) {
				try {
					this.sendCall(call);
				} catch (error) {
					this.pending.delete(id);
					call.reject(toError(error));
				}
				return;
			}
			void recovery.then(() => {
				if (this.closedValue || !this.pending.has(id)) return;
				try {
					this.sendCall(call);
				} catch (error) {
					this.pending.delete(id);
					call.reject(toError(error));
				}
			});
		});
	}

	async close(): Promise<void> {
		if (this.closedValue) return;
		this.closedValue = true;
		this.rejectAll(new Error("durable host client closed the connection"));
		this.socket.destroy();
		this.notifyClosed();
	}
}

function readEndpoint(path: string): HostEndpoint {
	const stat = statSync(path, { throwIfNoEntry: false });
	if (!stat?.isFile()) throw new Error(`durable host endpoint is missing at ${path}`);
	if (stat.size > ENDPOINT_READ_LIMIT) throw new Error("durable host endpoint exceeds its read bound");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error("durable host endpoint is unreadable", { cause: error });
	}
	if (Buffer.byteLength(text, "utf8") > ENDPOINT_READ_LIMIT) throw new Error("durable host endpoint exceeds its read bound");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error("durable host endpoint is not valid JSON", { cause: error });
	}
	return parseHostEndpoint(value);
}

/**
 * Read the endpoint, allowing for the short window between a winning claim and
 * a written endpoint. The launch path never uses this wait: it follows the
 * readiness line instead.
 */
async function readEndpointWithWait(path: string, timeoutMs: number): Promise<HostEndpoint> {
	const deadline = Date.now() + Math.min(Math.max(0, timeoutMs), ENDPOINT_WAIT_LIMIT_MS);
	let lastError: Error | undefined;
	for (;;) {
		try {
			return readEndpoint(path);
		} catch (error) {
			lastError = toError(error);
		}
		if (Date.now() >= deadline) break;
		await new Promise((resolveWait) => setTimeout(resolveWait, ENDPOINT_WAIT_INTERVAL_MS));
	}
	throw lastError ?? new Error(`durable host endpoint is missing at ${path}`);
}

/** Find the readiness line in already-captured stdout; a malformed matching line throws. */
function readyFromOutput(text: string): HostReady | undefined {
	const lines = text.split("\n");
	for (let index = 0; index < lines.length - 1; index += 1) {
		const ready = parseHostReadyLine(lines[index]);
		if (ready) return ready;
	}
	return undefined;
}

function waitForReady(child: ChildProcess, timeoutMs: number): Promise<HostReady> {
	return new Promise<HostReady>((resolveReady, rejectReady) => {
		let stdout: Buffer = Buffer.alloc(0);
		let stderr: Buffer = Buffer.alloc(0);
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const detail = () => `stdout=${stdout.toString("utf8")}\nstderr=${stderr.toString("utf8")}`;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			child.kill("SIGKILL");
			rejectReady(error);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = appendBounded(stdout, chunk);
			if (settled) return;
			try {
				const ready = readyFromOutput(stdout.toString("utf8"));
				if (!ready) return;
				settled = true;
				if (timer) clearTimeout(timer);
				resolveReady(ready);
			} catch (error) {
				fail(toError(error));
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk);
		});
		child.once("error", (error) => fail(error));
		child.once("exit", (code, signal) => fail(new Error(`durable host exited before readiness (${code ?? signal ?? "unknown"})\n${detail()}`)));
		timer = setTimeout(() => fail(new Error(`durable host did not announce readiness within ${timeoutMs} ms\n${detail()}`)), Math.max(1, timeoutMs));
	});
}

function unrefStream(stream: NodeJS.ReadableStream | null): void {
	(stream as { unref?: () => void } | null)?.unref?.();
}

/** Keep the host after this process exits, without letting its pipes hold the event loop open. */
function detachChild(child: ChildProcess): void {
	child.unref();
	unrefStream(child.stdout);
	unrefStream(child.stderr);
	// Keep draining both pipes so the host never blocks on a full pipe.
	child.stdout?.on("data", () => {});
	child.stderr?.on("data", () => {});
}

async function launchRunner(metadata: HostMetadata, options: HostLaunchOptions): Promise<Link> {
	const timeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
	const runner = options.runner ?? fileURLToPath(new URL("./durable-runner.ts", import.meta.url));
	const child = spawn(process.execPath, [runner, ...(options.runnerArgs ?? []), JSON.stringify(metadata)], {
		cwd: metadata.cwd,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...options.env },
	});
	await waitForReady(child, timeoutMs);
	detachChild(child);
	try {
		const endpoint = readEndpoint(hostPaths(metadata).endpoint);
		const socket = await connectSocket(endpoint.socketPath, timeoutMs);
		return await finishLink(metadata, endpoint, socket, timeoutMs);
	} catch (error) {
		child.kill("SIGKILL");
		throw error;
	}
}

/** Complete a fresh socket with the hello handshake, or destroy it. */
async function finishLink(metadata: HostMetadata, endpoint: HostEndpoint, socket: Socket, timeoutMs: number): Promise<Link> {
	try {
		const welcome = await handshake(metadata, endpoint, socket, timeoutMs);
		return { socket, endpoint, welcome };
	} catch (error) {
		socket.destroy();
		throw error;
	}
}

/** Attach only to a live host. */
async function attachLink(metadata: HostMetadata, options: HostLaunchOptions): Promise<Link> {
	const paths = hostPaths(metadata);
	const observation = observeClaim(paths.claim, paths.identity);
	if (observation.kind !== "live") throw new Error(`no live durable host for ${metadata.storageId}`);
	const timeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
	const endpoint = await readEndpointWithWait(paths.endpoint, timeoutMs);
	const socket = await connectSocket(endpoint.socketPath, timeoutMs);
	return finishLink(metadata, endpoint, socket, timeoutMs);
}

/** Attach to a live host or launch one when the claim is absent, stale, or dead. */
async function acquireLink(metadata: HostMetadata, options: HostLaunchOptions): Promise<Link> {
	const paths = hostPaths(metadata);
	const observation = observeClaim(paths.claim, paths.identity);
	if (observation.kind === "unknown") throw new Error(`durable host writer claim cannot be replaced: ${observation.error}`);
	if (observation.kind === "live") {
		try {
			return await attachLink(metadata, options);
		} catch {
			// A killed owner still reads as live until the process is reaped; wait
			// for the claim to release, then launch the replacement.
			await waitForClaimRelease(paths, options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS).catch(() => {});
		}
	}
	try {
		return await launchRunner(metadata, options);
	} catch (launchError) {
		// Another process may have won a concurrent launch; join its host.
		if (observeClaim(paths.claim, paths.identity).kind === "live") return attachLink(metadata, options);
		throw launchError;
	}
}

/** Wait for a dying host's claim to stop reading as live, bounded by the launch timeout. */
async function waitForClaimRelease(paths: HostPaths, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + Math.min(timeoutMs, ENDPOINT_WAIT_LIMIT_MS);
	while (observeClaim(paths.claim, paths.identity).kind === "live") {
		if (Date.now() >= deadline) throw new Error("durable host writer claim did not release before its deadline");
		await new Promise((resolveWait) => setTimeout(resolveWait, ENDPOINT_WAIT_INTERVAL_MS));
	}
}

function connectLink(metadata: HostMetadata, link: Link, options: HostLaunchOptions): HostConnection {
	return HostConnectionImpl.fromLink(metadata, link, options);
}

/** Attach to a running host or launch a new one; never blocks on a stale claim. */
export async function acquireHost(metadata: HostMetadata, options: HostLaunchOptions = {}): Promise<HostConnection> {
	const parsed = parseHostMetadata(metadata);
	return connectLink(parsed, await acquireLink(parsed, options), options);
}

/** Attach to a running host and fail when none is live. */
export async function connectHost(metadata: HostMetadata, options: HostLaunchOptions = {}): Promise<HostConnection> {
	const parsed = parseHostMetadata(metadata);
	return connectLink(parsed, await attachLink(parsed, options), options);
}

/**
 * Read one snapshot without keeping a connection: acquire (which may relaunch
 * a dead host), request `snapshot`, and close. Other clients are unaffected.
 */
export async function snapshotHost(metadata: HostMetadata, params?: unknown, options: HostLaunchOptions = {}): Promise<unknown> {
	const connection = await acquireHost(metadata, options);
	try {
		return await connection.request("snapshot", params);
	} finally {
		await connection.close();
	}
}
