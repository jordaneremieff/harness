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
import { fileURLToPath } from "node:url";
import type { JsonValue, ServiceCall, ServiceSubscriptionSnapshot } from "@earendil-works/chord";
import { Client, ServerError, type ServiceSubscription } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { observeClaim, readClaimFile } from "./claims.ts";
import {
	HOST_CHANGE_SERVICE_ID,
	HOST_OBSERVE_MEMBER,
	HOST_RUNTIME_VERSION,
	HOST_RUNTIME_VERSION_MEMBER,
	HOST_SERVICE_ID,
	HostError,
	hostMethodMinVersion,
	hostRequestVersionError,
	newerHostError,
	hostPaths,
	isCancelableHostWait,
	isRetrySafeHostMethod,
	observationServiceId,
	parseHostMetadata,
	parseHostReadyLine,
	type HostMetadata,
	type HostPaths,
	type HostReady,
} from "./host-protocol.ts";
import { frameFromOps, isObservationFrame, type ObservationFrame } from "./live-frames.ts";
import { AgentConversationSummarySchema, ListRowSchema, observationSchema, structuredObservation } from "./observation-schema.ts";

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
// An unresolved project trust decision includes time for the primary UI answer.
const TRUST_LAUNCH_TIMEOUT_MS = 330_000;
const DEFAULT_RETRY_ATTEMPTS = 1;
const STDIO_CAPTURE_LIMIT = 64 * 1024;
const CONNECT_WAIT_LIMIT_MS = 5000;
const launchedChildren = new Map<number, ChildProcess>();
const launchedReadiness = new WeakMap<ChildProcess, Promise<HostReady>>();

/** Pi exposes codec failures by Error.name, but does not re-export their class from pi-client. */
function isProtocolValidationError(error: unknown): error is Error {
	return error instanceof Error && error.name === "ProtocolValidationError";
}

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

/** What one live observation reads: one conversation, or the storage's live task graph. */
export type HostObservationScope = { readonly scope: "conversation"; readonly sessionId: string; readonly conversationId?: number } | { readonly scope: "tasks"; readonly sessionId: string };

/** One open live observation. `frame` is the latest delivered reading, never a cached cold copy. */
/** One live-frame listener state: normal frames are `live`, a dropped connection is `unavailable`. */
export type HostObservationState = "live" | "unavailable";
/** One live-frame listener. An `unavailable` call carries the last known frame, or undefined. */
export type HostObservationListener = (frame: ObservationFrame | undefined, fresh: boolean, state?: HostObservationState) => void;

export interface HostObservation {
	readonly scope: HostObservationScope;
	readonly frame: ObservationFrame;
	/** Replay the current frame, or unavailable for a retired observation; later loss reports unavailable once. */
	onFrame(listener: HostObservationListener): () => void;
	close(): Promise<void>;
}

/** One client link to a durable host. Access is limited by the private Unix directory and socket permissions. */
export interface HostConnection {
	readonly pid: number;
	readonly socketPath: string;
	readonly storageId: string;
	readonly metadata: HostMetadata;
	/** Runtime contract version; 0 for an older host that predates the handshake. */
	readonly runtimeVersion: number;
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
	/**
	 * Open one host-owned live observation. Frames arrive as published state,
	 * coalesced by the host; cancelling the returned handle or aborting `signal`
	 * closes only this observation. A connection recovery reopens a fresh
	 * subscription from the host's current snapshot.
	 */
	observe?(scope: HostObservationScope, options?: { readonly signal?: AbortSignal }): Promise<HostObservation>;
	/** Called once when this connection closes permanently; returns an unsubscribe function. */
	onClose(callback: () => void): () => void;
	close(): Promise<void>;
}

interface Link {
	readonly client: Client;
	readonly pid: number;
	readonly socketPath: string;
	readonly runtimeVersion: number;
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

interface ObservationEntry {
	readonly id: number;
	readonly scope: HostObservationScope;
	readonly listeners: Set<HostObservationListener>;
	token: string | undefined;
	subscription: ServiceSubscription | undefined;
	frame: ObservationFrame | undefined;
	disposed: boolean;
	removeAbort: () => void;
}

/** One observation request's parameters; the token keys the host's subscription. */
function observationParams(scope: HostObservationScope, token: string): Record<string, unknown> {
	return {
		token,
		scope: scope.scope,
		sessionId: scope.sessionId,
		...(scope.scope === "conversation" && scope.conversationId !== undefined ? { conversationId: scope.conversationId } : {}),
	};
}

/** Latest frame carried in the subscription baseline, when the host published one. */
function frameFromSnapshot(snapshot: ServiceSubscriptionSnapshot): ObservationFrame | undefined {
	for (const instance of snapshot.instances) {
		for (const member of instance.members) {
			if (member.kind !== "state" || member.name !== HOST_OBSERVE_MEMBER) continue;
			const frame = frameFromOps(member.ops as unknown as readonly unknown[]);
			if (frame !== undefined) return frame;
		}
	}
	return undefined;
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
	const client = new Client({ serverId, transportFactory: createUnixTransportFactory({ path: socketPath }) });
	const deadline = AbortSignal.timeout(CONNECT_WAIT_LIMIT_MS);
	const abort = (): void => client.disconnect("Durable host connect or handshake did not complete before its deadline");
	deadline.addEventListener("abort", abort, { once: true });
	try { await client.connect(); return client; }
	catch (error) { await client.dispose(); throw error; }
	finally { deadline.removeEventListener("abort", abort); }
}

/** Owned launches have a readiness event. A foreign launch gets one attach attempt, never timed retries. */
async function connectWhenReady(paths: HostPaths): Promise<Client> {
	const child = launchedChildren.get(claimPid(paths));
	if (child) await launchedReadiness.get(child);
	try { return await connectClient(paths.serverId, paths.socket); }
	catch (error) {
		if (!child && observeClaim(paths.claim, paths.identity).kind === "live")
			throw new HostError("The host is starting elsewhere or its live endpoint is unavailable. This Pi has no readiness event for that process. Retry the read after startup; no replacement was started.", "unavailable", { cause: error });
		throw error;
	}
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
	if (child.pid !== undefined) {
		const pid = child.pid;
		launchedChildren.set(pid, child);
		child.once("exit", () => { launchedChildren.delete(pid); });
	}
	const readiness = waitForReady(child, timeoutMs);
	launchedReadiness.set(child, readiness);
	const ready = await readiness;
	detachChild(child);
	const paths = hostPaths(metadata);
	try {
		if (ready.socketPath !== paths.socket) throw new Error(`durable host readiness path does not match the storage endpoint: ${ready.socketPath}`);
		const client = await connectClient(paths.serverId, paths.socket);
		return { client, pid: ready.pid, socketPath: paths.socket, runtimeVersion: ready.runtimeVersion };
	} catch (error) {
		child.kill("SIGKILL");
		throw error;
	}
}

/** Attach only to a live host. */
async function attachLink(metadata: HostMetadata): Promise<Link> {
	const paths = hostPaths(metadata);
	if (observeClaim(paths.claim, paths.identity).kind !== "live") throw new Error(`no live durable host for ${metadata.storageId}`);
	const client = await connectWhenReady(paths);
	try {
		return { client, pid: claimPid(paths), socketPath: paths.socket, runtimeVersion: await readRuntimeVersion(client, paths.serverId) };
	} catch (error) {
		const answered = client.connected;
		await client.dispose().catch(() => undefined);
		if (answered) throw new HostError(`Host runtime version unavailable: ${toError(error).message}`, "unavailable", { cause: error });
		throw error;
	}
}

/**
 * Read one live host's runtime contract version. An older host answers the
 * member with its unknown-method error and reads as version 0; that is version
 * detection for a live peer, not a fallback for retired data.
 */
async function readRuntimeVersion(client: Client, serverId: string): Promise<number> {
	try {
		const value = await client.request({ serverId }, { serviceId: HOST_SERVICE_ID, member: HOST_RUNTIME_VERSION_MEMBER, args: [] }, AbortSignal.timeout(CONNECT_WAIT_LIMIT_MS));
		const version = (value as { version?: unknown } | undefined)?.version;
		if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0) throw new Error("host runtime version is malformed");
		return version;
	} catch (error) {
		if (error instanceof Error && error.message.includes("unknown durable host method")) return 0;
		throw error;
	}
}

/** Prove release at a close completion or owned process exit, without filesystem notifications. */
export function waitForHostRelease(metadata: HostMetadata, options: { signal?: AbortSignal; after?: Promise<unknown> } = {}): Promise<void> {
	const paths = hostPaths(metadata);
	const deadline = AbortSignal.timeout(CONNECT_WAIT_LIMIT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	return new Promise<void>((resolveReleased, rejectReleased) => {
		const child = launchedChildren.get(claimPid(paths));
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			child?.off("exit", exited);
			signal.removeEventListener("abort", abort);
			if (error) rejectReleased(error);
			else resolveReleased();
		};
		const check = (): boolean => {
			const owner = observeClaim(paths.claim, paths.identity);
			if (owner.kind === "absent" || owner.kind === "dead") finish();
			else if (owner.kind === "unknown") finish(new Error(`durable host writer claim cannot be verified: ${owner.error}`));
			return settled;
		};
		const exited = (): void => {
			if (!check()) finish(new Error("The previous host exited but a live writer still owns the claim"));
		};
		const completed = (): void => {
			if (!check() && !child) finish(new Error("Host close completed without confirmed writer release; replacement is blocked"));
		};
		const abort = (): void => finish(new Error(`durable host writer release was not confirmed before observation ended (claim: ${observeClaim(paths.claim, paths.identity).kind})`, { cause: signal.reason }));
		if (signal.aborted) { abort(); return; }
		check();
		if (settled) return;
		if (!child && !options.after) {
			finish(new Error("No process-exit or close-completion event is available for this live foreign host; writer release is unconfirmed"));
			return;
		}
		child?.once("exit", exited);
		void options.after?.then(completed, completed);
		signal.addEventListener("abort", abort, { once: true });
		check();
	});
}

/** Attach to a live host or launch one when the claim is absent, stale, or dead. */
async function acquireLink(metadata: HostMetadata, options: HostLaunchOptions): Promise<Link> {
	const paths = hostPaths(metadata);
	const observation = observeClaim(paths.claim, paths.identity);
	if (observation.kind === "unknown") throw new Error(`durable host writer claim cannot be replaced: ${observation.error}`);
	if (observation.kind === "live") {
		try {
			return await attachLink(metadata);
		} catch (error) {
			if (error instanceof HostError || error instanceof ServerError || isProtocolValidationError(error)) throw error;
			// A killed owner still reads as live until the process is reaped; wait
			// for the claim to release, then launch the replacement.
			await waitForHostRelease(metadata, { signal: AbortSignal.timeout(Math.min(options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS, CONNECT_WAIT_LIMIT_MS)) });
		}
	}
	try {
		return await launchRunner(metadata, options);
	} catch (launchError) {
		// Another process may have won a concurrent launch; join its host.
		if (observeClaim(paths.claim, paths.identity).kind === "live") return attachLink(metadata);
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
	private runtimeVersionValue: number;
	private readonly pending = new Map<string, PendingCall>();
	private readonly changeEntries = new Map<number, ChangeEntry>();
	private readonly observationEntries = new Map<number, ObservationEntry>();
	private nextObservationId = 1;
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
		this.runtimeVersionValue = link.runtimeVersion;
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

	get runtimeVersion(): number {
		return this.runtimeVersionValue;
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
		this.runtimeVersionValue = link.runtimeVersion;
		this.unsubscribeState = link.client.onConnectionStateChange((change) => {
			if (this.closedValue || link.client !== this.client) return;
			if (change.state === "disconnected") this.startRecovery(change.error ?? new Error("durable host connection was lost"));
		});
	}

	request(method: string, params?: unknown, options: HostRequestOptions = {}): Promise<unknown> {
		if (this.closedValue) return Promise.reject(new Error("durable host connection is closed"));
		if (!isWellFormedRequestText(method)) return Promise.reject(new HostError("host request method must be 1..128 well-formed characters", "invalid"));
		if (options.requestId !== undefined && !isWellFormedRequestText(options.requestId)) return Promise.reject(new HostError("host requestId must be 1..128 well-formed characters", "invalid"));
		const versionError = hostRequestVersionError(method, this.runtimeVersionValue);
		if (versionError) return Promise.reject(versionError);
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
				if (!this.pending.delete(call.id)) return;
				try { call.resolve(this.checkedRead(call.method, result)); }
				catch (error) { call.reject(toError(error)); }
			},
			(error) => this.handleFailure(call, error),
		);
	}

	private checkedRead(method: string, value: unknown): unknown {
		if (this.runtimeVersionValue <= HOST_RUNTIME_VERSION) return value;
		try {
			if (method === "status" || method === "inspect") return structuredObservation(observationSchema(method), value);
			if (method === "dashboard") {
				if (!Array.isArray(value)) throw new Error("dashboard is not an array");
				for (const row of value) structuredObservation(AgentConversationSummarySchema, row);
			}
			if (method === "list") this.checkListRows(value);
			return value;
		} catch { throw newerHostError(this.runtimeVersionValue, `The host returned unsupported ${method} data.`); }
	}

	private checkListRows(value: unknown): void {
		const items = (value as { items?: unknown } | null)?.items;
		if (!Array.isArray(items)) throw new Error("list has no items");
		for (const row of items) structuredObservation(ListRowSchema, { ...row, sessionId: row?.identity, storageId: this.storageId, cwd: this.metadata.cwd });
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

	/**
	 * Open one live observation. The returned handle owns one subscription; its
	 * close, an aborted `signal`, or the connection closing stops frame delivery.
	 * A recovery reopens a fresh token and subscription from the host snapshot.
	 */
	async observe(scope: HostObservationScope, options: { readonly signal?: AbortSignal } = {}): Promise<HostObservation> {
		if (this.closedValue) throw new Error("durable host connection is closed");
		const versionError = hostRequestVersionError("observe-open", this.runtimeVersionValue);
		if (versionError) throw versionError;
		const signal = options.signal;
		if (signal?.aborted) throw abortReason(signal);
		const id = this.nextObservationId;
		this.nextObservationId += 1;
		const entry: ObservationEntry = { id, scope, listeners: new Set(), token: undefined, subscription: undefined, frame: undefined, disposed: false, removeAbort: () => {} };
		this.observationEntries.set(id, entry);
		try {
			await this.bindObservation(entry);
		} catch (error) {
			this.observationEntries.delete(id);
			throw toError(error);
		}
		const frame = entry.frame;
		if (frame === undefined) {
			await this.releaseObservation(id);
			throw new Error("durable host observation produced no frame");
		}
		if (signal) {
			const onAbort = () => {
				void this.releaseObservation(id);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			entry.removeAbort = () => signal.removeEventListener("abort", onAbort);
		}
		return {
			scope,
			get frame(): ObservationFrame {
				const current = entry.frame;
				if (current === undefined) throw new Error("durable host observation has no current frame");
				return current;
			},
			onFrame: (listener) => {
				if (entry.disposed) {
					try { listener(entry.frame, false, "unavailable"); }
					catch { /* A listener failure never changes observation state. */ }
					return () => {};
				}
				entry.listeners.add(listener);
				const current = entry.frame;
				if (current !== undefined) {
					try {
						listener(current, true, "live");
					} catch {
						// One listener failure never stops the others.
					}
				}
				return () => {
					entry.listeners.delete(listener);
				};
			},
			close: () => this.releaseObservation(id),
		};
	}

	/** Reopen one observation on the current client link and deliver its baseline. */
	private async bindObservation(entry: ObservationEntry): Promise<void> {
		if (this.closedValue || entry.disposed) return;
		const token = randomUUID();
		const opened = (await this.client.request(
			{ serverId: this.serverId },
			{ serviceId: HOST_SERVICE_ID, member: "observe-open", args: [observationParams(entry.scope, token) as JsonValue, token] },
		)) as { frame?: unknown } | undefined;
		if (this.closedValue || entry.disposed) {
			this.closeObservationToken(token);
			return;
		}
		const subscription = await this.client.subscribeService({ serverId: this.serverId }, observationServiceId(token), "singleton", (update) => {
			if (update.type !== "state") return;
			const frame = frameFromOps(update.ops as unknown as readonly unknown[]);
			if (frame !== undefined) this.deliverObservation(entry, frame, false);
		}).catch((error: unknown) => {
			this.closeObservationToken(token);
			throw error;
		});
		if (this.closedValue || entry.disposed) {
			await subscription.dispose().catch(() => undefined);
			this.closeObservationToken(token);
			return;
		}
		const openedFrame = isObservationFrame(opened?.frame) ? opened.frame : undefined;
		const baseline = frameFromSnapshot(subscription.snapshot) ?? openedFrame;
		const previous = entry.subscription;
		entry.token = token;
		entry.subscription = subscription;
		if (baseline !== undefined) entry.frame = baseline;
		if (previous) await previous.dispose().catch(() => undefined);
		subscription.start();
		if (baseline !== undefined) this.deliverObservation(entry, baseline, true);
	}

	private deliverObservation(entry: ObservationEntry, frame: ObservationFrame, fresh: boolean, state: HostObservationState = "live"): void {
		entry.frame = frame;
		for (const listener of [...entry.listeners]) {
			try {
				listener(frame, fresh, state);
			} catch {
				// One listener failure never stops the others.
			}
		}
	}

	private async releaseObservation(id: number): Promise<void> {
		const entry = this.observationEntries.get(id);
		if (!entry || entry.disposed) return;
		entry.disposed = true;
		entry.removeAbort();
		this.observationEntries.delete(id);
		const token = entry.token;
		entry.token = undefined;
		const subscription = entry.subscription;
		entry.subscription = undefined;
		if (subscription) await subscription.dispose().catch(() => undefined);
		if (token !== undefined) this.closeObservationToken(token);
	}

	private closeObservationToken(token: string): void {
		if (this.closedValue) return;
		if (hostMethodMinVersion("observe-close") > this.runtimeVersionValue) return;
		void this.client
			.request({ serverId: this.serverId }, { serviceId: HOST_SERVICE_ID, member: "observe-close", args: [{ token }, randomUUID()] })
			.catch(() => undefined);
	}

	private notifyObservationUnavailable(entry: ObservationEntry): void {
		for (const listener of [...entry.listeners]) {
			try { listener(entry.frame, false, "unavailable"); }
			catch { /* One listener failure never stops the others. */ }
		}
		entry.listeners.clear();
	}

	/** Retire a failed observation without closing the recovered transport. */
	private failObservation(entry: ObservationEntry): void {
		if (entry.disposed) return;
		void this.releaseObservation(entry.id);
		this.notifyObservationUnavailable(entry);
	}

	private disposeObservationEntries(): void {
		for (const entry of [...this.observationEntries.values()]) {
			entry.disposed = true;
			entry.removeAbort();
			const subscription = entry.subscription;
			entry.subscription = undefined;
			if (subscription) void subscription.dispose().catch(() => undefined);
			this.notifyObservationUnavailable(entry);
		}
		this.observationEntries.clear();
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
		// Encoder validation leaves the link connected; a decoder failure closes it.
		if (isProtocolValidationError(error) && this.client.connected) {
			this.pending.delete(call.id);
			call.reject(toError(error));
			return;
		}
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
		const retryable = calls.filter((call) => isRetrySafeHostMethod(call.method) && call.attempts < this.retryAttempts);
		if (retryable.length === 0 && this.observationEntries.size === 0) {
			this.shutdownLocal(cause);
			return;
		}
		let link: Link;
		try {
			// An open observation reconnects to a live host only. Launch authority belongs to
			// the manager's bounded recovery pool; an observation never relaunches a dead host.
			link = retryable.length > 0 ? await acquireLink(this.metadata, this.launchOptions) : await attachLink(this.metadata);
		} catch (error) {
			this.shutdownLocal(toError(error));
			return;
		}
		const previous = this.client;
		this.installClient(link);
		await previous.dispose().catch(() => undefined);
		for (const entry of this.changeEntries.values()) void this.bindChangeEntry(entry).catch(() => undefined);
		// A recovered observation starts from the host's current snapshot; the new
		// subscription's baseline replaces any stale frame.
		for (const entry of [...this.observationEntries.values()]) void this.bindObservation(entry).catch(() => this.failObservation(entry));
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
		this.disposeObservationEntries();
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
		this.disposeObservationEntries();
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
	return connectLink(parsed, await attachLink(parsed), options);
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
