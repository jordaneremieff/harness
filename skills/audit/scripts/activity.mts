import type { Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, opendir, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const fields = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const;
export const defaults = { visits: 65536, files: 16384, bytes: 268435456, records: 500000, recordBytes: 2097152, seconds: 60, groups: 20, refs: 3 };
export type Limits = typeof defaults;
export type StoreKind = "primary" | "durable" | "native";
const storeKinds: StoreKind[] = ["primary", "durable", "native"];
export type Filters = { stores: StoreKind[]; sources: string[]; tools: string[]; models: string[] };
export type Options = { agentDir: string; agentSessionsDir: string; from: number; to: number; limits: Limits; filters?: Filters; resume?: string };

type Tokens = Record<typeof fields[number], number>;
function blankTokens(): Tokens { return Object.fromEntries(fields.map(key => [key, 0])) as Tokens; }
export function usageSum() { return { records: 0, missing: 0, tokens: blankTokens(), missingTokenFields: blankTokens(), costRecords: 0, missingCost: 0, cost: 0 }; }
export type UsageSum = ReturnType<typeof usageSum>;
/** Adds one usage carrier; an empty or absent object is unknown usage, never zero. */
export function addUsage(sum: UsageSum, value: unknown) {
	const usage = object(value);
	if (Object.keys(usage).length === 0) { sum.missing++; return; }
	sum.records++;
	for (const key of fields) { if (finite(usage[key])) sum.tokens[key] += usage[key]; else sum.missingTokenFields[key]++; }
	const cost = object(usage.cost).total;
	if (finite(cost)) { sum.costRecords++; sum.cost += cost; } else sum.missingCost++;
}
/** Rounds the reported cost so that summation order across resumed runs cannot change printed figures. */
const rounded = (sum: UsageSum): UsageSum => ({ ...sum, cost: Math.round(sum.cost * 1e9) / 1e9 });
function mergeUsage(into: UsageSum, from: UsageSum) {
	for (const key of ["records", "missing", "costRecords", "missingCost", "cost"] as const) into[key] += from[key];
	for (const [target, source] of [[into.tokens, from.tokens], [into.missingTokenFields, from.missingTokenFields]]) {
		for (const key of fields) target[key] += source[key];
	}
}
export function units() {
	return { topLevelToolCalls: 0, responseToolCalls: 0, toolResults: 0, errorToolResults: 0, nestedCodemodeCalls: 0, nestedErrorCalls: 0,
		nestedToolTasks: 0, generationStarts: 0, compactionStarts: 0, modelResponses: 0, errorResponses: 0, abortedResponses: 0,
		codemodeResultsWithoutCalls: 0, malformedNestedCalls: 0, duplicateNestedCalls: 0 };
}
type Units = ReturnType<typeof units>;
function coverage() {
	return { storesVisited: 0, directoriesVisited: 0, directoryEntriesVisited: 0, filesVisited: 0, filesBeforeWindow: 0,
		filesRead: 0, filesSkipped: 0, filesUnreadable: 0, directoriesUnreadable: 0, directoriesSkipped: 0, entriesIgnored: 0,
		catalogRead: 0, catalogUnavailable: 0, bytesRead: 0, recordsRead: 0, rowsScanned: 0, malformedRecords: 0, unsupportedRecords: 0,
		missingTimestamps: 0, outsideWindow: 0, olderRecordStops: 0, outOfOrderRecords: 0, changedFiles: 0, trailingFragments: 0,
		ledgerDocuments: 0, ledgerUnsupported: 0, runs: 0, capsReached: [] as string[], discoveryComplete: true };
}
type Coverage = ReturnType<typeof coverage>;

/** Store index, source index, `byte, entryId` for JSONL or `conversationId, entryId` for Durable, then record time. */
type Ref = [number, number, number, number | string | null, number];
type ToolRow = { calls: number; results: number; errorResults: number; nestedCalls: number; nestedErrors: number; callRefs: Ref[]; errorRefs: Ref[] };
type ModelRow = { responses: number; errorResponses: number; abortedResponses: number; usage: UsageSum; refs: Ref[]; errorRefs: Ref[] };
type Repeat = { tool: string; times: number[]; errorTimes: number[]; refs: Ref[] };
/** Per session: call key to `[fingerprint, tool, time, ref]`, and call key to error flag of its result. */
type Pairing = { calls: Map<string, [string, string, number, Ref]>; results: Map<string, boolean> };
type JsonlCursor = { snapshotSize: number; end: number; atEnd: boolean; skipping: boolean; lastTime: number | null };
type SqliteCursor = { maxTasks: number; maxEntries: number; phase: "tasks" | "entries" | "ledger"; below: number | null };
type Source = { path: string; ino: number; stamp: string; mtimeMs: number; status: "pending" | "partial" | "done" | "unreadable" | "changed";
	inWindow: number; cursor?: JsonlCursor | SqliteCursor; pairing?: Pairing; changeNoted?: boolean };
type StoreState = { kind: StoreKind; roots: string[]; units: Units; coverage: Coverage; sources: Source[] };
type State = { version: 1; from: number; to: number; filters: Filters; refs: number; stores: StoreState[];
	tools: Map<string, ToolRow>; models: Map<string, ModelRow>; usage: Map<string, UsageSum>; withoutUsage: Map<string, number>;
	ledger: { models: Map<string, UsageSum>; tools: Map<string, UsageSum>; storages: number };
	repetition: { keys: Map<string, Repeat>; fingerprints: number; callsWithoutResult: number; resultsWithoutCall: number };
	changes: Array<{ path: string; change: string }> };
type Ctx = { state: State; store: StoreState; storeIndex: number; sourceIndex: number; source: Source; limits: Limits; deadline: number; run: { records: number; bytes: number } };

function cap(c: Coverage, name: string) { if (!c.capsReached.includes(name)) c.capsReached.push(name); }
function stamp(value: unknown): number { return typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN; }
function place(value: unknown, state: State): "in" | "newer" | "older" | "missing" {
	const time = stamp(value);
	if (!Number.isFinite(time)) return "missing";
	return time < state.from ? "older" : time >= state.to ? "newer" : "in";
}
function exhausted(x: Ctx) {
	const c = x.store.coverage;
	if (Date.now() >= x.deadline) cap(c, "seconds");
	if (x.run.bytes >= x.limits.bytes) cap(c, "bytes");
	if (x.run.records >= x.limits.records) cap(c, "records");
	return c.capsReached.some(key => ["seconds", "bytes", "records"].includes(key));
}
const selected = (list: string[], value: string) => list.length === 0 || list.includes(value);
function compareRefs(a: Ref, b: Ref) {
	return b[4] - a[4] || a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || String(a[3]).localeCompare(String(b[3]));
}
/** Keeps the newest `n` distinct references, so the kept set does not depend on reading order. */
function pushRef(list: Ref[], ref: Ref, n: number) {
	if (list.some(item => compareRefs(item, ref) === 0)) return;
	list.push(ref); list.sort(compareRefs);
	if (list.length > n) list.length = n;
}
function toolRow(x: Ctx, name: string) {
	let row = x.state.tools.get(name);
	if (!row) { row = { calls: 0, results: 0, errorResults: 0, nestedCalls: 0, nestedErrors: 0, callRefs: [], errorRefs: [] }; x.state.tools.set(name, row); }
	return row;
}
function modelRow(x: Ctx, name: string) {
	let row = x.state.models.get(name);
	if (!row) { row = { responses: 0, errorResponses: 0, abortedResponses: 0, usage: usageSum(), refs: [], errorRefs: [] }; x.state.models.set(name, row); }
	return row;
}
function category(x: Ctx, name: string) {
	let sum = x.state.usage.get(name);
	if (!sum) { sum = usageSum(); x.state.usage.set(name, sum); }
	return sum;
}
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as ObjectValue)[key])]));
}
/** Fingerprint of a tool name and its canonical arguments. Arguments themselves never leave this function. */
export function fingerprint(name: string, args: unknown) {
	return createHash("sha256").update(name).update("\0").update(JSON.stringify(canonical(args ?? null)) ?? "").digest("hex").slice(0, 16);
}
function pairing(x: Ctx) { x.source.pairing ??= { calls: new Map(), results: new Map() }; return x.source.pairing; }

type At = { session: string; ref: Ref; time: number; durable: boolean };
function countResponse(m: ObjectValue, r: At, x: Ctx) {
	const u = x.store.units, f = x.state.filters;
	const model = `${text(m.provider) ?? "unknown"}/${text(m.model) ?? "unknown"}`;
	if (selected(f.models, model)) {
		const row = modelRow(x, model);
		u.modelResponses++; row.responses++;
		pushRef(row.refs, r.ref, x.state.refs);
		if (m.stopReason === "error") { u.errorResponses++; row.errorResponses++; pushRef(row.errorRefs, r.ref, x.state.refs); }
		if (m.stopReason === "aborted") { u.abortedResponses++; row.abortedResponses++; }
		addUsage(row.usage, m.usage); addUsage(category(x, "responses"), m.usage);
	}
	for (const item of Array.isArray(m.content) ? m.content : []) countCall(object(item), r, x);
}
function countCall(block: ObjectValue, r: At, x: Ctx) {
	const name = text(block.name);
	if (block.type !== "toolCall" || !name || !selected(x.state.filters.tools, name)) return;
	const u = x.store.units, row = toolRow(x, name);
	u.responseToolCalls++; if (!r.durable) u.topLevelToolCalls++;
	row.calls++; pushRef(row.callRefs, r.ref, x.state.refs);
	const id = text(block.id);
	if (id) pairing(x).calls.set(`${r.session}\0${id}`, [fingerprint(name, block.arguments), name, r.time, r.ref]);
}
function countResult(m: ObjectValue, r: At, x: Ctx) {
	const name = text(m.toolName) ?? "unknown";
	if (m.usage !== undefined && x.state.filters.models.length === 0) addUsage(category(x, "toolResults"), m.usage);
	if (name === "codemode") countNested(object(m.details).calls, r, x);
	if (!selected(x.state.filters.tools, name)) return;
	const u = x.store.units, row = toolRow(x, name), error = m.isError === true;
	u.toolResults++; row.results++;
	if (error) { u.errorToolResults++; row.errorResults++; pushRef(row.errorRefs, r.ref, x.state.refs); }
	const id = text(m.toolCallId);
	if (id) pairing(x).results.set(`${r.session}\0${id}`, error);
}
function countNested(value: unknown, r: At, x: Ctx) {
	const u = x.store.units;
	if (!Array.isArray(value)) { u.codemodeResultsWithoutCalls++; return; }
	const seen = new Set<unknown>();
	for (const call of value) {
		const row = object(call);
		const validId = r.durable ? Number.isSafeInteger(row.id) : typeof row.id === "string" && row.id.length > 0;
		if (!validId || typeof row.name !== "string") { u.malformedNestedCalls++; continue; }
		if (seen.has(row.id)) { u.duplicateNestedCalls++; continue; }
		seen.add(row.id);
		if (!selected(x.state.filters.tools, row.name)) continue;
		const tool = toolRow(x, row.name);
		u.nestedCodemodeCalls++; tool.nestedCalls++;
		if (row.status === "error") { u.nestedErrorCalls++; tool.nestedErrors++; pushRef(tool.errorRefs, r.ref, x.state.refs); }
	}
}
function countMessage(message: unknown, r: At, x: Ctx) {
	const m = object(message);
	if (m.role === "assistant") countResponse(m, r, x);
	if (m.role === "toolResult") countResult(m, r, x);
}
/** Usage carriers outside assistant messages that the ordinary session format defines. */
function countCarrier(row: ObjectValue, x: Ctx) {
	const kind = row.type === "usage" ? `usage:${text(row.kind) ?? "unknown"}` : row.type === "compaction" ? "compaction" : "branchSummary";
	const model = row.type === "usage" ? `${text(row.provider) ?? "unknown"}/${text(row.model) ?? "unknown"}` : undefined;
	const models = x.state.filters.models;
	if (models.length > 0 && (model === undefined || !models.includes(model))) return;
	if (row.usage === undefined) { x.state.withoutUsage.set(kind, (x.state.withoutUsage.get(kind) ?? 0) + 1); return; }
	addUsage(category(x, kind), row.usage);
}

function parseRecord(raw: string, c: Coverage): ObjectValue {
	try { return object(JSON.parse(raw)); } catch { c.malformedRecords++; return {}; }
}
const jsonlActivity = new Set(["message", "usage", "compaction", "branch_summary"]);
/** Returns true when the backward read reached a record older than the window. */
function countLine(line: Buffer, byte: number, cursor: JsonlCursor, x: Ctx): boolean {
	const c = x.store.coverage;
	c.recordsRead++; x.run.records++;
	if (line.length > x.limits.recordBytes) { cap(c, "recordBytes"); c.unsupportedRecords++; return false; }
	const row = parseRecord(line.toString("utf8"), c);
	const time = stamp(row.timestamp);
	if (Number.isFinite(time)) {
		if (cursor.lastTime !== null && time > cursor.lastTime) c.outOfOrderRecords++;
		cursor.lastTime = time;
	}
	if (!jsonlActivity.has(String(row.type))) return false;
	const where = place(row.timestamp, x.state);
	if (where === "missing") { c.missingTimestamps++; return false; }
	if (where !== "in") { c.outsideWindow++; if (where === "older") c.olderRecordStops++; return where === "older"; }
	x.source.inWindow++;
	if (row.type !== "message") { countCarrier(row, x); return false; }
	countMessage(row.message, { session: x.source.path, ref: [x.storeIndex, x.sourceIndex, byte, text(row.id) ?? null, time], time, durable: false }, x);
	return false;
}
/** Splits complete lines from the end of `buffer`; returns the unprocessed prefix length, or -1 after an older record. */
function consumeBackward(buffer: Buffer, start: number, cursor: JsonlCursor, x: Ctx): number {
	let hi = buffer.length;
	while (hi > 0) {
		if (exhausted(x)) return hi;
		const previous = hi >= 2 ? buffer.lastIndexOf(10, hi - 2) : -1;
		if (previous < 0 && start > 0) return hi;
		const lineStart = previous + 1;
		const older = hi - 1 > lineStart && countLine(buffer.subarray(lineStart, hi - 1), start + lineStart, cursor, x);
		hi = lineStart; cursor.end = start + hi;
		if (older) return -1;
	}
	return 0;
}
/** Drops bytes after the last newline at the snapshot end or of an oversized record; returns the kept length or -1. */
function trimTail(buffer: Buffer, start: number, cursor: JsonlCursor, c: Coverage): number {
	const newline = buffer.lastIndexOf(10);
	if (newline < 0 && start > 0) return -1;
	if (cursor.atEnd && buffer.length - (newline + 1) > 0) c.trailingFragments++;
	cursor.atEnd = false; cursor.skipping = false; cursor.end = start + newline + 1;
	return newline + 1;
}
async function readChunk(file: FileHandle, position: number, x: Ctx): Promise<Buffer> {
	const size = Math.min(65536, position, x.limits.bytes - x.run.bytes);
	const chunk = Buffer.alloc(size);
	const { bytesRead } = await file.read(chunk, 0, size, position - size);
	if (bytesRead !== size) throw new Error("short read");
	x.store.coverage.bytesRead += size; x.run.bytes += size;
	return chunk;
}
/** Returns the part to split into lines, or undefined while an unfinished or oversized line continues below. */
function dropTail(buffer: Buffer, position: number, cursor: JsonlCursor, c: Coverage): Buffer | undefined {
	if (!cursor.atEnd && !cursor.skipping) return buffer;
	const kept = trimTail(buffer, position, cursor, c);
	if (kept >= 0) return buffer.subarray(0, kept);
	if (cursor.atEnd) { c.trailingFragments++; cursor.atEnd = false; cursor.skipping = true; }
	return undefined;
}
function keepCarry(buffer: Buffer, rest: number, cursor: JsonlCursor, x: Ctx): Buffer {
	if (rest <= x.limits.recordBytes) return buffer.subarray(0, rest);
	cap(x.store.coverage, "recordBytes"); x.store.coverage.unsupportedRecords++; cursor.skipping = true;
	return Buffer.alloc(0);
}
/** Reads lines newest first from `cursor.end`; `cursor.end` always marks the start of the oldest processed line. */
async function readBackward(file: FileHandle, cursor: JsonlCursor, x: Ctx): Promise<boolean> {
	let carry: Buffer = Buffer.alloc(0), position = cursor.end;
	while (position > 0) {
		if (exhausted(x)) return false;
		const chunk = await readChunk(file, position, x);
		position -= chunk.length;
		const buffer = dropTail(Buffer.concat([chunk, carry]), position, cursor, x.store.coverage);
		carry = Buffer.alloc(0);
		if (!buffer) continue;
		const rest = consumeBackward(buffer, position, cursor, x);
		if (rest < 0 || (rest === 0 && position === 0)) return true;
		if (exhausted(x)) return false;
		carry = keepCarry(buffer, rest, cursor, x);
	}
	return true;
}
async function readJsonl(x: Ctx): Promise<Source["status"]> {
	const c = x.store.coverage, source = x.source;
	const file = await open(source.path, "r");
	try {
		const before = await file.stat();
		if (source.cursor && (before.ino !== source.ino || before.size < (source.cursor as JsonlCursor).snapshotSize)) { noteChange(x.state, source, "replaced during a resumed collection; earlier counts kept, remainder unread"); return "changed"; }
		if (source.cursor && before.size > (source.cursor as JsonlCursor).snapshotSize) noteChange(x.state, source, "appended after its snapshot; appended records excluded");
		source.cursor ??= { snapshotSize: before.size, end: before.size, atEnd: true, skipping: false, lastTime: null };
		const done = await readBackward(file, source.cursor as JsonlCursor, x);
		const after = await file.stat();
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) c.changedFiles++;
		c.filesRead++;
		if (done) source.stamp = `${after.size}:${after.mtimeMs}`;
		return done ? "done" : "partial";
	} finally { await file.close(); }
}

async function catalog(path: string, x: Ctx) {
	const c = x.store.coverage;
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.size > 32768 || info.size > x.limits.bytes - x.run.bytes) throw new Error("catalog bound");
		const buffer = await readFile(path);
		c.bytesRead += buffer.length; x.run.bytes += buffer.length;
		const record = object(JSON.parse(buffer.toString("utf8")));
		if (typeof record.storageId !== "string" || `${record.storageId}.json` !== basename(path)) throw new Error("catalog identity");
		c.catalogRead++;
	} catch { c.catalogUnavailable++; }
}
function countTask(record: ObjectValue, x: Ctx) {
	const u = x.store.units;
	if (record.kind === "pi.generation") u.generationStarts++;
	else if (record.kind === "pi.compaction") u.compactionStarts++;
	else if (object(record.input).kind === "model") u.topLevelToolCalls++;
	else if (object(record.input).kind === "nested") u.nestedToolTasks++;
	else x.store.coverage.unsupportedRecords++;
}
function countEntry(record: ObjectValue, conversation: number, entry: number, x: Ctx) {
	const message = object(Array.isArray(record.model) ? record.model[0] : undefined);
	const session = `${storageId(x.source.path)}:${conversation}`, time = stamp(message.timestamp);
	countMessage(message, { session, ref: [x.storeIndex, x.sourceIndex, conversation, entry, time], time, durable: true }, x);
}
const storageId = (path: string) => basename(path).replace(/\.sqlite$/u, "");
type Scan = { table: "tasks" | "entries"; sql: string };
const scans: Scan[] = [
	{ table: "tasks", sql: "json_extract(record, '$.kind') IN ('pi.tool', 'pi.generation', 'pi.compaction')" },
	{ table: "entries", sql: "json_extract(record, '$.kind') IN ('pi.assistant', 'pi.tool-result')" },
];
type Row = Record<string, SQLOutputValue>;
/** Counts one candidate row; returns false when the byte budget leaves the row for a later run. */
function scanRow(row: Row, content: StatementSync, scan: Scan, cursor: SqliteCursor, x: Ctx): boolean {
	const c = x.store.coverage, bytes = Number(row.bytes), where = place(row.t, x.state);
	c.rowsScanned++;
	if (where !== "in") { if (where === "missing") c.missingTimestamps++; else c.outsideWindow++; cursor.below = Number(row.id); return true; }
	if (bytes > x.limits.bytes - x.run.bytes) { cap(c, "bytes"); return false; }
	c.recordsRead++; x.run.records++; x.source.inWindow++;
	cursor.below = Number(row.id);
	if (bytes > x.limits.recordBytes) { cap(c, "recordBytes"); c.unsupportedRecords++; return true; }
	c.bytesRead += bytes; x.run.bytes += bytes;
	const record = parseRecord(String(content.get(row.id)?.record), c);
	if (scan.table === "tasks") countTask(record, x); else countEntry(record, Number(row.conversation), Number(row.id), x);
	return true;
}
/** Visits one table newest identifier first, selecting the window before records consume the record budget. */
function scanTable(db: DatabaseSync, scan: Scan, cursor: SqliteCursor, x: Ctx): boolean {
	const max = scan.table === "tasks" ? cursor.maxTasks : cursor.maxEntries;
	const time = scan.table === "tasks" ? "$.startedAt" : "$.model[0].timestamp";
	const rows = db.prepare(`SELECT id, ${scan.table === "entries" ? "conversation_id" : "0"} AS conversation, json_extract(record, '${time}') AS t,
		length(CAST(record AS BLOB)) AS bytes FROM ${scan.table} WHERE id <= ? AND id < ? AND ${scan.sql} ORDER BY id DESC`).iterate(max, cursor.below ?? max + 1);
	const content = db.prepare(`SELECT record FROM ${scan.table} WHERE id = ?`);
	for (const row of rows) if (exhausted(x) || !scanRow(row, content, scan, cursor, x)) return false;
	return true;
}
/** Adds each current conversation `pi.usage` document. It is a lifetime ledger: never windowed or added to records. */
function readLedger(db: DatabaseSync, x: Ctx): boolean {
	const c = x.store.coverage, f = x.state.filters;
	const documents = db.prepare(`SELECT d.id AS id, (SELECT seq FROM document_revisions r WHERE r.document_id = d.id ORDER BY seq DESC LIMIT 1) AS seq
		FROM documents d WHERE d.retired_at IS NULL AND (CASE WHEN json_valid(d.kind) THEN json_extract(d.kind, '$') ELSE d.kind END) = 'pi.usage'`).all();
	const revision = db.prepare("SELECT kind, length(CAST(content AS BLOB)) AS bytes, content FROM document_revisions WHERE document_id = ? AND seq = ?");
	const rows = [];
	let total = 0;
	for (const document of documents) {
		const row = revision.get(document.id, document.seq);
		total += Number(row?.bytes ?? 0);
		// The ledger of one storage is added whole, so a resumed collection never adds part of it twice.
		if (total > x.limits.bytes - x.run.bytes) { cap(c, "bytes"); return false; }
		rows.push(row);
	}
	c.bytesRead += total; x.run.bytes += total;
	for (const row of rows) {
		if (row?.kind !== "base") { c.ledgerUnsupported++; continue; }
		const value = parseRecord(String(row.content), c);
		c.ledgerDocuments++;
		addLedger(object(value.models), f.models, x.state.ledger.models);
		if (f.models.length === 0) addLedger(object(value.tools), f.tools, x.state.ledger.tools);
	}
	x.state.ledger.storages++;
	return true;
}
function addLedger(bucket: ObjectValue, filter: string[], into: Map<string, UsageSum>) {
	for (const [key, usage] of Object.entries(bucket)) {
		if (!selected(filter, key)) continue;
		const sum = into.get(key) ?? usageSum(); addUsage(sum, usage); into.set(key, sum);
	}
}
function maxId(db: DatabaseSync, table: "tasks" | "entries") { return Number(db.prepare(`SELECT coalesce(max(id), 0) AS id FROM ${table}`).get()?.id ?? 0); }
function sqlitePhases(db: DatabaseSync, cursor: SqliteCursor, x: Ctx): boolean {
	for (const scan of scans) {
		if (cursor.phase !== scan.table) continue;
		if (!scanTable(db, scan, cursor, x)) return false;
		cursor.phase = scan.table === "tasks" ? "entries" : "ledger"; cursor.below = null;
	}
	return x.source.inWindow === 0 || readLedger(db, x);
}
async function readSqlite(x: Ctx): Promise<Source["status"]> {
	const source = x.source;
	if (!source.cursor) await catalog(source.path.replace(/\.sqlite$/u, ".json"), x);
	const db = new DatabaseSync(source.path, { readOnly: true });
	try {
		// A deferred read transaction sees WAL commits without opening a writer or running migrations.
		db.exec("PRAGMA query_only=ON; BEGIN");
		const tasks = maxId(db, "tasks"), entries = maxId(db, "entries");
		const prior = source.cursor as SqliteCursor | undefined;
		if (prior && (tasks > prior.maxTasks || entries > prior.maxEntries)) noteChange(x.state, source, "rows added after its snapshot; added rows excluded");
		source.cursor ??= { maxTasks: tasks, maxEntries: entries, phase: "tasks", below: null };
		const done = sqlitePhases(db, source.cursor as SqliteCursor, x);
		db.exec("ROLLBACK"); x.store.coverage.filesRead++;
		if (done) source.stamp = await sqliteStamp(source.path);
		return done ? "done" : "partial";
	} finally { db.close(); }
}

function noteChange(state: State, source: Source, change: string) {
	if (source.changeNoted) return;
	source.changeNoted = true; state.changes.push({ path: source.path, change });
}
async function fileStamp(path: string) { try { const info = await lstat(path); return `${info.size}:${info.mtimeMs}`; } catch { return "absent"; } }
async function sqliteStamp(path: string) { return `${await fileStamp(path)}+${await fileStamp(`${path}-wal`)}`; }
/** Folds one finished source's calls into repeated-call groups; each session lies within one source. */
function fold(state: State, source: Source, sourceKey: string) {
	const p = source.pairing; source.pairing = undefined;
	if (!p) return;
	const groups = new Map<string, Repeat>();
	for (const [key, [print, tool, time, ref]] of p.calls) {
		const group = `${sourceKey}\0${key.slice(0, key.lastIndexOf("\0"))}\0${print}`;
		const row = groups.get(group) ?? { tool, times: [], errorTimes: [], refs: [] };
		row.times.push(time); pushRef(row.refs, ref, state.refs);
		const result = p.results.get(key);
		if (result === undefined) state.repetition.callsWithoutResult++;
		if (result === true) row.errorTimes.push(time);
		groups.set(group, row);
	}
	for (const key of p.results.keys()) if (!p.calls.has(key)) state.repetition.resultsWithoutCall++;
	state.repetition.fingerprints += groups.size;
	for (const [key, row] of groups) if (row.times.length > 1) state.repetition.keys.set(key, row);
}

async function candidate(path: string, kind: StoreKind, store: StoreState, state: State) {
	const info = await lstat(path);
	const wal = kind === "durable" ? await lstat(`${path}-wal`).catch(() => undefined) : undefined;
	// An empty WAL holds no frames; a read-only open creates one, so only a non-empty WAL dates newer records.
	const mtimeMs = Math.max(info.mtimeMs, wal && wal.size > 0 ? wal.mtimeMs : 0);
	// A file last modified before the window cannot hold a record written within it.
	if (mtimeMs < state.from) { store.coverage.filesBeforeWindow++; return; }
	store.sources.push({ path, ino: info.ino, stamp: "", mtimeMs, status: "pending", inWindow: 0 });
}
type Walk = { store: StoreState; state: State; limits: Limits; deadline: number };
function discoveryStopped(w: Walk) {
	const c = w.store.coverage;
	if (c.directoryEntriesVisited >= w.limits.visits) cap(c, "visits");
	if (c.filesVisited >= w.limits.files) cap(c, "files");
	if (Date.now() >= w.deadline) cap(c, "seconds");
	const stop = ["visits", "files", "seconds"].some(key => c.capsReached.includes(key));
	if (stop) c.discoveryComplete = false;
	return stop;
}
async function visit(entry: Dirent, path: string, depth: number, w: Walk) {
	const c = w.store.coverage, kind = w.store.kind;
	c.directoryEntriesVisited++;
	const child = join(path, entry.name);
	if (entry.isDirectory()) {
		if (depth < 1 && kind !== "durable" && !entry.name.startsWith(".")) await walk(child, depth + 1, w);
		else c.directoriesSkipped++;
		return;
	}
	if (!entry.name.endsWith(kind === "durable" ? ".sqlite" : ".jsonl")) { c.entriesIgnored++; return; }
	c.filesVisited++;
	if (!entry.isFile()) { c.filesSkipped++; return; }
	try { await candidate(child, kind, w.store, w.state); } catch { c.filesUnreadable++; }
}
async function walk(path: string, depth: number, w: Walk): Promise<void> {
	if (discoveryStopped(w)) return;
	let directory: Awaited<ReturnType<typeof opendir>>;
	try { directory = await opendir(path); } catch { w.store.coverage.directoriesUnreadable++; w.store.coverage.discoveryComplete = false; return; }
	w.store.coverage.directoriesVisited++; if (depth === 0) w.store.coverage.storesVisited++;
	try {
		for await (const entry of directory) {
			if (discoveryStopped(w)) break;
			await visit(entry, path, depth, w);
		}
	} catch { w.store.coverage.directoriesUnreadable++; w.store.coverage.discoveryComplete = false; }
}
function storeRoot(kind: StoreKind, o: Options) {
	return kind === "primary" ? join(o.agentDir, "sessions") : join(o.agentSessionsDir, kind);
}
function sourceKind(path: string, o: Options): StoreKind {
	if (path.endsWith(".sqlite")) return "durable";
	return path.startsWith(join(o.agentSessionsDir, "native") + sep) ? "native" : "primary";
}
async function discover(state: State, o: Options) {
	const deadline = Date.now() + o.limits.seconds * 1000;
	for (const store of state.stores) {
		if (state.filters.sources.length > 0) {
			for (const path of state.filters.sources.filter(path => sourceKind(path, o) === store.kind)) {
				store.coverage.filesVisited++;
				try { await candidate(path, store.kind, store, state); } catch { store.coverage.filesUnreadable++; }
			}
		} else await walk(store.roots[0], 0, { store, state, limits: o.limits, deadline });
		store.sources.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
	}
}
function newState(o: Options): State {
	const filters = o.filters ?? { stores: storeKinds, sources: [], tools: [], models: [] };
	const explicit = filters.sources.length > 0;
	const kinds = explicit ? storeKinds.filter(kind => filters.sources.some(path => sourceKind(path, o) === kind)) : filters.stores;
	return { version: 1, from: o.from, to: o.to, filters, refs: o.limits.refs,
		stores: kinds.map(kind => ({ kind, roots: explicit ? ["explicit sources"] : [storeRoot(kind, o)], units: units(), coverage: coverage(), sources: [] })),
		tools: new Map(), models: new Map(), usage: new Map(), withoutUsage: new Map(), ledger: { models: new Map(), tools: new Map(), storages: 0 },
		repetition: { keys: new Map(), fingerprints: 0, callsWithoutResult: 0, resultsWithoutCall: 0 }, changes: [] };
}
async function checkFinished(state: State) {
	for (const store of state.stores) for (const source of store.sources) {
		if (source.status !== "done") continue;
		const now = store.kind === "durable" ? await sqliteStamp(source.path) : await fileStamp(source.path);
		if (now !== source.stamp) noteChange(state, source, "modified after it was read; later records excluded");
	}
}
async function collectSource(x: Ctx) {
	const status = await (x.store.kind === "durable" ? readSqlite(x) : readJsonl(x)).catch(() => "unreadable" as const);
	if (status === "unreadable") x.store.coverage.filesUnreadable++;
	x.source.status = status;
	if (status !== "partial") fold(x.state, x.source, `${x.storeIndex}/${x.sourceIndex}`);
}
async function collectStore(state: State, storeIndex: number, limits: Limits) {
	const store = state.stores[storeIndex];
	// Run budgets restart; discovery caps describe the frozen source list and stay.
	store.coverage.capsReached = store.coverage.capsReached.filter(key => key === "visits" || key === "files"); store.coverage.runs++;
	const x: Ctx = { state, store, storeIndex, sourceIndex: 0, source: store.sources[0], limits, deadline: Date.now() + limits.seconds * 1000, run: { records: 0, bytes: 0 } };
	for (const [sourceIndex, source] of store.sources.entries()) {
		if (source.status !== "pending" && source.status !== "partial") continue;
		if (exhausted(x)) break;
		Object.assign(x, { sourceIndex, source });
		await collectSource(x);
	}
}

const replacer = (_key: string, value: unknown) => value instanceof Map ? { $map: [...value] } : value;
const reviver = (_key: string, value: unknown) => {
	const row = object(value);
	return Array.isArray(row.$map) && Object.keys(row).length === 1 ? new Map(row.$map as Array<[unknown, unknown]>) : value;
};
export function encode(state: State) { return `v1.${deflateRawSync(JSON.stringify(state, replacer)).toString("base64url")}`; }
export function decode(token: string): State {
	if (!token.startsWith("v1.")) throw new Error("Unsupported continuation");
	const state = JSON.parse(inflateRawSync(Buffer.from(token.slice(3), "base64url")).toString("utf8"), reviver) as State;
	if (state.version !== 1) throw new Error("Unsupported continuation");
	return state;
}
async function resumeState(path: string): Promise<State> {
	const info = await lstat(path);
	if (!info.isFile() || info.size > defaults.bytes) throw new Error("Resume file is not a bounded regular file");
	const token = object(JSON.parse(await readFile(path, "utf8"))).continuation;
	if (typeof token !== "string") throw new Error("Resume file has no continuation; that collection finished");
	return decode(token);
}

function top<T>(rows: Array<[string, T]>, n: number, score: (row: T) => number) {
	const sorted = rows.sort((a, b) => score(b[1]) - score(a[1]) || (a[0] < b[0] ? -1 : 1));
	return { shown: sorted.slice(0, n), rest: sorted.slice(n) };
}
function resolveRefs(state: State, refs: Ref[]) {
	return refs.map(([storeIndex, sourceIndex, a, b, time]) => {
		const store = state.stores[storeIndex], path = store.sources[sourceIndex].path, at = new Date(time).toISOString();
		return store.kind === "durable" ? { sessionId: `${storageId(path)}:${a}`, entryId: b, at } : { file: path, byte: a, entryId: b, at };
	});
}
function repeatStats(row: Repeat) {
	const firstError = row.errorTimes.length ? Math.min(...row.errorTimes) : Number.POSITIVE_INFINITY;
	return { calls: row.times.length, repeatedCalls: row.times.length - 1, errorResults: row.errorTimes.length, callsAfterError: row.times.filter(time => time > firstError).length };
}
function sumRows<K extends string>(rows: Array<Record<K, number>>, keys: readonly K[]) {
	return Object.fromEntries(keys.map(key => [key, rows.reduce((total, row) => total + row[key], 0)])) as Record<K, number>;
}
function repetitionReport(state: State, n: number) {
	const rows = [...state.repetition.keys.entries()].map(([key, row]) => [key, { row, stats: repeatStats(row) }] as [string, { row: Repeat; stats: ReturnType<typeof repeatStats> }]);
	const perTool = new Map<string, { repeatedCalls: number; callsAfterError: number }>();
	for (const [, { row, stats }] of rows) {
		const total = perTool.get(row.tool) ?? { repeatedCalls: 0, callsAfterError: 0 };
		total.repeatedCalls += stats.repeatedCalls; total.callsAfterError += stats.callsAfterError; perTool.set(row.tool, total);
	}
	const { shown, rest } = top(rows, n, value => value.stats.repeatedCalls * 1e6 + value.stats.callsAfterError);
	const keys = ["calls", "repeatedCalls", "errorResults", "callsAfterError"] as const;
	return { perTool, report: {
		scope: "Observed repetition, not waste: identical top-level calls (same tool and canonical arguments) within one session. callsAfterError counts later identical calls after one whose result was an error. Nested codemode calls are excluded because their rows keep only truncated argument previews.",
		callFingerprints: state.repetition.fingerprints, repeatedFingerprints: rows.length,
		...sumRows(rows.map(([, value]) => value.stats), [...keys]),
		callsWithoutResult: state.repetition.callsWithoutResult, resultsWithoutCall: state.repetition.resultsWithoutCall,
		rows: shown.map(([, { row, stats }]) => ({ tool: row.tool, session: sessionOf(state, row.refs[0]), ...stats, refs: resolveRefs(state, row.refs) })),
		other: rest.length ? { fingerprints: rest.length, ...sumRows(rest.map(([, value]) => value.stats), [...keys]) } : null } };
}
function sessionOf(state: State, [storeIndex, sourceIndex, conversation]: Ref) {
	const store = state.stores[storeIndex], path = store.sources[sourceIndex].path;
	return store.kind === "durable" ? `${storageId(path)}:${conversation}` : path;
}
function toolsReport(state: State, n: number, perTool: Map<string, { repeatedCalls: number; callsAfterError: number }>) {
	const keys = ["calls", "results", "errorResults", "nestedCalls", "nestedErrors"] as const;
	const { shown, rest } = top([...state.tools.entries()], n, row => row.calls + row.results + row.nestedCalls);
	return { rows: shown.map(([tool, row]) => ({ tool, ...sumRows([row], [...keys]), ...(perTool.get(tool) ?? { repeatedCalls: 0, callsAfterError: 0 }),
		errorRefs: resolveRefs(state, row.errorRefs), callRefs: resolveRefs(state, row.callRefs) })),
	other: rest.length ? { tools: rest.length, ...sumRows(rest.map(([, row]) => row), [...keys]) } : null };
}
function modelsReport(state: State, n: number) {
	const { shown, rest } = top([...state.models.entries()], n, row => row.usage.cost * 1e6 + row.responses);
	const other = usageSum();
	for (const [, row] of rest) mergeUsage(other, row.usage);
	return { rows: shown.map(([model, row]) => ({ model, responses: row.responses, errorResponses: row.errorResponses, abortedResponses: row.abortedResponses,
		usage: rounded(row.usage), errorRefs: resolveRefs(state, row.errorRefs), refs: resolveRefs(state, row.refs) })),
	other: rest.length ? { models: rest.length, ...sumRows(rest.map(([, row]) => row), ["responses", "errorResponses", "abortedResponses"]), usage: rounded(other) } : null };
}
function ledgerRows(map: Map<string, UsageSum>, n: number) {
	const { shown, rest } = top([...map.entries()], n, row => row.cost);
	const other = usageSum();
	for (const [, row] of rest) mergeUsage(other, row);
	return { rows: shown.map(([key, usage]) => ({ key, usage: rounded(usage) })), other: rest.length ? { keys: rest.length, usage: rounded(other) } : null };
}
function usageReport(state: State, n: number) {
	const windowed = usageSum(), other: Record<string, UsageSum> = {};
	for (const [key, sum] of state.usage) { mergeUsage(windowed, sum); if (key !== "responses") other[key] = rounded(sum); }
	return {
		scope: "Recorded nominal usage in windowed records; cost is model metadata, not billing. The carriers below are disjoint by their defining writers, so their sum adds no record twice. Copied or forked histories can still repeat records across sources.",
		responseOnly: rounded(state.usage.get("responses") ?? usageSum()),
		otherCarriers: other, withoutUsage: Object.fromEntries(state.withoutUsage), windowedRecorded: rounded(windowed),
		unavailableInWindow: ["Durable compaction usage: written only to the conversation pi.usage ledger", "Durable nested tool usage: written only to the ledger and a retiring task document"],
		ledger: { scope: "Durable conversation pi.usage documents: lifetime totals of storages with windowed records, including compaction and nested tool usage. Never add them to windowed figures.",
			storages: state.ledger.storages, models: ledgerRows(state.ledger.models, n), tools: ledgerRows(state.ledger.tools, n) },
	};
}
function sourceCounts(store: StoreState) {
	const counts = { total: store.sources.length, done: 0, partial: 0, pending: 0, unreadable: 0, changed: 0 };
	for (const source of store.sources) counts[source.status]++;
	return counts;
}
function report(state: State, limits: Limits) {
	const total = units();
	for (const store of state.stores) for (const key of Object.keys(total) as Array<keyof Units>) total[key] += store.units[key];
	const unfinished = state.stores.some(store => store.sources.some(source => source.status === "pending" || source.status === "partial"));
	const { perTool, report: repetition } = repetitionReport(state, limits.groups);
	return {
		window: { from: new Date(state.from).toISOString(), toExclusive: new Date(state.to).toISOString() }, filters: state.filters, limitsPerStorePerRun: limits,
		complete: !unfinished && state.stores.every(store => store.coverage.discoveryComplete),
		modelRequests: { exactProviderAttempts: null, reason: "Retained responses and generation tasks do not record every provider attempt; retries and preparation failures differ." },
		stores: state.stores.map(store => ({ kind: store.kind, roots: store.roots, units: store.units, coverage: store.coverage, sources: sourceCounts(store) })),
		total, tools: toolsReport(state, limits.groups, perTool), models: modelsReport(state, limits.groups), usage: usageReport(state, limits.groups), repetition,
		changes: { count: state.changes.length, rows: state.changes.slice(0, limits.groups) },
		scope: "Retained records, not selected ancestry or unique executed work. Converted or copied histories may repeat across stores. Tool results record completion, not acceptance.",
		continuation: unfinished ? encode(state) : null,
	};
}
export async function collect(o: Options) {
	const state = o.resume ? await resumeState(o.resume) : newState(o);
	if (o.resume) await checkFinished(state); else await discover(state, o);
	for (const index of state.stores.keys()) await collectStore(state, index, o.limits);
	return report(state, o.limits);
}

function parseWindow(values: Map<string, string>) {
	const instants = ["--from", "--to"].map(key => {
		const value = values.get(key) ?? "";
		const time = Date.parse(value);
		if (!Number.isFinite(time) || !/Z$|[+-]\d\d:\d\d$/u.test(value)) throw new Error("Supply --from and --to ISO instants with timezone");
		return time;
	});
	if (instants[0] >= instants[1]) throw new Error("Expected from before to");
	return { from: instants[0], to: instants[1] };
}
function parseLimits(values: Map<string, string>): Limits {
	const limits = { ...defaults };
	for (const key of Object.keys(defaults) as Array<keyof Limits>) {
		const value = Number(values.get(`--${key}`) ?? defaults[key]);
		if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key] * 16) throw new Error(`Invalid bound --${key}`);
		limits[key] = value;
	}
	return limits;
}
const list = (value: string | undefined) => value === undefined ? [] : value.split(",").map(item => item.trim()).filter(Boolean);
function parseFilters(values: Map<string, string>): Filters {
	const stores = list(values.get("--store"));
	for (const store of stores) if (!storeKinds.includes(store as StoreKind)) throw new Error(`Unknown store ${store}`);
	const sources = list(values.get("--source")).map(path => resolve(path));
	for (const path of sources) if (!/\.(jsonl|sqlite)$/u.test(path)) throw new Error("A --source must name a .jsonl or .sqlite file");
	return { stores: stores.length ? stores as StoreKind[] : storeKinds, sources, tools: list(values.get("--tool")), models: list(values.get("--model")) };
}
const selection = ["--from", "--to", "--store", "--source", "--tool", "--model", "--agent-dir", "--agent-sessions-dir"];
export function parseArgs(args: string[]): Options {
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		if (!args[i]?.startsWith("--") || !args[i + 1] || values.has(args[i])) throw new Error("Expected unique --flag value pairs; use --help");
		values.set(args[i], args[i + 1]);
	}
	const allowed = [...selection, "--resume", ...Object.keys(defaults).map(key => `--${key}`)];
	for (const key of values.keys()) if (!allowed.includes(key)) throw new Error(`Unknown flag ${key}`);
	const limits = parseLimits(values);
	const resume = values.get("--resume");
	if (resume !== undefined) {
		if (selection.some(key => values.has(key))) throw new Error("A continuation binds window, filters and sources; pass only --resume and bounds");
		return { from: 0, to: 0, limits, agentDir: "", agentSessionsDir: "", resume: resolve(resume) };
	}
	const { from, to } = parseWindow(values);
	const agentDir = resolve(values.get("--agent-dir") ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	return { from, to, limits, filters: parseFilters(values), agentDir,
		agentSessionsDir: resolve(values.get("--agent-sessions-dir") ?? process.env.PI_AGENT_SESSIONS_DIR ?? join(agentDir, "agent-sessions")) };
}
const help = `Read-only retained Pi activity. Node with node:sqlite required.
Usage: node activity.mts --from ISO --to ISO [--store primary,durable,native] [--source FILE,...] [--tool NAME,...] [--model PROVIDER/MODEL,...]
         [--agent-dir PATH] [--agent-sessions-dir PATH] [bounds]
       node activity.mts --resume PREVIOUS_OUTPUT.json [bounds]
Bounds per store and run (positive integers, maximum 16 times default): ${JSON.stringify(defaults)}
Output: bounded JSON aggregates with exact references; no prompts or tool arguments. A non-null continuation resumes the same collection.
See references/activity-stores.md for units, filters and limits.`;
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.includes("--help")) console.log(help);
	else { try { console.log(JSON.stringify(await collect(parseArgs(process.argv.slice(2))), null, 2)); } catch (error) { console.error(error instanceof Error ? error.message : "Collection failed"); process.exitCode = 1; } }
}
