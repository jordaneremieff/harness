/**
 * agent/host-process: one exclusive durable host process per storage.
 *
 * `runHost` takes the writer claim for the storage before it creates the
 * runtime, then serves the storage over a local `pi-server` Unix endpoint. The
 * runtime owns Durable work; this module owns the claim, the process lifecycle,
 * and the public service surface. It announces readiness on stdout so a
 * launching client can connect without polling.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { decodeServiceControlCall } from "@earendil-works/chord";
import type { Context, JsonValue, ServiceCall, ServiceProviderUpdate, ServiceSubscriptionSnapshot } from "@earendil-works/chord";
import { ServerError } from "@earendil-works/pi-server";
import type { RoutedServerServiceAttachment, Server, ServerHost } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { type ClaimFile, type ClaimIdentity, classifyClaim, readClaimFile } from "./claims.ts";
import { formatHostReady, HOST_CHANGE_MEMBER, HOST_CHANGE_SERVICE_ID, HOST_OBSERVE_MEMBER, HOST_OBSERVE_SERVICE_ID, HOST_RUNTIME_VERSION, HOST_RUNTIME_VERSION_MEMBER, HOST_SERVICE_ID, hostPaths, isCancelableHostWait, observationTokenFromServiceId, parseHostMetadata, type HostMetadata, type HostPaths, type HostReady } from "./host-protocol.ts";
import { isObservationFrame } from "./live-frames.ts";

/** The host-side surface the parent runtime must supply. */
export interface HostRuntime {
	/**
	 * `requestId` is the durable request ID; `submit` maps it to the Durable
	 * request ID. `signal` follows the public cancel envelope, which may arrive
	 * for any request; the runtime decides what it cancels. Observational waits
	 * stop on it, admitted Durable work does not.
	 */
	request(method: string, params: unknown, requestId: string, signal?: AbortSignal): Promise<unknown>;
	close(): Promise<void>;
	isIdle(): boolean;
	/**
	 * Subscribe to actual storage writes for the change-notification service.
	 * The source is the native commit stream; the runtime must not fire it for
	 * read-only reads or for this notification bookkeeping. Absent: the host
	 * serves the initial snapshot and publishes no changes.
	 */
	onChange?(listener: () => void): () => void;
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

/** One connection-scoped change subscription; publications are coalesced per turn. */
interface ChangeSubscription {
	readonly id: string;
	readonly publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => void | Promise<void>;
	readonly context: Context;
	unsubscribe: () => void;
	sequence: number;
	pending: boolean;
}

/** One connection-scoped live-frame subscription; one token per observation. */
interface ObservationSubscription {
	readonly subscriptionId: string;
	readonly token: string;
	readonly publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => void | Promise<void>;
	readonly context: Context;
	sequence: number;
	revision: number;
	closed: boolean;
	close: () => void;
}

/** Per-attachment subscription state: change subscriptions, observation tokens, and their subscriptions. */
interface AttachmentState {
	readonly subscriptions: Map<string, ChangeSubscription>;
	readonly observations: Map<string, ObservationSubscription>;
	/** Observation tokens this attachment opened; only these may subscribe. */
	readonly tokens: Set<string>;
}

const IDLE_MINUTES_MAX = 35791;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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

class HostProcessServer implements HostProcess {
	readonly pid = process.pid;
	readonly socketPath: string;
	readonly done: Promise<void>;
	private readonly runtime: HostRuntime;
	private readonly paths: HostPaths;
	private readonly claim: HeldClaim;
	private readonly idleMs: number;
	private server: Server | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private connectionCount = 0;
	private closing = false;
	private closePromise: Promise<void> | undefined;
	private resolveDone: () => void = () => {};
	private rejectDone: (error: Error) => void = () => {};
	/** Live observation subscriptions across every attachment; frames publish on actual host writes. */
	private readonly observations = new Set<ObservationSubscription>();
	private observationPumpScheduled = false;
	private observationPumping = false;
	private observationAgain = false;
	private unsubscribeObservation: (() => void) | undefined;

	constructor(runtime: HostRuntime, paths: HostPaths, claim: HeldClaim, idleMs: number) {
		this.runtime = runtime;
		this.paths = paths;
		this.claim = claim;
		this.idleMs = idleMs;
		this.socketPath = paths.socket;
		this.done = new Promise<void>((resolve, reject) => {
			this.resolveDone = resolve;
			this.rejectDone = reject;
		});
		// Retirement may reject `done` before a caller attaches to it; keep the
		// rejection observable for awaiters without an unhandled report.
		void this.done.catch(() => {});
	}

	async start(announce: (ready: HostReady) => void): Promise<void> {
		const server = createUnixServer(this.host(), {
			serverId: this.paths.serverId,
			path: this.paths.socket,
			onConnectionCountChanged: (count) => this.onConnectionCountChanged(count),
		});
		this.server = server;
		try {
			await server.start();
		} catch (error) {
			await server.close().catch(() => undefined);
			throw error;
		}
		// The runtime commit source wakes frame publication for every open observation.
		this.unsubscribeObservation = this.runtime.onChange?.(() => this.scheduleObservationPump());
		announce({ pid: this.pid, socketPath: this.paths.socket, runtimeVersion: HOST_RUNTIME_VERSION });
		this.scheduleRetirement();
	}

	private host(): ServerHost {
		return {
			serverServices: { attachClient: () => this.attachment() },
			resolveSession: async (sessionId) => {
				throw new ServerError("session_not_found", `session ${sessionId} is not routed by this host`);
			},
			openSession: async () => {
				throw new ServerError("session_not_found", "this host routes no durable sessions");
			},
		};
	}

	private attachment(): RoutedServerServiceAttachment {
		const state: AttachmentState = { subscriptions: new Map(), observations: new Map(), tokens: new Set() };
		return {
			invokeService: (call, publish, context) => this.invokeService(call, publish, context, state),
			release: () => {
				for (const entry of state.subscriptions.values()) entry.unsubscribe();
				state.subscriptions.clear();
				for (const entry of state.observations.values()) entry.close();
				state.observations.clear();
				for (const token of state.tokens) this.closeObservationToken(token);
				state.tokens.clear();
			},
		};
	}

	/** Route Chord control calls for the change and observation services, then host methods. */
	private async invokeService(
		call: ServiceCall,
		publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => void | Promise<void>,
		context: Context,
		state: AttachmentState,
	): Promise<JsonValue | undefined> {
		const control = decodeServiceControlCall(call);
		if (control?.type === "subscribe") {
			if (control.serviceId === HOST_CHANGE_SERVICE_ID) return this.subscribeChanges(control.subscriptionId, publish, context, state) as unknown as JsonValue;
			const token = observationTokenFromServiceId(control.serviceId);
			if (token !== undefined) return (await this.subscribeObservation(control.subscriptionId, token, publish, context, state)) as unknown as JsonValue;
		}
		if (control?.type === "unsubscribe") {
			state.subscriptions.get(control.subscriptionId)?.unsubscribe();
			state.subscriptions.delete(control.subscriptionId);
			state.observations.get(control.subscriptionId)?.close();
			state.observations.delete(control.subscriptionId);
			return { unsubscribed: true };
		}
		if (control !== undefined) return undefined;
		return this.dispatch(call, context, state);
	}

	/**
	 * One coalesced change subscription. The runtime commit source fires per
	 * actual write; a burst collapses into one state publication per microtask
	 * turn, so the primary refreshes its footer once per observed state change.
	 */
	private subscribeChanges(
		subscriptionId: string,
		publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => void | Promise<void>,
		context: Context,
		state: AttachmentState,
	): ServiceSubscriptionSnapshot {
		const subscriptions = state.subscriptions;
		const entry: ChangeSubscription = { id: subscriptionId, publish, context, unsubscribe: () => {}, sequence: 0, pending: false };
		const notify = (): void => {
			if (entry.pending) return;
			entry.pending = true;
			queueMicrotask(() => {
				entry.pending = false;
				if (subscriptions.get(subscriptionId) !== entry) return;
				entry.sequence += 1;
				const update: ServiceProviderUpdate = { type: "state", member: HOST_CHANGE_MEMBER, sequence: entry.sequence, ops: [["r", { revision: entry.sequence }]] };
				void Promise.resolve(entry.publish(subscriptionId, update, entry.context)).catch(() => undefined);
			});
		};
		entry.unsubscribe = this.runtime.onChange?.(notify) ?? (() => {});
		subscriptions.set(subscriptionId, entry);
		return {
			serviceId: HOST_CHANGE_SERVICE_ID,
			mode: "singleton",
			instances: [{ members: [{ name: HOST_CHANGE_MEMBER, kind: "state", sequence: 0, ops: [["r", { revision: 0 }]] }] }],
		};
	}

	/**
	 * One live-frame subscription. The initial snapshot is the token's current
	 * frame, so a subscription never starts from a gap; later publications come
	 * from the observation pump, one coalesced state update per observed change.
	 */
	private async subscribeObservation(
		subscriptionId: string,
		token: string,
		publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => void | Promise<void>,
		context: Context,
		state: AttachmentState,
	): Promise<ServiceSubscriptionSnapshot> {
		if (!state.tokens.has(token)) throw new ServerError("service_not_found", `unknown observation token ${token}`);
		const baseline = await this.runtime.request("observe-frame", { token }, randomUUID());
		if (!isObservationFrame(baseline)) throw new ServerError("service_invalid_value", `observation token ${token} returned no frame`);
		const entry: ObservationSubscription = {
			subscriptionId,
			token,
			publish,
			context,
			sequence: baseline.revision,
			revision: baseline.revision,
			closed: false,
			close: () => {},
		};
		entry.close = () => this.closeObservationSubscription(entry);
		state.observations.set(subscriptionId, entry);
		this.observations.add(entry);
		// Close the open/subscribe gap: a commit between the baseline and
		// registration publishes on the next pump, which is scheduled now.
		this.scheduleObservationPump();
		return {
			serviceId: HOST_OBSERVE_SERVICE_ID,
			mode: "singleton",
			instances: [{ members: [{ name: HOST_OBSERVE_MEMBER, kind: "state", sequence: baseline.revision, ops: [["r", baseline as unknown as JsonValue]] }] }],
		};
	}

	private closeObservationSubscription(entry: ObservationSubscription): void {
		if (entry.closed) return;
		entry.closed = true;
		this.observations.delete(entry);
		this.closeObservationToken(entry.token);
	}

	/** Release one runtime token; the runtime stops the watch when the last token closes. */
	private closeObservationToken(token: string): void {
		void this.runtime.request("observe-close", { token }, randomUUID()).catch(() => undefined);
	}

	/** Coalesce runtime write notifications into one frame check per turn. */
	private scheduleObservationPump(): void {
		if (this.closing || this.observations.size === 0) return;
		if (this.observationPumping) {
			this.observationAgain = true;
			return;
		}
		if (this.observationPumpScheduled) return;
		this.observationPumpScheduled = true;
		queueMicrotask(() => {
			this.observationPumpScheduled = false;
			void this.pumpObservations().catch(() => undefined);
		});
	}

	/** Publish one state update per subscription whose frame revision advanced. */
	private async pumpObservations(): Promise<void> {
		if (this.closing) return;
		if (this.observationPumping) {
			this.observationAgain = true;
			return;
		}
		this.observationPumping = true;
		try {
			do {
				this.observationAgain = false;
				await Promise.all([...this.observations].map((entry) => this.publishObservation(entry)));
			} while (this.observationAgain && !this.closing);
		} finally {
			this.observationPumping = false;
		}
	}

	/** Read one subscription's frame and publish it when its revision advanced. */
	private async publishObservation(entry: ObservationSubscription): Promise<void> {
		if (entry.closed || this.closing) return;
		let frame: unknown;
		try {
			frame = await this.runtime.request("observe-frame", { token: entry.token }, randomUUID());
		} catch {
			return;
		}
		if (entry.closed || !isObservationFrame(frame) || frame.revision === entry.revision) return;
		entry.revision = frame.revision;
		entry.sequence += 1;
		const update: ServiceProviderUpdate = { type: "state", member: HOST_OBSERVE_MEMBER, sequence: entry.sequence, ops: [["r", frame as unknown as JsonValue]] };
		await Promise.resolve(entry.publish(entry.subscriptionId, update, entry.context)).catch(() => undefined);
	}

	/**
	 * Dispatch one public service call. The durable request ID travels as the
	 * second argument so a caller retry after link loss reuses it. The context
	 * signal follows the public cancel envelope; only observational waits in the
	 * runtime observe it, so a disconnect never cancels admitted Durable work.
	 */
	private async dispatch(call: ServiceCall, context: Context, state: AttachmentState): Promise<JsonValue | undefined> {
		if (call.serviceId !== HOST_SERVICE_ID) throw new ServerError("service_not_found", `unknown host service ${call.serviceId}`);
		const [rawParams, rawRequestId] = call.args;
		const params = rawParams === null ? undefined : rawParams;
		const requestId = typeof rawRequestId === "string" && rawRequestId !== "" ? rawRequestId : randomUUID();
		// The runtime contract version is a host-process property; an older host has no branch here and errors below.
		if (call.member === HOST_RUNTIME_VERSION_MEMBER) return { version: HOST_RUNTIME_VERSION };
		try {
			// Only an observational wait receives the disconnect or cancel signal;
			// admitted Durable work never sees one.
			const signal = isCancelableHostWait(call.member, params) ? context.abortSignal : undefined;
			const result = await this.runtime.request(call.member, params, requestId, signal);
			if (call.member === "observe-open") {
				const token = (result as { token?: unknown } | undefined)?.token;
				if (typeof token === "string") state.tokens.add(token);
			}
			return result as JsonValue | undefined;
		} catch (error) {
			// The public protocol carries bounded structural codes; the runtime
			// message is preserved so consumers keep actionable errors.
			throw new ServerError("service_invalid_value", error instanceof Error ? error.message : String(error));
		}
	}

	private onConnectionCountChanged(count: number): void {
		this.connectionCount = count;
		if (this.closing) return;
		if (count > 0) {
			if (this.idleTimer) {
				clearTimeout(this.idleTimer);
				this.idleTimer = undefined;
			}
			return;
		}
		this.scheduleRetirement();
	}

	private scheduleRetirement(): void {
		if (this.closing || this.idleMs === 0 || this.connectionCount > 0) return;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.onIdleCheck(), Math.max(1, this.idleMs));
	}

	private onIdleCheck(): void {
		this.idleTimer = undefined;
		if (this.closing || this.connectionCount > 0) return;
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
		this.closing = true;
		this.unsubscribeObservation?.();
		this.unsubscribeObservation = undefined;
		try {
			const server = this.server;
			if (server) await server.close();
			await this.runtime.close();
			this.claim.release();
			this.resolveDone();
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.rejectDone(failure);
			throw failure;
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
	const token = randomUUID();
	const claim = takeClaim(paths.claim, paths.identity, claimRecord(paths.identity, token));
	let runtime: HostRuntime | undefined;
	try {
		runtime = await createRuntime();
		const host = new HostProcessServer(runtime, paths, claim, idleMs);
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
