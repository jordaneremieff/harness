/**
 * agent/host-client: launch, attach, and call one durable host process.
 *
 * `acquireHost` first attaches to the exact endpoint, then lets a runner's
 * descriptor lease decide exclusion. Diagnostic records never prove ownership.
 * The connection uses the package-level Chord Unix transport and
 * keeps the storage host's request surface: stable request IDs, automatic
 * recovery and resend of retry-safe methods, and caller abort that stays local:
 * no request carries it to the wire, so admitted Durable work is never cancelled.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type FSWatcher, lstatSync, statSync, watch } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { awaitWithContext, withAbortSignal, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PluginError, isChordError } from "@earendil-works/chord";
import {
	connectTransport,
	type TransportClient,
	type TransportRequest,
	type TransportSubscription,
} from "../../transport/index.ts";
import { readClaimFile } from "./claims.ts";
import {
	HOST_CONTRACT_MEMBER,
	HostError,
	HostLeaseBusyError,
	hostRequestVersionError,
	hostPaths,
	isRetrySafeHostMethod,
	parseHostMetadata,
	parseHostHello,
	parseHostReadyLine,
	parseHostBusyLine,
	type HostMetadata,
	type HostPaths,
	type HostReady,
	type HostHello,
} from "./host-protocol.ts";
import { HOST_CONTRACT, type RuntimeContract } from "./version-contract.ts";
import { isObservationFrame, type ObservationFrame } from "./live-frames.ts";
import { parseHostChanges, type HostChanges, type NativeOwnerEvidence } from "./host-changes.ts";

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
// An unresolved project trust decision includes time for the primary UI answer.
const TRUST_LAUNCH_TIMEOUT_MS = 330_000;
const DEFAULT_RETRY_ATTEMPTS = 1;
/** Observation budgets leave room for native control answers and nested host acquisition. */
export function hostRequestBudget(method: string): number {
	switch (method) {
		case "spawn":
		case "resolve-agent":
		case "place":
		case "command":
			return TRUST_LAUNCH_TIMEOUT_MS + 90_000;
		case "abort":
		case "release":
		case "interrupt-continue":
		case "run-stop":
		case "timer-cancel":
		case "compact":
			return 90_000;
		default:
			return 60_000;
	}
}
const STDIO_CAPTURE_LIMIT = 64 * 1024;
const CONNECT_WAIT_LIMIT_MS = 5000;
const EXIT_HISTORY_LIMIT = 64;
type LinkPolicy = "acquire" | "attach-only";
export interface OwnedHostExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly failed: boolean;
}
interface OwnedLaunch {
	readonly child: ChildProcess;
	readonly ready: Promise<HostReady>;
	readonly exited: Promise<OwnedHostExit>;
	state: "pending" | "ready" | "uncertain" | "exited";
	writerReleased?: boolean;
	validatedReady?: HostReady;
	outcome?: OwnedHostExit;
}
const ownedLaunches = new Map<string, OwnedLaunch>();
const exitedLaunches = new Set<string>();

/** Only an exact child-exit event establishes the outcome of an owned launch. */
export function observeOwnedHostExit(metadata: HostMetadata): Promise<OwnedHostExit> | undefined {
	return ownedLaunches.get(hostPaths(metadata).socket)?.exited;
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
	/** Maximum observation time for one connected request or feed setup. */
	readonly requestTimeoutMs?: number;
	/** Revalidate demand immediately before a new runner starts. */
	readonly launchNeeded?: () => boolean;
	/** Ends local launch/attach observation only; never signals the native owner. */
	readonly signal?: AbortSignal;
}

/** What one live observation reads: one conversation, or the storage's live task graph. */
export type HostObservationScope =
	| { readonly scope: "conversation"; readonly sessionId: string; readonly conversationId?: number }
	| { readonly scope: "tasks"; readonly sessionId: string };

/** One open live observation. `frame` is the latest delivered reading, never a cached cold copy. */
/** One live-frame listener state: normal frames are `live`, a dropped connection is `unavailable`. */
export type HostObservationState = "live" | "unavailable";
/** One live-frame listener. An `unavailable` call carries the last known frame, or undefined. */
export type HostObservationListener = (
	frame: ObservationFrame | undefined,
	fresh: boolean,
	state?: HostObservationState,
) => void;

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
	/** Current operation contracts advertised by this host. */
	readonly runtimeContract: RuntimeContract;
	/** Negotiated generation; it remains an identity, not evidence of a live connection. */
	readonly writerId?: string;
	/** Current-link publication evidence, without a socket probe or a disk reread. */
	readonly ownerEvidence?: NativeOwnerEvidence;
	/** Exact owned child behind this link, when this process has that event source. */
	readonly ownedExit?: Promise<OwnedHostExit> | undefined;
	/** A successful owner close follows writer release; local client close does not. */
	readonly ownerReleased?: boolean;
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
	subscribeChanges?(listener: (frame: HostChanges) => void, signal?: AbortSignal): Promise<() => void>;
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
	readonly client: TransportClient;
	readonly writerId: string;
	readonly pid: number;
	readonly socketPath: string;
	readonly runtimeContract: RuntimeContract;
	readonly ownedExit?: Promise<OwnedHostExit>;
}

interface PendingCall {
	readonly method: string;
	readonly call: TransportRequest;
	readonly signal: AbortSignal | undefined;
	attempts: number;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	removeAbort: () => void;
}

interface ChangeEntry {
	readonly listener: (frame: HostChanges) => void;
	binding?: symbol;
	frame?: HostChanges;
	readonly signal: AbortSignal | undefined;
	subscription: TransportSubscription | undefined;
	disposed: boolean;
	removeAbort: () => void;
}

interface ObservationEntry {
	readonly id: number;
	readonly scope: HostObservationScope;
	readonly listeners: Set<HostObservationListener>;
	token: string | undefined;
	subscription: TransportSubscription | undefined;
	frame: ObservationFrame | undefined;
	unavailable?: boolean;
	disposed: boolean;
	removeAbort: () => void;
}

/** One observation request's parameters; the token keys the host's subscription. */
function observationParams(scope: HostObservationScope, token: string): Record<string, unknown> {
	return {
		token,
		scope: scope.scope,
		sessionId: scope.sessionId,
		...(scope.scope === "conversation" && scope.conversationId !== undefined
			? { conversationId: scope.conversationId }
			: {}),
	};
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
		if (
			claim !== null &&
			typeof claim === "object" &&
			"pid" in claim &&
			typeof claim.pid === "number" &&
			Number.isSafeInteger(claim.pid) &&
			claim.pid > 0
		)
			return claim.pid;
	} catch {
		// An attached host may be mid-restart; the pid is diagnostic only.
	}
	return 0;
}

function launchDeadline(metadata: HostMetadata, options: HostLaunchOptions): number {
	const timeout =
		options.launchTimeoutMs ?? (metadata.trust === undefined ? TRUST_LAUNCH_TIMEOUT_MS : DEFAULT_LAUNCH_TIMEOUT_MS);
	if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Host launch timeout must be positive and finite");
	return performance.now() + timeout;
}
function remaining(deadline: number): number {
	const value = Math.ceil(deadline - performance.now());
	if (value <= 0)
		throw new HostError("Host observation deadline reached; native work remains independent", "unavailable");
	return value;
}

/** The deadline belongs to setup or observation, not to admitted native work or a hydrated feed. */
export async function hostAttempt<T>(
	start: (signal: AbortSignal) => Promise<T>,
	timeoutMs = 60_000,
	caller?: AbortSignal,
): Promise<T> {
	const controller = new AbortController();
	const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
	signal.throwIfAborted();
	const timer = setTimeout(
		() => controller.abort(new HostError("Host request deadline reached; outcome unconfirmed", "unavailable")),
		timeoutMs,
	);
	try {
		return await awaitWithContext(start(signal), withAbortSignal(signal, BACKGROUND_CONTEXT));
	} catch (error) {
		signal.throwIfAborted();
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/** Withdrawal affects this observation; a late transport is disposed, never its owner. */
function withinBudget<T>(
	pending: Promise<T>,
	deadline: number,
	signal?: AbortSignal,
	late?: (value: T) => Promise<unknown>,
): Promise<T> {
	return new Promise<T>((resolveValue, rejectValue) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: unknown, value?: T) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (error !== undefined) rejectValue(error);
			else resolveValue(value as T);
		};
		const abort = () => finish(signal?.reason ?? new Error("Host observation cancelled"));
		void pending.then(
			(value) => {
				if (settled) {
					void late?.(value).catch(() => undefined);
					return;
				}
				finish(undefined, value);
			},
			(error: unknown) => finish(error),
		);
		if (signal?.aborted) {
			abort();
			return;
		}
		const delay = deadline - performance.now();
		if (delay <= 0) {
			finish(new HostError("Host observation deadline reached", "unavailable"));
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => finish(new HostError("Host observation deadline reached", "unavailable")), delay);
	});
}

async function connectClient(
	serverId: string,
	socketPath: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<TransportClient> {
	signal?.throwIfAborted();
	return withinBudget(
		connectTransport({ serverId, path: socketPath, timeoutMs: Math.min(CONNECT_WAIT_LIMIT_MS, remaining(deadline)) }),
		deadline,
		signal,
		(client) => client.dispose(),
	);
}

export class HostEndpointUnavailableError extends HostError {
	constructor(storageId: string, cause: unknown) {
		super(`No verified native host endpoint for ${storageId}: ${toError(cause).message}`, "unavailable", { cause });
		this.name = "HostEndpointUnavailableError";
	}
}

export class HostBusyEndpointUnavailableError extends HostError {
	constructor(storageId: string, cause: unknown) {
		super(`A runner reported BUSY for ${storageId}; no native host endpoint was verified.`, "unavailable", { cause });
		this.name = "HostBusyEndpointUnavailableError";
	}
}

/** The host refused before admission because it is ending; a fresh host can take the same operation. */
export class HostRetiringError extends HostError {
	/** True when the retiring host's connection closed within the wait, so a fresh host can take the work. */
	readonly ended: boolean;
	constructor(message: string, ended = false) {
		super(message, "unavailable");
		this.name = "HostRetiringError";
		this.ended = ended;
	}
}

/** A retiring host ends within its shutdown deadline; this wait adds a margin for transport close. */
export const RETIRING_HOST_WAIT_MS = 25_000;

/**
 * Resolve true when the connection has closed and, for a host this process launched, its process has exited; false
 * when the wait ends first. The exit follows the transport close, and only it lets this process launch the next host.
 */
export function connectionEnded(connection: HostConnection, waitMs: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (ended: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			signal?.removeEventListener("abort", aborted);
			resolve(ended);
		};
		const closed = () => {
			if (!connection.ownedExit) finish(true);
			else void connection.ownedExit.then(() => finish(true));
		};
		const aborted = () => finish(false);
		const timer = setTimeout(() => finish(false), waitMs);
		const unsubscribe = connection.onClose(closed);
		signal?.addEventListener("abort", aborted, { once: true });
		if (signal?.aborted) finish(false);
		else if (connection.closed) closed();
	});
}

/** Resolve true when the transport closes, false when the wait or the caller's signal ends first. */
function transportClosed(client: TransportClient, waitMs: number, signal?: AbortSignal): Promise<boolean> {
	if (!client.connected) return Promise.resolve(true);
	if (waitMs <= 0 || signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const finish = (closed: boolean) => {
			clearTimeout(timer);
			unsubscribe();
			signal?.removeEventListener("abort", aborted);
			resolve(closed);
		};
		let unsubscribe = () => {};
		const aborted = () => finish(false);
		const timer = setTimeout(() => finish(false), waitMs);
		unsubscribe = client.onClose(() => finish(true));
		signal?.addEventListener("abort", aborted, { once: true });
	});
}

export class HostLaunchDemandEnded extends HostError {
	constructor() {
		super("Host launch demand ended", "unavailable");
		this.name = "HostLaunchDemandEnded";
	}
}

export class HostReadinessUnavailableError extends HostError {
	constructor(cause: unknown) {
		super(
			"An owned runner remains unconfirmed; no replacement was started. A stuck start exits in 90 s, or 7 min during a trust prompt; then retry or use agent_attach.",
			"unavailable",
			{ cause },
		);
	}
}

function isRetiringRefusal(error: unknown): error is Error {
	if (!isChordError(error) || error.code !== "unavailable") return false;
	const details = error.details;
	return details !== null && typeof details === "object" && !Array.isArray(details) && details.retiring === true;
}

/** Find the readiness line in already-captured stdout; a malformed matching line throws. */
function readyFromOutput(buffer: Buffer): HostReady | undefined {
	const lines = buffer.toString("utf8").split("\n");
	for (let index = 0; index < lines.length - 1; index += 1) {
		const busy = parseHostBusyLine(lines[index]);
		if (busy) throw new HostLeaseBusyError(busy);
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
		child.once("exit", (code, signal) =>
			fail(new Error(`durable host exited before readiness (${code ?? signal ?? "unknown"})\n${detail()}`)),
		);
		timer = setTimeout(
			() => fail(new Error(`durable host did not announce readiness within ${timeoutMs} ms\n${detail()}`)),
			Math.max(1, timeoutMs),
		);
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

function startOwnedLaunch(metadata: HostMetadata, options: HostLaunchOptions, deadline: number): OwnedLaunch {
	options.signal?.throwIfAborted();
	const timeout = remaining(deadline);
	const paths = hostPaths(metadata);
	const key = paths.socket;
	const runner = options.runner ?? fileURLToPath(new URL("./durable-runner.ts", import.meta.url));
	// Node reports a missing cwd as `spawn <executable> ENOENT`, which names the wrong path.
	if (!statSync(metadata.cwd, { throwIfNoEntry: false })?.isDirectory())
		throw new HostError(`The agent's working directory no longer exists: ${metadata.cwd}`, "invalid");
	if (!statSync(process.execPath, { throwIfNoEntry: false })?.isFile())
		throw new HostError(
			`The running Node executable is no longer available: ${process.execPath}. Restart Pi, then retry the agent control.`,
			"invalid",
		);
	const child = spawn(process.execPath, [runner, ...(options.runnerArgs ?? []), JSON.stringify(metadata)], {
		cwd: metadata.cwd,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...options.env },
	});
	let resolveExit!: (outcome: OwnedHostExit) => void;
	const exited = new Promise<OwnedHostExit>((resolveValue) => {
		resolveExit = resolveValue;
	});
	const ready = waitForReady(child, timeout).then((value) => {
		if (value.socketPath !== paths.socket)
			throw new Error("Host readiness path does not match the expected storage endpoint");
		return value;
	});
	const attempt: OwnedLaunch = { child, exited, ready, state: "pending" };
	ownedLaunches.set(key, attempt);
	exitedLaunches.delete(key);
	const finish = (outcome: OwnedHostExit) => {
		if (attempt.outcome) return;
		attempt.state = "exited";
		attempt.outcome = outcome;
		resolveExit(outcome);
		if (ownedLaunches.get(key) !== attempt) return;
		exitedLaunches.add(key);
		while (exitedLaunches.size > EXIT_HISTORY_LIMIT) {
			const oldest = exitedLaunches.values().next().value;
			if (oldest === undefined) break;
			exitedLaunches.delete(oldest);
			if (ownedLaunches.get(oldest)?.state === "exited") ownedLaunches.delete(oldest);
		}
	};
	child.once("exit", (code, signal) => finish({ code, signal, failed: code !== 0 || signal !== null }));
	child.on("error", () => {
		if (child.pid === undefined) finish({ code: null, signal: null, failed: true });
	});
	void ready.then(
		(value) => {
			if (attempt.state !== "exited") {
				attempt.validatedReady = value;
				attempt.state = "ready";
			}
		},
		() => {
			if (attempt.state !== "exited") attempt.state = "uncertain";
		},
	);
	detachChild(child);
	return attempt;
}

function assertBusyTarget(error: unknown, metadata: HostMetadata, paths: HostPaths): void {
	if (
		error instanceof HostLeaseBusyError &&
		(error.target.storageId !== metadata.storageId || error.target.socketPath !== paths.socket)
	)
		throw new HostError("Busy runner identity does not match the expected storage endpoint", "invalid");
}

async function launchRunner(metadata: HostMetadata, options: HostLaunchOptions, deadline: number): Promise<Link> {
	const paths = hostPaths(metadata);
	let attempt = ownedLaunches.get(paths.socket);
	if (attempt?.state === "uncertain")
		throw new HostReadinessUnavailableError(new Error("The previous launch has no terminal child-exit event"));
	// An ending host this process launched removes its endpoint just before its process exits; that exit, not a
	// replacement guess, admits the next launch.
	if (
		attempt?.state === "ready" &&
		!attempt.writerReleased &&
		lstatSync(paths.socket, { throwIfNoEntry: false }) === undefined
	) {
		await withinBudget(attempt.exited, deadline, options.signal);
		attempt = ownedLaunches.get(paths.socket);
	}
	if (!attempt || attempt.state === "exited" || attempt.writerReleased) {
		if (options.launchNeeded?.() === false) throw new HostLaunchDemandEnded();
		attempt = startOwnedLaunch(metadata, options, deadline);
	}
	try {
		await withinBudget(attempt.ready, deadline, options.signal);
	} catch (error) {
		assertBusyTarget(error, metadata, paths);
		if (!(error instanceof HostLeaseBusyError) && !options.signal?.aborted && attempt.state !== "exited")
			throw new HostReadinessUnavailableError(error);
		throw error;
	}
	try {
		return await attachLink(metadata, deadline, options.signal);
	} catch (error) {
		if (!(error instanceof HostError) && !options.signal?.aborted && attempt.state !== "exited")
			throw new HostReadinessUnavailableError(error);
		throw error;
	}
}

/** The host refused before admission because it is ending; its transport closes once its lease is free. */
async function retiringHostEnded(
	client: TransportClient,
	refusal: HostRetiringError,
	deadline: number,
	signal?: AbortSignal,
): Promise<Error> {
	const ended = await transportClosed(client, Math.min(RETIRING_HOST_WAIT_MS, deadline - performance.now()), signal);
	await withinBudget(client.dispose(), performance.now() + CONNECT_WAIT_LIMIT_MS).catch(() => undefined);
	if (signal?.aborted) return abortReason(signal);
	return new HostRetiringError(refusal.message, ended);
}

/** Attachment verifies the endpoint and operation contract, never diagnostic PID presence. */
async function attachLink(
	metadata: HostMetadata,
	deadline = performance.now() + CONNECT_WAIT_LIMIT_MS,
	signal?: AbortSignal,
): Promise<Link> {
	const paths = hostPaths(metadata);
	const attempt = ownedLaunches.get(paths.socket);
	if (attempt?.state === "pending") {
		try {
			await withinBudget(attempt.ready, deadline, signal);
		} catch (error) {
			if (signal?.aborted || attempt.state === "pending") throw error;
		}
	}
	const client = await connectClient(paths.serverId, paths.socket, deadline, signal);
	try {
		const hello = await readHostHello(client, deadline, signal);
		return {
			client,
			writerId: hello.writerId,
			pid: claimPid(paths),
			socketPath: paths.socket,
			runtimeContract: hello.contract,
			...(attempt?.state === "ready" && !attempt.writerReleased && attempt.validatedReady?.writerId === hello.writerId
				? { ownedExit: attempt.exited }
				: {}),
		};
	} catch (error) {
		throw await attachFailure(client, error, deadline, signal);
	}
}

/** Close a link whose hello failed and name the failure for the caller. */
async function attachFailure(
	client: TransportClient,
	error: unknown,
	deadline: number,
	signal?: AbortSignal,
): Promise<unknown> {
	if (error instanceof HostRetiringError) return retiringHostEnded(client, error, deadline, signal);
	const answered = client.connected;
	await withinBudget(client.dispose(), deadline).catch(() => undefined);
	if (signal?.aborted) return abortReason(signal);
	if (answered)
		return new HostError(`Host runtime version unavailable: ${toError(error).message}`, "unavailable", {
			cause: error,
		});
	return error;
}

/** Read the current writer and operation contract without an older-handshake fallback. */
async function readHostHello(
	client: TransportClient,
	deadline = performance.now() + CONNECT_WAIT_LIMIT_MS,
	signal?: AbortSignal,
): Promise<HostHello> {
	try {
		const timeout = AbortSignal.timeout(Math.min(CONNECT_WAIT_LIMIT_MS, remaining(deadline)));
		const value = await withinBudget(
			client.request({ method: HOST_CONTRACT_MEMBER }, signal ? AbortSignal.any([signal, timeout]) : timeout),
			deadline,
			signal,
		);
		return parseHostHello(value);
	} catch (error) {
		if (isRetiringRefusal(error)) throw new HostRetiringError(error.message);
		if (!client.connected)
			throw new Error("The host link closed during runtime contract negotiation", { cause: error });
		throw new HostError(
			`The host does not provide a usable current operation contract. Restart the agent host after active work ends. ${toError(error).message}`,
			"unavailable",
			{ cause: error },
		);
	}
}

/** Observe a specific close completion or owned child exit, never a persistent inode. */
export function waitForHostRelease(
	metadata: HostMetadata,
	options: { signal?: AbortSignal; after?: Promise<unknown>; exit?: Promise<OwnedHostExit> } = {},
): Promise<void> {
	// A close belongs to its negotiated writer, not necessarily our last child at this endpoint.
	const exited = options.exit ?? (options.after ? undefined : observeOwnedHostExit(metadata));
	if (!exited && !options.after)
		return Promise.reject(
			new Error("No owned child-exit or owner close-completion event is available; writer release is unconfirmed"),
		);
	const deadline = performance.now() + CONNECT_WAIT_LIMIT_MS;
	const release = new Promise<void>((resolveReleased, rejectReleased) => {
		void exited?.then(() => resolveReleased(), rejectReleased);
		void options.after?.then(
			() => resolveReleased(),
			(error: unknown) => {
				if (!exited) rejectReleased(new Error("Owner close failed; writer release is unconfirmed", { cause: error }));
			},
		);
	});
	return withinBudget(release, deadline, options.signal);
}

async function attachBusyLink(metadata: HostMetadata, deadline: number, signal?: AbortSignal): Promise<Link> {
	let failure: unknown;
	try {
		return await attachLink(metadata, deadline, signal);
	} catch (error) {
		if (signal?.aborted || error instanceof HostError || isChordError(error) || error instanceof PluginError)
			throw error;
		failure = error;
	}
	// A busy writer without an endpoint yet is a host of older code that is still starting: it holds no start gate.
	if (!(await endpointAppears(hostPaths(metadata).socket, deadline, signal)))
		throw new HostBusyEndpointUnavailableError(metadata.storageId, failure);
	try {
		return await attachLink(metadata, deadline, signal);
	} catch (error) {
		if (signal?.aborted || error instanceof HostError || isChordError(error) || error instanceof PluginError)
			throw error;
		throw new HostBusyEndpointUnavailableError(metadata.storageId, error);
	}
}

/** A recheck that covers a directory notice the platform drops; notices end most waits sooner. */
const ENDPOINT_RECHECK_MS = 500;

/**
 * Resolve true once the endpoint path exists, false at the deadline or the caller's signal. The listener links its
 * socket into place only after it listens, so an existing path can answer.
 */
function endpointAppears(socketPath: string, deadline: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let watcher: FSWatcher | undefined;
		const finish = (found: boolean) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			watcher?.close();
			signal?.removeEventListener("abort", aborted);
			resolve(found);
		};
		const aborted = () => finish(false);
		const check = () => {
			if (lstatSync(socketPath, { throwIfNoEntry: false }) !== undefined) finish(true);
			else if (performance.now() >= deadline) finish(false);
		};
		const recheck = () => {
			check();
			if (!settled)
				timer = setTimeout(recheck, Math.max(1, Math.min(ENDPOINT_RECHECK_MS, deadline - performance.now())));
		};
		signal?.addEventListener("abort", aborted, { once: true });
		if (signal?.aborted) {
			finish(false);
			return;
		}
		try {
			watcher = watch(dirname(socketPath), { persistent: false }, check);
			watcher.on("error", () => watcher?.close());
		} catch {
			/* The recheck alone bounds the wait. */
		}
		recheck();
	});
}

/** Exclusion belongs to the runner lease; endpoint metadata never authorises replacement. */
async function acquireLink(
	metadata: HostMetadata,
	options: HostLaunchOptions,
	deadline = launchDeadline(metadata, options),
): Promise<Link> {
	options.signal?.throwIfAborted();
	try {
		return await attachLink(metadata, deadline, options.signal);
	} catch (error) {
		if (error instanceof HostLeaseBusyError) return attachBusyLink(metadata, deadline, options.signal);
		// A host that ended while this call waited leaves the storage to a fresh host, with a full launch budget,
		// through the same launch-or-attach path as any other launch.
		if (error instanceof HostRetiringError && error.ended) deadline = launchDeadline(metadata, options);
		else if (error instanceof HostError || isChordError(error) || error instanceof PluginError) throw error;
	}
	options.signal?.throwIfAborted();
	try {
		return await launchRunner(metadata, options, deadline);
	} catch (error) {
		if (error instanceof HostLeaseBusyError) return attachBusyLink(metadata, deadline, options.signal);
		throw error;
	}
}

class HostConnectionImpl implements HostConnection {
	readonly metadata: HostMetadata;
	readonly storageId: string;
	private client: TransportClient;
	private pidValue: number;
	private socketPathValue: string;
	private runtimeContractValue: RuntimeContract;
	private readonly pending = new Set<PendingCall>();
	private readonly changeEntries = new Map<number, ChangeEntry>();
	private readonly observationEntries = new Map<number, ObservationEntry>();
	private nextObservationId = 1;
	private readonly pendingChanges = new Set<ChangeEntry>();
	private writerIdValue = "";
	private changeFrame: HostChanges | undefined;
	private changeError = "The current host has no successful bounded publication";
	private nextChangeId = 1;
	private changeScheduled = false;
	private readonly launchOptions: HostLaunchOptions;
	private readonly linkPolicy: LinkPolicy;
	private readonly lifetime = new AbortController();
	private ownedExitValue: Promise<OwnedHostExit> | undefined;
	private ownerReleasedValue = false;
	private readonly retryAttempts: number;
	private closedValue = false;
	private closeNotified = false;
	private readonly closeListeners = new Set<() => void>();
	private recovery: Promise<void> | undefined;
	private unsubscribeState: (() => void) | undefined;

	private constructor(metadata: HostMetadata, link: Link, launchOptions: HostLaunchOptions, policy: LinkPolicy) {
		this.metadata = metadata;
		this.storageId = metadata.storageId;
		this.client = link.client;
		this.pidValue = link.pid;
		this.socketPathValue = link.socketPath;
		this.runtimeContractValue = link.runtimeContract;
		this.launchOptions = launchOptions;
		this.linkPolicy = policy;
		this.retryAttempts = launchOptions.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
		this.installClient(link);
	}

	static fromLink(
		metadata: HostMetadata,
		link: Link,
		launchOptions: HostLaunchOptions,
		policy: LinkPolicy,
	): HostConnection {
		return new HostConnectionImpl(metadata, link, launchOptions, policy);
	}

	get pid(): number {
		return this.pidValue;
	}

	get socketPath(): string {
		return this.socketPathValue;
	}

	get runtimeContract(): RuntimeContract {
		return this.runtimeContractValue;
	}

	get writerId(): string {
		return this.writerIdValue;
	}
	get ownerEvidence(): NativeOwnerEvidence {
		if (this.closedValue || !this.client.connected || this.ownerReleasedValue || this.recovery)
			return { kind: "unavailable", reason: "The current host link is unavailable or released" };
		if (!this.changeFrame) return { kind: "unknown", reason: this.changeError };
		return {
			kind: "verified",
			storageId: this.storageId,
			socketPath: this.socketPathValue,
			writerId: this.writerIdValue,
			...(this.changeFrame.view === undefined ? {} : { view: this.changeFrame.view }),
		};
	}
	get ownedExit(): Promise<OwnedHostExit> | undefined {
		return this.ownedExitValue;
	}
	get ownerReleased(): boolean {
		return this.ownerReleasedValue;
	}

	get closed(): boolean {
		return this.closedValue;
	}

	onClose(callback: () => void): () => void {
		if (this.closeNotified) {
			queueMicrotask(() => {
				try {
					callback();
				} catch {
					/* A listener failure never changes connection state. */
				}
			});
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
		for (const listener of [...this.closeListeners]) {
			try {
				listener();
			} catch {
				/* One listener failure never stops the others. */
			}
		}
		this.closeListeners.clear();
	}

	private installClient(link: Link): void {
		this.unsubscribeState?.();
		this.clearPublication("The current host has no successful bounded publication");
		this.writerIdValue = link.writerId;
		this.client = link.client;
		this.pidValue = link.pid;
		this.socketPathValue = link.socketPath;
		this.runtimeContractValue = link.runtimeContract;
		this.ownedExitValue = link.ownedExit;
		this.ownerReleasedValue = false;
		this.unsubscribeState = link.client.onClose((reason) => {
			if (this.closedValue || link.client !== this.client) return;
			this.clearPublication("The host transport was lost");
			for (const entry of this.observationEntries.values()) this.markObservationUnavailable(entry);
			this.startRecovery(new Error(`durable host connection closed: ${reason}`));
		});
	}

	request(method: string, params?: unknown, options: HostRequestOptions = {}): Promise<unknown> {
		if (this.closedValue) return Promise.reject(new Error("durable host connection is closed"));
		if (!isWellFormedRequestText(method))
			return Promise.reject(new HostError("host request method must be 1..128 well-formed characters", "invalid"));
		if (options.requestId !== undefined && !isWellFormedRequestText(options.requestId))
			return Promise.reject(new HostError("host requestId must be 1..128 well-formed characters", "invalid"));
		const versionError = hostRequestVersionError(method, this.runtimeContractValue);
		if (versionError) return Promise.reject(versionError);
		const signal = options.signal;
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		const id = options.requestId ?? randomUUID();
		return new Promise<unknown>((resolveCall, rejectCall) => {
			const call: PendingCall = {
				method,
				call: {
					method,
					...(params === undefined ? {} : { params }),
					requestId: id,
					contract: HOST_CONTRACT.operations[method],
				},
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
					if (!this.pending.delete(call)) return;
					call.removeAbort();
					rejectCall(abortReason(signal));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				call.removeAbort = () => signal.removeEventListener("abort", onAbort);
			}
			this.pending.add(call);
			const recovery = this.recovery;
			if (recovery)
				void recovery.then(
					() => this.startCall(call),
					() => this.startCall(call),
				);
			else this.startCall(call);
		});
	}

	private startCall(call: PendingCall): void {
		if (this.closedValue || !this.pending.has(call)) return;
		// Caller cancellation stays local and never cancels admitted Durable work.
		const client = this.client;
		const ownedExit = this.ownedExitValue;
		void hostAttempt(
			(deadline) => client.request(call.call, deadline),
			this.launchOptions.requestTimeoutMs ?? hostRequestBudget(call.method),
		).then(
			(result) => {
				if (call.method === "close") {
					if (client === this.client) {
						this.ownerReleasedValue = true;
						this.clearPublication("The host owner released the writer");
					}
					const attempt = ownedLaunches.get(hostPaths(this.metadata).socket);
					if (attempt && ownedExit === attempt.exited) attempt.writerReleased = true;
				}
				if (!this.pending.delete(call)) return;
				try {
					call.resolve(result);
				} catch (error) {
					call.reject(toError(error));
				}
			},
			(error) => {
				if (client === this.client) this.handleFailure(call, error);
			},
		);
	}

	async subscribeChanges(listener: (frame: HostChanges) => void, signal?: AbortSignal): Promise<() => void> {
		if (this.closedValue) throw new Error("durable host connection is closed");
		if (signal?.aborted) throw abortReason(signal);
		const id = this.nextChangeId;
		this.nextChangeId += 1;
		const entry: ChangeEntry = { listener, signal, subscription: undefined, disposed: false, removeAbort: () => {} };
		this.changeEntries.set(id, entry);
		try {
			await this.bindChangeEntry(entry);
		} catch (error) {
			this.releaseChangeEntry(id);
			throw toError(error);
		}
		if (signal?.aborted) {
			this.releaseChangeEntry(id);
			throw abortReason(signal);
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
		const refusal = hostRequestVersionError("changes", this.runtimeContractValue);
		if (refusal) {
			this.clearPublication(`changes: ${refusal.message}`, false);
			throw refusal;
		}
		const client = this.client;
		const writerId = this.writerIdValue;
		const binding = Symbol();
		entry.binding = binding;
		const current = () =>
			!this.closedValue &&
			!this.ownerReleasedValue &&
			!entry.disposed &&
			!entry.signal?.aborted &&
			client === this.client &&
			client.connected &&
			entry.binding === binding;
		const retain = (value: unknown) => {
			if (!current()) return;
			const frame = parseHostChanges(value, writerId, this.storageId);
			entry.frame = frame;
			this.changeFrame = frame;
			this.changeError = frame.view === undefined ? "The current host has no successful bounded publication" : "";
			this.queueChange(entry);
		};
		let subscription: TransportSubscription;
		try {
			subscription = await hostAttempt(
				(setup) =>
					client.subscribe(
						"changes",
						undefined,
						(value) => {
							try {
								retain(value);
							} catch (error) {
								if (current()) this.clearPublication(`changes: ${toError(error).message}`, false);
							}
						},
						setup,
					),
				this.launchOptions.requestTimeoutMs,
				entry.signal,
			);
		} catch (error) {
			if (current()) this.clearPublication(`changes: ${toError(error).message}`, false);
			throw error;
		}
		if (!current()) {
			await subscription.dispose().catch(() => undefined);
			return;
		}
		const previous = entry.subscription;
		if (previous) await previous.dispose().catch(() => undefined);
		if (!current()) {
			await subscription.dispose().catch(() => undefined);
			return;
		}
		entry.subscription = subscription;
		try {
			retain(subscription.value);
		} catch (error) {
			if (current()) this.clearPublication(`changes: ${toError(error).message}`, false);
			await subscription.dispose().catch(() => undefined);
			throw error;
		}
	}

	private releaseChangeEntry(id: number): void {
		const entry = this.changeEntries.get(id);
		if (!entry) return;
		entry.disposed = true;
		entry.removeAbort();
		this.changeEntries.delete(id);
		this.pendingChanges.delete(entry);
		if (this.changeFrame === entry.frame) {
			this.changeFrame = undefined;
			this.changeError = "No current publication subscription remains";
			for (const remaining of this.changeEntries.values())
				if (remaining.binding && remaining.frame) this.changeFrame = remaining.frame;
		}
		entry.binding = undefined;
		entry.frame = undefined;
		if (this.changeEntries.size === 0) this.clearPublication("No current publication subscription remains");
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
	async observe(
		scope: HostObservationScope,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<HostObservation> {
		if (this.closedValue) throw new Error("durable host connection is closed");
		const versionError = hostRequestVersionError("observe-open", this.runtimeContractValue);
		if (versionError) throw versionError;
		const signal = options.signal;
		if (signal?.aborted) throw abortReason(signal);
		const id = this.nextObservationId;
		this.nextObservationId += 1;
		const entry: ObservationEntry = {
			id,
			scope,
			listeners: new Set(),
			token: undefined,
			subscription: undefined,
			frame: undefined,
			disposed: false,
			removeAbort: () => {},
		};
		this.observationEntries.set(id, entry);
		if (signal) {
			const onAbort = () => {
				void this.releaseObservation(id);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			entry.removeAbort = () => signal.removeEventListener("abort", onAbort);
		}
		try {
			await this.bindObservation(entry);
			if (signal?.aborted) throw abortReason(signal);
		} catch (error) {
			await this.releaseObservation(id);
			throw toError(error);
		}
		const frame = entry.frame;
		if (frame === undefined) {
			await this.releaseObservation(id);
			throw new Error("durable host observation produced no frame");
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
					try {
						listener(entry.frame, false, "unavailable");
					} catch {
						/* A listener failure never changes observation state. */
					}
					return () => {};
				}
				entry.listeners.add(listener);
				const current = entry.frame;
				if (current !== undefined) {
					try {
						listener(current, !entry.unavailable, entry.unavailable ? "unavailable" : "live");
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
		const opened = (await this.request("observe-open", observationParams(entry.scope, token), { requestId: token })) as
			| { frame?: unknown }
			| undefined;

		if (this.closedValue || entry.disposed) {
			void this.closeObservationToken(token);
			return;
		}
		const subscription = await hostAttempt(
			(setup) =>
				this.client.subscribe(
					"observation",
					token,
					(value) => {
						if (value === null) {
							this.failObservation(entry);
							return;
						}
						if (isObservationFrame(value)) this.deliverObservation(entry, value, false);
					},
					setup,
				),
			this.launchOptions.requestTimeoutMs,
		).catch((error: unknown) => {
			void this.closeObservationToken(token);
			throw error;
		});
		if (this.closedValue || entry.disposed) {
			await subscription.dispose().catch(() => undefined);
			void this.closeObservationToken(token);
			return;
		}
		const openedFrame = isObservationFrame(opened?.frame) ? opened.frame : undefined;
		const baseline = isObservationFrame(subscription.value) ? subscription.value : openedFrame;
		const previous = entry.subscription;
		entry.token = token;
		entry.subscription = subscription;
		if (baseline !== undefined) entry.frame = baseline;
		if (previous) await previous.dispose().catch(() => undefined);
		if (!this.closedValue && !entry.disposed && baseline !== undefined) this.deliverObservation(entry, baseline, true);
	}

	private deliverObservation(
		entry: ObservationEntry,
		frame: ObservationFrame,
		fresh: boolean,
		state: HostObservationState = "live",
	): void {
		if (this.closedValue || entry.disposed) return;
		entry.frame = frame;
		entry.unavailable = state === "unavailable";
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
		if (token !== undefined) await this.closeObservationToken(token);
	}

	private async closeObservationToken(token: string): Promise<void> {
		if (this.closedValue) return;
		if (hostRequestVersionError("observe-close", this.runtimeContractValue)) return;
		await this.request("observe-close", { token }).catch(() => undefined);
	}

	private markObservationUnavailable(entry: ObservationEntry): void {
		if (entry.unavailable) return;
		entry.unavailable = true;
		for (const listener of [...entry.listeners]) {
			try {
				listener(entry.frame, false, "unavailable");
			} catch {
				/* One listener failure never stops the others. */
			}
		}
	}

	private notifyObservationUnavailable(entry: ObservationEntry): void {
		this.markObservationUnavailable(entry);
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

	private clearPublication(reason: string, invalidateBindings = true): void {
		this.changeFrame = undefined;
		this.changeError = reason;
		this.pendingChanges.clear();
		for (const entry of this.changeEntries.values()) {
			entry.frame = undefined;
			if (invalidateBindings) entry.binding = undefined;
		}
	}

	/** Coalesce a burst of write notifications into one listener call per turn. */
	private queueChange(entry: ChangeEntry): void {
		if (this.closedValue) return;
		this.pendingChanges.add(entry);
		if (this.changeScheduled) return;
		this.changeScheduled = true;
		queueMicrotask(() => {
			this.changeScheduled = false;
			const callbacks = [...this.pendingChanges];
			this.pendingChanges.clear();
			for (const entry of callbacks) {
				if (
					!this.closedValue &&
					!entry.disposed &&
					entry.frame &&
					entry.binding &&
					this.client.connected &&
					!this.ownerReleasedValue
				) {
					try {
						entry.listener(entry.frame);
					} catch {
						/* One listener failure never stops the others. */
					}
				}
			}
		});
	}

	private handleFailure(call: PendingCall, error: unknown): void {
		if (!this.pending.has(call)) return;
		if (this.client.connected || (isChordError(error) && error.code !== "unavailable")) {
			this.pending.delete(call);
			call.reject(
				isRetiringRefusal(error)
					? new HostRetiringError(error.message)
					: isChordError(error) || error instanceof PluginError
						? new HostError(error.message, error.code)
						: toError(error),
			);
			return;
		}
		if (call.signal?.aborted) {
			this.pending.delete(call);
			call.reject(abortReason(call.signal));
			return;
		}
		this.startRecovery(toError(error));
	}

	private startRecovery(cause: Error): void {
		if (this.closedValue || this.recovery) return;
		this.recovery = this.recover(cause).finally(() => {
			this.recovery = undefined;
			// A replacement may close while recovery awaits old-link disposal or
			// resends calls. Its loss must settle calls despite the recovery guard.
			if (!this.closedValue && !this.client.connected)
				this.shutdownLocal(new HostError("The replacement host link closed during recovery", "unavailable"));
		});
	}

	private async recoveryLink(demand: () => boolean): Promise<Link> {
		const options = {
			...this.launchOptions,
			signal: this.lifetime.signal,
			launchNeeded: () => demand() && this.launchOptions.launchNeeded?.() !== false,
		};
		const deadline = launchDeadline(this.metadata, options);
		try {
			return await attachLink(
				this.metadata,
				Math.min(deadline, performance.now() + CONNECT_WAIT_LIMIT_MS),
				this.lifetime.signal,
			);
		} catch (error) {
			if (this.linkPolicy !== "acquire" || !demand() || this.ownerReleasedValue || !this.ownedExitValue) throw error;
			const outcome = await withinBudget(this.ownedExitValue, deadline, this.lifetime.signal);
			if (!outcome.failed)
				throw new HostError("The owned host exited cleanly; automatic replacement was not started", "unavailable");
			return acquireLink(this.metadata, options, deadline);
		}
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
			link = await this.recoveryLink(() => retryable.some((call) => this.pending.has(call)));
		} catch (error) {
			this.shutdownLocal(toError(error));
			return;
		}
		if (this.closedValue) {
			await withinBudget(link.client.dispose(), performance.now() + CONNECT_WAIT_LIMIT_MS).catch(() => undefined);
			return;
		}
		const previous = this.client;
		this.installClient(link);
		await withinBudget(previous.dispose(), performance.now() + CONNECT_WAIT_LIMIT_MS).catch(() => undefined);
		if (this.closedValue) return;
		for (const entry of this.changeEntries.values()) void this.bindChangeEntry(entry).catch(() => undefined);
		// A recovered observation starts from the host's current snapshot; the new
		// subscription's baseline replaces any stale frame.
		for (const entry of [...this.observationEntries.values()])
			void this.bindObservation(entry).catch(() => this.failObservation(entry));
		for (const call of calls) {
			if (!this.pending.has(call)) continue;
			if (!isRetrySafeHostMethod(call.method) || call.attempts >= this.retryAttempts) {
				this.pending.delete(call);
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
		this.clearPublication("The local host connection is closed");
		this.lifetime.abort(error);
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
			this.pending.delete(call);
			call.reject(error);
		}
	}

	async close(): Promise<void> {
		if (this.closedValue) return;
		this.closedValue = true;
		this.clearPublication("The local host connection is closed");
		this.lifetime.abort(new Error("durable host client closed the connection"));
		this.unsubscribeState?.();
		this.unsubscribeState = undefined;
		this.disposeChangeEntries();
		this.disposeObservationEntries();
		this.rejectAll(new Error("durable host client closed the connection"));
		await withinBudget(this.client.dispose(), performance.now() + CONNECT_WAIT_LIMIT_MS).catch(() => undefined);
		this.notifyClosed();
	}
}

function connectLink(
	metadata: HostMetadata,
	link: Link,
	options: HostLaunchOptions,
	policy: LinkPolicy,
): HostConnection {
	return HostConnectionImpl.fromLink(metadata, link, options, policy);
}

/** Attach to a running host or launch a new one; never blocks on a stale claim. */
export async function acquireHost(metadata: HostMetadata, options: HostLaunchOptions = {}): Promise<HostConnection> {
	const parsed = parseHostMetadata(metadata);
	const link = await acquireLink(parsed, options);
	return connectLink(parsed, link, options, "acquire");
}

/** Attach to a running host and fail when none is live. */
export async function connectHost(metadata: HostMetadata, options: HostLaunchOptions = {}): Promise<HostConnection> {
	const parsed = parseHostMetadata(metadata);
	try {
		return connectLink(
			parsed,
			await attachLink(
				parsed,
				Math.min(launchDeadline(parsed, options), performance.now() + CONNECT_WAIT_LIMIT_MS),
				options.signal,
			),
			options,
			"attach-only",
		);
	} catch (error) {
		if (error instanceof HostRetiringError && error.ended)
			throw new HostEndpointUnavailableError(parsed.storageId, error);
		if (options.signal?.aborted || error instanceof HostError || isChordError(error) || error instanceof PluginError)
			throw error;
		throw new HostEndpointUnavailableError(parsed.storageId, error);
	}
}

/**
 * Read one snapshot without keeping a connection: acquire (which may relaunch
 * a dead host), request `snapshot`, and close. Other clients are unaffected.
 */
export async function snapshotHost(
	metadata: HostMetadata,
	params?: unknown,
	options: HostLaunchOptions = {},
): Promise<unknown> {
	const connection = await acquireHost(metadata, options);
	try {
		return await connection.request("snapshot", params);
	} finally {
		await connection.close();
	}
}
