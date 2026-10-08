import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type OperationContract = Readonly<{ request: string; response: string; durable?: string }>;
export type OperationName = "dashboard" | "snapshot" | "inspect" | "observe-open" | "observe-frame"
	| "observe-close" | "changes" | "task-submit" | "abort" | "configure";
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
type Context = { identity?: string; requestId?: string; token?: string };
type Responses = {
	dashboard: Summary[]; snapshot: Snapshot; inspect: InspectResult;
	"observe-open": JsonObject & { token: string; frame: ConversationFrame | JsonObject };
	"observe-frame": ConversationFrame | JsonObject; "observe-close": JsonObject & { closed: boolean };
	changes: JsonObject; "task-submit": Admission; abort: AbortReceipt; configure: never;
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
const opaque = new Set<OperationName>(["snapshot", "inspect", "observe-open", "observe-frame"]);
function contract(member: string, version = "1.0.0", response = `${member}/${version}`, native = false): OperationContract {
	return Object.freeze({ request: `${member}/${version}`, response, ...(native && durable ? { durable } : {}) });
}
export const supportedOperations: Readonly<Record<OperationName, OperationContract>> = Object.freeze({
	dashboard: contract("dashboard", "1.0.0", "46dd1bdd919bd3093ad6a3c0a316b35fa05d491490a37c9879ef9a9cffc4f241"),
	snapshot: contract("snapshot", "1.0.0", undefined, true),
	inspect: contract("inspect", "1.0.0", "98cbec841b6626155420cf582d77e318ea0c8e7607f113dffe04d94bf1b99736", true),
	"observe-open": contract("observe-open", "1.0.0", undefined, true),
	"observe-frame": contract("observe-frame", "1.0.0", undefined, true),
	"observe-close": contract("observe-close"), changes: contract("changes"),
	"task-submit": contract("task-submit", "1.0.0", "task-submit/1.1.0"), abort: contract("abort"),
	configure: contract("configure", "1.2.0"),
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
export function assertOperation(descriptor: RuntimeDescriptor, member: OperationName): OperationContract {
	if (member === "configure") unavailable("Configure is unavailable: execution selection is not decoded");
	if (opaque.has(member) && !durable) unavailable("Durable package metadata is unavailable");
	const local = Object.hasOwn(supportedOperations, member) ? supportedOperations[member] : undefined;
	const remote = Object.hasOwn(descriptor.operations, member) ? descriptor.operations[member] : undefined;
	if (!local || !remote || local.request !== remote.request || local.response !== remote.response || local.durable !== remote.durable)
		throw new ContractError(`Incompatible operation: ${member}`, "incompatible");
	return local;
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
		string(c.at, 64); optional(c, ["errorMessage"], v => string(v, maxText, true));
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
	if (o.model !== undefined) array(o.model, v => string(object(v).role, 128));
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
	const agent = object(o.agent); string(agent.thinkingLevel, 256, true);
	fields(agent, ["extensions", "tools"], v => array(v, x => string(x, 512)));
	optional(agent, ["model"], model); array(o.tasks, task); array(o.submissions, submission);
}
function task(value: JsonValue): void {
	const o = object(value); integer(o.id, 1); fields(o, ["kind", "status"], v => string(v, 128));
	fields(o, ["background", "abortRequested"], boolean); optional(o, ["owner"], v => integer(v, 1));
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
	integer(o.submissionId, 1); choice(o.status, ["queued", "placed", "done", "unanswered"]);
	optional(o, ["requestId", "operationId", "reason"], v => string(v, 2000, true));
	optional(o, ["entryId", "answerEntryId"], v => integer(v, 1));
	optional(o, ["answer"], v => string(v, 16 * 1024 * 1024, true));
	if (context.requestId !== undefined) requireValue(o.requestId === context.requestId, "Wrong result request ID");
	const usage = object(o.usage); fields(usage, ["models", "tools"], object);
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
	array(o.runningTools, value => { const t = object(value); fields(t, ["toolCallId", "name"], v => string(v, 512)); });
	optional(o, ["streamedText", "lastError"], v => string(v, 16 * 1024 * 1024, true));
}
function changes(value: JsonValue): JsonObject {
	const o = object(value); requireValue(o.type === "state" && o.member === "change", "Invalid change state"); integer(o.sequence);
	requireValue(Array.isArray(o.ops) && o.ops.length === 1, "Invalid change operations");
	const op = o.ops[0]; requireValue(Array.isArray(op) && op.length === 2 && op[0] === "r", "Expected root replacement");
	const state = object(op[1]); only(state, ["revision"]); integer(state.revision);
	requireValue(state.revision === o.sequence, "Change sequence mismatch"); return o;
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
	};
	const decoder = decoders[member as Exclude<OperationName, "configure">];
	requireValue(Object.hasOwn(decoders, member) && decoder, "Unsupported operation"); return decoder() as Responses[M];
}
function token(value: unknown): void { string(value, 128); requireValue(/^[A-Za-z0-9._:-]+$/.test(value), "Invalid observation token"); }
export function decodeOperatorInput(value: unknown): JsonObject {
	const o = object(json(value)); only(o, ["sessionId", "message", "origin", "requester", "replyTo", "requestId",
		"whenBusy", "operationId", "checkInMinutes"]);
	identity(o.sessionId); string(o.message, 1024 * 1024); requireValue(o.origin === "operator", "Operator origin required");
	fields(o, ["requester", "replyTo", "requestId"], v => string(v, 512));
	requireValue(o.replyTo === o.sessionId, "Operator input requires a self-owned reply route");
	if (o.whenBusy !== undefined) choice(o.whenBusy, ["steer", "followUp", "reject"]);
	optional(o, ["operationId"], v => string(v, 512));
	if (o.checkInMinutes !== undefined) requireValue(typeof o.checkInMinutes === "number" && o.checkInMinutes >= 0
		&& o.checkInMinutes <= 35791, "Invalid check-in interval");
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
	if (member === "abort") { only(o, ["sessionId", "background"]); identity(o.sessionId); optional(o, ["background"], boolean); return o; }
	if (member === "dashboard") { only(o, ["conversationId", "cwd"]); optional(o, ["conversationId"], v => integer(v, 1));
		optional(o, ["cwd"], v => string(v, 4096)); return o; }
	if (member === "snapshot") { only(o, ["sessionId", "before", "limit", "maxBytes"]); identity(o.sessionId);
		optional(o, ["before"], v => integer(v, 1)); optional(o, ["limit"], v => integer(v, 1, 200));
		optional(o, ["maxBytes"], v => integer(v, 1, 1048576)); return o; }
	if (member === "inspect") { inspectInput(o); return o; }
	unavailable("Changes is a subscription gate, not a request operation");
}
function observeInput(o: JsonObject): void {
	only(o, ["token", "scope", "sessionId"]); token(o.token); choice(o.scope, ["conversation", "tasks"]);
	if (o.scope === "conversation") identity(o.sessionId);
	else requireValue(o.sessionId === undefined, "Task observation has no conversation target");
}
function inspectInput(o: JsonObject): void {
	only(o, ["sessionId", "view", "limit", "cursor", "entryId", "fromId", "offset", "query", "source", "submissionId", "operationId"]);
	identity(o.sessionId); optional(o, ["entryId", "fromId", "submissionId"], v => integer(v, 1));
	optional(o, ["limit"], v => integer(v, 1)); optional(o, ["offset"], v => integer(v)); optional(o, ["cursor"], object);
	optional(o, ["query", "operationId"], v => string(v, 2000));
	if (o.view !== undefined) choice(o.view, ["activity", "history", "branch", "search", "exact", "result"]);
	if (o.source !== undefined) choice(o.source, ["user", "assistant", "toolResult", "summary", "custom"]);
}
