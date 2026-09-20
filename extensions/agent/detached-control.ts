/** Public Pi transport for controls sent to the process that owns a detached run. */
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdtempSync, openSync, readSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createRemoteServiceBinding, createRemoteServiceEndpoint, defineService, RemoteServiceError, RemoteServiceProvider, type Context, type ServiceCall } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { SessionMetadata } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Client, createClientServiceTransport } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { ServerDrainingError, SessionNotFoundError, type RoutedSessionAttachment, type ServerHost } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { DetachedRuns, type DetachedRunRequest } from "./detached.ts";
import type { AgentWorkerSession, WorkerStatus } from "./worker.ts";

type InspectOptions = { cursor?: number; limit?: number; entryId?: string; offset?: number };
type Inspection = Awaited<ReturnType<AgentWorkerSession["inspect"]>>;
type ControlWorker = Pick<AgentWorkerSession, "status" | "inspect" | "steer">;

interface AttachmentService {
	attach(sessionId: string, context: Context): Promise<void>;
}
interface ControlService {
	status(context: Context): Promise<string>;
	inspect(options: InspectOptions, context: Context): Promise<string>;
	steer(message: string, images: ImageContent[] | null, context: Context): Promise<void>;
	abort(context: Context): Promise<boolean>;
}
const Attachment = defineService<AttachmentService>("agent.run-attachment");
const Control = defineService<ControlService>("agent.run-control");
const MAX_ENDPOINT_BYTES = 4096;
const MAX_OBSERVATION_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const CONTROL_TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface ControlEndpoint {
	runId: string;
	sessionId: string;
	pid: number;
	serverId: string;
	path: string;
}

function endpointFile(request: DetachedRunRequest): string {
	return `${new DetachedRuns(request.sessionsRoot).requestFile(request.runId)}.control.json`;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maxBytes;
}
function privateOwner(stat: Stats): boolean {
	return (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid());
}
function validEndpoint(value: unknown, request: DetachedRunRequest): value is ControlEndpoint {
	return object(value) && Object.keys(value).sort().join(",") === "path,pid,runId,serverId,sessionId"
		&& value.runId === request.runId && value.sessionId === request.sessionId && value.pid === request.pid
		&& typeof value.serverId === "string" && UUID.test(value.serverId)
		&& text(value.path, 100) && isAbsolute(value.path) && basename(value.path) === "s.sock";
}

function readEndpointDescriptor(request: DetachedRunRequest): ControlEndpoint | undefined {
	let fd: number | undefined;
	try {
		// Special files must not block before fstat admits an owner-private regular file.
		fd = openSync(endpointFile(request), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || !privateOwner(stat) || stat.size > MAX_ENDPOINT_BYTES) throw new Error("invalid detached control descriptor file");
		const data = Buffer.alloc(MAX_ENDPOINT_BYTES + 1);
		let count = 0;
		while (count < data.length) {
			const read = readSync(fd, data, count, data.length - count, null);
			if (!read) break;
			count += read;
		}
		if (count > MAX_ENDPOINT_BYTES) throw new Error("detached control descriptor exceeds its byte limit");
		const value: unknown = JSON.parse(data.toString("utf8", 0, count));
		if (!validEndpoint(value, request)) throw new Error("detached control descriptor does not match its run");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Missing readiness is distinct from a malformed or mismatched descriptor. */
export function readControlEndpoint(request: DetachedRunRequest): ControlEndpoint | undefined {
	const value = readEndpointDescriptor(request);
	if (!value) return undefined;
	try {
		const directory = lstatSync(dirname(value.path));
		const socket = lstatSync(value.path);
		if (!directory.isDirectory() || !privateOwner(directory) || !socket.isSocket() || !privateOwner(socket)) {
			throw new Error("detached control route is not an owner-private socket");
		}
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function invalid(message: string): never {
	throw new RemoteServiceError("service_invalid_value", message);
}
function checkInspect(value: unknown): asserts value is InspectOptions {
	if (!object(value) || Object.keys(value).some((key) => !["cursor", "limit", "entryId", "offset"].includes(key))) invalid("invalid inspect options");
	for (const key of ["cursor", "offset"] as const) {
		if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) invalid(`invalid inspect ${key}`);
	}
	if (value.limit !== undefined && (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 12)) invalid("invalid inspect limit");
	if (value.entryId !== undefined && !text(value.entryId, 256)) invalid("invalid inspect entryId");
}
function checkSteer(message: unknown, images: unknown): void {
	if (!text(message, MAX_INPUT_BYTES)) invalid("invalid steering message or message exceeds its byte limit");
	if (images === null) return;
	if (!Array.isArray(images) || images.length > 8) invalid("invalid steering images");
	let bytes = 0;
	for (const image of images) {
		if (!object(image) || Object.keys(image).sort().join(",") !== "data,mimeType,type" || image.type !== "image"
			|| !text(image.data, MAX_IMAGE_BYTES) || !text(image.mimeType, 100) || !image.mimeType.startsWith("image/")) invalid("invalid steering image");
		bytes += Buffer.byteLength(image.data);
		if (bytes > MAX_IMAGE_BYTES) invalid("steering images exceed their byte limit");
	}
}
function checkCall(call: ServiceCall, serviceId: string): void {
	if (call.serviceId !== serviceId) return;
	const counts: Record<string, number> = serviceId === Attachment.id ? { attach: 1 } : { status: 0, inspect: 1, steer: 2, abort: 0 };
	if (Object.hasOwn(counts, call.member) && call.args.length !== counts[call.member]) invalid("invalid detached control argument count");
}
function observation(value: unknown, sessionId: string): string {
	if (!object(value) || value.sessionId !== sessionId) invalid("detached observation has the wrong session identity");
	const serialized = JSON.stringify(value);
	if (Buffer.byteLength(serialized) > MAX_OBSERVATION_BYTES) invalid("detached observation exceeds its byte limit");
	return serialized;
}
function parseObservation<T>(serialized: string, sessionId: string): T {
	if (!text(serialized, MAX_OBSERVATION_BYTES)) throw new Error("invalid detached observation or observation exceeds its byte limit");
	const value: unknown = JSON.parse(serialized);
	if (!object(value) || value.sessionId !== sessionId) throw new Error("detached observation has the wrong session identity");
	return value as T;
}

export interface DetachedControlServerOptions {
	request: DetachedRunRequest;
	metadata: SessionMetadata;
	worker: ControlWorker;
	requestAbort(): Promise<boolean> | Promise<void> | boolean | void;
	canSteer(): boolean;
}
export interface DetachedControlServer {
	sealAndDrain(): Promise<void>;
	close(): Promise<void>;
}

/** Readiness belongs to this process; a view never acquires worker ownership. */
export async function createDetachedControlServer(options: DetachedControlServerOptions): Promise<DetachedControlServer> {
	const { request, worker } = options;
	if (request.pid !== process.pid || request.launchState !== "started") throw new Error("detached control server requires its owning run process");
	if (options.metadata.id !== request.sessionId) throw new Error("detached control metadata does not match its session");
	const directory = mkdtempSync(join(tmpdir(), "pi-ac-"));
	const path = join(directory, "s.sock");
	const descriptor: ControlEndpoint = { runId: request.runId, sessionId: request.sessionId, pid: request.pid, serverId: randomUUID(), path };
	const file = endpointFile(request);
	const temporary = `${file}.${descriptor.serverId}.tmp`;
	const pending = new Set<Promise<unknown>>();
	let sealed = false;
	let published = false;
	let closeTask: Promise<void> | undefined;
	const admit = <T>(action: () => Promise<T>): Promise<T> => {
		if (sealed) return Promise.reject(new ServerDrainingError());
		const task = Promise.resolve().then(action);
		pending.add(task);
		void task.then(() => pending.delete(task), () => pending.delete(task));
		return task;
	};
	const provider = new RemoteServiceProvider([{ service: Control, mode: "singleton" }]);
	provider.provide(Control, {
		status: async () => observation(await worker.status(), request.sessionId),
		inspect: async (input) => { checkInspect(input); return observation(await worker.inspect(input), request.sessionId); },
		steer: async (message, images) => {
			checkSteer(message, images);
			if (!options.canSteer()) throw new ServerDrainingError();
			await worker.steer(message, images ?? undefined);
		},
		abort: async () => (await options.requestAbort()) !== false,
	});
	const endpointAttachment = (source: RemoteServiceProvider, serviceId: string): RoutedSessionAttachment => {
		const endpoint = createRemoteServiceEndpoint(source);
		return {
			invokeService: (call, publish, context) => admit(async () => { checkCall(call, serviceId); return endpoint.invoke(call, publish, context); }),
			release: () => endpoint.dispose(),
		};
	};
	const host: ServerHost = {
		serverServices: {
			attachClient(presentation) {
				const connectionProvider = new RemoteServiceProvider([{ service: Attachment, mode: "singleton" }]);
				connectionProvider.provide(Attachment, {
					async attach(sessionId, context) {
						if (!text(sessionId, 256) || sessionId !== request.sessionId) throw new SessionNotFoundError();
						await presentation.attachSession(sessionId, context);
					},
				});
				const endpoint = endpointAttachment(connectionProvider, Attachment.id);
				return { ...endpoint, release: async (context) => { await endpoint.release(context); connectionProvider.dispose(); } };
			},
		},
		async resolveSession(sessionId) {
			if (sessionId !== request.sessionId) throw new SessionNotFoundError();
			return options.metadata;
		},
		async openSession() {
			return { attachClient: () => endpointAttachment(provider, Control.id), close: async () => {} };
		},
	};
	const server = createUnixServer(host, { serverId: descriptor.serverId, path, maxFrameLength: MAX_FRAME_BYTES, gracefulCloseTimeoutMs: 1000 });
	const sealAndDrain = async (): Promise<void> => {
		sealed = true;
		await Promise.allSettled(pending);
	};
	const close = (): Promise<void> => {
		closeTask ??= (async () => {
			await sealAndDrain();
			const errors: unknown[] = [];
			const attempt = async (action: () => unknown) => { try { await action(); } catch (error) { errors.push(error); } };
			if (published) await attempt(() => {
				const current = readEndpointDescriptor(request);
				if (current && (current.serverId !== descriptor.serverId || current.path !== path)) throw new Error("detached control descriptor was replaced");
				if (current) unlinkSync(file);
				published = false;
			});
			await attempt(() => server.close());
			await attempt(() => provider.dispose());
			await attempt(() => rmdirSync(directory));
			if (errors.length) throw new AggregateError(errors, "detached control cleanup failed");
		})();
		return closeTask;
	};
	try {
		await server.start();
		const serialized = JSON.stringify(descriptor);
		if (!validEndpoint(descriptor, request) || Buffer.byteLength(serialized) > MAX_ENDPOINT_BYTES) throw new Error("invalid detached control route");
		writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
		try { linkSync(temporary, file); published = true; } finally { unlinkSync(temporary); }
		return { sealAndDrain, close };
	} catch (error) {
		try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "detached control startup and cleanup failed"); }
		throw error;
	}
}

export interface DetachedControlClient {
	status(): Promise<WorkerStatus>;
	inspect(options?: InspectOptions): Promise<Inspection>;
	steer(message: string, images?: ImageContent[]): Promise<void>;
	abort(): Promise<boolean>;
}

/** One bounded connection, no replay, and no implicit cancellation of remote work. */
export async function withDetachedControl<T>(request: DetachedRunRequest, callback: (control: DetachedControlClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
	const endpoint = readControlEndpoint(request);
	if (!endpoint) throw new Error(`detached control endpoint is not ready for run ${request.runId}`);
	const timeout = AbortSignal.timeout(CONTROL_TIMEOUT_MS);
	const cancellation = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const context = withAbortSignal(cancellation, BACKGROUND_CONTEXT);
	const client = new Client({ serverId: endpoint.serverId, transportFactory: createUnixTransportFactory({ path: endpoint.path }), maxFrameLength: MAX_FRAME_BYTES });
	const disconnect = () => client.disconnect("detached control caller stopped; accepted work was not replayed");
	cancellation.addEventListener("abort", disconnect, { once: true });
	let attachmentBinding: ReturnType<typeof createRemoteServiceBinding> | undefined;
	let controlBinding: ReturnType<typeof createRemoteServiceBinding> | undefined;
	try {
		cancellation.throwIfAborted();
		await awaitWithContext(client.connect(), context);
		attachmentBinding = createRemoteServiceBinding({ services: [Attachment], transport: createClientServiceTransport(client, () => ({ serverId: endpoint.serverId })) });
		const attachment = attachmentBinding.use(Attachment);
		await attachmentBinding.ready(context);
		await attachment.attach(request.sessionId, context);
		controlBinding = createRemoteServiceBinding({ services: [Control], transport: createClientServiceTransport(client, () => client.attachment) });
		const remote = controlBinding.use(Control);
		await controlBinding.ready(context);
		const control: DetachedControlClient = {
			status: async () => parseObservation<WorkerStatus>(await remote.status(context), request.sessionId),
			inspect: async (input = {}) => { checkInspect(input); return parseObservation<Inspection>(await remote.inspect(input, context), request.sessionId); },
			steer: async (message, images) => { checkSteer(message, images ?? null); await remote.steer(message, images ?? null, context); },
			abort: async () => remote.abort(context),
		};
		return await awaitWithContext(callback(control), context);
	} finally {
		cancellation.removeEventListener("abort", disconnect);
		// Disconnect first: subscription disposal must not await remote unsubscribe replies.
		await client.dispose();
		await Promise.allSettled([controlBinding?.dispose(BACKGROUND_CONTEXT), attachmentBinding?.dispose(BACKGROUND_CONTEXT)]);
	}
}
