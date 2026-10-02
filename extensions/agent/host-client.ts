/**
 * agent/host-client: launch, attach, and call one durable host process.
 *
 * `acquireHost` attaches when a live writer claim exists and launches the
 * detached runner when the claim is absent, stale, or dead. The connection
 * speaks the public Pi service protocol over a `pi-client` Unix transport and
 * keeps the storage host's request surface: stable request IDs, automatic
 * recovery and resend of retry-safe methods, and caller abort that reaches the
 * wire only for observational waits. Admitted Durable work is never cancelled.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JsonValue, ServiceCall } from "@earendil-works/chord";
import { Client, ServerError, type ServiceSubscription } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { observeClaim, readClaimFile } from "./claims.ts";
import {
	HOST_CHANGE_SERVICE_ID,
	HOST_SERVICE_ID,
	HostError,
	hostPaths,
	isCancelableHostWait,
	isRetrySafeHostMethod,
	parseHostMetadata,
	parseHostReadyLine,
	type HostMetadata,
	type HostPaths,
	type HostReady,
} from "./host-protocol.ts";

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
// An unresolved project trust decision includes time for the primary UI answer.
const TRUST_LAUNCH_TIMEOUT_MS = 330_000;
const DEFAULT_RETRY_ATTEMPTS = 1;
const STDIO_CAPTURE_LIMIT = 64 * 1024;
const CONNECT_WAIT_LIMIT_MS = 5000;
const CONNECT_RETRY_INTERVAL_MS = 25;

export interface HostRequestOptions {
	/** Durable request ID. Resends reuse it; for `submit` the runtime maps it to the Durable request ID. */
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

/** One client link to a durable host. Access is limited by the private Unix directory and socket permissions. */
export interface HostConnection {
	readonly pid: number;
	readonly socketPath: string;
	readonly storageId: string;
	readonly metadata: HostMetadata;
	readonly closed: boolean;
	request(method: string, params?: unknown, options?: HostRequestOptions): Promise<unknown>;
	/**
	 * Subscribe to coalesced host write notifications. The listener runs once for
	 * the current state and then after observed writes. Cancelling the returned
	 * function or aborting `signal` stops notifications without cancelling
	 * admitted Durable work. A connection recovery re-subscribes automatically.
	 * Optional so structural test doubles remain valid; every acquired
	 * connection implements it.
	 */
	subscribeChanges?(listener: () => void, signal?: AbortSignal): Promise<() => void>;
	/** Called once when this connection closes permanently; returns an unsubscribe function. */
	onClose(callback: () => void): () => void;
	close(): Promise<void>;
}

interface Link {
	readonly client: Client;
	readonly pid: number;
	readonly socketPath: string;
}

interface PendingCall {
	readonly id: string;
	readonly method: string;
	readonly params: unknown;
	readonly call: ServiceCall;
	readonly signal: AbortSignal | undefined;
	attempts: number;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	removeAbort: () => void;
}

interface ChangeEntry {
	readonly listener: () => void;
	readonly signal: AbortSignal | undefined;
	subscription: ServiceSubscription | undefined;
	disposed: boolean;
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

/** The owning process reported in the claim file; zero when the claim is unreadable. */
function claimPid(paths: HostPaths): number {
	try {
		const claim = readClaimFile(paths.claim).claim;
		if (claim !== null && typeof claim === "object" && "pid" in claim && typeof claim.pid === "number" && Number.isSafeInteger(claim.pid) && claim.pid > 0) return claim.pid;
	} catch {
		// An attached host may be mid-restart; the pid is diagnostic only.
	}
	return 0;
}

async function connectClient(serverId: string, socketPath: string): Promise<Client> {
	return Client.connect({ serverId, transportFactory: createUnixTransportFactory({ path: socketPath }) });
}

/** Bounded reconciliation for the short window between a winning claim and a listening socket. */
async function connectWithWait(paths: HostPaths, timeoutMs: number): Promise<Client> {
	const deadline = Date.now() + Math.min(Math.max(0, timeoutMs), CONNECT_WAIT_LIMIT_MS);
	let lastError: Error | undefined;
	for (;;) {
		try {
			return await connectClient(paths.serverId, paths.socket);
		} catch (error) {
			lastError = toError(error);
		}
		// A present socket that refuses means the owner is dead; only wait while the
		// endpoint is still absent.
		if (existsSync(paths.socket)) break;
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_INTERVAL_MS));
	}
	throw lastError ?? new Error(`durable host endpoint is missing at ${paths.socket}`);
}

/** Find the readiness line in already-captured stdout; a malformed matching line throws. */
function readyFromOutput(buffer: Buffer): HostReady | undefined {
	const lines = buffer.toString("utf8").split("\n");
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
				const ready = readyFromOutput(stdout);
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
	const timeoutMs = options.launchTimeoutMs ?? (metadata.trust === undefined ? TRUST_LAUNCH_TIMEOUT_MS : DEFAULT_LAUNCH_TIMEOUT_MS);
	const runner = options.runner ?? fileURLToPath(new URL("./durable-runner.ts", import.meta.url));
	const child = spawn(process.execPath, [runner, ...(options.runnerArgs ?? []), JSON.stringify(metadata)], {
		cwd: metadata.cwd,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...options.env },
	});
	const ready = await waitForReady(child, timeoutMs);
	detachChild(child);
	const paths = hostPaths(metadata);
	try {
		if (ready.socketPath !== paths.socket) throw new Error(`durable host readiness path does not match the storage endpoint: ${ready.socketPath}`);
		const client = await connectWithWait(paths, timeoutMs);
		return { client, pid: ready.pid, socketPath: paths.socket };
	} catch (error) {
		child.kill("SIGKILL");
		throw error;
	}
}

/** Attach only to a live host. */
async function attachLink(metadata: HostMetadata, options: HostLaunchOptions): Promise<Link> {
	const paths = hostPaths(metadata);
	if (observeClaim(paths.claim, paths.identity).kind !== "live") throw new Error(`no live durable host for ${metadata.storageId}`);
	const client = await connectWithWait(paths, options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS);
	return { client, pid: claimPid(paths), socketPath: paths.socket };
}

/** Wait for a dying host's claim to stop reading as live, bounded by the launch timeout. */
async function waitForClaimRelease(paths: HostPaths, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + Math.min(timeoutMs, CONNECT_WAIT_LIMIT_MS);
	while (observeClaim(paths.claim, paths.identity).kind === "live") {
		if (Date.now() >= deadline) throw new Error("durable host writer claim did not release before its deadline");
		await new Promise((resolveWait) => setTimeout(resolveWait, CONNECT_RETRY_INTERVAL_MS));
	}
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

class HostConnectionImpl implements HostConnection {
	readonly metadata: HostMetadata;
	readonly storageId: string;
	private readonly serverId: string;
	private client: Client;
	private pidValue: number;
	private socketPathValue: string;
	private readonly pending = new Map<string, PendingCall>();
	private readonly changeEntries = new Map<number, ChangeEntry>();
	private readonly pendingChanges = new Set<() => void>();
	private nextChangeId = 1;
	private changeScheduled = false;
	private readonly launchOptions: HostLaunchOptions;
	private readonly retryAttempts: number;
	private closedValue = false;
	private closeNotified = false;
	private readonly closeListeners = new Set<() => void>();
	private recovery: Promise<void> | undefined;
	private unsubscribeState: (() => void) | undefined;

	private constructor(metadata: HostMetadata, link: Link, launchOptions: HostLaunchOptions) {
		this.metadata = metadata;
		this.storageId = metadata.storageId;
		this.serverId = hostPaths(metadata).serverId;
		this.client = link.client;
		this.pidValue = link.pid;
		this.socketPathValue = link.socketPath;
		this.launchOptions = launchOptions;
		this.retryAttempts = launchOptions.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
		this.installClient(link);
	}

	static fromLink(metadata: HostMetadata, link: Link, launchOptions: HostLaunchOptions): HostConnection {
		return new HostConnectionImpl(metadata, link, launchOptions);
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

	private installClient(link: Link): void {
		this.unsubscribeState?.();
		this.client = link.client;
		this.pidValue = link.pid;
		this.socketPathValue = link.socketPath;
		this.unsubscribeState = link.client.onConnectionStateChange((change) => {
			if (this.closedValue || link.client !== this.client) return;
			if (change.state === "disconnected") this.startRecovery(change.error ?? new Error("durable host connection was lost"));
		});
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
				call: { serviceId: HOST_SERVICE_ID, member: method, args: [params === undefined ? null : (params as JsonValue), id] },
				signal,
				attempts: 0,
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
					rejectCall(abortReason(signal));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				call.removeAbort = () => signal.removeEventListener("abort", onAbort);
			}
			this.pending.set(id, call);
			const recovery = this.recovery;
			if (recovery) void recovery.then(() => this.startCall(call), () => this.startCall(call));
			else this.startCall(call);
		});
	}

	private startCall(call: PendingCall): void {
		if (this.closedValue || !this.pending.has(call.id)) return;
		// The wire sees a caller signal only for observational waits, so a
		// cancel envelope can never reach admitted Durable work.
		const wireSignal = isCancelableHostWait(call.method, call.params) ? call.signal : undefined;
		void this.client.request({ serverId: this.serverId }, call.call, wireSignal).then(
			(result) => {
				if (this.pending.delete(call.id)) call.resolve(result);
			},
			(error) => this.handleFailure(call, error),
		);
	}

	async subscribeChanges(listener: () => void, signal?: AbortSignal): Promise<() => void> {
		if (this.closedValue) throw new Error("durable host connection is closed");
		if (signal?.aborted) throw abortReason(signal);
		const id = this.nextChangeId;
		this.nextChangeId += 1;
		const entry: ChangeEntry = { listener, signal, subscription: undefined, disposed: false, removeAbort: () => {} };
		this.changeEntries.set(id, entry);
		try {
			await this.bindChangeEntry(entry);
		} catch (error) {
			this.changeEntries.delete(id);
			throw toError(error);
		}
		if (signal) {
			const onAbort = () => {
				this.releaseChangeEntry(id);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			entry.removeAbort = () => signal.removeEventListener("abort", onAbort);
		}
		return () => {
			this.releaseChangeEntry(id);
		};
	}

	/** Bind or re-bind one logical subscription to the current client link. */
	private async bindChangeEntry(entry: ChangeEntry): Promise<void> {
		if (this.closedValue || entry.disposed) return;
		const subscription = await this.client.subscribeService(
			{ serverId: this.serverId },
			HOST_CHANGE_SERVICE_ID,
			"singleton",
			() => this.queueChange(entry.listener),
			entry.signal,
		);
		if (this.closedValue || entry.disposed) {
			await subscription.dispose().catch(() => undefined);
			return;
		}
		const previous = entry.subscription;
		if (previous) await previous.dispose().catch(() => undefined);
		entry.subscription = subscription;
		subscription.start();
		queueMicrotask(() => {
			if (!this.closedValue && !entry.disposed) entry.listener();
		});
	}

	private releaseChangeEntry(id: number): void {
		const entry = this.changeEntries.get(id);
		if (!entry) return;
		entry.disposed = true;
		entry.removeAbort();
		this.changeEntries.delete(id);
		this.pendingChanges.delete(entry.listener);
		const subscription = entry.subscription;
		entry.subscription = undefined;
		if (subscription) void subscription.dispose().catch(() => undefined);
	}

	private disposeChangeEntries(): void {
		this.pendingChanges.clear();
		for (const entry of [...this.changeEntries.values()]) {
			entry.disposed = true;
			entry.removeAbort();
			const subscription = entry.subscription;
			entry.subscription = undefined;
			if (subscription) void subscription.dispose().catch(() => undefined);
		}
		this.changeEntries.clear();
	}

	/** Coalesce a burst of write notifications into one listener call per turn. */
	private queueChange(listener: () => void): void {
		if (this.closedValue) return;
		this.pendingChanges.add(listener);
		if (this.changeScheduled) return;
		this.changeScheduled = true;
		queueMicrotask(() => {
			this.changeScheduled = false;
			const callbacks = [...this.pendingChanges];
			this.pendingChanges.clear();
			for (const callback of callbacks) {
				if (!this.closedValue) callback();
			}
		});
	}

	private handleFailure(call: PendingCall, error: unknown): void {
		if (!this.pending.has(call.id)) return;
		if (error instanceof ServerError) {
			this.pending.delete(call.id);
			call.reject(new HostError(error.message, error.code));
			return;
		}
		if (call.signal?.aborted) {
			this.pending.delete(call.id);
			call.reject(abortReason(call.signal));
			return;
		}
		this.startRecovery(toError(error));
	}

	private startRecovery(cause: Error): void {
		if (this.closedValue || this.recovery) return;
		this.recovery = this.recover(cause).finally(() => {
			this.recovery = undefined;
		});
	}

	private async recover(cause: Error): Promise<void> {
		const calls = [...this.pending.values()];
		if (!calls.some((call) => isRetrySafeHostMethod(call.method) && call.attempts < this.retryAttempts)) {
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
		const previous = this.client;
		this.installClient(link);
		await previous.dispose().catch(() => undefined);
		for (const entry of this.changeEntries.values()) void this.bindChangeEntry(entry).catch(() => undefined);
		for (const call of calls) {
			if (!this.pending.has(call.id)) continue;
			if (!isRetrySafeHostMethod(call.method) || call.attempts >= this.retryAttempts) {
				this.pending.delete(call.id);
				call.reject(cause);
				continue;
			}
			call.attempts += 1;
			this.startCall(call);
		}
	}

	private shutdownLocal(error: Error): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.unsubscribeState?.();
		this.unsubscribeState = undefined;
		this.disposeChangeEntries();
		this.rejectAll(error);
		void this.client.dispose().catch(() => undefined);
		this.notifyClosed();
	}

	private rejectAll(error: Error): void {
		for (const call of [...this.pending.values()]) {
			this.pending.delete(call.id);
			call.reject(error);
		}
	}

	async close(): Promise<void> {
		if (this.closedValue) return;
		this.closedValue = true;
		this.unsubscribeState?.();
		this.unsubscribeState = undefined;
		this.disposeChangeEntries();
		this.rejectAll(new Error("durable host client closed the connection"));
		await this.client.dispose().catch(() => undefined);
		this.notifyClosed();
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
