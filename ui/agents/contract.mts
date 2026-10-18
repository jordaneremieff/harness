import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { LIMITS } from "../shared/api.ts";
import type { NativeInputMessage, NativeInputPart } from "./input.mts";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type OperationContract = Readonly<{ request: string; response: string; durable?: string }>;
export type OperationName = "dashboard" | "snapshot" | "inspect" | "observe-open" | "observe-frame"
	| "observe-close" | "changes" | "task-submit" | "abort" | "configure" | "collaboration-list" | "collaboration-read"
	| "status" | "command";
export type RuntimeDescriptor = {
	format: "pi.agent.contract/1"; release: string;
	upstream: { codingAgent: string; durable: string };
	requires: { codingAgent: string; durable: string };
	operations: Record<string, OperationContract>;
};
export type Summary = {
	id: string; storageId: string; cwd: string; modifiedAt: number; owner: "here" | "unavailable" | "unknown";
	state: "starting" | "working" | "idle" | "done" | "failed" | "stopped" | "interrupted" | "new" | "unavailable";
	cost: number; partial: boolean; creatingOwnerId?: string; name?: string; firstMessage?: string;
	model?: { provider: string; modelId: string; thinkingLevel: string }; ownerLabel?: string; latestReply?: string;
	error?: string; toolCalls?: number; currentTool?: { name: string; argument: string }; durationMs?: number;
	health?: JsonObject; awaiting?: JsonValue; profile?: JsonValue;
};
export type Publication = { updatedAt: string; rows: Summary[]; coverage: { complete: boolean; omitted: number };
	storageId?: string; unavailable?: string; profiles?: JsonValue; profileSeed?: JsonValue; modelEvidence?: JsonValue };
type Entry = JsonObject & { id: string; kind: string };
type Coverage = JsonObject & { complete: boolean; entries: number; bytes: number; hiddenExcluded: number;
	entryLimitReached: boolean; byteLimitReached: boolean };
export type Snapshot = JsonObject & { entries: Entry[]; partial: boolean; revision: string;
	nextBefore: number | null; coverage: Coverage };
export type ConversationFrame = JsonObject & { scope: "conversation"; storageId: string; conversationId: number;
	revision: number; observedAt: string; entries: Entry[]; live: Entry[]; nextBefore: number | null;
	status: JsonObject; coverage: Coverage };
export type Admission = JsonObject & { submissionId: number; conversationId: number; deduped: boolean;
	identity: string; result: JsonObject & { sessionId: string; submissionId: number; requestId?: string } };
export type AbortReceipt = JsonObject & { conversationId: number; identity: string; background: boolean };
export type InspectResult = JsonObject & { view: string; sessionId: string; conversationId: number };
/** What one live host reports as installed: contribution commands, extensions without commands, and extensions that failed to load. */
export type HostInventory = { contributions: { name: string; source: string; commands: { name: string; description: string }[] }[];
	ordinaryOnly: string[]; failed?: { path: string; error: string }[] };
/** A status reply for one conversation. A retained, not-live host reply carries no inventory. */
export type StatusReply = JsonObject & { storageId: string; inventory?: HostInventory };
export type CommandResult = JsonObject & { name: string; conversationId: number; identity: string; text: string };
export type ThreadSummary = { id: string; title: string; purpose: string; updatedAt: number; closed: boolean; members: number };
export type ThreadList = { items: ThreadSummary[]; nextCursor: string | null;
	coverage: { complete: boolean; visited: number; omitted: number; unavailable?: number } };
export type ThreadMember = { identity: string; contribution: string; joinedAt: number };
export type ThreadFrame = { title: string; purpose: string; authority: string; source: string; restrictions: string;
	acceptance: string; integrator: string };
export type ThreadRecord = ThreadFrame & { id: string; creator: string; createdAt: number; updatedAt: number; revision: number;
	closed: boolean; sequence: number; members: ThreadMember[] };
export type ThreadEvent = { threadId: string; sequence: number; at: number; sender: string; origin: "model" | "operator";
	kind: string; message: string; source: string; replyTo: number | null; revision: number; notify: string[] };
export type ThreadPage = { thread: ThreadRecord; events: ThreadEvent[]; nextBefore: number | null; pending: number;
	coverage: { complete: boolean; bytes: number } };
type Context = { identity?: string; requestId?: string; token?: string };
type Responses = {
	dashboard: Summary[]; snapshot: Snapshot; inspect: InspectResult;
	"observe-open": JsonObject & { token: string; frame: ConversationFrame | JsonObject };
	"observe-frame": ConversationFrame | JsonObject; "observe-close": JsonObject & { closed: boolean };
	changes: JsonObject; "task-submit": Admission; abort: AbortReceipt; configure: never;
	"collaboration-list": ThreadList; "collaboration-read": ThreadPage;
	status: StatusReply; command: CommandResult;
};

export class ContractError extends Error {
	readonly code: "malformed" | "incompatible" | "unavailable";
	constructor(message: string, code: ContractError["code"] = "malformed") {
		super(message); this.name = "ContractError"; this.code = code;
	}
}
function requireValue(ok: unknown, message: string): asserts ok {
	if (!ok) throw new ContractError(message);
}
function unavailable(message: string): never { throw new ContractError(message, "unavailable"); }
function object(value: unknown): JsonObject {
	requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a JSON object");
	return value as JsonObject;
}
function string(value: unknown, max = 2000, empty = false): asserts value is string {
	requireValue(typeof value === "string" && value.length <= max && (empty || value.length > 0), "Invalid string");
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
	requireValue(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max, "Invalid integer");
}
function boolean(value: unknown): asserts value is boolean { requireValue(typeof value === "boolean", "Invalid boolean"); }
function choice(value: unknown, values: readonly string[]): void { requireValue(values.includes(value as string), "Invalid choice"); }
function fields(o: JsonObject, names: string[], check: (v: JsonValue) => void): void {
	for (const name of names) check(o[name]);
}
function optional(o: JsonObject, names: string[], check: (v: JsonValue) => void): void {
	for (const name of names) if (o[name] !== undefined) check(o[name]);
}
function array(value: unknown, check: (v: JsonValue) => void, max = 10000): void {
	requireValue(Array.isArray(value) && value.length <= max, "Invalid array");
	for (const item of value) check(item);
}
function nullableId(value: JsonValue): void { if (value !== null) integer(value, 1); }
function timestamp(value: JsonValue): void {
	string(value, 64); requireValue(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "Invalid timestamp");
}
function only(o: JsonObject, names: string[]): void {
	requireValue(Object.keys(o).every(k => names.includes(k)), "Unsupported field");
}

// Native output has its own bound; snapshot coverage.bytes is not a serialized output bound.
function json(value: unknown): JsonValue {
	let nodes = 0; let bytes = 0;
	const visit = (v: unknown, depth: number): void => {
		requireValue(++nodes <= 250000 && depth <= 64, "JSON structure exceeds consumer bound");
		if (typeof v === "string") bytes += Buffer.byteLength(v) + 2;
		else if (typeof v === "number") requireValue(Number.isFinite(v), "Non-finite JSON number");
		else if (v !== null && typeof v === "object") visitObject(v, depth);
		else requireValue(v === null || typeof v === "boolean", "Non-JSON value");
		requireValue(bytes <= 16 * 1024 * 1024, "JSON exceeds 16 MiB consumer bound");
	};
	const visitObject = (v: object, depth: number): void => {
		requireValue(Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null,
			"Non-JSON object");
		requireValue(Object.getOwnPropertySymbols(v).length === 0, "Non-JSON symbol property");
		if (Array.isArray(v)) requireValue(v.length <= 250000 && Object.keys(v).length === v.length, "Invalid JSON array");
		for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
			if (Array.isArray(v) && key === "length") continue;
			requireValue("value" in d && d.enumerable, "Non-JSON property");
			bytes += Buffer.byteLength(key) + 4; visit(d.value, depth + 1);
		}
	};
	visit(value, 0);
	const encoded = JSON.stringify(value);
	requireValue(Buffer.byteLength(encoded) <= 16 * 1024 * 1024, "JSON exceeds 16 MiB consumer bound");
	return JSON.parse(encoded) as JsonValue;
}
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function semver(value: unknown, stable = false): number[] {
	string(value, 128); const match = semverPattern.exec(value);
	requireValue(match && (!stable || !match[4]), "Invalid semantic version");
	if (match[4]) requireValue(match[4].split(".").every(part => !/^\d+$/.test(part) || part === "0" || part[0] !== "0"),
		"Invalid numeric prerelease identifier");
	const parts = match.slice(1, 4).map(Number); for (const part of parts) integer(part); return parts;
}
function meets(version: string, floor: string): boolean {
	const a = semver(version); const b = semver(floor, true);
	for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
	return !version.split("+")[0].includes("-");
}
function nativeVersion(): string | undefined {
	try {
		const path = createRequire(import.meta.url).resolve("@earendil-works/pi-durable/package.json");
		const metadata = object(json(JSON.parse(readFileSync(path, "utf8"))));
		requireValue(metadata.name === "@earendil-works/pi-durable", "Wrong Durable package metadata");
		semver(metadata.version); return metadata.version as string;
	} catch { return undefined; }
}
const durable = nativeVersion();
const opaque = new Set<OperationName>(["snapshot", "inspect", "observe-open", "observe-frame", "status", "command"]);
function contract(member: string, version = "1.0.0", response = `${member}/${version}`, native = false): OperationContract {
	return Object.freeze({ request: `${member}/${version}`, response, ...(native && durable ? { durable } : {}) });
}
export const supportedOperations: Readonly<Record<OperationName, OperationContract>> = Object.freeze({
	dashboard: contract("dashboard", "1.0.0", "a89f98f3eb28c78f115c0010581107073600bfb9ec44934ad622aeb5d1cffcd7"),
	snapshot: contract("snapshot", "1.0.0", "snapshot/2.0.0", true),
	inspect: contract("inspect", "1.1.0", "d38d5e5a297d6b3738547ab0154cd494602f01c4a898423a076d2d946e430a6b", true),
	"observe-open": contract("observe-open", "1.0.0", "observe-open/2.0.0", true),
	"observe-frame": contract("observe-frame", "1.0.0", "observe-frame/2.0.0", true),
	"observe-close": contract("observe-close"), changes: contract("changes"),
	"task-submit": contract("task-submit", "1.0.0", "task-submit/1.2.0"), abort: contract("abort"),
	configure: contract("configure", "1.3.0"),
	"collaboration-list": contract("collaboration-list"), "collaboration-read": contract("collaboration-read"),
	status: contract("status", "1.0.0", "294bb95f3d60b9c9ae2976f291e4f8d41c11d00ec517c1aebcfd9c7af40a3087", true),
	command: contract("command", "1.1.0", "command/1.0.0", true),
});
function operation(value: JsonValue): OperationContract {
	const o = object(value); only(o, ["request", "response", "durable"]);
	fields(o, ["request", "response"], v => { string(v, 256); requireValue(!/[\s\x00-\x1f\x7f]/.test(v), "Invalid operation identity"); });
	if (o.durable !== undefined) semver(o.durable);
	return o as OperationContract;
}
export function decodeDescriptor(value: unknown): RuntimeDescriptor {
	const o = object(json(value)); only(o, ["format", "release", "upstream", "requires", "operations"]);
	requireValue(o.format === "pi.agent.contract/1", "Invalid descriptor format"); semver(o.release);
	const upstream = object(o.upstream); const floors = object(o.requires);
	for (const key of ["codingAgent", "durable"]) {
		semver(upstream[key]); semver(floors[key], true);
		requireValue(meets(upstream[key] as string, floors[key] as string), "Unmet host API floor");
	}
	const operations = object(o.operations); requireValue(Object.keys(operations).length <= 128, "Too many operations");
	for (const [member, value] of Object.entries(operations)) {
		requireValue(/^[a-z][a-z0-9-]{0,127}$/.test(member), "Invalid operation name"); operation(value);
	}
	return o as unknown as RuntimeDescriptor;
}
export function assertOperation(descriptor: Pick<RuntimeDescriptor, "operations">, member: OperationName): OperationContract {
	if (member === "configure") unavailable("Configure is unavailable: execution selection is not decoded");
	if (opaque.has(member) && !durable) unavailable("Durable package metadata is unavailable");
	const local = Object.hasOwn(supportedOperations, member) ? supportedOperations[member] : undefined;
	const remote = Object.hasOwn(descriptor.operations, member) ? descriptor.operations[member] : undefined;
	if (!local || !remote || local.request !== remote.request || local.response !== remote.response || local.durable !== remote.durable)
		throw new ContractError(`Incompatible operation: ${member}`, "incompatible");
	return local;
}
export type RetainedMethod = "snapshot" | "inspect";
export type RetainedDescriptor = {version: "retained-read/1.0.0"; upstream: RuntimeDescriptor["upstream"];
	operations: Record<RetainedMethod, OperationContract>};
export type RetainedFailure = {ok: false; error: {code: string; message: string; retryable: boolean}};
const retainedErrors: Readonly<Record<string, boolean>> = Object.freeze({invalid_request:false, incompatible:false,
	not_found:false, source_changed:true, source_unreadable:false, limit_exceeded:false, timeout:true, cancelled:false, internal:false});
export function decodeRetainedDescriptor(value: unknown): RetainedDescriptor {
	const o = object(json(value)); only(o, ["version", "upstream", "operations"]);
	if (o.version !== "retained-read/1.0.0") throw new ContractError("Incompatible retained reader version", "incompatible");
	const upstream = object(o.upstream); only(upstream, ["codingAgent", "durable"]);
	fields(upstream, ["codingAgent", "durable"], v => semver(v));
	const operations = object(o.operations); only(operations, ["snapshot", "inspect"]);
	for (const member of ["snapshot", "inspect"] as const) {
		const parsed = operation(operations[member]);
		requireValue(parsed.durable === upstream.durable, "Reader Durable identity disagrees with its operation");
	}
	return o as unknown as RetainedDescriptor;
}
export function retainedTarget(value: unknown): {storageId: string; conversationId: number} {
	string(value, 256);
	requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[1-9]\d*)?$/.test(value), "Invalid retained target");
	return identity(value);
}
export function decodeRetainedParams(member: RetainedMethod, value: unknown, targetIdentity: string): JsonObject {
	retainedTarget(targetIdentity);
	requireValue(member === "snapshot" || member === "inspect", "Unsupported retained method");
	const params = object(json(value));
	requireValue(params.sessionId === undefined && params.conversationId === undefined, "Target belongs in the retained envelope");
	decodeInput(member, {...params, sessionId: targetIdentity}, {identity: targetIdentity});
	optional(params, ["limit"], v => integer(v, 1, 100));
	if (member === "inspect") retainedInspectParams(params);
	return params;
}
function retainedInspectParams(params: JsonObject): void {
	choice(params.view, ["history", "branch", "activity", "exact", "search", "result"]);
	if (params.cursor !== undefined) requireValue(Buffer.byteLength(JSON.stringify(params.cursor)) <= 4096, "Cursor exceeds its byte bound");
	optional(params, ["query"], v => string(v, 256));
	optional(params, ["requestId", "operationId"], v => {
		string(v, 1024); requireValue(!/[\x00-\x1f\x7f-\x9f]/.test(v), "Invalid retained selector");
	});
	if (params.view === "exact") integer(params.entryId, 1);
	if (params.view === "search") string(params.query, 256);
}
export function decodeRetainedResponse<M extends RetainedMethod>(member: M, value: unknown, id: string, targetIdentity: string, params: JsonObject = {}): {ok: true; result: Responses[M]} | RetainedFailure {
	const o = object(json(value));
	requireValue(o.version === "retained-read/1.0.0" && o.id === id, "Wrong retained response correlation");
	boolean(o.ok);
	if (!o.ok) {
		only(o, ["version", "id", "ok", "error"]);
		const error = object(o.error); only(error, ["code", "message", "retryable"]);
		string(error.code, 64); string(error.message, 2000); boolean(error.retryable);
		requireValue(Object.hasOwn(retainedErrors, error.code) && retainedErrors[error.code] === error.retryable, "Invalid retained failure policy");
		return {ok: false, error: error as RetainedFailure["error"]};
	}
	only(o, ["version", "id", "ok", "method", "sessionId", "storageId", "conversationId", "result"]);
	const parsed = retainedTarget(targetIdentity);
	requireValue(o.method === member && o.sessionId === targetIdentity && o.storageId === parsed.storageId && o.conversationId === parsed.conversationId, "Wrong retained response target");
	if (member === "inspect" && params.view !== undefined) requireValue(object(o.result).view === params.view, "Wrong retained inspection view");
	return {ok: true, result: decodeResponse(member, o.result, {identity: targetIdentity, ...(typeof params.requestId === "string" ? {requestId:params.requestId} : {})})};
}
function identity(value: unknown): { storageId: string; conversationId: number } {
	string(value, 512); requireValue(!/[\s\x00-\x1f\x7f]/.test(value), "Invalid identity");
	const parts = value.split(":"); requireValue(parts.length <= 2 && parts[0].length > 0, "Invalid identity");
	if (parts.length === 1) return { storageId: parts[0], conversationId: 1 };
	requireValue(/^[1-9]\d*$/.test(parts[1]), "Invalid conversation identity");
	const conversationId = Number(parts[1]); integer(conversationId, 2);
	return { storageId: parts[0], conversationId };
}
function target(o: JsonObject, field: string, context: Context): void {
	const parsed = identity(o[field]); integer(o.conversationId, 1);
	requireValue(parsed.conversationId === o.conversationId, "Conversation identity mismatch");
	if (context.identity !== undefined) requireValue(o[field] === context.identity, "Wrong target identity");
}
function model(value: JsonValue): void { fields(object(value), ["provider", "modelId"], v => string(v, 512)); }
function summary(value: JsonValue, maxText = 16 * 1024 * 1024): void {
	const o = object(value); const parsed = identity(o.id);
	requireValue(o.storageId === parsed.storageId, "Row storage mismatch"); string(o.cwd, 4096);
	fields(o, ["modifiedAt", "cost"], v => requireValue(typeof v === "number" && v >= 0, "Invalid summary number"));
	boolean(o.partial); choice(o.owner, ["here", "unavailable", "unknown"]);
	choice(o.state, ["starting", "working", "idle", "done", "failed", "stopped", "interrupted", "new", "unavailable"]);
	optional(o, ["creatingOwnerId", "name", "firstMessage", "ownerLabel", "latestReply", "error"], v => string(v, maxText, true));
	optional(o, ["toolCalls", "durationMs"], v => integer(v));
	if (o.model !== undefined) { model(o.model); string(object(o.model).thinkingLevel, 256); }
	if (o.currentTool !== undefined) fields(object(o.currentTool), ["name", "argument"], v => string(v, maxText, true));
	if (o.health !== undefined) health(o.health, maxText);
}
function health(value: JsonValue, maxText: number): void {
	const o = object(value); optional(o, ["lastError"], v => string(v, maxText, true));
	if (o.compactionFailure !== undefined) {
		const c = object(o.compactionFailure); fields(c, ["reason"], v => string(v, maxText, true));
		optional(c, ["at"], v => string(v, 64)); optional(c, ["errorMessage"], v => string(v, maxText, true));
	}
	if (o.autoRetry !== undefined) {
		const r = object(o.autoRetry); fields(r, ["attempt", "maxAttempts", "delayMs"], v => integer(v));
		string(r.errorMessage, maxText, true);
	}
}
export function decodePublication(value: unknown, storageId: string): Publication {
	requireValue(identity(storageId).storageId === storageId, "Expected a storage identity");
	const o = object(json(value)); timestamp(o.updatedAt);
	if (o.storageId !== undefined) requireValue(o.storageId === storageId, "Publication storage mismatch");
	array(o.rows, row => { summary(row, 2000); requireValue(object(row).storageId === storageId, "Publication row mismatch"); });
	const c = object(o.coverage); boolean(c.complete); integer(c.omitted);
	optional(o, ["unavailable"], v => string(v, 2000, true));
	requireValue(Buffer.byteLength(JSON.stringify(o)) <= 24 * 1024, "Publication exceeds 24 KiB"); return o as unknown as Publication;
}
function entry(value: JsonValue, live = false): void {
	const o = object(value); string(o.id, 512); string(o.kind, 256);
	if (live) requireValue(/^live:(generation|tool:.+)$/.test(o.id), "Invalid live entry ID");
	else { requireValue(/^[1-9]\d*$/.test(o.id), "Invalid committed entry ID"); integer(Number(o.id), 1); }
	requireValue(o.kind !== "system", "Hidden system entry"); optional(o, ["head"], v => string(v, 16 * 1024 * 1024, true));
	if (live && o.data !== undefined) {
		const data = object(o.data);
		if (data.nestedTool !== undefined) {
			nestedTool(data.nestedTool);
			requireValue(data.live === true && o.kind === "pi.tool-result" && o.id === `live:tool:${object(data.nestedTool).callId}`, "Invalid nested tool entry");
		}
	}
	if (o.model !== undefined) array(o.model, v => {
		const message = object(v); string(message.role, 128);
		if (message.role === "assistant" || message.role === "toolResult") optional(message, ["durationMs"], v => integer(v));
	});
}
function coverage(value: JsonValue): void {
	const o = object(value); fields(o, ["complete", "entryLimitReached", "byteLimitReached"], boolean);
	fields(o, ["entries", "bytes", "hiddenExcluded"], v => integer(v));
}
function transcript(o: JsonObject): void {
	array(o.entries, v => entry(v), 200); nullableId(o.nextBefore); coverage(o.coverage);
	const entries = o.entries as Entry[];
	for (let i = 1; i < entries.length; i++) requireValue(Number(entries[i - 1].id) < Number(entries[i].id), "Unordered entries");
}
function snapshot(value: JsonValue): Snapshot {
	const o = object(value); transcript(o); boolean(o.partial); string(o.revision, 512); return o as Snapshot;
}
function status(value: JsonValue, expected: string): void {
	const o = object(value); target(o, "identity", { identity: expected }); boolean(o.busy);
	if (o.lastText !== null) string(o.lastText, 16 * 1024 * 1024, true);
	requireValue("live" in o && "inbox" in o, "Missing native status");
	if (o.live !== null) liveState(o.live);
	const agent = object(o.agent); string(agent.thinkingLevel, 256, true);
	fields(agent, ["extensions", "tools"], v => array(v, x => string(x, 512)));
	optional(agent, ["model"], model); array(o.tasks, task); array(o.submissions, submission);
	optional(o, ["providerBlock"], providerBlock);
	if (o.retry !== undefined) { const retry = object(o.retry); integer(retry.attempt, 1); retryState(retry); }
}
function toolProgress(o: JsonObject): void {
	fields(o, ["callId", "name"], v => string(v, 512)); choice(o.status, ["pending", "running", "done"]);
	optional(o, ["taskId", "entry"], v => integer(v, 1)); optional(o, ["output"], v => string(v, 16 * 1024 * 1024, true));
	optional(o, ["droppedBytes", "droppedLines"], v => integer(v));
	if (o.diagnostics !== undefined) array(o.diagnostics, value => {
		const d = object(value); choice(d.severity, ["info", "warn", "error"]); string(d.message, 16 * 1024 * 1024, true);
		optional(d, ["code"], v => string(v, 512, true));
	});
}
function nestedTool(value: JsonValue): void {
	const o = object(value); toolProgress(o); integer(o.taskId, 1); integer(o.parentTaskId, 1);
	string(o.parentCallId, 512); object(o.arguments);
	if (o.summary !== undefined) {
		const s = object(o.summary); boolean(s.isError);
		optional(s, ["durationMs"], v => requireValue(typeof v === "number" && v >= 0, "Invalid tool duration"));
		optional(s, ["error"], v => string(v, 16 * 1024 * 1024, true));
	}
}
function compaction(value: JsonValue, failure = false): void {
	const o = object(value); integer(o.taskId, 1); choice(o.reason, ["manual", "threshold", "overflow"]);
	if (failure) { string(o.error, 16 * 1024 * 1024, true); return; }
	boolean(o.blocking); integer(o.attempt);
	if (o.retry !== undefined) {
		const r = object(o.retry); requireValue(typeof r.at === "number", "Invalid retry timestamp");
		string(r.error, 16 * 1024 * 1024, true);
	}
}
function retryState(value: JsonValue): void {
	const retry = object(value); integer(retry.at, 0, 8640000000000000); string(retry.error, 16 * 1024 * 1024, true);
}
function liveState(value: JsonValue): void {
	const o = object(value);
	if (o.generation !== undefined) {
		const generation = object(o.generation); integer(generation.attempt, 1);
		if (generation.retry !== undefined) retryState(generation.retry);
	}
	if (o.tools !== undefined) array(o.tools, v => toolProgress(object(v)));
	if (o.nestedTools !== undefined) array(o.nestedTools, nestedTool);
	if (o.compactions !== undefined) array(o.compactions, v => compaction(v));
	if (o.compactionFailure !== undefined) compaction(o.compactionFailure, true);
}
function task(value: JsonValue): void {
	const o = object(value); integer(o.id, 1); fields(o, ["kind", "status"], v => string(v, 128));
	fields(o, ["background", "abortRequested"], boolean); optional(o, ["owner"], v => integer(v, 1));
	optional(o, ["startedAt", "endedAt"], v => requireValue(typeof v === "number" && Number.isFinite(v), "Invalid task timestamp"));
}
function submission(value: JsonValue): void {
	const o = object(value); integer(o.id, 1); choice(o.type, ["input", "write"]); string(o.status, 128);
	optional(o, ["requestId", "reason"], v => string(v, 2000, true)); optional(o, ["entryId", "answerEntryId"], v => integer(v, 1));
}
export function decodeFrame(value: unknown, context: Context = {}): ConversationFrame | JsonObject {
	return frameValue(object(json(value)), context);
}
function frameValue(o: JsonObject, context: Context): ConversationFrame | JsonObject {
	requireValue(identity(o.storageId).storageId === o.storageId, "Expected a frame storage identity");
	integer(o.revision); timestamp(o.observedAt);
	if (o.scope === "tasks") return tasksFrame(o, context);
	requireValue(o.scope === "conversation", "Invalid frame scope"); integer(o.conversationId, 1);
	const expected = o.conversationId === 1 ? o.storageId : `${o.storageId}:${o.conversationId}`;
	identity(expected); if (context.identity !== undefined) requireValue(expected === context.identity, "Wrong frame target");
	transcript(o); array(o.live, v => entry(v, true)); status(o.status, expected); return o as ConversationFrame;
}
function tasksFrame(o: JsonObject, context: Context): JsonObject {
	requireValue(context.identity === undefined, "Tasks frame cannot replace a conversation frame");
	array(o.tasks, value => {
		task(value); const t = object(value); integer(t.conversationId, 1); string(t.phase, 128);
		array(t.waitsOn, v => integer(v, 1)); array(t.conversations, v => integer(v, 1));
	});
	array(o.labels, value => {
		const l = object(value); target(l, "identity", {});
		requireValue(identity(l.identity).storageId === o.storageId, "Task label storage mismatch");
		optional(l, ["name", "firstMessage"], v => string(v, 2000, true));
	});
	const c = object(o.coverage); boolean(c.complete); boolean(c.live); return o;
}
function compact(value: JsonValue, raw = false): void {
	const o = object(value); integer(o.id, 1); string(o.kind, 128);
	choice(o.source, ["user", "assistant", "toolResult", "summary", "custom"]);
	string(o.text, 16 * 1024 * 1024, true); boolean(o.truncated);
	if (!raw) requireValue(o.format === "compact" && o.nextOffset === null, "Invalid compact entry");
	else if (o.nextOffset !== null) integer(o.nextOffset);
	if (o.omissions !== undefined) fields(object(o.omissions), ["providerSignatures", "imagePayloads", "redactedThinking"], v => integer(v));
	if (o.toolResults !== undefined) array(o.toolResults, value => {
		const result = object(value); fields(result, ["name", "text"], v => string(v, 16 * 1024 * 1024, true));
		fields(result, ["isError", "truncated"], boolean); optional(result, ["callId"], v => string(v, 512));
		optional(result, ["durationMs"], v => integer(v));
	}, 8);
}
function inspect(value: JsonValue, context: Context): InspectResult {
	const o = object(value); target(o, "sessionId", context);
	choice(o.view, ["history", "branch", "activity", "exact", "search", "result"]);
	if (o.view === "exact") inspectExact(o);
	else if (o.view === "result") inspectResult(o, context);
	else inspectPage(o);
	return o as InspectResult;
}
function inspectExact(o: JsonObject): void {
	integer(o.entryId, 1); integer(o.offset); string(o.text, 16 * 1024 * 1024, true); boolean(o.truncated);
	if (o.nextOffset !== null) { integer(o.nextOffset); requireValue(o.nextOffset > o.offset, "Invalid exact continuation"); }
}
function inspectResult(o: JsonObject, context: Context): void {
	optional(o, ["providerBlock"], providerBlock);
	optional(o, ["recoveryOf"], v => string(v, 16 * 1024 * 1024, true));
	if (o.status === "unavailable") {
		only(o, ["view", "sessionId", "conversationId", "status", "requestId", "submissionId", "operationId", "reason", "usage"]);
		optional(o, ["submissionId"], v => integer(v, 1)); string(o.reason, 2000, true);
	} else {
		integer(o.submissionId, 1); choice(o.status, ["queued", "placed", "done", "unanswered"]);
	}
	optional(o, ["requestId", "operationId", "reason"], v => string(v, 2000, true));
	optional(o, ["entryId", "answerEntryId"], v => integer(v, 1));
	optional(o, ["answer"], v => string(v, 16 * 1024 * 1024, true));
	if (context.requestId !== undefined) requireValue(o.requestId === context.requestId, "Wrong result request ID");
	const usage = object(o.usage); fields(usage, ["models", "tools"], object);
}
function resultReference(value: JsonValue): void {
	const o = object(value); only(o, ["sessionId", "submissionId", "requestId"]);
	string(o.sessionId, 256); requireValue(!/[\s@]/.test(o.sessionId), "Invalid result identity");
	integer(o.submissionId, 1); optional(o, ["requestId"], v => string(v, 1024));
}
function providerBlock(value: JsonValue): void {
	const o = object(value); only(o, ["blockId", "conversationId", "providerSessionId", "epoch", "model", "error",
		"errorRedacted", "errorTruncated", "source", "timestamp", "originalResults", "omittedOriginalResults"]);
	string(o.blockId, 128); integer(o.conversationId, 1); string(o.providerSessionId, 256);
	fields(o, ["epoch", "timestamp", "omittedOriginalResults"], v => integer(v));
	const selected = object(o.model); only(selected, ["provider", "modelId"]);
	fields(selected, ["provider", "modelId"], v => string(v, 256, true)); string(o.error, 4096, true);
	fields(o, ["errorRedacted", "errorTruncated"], boolean); choice(o.source, ["provider", "host-block"]);
	array(o.originalResults, resultReference, 16);
}
function inspectPage(o: JsonObject): void {
	if (o.nextCursor !== null) object(o.nextCursor); string(o.detail, 2000, true);
	if (o.view === "activity") {
		requireValue(o.format === "compact", "Invalid activity format");
		array(o.turns, v => array(object(v).entries, x => compact(x))); activityMetadata(o.metadata);
		const c = object(o.coverage); scanCoverage(c);
		fields(c, ["entryLimitReached", "scanByteLimitReached", "byteLimitReached", "metadataTruncated"], boolean);
		fields(c, ["bytes", "omittedEntries"], v => integer(v));
	} else if (o.view === "search") {
		array(o.matches, v => { const m = object(v); integer(m.entryId, 1); integer(m.matchOffset);
			fields(m, ["kind", "source", "excerpt", "excerptText"], x => string(x, 16 * 1024 * 1024, true)); boolean(m.truncated); });
		scanCoverage(object(o.coverage));
	} else {
		requireValue(o.order === "newestFirst", "Invalid history order");
		if (o.view === "history") requireValue(o.format === "compact", "Invalid history format");
		array(o.entries, v => compact(v, o.view === "branch"));
	}
}
function scanCoverage(o: JsonObject): void { fields(o, ["scannedEntries", "scannedBytes"], v => integer(v)); boolean(o.complete); }
function activityMetadata(value: JsonValue): void {
	const o = object(value); choice(o.owner, ["here", "unavailable", "unknown"]); boolean(o.live);
	fields(o, ["operation", "pending"], v => { if (v !== null) integer(v); });
	array(o.runningTools, value => {
		const t = object(value); fields(t, ["toolCallId", "name"], v => string(v, 512));
		optional(t, ["taskId", "parentTaskId"], v => integer(v, 1)); optional(t, ["parentToolCallId"], v => string(v, 512));
		optional(t, ["issuedAt"], v => string(v, 64)); optional(t, ["elapsedMs"], v => integer(v));
		optional(t, ["elapsedFrom"], v => choice(v, ["tool-call-entry"]));
	});
	health(o, 16 * 1024 * 1024);
	optional(o, ["streamedText", "lastError"], v => string(v, 16 * 1024 * 1024, true));
}
function changes(value: JsonValue): JsonObject {
	const o = object(value); only(o, ["revision"]); integer(o.revision); return o;
}
function admission(value: JsonValue, context: Context): Admission {
	const o = object(value); target(o, "identity", context); integer(o.submissionId, 1); boolean(o.deduped);
	const result = object(o.result); requireValue(result.sessionId === o.identity && result.submissionId === o.submissionId,
		"Admission reference mismatch"); optional(result, ["requestId"], v => string(v, 512));
	if (context.requestId !== undefined) requireValue(result.requestId === context.requestId, "Wrong admission request ID");
	return o as Admission;
}
function abort(value: JsonValue, context: Context): AbortReceipt {
	const o = object(value); target(o, "identity", context); boolean(o.background); return o as AbortReceipt;
}
/** The commands the host runs for itself rather than through a contribution. The UI never offers or sends them. */
export const RESERVED_COMMANDS: readonly string[] = Object.freeze(["tree", "reload"]);
function hostInventory(value: JsonValue): void {
	const o = object(value); only(o, ["contributions", "ordinaryOnly", "failed"]);
	array(o.contributions, c => {
		const contribution = object(c); only(contribution, ["name", "source", "commands"]);
		fields(contribution, ["name", "source"], v => string(v, 4096, true));
		array(contribution.commands, x => { const command = object(x); only(command, ["name", "description"]);
			string(command.name, 512); string(command.description, 65536, true); }, 4096);
	}, 1024);
	array(o.ordinaryOnly, v => string(v, 4096, true), 1024);
	optional(o, ["failed"], v => array(v, f => { const failure = object(f); only(failure, ["path", "error"]);
		fields(failure, ["path", "error"], x => string(x, 65536, true)); }, 1024));
}
function statusReply(value: JsonValue): StatusReply {
	const o = object(value); string(o.storageId, 512);
	requireValue(o.conversation !== undefined || o.conversations !== undefined, "Status reply names no conversation");
	if (o.inventory !== undefined) hostInventory(o.inventory);
	return o as StatusReply;
}
function commandResult(value: JsonValue, context: Context): CommandResult {
	const o = object(value); only(o, ["name", "conversationId", "identity", "text"]);
	string(o.name, 512); string(o.text, 16 * 1024 * 1024, true); target(o, "identity", context);
	return o as CommandResult;
}
const threadIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[0-9a-f]{32}$/;
const participantPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?::[1-9]\d*)?$/;
function threadId(value: unknown): asserts value is string {
	string(value, 128); requireValue(threadIdPattern.test(value), "Invalid thread identity");
}
function participant(value: unknown): asserts value is string {
	string(value, 512); requireValue(participantPattern.test(value), "Invalid thread participant identity");
}
function listCursor(value: unknown): asserts value is string {
	string(value, 16); requireValue(/^(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)), "Invalid thread list cursor");
}
function threadSummary(value: JsonValue): void {
	const o = object(value); only(o, ["id", "title", "purpose", "updatedAt", "closed", "members"]);
	threadId(o.id); string(o.title, 160); string(o.purpose, 160); integer(o.updatedAt); boolean(o.closed); integer(o.members, 0, 64);
}
function threadList(value: JsonValue): ThreadList {
	const o = object(value); only(o, ["items", "nextCursor", "coverage"]);
	array(o.items, threadSummary, 20); if (o.nextCursor !== null) listCursor(o.nextCursor);
	const c = object(o.coverage); only(c, ["complete", "visited", "omitted", "unavailable"]);
	boolean(c.complete); integer(c.visited, 0, 64); integer(c.omitted); optional(c, ["unavailable"], v => integer(v));
	requireValue(c.complete === (o.nextCursor === null), "Thread list continuation disagrees with its coverage");
	return o as ThreadList;
}
function threadFrame(o: JsonObject): void {
	fields(o, ["title"], v => string(v, 160)); fields(o, ["purpose", "authority", "restrictions", "acceptance"], v => string(v, 4000));
	string(o.source, 2000); participant(o.integrator);
}
function threadMember(value: JsonValue): void {
	const o = object(value); only(o, ["identity", "contribution", "joinedAt"]);
	participant(o.identity); string(o.contribution, 256, true); integer(o.joinedAt);
}
function threadRecord(value: JsonValue): ThreadRecord {
	const o = object(value);
	only(o, ["title", "purpose", "authority", "source", "restrictions", "acceptance", "integrator", "id", "creator", "createdAt", "updatedAt", "revision", "closed", "sequence", "members"]);
	threadFrame(o); threadId(o.id); participant(o.creator); fields(o, ["createdAt", "updatedAt", "sequence"], v => integer(v));
	integer(o.revision, 1); boolean(o.closed); array(o.members, threadMember, 64);
	requireValue((o.updatedAt as number) >= (o.createdAt as number), "Thread updates precede its creation");
	return o as ThreadRecord;
}
function threadEvent(value: JsonValue): void {
	const o = object(value);
	only(o, ["threadId", "sequence", "at", "sender", "origin", "kind", "message", "source", "replyTo", "revision", "notify"]);
	threadId(o.threadId); integer(o.sequence, 1); integer(o.at); participant(o.sender); choice(o.origin, ["model", "operator"]);
	string(o.kind, 32); string(o.message, 24 * 1024); string(o.source, 2000, true); integer(o.revision, 1);
	if (o.replyTo !== null) { integer(o.replyTo, 1); requireValue(o.replyTo < (o.sequence as number), "Reply names a later event"); }
	array(o.notify, participant, 16);
}
function threadPage(value: JsonValue): ThreadPage {
	const o = object(value); only(o, ["thread", "events", "nextBefore", "pending", "coverage"]);
	const thread = threadRecord(o.thread); array(o.events, threadEvent, 20);
	const events = o.events as unknown as ThreadEvent[];
	for (let i = 0; i < events.length; i++) {
		requireValue(events[i].threadId === thread.id, "Event belongs to another thread");
		requireValue(events[i].sequence <= thread.sequence && events[i].revision <= thread.revision, "Event is newer than its thread");
		if (i > 0) requireValue(events[i].sequence === events[i - 1].sequence + 1, "Thread events are not consecutive");
	}
	nullableId(o.nextBefore); integer(o.pending);
	const c = object(o.coverage); only(c, ["complete", "bytes"]); boolean(c.complete); integer(c.bytes, 0, 48 * 1024);
	requireValue(c.complete === (o.nextBefore === null), "Thread continuation disagrees with its coverage");
	if (o.nextBefore !== null) requireValue(events.length > 0 && o.nextBefore === events[0].sequence, "Thread continuation does not name the oldest event");
	else requireValue(events.length === 0 || events[0].sequence === 1, "Complete thread page omits its first event");
	return o as ThreadPage;
}
export function decodeResponse<M extends OperationName>(member: M, value: unknown, context: Context = {}): Responses[M] {
	if (member === "configure") unavailable("Configure is unavailable: execution selection is not decoded");
	const v = json(value);
	const decoders = {
		dashboard: () => { array(v, summary); return v as unknown as Summary[]; }, snapshot: () => snapshot(v),
		inspect: () => inspect(v, context), "observe-frame": () => frameValue(object(v), context),
		"observe-open": () => { const o = object(v); token(o.token);
			if (context.token !== undefined) requireValue(o.token === context.token, "Wrong observation token");
			o.frame = frameValue(object(o.frame), context); return o; },
		"observe-close": () => { const o = object(v); boolean(o.closed); return o; },
		changes: () => changes(v), "task-submit": () => admission(v, context), abort: () => abort(v, context),
		"collaboration-list": () => threadList(v), "collaboration-read": () => threadPage(v),
		status: () => statusReply(v), command: () => commandResult(v, context),
	};
	const decoder = decoders[member as Exclude<OperationName, "configure">];
	requireValue(Object.hasOwn(decoders, member) && decoder, "Unsupported operation"); return decoder() as Responses[M];
}
function token(value: unknown): void { string(value, 128); requireValue(/^[A-Za-z0-9._:-]+$/.test(value), "Invalid observation token"); }
function inputObject(value: unknown): JsonObject {
	const result = object(value);
	requireValue(Object.getPrototypeOf(result) === Object.prototype || Object.getPrototypeOf(result) === null, "Invalid input object");
	requireValue(Object.getOwnPropertySymbols(result).length === 0, "Invalid input symbol");
	for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(result)))
		requireValue("value" in descriptor && descriptor.enumerable && descriptor.value !== undefined, "Invalid input property");
	return result;
}
function imagePart(value: JsonValue): {part: NativeInputPart; bytes: number; encoded: number} {
	const part = inputObject(value); only(part, ["type", "data", "mimeType"]);
	requireValue(part.type === "image" && (part.mimeType === "image/png" || part.mimeType === "image/jpeg"), "Invalid input image type");
	const data = part.data;
	requireValue(typeof data === "string" && data.length > 0 && data.length <= LIMITS.imageBase64Bytes && data.length % 4 === 0, "Invalid input image size");
	requireValue(/^[A-Za-z0-9+/]*={0,2}$/.test(data), "Invalid input image base64");
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	if (padding === 2) requireValue(/[AQgw]/.test(data[data.length - 3]), "Noncanonical image base64");
	if (padding === 1) requireValue(/[AEIMQUYcgkosw048]/.test(data[data.length - 2]), "Noncanonical image base64");
	const bytes = data.length / 4 * 3 - padding;
	requireValue(bytes > 0 && bytes <= LIMITS.imageBytes, "Input image exceeds its byte bound");
	return {part: {type: "image", data, mimeType: part.mimeType}, bytes, encoded: data.length};
}
export function decodeNativeMessage(value: JsonValue): NativeInputMessage {
	if (typeof value === "string") {
		requireValue(value.length > 0 && Buffer.byteLength(value) <= LIMITS.inputFrameBytes, "Invalid input text");
		return value;
	}
	requireValue(Array.isArray(value) && value.length > 0 && value.length <= LIMITS.imagesPerDraft + 1, "Invalid input parts");
	requireValue(Object.getPrototypeOf(value) === Array.prototype && Reflect.ownKeys(value).length === value.length + 1, "Invalid input array");
	for (let i = 0; i < value.length; i++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, i);
		requireValue(descriptor && "value" in descriptor && descriptor.enumerable, "Invalid input array item");
	}
	const parts: NativeInputPart[] = []; let start = 0, bytes = 0, encoded = 0;
	const first = inputObject(value[0]);
	if (first.type === "text") {
		only(first, ["type", "text"]); string(first.text, LIMITS.textBytes);
		requireValue(Buffer.byteLength(first.text) <= LIMITS.textBytes, "Input text exceeds its byte bound");
		parts.push({type: "text", text: first.text}); start = 1;
	}
	requireValue(value.length - start >= 1 && value.length - start <= LIMITS.imagesPerDraft, "Invalid input image count");
	for (let i = start; i < value.length; i++) {
		const image = imagePart(value[i]); bytes += image.bytes; encoded += image.encoded;
		requireValue(bytes <= LIMITS.draftImageBytes && encoded <= LIMITS.imageBase64Bytes, "Input images exceed their aggregate bound");
		parts.push(image.part);
	}
	return parts;
}
export function decodeOperatorInput(value: unknown): JsonObject {
	const o = inputObject(value); only(o, ["sessionId", "message", "origin", "requester", "replyTo", "requestId",
		"whenBusy", "operationId", "checkInMinutes"]);
	identity(o.sessionId); decodeNativeMessage(o.message); requireValue(o.origin === "operator", "Operator origin required");
	fields(o, ["requester", "replyTo", "requestId"], v => string(v, 512));
	requireValue(o.replyTo === o.sessionId, "Operator input requires a self-owned reply route");
	if (o.whenBusy !== undefined) choice(o.whenBusy, ["steer", "followUp", "reject"]);
	optional(o, ["operationId"], v => string(v, 512));
	if (o.checkInMinutes !== undefined) requireValue(typeof o.checkInMinutes === "number" && o.checkInMinutes >= 0
		&& o.checkInMinutes <= 35791, "Invalid check-in interval");
	requireValue(Buffer.byteLength(JSON.stringify(o)) + 4 <= LIMITS.inputFrameBytes, "Input envelope exceeds its byte bound");
	return o;
}
export function decodeInput(member: OperationName, value: unknown, context: Context = {}): JsonObject {
	if (member === "configure") unavailable("Configure is unavailable: execution selection is not decoded");
	const o = member === "task-submit" ? decodeOperatorInput(value) : object(json(value));
	if (context.identity !== undefined && o.sessionId !== undefined) requireValue(o.sessionId === context.identity, "Wrong input target");
	if (context.requestId !== undefined) requireValue(o.requestId === context.requestId, "Wrong input request ID");
	if (context.token !== undefined) requireValue(o.token === context.token, "Wrong input observation token");
	if (member === "task-submit") return o;
	if (member === "observe-open") { observeInput(o); return o; }
	if (member === "observe-frame" || member === "observe-close") { only(o, ["token"]); token(o.token); return o; }

	if (member === "dashboard") { only(o, ["conversationId", "cwd"]); optional(o, ["conversationId"], v => integer(v, 1));
		optional(o, ["cwd"], v => string(v, 4096)); return o; }
	if (member === "snapshot") { only(o, ["sessionId", "before", "limit", "maxBytes"]); identity(o.sessionId);
		optional(o, ["before"], v => integer(v, 1)); optional(o, ["limit"], v => integer(v, 1, 200));
		optional(o, ["maxBytes"], v => integer(v, 1, 1048576)); return o; }
	if (member === "inspect") { inspectInput(o); return o; }
	const simpleInput = simpleInputs[member];
	if (simpleInput) { simpleInput(o); return o; }
	unavailable("Changes is a subscription gate, not a request operation");
}
function commandInput(o: JsonObject): void {
	only(o, ["sessionId", "name", "args", "invocationId"]); identity(o.sessionId);
	string(o.name, 128); requireValue(/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(o.name as string), "Invalid command name");
	requireValue(!RESERVED_COMMANDS.includes(o.name as string), "Reserved host command");
	optional(o, ["args"], v => { string(v, LIMITS.textBytes, true); requireValue(Buffer.byteLength(v as string) <= LIMITS.textBytes, "Command arguments exceed their byte bound"); });
	string(o.invocationId, 125); requireValue(/^[a-zA-Z0-9._:-]+$/.test(o.invocationId as string), "Invalid invocation identity");
}
function threadListInput(o: JsonObject): void {
	only(o, ["cursor", "limit", "query"]); optional(o, ["cursor"], listCursor); optional(o, ["limit"], v => integer(v, 1, 20));
	optional(o, ["query"], v => { string(v, 256); requireValue(v.trim().length > 0, "Blank thread query"); });
}
function threadReadInput(o: JsonObject): void {
	only(o, ["threadId", "limit", "before"]); threadId(o.threadId);
	optional(o, ["limit"], v => integer(v, 1, 20)); optional(o, ["before"], v => integer(v, 1));
}
const simpleInputs: Partial<Record<OperationName, (o: JsonObject) => void>> = {
	abort: o => { only(o, ["sessionId", "background"]); identity(o.sessionId); optional(o, ["background"], boolean); },
	status: o => { only(o, ["sessionId"]); identity(o.sessionId); },
	command: commandInput, "collaboration-list": threadListInput, "collaboration-read": threadReadInput,
};
function observeInput(o: JsonObject): void {
	only(o, ["token", "scope", "sessionId"]); token(o.token); choice(o.scope, ["conversation", "tasks"]);
	if (o.scope === "conversation") identity(o.sessionId);
	else requireValue(o.sessionId === undefined, "Task observation has no conversation target");
}
function inspectInput(o: JsonObject): void {
	only(o, ["sessionId", "view", "limit", "cursor", "entryId", "fromId", "offset", "query", "source", "submissionId", "requestId", "operationId"]);
	identity(o.sessionId); optional(o, ["entryId", "fromId", "submissionId"], v => integer(v, 1));
	optional(o, ["limit"], v => integer(v, 1)); optional(o, ["offset"], v => integer(v)); optional(o, ["cursor"], object);
	optional(o, ["query", "operationId"], v => string(v, 2000));
	optional(o, ["requestId"], v => string(v, 1024));
	requireValue(o.requestId === undefined || o.view === "result", "Request IDs select only result inspection");
	if (o.view === "result") requireValue(o.submissionId !== undefined || o.requestId !== undefined || o.operationId !== undefined, "Result inspection requires a selector");
	if (o.view !== undefined) choice(o.view, ["activity", "history", "branch", "search", "exact", "result"]);
	if (o.source !== undefined) choice(o.source, ["user", "assistant", "toolResult", "summary", "custom"]);
}
