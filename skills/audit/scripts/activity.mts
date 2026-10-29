import type { Dir, Dirent } from "node:fs";
import { open, opendir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const fields = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const;
export const defaults = { visits: 10000, files: 2048, bytes: 268435456, records: 500000, recordBytes: 2097152, seconds: 60 };
export type Limits = typeof defaults;
export type Options = { agentDir: string; agentSessionsDir: string; from: number; to: number; limits: Limits };
function blankTokens() { return Object.fromEntries(fields.map(key => [key, 0])) as Record<typeof fields[number], number>; }
export function units() {
	return { topLevelToolCalls: 0, nestedCodemodeCalls: 0, nestedToolTasks: 0, generationStarts: 0,
		modelResponses: 0, usageRecords: 0, missingUsage: 0, costRecords: 0, missingCost: 0, recordedCost: 0,
		tokens: blankTokens(),
		missingTokenFields: blankTokens(),
		codemodeResultsWithoutCalls: 0, malformedNestedCalls: 0, duplicateNestedCalls: 0 };
}
type Units = ReturnType<typeof units>;
function coverage() {
	return { storesVisited: 0, directoriesVisited: 0, directoryEntriesVisited: 0, filesVisited: 0,
		filesRead: 0, filesSkipped: 0, filesUnreadable: 0, directoriesUnreadable: 0, directoriesSkipped: 0, entriesIgnored: 0, catalogRead: 0,
		catalogUnavailable: 0, bytesRead: 0, recordsRead: 0, malformedRecords: 0, unsupportedRecords: 0,
		missingTimestamps: 0, outsideWindow: 0, changedFiles: 0, partialFiles: 0, trailingFragments: 0,
		capsReached: [] as string[], discoveryComplete: true };
}
type Coverage = ReturnType<typeof coverage>;
function cap(c: Coverage, name: string) { if (!c.capsReached.includes(name)) c.capsReached.push(name); }
function stamp(value: unknown): number { return typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN; }
function inWindow(value: unknown, c: Coverage, options: Options) {
	const time = stamp(value);
	if (!Number.isFinite(time)) { c.missingTimestamps++; return false; }
	if (time < options.from || time >= options.to) { c.outsideWindow++; return false; }
	return true;
}
function countUsage(value: unknown, u: Units) {
	const usage = object(value);
	if (Object.keys(usage).length === 0) u.missingUsage++; else u.usageRecords++;
	for (const key of fields) { if (finite(usage[key])) u.tokens[key] += usage[key]; else u.missingTokenFields[key]++; }
	const cost = object(usage.cost).total;
	if (finite(cost)) { u.costRecords++; u.recordedCost += cost; } else u.missingCost++;
}
function countNested(value: unknown, u: Units, durable: boolean) {
	if (!Array.isArray(value)) { u.codemodeResultsWithoutCalls++; return; }
	const seen = new Set<unknown>();
	for (const call of value) {
		const row = object(call);
		const validId = durable ? Number.isSafeInteger(row.id) : typeof row.id === "string" && row.id.length > 0;
		if (!validId || typeof row.name !== "string") { u.malformedNestedCalls++; continue; }
		if (seen.has(row.id)) { u.duplicateNestedCalls++; continue; }
		seen.add(row.id); u.nestedCodemodeCalls++;
	}
}
export function countMessage(message: unknown, u: Units, durable: boolean) {
	const m = object(message);
	if (m.role === "assistant") {
		u.modelResponses++;
		if (!durable && Array.isArray(m.content)) u.topLevelToolCalls += m.content.filter(item => object(item).type === "toolCall").length;
		countUsage(m.usage, u);
	}
	if (m.role === "toolResult" && m.toolName === "codemode") countNested(object(m.details).calls, u, durable);
}
function parseRecord(raw: string, c: Coverage): ObjectValue {
	try { return object(JSON.parse(raw)); } catch { c.malformedRecords++; return {}; }
}
function countLine(line: Buffer, c: Coverage, u: Units, o: Options) {
	c.recordsRead++;
	if (line.length > o.limits.recordBytes) { cap(c, "recordBytes"); c.unsupportedRecords++; return; }
	const row = parseRecord(line.toString("utf8"), c);
	if (row.type === "message" && inWindow(row.timestamp, c, o)) countMessage(row.message, u, false);
}
function consumeLines(buffer: Buffer, c: Coverage, u: Units, o: Options) {
	let pending = buffer;
	let end = pending.indexOf(10);
	while (end >= 0 && c.recordsRead < o.limits.records) {
		countLine(pending.subarray(0, end), c, u, o);
		pending = pending.subarray(end + 1); end = pending.indexOf(10);
	}
	return pending;
}
function exhausted(c: Coverage, o: Options, deadline: number) {
	if (Date.now() >= deadline) cap(c, "seconds");
	if (c.bytesRead >= o.limits.bytes) cap(c, "bytes");
	if (c.recordsRead >= o.limits.records) cap(c, "records");
	return c.capsReached.some(key => ["seconds", "bytes", "records"].includes(key));
}
async function jsonl(path: string, c: Coverage, u: Units, o: Options, deadline: number) {
	const file = await open(path, "r");
	try {
		const before = await file.stat();
		let position = 0;
		let pending: Buffer = Buffer.alloc(0);
		const chunk = Buffer.alloc(65536);
		while (position < before.size && !exhausted(c, o, deadline)) {
			const size = Math.min(chunk.length, before.size - position, o.limits.bytes - c.bytesRead);
			const { bytesRead } = await file.read(chunk, 0, size, position);
			if (!bytesRead) break;
			position += bytesRead; c.bytesRead += bytesRead;
			pending = consumeLines(Buffer.concat([pending, chunk.subarray(0, bytesRead)]), c, u, o);
			if (pending.length > o.limits.recordBytes) { cap(c, "recordBytes"); break; }
		}
		exhausted(c, o, deadline);
		if (pending.length) c.trailingFragments++;
		if (position < before.size || pending.length) c.partialFiles++;
		const after = await file.stat();
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) c.changedFiles++;
		c.filesRead++;
	} finally { await file.close(); }
}
async function catalog(path: string, c: Coverage, o: Options) {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.size > 32768 || info.size > o.limits.bytes - c.bytesRead) throw new Error("catalog bound");
		const f = await open(path, "r");
		try {
			const buffer = Buffer.alloc(info.size);
			const { bytesRead } = await f.read(buffer, 0, buffer.length, 0); c.bytesRead += bytesRead;
			const record = object(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
			if (typeof record.storageId !== "string" || `${record.storageId}.json` !== path.split(/[\\/]/u).at(-1)) throw new Error("catalog identity");
			c.catalogRead++;
		} finally { await f.close(); }
	} catch { c.catalogUnavailable++; }
}
function countTask(record: ObjectValue, c: Coverage, u: Units, o: Options) {
	if (record.kind !== "pi.tool" && record.kind !== "pi.generation") return;
	if (!inWindow(record.startedAt, c, o)) return;
	if (record.kind === "pi.generation") u.generationStarts++;
	else if (object(record.input).kind === "model") u.topLevelToolCalls++;
	else if (object(record.input).kind === "nested") u.nestedToolTasks++;
	else c.unsupportedRecords++;
}
function countEntry(record: ObjectValue, c: Coverage, u: Units, o: Options) {
	if (record.kind !== "pi.assistant" && record.kind !== "pi.tool-result") return;
	const message = object(Array.isArray(record.model) ? record.model[0] : undefined);
	if (inWindow(message.timestamp, c, o)) countMessage(message, u, true);
}
function sqliteRows(db: DatabaseSync, table: "tasks" | "entries", c: Coverage, u: Units, o: Options, deadline: number) {
	const rows = db.prepare(`SELECT id, length(CAST(record AS BLOB)) AS bytes FROM ${table} ORDER BY id LIMIT ?`).iterate(o.limits.records - c.recordsRead + 1);
	const content = db.prepare(`SELECT record FROM ${table} WHERE id = ?`);
	for (const row of rows) {
		if (exhausted(c, o, deadline)) return false;
		const bytes = Number(row.bytes);
		if (bytes > o.limits.bytes - c.bytesRead) { cap(c, "bytes"); return false; }
		c.recordsRead++;
		if (bytes > o.limits.recordBytes) { cap(c, "recordBytes"); c.unsupportedRecords++; continue; }
		const raw = String(content.get(row.id)?.record);
		c.bytesRead += bytes;
		const record = parseRecord(raw, c);
		if (table === "tasks") countTask(record, c, u, o); else countEntry(record, c, u, o);
	}
	return true;
}
async function sqlite(path: string, c: Coverage, u: Units, o: Options, deadline: number) {
	await catalog(path.replace(/\.sqlite$/u, ".json"), c, o);
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		// A deferred read transaction sees WAL commits without opening a writer or running migrations.
		db.exec("PRAGMA query_only=ON; BEGIN");
		for (const table of ["tasks", "entries"] as const) {
			if (!sqliteRows(db, table, c, u, o, deadline)) { c.partialFiles++; break; }
		}
		db.exec("ROLLBACK"); c.filesRead++;
	} finally { db.close(); }
}
type StoreKind = "primary" | "durable" | "native";
type Scan = { c: Coverage; u: Units; o: Options; deadline: number; kind: StoreKind };
function discoveryStopped(s: Scan) {
	const { c, o, deadline } = s;
	if (c.directoryEntriesVisited >= o.limits.visits) cap(c, "visits");
	if (c.filesVisited >= o.limits.files) cap(c, "files");
	const stop = exhausted(c, o, deadline) || c.capsReached.includes("visits") || c.capsReached.includes("files");
	if (stop) c.discoveryComplete = false;
	return stop;
}
async function visit(entry: Dirent, path: string, depth: number, s: Scan) {
	const { c, u, o, deadline, kind } = s;
	c.directoryEntriesVisited++;
	const child = join(path, entry.name);
	if (entry.isDirectory()) {
		if (depth < 1 && kind !== "durable" && !entry.name.startsWith(".")) await walk(child, depth + 1, s);
		else c.directoriesSkipped++;
		return;
	}
	if (!entry.name.endsWith(kind === "durable" ? ".sqlite" : ".jsonl")) { c.entriesIgnored++; return; }
	c.filesVisited++;
	if (!entry.isFile()) { c.filesSkipped++; return; }
	try { if (kind === "durable") await sqlite(child, c, u, o, deadline); else await jsonl(child, c, u, o, deadline); }
	catch { c.filesUnreadable++; }
}
async function walk(path: string, depth: number, s: Scan): Promise<void> {
	if (discoveryStopped(s)) return;
	let directory: Dir;
	try { directory = await opendir(path); } catch { s.c.directoriesUnreadable++; s.c.discoveryComplete = false; return; }
	s.c.directoriesVisited++; if (depth === 0) s.c.storesVisited++;
	try {
		for await (const entry of directory) {
			if (discoveryStopped(s)) break;
			await visit(entry, path, depth, s);
		}
	} catch { s.c.directoriesUnreadable++; s.c.discoveryComplete = false; }
}
export async function collectStore(root: string, kind: StoreKind, o: Options) {
	const c = coverage(), u = units(), deadline = Date.now() + o.limits.seconds * 1000;
	await walk(root, 0, { c, u, o, deadline, kind });
	return { root, kind, units: u, coverage: c };
}
export async function collect(o: Options) {
	const stores = [];
	for (const [kind, root] of [["primary", join(o.agentDir, "sessions")], ["durable", join(o.agentSessionsDir, "durable")], ["native", join(o.agentSessionsDir, "native")]] as const) stores.push(await collectStore(root, kind, o));
	const total = units();
	for (const store of stores) for (const key of Object.keys(total) as Array<keyof Units>) {
		if (key === "tokens" ||
			key === "missingTokenFields") for (const field of fields) total[key][field] += store.units[key][field];
		else total[key] += store.units[key];
	}
	return { window: { from: new Date(o.from).toISOString(), toExclusive: new Date(o.to).toISOString() }, limitsPerStore: o.limits,
		modelRequests: { exactProviderAttempts: null, reason: "Retained responses and generation tasks do not record every provider attempt; retries and preparation failures differ." },
		stores, total, scope: "Retained records, not selected ancestry or unique executed work. Converted or copied histories may repeat across stores. Costs are recorded nominal values, not billing." };
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
export function parseArgs(args: string[]): Options {
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		if (!args[i]?.startsWith("--") || !args[i + 1] || values.has(args[i])) throw new Error("Expected unique --flag value pairs; use --help");
		values.set(args[i], args[i + 1]);
	}
	const allowed = ["--from", "--to", "--agent-dir", "--agent-sessions-dir", ...Object.keys(defaults).map(key => `--${key}`)];
	for (const key of values.keys()) if (!allowed.includes(key)) throw new Error(`Unknown flag ${key}`);
	const { from, to } = parseWindow(values);
	const limits = parseLimits(values);
	const agentDir = resolve(values.get("--agent-dir") ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	return { from, to, limits, agentDir, agentSessionsDir: resolve(values.get("--agent-sessions-dir") ?? process.env.PI_AGENT_SESSIONS_DIR ?? join(agentDir, "agent-sessions")) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.includes("--help")) console.log(`Read-only retained Pi activity. Node with node:sqlite required.\nUsage: node activity.mts --from ISO --to ISO [--agent-dir PATH] [--agent-sessions-dir PATH]\nBounds per store (positive integers, maximum 16 times default): ${JSON.stringify(defaults)}\nOutput: bounded JSON aggregates; no prompts or tool arguments. See references/activity-stores.md for units and limits.`);
	else { try { console.log(JSON.stringify(await collect(parseArgs(process.argv.slice(2))), null, 2)); } catch (error) { console.error(error instanceof Error ? error.message : "Collection failed"); process.exitCode = 1; } }
}
