import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readSettings } from "./settings.ts";
/**
 * agent/host-process: one exclusive durable host process per storage.
 *
 * `runHost` takes the writer claim for the storage before it creates the
 * runtime, then serves the storage over a local Chord Unix endpoint. The
 * runtime owns Durable work; this module owns the claim, the process lifecycle,
 * and the public service surface. It announces readiness on stdout so a
 * launching client can connect without polling.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, ftruncateSync, lstatSync, mkdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { ChordError, PluginError, invalid, isChordError } from "@earendil-works/chord";
import { createTransportServer, type TransportServer, type TransportRequest } from "../../transport/index.ts";
import { tryNativeWriterLeases, waitNativeWriterLease, type NativeWriterLease } from "./native-lease.ts";
import { validNativeWriterId } from "./claims.ts";
import { isPassiveHostOperation } from "./host-passive.ts";
import {
	formatHostReady,
	HostError,
	HOST_CONTRACT_MEMBER,
	hostPaths,
	parseHostMetadata,
	startGatePath,
	writerLeasePaths,
	type HostMetadata,
	type HostPaths,
	type HostReady,
	type HostBusy,
	formatHostBusy,
} from "./host-protocol.ts";
import { HOST_CONTRACT, parseOperationContract, operationContractMismatch } from "./version-contract.ts";
import { isObservationFrame } from "./live-frames.ts";
import type { CatalogView } from "./catalog-view.ts";
import type { HostChanges } from "./host-changes.ts";
import { createObservationPump, type ObservationClock, type ObservationPump } from "./observation-pump.ts";

function hostOperationError(error: unknown): ChordError | PluginError {
	if (isChordError(error) || error instanceof PluginError) return error;
	return new PluginError(
		error instanceof HostError ? error.code : "internal",
		error instanceof Error ? error.message : String(error),
	);
}

/**
 * A refusal before admission from a host that is ending. `details.retiring` tells a caller that the operation was not
 * admitted and that a fresh host can take it once this one has ended.
 */
function retiringRefusal(message: string): ChordError {
	return new ChordError({ code: "unavailable", message, details: { retiring: true } });
}

/** The host-side surface the parent runtime must supply. */
export interface HostRuntime {
	/**
	 * `requestId` is the durable request ID; `submit` maps it to the Durable
	 * request ID. The host process passes no `signal`: caller cancellation stays
	 * with the client and never reaches admitted Durable work.
	 */
	request(method: string, params: unknown, requestId: string, signal?: AbortSignal): Promise<unknown>;
	/** Pending native work or a failed runtime requires process death rather than an unbounded task join. */
	close(): Promise<void> | Promise<"process-exit" | "failed-process-exit" | undefined>;
	isIdle(): boolean;
	/** Revalidate native work, delivery, and local controls, then synchronously seal both admission boundaries. */
	tryRetire?(seal: () => boolean): Promise<boolean>;
	/** Ask for immediate guarded retirement without cancelling work or retained rows. */
	requestRelease?(): Promise<{ retiring: boolean; blockers: string[] }>;
	readonly releaseRequested?: boolean;
	/** The process applies release after requester disconnect or the bounded response grace. */
	onReleaseRequested?(listener: (requested: boolean) => void): () => void;
	/** A failed runtime requires process shutdown after the current response. */
	readonly shutdownRequired?: boolean;
	/**
	 * Subscribe to actual storage writes for the change-notification service.
	 * The source is the native commit stream; the runtime must not fire it for
	 * read-only reads or for this notification bookkeeping. Absent: the host
	 * serves the initial snapshot and publishes no changes.
	 */
	onChange?(listener: () => void): () => void;
	/** Latest bounded view after its successful catalogue publication, not a disk reread. */
	readonly publishedView?: CatalogView;
	/** Native view publications and committed invalidation wake observation feeds independently of catalog writes. */
	onObservationChange?(listener: () => void): () => void;
	/** Native commits and host-local control completion reset the idle interval without publishing a footer change. */
	onActivity?(listener: () => void): () => void;
	/** Delivery effects settled without new native activity. */
	onQuiescent?(listener: () => void): () => void;
}

/** Bootstrap services that runHost lends the factory while it builds the runtime. */
export interface HostBootstrap {
	/**
	 * Run one wait for a decision from a person (a project trust prompt). The bootstrap deadline extends for the wait
	 * and starts again when it ends.
	 */
	decisionWait<T>(wait: () => Promise<T>): Promise<T>;
}

/** Called with exclusive ownership. A rejected factory retains the claim because partial native construction has no close handle. */
export type HostRuntimeFactory = (bootstrap: HostBootstrap) => HostRuntime | Promise<HostRuntime>;

export interface RunHostOptions {
	readonly metadata: HostMetadata;
	/** Idle window in milliseconds. Defaults from local `agent.idleMinutes` settings. */
	readonly idleMs?: number;
	/** Environment used for the idle default; defaults to `process.env`. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Readiness announcement. Defaults to the stdout readiness line. */
	readonly announceReady?: (ready: HostReady) => void;
	/** Losing contenders announce exclusion before they leave without a runtime. */
	readonly announceBusy?: (target: HostBusy) => void;
	/** Dedicated process owner's terminal exit; embedded hosts must not supply it. */
	readonly exit?: (status: 0 | 1) => never;
	/** Schedule one idle check and return its cancellation function. Defaults to a wall-clock timer. */
	readonly scheduleIdleCheck?: (check: () => void, delayMs: number) => () => void;
	/** Waiting used by the observation scheduler. Defaults to a wall-clock timer. */
	readonly observationClock?: ObservationClock;
	/** Write a clean end record through the held descriptor; failure retains exclusion. */
	readonly writeEndRecord?: (descriptor: number, bytes: Buffer) => void;
	/** Schedule the dedicated process's shutdown deadline and return its cancellation. Defaults to a wall-clock timer. */
	readonly scheduleShutdownDeadline?: (expire: () => void, delayMs: number) => () => void;
	/** Schedule the next writer lease check and return its cancellation. Defaults to a timer that keeps no process alive. */
	readonly scheduleLeaseCheck?: (check: () => void, delayMs: number) => () => void;
	/** Schedule the dedicated process's bootstrap deadline and return its cancellation. Defaults to a wall-clock timer. */
	readonly scheduleBootstrapDeadline?: (expire: () => void, delayMs: number) => () => void;
}

/** Owner of one storage for the process lifetime. */
export interface HostProcess {
	readonly pid: number;
	readonly socketPath: string;
	/** Resolves on clean retirement and rejects when shutdown fails. */
	readonly done: Promise<void>;
	close(): Promise<void>;
}

/** A busy lease never grants permission to open native storage. */
export class HostClaimRefusedError extends Error {
	readonly observation: "busy" | "unknown";
	constructor(message: string, observation: "busy" | "unknown", cause?: unknown) {
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

interface ChangeSubscription {
	unsubscribe: () => void;
}
interface ObservationSubscription {
	readonly subscriptionId: string;
	readonly token: string;
	readonly publish: (value: unknown) => void;
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
	readonly closingTokens: Map<string, Promise<unknown>>;
	released: boolean;
}

const IDLE_MINUTES_MAX = 35791;
/** Observation frames are rebuilt at most once per interval, regardless of how often the storage changes. */
const OBSERVATION_INTERVAL_MS = 100;
/** Bound the response grace when the transport exposes no per-response flush signal. */
const RELEASE_RESPONSE_GRACE_MS = 100;
/** A dedicated host process ends this long after any shutdown starts, even when a close step never settles. */
export const SHUTDOWN_GRACE_MS = 20_000;
/** A serving host checks that its writer lease files still name its descriptors at this interval. */
export const LEASE_CHECK_MS = 300_000;
/**
 * A dedicated host process that has not announced readiness this long after it took the writer lease ends, which
 * releases the lease. While the host waits for a project trust decision from the primary, the longer bound applies,
 * and the shorter one starts again when the decision arrives. A launcher that allows for a trust decision can wait
 * longer than the short bound; it then observes the runner's exit.
 */
export const BOOTSTRAP_DEADLINE_MS = 90_000;
export const TRUST_BOOTSTRAP_DEADLINE_MS = 420_000;

/** Report on stderr; a closed or broken pipe never stops the exit or the step that follows the report. */
function diagnostic(text: string): void {
	try {
		writeSync(2, text);
	} catch {
		/* The process outlives its launcher's pipes. */
	}
}

function wallClockDeadline(expire: () => void, delayMs: number): () => void {
	const timer = setTimeout(expire, delayMs);
	return () => clearTimeout(timer);
}

/** The bootstrap deadline does not keep the process alive: a bootstrap that waits on nothing ends at once. */
function unrefDeadline(expire: () => void, delayMs: number): () => void {
	const timer = setTimeout(expire, delayMs);
	timer.unref();
	return () => clearTimeout(timer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Resolve the idle window from explicit input or the local agent settings. */
export function resolveIdleMs(
	idleMs?: number,
	env: Readonly<Record<string, string | undefined>> = process.env,
	agentDir = env.PI_AGENT_DIR ?? getAgentDir(),
): number {
	if (idleMs !== undefined) {
		if (!Number.isFinite(idleMs) || idleMs < 0 || idleMs > IDLE_MINUTES_MAX * 60_000)
			throw new Error(`idleMs must be a finite nonnegative number no greater than ${IDLE_MINUTES_MAX} minutes`);
		return idleMs;
	}
	return readSettings({ agentDir, env }).values.idleMinutes * 60_000;
}

function takeClaim(paths: readonly string[], record: ClaimRecord): NativeWriterLease {
	for (const path of paths) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const attempt = tryNativeWriterLeases(paths);
	if (attempt.kind === "busy")
		throw new HostClaimRefusedError("Durable host writer lease is busy; no native runtime was opened", "busy");
	const lease = attempt.lease;
	try {
		lease.assertNamed();
		ftruncateSync(lease.descriptor, 0);
		writeFileSync(lease.descriptor, JSON.stringify(record));
		return lease;
	} catch (error) {
		lease.release();
		throw error;
	}
}

class HostProcessServer implements HostProcess {
	readonly pid = process.pid;
	readonly socketPath: string;
	readonly done: Promise<void>;
	private readonly runtime: HostRuntime;
	private readonly paths: HostPaths;
	private readonly claim: NativeWriterLease;
	private readonly idleMs: number;
	private server: TransportServer | undefined;
	private socketIdentity: { dev: number; ino: number } | undefined;
	private cancelIdleCheck: (() => void) | undefined;
	private readonly scheduleIdleCheck: NonNullable<RunHostOptions["scheduleIdleCheck"]>;
	private pendingReplies = 0;
	private activeRequests = 0;
	private idleExpired = false;
	private passiveWait: { promise: Promise<void>; resolve: () => void } | undefined;
	private observationDeferred = false;
	private activityGeneration = 0;
	private readonly attachments = new Map<string, AttachmentState>();
	private retirementChecking = false;
	private releasePending = false;
	private releaseScheduled = false;
	private releaseGraceExpired = false;
	private releaseDraining = false;
	private releaseTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly releaseRequesters = new Set<AttachmentState>();
	private releaseChecking = false;
	private releaseAgain = false;
	private unsubscribeRelease: (() => void) | undefined;
	private closing = false;
	private closePromise: Promise<void> | undefined;
	private readonly closeResponseReady: Promise<void>;
	private resolveCloseResponse: () => void = () => {};
	private rejectCloseResponse: (error: Error) => void = () => {};
	private resolveDone: () => void = () => {};
	private rejectDone: (error: Error) => void = () => {};
	/** Live observation subscriptions across every attachment; frames publish on actual host writes. */
	private readonly observations = new Set<ObservationSubscription>();
	private readonly observationPump: ObservationPump;
	private unsubscribeObservation: (() => void) | undefined;
	private unsubscribeActivity: (() => void) | undefined;
	private unsubscribeQuiescent: (() => void) | undefined;

	private readonly exit: RunHostOptions["exit"];
	private readonly writerId: string;
	private readonly record: ClaimRecord;
	private readonly writeEndRecord: NonNullable<RunHostOptions["writeEndRecord"]>;
	private readonly scheduleShutdownDeadline: NonNullable<RunHostOptions["scheduleShutdownDeadline"]>;
	private cancelShutdownDeadline: (() => void) | undefined;
	private writerLost = false;
	private cancelLeaseCheck: (() => void) | undefined;
	private readonly scheduleLeaseTimer: NonNullable<RunHostOptions["scheduleLeaseCheck"]>;

	constructor(
		runtime: HostRuntime,
		paths: HostPaths,
		claim: NativeWriterLease,
		record: ClaimRecord,
		idleMs: number,
		scheduleIdleCheck?: RunHostOptions["scheduleIdleCheck"],
		observationClock?: ObservationClock,
		exit?: RunHostOptions["exit"],
		writeEndRecord = writeEndClaim,
		scheduleShutdownDeadline?: RunHostOptions["scheduleShutdownDeadline"],
		scheduleLeaseCheck?: RunHostOptions["scheduleLeaseCheck"],
	) {
		this.scheduleLeaseTimer = scheduleLeaseCheck ?? unrefDeadline;
		this.exit = exit;
		this.scheduleShutdownDeadline = scheduleShutdownDeadline ?? wallClockDeadline;
		this.record = record;
		this.writerId = record.token;
		this.writeEndRecord = writeEndRecord;
		this.runtime = runtime;
		this.paths = paths;
		this.claim = claim;
		this.idleMs = idleMs;
		this.observationPump = createObservationPump({
			intervalMs: OBSERVATION_INTERVAL_MS,
			run: () => this.pumpObservations(),
			// A failed pass loses no subscription state; later invalidation retries.
			onError: () => undefined,
			clock: observationClock,
		});
		// The listening endpoint keeps a dedicated host alive; its idle timer never does.
		this.scheduleIdleCheck = scheduleIdleCheck ?? unrefDeadline;
		this.socketPath = paths.socket;
		this.closeResponseReady = new Promise((resolve, reject) => {
			this.resolveCloseResponse = resolve;
			this.rejectCloseResponse = reject;
		});
		void this.closeResponseReady.catch(() => {});
		this.done = new Promise<void>((resolve, reject) => {
			this.resolveDone = resolve;
			this.rejectDone = reject;
		});
		// Retirement may reject `done` before a caller attaches to it; keep the
		// rejection observable for awaiters without an unhandled report.
		void this.done.catch(() => {});
	}

	async start(announce: (ready: HostReady) => void): Promise<void> {
		// Construction follows exclusive writer-claim acquisition. Only that owner replaces a stale socket.
		const prior = lstatSync(this.paths.socket, { throwIfNoEntry: false });
		if (prior) {
			if (!prior.isSocket() || prior.uid !== process.getuid?.())
				throw new Error("Durable host endpoint is not an owned socket");
			const current = lstatSync(this.paths.socket);
			if (current.dev !== prior.dev || current.ino !== prior.ino)
				throw new Error("Durable host socket changed before replacement");
			unlinkSync(this.paths.socket);
		}
		const server = createTransportServer({
			serverId: this.paths.serverId,
			path: this.paths.socket,
			request: (request, peer) => this.invoke(request, this.attachment(peer)),
			subscribe: async (kind, token, peer, publish) => {
				const state = this.attachment(peer);
				while (this.passiveAdmissionPaused()) await this.waitForPassiveAdmission();
				this.assertPassiveAdmission(state);
				this.pendingReplies++;
				try {
					return kind === "changes"
						? this.subscribeChanges(publish, state)
						: await this.subscribeObservation(token ?? "", publish, state);
				} finally {
					this.replyReady(true);
				}
			},
			release: (peer) => this.releaseAttachment(peer),
		});
		this.server = server;
		try {
			await server.start();
			const socket = lstatSync(this.paths.socket);
			this.socketIdentity = { dev: socket.dev, ino: socket.ino };
		} catch (error) {
			await server.close().catch(() => undefined);
			throw error;
		}
		const subscribeObservation = this.runtime.onObservationChange ?? this.runtime.onChange;
		this.unsubscribeObservation = subscribeObservation?.call(this.runtime, () => {
			if (this.observations.size > 0) this.observationPump.markDirty();
		});
		const subscribeActivity = this.runtime.onActivity ?? this.runtime.onChange;
		this.unsubscribeActivity = subscribeActivity?.call(this.runtime, () => {
			if (!this.writerNamed()) return;
			this.shutdownIfRequired();
			this.resetIdleWindow();
			if (this.releasePending) this.scheduleRelease();
			else this.scheduleRetirement();
		});
		this.unsubscribeQuiescent = this.runtime.onQuiescent?.(() => {
			if (this.releasePending) this.scheduleRelease();
			else if (this.cancelIdleCheck === undefined) this.scheduleRetirement();
		});
		this.unsubscribeRelease = this.runtime.onReleaseRequested?.((requested) => {
			if (!requested) {
				this.cancelRelease();
				return;
			}
			this.releasePending = true;
			this.scheduleRelease();
		});
		if (this.runtime.releaseRequested) {
			this.releasePending = true;
			this.scheduleRelease();
		}
		if (this.runtime.shutdownRequired) throw new Error("Durable runtime stopped before host readiness");
		announce({ pid: this.pid, socketPath: this.paths.socket, writerId: this.writerId, contract: HOST_CONTRACT });
		this.scheduleRetirement();
		this.scheduleLeaseCheck();
	}

	private attachment(peer: string): AttachmentState {
		let state = this.attachments.get(peer);
		if (!state) {
			state = {
				subscriptions: new Map(),
				observations: new Map(),
				tokens: new Set(),
				closingTokens: new Map(),
				released: false,
			};
			this.attachments.set(peer, state);
		}
		return state;
	}

	private releaseAttachment(peer: string): void {
		const state = this.attachments.get(peer);
		if (!state || state.released) return;
		state.released = true;
		for (const entry of state.subscriptions.values()) entry.unsubscribe();
		state.subscriptions.clear();
		for (const entry of state.observations.values()) entry.close();
		state.observations.clear();
		for (const token of [...state.tokens]) this.closeObservationToken(token, state);
		// A disconnected peer owns its tokens until native cleanup settles.
		void Promise.allSettled(state.closingTokens.values()).then(() => {
			this.attachments.delete(peer);
		});
		if (this.releaseRequesters.delete(state)) {
			this.releaseGraceExpired = true;
			if (this.releaseTimer !== undefined) clearTimeout(this.releaseTimer);
			this.releaseScheduled = false;
			this.scheduleRelease();
		}
	}

	private async invoke(request: TransportRequest, state: AttachmentState): Promise<unknown> {
		if (this.closing) throw retiringRefusal("The durable host process is shutting down");
		const { method, contract } = request;
		if (method !== HOST_CONTRACT_MEMBER) this.validateOperation(method, contract);
		if (method === HOST_CONTRACT_MEMBER || method === "close") return this.dispatch(request, state);
		const passive = isPassiveHostOperation(method);
		if (passive) {
			while (this.passiveAdmissionPaused()) await this.waitForPassiveAdmission();
			this.assertPassiveAdmission(state);
		} else {
			this.activeRequests++;
			this.resetIdleWindow();
		}
		this.pendingReplies++;
		try {
			return await this.dispatch(request, state);
		} finally {
			this.replyReady(passive);
		}
	}

	private subscribeChanges(
		publish: (value: unknown) => void,
		state: AttachmentState,
	): { value: unknown; close: () => void } {
		const id = randomUUID();
		let sequence = 0;
		let pending = false;
		const entry: ChangeSubscription = { unsubscribe: () => {} };
		entry.unsubscribe =
			this.runtime.onChange?.(() => {
				if (pending) return;
				pending = true;
				queueMicrotask(() => {
					pending = false;
					if (state.subscriptions.get(id) !== entry) return;
					publish(this.changesFrame(++sequence));
				});
			}) ?? (() => {});
		state.subscriptions.set(id, entry);
		return {
			value: this.changesFrame(0),
			close: () => {
				if (state.subscriptions.delete(id)) entry.unsubscribe();
			},
		};
	}

	private changesFrame(revision: number): HostChanges {
		const view = this.runtime.publishedView;
		return { revision, writerId: this.writerId, ...(view === undefined ? {} : { view }) };
	}

	private async subscribeObservation(
		token: string,
		publish: (value: unknown) => void,
		state: AttachmentState,
	): Promise<{ value: unknown; close: () => void }> {
		if (!state.tokens.has(token)) throw invalid("args", `unknown observation token ${token}`);
		let baseline: unknown;
		try {
			baseline = await this.runtime.request("observe-frame", { token }, randomUUID());
			if (!isObservationFrame(baseline) || state.released || !state.tokens.has(token))
				throw invalid("args", `observation token ${token} returned no frame`);
		} catch (error) {
			this.closeObservationToken(token, state);
			throw error;
		}
		const entry: ObservationSubscription = {
			subscriptionId: randomUUID(),
			token,
			publish,
			revision: baseline.revision,
			closed: false,
			close: () => {},
		};
		entry.close = () => this.closeObservationSubscription(entry, state);
		state.observations.set(entry.subscriptionId, entry);
		this.observations.add(entry);
		// Cover an update that raced the baseline read; revision equality suppresses a duplicate frame.
		this.observationPump.markDirty();
		return { value: baseline, close: entry.close };
	}

	private closeObservationSubscription(entry: ObservationSubscription, state: AttachmentState): void {
		if (entry.closed) return;
		entry.closed = true;
		this.observations.delete(entry);
		state.observations.delete(entry.subscriptionId);
		this.closeObservationToken(entry.token, state);
		if (this.observations.size === 0) this.observationPump.cancelPending();
	}

	/** Release one runtime token; the runtime stops the watch when the last token closes. */
	private closeObservationToken(token: string, state: AttachmentState): void {
		if (!state.tokens.has(token) || state.closingTokens.has(token)) return;
		this.pendingReplies++;
		const closing = this.runtime.request("observe-close", { token }, randomUUID());
		state.closingTokens.set(token, closing);
		void closing
			.catch(() => undefined)
			.finally(() => {
				state.closingTokens.delete(token);
				state.tokens.delete(token);
				this.endReply(true);
			});
	}

	/** Publish one state update per subscription whose frame revision advanced. */
	private async pumpObservations(): Promise<void> {
		if (this.closing) return;
		if (this.passiveAdmissionPaused()) {
			this.observationDeferred = true;
			return;
		}
		this.pendingReplies++;
		try {
			await Promise.all([...this.observations].map((entry) => this.publishObservation(entry)));
		} finally {
			this.replyReady(true);
		}
	}

	/** Read one subscription's frame and publish it when its revision advanced. */
	private async publishObservation(entry: ObservationSubscription): Promise<void> {
		if (entry.closed || this.closing) return;
		let frame: unknown;
		try {
			frame = await this.runtime.request("observe-frame", { token: entry.token }, randomUUID());
		} catch {
			await this.failObservation(entry);
			return;
		}
		if (entry.closed) return;
		if (!isObservationFrame(frame)) {
			await this.failObservation(entry);
			return;
		}
		// The subscription or the host may have closed while the frame was built.
		if (this.closing || entry.closed || !this.observations.has(entry)) return;
		if (frame.revision === entry.revision) return;
		entry.revision = frame.revision;
		entry.publish(frame);
	}

	/** A lost native watch is unavailable, not a live token retaining an old frame. */
	private async failObservation(entry: ObservationSubscription): Promise<void> {
		if (entry.closed) return;
		entry.publish(null);
		entry.close();
	}

	/** Dispatch one negotiated operation; caller cancellation never reaches admitted Durable work. */
	private async dispatch(request: TransportRequest, state: AttachmentState): Promise<unknown> {
		const { method, params } = request;
		const requestId = request.requestId ?? randomUUID();
		// Negotiate before parsing or dispatching an operation payload.
		if (method === HOST_CONTRACT_MEMBER)
			return { format: "pi.agent.host-hello/1", writerId: this.writerId, contract: HOST_CONTRACT };
		// Process shutdown owns the transport, runtime, writer claim, and done promise.
		if (method === "close") {
			// Chord.close joins method invocations. Release this invocation after writer
			// release or a terminal failure, before shutdown joins the transport.
			await Promise.race([this.shutdown(), this.closeResponseReady]);
			return {};
		}
		if (this.closing) throw retiringRefusal("The durable host process is shutting down");
		if (!this.writerNamed()) throw retiringRefusal("The durable host lost its writer lease; no operation was admitted");
		const token = this.prepareObservationToken(method, params, state);
		try {
			if (method === "observe-close" && token !== undefined) await state.closingTokens.get(token);
			const result = await this.runtime.request(method, params, requestId);
			if (this.releasePending && isRecord(result) && result.retiring === true) this.releaseRequesters.add(state);
			this.trackObservationResult(method, params, result, state);
			return result;
		} catch (error) {
			if (method === "observe-open" && token !== undefined) state.tokens.delete(token);
			throw hostOperationError(error);
		} finally {
			this.shutdownIfRequired();
		}
	}

	private validateOperation(method: string, rawContract: unknown): void {
		let mismatch: string | undefined;
		try {
			mismatch = operationContractMismatch(method, parseOperationContract(rawContract));
		} catch {
			mismatch = "The caller does not provide a current operation contract.";
		}
		if (mismatch)
			throw new ChordError({
				code: "unavailable",
				reason: "version",
				message: `${mismatch} Restart the caller or host with matching current agent code; no operation was admitted.`,
			});
	}

	private assertObservationAdmission(method: string): void {
		if (method === "observe-open" && this.releasePending)
			throw new ChordError({ code: "unavailable", message: "The durable host release is pending" });
	}

	private prepareObservationToken(method: string, params: unknown, state: AttachmentState): string | undefined {
		this.assertObservationAdmission(method);
		const token =
			params !== null && typeof params === "object" && "token" in params && typeof params.token === "string"
				? params.token
				: undefined;
		if (
			method === "observe-frame" &&
			(token === undefined || !state.tokens.has(token) || state.closingTokens.has(token))
		)
			throw invalid("args", "The observation token does not belong to this connection");
		if ((method === "observe-open" || method === "observe-close") && token !== undefined) {
			if (
				[...this.attachments.values()].some(
					(owner) => owner !== state && (owner.tokens.has(token) || owner.closingTokens.has(token)),
				)
			)
				throw invalid("args", "The observation token belongs to another connection");
		}
		if (method === "observe-open" && token !== undefined) {
			if (state.closingTokens.has(token)) throw invalid("args", "The observation token is still closing");
			state.tokens.add(token);
		}
		return token;
	}

	private trackObservationResult(method: string, params: unknown, result: unknown, state: AttachmentState): void {
		if (method === "observe-open") {
			const token = (result as { token?: unknown } | undefined)?.token;
			if (typeof token !== "string") return;
			state.tokens.add(token);
			if (state.released) this.closeObservationToken(token, state);
		}
		if (method === "observe-close") {
			const token = (params as { token?: unknown } | undefined)?.token;
			if (typeof token !== "string") return;
			state.tokens.delete(token);
			for (const entry of [...state.observations.values()]) if (entry.token === token) entry.close();
		}
	}

	private shutdownIfRequired(): void {
		if (!this.runtime.shutdownRequired || this.closing) return;
		this.sealPassiveAdmission();
		// Let the service response reach the client before shutdown closes transport.
		setImmediate(() => {
			void this.shutdown().catch(() => {});
		});
	}

	private resetIdleWindow(): void {
		this.activityGeneration++;
		this.idleExpired = false;
		this.cancelIdleCheck?.();
		this.cancelIdleCheck = undefined;
		this.resumePassiveAdmission();
	}

	private passiveAdmissionPaused(): boolean {
		return !this.closing && (this.idleExpired || this.releaseDraining);
	}

	private waitForPassiveAdmission(): Promise<void> {
		// A tentative check is not a retiring refusal: the same writer may still serve the caller.
		if (!this.passiveWait) {
			let resolve = () => {};
			const promise = new Promise<void>((done) => {
				resolve = done;
			});
			this.passiveWait = { promise, resolve };
		}
		return this.passiveWait.promise;
	}

	private assertPassiveAdmission(state: AttachmentState): void {
		if (this.closing) throw retiringRefusal("The durable host process is shutting down");
		if (state.released)
			throw new ChordError({ code: "unavailable", message: "The attachment closed before admission" });
	}

	private resumePassiveAdmission(): void {
		if (this.passiveAdmissionPaused()) return;
		this.passiveWait?.resolve();
		this.passiveWait = undefined;
		if (!this.closing && this.observationDeferred && this.observations.size > 0) this.observationPump.markDirty();
		this.observationDeferred = false;
	}

	private sealPassiveAdmission(): void {
		this.closing = true;
		this.resumePassiveAdmission();
	}

	/** Chord queues the reply after the invocation returns; the Unix transport drains writes on close. */
	private replyReady(passive: boolean): void {
		setImmediate(() => this.endReply(passive));
	}

	private endReply(passive: boolean): void {
		this.pendingReplies--;
		if (!passive) this.activeRequests--;
		if (this.releasePending) {
			if (!passive || this.releaseDraining) this.scheduleRelease();
		} else if (this.idleExpired) void this.onIdleCheck();
		else this.scheduleRetirement();
	}

	/** Give the response a bounded grace; requester disconnect ends the grace early. */
	private scheduleRelease(): void {
		if (this.closing || !this.releasePending || this.releaseScheduled) return;
		if (this.releaseChecking) {
			this.releaseAgain = true;
			return;
		}
		this.releaseScheduled = true;
		this.releaseTimer = setTimeout(
			() => {
				this.releaseTimer = undefined;
				this.releaseGraceExpired = true;
				this.releaseDraining = true;
				this.releaseScheduled = false;
				void this.releaseWhenQuiescent().catch(() => {});
			},
			this.releaseGraceExpired ? 0 : RELEASE_RESPONSE_GRACE_MS,
		);
	}

	private cancelRelease(): void {
		this.releasePending = false;
		this.releaseAgain = false;
		this.releaseGraceExpired = false;
		this.releaseDraining = false;
		this.releaseScheduled = false;
		this.releaseRequesters.clear();
		if (this.releaseTimer !== undefined) clearTimeout(this.releaseTimer);
		this.releaseTimer = undefined;
		this.resumePassiveAdmission();
		this.scheduleRetirement();
	}

	private async releaseWhenQuiescent(): Promise<void> {
		if (this.closing || !this.releasePending || this.retirementChecking || this.pendingReplies > 0) return;
		this.releaseChecking = true;
		this.cancelIdleCheck?.();
		this.cancelIdleCheck = undefined;
		const generation = this.activityGeneration;
		try {
			await this.onIdleCheck(true);
		} finally {
			this.releaseChecking = false;
			this.releaseDraining = false;
			this.resumePassiveAdmission();
			const again = this.releaseAgain;
			this.releaseAgain = false;
			if (this.releasePending && (again || generation !== this.activityGeneration)) this.scheduleRelease();
		}
	}

	private closeObservations(): void {
		for (const state of this.attachments.values()) {
			for (const entry of [...state.observations.values()]) entry.close();
			for (const token of state.tokens) this.closeObservationToken(token, state);
		}
	}

	private scheduleRetirement(): void {
		if (this.closing || this.idleMs === 0 || this.activeRequests > 0 || this.idleExpired || this.cancelIdleCheck)
			return;
		const generation = this.activityGeneration;
		this.cancelIdleCheck = this.scheduleIdleCheck(
			() => {
				if (generation !== this.activityGeneration) return;
				this.cancelIdleCheck = undefined;
				this.idleExpired = true;
				void this.onIdleCheck();
			},
			Math.max(1, this.idleMs),
		);
	}

	/**
	 * Check the writer lease on its own timer, whatever retirement, requests or observations do, so a host that
	 * nothing wakes still learns that its lease file was removed.
	 */
	private scheduleLeaseCheck(): void {
		if (this.closing) return;
		this.cancelLeaseCheck = this.scheduleLeaseTimer(() => {
			this.cancelLeaseCheck = undefined;
			if (this.writerNamed()) this.scheduleLeaseCheck();
		}, LEASE_CHECK_MS);
	}

	private async onIdleCheck(releasing = false): Promise<void> {
		if (this.closing || this.retirementChecking || this.pendingReplies > 0 || (!releasing && !this.idleExpired)) return;
		if (!this.writerNamed()) return;
		this.retirementChecking = true;
		const generation = this.activityGeneration;
		const seal = (): boolean => {
			if (
				this.closing ||
				generation !== this.activityGeneration ||
				this.pendingReplies > 0 ||
				(releasing ? !this.releasePending : !this.idleExpired)
			)
				return false;
			this.sealPassiveAdmission();
			// Admission is sealed now; the deadline covers the observation cleanup that precedes shutdown.
			this.armShutdownDeadline();
			this.closeObservations();
			return true;
		};
		try {
			if (!releasing && !this.runtime.isIdle()) return;
			const retired = this.runtime.tryRetire ? await this.runtime.tryRetire(seal) : this.runtime.isIdle() && seal();
			if (retired) {
				await Promise.allSettled([...this.attachments.values()].flatMap((state) => [...state.closingTokens.values()]));
				await this.shutdown();
			}
		} catch {
			/* An unavailable check waits for the next activity or quiescent event. */
		} finally {
			this.retirementChecking = false;
			this.resumeRetirement(generation, releasing);
		}
	}

	private resumeRetirement(generation: number, releasing: boolean): void {
		if (generation === this.activityGeneration) this.idleExpired = false;
		this.resumePassiveAdmission();
		if (this.releasePending) {
			if (!releasing) this.scheduleRelease();
		} else if (this.idleExpired) void this.onIdleCheck();
		else this.scheduleRetirement();
	}

	/**
	 * Both lease files must still name the descriptors this host holds. A removed or replaced file lets another
	 * process take a new lease for the same storage, so this host stops at once: it unpublishes its own endpoint and
	 * the dedicated process exits without closing the runtime, which would write again.
	 */
	private writerNamed(): boolean {
		if (this.writerLost) return false;
		try {
			this.claim.assertNamed();
			return true;
		} catch {
			this.writerLost = true;
		}
		this.sealPassiveAdmission();
		this.cancelIdleCheck?.();
		this.cancelIdleCheck = undefined;
		this.cancelLeaseCheck?.();
		this.cancelLeaseCheck = undefined;
		this.observationPump.dispose();
		diagnostic(
			"Durable host: its writer lease file was removed, replaced or changed; the process stops without further writes.\n",
		);
		try {
			this.unpublishSocket();
		} catch {
			/* Another endpoint at this path is not ours to remove. */
		}
		// Let the refusal reach its caller before the process ends or the transport closes.
		setImmediate(() => {
			if (this.exit) this.exit(1);
			this.rejectDone(new Error("The durable host lost its writer lease"));
			void this.server?.close().catch(() => undefined);
		});
		return false;
	}

	close(): Promise<void> {
		return this.shutdown();
	}

	private shutdown(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.sealPassiveAdmission();
		this.armShutdownDeadline();
		this.closePromise = this.performShutdown().finally(() => {
			this.cancelShutdownDeadline?.();
			this.cancelShutdownDeadline = undefined;
		});
		return this.closePromise;
	}

	/**
	 * Idle retirement, release, a close request and a signal share one deadline. Process exit ends a close step that
	 * never settles and releases the writer lease; an embedded host has no process to end.
	 */
	private armShutdownDeadline(): void {
		const exit = this.exit;
		if (!exit || this.cancelShutdownDeadline) return;
		this.cancelShutdownDeadline = this.scheduleShutdownDeadline(() => {
			diagnostic(
				`Durable host: shutdown did not finish within ${SHUTDOWN_GRACE_MS / 1000} s; the process exits and releases its writer lease.\n`,
			);
			exit(1);
		}, SHUTDOWN_GRACE_MS);
	}

	/** Remove only our published endpoint before another writer receives the claim. */
	private unpublishSocket(): void {
		if (!this.socketIdentity) return;
		const socket = lstatSync(this.paths.socket, { throwIfNoEntry: false });
		if (socket === undefined) return;
		if (!socket.isSocket() || socket.dev !== this.socketIdentity?.dev || socket.ino !== this.socketIdentity.ino)
			throw new Error("Durable host socket changed before shutdown; refusing to unlink another endpoint");
		unlinkSync(this.paths.socket);
	}

	private async performShutdown(): Promise<void> {
		this.cancelIdleCheck?.();
		this.cancelIdleCheck = undefined;
		if (this.releaseTimer !== undefined) clearTimeout(this.releaseTimer);
		this.releaseTimer = undefined;
		this.releaseRequesters.clear();
		this.unsubscribeObservation?.();
		this.unsubscribeObservation = undefined;
		this.unsubscribeActivity?.();
		this.unsubscribeActivity = undefined;
		this.unsubscribeQuiescent?.();
		this.unsubscribeQuiescent = undefined;
		this.unsubscribeRelease?.();
		this.unsubscribeRelease = undefined;
		// Stop admitting observation work before the runtime that answers it closes.
		this.observationPump.dispose();
		this.cancelLeaseCheck?.();
		this.cancelLeaseCheck = undefined;
		try {
			// A host whose lease file is gone must not write again: no runtime close, marker or end record.
			if (!this.writerNamed())
				throw new Error("The durable host lost its writer lease; it stopped without closing its runtime");
			await closeRuntime(this.runtime, this.exit);
			this.unpublishSocket();
			this.claim.assertNamed();
			const endedAt = new Date().toISOString();
			if (!validNativeWriterId(this.record.token) || endedAt < this.record.createdAt)
				throw new Error("Writer end identity or time order is invalid");
			this.writeEndRecord(this.claim.descriptor, Buffer.from(JSON.stringify({ ...this.record, endedAt })));
			this.claim.release();
			this.resolveCloseResponse();
			// Let the released close invocation enqueue its response before transport EOF.
			await new Promise<void>((resolve) => setImmediate(resolve));
			await this.server?.close();
			this.resolveDone();
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.rejectCloseResponse(failure);
			// Let a failed close invocation leave before Chord joins it.
			await new Promise<void>((resolve) => setImmediate(resolve));
			await this.server?.close().catch(() => undefined);
			this.rejectDone(failure);
			throw failure;
		}
	}
}

/** Keep the live claim until process death when native close cannot join pending work. */
async function closeRuntime(runtime: HostRuntime, exit?: RunHostOptions["exit"]): Promise<void> {
	const outcome = await runtime.close();
	if (!outcome) return;
	if (!exit) throw new Error("Busy native shutdown requires its dedicated process owner");
	exit(outcome === "failed-process-exit" ? 1 : 0);
}

function claimRecord(identity: HostPaths["identity"], token: string): ClaimRecord {
	return {
		token,
		pid: process.pid,
		host: hostname(),
		sessionId: identity.sessionId,
		cwd: resolve(identity.cwd),
		createdAt: new Date().toISOString(),
	};
}

/** Positional writes do not inherit the descriptor offset left by acquisition. */
function writeEndClaim(descriptor: number, bytes: Buffer): void {
	let offset = 0;
	while (offset < bytes.length) {
		const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
		if (count === 0) throw new Error("Writer end record made no write progress");
		offset += count;
	}
	ftruncateSync(descriptor, bytes.length);
}

/**
 * Take the storage claim, then create the runtime, then listen. Keeping the
 * claim ahead of runtime creation prevents a losing launch from opening
 * schedulers for a storage another host owns.
 */
export async function runHost(createRuntime: HostRuntimeFactory, options: RunHostOptions): Promise<HostProcess> {
	const metadata = parseHostMetadata(options.metadata);
	const idleMs = resolveIdleMs(options.idleMs, options.env ?? process.env, metadata.agentDir);
	const paths = hostPaths(metadata);
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	chmodSync(paths.directory, 0o700);
	mkdirSync(dirname(paths.claim), { recursive: true, mode: 0o700 });
	const record = claimRecord(paths.identity, randomUUID());
	const exit = options.exit;
	// Dedicated runners of one storage queue on its start gate. The winner holds the gate until its endpoint listens,
	// so a contender that then finds the writer lease busy reports BUSY only once that endpoint can answer.
	const gate = exit ? openStartGate(metadata) : undefined;
	let claim: NativeWriterLease;
	try {
		claim = takeClaim(writerLeasePaths(metadata), record);
	} catch (error) {
		gate?.release();
		if (error instanceof HostClaimRefusedError && error.observation === "busy") {
			(options.announceBusy ?? ((target) => process.stdout.write(formatHostBusy(target))))({
				storageId: metadata.storageId,
				socketPath: paths.socket,
			});
		}
		throw error;
	}
	// Without a complete runtime there is no safe close handle: keep the lease until process exit. A dedicated
	// process whose bootstrap never finishes would hold it forever, so it ends at its bootstrap deadline.
	const deadline = bootstrapDeadline(exit, options.scheduleBootstrapDeadline ?? unrefDeadline);
	try {
		const runtime = await createRuntime({ decisionWait: deadline.decisionWait });
		const host = new HostProcessServer(
			runtime,
			paths,
			claim,
			record,
			idleMs,
			options.scheduleIdleCheck,
			options.observationClock,
			options.exit,
			options.writeEndRecord,
			options.scheduleShutdownDeadline,
			options.scheduleLeaseCheck,
		);
		try {
			await host.start(options.announceReady ?? ((ready) => process.stdout.write(formatHostReady(ready))));
			return host;
		} catch (error) {
			await host.close();
			throw error;
		}
	} finally {
		deadline.cancel();
		gate?.release();
	}
}

/** The bootstrap deadline of a dedicated process; an embedded host has none. */
function bootstrapDeadline(
	exit: RunHostOptions["exit"],
	schedule: NonNullable<RunHostOptions["scheduleBootstrapDeadline"]>,
): { readonly decisionWait: HostBootstrap["decisionWait"]; cancel(): void } {
	let cancelTimer: (() => void) | undefined;
	let ended = false;
	let waits = 0;
	const arm = (delayMs: number) => {
		cancelTimer?.();
		cancelTimer = undefined;
		if (ended || !exit) return;
		cancelTimer = schedule(() => {
			diagnostic(
				`Durable host: bootstrap did not announce readiness within ${delayMs / 1000} s; the process exits and releases its writer lease. A configured extension that never finishes loading can cause this.\n`,
			);
			exit(1);
		}, delayMs);
	};
	arm(BOOTSTRAP_DEADLINE_MS);
	return {
		async decisionWait(wait) {
			waits++;
			if (waits === 1) arm(TRUST_BOOTSTRAP_DEADLINE_MS);
			try {
				return await wait();
			} finally {
				waits--;
				if (waits === 0) arm(BOOTSTRAP_DEADLINE_MS);
			}
		},
		cancel() {
			ended = true;
			cancelTimer?.();
			cancelTimer = undefined;
		},
	};
}

/** The start gate sits beside the storage file; a dedicated runner may block its own thread on it. */
function openStartGate(metadata: HostMetadata): NativeWriterLease {
	const path = startGatePath(metadata);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	return waitNativeWriterLease(path);
}
