import assert from "node:assert/strict";
import { appendFile, lstat, mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { captureHooks, collect, decode, defaults, fingerprint, parseArgs, type Filters, type Options, type StoreKind } from "./activity.mts";

const time = Date.parse("2026-10-20T12:00:00Z");
const hour = 3600000;
const usage = (total: number, cost: number) => ({ input: 5, output: 3, cacheRead: 2, cacheWrite: 0, reasoning: 1, totalTokens: total, cost: { total: cost } });
const assistant = (at = time, calls: Array<{ id: string; name: string; arguments?: unknown }> = [{ id: "outer", name: "codemode" }], extra: Record<string, unknown> = {}) =>
	({ role: "assistant", provider: "p", model: "m", timestamp: at, content: calls.map(call => ({ type: "toolCall", ...call })), usage: usage(10, 0.125), stopReason: "toolUse", ...extra });
const toolResult = (toolCallId: string, toolName: string, isError = false, at = time, extra: Record<string, unknown> = {}) =>
	({ role: "toolResult", toolCallId, toolName, isError, timestamp: at, content: [], ...extra });
const codemode = (ids: unknown[]) => toolResult("outer", "codemode", false, time, { details: { calls: ids.map((id, index) => ({ id, name: index % 2 ? "bash" : "read", status: "ok" })) } });
let sequence = 0;
const entry = (row: Record<string, unknown>, at = time) => `${JSON.stringify({ id: `e${++sequence}`, timestamp: new Date(at).toISOString(), ...row })}\n`;
const line = (message: Record<string, unknown>, at = typeof message.timestamp === "number" ? message.timestamp : time) => entry({ type: "message", message }, at);

type Fixture = { root: string; o: Options; primary: string; native: string; durable: string };
async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "audit-activity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const o: Options = { agentDir: root, agentSessionsDir: join(root, "agent-sessions"), from: time, to: time + hour, limits: { ...defaults } };
	const f = { root, o, primary: join(root, "sessions", "project"), native: join(o.agentSessionsDir, "native"), durable: join(o.agentSessionsDir, "durable") };
	for (const path of [f.primary, f.native, f.durable]) await mkdir(path, { recursive: true });
	return f;
}
const only = (stores: StoreKind[], extra: Partial<Filters> = {}): Filters => ({ stores, sources: [], tools: [], models: [], ...extra });
function storage(t: { after: (fn: () => void) => void }, path: string) {
	const db = new DatabaseSync(path);
	t.after(() => { if (db.isOpen) db.close(); });
	db.exec(`PRAGMA journal_mode=WAL;
		CREATE TABLE tasks(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, kind TEXT NOT NULL, record TEXT NOT NULL);
		CREATE TABLE entries(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL);
		CREATE TABLE documents(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, retired_at INTEGER, record TEXT NOT NULL);
		CREATE TABLE document_revisions(document_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (document_id, seq))`);
	let id = 0;
	return {
		db,
		task: (record: Record<string, unknown>) => { id++; db.prepare("INSERT INTO tasks VALUES (?, 1, ?, ?)").run(id, JSON.stringify(record.kind), JSON.stringify({ id, ...record })); },
		entry: (kind: string, message: unknown, conversation = 1) => { id++; db.prepare("INSERT INTO entries VALUES (?, ?, NULL, ?, ?)").run(id, conversation, id, JSON.stringify({ kind, model: [message], id })); return id; },
		ledger: (owner: number, value: unknown, kind = "base") => {
			id++; db.prepare("INSERT INTO documents VALUES (?, ?, NULL, ?)").run(id, JSON.stringify("pi.usage"), JSON.stringify({ owner }));
			db.prepare("INSERT INTO document_revisions VALUES (?, 1, ?, ?)").run(id, kind, JSON.stringify(value));
		},
	};
}
const durableResult = (ids: number[]) => ({ ...codemode(ids) });

test("separates top-level, nested, generation and response units across stores without changing WAL data", async t => {
	const f = await fixture(t);
	await writeFile(join(f.primary, "primary.jsonl"), line(assistant()) + line(codemode(["outer/read/1", "outer/bash/2"])));
	await writeFile(join(f.native, "native.jsonl"), line(assistant()) + line(codemode(["outer/read/1", "outer/bash/2"])));
	const path = join(f.durable, "storage.sqlite");
	const s = storage(t, path);
	s.task({ kind: "pi.generation", startedAt: time });
	s.task({ kind: "pi.tool", startedAt: time, input: { kind: "model" } });
	s.task({ kind: "pi.tool", startedAt: time, input: { kind: "nested" } });
	s.task({ kind: "pi.compaction", startedAt: time });
	s.entry("pi.assistant", assistant());
	s.entry("pi.tool-result", durableResult([1, 2]));
	await writeFile(path.replace(/sqlite$/u, "json"), JSON.stringify({ storageId: "storage" }));
	const before = await readFile(`${path}-wal`);
	const report = await collect(f.o);
	assert.equal(report.total.topLevelToolCalls, 3);
	assert.equal(report.total.responseToolCalls, 3);
	assert.equal(report.total.nestedCodemodeCalls, 6);
	assert.equal(report.total.nestedToolTasks, 1);
	assert.equal(report.total.generationStarts, 1);
	assert.equal(report.total.compactionStarts, 1);
	assert.equal(report.total.modelResponses, 3);
	assert.equal(report.usage.responseOnly.tokens.totalTokens, 30);
	assert.equal(report.usage.responseOnly.cost, 0.375);
	assert.equal(report.modelRequests.exactProviderAttempts, null);
	assert.equal(report.complete, true);
	assert.equal(report.continuation, null);
	assert.deepEqual(await readFile(`${path}-wal`), before);
	for (const store of report.stores) { assert.equal(store.coverage.filesRead, 1); assert.equal(store.coverage.filesUnreadable, 0); assert.deepEqual(store.coverage.capsReached, []); }
	assert.equal(report.stores[1].coverage.catalogRead, 1);
	const read = report.tools.rows.find(row => row.tool === "read");
	assert.deepEqual([read?.nestedCalls, read?.calls], [3, 0]);
	const codemodeRow = report.tools.rows.find(row => row.tool === "codemode");
	assert.deepEqual([codemodeRow?.calls, codemodeRow?.results], [3, 3]);
	assert.deepEqual(codemodeRow?.callRefs.find(ref => "sessionId" in ref), { sessionId: "storage:1", entryId: 5, at: new Date(time).toISOString() });
	assert.ok(codemodeRow?.callRefs.some(ref => "file" in ref && String(ref.file).endsWith("primary.jsonl") && ref.byte === 0 && typeof ref.entryId === "string"));
});

test("reports malformed lines, missing timestamps, window exclusions, and a trailing partial record", async t => {
	const f = await fixture(t);
	await writeFile(join(f.primary, "sample.jsonl"), `invalid\n${JSON.stringify({ type: "message", timestamp: "bad", message: assistant() })}\n${line(assistant(), time + hour)}${line(assistant())}{"type":`);
	const report = await collect({ ...f.o, filters: only(["primary"]) });
	const c = report.stores[0].coverage;
	assert.equal(report.total.modelResponses, 1);
	assert.deepEqual([c.malformedRecords, c.missingTimestamps, c.outsideWindow, c.trailingFragments, c.olderRecordStops], [1, 1, 1, 1, 0]);
});

test("bounds records, bytes, file discovery and oversized records", async t => {
	const f = await fixture(t);
	await writeFile(join(f.primary, "a.jsonl"), line(assistant()).repeat(3));
	await writeFile(join(f.primary, "b.jsonl"), line(assistant()));
	for (const [key, value] of [["records", 1], ["bytes", 4], ["files", 1], ["recordBytes", 5]] as const) {
		const report = await collect({ ...f.o, filters: only(["primary"]), limits: { ...defaults, [key]: value } });
		const c = report.stores[0].coverage;
		assert.ok(c.capsReached.includes(key), key);
		if (key === "records") assert.equal(c.recordsRead, 1);
		if (key === "bytes") assert.equal(c.bytesRead, 4);
		if (key !== "recordBytes") assert.equal(report.complete, false, key);
	}
});

test("reports unavailable stores, catalogs and corrupt SQLite without treating them as zero coverage", async t => {
	const f = await fixture(t);
	await writeFile(join(f.durable, "broken.sqlite"), "broken");
	await writeFile(join(f.durable, "header.sqlite"), "x".repeat(64));
	const journaled = join(f.durable, "journaled.sqlite");
	storage(t, journaled).entry("pi.assistant", assistant());
	await writeFile(`${journaled}-journal`, "pending rollback");
	const report = await collect({ ...f.o, filters: only(["durable"]) });
	assert.equal(report.stores[0].coverage.filesUnreadable, 3);
	assert.equal(report.stores[0].coverage.catalogUnavailable, 3);
	assert.equal(report.stores[0].sources.unreadable, 3);
	assert.equal(report.total.modelResponses, 0);
	const absent = await collect({ ...f.o, agentSessionsDir: join(f.root, "absent"), filters: only(["native"]) });
	assert.equal(absent.stores[0].coverage.storesVisited, 0);
	assert.equal(absent.stores[0].coverage.discoveryComplete, false);
	assert.equal(absent.complete, false);
});

test("missing usage is unknown and nested duplicates never increase top-level counts", async t => {
	const f = await fixture(t);
	const calls = [{ id: "a", name: "read" }, { id: "a", name: "read" }, {}];
	await writeFile(join(f.primary, "a.jsonl"), line({ role: "assistant", provider: "p", model: "m", content: [] }) +
		line(toolResult("x", "codemode", false, time, { details: { calls } })) + line(toolResult("y", "codemode")));
	const report = await collect({ ...f.o, filters: only(["primary"]) });
	assert.equal(report.usage.responseOnly.missing, 1); assert.equal(report.usage.responseOnly.records, 0);
	assert.equal(report.total.nestedCodemodeCalls, 1); assert.equal(report.total.duplicateNestedCalls, 1);
	assert.equal(report.total.malformedNestedCalls, 1); assert.equal(report.total.codemodeResultsWithoutCalls, 1);
	assert.equal(report.total.topLevelToolCalls, 0);
});

test("reaches recent evidence beyond an initial bound and skips files last modified before the window", async t => {
	const f = await fixture(t);
	const old = Array.from({ length: 50 }, (_, index) => line(assistant(time - hour - index))).reverse().join("");
	await writeFile(join(f.primary, "long.jsonl"), old + line(assistant(time + 1)));
	await writeFile(join(f.primary, "stale.jsonl"), line(assistant()));
	await utimes(join(f.primary, "stale.jsonl"), new Date(time - hour), new Date(time - hour));
	const s = storage(t, join(f.durable, "big.sqlite"));
	for (let index = 0; index < 50; index++) s.entry("pi.assistant", assistant(time - hour - index));
	s.entry("pi.assistant", assistant(time + 1));
	const report = await collect({ ...f.o, filters: only(["primary", "durable"]), limits: { ...defaults, records: 2 } });
	const [primary, durable] = report.stores;
	assert.equal(primary.units.modelResponses, 1);
	assert.equal(primary.coverage.filesBeforeWindow, 1);
	assert.equal(primary.coverage.olderRecordStops, 1);
	assert.ok(primary.coverage.recordsRead <= 2);
	assert.equal(durable.units.modelResponses, 1);
	assert.equal(durable.coverage.recordsRead, 1);
	assert.equal(durable.coverage.outsideWindow, 50);
	assert.equal(report.complete, true);
});

test("keeps response-only usage apart from other carriers and the lifetime ledger without double counting", async t => {
	const f = await fixture(t);
	await writeFile(join(f.primary, "a.jsonl"), line(assistant(time, [])) +
		entry({ type: "usage", kind: "cache_warm", provider: "p", model: "m", usage: usage(7, 0.0625) }) +
		entry({ type: "compaction", summary: "s", usage: usage(5, 0.03125) }) + entry({ type: "branch_summary", summary: "s" }) +
		line(toolResult("t", "tool", false, time, { usage: usage(3, 0.015625) })));
	const s = storage(t, join(f.durable, "store.sqlite"));
	s.entry("pi.assistant", assistant(time, []));
	s.ledger(1, { models: { "p/m": usage(40, 0.5) }, tools: { tool: usage(2, 0.02) } });
	s.ledger(2, { models: {}, tools: {} }, "delta");
	const report = await collect({ ...f.o, filters: only(["primary", "durable"]) });
	const u = report.usage;
	assert.equal(u.responseOnly.records, 2);
	assert.equal(u.responseOnly.cost, 0.25);
	assert.deepEqual(Object.keys(u.otherCarriers).sort(), ["compaction", "toolResults", "usage:cache_warm"]);
	assert.deepEqual(u.withoutUsage, { branchSummary: 1 });
	assert.equal(u.windowedRecorded.records, 5);
	assert.equal(u.windowedRecorded.cost, 0.359375);
	assert.equal(report.models.rows[0].usage.records, 2);
	assert.equal(u.ledger.storages, 1);
	assert.equal(u.ledger.models.rows[0]?.usage.cost, 0.5);
	assert.equal(u.ledger.tools.rows[0]?.key, "tool");
	assert.equal(report.stores[1].coverage.ledgerUnsupported, 1);
	const filtered = await collect({ ...f.o, filters: only(["primary"], { models: ["other/model"] }) });
	assert.equal(filtered.usage.windowedRecorded.records, 0);
	assert.equal(filtered.total.modelResponses, 0);
});

test("counts identical calls and calls after an error per session without emitting arguments", async t => {
	const f = await fixture(t);
	const args = { command: "secret-argument-text" };
	const rows = [
		line(assistant(time, [{ id: "c1", name: "bash", arguments: args }])), line(toolResult("c1", "bash", true, time + 1)),
		line(assistant(time + 2, [{ id: "c2", name: "bash", arguments: { ...args } }])), line(toolResult("c2", "bash", false, time + 3)),
		line(assistant(time + 4, [{ id: "c3", name: "bash", arguments: args }, { id: "c4", name: "read", arguments: { path: "x" } }])),
		line(toolResult("c3", "bash", false, time + 5)),
	];
	await writeFile(join(f.primary, "a.jsonl"), rows.join(""));
	await writeFile(join(f.primary, "b.jsonl"), rows.slice(0, 2).join(""));
	const report = await collect({ ...f.o, filters: only(["primary"]) });
	const r = report.repetition;
	assert.deepEqual([r.callFingerprints, r.repeatedFingerprints, r.calls, r.repeatedCalls, r.callsAfterError, r.errorResults], [3, 1, 3, 2, 2, 1]);
	assert.equal(r.callsWithoutResult, 1);
	assert.equal(r.rows[0].tool, "bash");
	assert.ok(r.rows[0].session.endsWith("a.jsonl"));
	assert.equal(r.rows[0].refs.length, 3);
	const bash = report.tools.rows.find(row => row.tool === "bash");
	assert.deepEqual([bash?.calls, bash?.results, bash?.errorResults, bash?.repeatedCalls, bash?.callsAfterError], [4, 4, 2, 2, 2]);
	assert.equal(bash?.errorRefs.length, 2);
	assert.ok(!JSON.stringify(report).includes("secret-argument-text"));
	assert.equal(fingerprint("bash", { b: 1, a: [2] }), fingerprint("bash", { a: [2], b: 1 }));
	const filtered = await collect({ ...f.o, filters: only(["primary"], { tools: ["read"] }) });
	assert.deepEqual(filtered.tools.rows.map(row => row.tool), ["read"]);
	assert.equal(filtered.repetition.calls, 0);
	const sessions = Object.fromEntries(report.sessions.rows.map(row => [row.session.split("/").at(-1), row]));
	assert.deepEqual([sessions["a.jsonl"]?.responses, sessions["a.jsonl"]?.toolCalls, sessions["a.jsonl"]?.errorResults], [3, 4, 1]);
	assert.equal(sessions["a.jsonl"]?.responseCost.cost, 0.375);
	assert.equal(sessions["a.jsonl"]?.first, new Date(time).toISOString());
	assert.equal(sessions["a.jsonl"]?.last, new Date(time + 5).toISOString());
	assert.equal(sessions["a.jsonl"]?.firstRef.byte, 0);
	assert.deepEqual([sessions["b.jsonl"]?.responses, sessions["b.jsonl"]?.errorResults], [1, 1]);
	const one = await collect({ ...f.o, filters: only(["primary"]), limits: { ...defaults, groups: 1 } });
	assert.deepEqual([one.sessions.rows.length, one.sessions.other?.sessions, one.sessions.other?.responses], [1, 1, 1]);
});

async function listing(directory: string) {
	const rows = [];
	for (const name of (await readdir(directory)).sort()) {
		const info = await lstat(join(directory, name), { bigint: true });
		rows.push([name, info.size, info.mtimeNs, info.ctimeNs]);
	}
	return rows;
}
test("reads private copies and leaves the source directory unchanged, with or without WAL companions", async t => {
	const f = await fixture(t);
	const closed = join(f.durable, "closed.sqlite");
	const quiet = storage(t, closed);
	quiet.entry("pi.assistant", assistant());
	quiet.db.close();
	const live = storage(t, join(f.durable, "live.sqlite"));
	live.entry("pi.assistant", assistant());
	await writeFile(join(f.durable, "live.json"), JSON.stringify({ storageId: "live" }));
	const names = (await readdir(f.durable)).sort();
	assert.ok(!names.includes("closed.sqlite-wal") && !names.includes("closed.sqlite-shm"));
	assert.ok(names.includes("live.sqlite-wal"));
	const before = await listing(f.durable);
	const scratch = async () => (await readdir(tmpdir())).filter(name => name.startsWith("pi-audit-activity-")).length;
	const scratchBefore = await scratch();
	const report = await collect({ ...f.o, filters: only(["durable"]) });
	assert.equal(report.total.modelResponses, 2);
	assert.equal(report.stores[0].sources.done, 2);
	assert.deepEqual(await listing(f.durable), before);
	assert.equal(await scratch(), scratchBefore);
});

test("reports a storage that changes during every copy and counts none of its records", async t => {
	const f = await fixture(t);
	const s = storage(t, join(f.durable, "busy.sqlite"));
	s.entry("pi.assistant", assistant());
	let copies = 0;
	captureHooks.afterCopy = () => { copies++; s.entry("pi.assistant", assistant()); };
	t.after(() => { captureHooks.afterCopy = undefined; });
	const busy = await collect({ ...f.o, filters: only(["durable"]) });
	assert.equal(copies, 3);
	assert.equal(busy.total.modelResponses, 0);
	assert.equal(busy.stores[0].sources.changed, 1);
	assert.equal(busy.changes.rows[0]?.change.split(";")[0], "changed during each copy");
	captureHooks.afterCopy = () => { if (copies++ === 3) s.entry("pi.assistant", assistant()); };
	const settled = await collect({ ...f.o, filters: only(["durable"]) });
	assert.equal(settled.total.modelResponses, 5);
	assert.equal(settled.changes.count, 0);
	captureHooks.afterCopy = undefined;
	const small = await collect({ ...f.o, filters: only(["durable"]), limits: { ...defaults, bytes: 1024 } });
	assert.equal(small.stores[0].sources.oversized, 1);
	assert.ok(small.stores[0].coverage.capsReached.includes("bytes"));
});

async function fullFixture(t: Parameters<typeof storage>[0] & { after: (fn: () => Promise<void>) => void }) {
	const f = await fixture(t);
	for (const name of ["a", "b", "c"]) {
		const rows = Array.from({ length: 6 }, (_, index) => [
			line(assistant(time + index * 10, [{ id: `${name}${index}`, name: index % 2 ? "bash" : "read", arguments: { n: index % 3 } }], index === 4 ? { stopReason: "error" } : {})),
			line(toolResult(`${name}${index}`, index % 2 ? "bash" : "read", index === 1, time + index * 10 + 1)),
		].join("")).join("");
		await writeFile(join(name === "c" ? f.native : f.primary, `${name}.jsonl`), rows + entry({ type: "usage", kind: "cache_warm", provider: "p", model: "m", usage: usage(1, 0.0078125) }, time + 100));
	}
	const s = storage(t, join(f.durable, "store.sqlite"));
	for (let index = 0; index < 6; index++) {
		s.task({ kind: "pi.tool", startedAt: time + index, input: { kind: "model" } });
		s.entry("pi.assistant", assistant(time + index, [{ id: `d${index}`, name: "read", arguments: { n: 1 } }]), 1 + (index % 2));
		s.entry("pi.tool-result", toolResult(`d${index}`, "read", index === 0, time + index), 1 + (index % 2));
	}
	s.ledger(1, { models: { "p/m": usage(40, 0.5) }, tools: {} });
	return { f, s };
}
const comparable = (report: Awaited<ReturnType<typeof collect>>) => ({ total: report.total, sessions: report.sessions, tools: report.tools, models: report.models, usage: report.usage, repetition: report.repetition,
	stores: report.stores.map(store => ({ units: store.units, records: store.coverage.recordsRead, outside: store.coverage.outsideWindow, sources: store.sources })) });

test("a resumed collection equals one complete pass", async t => {
	const { f } = await fullFixture(t);
	const single = await collect(f.o);
	assert.equal(single.continuation, null);
	let report = await collect({ ...f.o, limits: { ...defaults, records: 3 } });
	const output = join(f.root, "previous.json");
	let runs = 1;
	while (report.continuation !== null) {
		assert.ok(runs++ < 50, "resumption makes progress");
		assert.equal(report.complete, false);
		await writeFile(output, JSON.stringify(report));
		report = await collect({ ...parseArgs(["--resume", output, "--records", "3"]) });
	}
	assert.ok(runs > 3);
	assert.deepEqual(comparable(report), comparable(single));
	assert.equal(report.changes.count, 0);
	assert.equal(report.complete, true);
});

test("reports sources changed between runs instead of counting them twice", async t => {
	const { f, s } = await fullFixture(t);
	const output = join(f.root, "previous.json");
	const first = await collect({ ...f.o, filters: only(["primary", "durable"]), limits: { ...defaults, records: 14 } });
	assert.notEqual(first.continuation, null);
	const state = decode(first.continuation ?? "");
	const [done, partial] = state.stores[0].sources;
	assert.deepEqual([done.status, partial.status], ["done", "partial"]);
	await appendFile(done.path, line(assistant(time + 200, [])));
	await appendFile(partial.path, line(assistant(time + 300, [])));
	s.entry("pi.assistant", assistant(time + 400, []));
	await writeFile(output, JSON.stringify(first));
	let report = await collect(parseArgs(["--resume", output]));
	while (report.continuation !== null) { await writeFile(output, JSON.stringify(report)); report = await collect(parseArgs(["--resume", output])); }
	const fresh = await collect({ ...f.o, filters: only(["primary", "durable"]) });
	assert.equal(fresh.total.modelResponses - report.total.modelResponses, 3);
	assert.deepEqual(report.changes.rows.map(row => row.change.split(";")[0]).sort(), ["appended after its snapshot", "modified after it was read", "rows added after its snapshot"]);
	assert.equal(report.changes.count, 3);
});

test("requires explicit zoned windows, finite positive bounds, known filters and a bound continuation", () => {
	const args = ["--from", "2026-10-20T00:00:00Z", "--to", "2026-10-21T00:00:00Z"];
	assert.equal(parseArgs(args).from, Date.parse(args[1]));
	const filtered = parseArgs([...args, "--store", "durable,native", "--tool", "bash,read", "--model", "p/m", "--source", "a.jsonl"]);
	assert.deepEqual(filtered.filters?.stores, ["durable", "native"]);
	assert.deepEqual(filtered.filters?.tools, ["bash", "read"]);
	assert.ok(filtered.filters?.sources[0].endsWith("a.jsonl"));
	for (const extra of [["--bytes", "Infinity"], ["--files", "0"], ["--unknown", "1"], ["--from", args[1]], ["--store", "other"], ["--source", "a.txt"]]) assert.throws(() => parseArgs([...args, ...extra]));
	assert.throws(() => parseArgs([]));
	assert.throws(() => parseArgs(["--from", "2026-10-20", "--to", "2026-10-21"]));
	assert.throws(() => parseArgs(["--resume", "x.json", "--tool", "bash"]));
	assert.equal(parseArgs(["--resume", "x.json", "--records", "5"]).limits.records, 5);
});
