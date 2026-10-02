/**
 * agent/host-protocol: the wire contract for durable host processes.
 *
 * One host process owns one Durable storage. Clients connect over a Unix
 * socket in a private per-storage directory. Every frame is a 4-byte
 * big-endian length followed by UTF-8 JSON, bounded by HOST_MAX_FRAME_BYTES.
 * The host writes an endpoint file with its generated handshake token after it
 * takes the writer claim, so the token never appears in process arguments or
 * the environment.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type ClaimIdentity, claimPath } from "./claims.ts";

/** Wire version; both peers refuse any other value. */
export const HOST_PROTOCOL_VERSION = 1;
/** Largest JSON payload of one frame. A larger declared frame ends the link. */
export const HOST_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Bound for a client hello before the host closes the connection. */
export const HOST_HELLO_TIMEOUT_MS = 10_000;
/** Readiness line the host prints after it starts listening. */
export const HOST_READY_PREFIX = "PI_AGENT_HOST_READY ";
/** Largest accepted failure response body. */
export const HOST_ERROR_MESSAGE_LIMIT = 8192;

const LENGTH_BYTES = 4;
const PATH_LIMIT = 4096;
const IDENTITY_LIMIT = 512;
const NAME_LIMIT = 256;
const METHOD_LIMIT = 128;
const ERROR_MESSAGE_LIMIT = HOST_ERROR_MESSAGE_LIMIT;
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

/** Failure codes a runtime may attach to a request error. */
export const HOST_ERROR_CODES = ["invalid", "unavailable", "claim", "internal"] as const;
export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

export interface HostErrorPayload {
	readonly message: string;
	readonly code?: HostErrorCode;
}

/** An error from a runtime or a remote host. The code survives the wire. */
export class HostError extends Error {
	readonly code: HostErrorCode;
	constructor(message: string, code: HostErrorCode = "internal", options?: ErrorOptions) {
		super(message, options);
		this.name = "HostError";
		this.code = code;
	}
}

export interface HostHello {
	readonly kind: "hello";
	readonly version: number;
	readonly token: string;
	readonly metadata: HostMetadata;
}

export interface HostWelcome {
	readonly kind: "welcome";
	readonly version: number;
	readonly pid: number;
	readonly storageId: string;
	readonly socketPath: string;
}

export interface HostRequestMessage {
	readonly kind: "request";
	readonly id: string;
	readonly method: string;
	readonly params?: unknown;
}

/** Client withdrawal of an observational wait. It never cancels admitted work. */
export interface HostCancelMessage {
	readonly kind: "cancel";
	readonly id: string;
}

export type HostResponseMessage =
	| { readonly kind: "response"; readonly id: string; readonly ok: true; readonly result: unknown }
	| { readonly kind: "response"; readonly id: string; readonly ok: false; readonly error: HostErrorPayload };

export type HostClientMessage = HostHello | HostRequestMessage | HostCancelMessage;
export type HostServerMessage = HostWelcome | HostResponseMessage;
export type HostMessage = HostClientMessage | HostServerMessage;

/** Host-transport endpoint record; readable only by the host's user. */
export interface HostEndpoint {
	readonly version: number;
	readonly pid: number;
	readonly socketPath: string;
	readonly token: string;
	readonly createdAt: string;
}

/** Private directory, socket, endpoint, and claim paths for one host identity. */
export interface HostPaths {
	readonly directory: string;
	readonly socket: string;
	readonly endpoint: string;
	readonly claim: string;
	readonly identity: ClaimIdentity;
}

export interface HostReady {
	readonly pid: number;
	readonly socketPath: string;
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

function positiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new Error(`${field} must be a positive integer`);
	return value;
}

function timestampText(value: unknown, field: string): string {
	const text = boundedText(value, field, 64);
	if (new Date(text).toISOString() !== text) throw new Error(`${field} must be an ISO timestamp`);
	return text;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`${field} has unsupported field ${key}`);
	}
}

/** Strict metadata validation for spawn arguments and for hello echo. */
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

function parseErrorPayload(value: unknown): HostErrorPayload {
	if (!isRecord(value)) throw new Error("host error must be an object");
	const code = value.code;
	if (code !== undefined && !HOST_ERROR_CODES.includes(code as HostErrorCode)) throw new Error("host error code is unsupported");
	return {
		message: boundedText(value.message, "host error message", ERROR_MESSAGE_LIMIT),
		...(code === undefined ? {} : { code: code as HostErrorCode }),
	};
}

export function parseHostClientMessage(value: unknown): HostClientMessage {
	if (!isRecord(value)) throw new Error("host message must be an object");
	if (value.kind === "hello") {
		return {
			kind: "hello",
			version: positiveInteger(value.version, "host hello version"),
			token: boundedText(value.token, "host hello token", NAME_LIMIT),
			metadata: parseHostMetadata(value.metadata),
		};
	}
	if (value.kind === "request") {
		return {
			kind: "request",
			id: boundedText(value.id, "host request id", METHOD_LIMIT),
			method: boundedText(value.method, "host request method", METHOD_LIMIT),
			...(value.params === undefined ? {} : { params: value.params }),
		};
	}
	if (value.kind === "cancel") return { kind: "cancel", id: boundedText(value.id, "host cancel id", METHOD_LIMIT) };
	throw new Error("host client message kind is unsupported");
}

export function parseHostServerMessage(value: unknown): HostServerMessage {
	if (!isRecord(value)) throw new Error("host message must be an object");
	if (value.kind === "welcome") {
		return {
			kind: "welcome",
			version: positiveInteger(value.version, "host welcome version"),
			pid: positiveInteger(value.pid, "host welcome pid"),
			storageId: boundedText(value.storageId, "host welcome storageId", IDENTITY_LIMIT),
			socketPath: boundedText(value.socketPath, "host welcome socketPath", PATH_LIMIT),
		};
	}
	if (value.kind === "response") {
		const id = boundedText(value.id, "host response id", METHOD_LIMIT);
		if (value.ok === true) return { kind: "response", id, ok: true, result: value.result };
		if (value.ok === false) return { kind: "response", id, ok: false, error: parseErrorPayload(value.error) };
		throw new Error("host response needs a boolean ok field");
	}
	throw new Error("host server message kind is unsupported");
}

/** Encode one length-prefixed JSON frame; an oversized payload refuses before write. */
export function encodeHostFrame(message: HostMessage): Buffer {
	const payload = Buffer.from(JSON.stringify(message), "utf8");
	if (payload.byteLength > HOST_MAX_FRAME_BYTES) throw new RangeError(`host frame of ${payload.byteLength} bytes exceeds the ${HOST_MAX_FRAME_BYTES}-byte bound`);
	const frame = Buffer.allocUnsafe(LENGTH_BYTES + payload.byteLength);
	frame.writeUInt32BE(payload.byteLength, 0);
	payload.copy(frame, LENGTH_BYTES);
	return frame;
}

/** Incremental frame reader. It refuses an oversized declaration before buffering the payload. */
export class HostFrameDecoder {
	private buffer: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): HostMessage[] {
		if (chunk.length === 0) return [];
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const messages: HostMessage[] = [];
		let offset = 0;
		while (this.buffer.length - offset >= LENGTH_BYTES) {
			const length = this.buffer.readUInt32BE(offset);
			if (length > HOST_MAX_FRAME_BYTES) throw new RangeError(`declared host frame of ${length} bytes exceeds the ${HOST_MAX_FRAME_BYTES}-byte bound`);
			if (this.buffer.length - offset - LENGTH_BYTES < length) break;
			const payload = this.buffer.subarray(offset + LENGTH_BYTES, offset + LENGTH_BYTES + length);
			let value: unknown;
			try {
				value = JSON.parse(payload.toString("utf8"));
			} catch (error) {
				throw new Error("host frame is not valid JSON", { cause: error });
			}
			messages.push(value as HostMessage);
			offset += LENGTH_BYTES + length;
		}
		this.buffer = offset === 0 ? this.buffer : this.buffer.subarray(offset);
		return messages;
	}
}

export function parseHostEndpoint(value: unknown): HostEndpoint {
	if (!isRecord(value)) throw new Error("host endpoint must be an object");
	return {
		version: positiveInteger(value.version, "host endpoint version"),
		pid: positiveInteger(value.pid, "host endpoint pid"),
		socketPath: boundedText(value.socketPath, "host endpoint socketPath", PATH_LIMIT),
		token: boundedText(value.token, "host endpoint token", NAME_LIMIT),
		createdAt: timestampText(value.createdAt, "host endpoint createdAt"),
	};
}

/** Largest Unix socket path length that works on every supported host (macOS sun_path is 104 bytes). */
export const HOST_SOCKET_PATH_LIMIT_BYTES = 100;

/**
 * Choose a socket path under the host directory, or a short temporary path when
 * that directory is too deep for the platform limit. The fallback is stable
 * for one host key, so every process derives the same address.
 */
function socketPath(directory: string, key: string): string {
	const preferred = join(directory, "host.sock");
	if (Buffer.byteLength(preferred, "utf8") <= HOST_SOCKET_PATH_LIMIT_BYTES) return preferred;
	const candidates = [join(tmpdir(), "pi-hosts", `${key.slice(0, 24)}.sock`), join(tmpdir(), `${key.slice(0, 16)}.sock`)];
	for (const candidate of candidates) {
		if (Buffer.byteLength(candidate, "utf8") <= HOST_SOCKET_PATH_LIMIT_BYTES) return candidate;
	}
	throw new Error(`no Unix socket path within ${HOST_SOCKET_PATH_LIMIT_BYTES} bytes for durable host ${directory}`);
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
	return { directory, socket: socketPath(directory, key), endpoint: join(directory, "endpoint.json"), claim: claimPath(directory, identity), identity };
}

export function formatHostReady(ready: HostReady): string {
	return `${HOST_READY_PREFIX}${JSON.stringify({ pid: ready.pid, socketPath: ready.socketPath })}\n`;
}

/** Parse one readiness line. A non-matching line yields undefined; a matching line with a bad body throws. */
export function parseHostReadyLine(line: string): HostReady | undefined {
	if (!line.startsWith(HOST_READY_PREFIX)) return undefined;
	const value: unknown = JSON.parse(line.slice(HOST_READY_PREFIX.length));
	if (!isRecord(value)) throw new Error("host readiness line is not an object");
	return { pid: positiveInteger(value.pid, "host readiness pid"), socketPath: boundedText(value.socketPath, "host readiness socketPath", PATH_LIMIT) };
}

export function newHostToken(): string {
	return randomBytes(32).toString("hex");
}

export function hostTokensMatch(left: string, right: string): boolean {
	const a = Buffer.from(left, "utf8");
	const b = Buffer.from(right, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Methods a client may resend after a link failure. A safe method must be
 * idempotent for its parameters. `submit`, `report`, and `acknowledge` dedupe
 * by request ID or acknowledgement state; read methods are naturally safe.
 * Unknown methods are never retried.
 */
const HOST_RETRY_SAFE_METHODS: ReadonlySet<string> = new Set(["submit", "report", "acknowledge", "inspect", "status", "list", "receipts", "dashboard", "snapshot"]);

export function isRetrySafeHostMethod(method: string): boolean {
	return HOST_RETRY_SAFE_METHODS.has(method);
}

/**
 * True only for an observational wait a client may withdraw. Cancellation ends
 * the wait; it never aborts admitted Durable work.
 */
export function isCancelableHostWait(method: string, params: unknown): boolean {
	return method === "receipts" && isRecord(params) && params.wait === true;
}
