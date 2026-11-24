/**
 * primary-channel: the local endpoint through which a Durable host reaches the
 * ordinary primary session that owns it.
 *
 * The primary session registers one channel: a Chord endpoint over a Unix socket
 * whose methods deliver a message, ask for a project-trust decision, and
 * report read-only live information. The endpoint record lives under
 * `<sessionsRoot>/.primaries/<id>.json` with a 0700 directory and a 0600 socket;
 * no token crosses the boundary, because the filesystem permissions and the
 * exact `serverId` handshake are the same-user security boundary.
 *
 * Registration refuses while the recorded owner is a live local PID or belongs
 * to another host. Only a proven dead local PID permits replacement, so a
 * transient connect failure can never overwrite a live registration. Clients
 * prove liveness by connecting and checking the announced `serverId`; an unknown
 * id reports its supported ids from a bounded directory page with coverage.
 *
 * The module carries no session, manager, or UI logic. The primary extension
 * supplies `deliver` (usually `pi.sendMessage`) and `promptTrust` (usually a UI
 * select mapped by `promptProjectTrust`).
 */
import {
	constants,
	closeSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	chmodSync,
	writeFileSync,
	type BigIntStats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { invalid } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	connectTransport,
	createTransportServer,
	unixSocketPath,
	type TransportClient,
	type TransportRequest,
} from "../../transport/index.ts";
import { PRIMARY_DELIVERY_CONTRACT } from "./version-contract.ts";
import type { ProjectTrustDecision } from "./trust-support.ts";
import type { PrimaryIntentClaim } from "./effort-presence.ts";
export type { PrimaryIntentClaim } from "./effort-presence.ts";

/** Current notice contract includes explicit quiet-delivery semantics. */
export const PRIMARY_ENDPOINT_VERSION = PRIMARY_DELIVERY_CONTRACT;
const ENDPOINT_BYTES = 16 * 1024;
const DESCRIPTOR_RECORD_LIMIT = 512;
const DESCRIPTOR_PAYLOAD_LIMIT = 4 * 1024 * 1024;
const LIST_LIMIT = 20;
const VISIT_LIMIT = 256;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
/** A human trust decision is not a transport exchange; it carries its own bounded deadline. */
const TRUST_DECISION_TIMEOUT_MS = 300_000;
/** Canonical lowercase UUID of any version, used for native session ids. */
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** The public Unix server identity requires a canonical lowercase UUIDv4. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** One message the primary displays through its own session. `replyTo` is retained, not reinterpreted. */
export interface PrimaryDelivery {
	readonly sourceId: string;
	readonly text: string;
	readonly details?: JsonValue;
	readonly replyTo?: string;
	/** Defaults true. False requires the recipient's durable inbox instead of immediate transcript retention. */
	readonly requireRetained?: boolean;
}

export type PrimaryRepositoryState = "git" | "outside-git" | "unknown";

export interface PrimaryObservedPurpose {
	readonly source: "session-name" | "interactive-input";
	readonly text: string;
}

/** A stored work item that this session used, as reported by its producing extension. */
export interface PrimaryWorkReference {
	readonly kind: string;
	readonly id: string;
	readonly title?: string;
}

export const PRIMARY_WORK_REFERENCE_LIMIT = 16;
const WORK_REFERENCE_KIND = /^[a-z][a-z0-9-]{0,31}$/u;

/** Validate one reference; `kind` and `id` are opaque to the agent extension. */
export function validateWorkReference(value: unknown): PrimaryWorkReference {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("work reference must be an object");
	const record = value as Record<string, unknown>;
	if (typeof record.kind !== "string" || !WORK_REFERENCE_KIND.test(record.kind))
		throw new TypeError("work reference kind must be a lowercase token of 1-32 characters");
	if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 256)
		throw new TypeError("work reference id must contain 1-256 characters");
	if (
		record.title !== undefined &&
		(typeof record.title !== "string" || record.title.length === 0 || record.title.length > 200)
	)
		throw new TypeError("work reference title must contain 1-200 characters");
	return { kind: record.kind, id: record.id, ...(record.title === undefined ? {} : { title: record.title }) };
}

/** Serialized bytes the `workRefs` field may hold in an endpoint record. */
export const PRIMARY_WORK_REFERENCE_BYTES = 3 * 1024;

/**
 * Fit the work references into their own share and into the bytes the rest of the record leaves:
 * as many of the newest references as fit by kind and identity, then their titles, newest first.
 * A claim, a purpose or a name never fails to publish because of work references.
 */
function fitWorkRefs(endpoint: PrimaryEndpoint): PrimaryEndpoint {
	const { workRefs, ...rest } = endpoint;
	if (!workRefs?.length) return endpoint;
	// The field adds `,"workRefs":` and its value to the serialized rest.
	const room = Math.min(PRIMARY_WORK_REFERENCE_BYTES, ENDPOINT_BYTES - Buffer.byteLength(JSON.stringify(rest)) - 12);
	const fits = (refs: readonly PrimaryWorkReference[]) => Buffer.byteLength(JSON.stringify(refs)) <= room;
	if (fits(workRefs)) return endpoint;
	let refs: PrimaryWorkReference[] = workRefs.map(({ kind, id }) => ({ kind, id }));
	while (refs.length > 0 && !fits(refs)) refs.pop();
	for (let index = 0; index < refs.length; index++) {
		const title = workRefs[index].title;
		if (title === undefined) continue;
		const titled = refs.with(index, { ...refs[index], title });
		if (fits(titled)) refs = titled;
	}
	return refs.length === 0 ? rest : { ...rest, workRefs: refs };
}

function validateWorkReferences(value: unknown): PrimaryWorkReference[] {
	if (!Array.isArray(value) || value.length > PRIMARY_WORK_REFERENCE_LIMIT)
		throw new TypeError(`workRefs requires at most ${PRIMARY_WORK_REFERENCE_LIMIT} references`);
	return value.map(validateWorkReference);
}

/** Read-only live information about one registered primary. */
export interface PrimaryInfo {
	readonly id: string;
	readonly cwd: string;
	readonly name?: string;
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel?: string;
	readonly hostname: string;
	readonly pid: number;
	readonly socketPath: string;
	readonly startedAt: string;
	/** Canonical Git common directory, written by the host. */
	readonly repository?: string;
	readonly repositoryState?: PrimaryRepositoryState;
	readonly lastActivityAt?: string;
	/** Session-written declaration, not verified host state. */
	readonly intentClaim?: PrimaryIntentClaim;
	readonly observedPurpose?: PrimaryObservedPurpose;
	/** Work items this session used most recently, newest first; reported by producers, not verified. */
	readonly workRefs?: readonly PrimaryWorkReference[];
	/** Public Pi retained session file; it does not identify the live selected leaf. */
	readonly sessionFile?: string;
}

interface PrimaryEndpoint extends PrimaryInfo {
	readonly version: string;
	/** Independent canonical UUIDv4 announced by the public Unix server. */
	readonly serverId: string;
}

/** Ownership metadata is readable independently of whether its opaque tag authorizes delivery. */
type RecordedPrimaryEndpoint = Omit<PrimaryEndpoint, "version"> & { readonly version: unknown };

/** Cheap owner classification; `unknown` covers unverified ownership, `incompatible` a live local owner with another contract. */
export type PrimaryEndpointOwnerState = "absent" | "dead" | "live" | "unknown" | "incompatible";

/** Owner classification plus the observed endpoint version when the record is readable. */
export interface PrimaryEndpointStatus {
	readonly state: PrimaryEndpointOwnerState;
	readonly version?: string;
}

export class PrimaryChannelUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrimaryChannelUnavailableError";
	}
}

export class PrimaryChannelConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrimaryChannelConflictError";
	}
}

export interface PrimaryChannelOptions {
	/** Primary session id; must be a canonical lowercase UUID. */
	readonly id: string;
	readonly cwd: string;
	/** Root under which `.primaries` stores endpoint records. */
	readonly sessionsRoot: string;
	readonly signal?: AbortSignal;
	/** Display one message in the primary session, usually `pi.sendMessage`. */
	readonly deliver: (message: PrimaryDelivery) => void | Promise<void>;
	/** Ask the primary UI for one trust decision, usually through `promptProjectTrust`. */
	readonly promptTrust: (cwd: string) => Promise<ProjectTrustDecision | undefined>;
	readonly name?: string;
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel?: string;
	readonly repository?: string;
	readonly repositoryState?: PrimaryRepositoryState;
	readonly lastActivityAt?: string;
	readonly intentClaim?: PrimaryIntentClaim;
	readonly observedPurpose?: PrimaryObservedPurpose;
	readonly workRefs?: readonly PrimaryWorkReference[];
	readonly sessionFile?: string;
	/**
	 * The session registers again in this process, as after an extension reload: a record that this process
	 * published is replaced in one rename, so readers never find the session without an endpoint.
	 */
	readonly replaceOwn?: boolean;
}

export interface PrimaryChannel {
	readonly id: string;
	readonly socketPath: string;
	info(): PrimaryInfo;
	/** Replace the displayed identity fields; the announced server identity and socket stay unchanged. */
	update(info: {
		name: string | undefined;
		model: { provider: string; modelId: string } | undefined;
		thinkingLevel: string | undefined;
	}): void;
	publishIntent(intentClaim: PrimaryIntentClaim | undefined): void;
	touch(at: string): void;
	setObservedPurpose(value: PrimaryObservedPurpose | undefined): void;
	setWorkRefs(value: readonly PrimaryWorkReference[]): void;
	close(): Promise<void>;
}

export interface PrimaryChannelConnection {
	readonly id: string;
	info(): Promise<PrimaryInfo>;
	deliver(message: PrimaryDelivery): Promise<void>;
	/**
	 * Ask the primary UI for one decision. The request uses the human-decision
	 * deadline, not the handshake deadline, and the caller's signal cancels it.
	 */
	trustPrompt(cwd: string, signal?: AbortSignal): Promise<ProjectTrustDecision | undefined>;
	close(): Promise<void>;
}

/** Connect one client with a bounded handshake; a silent peer cannot hang the caller. */
async function connectClient(
	id: string,
	socketPath: string,
	serverId: string,
	timeoutMs: number,
): Promise<TransportClient> {
	try {
		return await connectTransport({ path: socketPath, serverId, timeoutMs });
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError")
			throw new PrimaryChannelUnavailableError(
				`primary channel ${id} did not complete its identity handshake within ${timeoutMs} ms`,
			);
		throw error;
	}
}

function errnoCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

/** Proven local process state; anything but ESRCH stays live or unknown and refuses replacement. */
function processState(pid: number): "dead" | "live" | "unknown" {
	try {
		process.kill(pid, 0);
		return "live";
	} catch (error) {
		return errnoCode(error) === "ESRCH" ? "dead" : "unknown";
	}
}

/** How long a probe result stands before the next read probes again. */
const OWNER_PROBE_TTL_MS = 10_000;
/** Probe results kept per process; the oldest is dropped beyond the bound. */
const OWNER_PROBE_LIMIT = 1024;
/** Resolution of a process start time read from `ps`, and the clock tolerance beside it. */
const PROCESS_START_TOLERANCE_MS = 2_000;
type OwnerRecord = {
	readonly pid: number;
	readonly startedAt: string;
	readonly serverId: string;
	readonly socketPath: string;
};
/**
 * `reused` is proof: the recorded socket accepts nothing (refused or missing) and the process that holds the
 * PID started after the record was written, so the record's owner has ended. `listening` and `unproven` (the
 * process that wrote the record refuses, as a busy owner with a full listen queue does, or a start time that
 * could not be read) keep the owner live.
 */
type OwnerProbe = { readonly result: "listening" | "unproven" | "reused"; readonly at: number };
const ownerProbes = new Map<string, OwnerProbe>();
const ownerProbing = new Map<string, Promise<void>>();
/** Server identities of the channels that this process holds open; their owner is this process. */
const ownServers = new Set<string>();
const probeKey = (record: OwnerRecord) => `${record.pid}\u0000${record.serverId}\u0000${record.socketPath}`;

/**
 * State of the process that published a record. No process holds its PID: the owner ended. Otherwise another
 * process can hold it, after a crash or a reboot, so a read of a live foreign PID starts a background probe
 * when the last one is stale, and the record reads as dead once a probe proved the PID reused. Until then it
 * reads as live, so a late end is possible and a false end is not. No comparison of the wall clock with the
 * boot time enters: a step of the clock would move it.
 */
function ownerState(record: OwnerRecord): "dead" | "live" | "unknown" {
	const state = processState(record.pid);
	if (state !== "live" || ownServers.has(record.serverId)) return state;
	const probe = ownerProbes.get(probeKey(record));
	if (probe?.result === "reused") return "dead";
	if (probe === undefined || Date.now() - probe.at > OWNER_PROBE_TTL_MS) void probeOwner(record);
	return "live";
}

/** Seconds of `[[dd-]hh:]mm:ss`, the elapsed-time column of `ps`. */
function elapsedSeconds(text: string): number | undefined {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(text.trim());
	if (match === null) return undefined;
	const [, days = "0", hours = "0", minutes, seconds] = match;
	return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}
/** When the process that holds a PID started, from `ps`; undefined when that cannot be read. */
function processStartedAt(pid: number): Promise<number | undefined> {
	return new Promise((done) => {
		execFile("ps", ["-o", "etime=", "-p", String(pid)], { timeout: 2_000 }, (error, stdout) => {
			const elapsed = error === null ? elapsedSeconds(String(stdout)) : undefined;
			done(elapsed === undefined ? undefined : Date.now() - elapsed * 1000);
		});
	});
}
/**
 * Whether the process that holds a record's PID started after the record was written: then the PID was
 * reused and the record's owner has ended. A busy live owner started before its record, so it never
 * produces this evidence. Both times stand on the timeline of their writing: a later step of the wall clock
 * moves `ps`'s elapsed time and the current time together, so the derived start time does not move.
 */
async function pidReused(record: OwnerRecord): Promise<boolean> {
	const written = Date.parse(record.startedAt);
	const started = await processStartedAt(record.pid);
	return Number.isFinite(written) && started !== undefined && started > written + PROCESS_START_TOLERANCE_MS;
}

/**
 * The reuse proof: the recorded socket accepts nothing, either refused or missing, and the PID's holder started
 * after the record was written. Neither half alone proves anything: a busy owner refuses, and a cleaned
 * temporary directory loses a live owner's socket file.
 */
async function reusedOwner(record: OwnerRecord): Promise<"listening" | "unproven" | "reused"> {
	const socket = await socketState(record.socketPath);
	if (socket === "accepting" || socket === "unknown") return "listening";
	return (await pidReused(record)) ? "reused" : "unproven";
}

/** One deduplicated probe of the reuse proof. */
function probeOwner(record: OwnerRecord): Promise<void> {
	const key = probeKey(record);
	const running = ownerProbing.get(key);
	if (running !== undefined) return running;
	const probe = (async () => {
		const result = await reusedOwner(record);
		ownerProbes.delete(key);
		ownerProbes.set(key, { result, at: Date.now() });
		if (ownerProbes.size > OWNER_PROBE_LIMIT) ownerProbes.delete(ownerProbes.keys().next().value as string);
	})().finally(() => ownerProbing.delete(key));
	ownerProbing.set(key, probe);
	return probe;
}

/**
 * Wait until each named record whose PID is alive and that has never been probed in this process has its
 * first probe, so the synchronous readers that follow classify a crashed owner whose PID another process holds
 * as dead. A record with an earlier probe result keeps it while a stale one is probed again in the background.
 */
export async function verifyPrimaryOwners(sessionsRoot: string, ids: Iterable<string>): Promise<void> {
	const probes: Promise<unknown>[] = [];
	for (const id of new Set(ids)) {
		if (!UUID_ANY.test(id)) continue;
		let record: RecordedPrimaryEndpoint | undefined;
		try {
			record = readValidatedEndpoint(primaryEndpointPath(sessionsRoot, id));
		} catch {
			continue;
		}
		if (record === undefined || record.id !== id) continue;
		probes.push(settledClassification(record, id));
	}
	await Promise.all(probes);
}

/**
 * What a connection to a socket path shows: `accepting`, `refused` (no server listens, or its listen queue is
 * full), `missing` (no socket file), or `unknown` for a slow owner past the deadline or any other error.
 */
function socketState(path: string, timeoutMs = 1000): Promise<"accepting" | "refused" | "missing" | "unknown"> {
	return new Promise((done) => {
		const socket = connect(path);
		const finish = (state: "accepting" | "refused" | "missing" | "unknown") => {
			clearTimeout(timer);
			socket.destroy();
			done(state);
		};
		const timer = setTimeout(() => finish("unknown"), timeoutMs);
		socket.once("connect", () => finish("accepting"));
		socket.once("error", (error) => {
			const code = errnoCode(error);
			finish(code === "ECONNREFUSED" ? "refused" : code === "ENOENT" ? "missing" : "unknown");
		});
	});
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value === "")
		throw new PrimaryChannelUnavailableError(`primary endpoint ${key} must be a non-empty string`);
	return value;
}

/** Validate bounded session declarations independently from the delivery contract. */
export function validatePrimaryIntentClaim(value: unknown): PrimaryIntentClaim {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("intentClaim must be an object");
	const record = value as Record<string, unknown>;
	const text = (key: string, max: number): string => {
		const field = record[key];
		if (typeof field !== "string" || field.length === 0 || field.length > max)
			throw new TypeError(`intentClaim ${key} must contain 1-${max} characters`);
		return field;
	};
	const scope = record.scope;
	if (scope === null || typeof scope !== "object" || Array.isArray(scope))
		throw new TypeError("intentClaim scope must be an object");
	const fullGate = (scope as Record<string, unknown>).fullGate;
	if (fullGate !== undefined && typeof fullGate !== "boolean")
		throw new TypeError("intentClaim scope.fullGate must be a boolean");
	const list = (key: "paths" | "branches"): string[] => {
		const entries = (scope as Record<string, unknown>)[key];
		if (
			!Array.isArray(entries) ||
			entries.length > 32 ||
			entries.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 512)
		)
			throw new TypeError(`intentClaim scope.${key} requires at most 32 strings of 1-512 characters`);
		return [...entries] as string[];
	};
	return {
		purpose: text("purpose", 1024),
		integration: text("integration", 2048),
		authority: text("authority", 2048),
		scope: { paths: list("paths"), branches: list("branches"), ...(fullGate === undefined ? {} : { fullGate }) },
		...(record.contactThread === undefined ? {} : { contactThread: text("contactThread", 256) }),
		updatedAt: text("updatedAt", 64),
	};
}

function validateObservedPurpose(value: unknown): PrimaryObservedPurpose {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("observedPurpose must be an object");
	const record = value as Record<string, unknown>;
	if (record.source !== "session-name" && record.source !== "interactive-input")
		throw new TypeError("observedPurpose source is invalid");
	if (typeof record.text !== "string" || record.text.length === 0 || record.text.length > 512)
		throw new TypeError("observedPurpose text must contain 1-512 characters");
	return { source: record.source, text: record.text };
}

/** Required identity fields of one endpoint record. */
function endpointIdentity(
	record: Record<string, unknown>,
): Pick<PrimaryEndpoint, "id" | "serverId" | "cwd" | "hostname" | "socketPath" | "startedAt"> {
	const id = optionalString(record, "id");
	const serverId = optionalString(record, "serverId");
	const cwd = optionalString(record, "cwd");
	const host = optionalString(record, "hostname");
	const socketPath = optionalString(record, "socketPath");
	const startedAt = optionalString(record, "startedAt");
	if (
		id === undefined ||
		serverId === undefined ||
		cwd === undefined ||
		host === undefined ||
		socketPath === undefined ||
		startedAt === undefined
	)
		throw new PrimaryChannelUnavailableError("primary endpoint identity is incomplete");
	if (!UUID_ANY.test(id) || !UUID_V4.test(serverId))
		throw new PrimaryChannelUnavailableError("primary endpoint identities are not canonical UUIDs");
	return { id, serverId, cwd, hostname: host, socketPath, startedAt };
}

/** Optional model identity of one endpoint record. */
function endpointModel(record: Record<string, unknown>): { provider: string; modelId: string } | undefined {
	const model = record.model;
	if (model === undefined) return undefined;
	if (
		model === null ||
		typeof model !== "object" ||
		typeof (model as { provider?: unknown }).provider !== "string" ||
		typeof (model as { modelId?: unknown }).modelId !== "string"
	)
		throw new PrimaryChannelUnavailableError("primary endpoint model is invalid");
	return model as { provider: string; modelId: string };
}

/** Positive process id of one endpoint record. */
function endpointPid(record: Record<string, unknown>): number {
	if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0)
		throw new PrimaryChannelUnavailableError("primary endpoint pid is invalid");
	return record.pid;
}

type EndpointDescriptor = Pick<
	PrimaryInfo,
	"repository" | "repositoryState" | "lastActivityAt" | "intentClaim" | "observedPurpose" | "workRefs" | "sessionFile"
>;

/** Session-written and observed descriptor fields; each validates its own bounds. */
function sessionDescriptor(
	record: Record<string, unknown>,
): Pick<EndpointDescriptor, "intentClaim" | "observedPurpose" | "workRefs"> {
	const intentClaim = record.intentClaim === undefined ? undefined : validatePrimaryIntentClaim(record.intentClaim);
	const observedPurpose =
		record.observedPurpose === undefined ? undefined : validateObservedPurpose(record.observedPurpose);
	const workRefs = record.workRefs === undefined ? [] : validateWorkReferences(record.workRefs);
	return {
		...(observedPurpose === undefined ? {} : { observedPurpose }),
		...(workRefs.length === 0 ? {} : { workRefs }),
		...(intentClaim === undefined ? {} : { intentClaim }),
	};
}

function endpointDescriptor(record: Record<string, unknown>): EndpointDescriptor {
	const repository = optionalString(record, "repository");
	const repositoryState = record.repositoryState;
	if (
		repositoryState !== undefined &&
		repositoryState !== "git" &&
		repositoryState !== "outside-git" &&
		repositoryState !== "unknown"
	)
		throw new TypeError("repositoryState is invalid");
	if (repositoryState === "git" && !repository) throw new TypeError("Git repository identity is missing");
	if (repositoryState === "outside-git" && repository)
		throw new TypeError("outside-git repository identity is invalid");
	const sessionFile = optionalString(record, "sessionFile");
	const lastActivityAt = optionalString(record, "lastActivityAt");
	return {
		...(sessionFile === undefined ? {} : { sessionFile }),
		...(repositoryState === undefined ? {} : { repositoryState }),
		...(repository === undefined ? {} : { repository }),
		...(lastActivityAt === undefined ? {} : { lastActivityAt }),
		...sessionDescriptor(record),
	};
}

/** Validate one decoded endpoint record. The contract version is checked by the caller. */
function parseEndpoint(value: unknown, strictDescriptor = false): RecordedPrimaryEndpoint {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new PrimaryChannelUnavailableError("primary endpoint is not an object");
	const record = value as Record<string, unknown>;
	const version = record.version;
	const identity = endpointIdentity(record);
	const name = optionalString(record, "name");
	const model = endpointModel(record);
	const thinkingLevel = optionalString(record, "thinkingLevel");
	let descriptor: EndpointDescriptor = {};
	try {
		descriptor = endpointDescriptor(record);
	} catch (error) {
		if (strictDescriptor) throw error;
		// Descriptive corruption does not prevent core delivery or ownership checks.
	}
	return {
		version,
		...descriptor,
		...identity,
		...(name === undefined ? {} : { name }),
		...(model === undefined ? {} : { model }),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		pid: endpointPid(record),
	};
}

/** Bounded diagnostic label only; no conversion authorizes a contract. */
function endpointVersionLabel(version: unknown): string {
	const label = typeof version === "string" ? version : JSON.stringify(version);
	return label === undefined ? "missing" : label.length === 0 ? "empty" : label.slice(0, 256);
}

/** Refuse another delivery contract with owner-specific restart guidance. */
export function primaryEndpointIncompatibleError(id: string, version: string): PrimaryChannelUnavailableError {
	return new PrimaryChannelUnavailableError(
		`primary owner ${id} runs an agent extension with endpoint version ${version}; this host requires version ${PRIMARY_ENDPOINT_VERSION}. Restart that Pi process to load the current extension.`,
	);
}

/** One decoded endpoint record plus the file identity it was read from. */
interface EndpointFile {
	readonly endpoint: RecordedPrimaryEndpoint;
	readonly dev: number;
	readonly ino: number;
}

interface ValidatedEndpoint {
	readonly revision: string;
	readonly endpoint: RecordedPrimaryEndpoint;
	readonly bytes: number;
}

/** Strict descriptor observation reuses a parse only for an unchanged opened-file revision. */
const validatedEndpoints = new Map<string, ValidatedEndpoint>();
let validatedEndpointBytes = 0;

function endpointRevision(info: BigIntStats): string {
	return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

function forgetValidatedEndpoint(path: string): void {
	const cached = validatedEndpoints.get(path);
	if (cached === undefined) return;
	validatedEndpoints.delete(path);
	validatedEndpointBytes -= cached.bytes;
}

function rememberValidatedEndpoint(
	path: string,
	revision: string,
	endpoint: RecordedPrimaryEndpoint,
	bytes: number,
): void {
	forgetValidatedEndpoint(path);
	validatedEndpoints.set(path, { revision, endpoint: structuredClone(endpoint), bytes });
	validatedEndpointBytes += bytes;
	while (validatedEndpoints.size > DESCRIPTOR_RECORD_LIMIT || validatedEndpointBytes > DESCRIPTOR_PAYLOAD_LIMIT) {
		const oldest = validatedEndpoints.keys().next().value;
		if (oldest === undefined) break;
		forgetValidatedEndpoint(oldest);
	}
}

function unreadableEndpoint(path: string, error: unknown): never {
	forgetValidatedEndpoint(path);
	throw new PrimaryChannelUnavailableError(`primary endpoint is unreadable: ${String(error)}`);
}

/** Read one endpoint for descriptor observation, reusing only validation of the same file revision. */
function readValidatedEndpoint(path: string): RecordedPrimaryEndpoint | undefined {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") {
			forgetValidatedEndpoint(path);
			return undefined;
		}
		return unreadableEndpoint(path, error);
	}
	try {
		const stat = fstatSync(fd, { bigint: true });
		if (!stat.isFile() || stat.size > BigInt(ENDPOINT_BYTES))
			return unreadableEndpoint(path, "the record exceeds its bound or is not a regular file");
		const revision = endpointRevision(stat);
		const cached = validatedEndpoints.get(path);
		if (cached?.revision === revision) {
			validatedEndpoints.delete(path);
			validatedEndpoints.set(path, cached);
			return structuredClone(cached.endpoint);
		}
		forgetValidatedEndpoint(path);
		const buffer = Buffer.alloc(ENDPOINT_BYTES + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
			if (!count) break;
			bytes += count;
		}
		if (bytes > ENDPOINT_BYTES) throw new PrimaryChannelUnavailableError("primary endpoint exceeds its bound");
		const endpoint = parseEndpoint(JSON.parse(buffer.toString("utf8", 0, bytes)), true);
		const after = fstatSync(fd, { bigint: true });
		if (endpointRevision(after) === revision) rememberValidatedEndpoint(path, revision, endpoint, bytes);
		return endpoint;
	} finally {
		closeSync(fd);
	}
}

/** Read one endpoint file with a no-symlink bounded read and exact identity validation. */
function readEndpointFile(path: string): EndpointFile | undefined {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return undefined;
		throw new PrimaryChannelUnavailableError(`primary endpoint is unreadable: ${String(error)}`);
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > ENDPOINT_BYTES)
			throw new PrimaryChannelUnavailableError("primary endpoint exceeds its bound or is not a regular file");
		const buffer = Buffer.alloc(ENDPOINT_BYTES + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
			if (!count) break;
			bytes += count;
		}
		if (bytes > ENDPOINT_BYTES) throw new PrimaryChannelUnavailableError("primary endpoint exceeds its bound");
		return { endpoint: parseEndpoint(JSON.parse(buffer.toString("utf8", 0, bytes))), dev: stat.dev, ino: stat.ino };
	} finally {
		closeSync(fd);
	}
}

/** Read one endpoint record with a no-symlink bounded read and exact identity validation. */
function readEndpoint(path: string): RecordedPrimaryEndpoint | undefined {
	return readEndpointFile(path)?.endpoint;
}

/** Refuse unreadable publication rather than advertise metadata beyond the read bound. */
function serializeEndpoint(endpoint: PrimaryEndpoint): string {
	const encoded = JSON.stringify(endpoint);
	if (Buffer.byteLength(encoded) > ENDPOINT_BYTES) throw new TypeError("primary endpoint exceeds its 16 KiB bound");
	return encoded;
}

/** Publish one complete record exclusively; an existing path refuses publication. */
function publishEndpoint(path: string, endpoint: PrimaryEndpoint): void {
	writeFileSync(path, serializeEndpoint(endpoint), { flag: "wx", mode: 0o600 });
	forgetValidatedEndpoint(path);
}

/** Replace one complete record atomically, so a reader never sees a partial write. */
function rewriteEndpoint(path: string, endpoint: PrimaryEndpoint): void {
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, serializeEndpoint(endpoint), { mode: 0o600 });
		renameSync(temporary, path);
		forgetValidatedEndpoint(path);
	} finally {
		removeFile(temporary);
	}
}

/** Remove one file, ignoring its absence. */
function removeFile(path: string): void {
	forgetValidatedEndpoint(path);
	try {
		unlinkSync(path);
	} catch (error) {
		if (errnoCode(error) !== "ENOENT") throw error;
	}
}

/** Bounded directory page of supported primary ids. */
async function listPrimaryIds(directory: string): Promise<{ ids: string[]; complete: boolean }> {
	const ids: string[] = [];
	let visited = 0;
	let complete = true;
	let handle: Awaited<ReturnType<typeof opendir>>;
	try {
		handle = await opendir(directory);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return { ids, complete: true };
		throw error;
	}
	for await (const entry of handle) {
		visited += 1;
		if (entry.isFile() && entry.name.endsWith(".json") && UUID_ANY.test(entry.name.slice(0, -5)))
			ids.push(entry.name.slice(0, -5));
		if (visited >= VISIT_LIMIT || ids.length >= LIST_LIMIT) {
			complete = false;
			break;
		}
	}
	ids.sort();
	return { ids, complete };
}

/**
 * Remove a stale record only when its owner is proven dead and the file identity still matches the read,
 * so a live or concurrently replaced record is never removed. A PID that looks live proves nothing after a
 * crash or a reboot, because another process can hold it; the reuse proof then shows the owner gone.
 * With `replaceOwn`, a record of this process stays for an atomic replacement: the result is `replace`.
 */
async function removeDeadEndpoint(endpointPath: string, id: string, replaceOwn = false): Promise<"absent" | "replace"> {
	const file = readEndpointFile(endpointPath);
	if (file === undefined) return "absent";
	if (file.endpoint.id !== id)
		throw new PrimaryChannelConflictError(`primary channel ${id} has an invalid endpoint record`);
	if (file.endpoint.hostname !== hostname())
		throw new PrimaryChannelConflictError(
			`primary channel ${id} is registered on another host (${file.endpoint.hostname}); refusing local replacement`,
		);
	if (replaceOwn && file.endpoint.pid === process.pid) return "replace";
	const state = processState(file.endpoint.pid);
	const replaceable = state === "dead" || (state === "live" && (await reusedOwner(file.endpoint)) === "reused");
	if (!replaceable)
		throw new PrimaryChannelConflictError(
			`primary channel ${id} is already registered by live PID ${file.endpoint.pid}; refusing replacement`,
		);
	const current = lstatSync(endpointPath, { throwIfNoEntry: false });
	if (current === undefined) return "absent";
	if (current.dev !== file.dev || current.ino !== file.ino)
		throw new PrimaryChannelConflictError(`primary channel ${id} changed during registration; retry`);
	removeFile(endpointPath);
	removeFile(file.endpoint.socketPath);
	return "absent";
}

/**
 * Remove one endpoint record whose owner is proven dead: no process holds its PID, or a completed probe of
 * this process found the reuse proof (no accepting socket and a PID holder that started after the record).
 * A refusal alone, as from a busy owner with a full listen queue, and a comparison of the wall clock with the
 * boot time never remove anything. A live, unknown, foreign, malformed or concurrently replaced record stays.
 * True when it removed one.
 */
export function removeDeadPrimaryEndpoint(sessionsRoot: string, id: string): boolean {
	if (!UUID_ANY.test(id)) return false;
	const endpointPath = primaryEndpointPath(sessionsRoot, id);
	let file: EndpointFile | undefined;
	try {
		file = readEndpointFile(endpointPath);
	} catch {
		return false;
	}
	if (file === undefined || file.endpoint.id !== id || file.endpoint.hostname !== hostname()) return false;
	if (processState(file.endpoint.pid) !== "dead" && ownerProbes.get(probeKey(file.endpoint))?.result !== "reused")
		return false;
	const current = lstatSync(endpointPath, { throwIfNoEntry: false });
	if (current === undefined || current.dev !== file.dev || current.ino !== file.ino) return false;
	removeFile(endpointPath);
	removeFile(file.endpoint.socketPath);
	return true;
}

/** The application endpoint for one primary channel. */
class PrimaryChannelHost {
	private readonly options: PrimaryChannelOptions;
	private endpoint: PrimaryEndpoint;
	private readonly endpointPath: string;
	/** The session's whole list; the record holds the part that fits beside the other fields. */
	private workRefs: readonly PrimaryWorkReference[];

	constructor(options: PrimaryChannelOptions, endpoint: PrimaryEndpoint, endpointPath: string) {
		this.options = options;
		this.endpoint = endpoint;
		this.endpointPath = endpointPath;
		this.workRefs = options.workRefs === undefined ? [] : validateWorkReferences([...options.workRefs]);
	}

	info(): PrimaryInfo {
		const { version: _version, serverId: _serverId, ...info } = this.endpoint;
		return info;
	}

	/** Replace the displayed identity fields and rewrite the endpoint record atomically. */
	update(info: {
		name: string | undefined;
		model: { provider: string; modelId: string } | undefined;
		thinkingLevel: string | undefined;
	}): void {
		const { name: _name, model: _model, thinkingLevel: _thinkingLevel, ...retained } = this.endpoint;
		this.replace({
			...retained,
			...(info.name === undefined ? {} : { name: info.name }),
			...(info.model === undefined ? {} : { model: { provider: info.model.provider, modelId: info.model.modelId } }),
			...(info.thinkingLevel === undefined ? {} : { thinkingLevel: info.thinkingLevel }),
		});
	}

	publishIntent(intentClaim: PrimaryIntentClaim | undefined): void {
		const { intentClaim: _claim, ...retained } = this.endpoint;
		this.replace({
			...retained,
			...(intentClaim === undefined ? {} : { intentClaim: validatePrimaryIntentClaim(intentClaim) }),
		});
	}

	touch(at: string): void {
		if (typeof at !== "string" || at.length === 0) throw new TypeError("lastActivityAt must be a non-empty string");
		this.replace({ ...this.endpoint, lastActivityAt: at });
	}

	setObservedPurpose(value: PrimaryObservedPurpose | undefined): void {
		const { observedPurpose: _purpose, ...retained } = this.endpoint;
		this.replace({ ...retained, ...(value === undefined ? {} : { observedPurpose: validateObservedPurpose(value) }) });
	}

	setWorkRefs(value: readonly PrimaryWorkReference[]): void {
		const workRefs = validateWorkReferences([...value]);
		this.replace(this.endpoint, workRefs);
		this.workRefs = workRefs;
	}

	/** Every rewrite fits the whole list again, so references regain bytes that another field gives up. */
	private replace(next: PrimaryEndpoint, workRefs = this.workRefs): void {
		const { workRefs: _published, ...fields } = next;
		const endpoint = fitWorkRefs(workRefs.length === 0 ? fields : { ...fields, workRefs: [...workRefs] });
		rewriteEndpoint(this.endpointPath, endpoint);
		this.endpoint = endpoint;
	}

	async dispatch(request: TransportRequest): Promise<JsonValue | undefined> {
		switch (request.method) {
			case "info":
				return this.info() as unknown as JsonValue;
			case "deliver":
				return this.deliver(request.params, true);
			case "admit":
				return this.deliver(request.params, false);
			case "trustPrompt":
				return this.trustPrompt(request.params);
			default:
				throw invalid("args", `unknown primary channel method ${request.method}`);
		}
	}

	/** Route one validated message to transcript confirmation or inbox admission. */
	private async deliver(raw: unknown, requireRetained: boolean): Promise<JsonValue> {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw))
			throw invalid("params", "deliver requires a message object");
		const message = raw as Record<string, unknown>;
		if (typeof message.sourceId !== "string" || message.sourceId === "" || typeof message.text !== "string")
			throw invalid("params", "deliver requires sourceId and text");
		if (message.replyTo !== undefined && typeof message.replyTo !== "string")
			throw invalid("params", "deliver replyTo must be a string");
		if (message.requireRetained !== undefined && message.requireRetained !== requireRetained)
			throw invalid("params", "requireRetained does not match the primary message operation");
		await this.options.deliver({
			requireRetained,
			sourceId: message.sourceId,
			text: message.text,
			...(message.details === undefined ? {} : { details: message.details as JsonValue }),
			...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
		});
		return null;
	}

	/** Ask the primary UI for one trust decision. */
	private async trustPrompt(raw: unknown): Promise<JsonValue> {
		if (typeof raw !== "string" || raw === "") throw invalid("params", "trustPrompt requires a cwd string");
		const answer = await this.options.promptTrust(raw);
		return answer === undefined ? null : { trusted: answer.trusted, remember: answer.remember ?? null };
	}
}

/** Build one endpoint record for this process. */
function endpointRecord(options: PrimaryChannelOptions, serverId: string, socketPath: string): PrimaryEndpoint {
	return fitWorkRefs({
		version: PRIMARY_ENDPOINT_VERSION,
		id: options.id,
		serverId,
		cwd: options.cwd,
		...(options.sessionFile === undefined ? {} : { sessionFile: options.sessionFile }),
		...(options.observedPurpose === undefined
			? {}
			: { observedPurpose: validateObservedPurpose(options.observedPurpose) }),
		...(options.workRefs === undefined || options.workRefs.length === 0
			? {}
			: { workRefs: validateWorkReferences([...options.workRefs]) }),
		...(options.repository === undefined ? {} : { repository: options.repository }),
		...(options.repositoryState === undefined ? {} : { repositoryState: options.repositoryState }),
		...(options.lastActivityAt === undefined ? {} : { lastActivityAt: options.lastActivityAt }),
		...(options.intentClaim === undefined ? {} : { intentClaim: validatePrimaryIntentClaim(options.intentClaim) }),
		...(options.name === undefined ? {} : { name: options.name }),
		...(options.model === undefined
			? {}
			: { model: { provider: options.model.provider, modelId: options.model.modelId } }),
		...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
		hostname: hostname(),
		pid: process.pid,
		socketPath,
		startedAt: new Date().toISOString(),
	});
}

/** Register one live primary channel. Rejects while another owner is registered. */
export async function createPrimaryChannel(options: PrimaryChannelOptions): Promise<PrimaryChannel> {
	if (!UUID_ANY.test(options.id)) throw new TypeError("primary channel id must be a canonical lowercase UUID");
	const directory = join(resolve(options.sessionsRoot), ".primaries");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const endpointPath = join(directory, `${options.id}.json`);
	const existing = await removeDeadEndpoint(endpointPath, options.id, options.replaceOwn);
	const serverId = randomUUID();
	const socketPath = unixSocketPath(serverId, directory);
	const endpoint = endpointRecord(options, serverId, socketPath);
	const host = new PrimaryChannelHost(options, endpoint, endpointPath);
	const server = createTransportServer({ serverId, path: socketPath, request: (request) => host.dispatch(request) });
	try {
		await server.start();
	} catch (error) {
		await server.close().catch(() => undefined);
		throw error;
	}
	try {
		ownServers.add(serverId);
		if (existing === "replace") rewriteEndpoint(endpointPath, endpoint);
		else publishEndpoint(endpointPath, endpoint);
	} catch (error) {
		ownServers.delete(serverId);
		await server.close().catch(() => undefined);
		removeFile(socketPath);
		if (errnoCode(error) === "EEXIST")
			throw new PrimaryChannelConflictError(
				`primary channel ${options.id} was registered concurrently; refusing replacement`,
			);
		throw error;
	}
	let closePromise: Promise<void> | undefined;
	/** Idempotent teardown: every caller awaits the same in-flight promise. */
	const close = (): Promise<void> => {
		if (closePromise) return closePromise;
		closePromise = (async () => {
			options.signal?.removeEventListener("abort", onAbort);
			ownServers.delete(serverId);
			await server.close().catch(() => undefined);
			removeFile(socketPath);
			try {
				const current = readEndpoint(endpointPath);
				if (current !== undefined && current.pid === process.pid && current.serverId === serverId)
					removeFile(endpointPath);
			} catch {
				// A changed or unreadable record belongs to another owner.
			}
		})();
		return closePromise;
	};
	const onAbort = (): void => {
		void close().catch(() => undefined);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	return {
		id: options.id,
		socketPath,
		info: () => host.info(),
		update: (info) => host.update(info),
		publishIntent: (claim) => host.publishIntent(claim),
		touch: (at) => host.touch(at),
		setObservedPurpose: (value) => host.setObservedPurpose(value),
		setWorkRefs: (value) => host.setWorkRefs(value),
		close,
	};
}

/** Compose the unknown-id refusal with a bounded supported-id page. */
async function unavailable(directory: string, id: string): Promise<PrimaryChannelUnavailableError> {
	const { ids, complete } = await listPrimaryIds(directory).catch(() => ({ ids: [], complete: false }));
	const list = ids.length === 0 ? "none" : ids.join(", ");
	return new PrimaryChannelUnavailableError(
		`no live primary channel for ${id}; supported ids: ${list} (coverage: ${complete ? "complete" : "partial"})`,
	);
}

/** Connect to one registered primary channel and prove the announced serverId within a bounded deadline. */
export async function connectPrimaryChannel(options: {
	readonly id: string;
	readonly sessionsRoot: string;
	readonly timeoutMs?: number;
}): Promise<PrimaryChannelConnection> {
	if (!UUID_ANY.test(options.id))
		throw new PrimaryChannelUnavailableError(
			`primary id ${JSON.stringify(options.id)} is not a canonical UUID; no primary channel was read`,
		);
	const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const directory = join(resolve(options.sessionsRoot), ".primaries");
	const endpoint = readEndpoint(primaryEndpointPath(options.sessionsRoot, options.id));
	if (endpoint === undefined || endpoint.id !== options.id) throw await unavailable(directory, options.id);
	if (endpoint.version !== PRIMARY_ENDPOINT_VERSION)
		throw primaryEndpointIncompatibleError(options.id, endpointVersionLabel(endpoint.version));
	let client: TransportClient;
	try {
		client = await connectClient(options.id, endpoint.socketPath, endpoint.serverId, timeoutMs);
	} catch (error) {
		throw new PrimaryChannelUnavailableError(
			`primary channel ${options.id} is registered but unreachable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		const invoke = async (
			method: string,
			params: JsonValue | undefined,
			deadlineMs: number,
			signal?: AbortSignal,
		): Promise<unknown> => {
			const deadline = AbortSignal.timeout(deadlineMs);
			return client.request(
				{ method, ...(params === undefined ? {} : { params }) },
				signal === undefined ? deadline : AbortSignal.any([deadline, signal]),
			);
		};
		return {
			id: endpoint.id,
			info: async () => (await invoke("info", undefined, timeoutMs)) as PrimaryInfo,
			deliver: async (message) => {
				if (message.requireRetained !== undefined && typeof message.requireRetained !== "boolean")
					throw new TypeError("deliver requireRetained must be a boolean");
				await invoke(
					message.requireRetained === false ? "admit" : "deliver",
					{
						sourceId: message.sourceId,
						text: message.text,
						...(message.details === undefined ? {} : { details: message.details }),
						...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
					},
					timeoutMs,
				);
			},
			trustPrompt: async (cwd, signal) => {
				const value = await invoke("trustPrompt", cwd, TRUST_DECISION_TIMEOUT_MS, signal);
				if (value === null || value === undefined) return undefined;
				const answer = value as { trusted?: unknown; remember?: unknown };
				return { trusted: answer.trusted === true, remember: answer.remember === true };
			},
			close: async () => {
				await client.dispose().catch(() => undefined);
			},
		};
	} catch (error) {
		await client.dispose().catch(() => undefined);
		throw error;
	}
}

/** Path of the endpoint record for one primary id; a non-canonical id never reaches the filesystem. */
export function primaryEndpointPath(sessionsRoot: string, id: string): string {
	if (!UUID_ANY.test(id)) throw new TypeError(`primary id ${JSON.stringify(id)} is not a canonical UUID`);
	return join(resolve(sessionsRoot), ".primaries", `${id}.json`);
}

/** Cheap boundedly-read owner status without connecting; malformed and foreign records stay unknown. */
export function primaryEndpointStatus(sessionsRoot: string, id: string): PrimaryEndpointStatus {
	if (!UUID_ANY.test(id)) return { state: "unknown" };
	let record: RecordedPrimaryEndpoint | undefined;
	try {
		record = readEndpoint(primaryEndpointPath(sessionsRoot, id));
	} catch {
		return { state: "unknown" };
	}
	if (record === undefined) return { state: "absent" };
	return classifyEndpoint(record, id);
}

function classifyEndpoint(record: RecordedPrimaryEndpoint, id: string): PrimaryEndpointStatus {
	const version = endpointVersionLabel(record.version);
	if (record.id !== id || record.hostname !== hostname()) return { state: "unknown", version };
	const state = ownerState(record);
	if (state !== "live") return { state, version };
	return { state: record.version === PRIMARY_ENDPOINT_VERSION ? "live" : "incompatible", version };
}

/** One checked descriptor read uses the same parser and ownership rules as delivery. */
export function readPrimaryEndpointDescriptor(
	sessionsRoot: string,
	id: string,
): PrimaryEndpointStatus & { readonly info?: PrimaryInfo; readonly unreadable?: true } {
	if (!UUID_ANY.test(id)) return { state: "unknown", unreadable: true };
	try {
		const endpoint = readValidatedEndpoint(primaryEndpointPath(sessionsRoot, id));
		if (!endpoint) return { state: "absent" };
		if (endpoint.id !== id) return { state: "unknown", unreadable: true };
		const { version: _version, serverId: _serverId, ...info } = endpoint;
		return { ...classifyEndpoint(endpoint, id), info };
	} catch {
		return { state: "unknown", unreadable: true };
	}
}

/**
 * The descriptor that `readPrimaryEndpointDescriptor` returns, after the probe that its classification of a
 * live PID started has settled, so a crashed owner whose PID another process holds reads as dead. One record
 * read; a current probe adds no connection and no wait.
 */
export async function readVerifiedPrimaryEndpointDescriptor(
	sessionsRoot: string,
	id: string,
): Promise<ReturnType<typeof readPrimaryEndpointDescriptor>> {
	if (!UUID_ANY.test(id)) return { state: "unknown", unreadable: true };
	let endpoint: RecordedPrimaryEndpoint | undefined;
	try {
		endpoint = readValidatedEndpoint(primaryEndpointPath(sessionsRoot, id));
	} catch {
		return { state: "unknown", unreadable: true };
	}
	if (!endpoint) return { state: "absent" };
	if (endpoint.id !== id) return { state: "unknown", unreadable: true };
	const { version: _version, serverId: _serverId, ...info } = endpoint;
	return { ...(await settledClassification(endpoint, id)), info };
}

/** Classify a record, waiting for the socket probe that classifying a live PID started. */
async function settledClassification(record: RecordedPrimaryEndpoint, id: string): Promise<PrimaryEndpointStatus> {
	const status = classifyEndpoint(record, id);
	if (status.state !== "live" && status.state !== "incompatible") return status;
	// Only a record without any result waits; a stale result stands while its next probe runs.
	const key = probeKey(record);
	const running = ownerProbes.has(key) ? undefined : ownerProbing.get(key);
	if (running === undefined) return status;
	await running;
	return classifyEndpoint(record, id);
}

/** Owner state alone; a live incompatible owner never authorizes fallback or replacement. */
export function primaryEndpointOwnerState(sessionsRoot: string, id: string): PrimaryEndpointOwnerState {
	return primaryEndpointStatus(sessionsRoot, id).state;
}

/** One bounded liveness check that never mutates registration state. */
export async function probePrimaryChannel(sessionsRoot: string, id: string): Promise<boolean> {
	try {
		const connection = await connectPrimaryChannel({ id, sessionsRoot, timeoutMs: 1000 });
		await connection.close();
		return true;
	} catch {
		return false;
	}
}
