/**
 * agent/host-protocol: host metadata, identities, and method policy.
 *
 * The wire transport is the public Pi service protocol: a `pi-server` Unix
 * server in the host process and a `pi-client` Unix client in the caller. This
 * module keeps the validated host metadata, the per-storage directory, claim
 * identity and socket path, the process readiness line, and the method policy
 * the client applies across link recovery. Peer authentication is the Unix
 * socket boundary: a private directory and a socket created owner-only (0600)
 * by the public listener.
 */
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getUnixSocketPath } from "@earendil-works/pi-server/unix";
import { type ClaimIdentity, claimPath } from "./claims.ts";

/** Chord service identity for the storage host's request surface. */
export const HOST_SERVICE_ID = "pi.agent.host";
/**
 * Host runtime contract version. Bump this when the host method set or the wire
 * contract changes. A host that reports no version predates this handshake and
 * reads as version 0, so a current client can recognize it and replace it when
 * it goes idle.
 */
export const HOST_RUNTIME_VERSION = 2;
/** Method member that reports the runtime version of one live host. */
export const HOST_RUNTIME_VERSION_MEMBER = "runtime-version";
/** Chord service identity for the host's coalesced change notifications. */
export const HOST_CHANGE_SERVICE_ID = "pi.agent.host.changes";
/** State member published on every actual host write. */
export const HOST_CHANGE_MEMBER = "change";
/** Chord service identity prefix for one observation token's live frames. */
export const HOST_OBSERVE_SERVICE_ID = "pi.agent.host.observe";
/** State member published on the observation service. */
export const HOST_OBSERVE_MEMBER = "frame";
/** Readiness line the host prints after it starts listening. */
export const HOST_READY_PREFIX = "PI_AGENT_HOST_READY ";
/** Largest Unix socket path length that works on every supported host (macOS sun_path is 104 bytes). */
export const HOST_SOCKET_PATH_LIMIT_BYTES = 100;

const PATH_LIMIT = 4096;
const IDENTITY_LIMIT = 512;
const NAME_LIMIT = 256;
const INVALID_TEXT = /[\u0000-\u001f\u007f-\u009f]/u;

/** Stable model selection stored with a host; the runtime maps it to a provider model. */
export interface HostModel {
	readonly provider: string;
	readonly modelId: string;
}

/** Serializable description of one durable host. Exactly these fields cross the process boundary. */
export interface HostMetadata {
	readonly storageId: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly packageDir: string;
	readonly storagePath: string;
	readonly model: HostModel;
	readonly thinkingLevel: string;
	readonly name?: string;
	readonly trust?: boolean;
	readonly ownerId?: string;
}

/** Application failure codes carried inside a host error message. */
export type HostErrorCode = "invalid" | "unavailable" | "claim" | "internal";

/** An error from a runtime or a remote host. The public protocol carries its message and a generic code. */
export class HostError extends Error {
	readonly code: string;
	constructor(message: string, code: string = "internal", options?: ErrorOptions) {
		super(message, options);
		this.name = "HostError";
		this.code = code;
	}
}

/** Private directory, socket, and claim paths for one host identity. */
export interface HostPaths {
	readonly directory: string;
	/** Canonical v4 identity the public Unix transport expects in the handshake. */
	readonly serverId: string;
	readonly socket: string;
	readonly claim: string;
	readonly identity: ClaimIdentity;
}

export interface HostReady {
	readonly pid: number;
	readonly socketPath: string;
	/** Runtime contract version; 0 when an older host omits the field. */
	readonly runtimeVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, field: string, limit: number, allowEmpty = false): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	if (value.length > limit) throw new Error(`${field} exceeds its ${limit}-character bound`);
	if (!allowEmpty && value.length === 0) throw new Error(`${field} must not be empty`);
	if (INVALID_TEXT.test(value)) throw new Error(`${field} contains control characters`);
	return value;
}

function absolutePath(value: unknown, field: string): string {
	const text = boundedText(value, field, PATH_LIMIT);
	if (!isAbsolute(text)) throw new Error(`${field} must be an absolute path`);
	return text;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`${field} has unsupported field ${key}`);
	}
}

/** Strict metadata validation for spawn arguments and for the host process. */
export function parseHostMetadata(value: unknown): HostMetadata {
	if (!isRecord(value)) throw new Error("host metadata must be an object");
	rejectUnknownFields(value, ["storageId", "cwd", "agentDir", "packageDir", "storagePath", "model", "thinkingLevel", "name", "trust", "ownerId"], "host metadata");
	if (!isRecord(value.model)) throw new Error("host metadata model must be an object");
	rejectUnknownFields(value.model, ["provider", "modelId"], "host metadata model");
	if (value.trust !== undefined && typeof value.trust !== "boolean") throw new Error("host metadata trust must be a boolean");
	return {
		storageId: boundedText(value.storageId, "host metadata storageId", IDENTITY_LIMIT),
		cwd: absolutePath(value.cwd, "host metadata cwd"),
		agentDir: absolutePath(value.agentDir, "host metadata agentDir"),
		packageDir: absolutePath(value.packageDir, "host metadata packageDir"),
		storagePath: absolutePath(value.storagePath, "host metadata storagePath"),
		model: {
			provider: boundedText(value.model.provider, "host metadata model.provider", IDENTITY_LIMIT),
			modelId: boundedText(value.model.modelId, "host metadata model.modelId", IDENTITY_LIMIT),
		},
		thinkingLevel: boundedText(value.thinkingLevel, "host metadata thinkingLevel", NAME_LIMIT),
		...(value.name === undefined ? {} : { name: boundedText(value.name, "host metadata name", NAME_LIMIT, true) }),
		...(value.trust === undefined ? {} : { trust: value.trust }),
		...(value.ownerId === undefined ? {} : { ownerId: boundedText(value.ownerId, "host metadata ownerId", IDENTITY_LIMIT) }),
	};
}

/**
 * Derive the canonical v4 server identity a public Unix endpoint requires from
 * the harness storage identity. The harness storage ID stays free-form.
 */
function serverIdFor(storageId: string, cwd: string): string {
	const digest = createHash("sha256").update(`pi.agent.host\u0000${storageId}\u0000${resolve(cwd)}`).digest("hex");
	const variant = ((Number.parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Choose a short socket directory. The public server binds
 * `<directory>/<serverId>.sock`, so the directory must keep the socket path
 * inside the platform limit. The private per-account paths come first.
 */
function socketDirectory(agentDir: string, serverId: string): string {
	const candidates = [join(agentDir, "durable-hosts"), join(tmpdir(), "pi-hosts"), join("/tmp", "pi-hosts")];
	for (const directory of candidates) {
		if (Buffer.byteLength(getUnixSocketPath(serverId, directory), "utf8") <= HOST_SOCKET_PATH_LIMIT_BYTES) return directory;
	}
	throw new Error(`no Unix socket path within ${HOST_SOCKET_PATH_LIMIT_BYTES} bytes for durable host ${serverId}`);
}

/**
 * Derive the private host directory from the agent directory and the storage
 * identity. The key is stable for one storage and separate for a different
 * storage or working directory.
 */
export function hostPaths(metadata: Pick<HostMetadata, "agentDir" | "storageId" | "cwd">): HostPaths {
	const key = createHash("sha256").update(`${metadata.storageId}\u0000${resolve(metadata.cwd)}`).digest("hex");
	const directory = join(metadata.agentDir, "durable-hosts", key);
	const identity: ClaimIdentity = { sessionId: metadata.storageId, cwd: metadata.cwd };
	const serverId = serverIdFor(metadata.storageId, metadata.cwd);
	return { directory, serverId, socket: getUnixSocketPath(serverId, socketDirectory(metadata.agentDir, serverId)), claim: claimPath(directory, identity), identity };
}

export function formatHostReady(ready: HostReady): string {
	return `${HOST_READY_PREFIX}${JSON.stringify({ pid: ready.pid, socketPath: ready.socketPath, runtimeVersion: ready.runtimeVersion })}\n`;
}

/** Parse one readiness line. A non-matching line yields undefined; a matching line with a bad body throws. */
export function parseHostReadyLine(line: string): HostReady | undefined {
	if (!line.startsWith(HOST_READY_PREFIX)) return undefined;
	const value: unknown = JSON.parse(line.slice(HOST_READY_PREFIX.length));
	if (!isRecord(value)) throw new Error("host readiness line is not an object");
	if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error("host readiness pid must be a positive integer");
	// A missing runtime version is an older host by definition; a present value must be exact.
	const runtimeVersion = value.runtimeVersion === undefined ? 0 : value.runtimeVersion;
	if (typeof runtimeVersion !== "number" || !Number.isSafeInteger(runtimeVersion) || runtimeVersion < 0) throw new Error("host readiness runtimeVersion must be a nonnegative integer");
	return { pid: value.pid, socketPath: boundedText(value.socketPath, "host readiness socketPath", PATH_LIMIT), runtimeVersion };
}

/**
 * Methods a client may resend after a link failure. A safe method must be
 * idempotent for its parameters. `submit`, `report`, and `acknowledge` dedupe
 * by request ID or acknowledgement state; read methods are naturally safe.
 * Unknown methods are never retried.
 */
const HOST_RETRY_SAFE_METHODS: ReadonlySet<string> = new Set(["submit", "report", "acknowledge", "inspect", "status", "list", "receipts", "dashboard", "snapshot", "observe-open", "observe-frame", "observe-close", "timer-list"]);

/** Service id one observation token subscribes to for live frames. */
export function observationServiceId(token: string): string {
	return `${HOST_OBSERVE_SERVICE_ID}:${token}`;
}

/** Token carried by one observation service id; undefined for any other service id. */
export function observationTokenFromServiceId(serviceId: string): string | undefined {
	const prefix = `${HOST_OBSERVE_SERVICE_ID}:`;
	if (!serviceId.startsWith(prefix)) return undefined;
	const token = serviceId.slice(prefix.length);
	return token === "" ? undefined : token;
}

export function isRetrySafeHostMethod(method: string): boolean {
	return HOST_RETRY_SAFE_METHODS.has(method);
}

/**
 * First runtime version that serves one host method. Methods absent from the
 * table exist in every version. A newer window calling a newer-only method on an
 * older host gets the update-pending error instead of a raw unknown-method one.
 */
const HOST_METHOD_MIN_VERSION: ReadonlyMap<string, number> = new Map([
	[HOST_RUNTIME_VERSION_MEMBER, 1],
	["close", 2],
	["reset", 1],
	["timer-schedule", 1],
	["timer-list", 1],
	["timer-cancel", 1],
	["observe-open", 1],
	["observe-frame", 1],
	["observe-close", 1],
]);

/** First runtime version that serves one host method; 0 for every method all versions serve. */
export function hostMethodMinVersion(method: string): number {
	return HOST_METHOD_MIN_VERSION.get(method) ?? 0;
}

/** Clear refusal when an older host does not serve a method the caller needs. */
export function hostUpdatePendingError(method: string, runtimeVersion: number): HostError {
	const reason = method === "close" ? "cannot close its process safely" : `does not support ${method}`;
	const action = runtimeVersion < hostMethodMinVersion("close")
		? "Automatic update is blocked. Close its older Pi clients so an idle host can retire, then use agent_attach."
		: "It updates when idle.";
	return new HostError(`This agent's host runs older code and ${reason}. ${action}`, "unavailable");
}

/**
 * True only for an observational wait whose caller may withdraw it. The client
 * passes the caller's abort signal to the wire for these calls, so the public
 * cancel envelope reaches the host. Other requests never carry an abort signal;
 * admitted Durable work is never cancelled by a client disconnect or abort.
 */
export function isCancelableHostWait(method: string, params: unknown): boolean {
	return method === "receipts" && isRecord(params) && params.wait === true;
}
