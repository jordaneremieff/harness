/**
 * primary-channel: the local endpoint through which a Durable host reaches the
 * ordinary primary session that owns it.
 *
 * The primary session registers one channel: a public `pi-server` Unix server
 * whose service members deliver a message, ask for a project-trust decision, and
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
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, chmodSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Context, JsonValue, ServiceCall, ServiceProviderUpdate } from "@earendil-works/chord";
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import type { ByteTransport, ByteTransportFactory } from "@earendil-works/pi-client";
import { ServerError, type RoutedServerServiceAttachment, type ServerHost } from "@earendil-works/pi-server";
import { createUnixServer, getUnixSocketPath } from "@earendil-works/pi-server/unix";
import { PRIMARY_DELIVERY_CONTRACT } from "./version-contract.ts";
import type { ProjectTrustDecision } from "./trust-support.ts";

/** Service id all primary channel calls use. */
export const PRIMARY_CHANNEL_SERVICE_ID = "pi.agent.primary";
/** Current notice contract includes explicit quiet-delivery semantics. */
export const PRIMARY_ENDPOINT_VERSION = PRIMARY_DELIVERY_CONTRACT;
const ENDPOINT_BYTES = 16 * 1024;
const LIST_LIMIT = 20;
const VISIT_LIMIT = 256;
const SOCKET_PATH_BYTES = 100;
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
	/** Primary session id; must be a canonical lowercase UUIDv4. */
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
}

export interface PrimaryChannel {
	readonly id: string;
	readonly socketPath: string;
	info(): PrimaryInfo;
	/** Replace the displayed identity fields; the announced server identity and socket stay unchanged. */
	update(info: { name: string | undefined; model: { provider: string; modelId: string } | undefined; thinkingLevel: string | undefined }): void;
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
async function connectClient(id: string, socketPath: string, serverId: string, timeoutMs: number): Promise<Client> {
	const base = createUnixTransportFactory({ path: socketPath });
	const transports = new Set<ByteTransport>();
	const factory: ByteTransportFactory = async (handlers) => {
		const transport = await base(handlers);
		transports.add(transport);
		return transport;
	};
	const connecting = Client.connect({ transportFactory: factory, serverId });
	const timer: { handle?: ReturnType<typeof setTimeout> } = {};
	const expired = new Promise<never>((_resolve, reject) => {
		timer.handle = setTimeout(() => {
			for (const transport of transports) transport.close();
			reject(new PrimaryChannelUnavailableError(`primary channel ${id} did not complete its identity handshake within ${timeoutMs} ms`));
		}, timeoutMs);
		timer.handle.unref?.();
	});
	try {
		return await Promise.race([connecting, expired]);
	} catch (error) {
		void connecting.then((client) => client.dispose().catch(() => undefined), () => undefined);
		throw error;
	} finally {
		if (timer.handle !== undefined) clearTimeout(timer.handle);
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

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value === "") throw new PrimaryChannelUnavailableError(`primary endpoint ${key} must be a non-empty string`);
	return value;
}

/** Required identity fields of one endpoint record. */
function endpointIdentity(record: Record<string, unknown>): Pick<PrimaryEndpoint, "id" | "serverId" | "cwd" | "hostname" | "socketPath" | "startedAt"> {
	const id = optionalString(record, "id");
	const serverId = optionalString(record, "serverId");
	const cwd = optionalString(record, "cwd");
	const host = optionalString(record, "hostname");
	const socketPath = optionalString(record, "socketPath");
	const startedAt = optionalString(record, "startedAt");
	if (id === undefined || serverId === undefined || cwd === undefined || host === undefined || socketPath === undefined || startedAt === undefined) throw new PrimaryChannelUnavailableError("primary endpoint identity is incomplete");
	if (!UUID_ANY.test(id) || !UUID_V4.test(serverId)) throw new PrimaryChannelUnavailableError("primary endpoint identities are not canonical UUIDs");
	return { id, serverId, cwd, hostname: host, socketPath, startedAt };
}

/** Optional model identity of one endpoint record. */
function endpointModel(record: Record<string, unknown>): { provider: string; modelId: string } | undefined {
	const model = record.model;
	if (model === undefined) return undefined;
	if (model === null || typeof model !== "object" || typeof (model as { provider?: unknown }).provider !== "string" || typeof (model as { modelId?: unknown }).modelId !== "string") throw new PrimaryChannelUnavailableError("primary endpoint model is invalid");
	return model as { provider: string; modelId: string };
}

/** Positive process id of one endpoint record. */
function endpointPid(record: Record<string, unknown>): number {
	if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) throw new PrimaryChannelUnavailableError("primary endpoint pid is invalid");
	return record.pid;
}

/** Validate one decoded endpoint record. The contract version is checked by the caller. */
function parseEndpoint(value: unknown): RecordedPrimaryEndpoint {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PrimaryChannelUnavailableError("primary endpoint is not an object");
	const record = value as Record<string, unknown>;
	const version = record.version;
	const identity = endpointIdentity(record);
	const name = optionalString(record, "name");
	const model = endpointModel(record);
	const thinkingLevel = optionalString(record, "thinkingLevel");
	return {
		version,
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
		if (!stat.isFile() || stat.size > ENDPOINT_BYTES) throw new PrimaryChannelUnavailableError("primary endpoint exceeds its bound or is not a regular file");
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

/** Publish one complete record exclusively; an existing path refuses publication. */
function publishEndpoint(path: string, endpoint: PrimaryEndpoint): void {
	writeFileSync(path, JSON.stringify(endpoint), { flag: "wx", mode: 0o600 });
}

/** Replace one complete record atomically, so a reader never sees a partial write. */
function rewriteEndpoint(path: string, endpoint: PrimaryEndpoint): void {
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(endpoint), { mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		removeFile(temporary);
	}
}

/** Remove one file, ignoring its absence. */
function removeFile(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (errnoCode(error) !== "ENOENT") throw error;
	}
}

/** Derived socket path with the host transport's deep-root fallback. */
function primarySocketPath(serverId: string, directory: string): string {
	const preferred = getUnixSocketPath(serverId, directory);
	if (Buffer.byteLength(preferred, "utf8") <= SOCKET_PATH_BYTES) return preferred;
	const fallbackDir = join(tmpdir(), "pi-primary");
	mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
	const key = createHash("sha256").update(serverId).digest("hex").slice(0, 24);
	return join(fallbackDir, `${key}.sock`);
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
		if (entry.isFile() && entry.name.endsWith(".json") && UUID_ANY.test(entry.name.slice(0, -5))) ids.push(entry.name.slice(0, -5));
		if (visited >= VISIT_LIMIT || ids.length >= LIST_LIMIT) {
			complete = false;
			break;
		}
	}
	ids.sort();
	return { ids, complete };
}

/**
 * Remove a stale record only when its owner is a proven dead local PID and the
 * file identity still matches the read, so a live or concurrently replaced
 * record is never removed.
 */
function removeDeadEndpoint(endpointPath: string, id: string): void {
	const file = readEndpointFile(endpointPath);
	if (file === undefined) return;
	if (file.endpoint.id !== id) throw new PrimaryChannelConflictError(`primary channel ${id} has an invalid endpoint record`);
	if (file.endpoint.hostname !== hostname()) throw new PrimaryChannelConflictError(`primary channel ${id} is registered on another host (${file.endpoint.hostname}); refusing local replacement`);
	if (processState(file.endpoint.pid) !== "dead") throw new PrimaryChannelConflictError(`primary channel ${id} is already registered by live PID ${file.endpoint.pid}; refusing replacement`);
	const current = lstatSync(endpointPath, { throwIfNoEntry: false });
	if (current === undefined) return;
	if (current.dev !== file.dev || current.ino !== file.ino) throw new PrimaryChannelConflictError(`primary channel ${id} changed during registration; retry`);
	removeFile(endpointPath);
	removeFile(file.endpoint.socketPath);
}

/** The server-side attachment host for one primary channel. */
class PrimaryChannelHost implements ServerHost {
	readonly serverServices = {
		attachClient: (): RoutedServerServiceAttachment => ({ invokeService: (call: ServiceCall, _publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => void | Promise<void>, _context: Context) => this.dispatch(call), release: () => {} }),
	};

	readonly resolveSession = async (): Promise<never> => {
		throw new ServerError("session_not_found", "this primary channel routes no sessions");
	};

	readonly openSession = async (): Promise<never> => {
		throw new ServerError("session_not_found", "this primary channel routes no sessions");
	};

	private readonly options: PrimaryChannelOptions;
	private endpoint: PrimaryEndpoint;
	private readonly endpointPath: string;

	constructor(options: PrimaryChannelOptions, endpoint: PrimaryEndpoint, endpointPath: string) {
		this.options = options;
		this.endpoint = endpoint;
		this.endpointPath = endpointPath;
	}

	info(): PrimaryInfo {
		const { version: _version, serverId: _serverId, ...info } = this.endpoint;
		return info;
	}

	/** Replace the displayed identity fields and rewrite the endpoint record atomically. */
	update(info: { name: string | undefined; model: { provider: string; modelId: string } | undefined; thinkingLevel: string | undefined }): void {
		const { version, id, serverId, cwd, hostname, pid, socketPath, startedAt } = this.endpoint;
		this.endpoint = {
			version,
			id,
			serverId,
			cwd,
			hostname,
			pid,
			socketPath,
			startedAt,
			...(info.name === undefined ? {} : { name: info.name }),
			...(info.model === undefined ? {} : { model: { provider: info.model.provider, modelId: info.model.modelId } }),
			...(info.thinkingLevel === undefined ? {} : { thinkingLevel: info.thinkingLevel }),
		};
		rewriteEndpoint(this.endpointPath, this.endpoint);
	}

	private async dispatch(call: ServiceCall): Promise<JsonValue | undefined> {
		if (call.serviceId !== PRIMARY_CHANNEL_SERVICE_ID) throw new ServerError("service_not_found", `unknown primary channel service ${call.serviceId}`);
		switch (call.member) {
			case "info":
				return this.info() as unknown as JsonValue;
			case "deliver":
				return this.deliver(call.args[0]);
			case "trustPrompt":
				return this.trustPrompt(call.args[0]);
			default:
				throw new ServerError("service_invalid_value", `unknown primary channel member ${call.member}`);
		}
	}

	/** Display one validated message in the primary session. */
	private async deliver(raw: unknown): Promise<JsonValue> {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ServerError("service_invalid_value", "deliver requires a message object");
		const message = raw as Record<string, unknown>;
		if (typeof message.sourceId !== "string" || message.sourceId === "" || typeof message.text !== "string") throw new ServerError("service_invalid_value", "deliver requires sourceId and text");
		if (message.replyTo !== undefined && typeof message.replyTo !== "string") throw new ServerError("service_invalid_value", "deliver replyTo must be a string");
		await this.options.deliver({
			sourceId: message.sourceId,
			text: message.text,
			...(message.details === undefined ? {} : { details: message.details as JsonValue }),
			...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
		});
		return null;
	}

	/** Ask the primary UI for one trust decision. */
	private async trustPrompt(raw: unknown): Promise<JsonValue> {
		if (typeof raw !== "string" || raw === "") throw new ServerError("service_invalid_value", "trustPrompt requires a cwd string");
		const answer = await this.options.promptTrust(raw);
		return answer === undefined ? null : { trusted: answer.trusted, remember: answer.remember ?? null };
	}
}

/** Build one endpoint record for this process. */
function endpointRecord(options: PrimaryChannelOptions, serverId: string, socketPath: string): PrimaryEndpoint {
	return {
		version: PRIMARY_ENDPOINT_VERSION,
		id: options.id,
		serverId,
		cwd: options.cwd,
		...(options.name === undefined ? {} : { name: options.name }),
		...(options.model === undefined ? {} : { model: { provider: options.model.provider, modelId: options.model.modelId } }),
		...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
		hostname: hostname(),
		pid: process.pid,
		socketPath,
		startedAt: new Date().toISOString(),
	};
}

/** Register one live primary channel. Rejects while another owner is registered. */
export async function createPrimaryChannel(options: PrimaryChannelOptions): Promise<PrimaryChannel> {
	if (!UUID_ANY.test(options.id)) throw new TypeError("primary channel id must be a canonical lowercase UUID");
	const directory = join(resolve(options.sessionsRoot), ".primaries");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const endpointPath = join(directory, `${options.id}.json`);
	removeDeadEndpoint(endpointPath, options.id);
	const serverId = randomUUID();
	const socketPath = primarySocketPath(serverId, directory);
	const endpoint = endpointRecord(options, serverId, socketPath);
	const host = new PrimaryChannelHost(options, endpoint, endpointPath);
	const server = createUnixServer(host, { serverId, path: socketPath, mode: 0o600 });
	try {
		await server.start();
	} catch (error) {
		await server.close().catch(() => undefined);
		throw error;
	}
	try {
		publishEndpoint(endpointPath, endpoint);
	} catch (error) {
		await server.close().catch(() => undefined);
		removeFile(socketPath);
		if (errnoCode(error) === "EEXIST") throw new PrimaryChannelConflictError(`primary channel ${options.id} was registered concurrently; refusing replacement`);
		throw error;
	}
	let closePromise: Promise<void> | undefined;
	/** Idempotent teardown: every caller awaits the same in-flight promise. */
	const close = (): Promise<void> => {
		if (closePromise) return closePromise;
		closePromise = (async () => {
			options.signal?.removeEventListener("abort", onAbort);
			await server.close().catch(() => undefined);
			removeFile(socketPath);
			try {
				const current = readEndpoint(endpointPath);
				if (current !== undefined && current.pid === process.pid && current.serverId === serverId) removeFile(endpointPath);
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
	return { id: options.id, socketPath, info: () => host.info(), update: (info) => host.update(info), close };
}

/** Compose the unknown-id refusal with a bounded supported-id page. */
async function unavailable(directory: string, id: string): Promise<PrimaryChannelUnavailableError> {
	const { ids, complete } = await listPrimaryIds(directory).catch(() => ({ ids: [], complete: false }));
	const list = ids.length === 0 ? "none" : ids.join(", ");
	return new PrimaryChannelUnavailableError(`no live primary channel for ${id}; supported ids: ${list} (coverage: ${complete ? "complete" : "partial"})`);
}

/** Connect to one registered primary channel and prove the announced serverId within a bounded deadline. */
export async function connectPrimaryChannel(options: { readonly id: string; readonly sessionsRoot: string; readonly timeoutMs?: number }): Promise<PrimaryChannelConnection> {
	if (!UUID_ANY.test(options.id)) throw new PrimaryChannelUnavailableError(`primary id ${JSON.stringify(options.id)} is not a canonical UUID; no primary channel was read`);
	const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const directory = join(resolve(options.sessionsRoot), ".primaries");
	const endpoint = readEndpoint(primaryEndpointPath(options.sessionsRoot, options.id));
	if (endpoint === undefined || endpoint.id !== options.id) throw await unavailable(directory, options.id);
	if (endpoint.version !== PRIMARY_ENDPOINT_VERSION) throw primaryEndpointIncompatibleError(options.id, endpointVersionLabel(endpoint.version));
	let client: Client;
	try {
		client = await connectClient(options.id, endpoint.socketPath, endpoint.serverId, timeoutMs);
	} catch (error) {
		throw new PrimaryChannelUnavailableError(`primary channel ${options.id} is registered but unreachable: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		if (client.hello?.serverId !== endpoint.serverId) throw new PrimaryChannelUnavailableError(`primary channel ${options.id} announced serverId ${String(client.hello?.serverId)}; identity handshake failed`);
		const invoke = async (member: string, args: readonly JsonValue[], deadlineMs: number, signal?: AbortSignal): Promise<JsonValue | undefined> => {
			const deadline = AbortSignal.timeout(deadlineMs);
			return client.request({ serverId: endpoint.serverId }, { serviceId: PRIMARY_CHANNEL_SERVICE_ID, member, args }, signal === undefined ? deadline : AbortSignal.any([deadline, signal]));
		};
		return {
			id: endpoint.id,
			info: async () => (await invoke("info", [], timeoutMs)) as unknown as PrimaryInfo,
			deliver: async (message) => {
				await invoke("deliver", [{
					sourceId: message.sourceId,
					text: message.text,
					...(message.details === undefined ? {} : { details: message.details }),
					...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
				}], timeoutMs);
			},
			trustPrompt: async (cwd, signal) => {
				const value = await invoke("trustPrompt", [cwd], TRUST_DECISION_TIMEOUT_MS, signal);
				if (value === null || value === undefined) return undefined;
				const answer = value as { trusted?: unknown; remember?: unknown };
				return { trusted: answer.trusted === true, remember: answer.remember === true };
			},
			close: async () => { await client.dispose().catch(() => undefined); },
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
	const version = endpointVersionLabel(record.version);
	if (record.id !== id || record.hostname !== hostname()) return { state: "unknown", version };
	const state = processState(record.pid);
	if (state !== "live") return { state, version };
	return { state: record.version === PRIMARY_ENDPOINT_VERSION ? "live" : "incompatible", version };
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
