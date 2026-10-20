/** One-shot public retained reads, independent of live host acquisition and negotiation. */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, type ConversationId } from "@earendil-works/pi-durable";
import { AgentCatalog } from "./catalog.ts";
import { collaborationStorage, CollaborationReadError } from "./collaboration.ts";
import { DurableObservation, InspectionRequestError, parseInspectParams } from "./durable-observation.ts";
import { checkRetainedRead, RetainedReadError, type RetainedErrorCode } from "./retained-errors.ts";
import { HOST_CONTRACT, parseOperationContract, type OperationContract } from "./version-contract.ts";

export const RETAINED_READ_VERSION = "retained-read/1.0.0";
export const RETAINED_REQUEST_BYTES = 65536;
export const RETAINED_RESPONSE_BYTES = 16 * 1024 * 1024;
export const RETAINED_DEADLINE_MS = 30_000;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Params = Record<string, unknown>;
type CollaborationMethod = "collaboration-list" | "collaboration-read";
type RetainedMethod = "snapshot" | "inspect" | CollaborationMethod;
interface ReadRequest {
	version: typeof RETAINED_READ_VERSION;
	id: string;
	store: string;
	sessionId: string;
	method: RetainedMethod;
	expected: OperationContract;
	params: Params;
	storageId: string;
	conversationId: ConversationId;
}
export type RetainedResponse = {
	version: typeof RETAINED_READ_VERSION; id: string; ok: true;
	method: RetainedMethod; sessionId: string; storageId: string; conversationId: number; result: unknown;
} | {
	version: typeof RETAINED_READ_VERSION; id: string | null; ok: false;
	error: { code: RetainedErrorCode; message: string; retryable: boolean };
};

export function retainedReadDescriptor(scope?: "collaboration"): unknown {
	if (scope === "collaboration") return { version: RETAINED_READ_VERSION, upstream: HOST_CONTRACT.upstream, operations: { "collaboration-list": HOST_CONTRACT.operations["collaboration-list"], "collaboration-read": HOST_CONTRACT.operations["collaboration-read"] } };
	return { version: RETAINED_READ_VERSION, upstream: HOST_CONTRACT.upstream, operations: { snapshot: HOST_CONTRACT.operations.snapshot, inspect: HOST_CONTRACT.operations.inspect } };
}

function collaborationMethod(method: RetainedMethod): method is CollaborationMethod { return method === "collaboration-list" || method === "collaboration-read"; }

function object(value: unknown): value is Params { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value); }
function validId(value: unknown): value is string { return text(value, 256) && !/\s/u.test(value); }
function invalid(): never { throw new RetainedReadError("invalid_request"); }
function keys(value: Params, allowed: string[]): void { if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(); }
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }

function optionalInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
	if (value !== undefined && !integer(value, minimum, maximum)) invalid();
}

function snapshotParams(value: Params): void {
	keys(value, ["before", "limit", "maxBytes"]);
	optionalInteger(value.before, 1);
	optionalInteger(value.maxBytes, 1, 1048576);
}

function inspectNumbers(value: Params): void {
	for (const key of ["entryId", "fromId", "submissionId"]) optionalInteger(value[key], 1);
	optionalInteger(value.offset, 0);
}

function inspectTextAndCursor(value: Params): void {
	if (value.cursor !== undefined && (!object(value.cursor) || Buffer.byteLength(JSON.stringify(value.cursor)) > 4096)) invalid();
	if (value.query !== undefined && (typeof value.query !== "string" || value.query.length === 0 || value.query.length > 256)) invalid();
	for (const key of ["requestId", "operationId"]) if (value[key] !== undefined && !text(value[key], 1024)) invalid();
	if (value.source !== undefined && !["user", "assistant", "toolResult", "summary", "custom"].includes(value.source as string)) invalid();
}

function inspectSelectors(value: Params): void {
	if (!["history", "branch", "activity", "exact", "search", "result"].includes(value.view as string)) invalid();
	if (value.view === "exact" && value.entryId === undefined) invalid();
	if (value.view === "search" && value.query === undefined) invalid();
	if (value.requestId !== undefined && value.view !== "result") invalid();
	if (value.view === "result" && value.requestId === undefined && value.submissionId === undefined && value.operationId === undefined) invalid();
}

function collaborationParams(method: CollaborationMethod, value: Params, storageId: string): void {
	optionalInteger(value.limit, 1, 20);
	if (method === "collaboration-list") {
		keys(value, ["query", "cursor", "limit"]);
		if (value.query !== undefined && (typeof value.query !== "string" || value.query.trim().length === 0 || value.query.length > 256)) invalid();
		if (value.cursor !== undefined && (typeof value.cursor !== "string" || value.cursor.length > 16 || !/^(?:0|[1-9][0-9]*)$/u.test(value.cursor) || !integer(Number(value.cursor), 0))) invalid();
		return;
	}
	keys(value, ["threadId", "before", "limit"]);
	optionalInteger(value.before, 1);
	if (!text(value.threadId, 128)) invalid();
	try { if (collaborationStorage(value.threadId) !== storageId) invalid(); } catch { invalid(); }
}

function parseParams(method: ReadRequest["method"], value: unknown, storageId: string): Params {
	if (!object(value)) invalid();
	if (collaborationMethod(method)) collaborationParams(method, value, storageId);
	else {
		optionalInteger(value.limit, 1, 100);
		if (method === "snapshot") snapshotParams(value);
		else {
			keys(value, ["view", "limit", "cursor", "entryId", "fromId", "offset", "query", "source", "submissionId", "requestId", "operationId"]);
			inspectNumbers(value);
			inspectTextAndCursor(value);
			inspectSelectors(value);
			parseInspectParams(value);
		}
	}
	return value;
}

function parseTarget(sessionId: string, method: RetainedMethod): { storageId: string; conversationId: ConversationId } {
	const [storageId, suffix, extra] = sessionId.split(":");
	if (!UUID.test(storageId) || extra !== undefined || (suffix !== undefined && (!/^[1-9][0-9]*$/u.test(suffix) || !integer(Number(suffix), 2)))) invalid();
	if (collaborationMethod(method) && (suffix !== undefined || storageId.length !== 36)) invalid();
	return { storageId, conversationId: Number(suffix ?? 1) as ConversationId };
}

function parseRequest(value: unknown): ReadRequest {
	if (!object(value)) invalid();
	const required = ["version", "id", "store", "sessionId", "method", "expected", "params"];
	keys(value, required);
	if (required.some((key) => !Object.hasOwn(value, key))) invalid();
	if (!validId(value.id) || !text(value.store, 4096) || !isAbsolute(value.store) || typeof value.sessionId !== "string") invalid();
	if (value.method !== "snapshot" && value.method !== "inspect" && value.method !== "collaboration-list" && value.method !== "collaboration-read") invalid();
	const { storageId, conversationId } = parseTarget(value.sessionId, value.method);
	if (value.version !== RETAINED_READ_VERSION) throw new RetainedReadError("incompatible");
	let expected: OperationContract;
	try { expected = parseOperationContract(value.expected); } catch { invalid(); }
	const contract = HOST_CONTRACT.operations[value.method];
	if (expected.request !== contract.request || expected.response !== contract.response || expected.durable !== contract.durable) throw new RetainedReadError("incompatible");
	const params = parseParams(value.method, value.params, storageId);
	return { version: RETAINED_READ_VERSION, id: value.id, store: value.store, sessionId: value.sessionId, method: value.method, expected, params, storageId, conversationId };
}

export function retainedFailure(error: unknown, id: string | null): RetainedResponse {
	const failure = error instanceof RetainedReadError ? error : new RetainedReadError("internal");
	return { version: RETAINED_READ_VERSION, id, ok: false, error: { code: failure.code, message: failure.message, retryable: failure.retryable } };
}

/** Hooks replace only the boundary under test; production uses the catalog and private observation. */
export interface RetainedReadHooks {
	readonly readCatalog?: (store: string, storageId: string) => { storagePath: string };
	readonly open?: (storagePath: string, storageId: string, signal: AbortSignal) => Promise<Pick<DurableObservation, "conversation" | "request" | "close">>;
	readonly responseBytes?: number;
	readonly deadlineMs?: number;
}

interface ReadDeadline {
	readonly signal: AbortSignal;
	readonly deadline: number;
	check(): void;
	close(): void;
}

function readDeadline(signal: AbortSignal | undefined, deadline: number): ReadDeadline {
	const controller = new AbortController();
	const cancel = (): void => controller.abort(signal?.reason instanceof RetainedReadError ? signal.reason : new RetainedReadError("cancelled"));
	if (signal?.aborted) cancel();
	else signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => controller.abort(new RetainedReadError("timeout")), Math.max(0, deadline - Date.now()));
	return { signal: controller.signal, deadline, check: () => checkRetainedRead(controller.signal, deadline), close: () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); } };
}

function decodeRequest(bytes: Uint8Array): unknown {
	if (bytes.byteLength > RETAINED_REQUEST_BYTES) throw new RetainedReadError("limit_exceeded");
	try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { invalid(); }
}

function retainedRecord(request: ReadRequest, hooks: RetainedReadHooks): { storagePath: string } {
	try { return (hooks.readCatalog ?? ((store, storageId) => new AgentCatalog(store).read(storageId)))(request.store, request.storageId); }
	catch (error) { throw new RetainedReadError((error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "source_unreadable"); }
}

type ReadObservation = Pick<DurableObservation, "conversation" | "request" | "close">;

async function openRetainedObservation(request: ReadRequest, path: string, scope: ReadDeadline, hooks: RetainedReadHooks, context: Context): Promise<ReadObservation> {
	try {
		if (hooks.open) return await hooks.open(path, request.storageId, scope.signal);
		return await DurableObservation.open({ backupFrom: path, storageId: request.storageId, requireSourceExists: true, sourceRoot: request.store, deadline: scope.deadline, models: createModels(), registry: createRegistry() }, context);
	} catch (error) { scope.check(); throw error; }
}

function scopedThread(value: unknown, storageId: string): value is Params & { id: string } {
	if (!object(value) || typeof value.id !== "string") return false;
	try { return collaborationStorage(value.id) === storageId; } catch { return false; }
}

function collaborationResult(request: ReadRequest, result: unknown): unknown {
	if (!object(result)) throw new RetainedReadError("source_unreadable");
	if (request.method === "collaboration-read") {
		if (!scopedThread(result.thread, request.storageId) || result.thread.id !== request.params.threadId) throw new RetainedReadError("source_unreadable");
	} else if (!Array.isArray(result.items) || result.items.some((item) => !scopedThread(item, request.storageId))) throw new RetainedReadError("source_unreadable");
	return result;
}

function retainedRequestError(error: unknown): unknown {
	if (error instanceof InspectionRequestError) return new RetainedReadError("invalid_request");
	if (error instanceof CollaborationReadError) {
		const failure = new RetainedReadError(error.code);
		if (error.code === "not_found") failure.message = "The retained thread does not exist.";
		return failure;
	}
	return error;
}

async function readRetainedObservation(request: ReadRequest, observation: ReadObservation, scope: ReadDeadline, context: Context): Promise<unknown> {
	try {
		scope.check();
		if (!collaborationMethod(request.method) && !await observation.conversation(request.conversationId, context)) throw new RetainedReadError("not_found");
		scope.check();
		try {
			const result = await observation.request(request.method, { ...request.params, sessionId: request.sessionId }, context);
			return collaborationMethod(request.method) ? collaborationResult(request, result) : result;
		} catch (error) { throw retainedRequestError(error); }
	} finally { await observation.close(); }
}

async function executeRetainedRead(request: ReadRequest, scope: ReadDeadline, hooks: RetainedReadHooks): Promise<RetainedResponse> {
	scope.check();
	const record = retainedRecord(request, hooks);
	scope.check();
	const context = withAbortSignal(scope.signal, BACKGROUND_CONTEXT);
	const observation = await openRetainedObservation(request, record.storagePath, scope, hooks, context);
	const result = await readRetainedObservation(request, observation, scope, context);
	scope.check();
	const response: RetainedResponse = { version: RETAINED_READ_VERSION, id: request.id, ok: true, method: request.method, sessionId: request.sessionId, storageId: request.storageId, conversationId: request.conversationId, result };
	if (Buffer.byteLength(JSON.stringify(response)) + 1 > (hooks.responseBytes ?? RETAINED_RESPONSE_BYTES)) throw new RetainedReadError("limit_exceeded");
	scope.check();
	return response;
}

function checkedFailure(error: unknown, id: string | null, scope: ReadDeadline): RetainedResponse {
	try { scope.check(); } catch (stopped) { return retainedFailure(stopped, id); }
	return retainedFailure(error, id);
}

export async function retainedRead(bytes: Uint8Array, signal?: AbortSignal, hooks: RetainedReadHooks = {}, absoluteDeadline?: number): Promise<RetainedResponse> {
	let id: string | null = null;
	const scope = readDeadline(signal, absoluteDeadline ?? Date.now() + (hooks.deadlineMs ?? RETAINED_DEADLINE_MS));
	try {
		scope.check();
		const value = decodeRequest(bytes);
		if (object(value) && validId(value.id)) id = value.id;
		return await executeRetainedRead(parseRequest(value), scope, hooks);
	} catch (error) { return checkedFailure(error, id, scope); }
	finally { scope.close(); }
}

function readInput(signal: AbortSignal): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let length = 0;
		const finish = (error?: unknown): void => {
			process.stdin.off("data", data); process.stdin.off("end", end); process.stdin.off("error", failed); process.stdin.off("close", closed);
			signal.removeEventListener("abort", abort);
			process.stdin.pause();
			if (error) reject(error); else resolve(Buffer.concat(chunks));
		};
		const data = (chunk: Buffer): void => {
			length += chunk.length;
			if (length > RETAINED_REQUEST_BYTES) finish(new RetainedReadError("limit_exceeded")); else chunks.push(Buffer.from(chunk));
		};
		const end = (): void => finish();
		const failed = (): void => finish(new RetainedReadError("invalid_request"));
		const closed = (): void => finish(new RetainedReadError("cancelled"));
		const abort = (): void => finish(signal.reason);
		process.stdin.on("data", data); process.stdin.once("end", end); process.stdin.once("error", failed); process.stdin.once("close", closed);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

async function main(): Promise<void> {
	const deadline = Date.now() + RETAINED_DEADLINE_MS;
	const controller = new AbortController();
	const cancel = (): void => {
		controller.abort(new RetainedReadError("cancelled"));
		process.stdin.destroy();
	};
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	const timer = setTimeout(() => { controller.abort(new RetainedReadError("timeout")); process.stdin.destroy(); }, RETAINED_DEADLINE_MS);
	let output: unknown;
	let ok = false;
	try {
		const args = process.argv.slice(2);
		if (args[0] === "--contract" && (args.length === 1 || (args.length === 2 && args[1] === "collaboration"))) {
			output = retainedReadDescriptor(args.length === 2 ? "collaboration" : undefined); ok = true;
		}
		else {
			if (args.length !== 0) invalid();
			const input = await readInput(controller.signal);
			checkRetainedRead(controller.signal);
			const response = await retainedRead(input, controller.signal, {}, deadline);
			output = response; ok = response.ok;
		}
	} catch (error) { output = retainedFailure(controller.signal.aborted ? controller.signal.reason : error, null); }
	finally { clearTimeout(timer); process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
	process.stdout.write(`${JSON.stringify(output)}\n`);
	process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
