import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { collect, collectStore, countMessage, defaults, parseArgs, units, type Options } from "./activity.mts";

const time = Date.parse("2026-10-20T12:00:00Z");
const assistant = { role: "assistant", timestamp: time, content: [{ type: "toolCall", name: "codemode", id: "outer" }], usage: { input: 5, output: 3, cacheRead: 2, cacheWrite: 0, reasoning: 1, totalTokens: 10, cost: { total: 0.1 } } };
const result = { role: "toolResult", toolName: "codemode", timestamp: time, details: { calls: [{ id: 1, name: "read" }, { id: 2, name: "bash" }] } };
const ordinaryResult = { ...result, details: { calls: result.details.calls.map(call => ({ ...call, id: `outer/read/${call.id}` })) } };
const line = (message: unknown, timestamp = new Date(time).toISOString()) => `${JSON.stringify({ type: "message", timestamp, message })}\n`;
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const root = await mkdtemp(join(tmpdir(), "audit-activity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const o: Options = { agentDir: root, agentSessionsDir: join(root, "agent-sessions"), from: time, to: time + 1, limits: { ...defaults } };
	await mkdir(join(root, "sessions", "project"), { recursive: true });
	await mkdir(join(o.agentSessionsDir, "native"), { recursive: true });
	await mkdir(join(o.agentSessionsDir, "durable"), { recursive: true });
	return o;
}
test("separates top-level, nested, generation and response units across stores without changing WAL data", async t => {
	const o = await fixture(t);
	await writeFile(join(o.agentDir, "sessions", "project", "primary.jsonl"), line(assistant) + line(ordinaryResult));
	await writeFile(join(o.agentSessionsDir, "native", "native.jsonl"), line(assistant) + line(ordinaryResult));
	const path = join(o.agentSessionsDir, "durable", "storage.sqlite");
	const db = new DatabaseSync(path);
	t.after(() => db.close());
	db.exec("PRAGMA journal_mode=WAL; CREATE TABLE tasks(id INTEGER PRIMARY KEY,record TEXT); CREATE TABLE entries(id INTEGER PRIMARY KEY,record TEXT)");
	const insert = db.prepare("INSERT INTO tasks VALUES (?,?)");
	insert.run(1, JSON.stringify({ kind: "pi.generation", startedAt: time }));
	insert.run(2, JSON.stringify({ kind: "pi.tool", startedAt: time, input: { kind: "model" } }));
	insert.run(3, JSON.stringify({ kind: "pi.tool", startedAt: time, input: { kind: "nested" } }));
	db.prepare("INSERT INTO entries VALUES (?,?)").run(4, JSON.stringify({ kind: "pi.assistant", model: [assistant] }));
	db.prepare("INSERT INTO entries VALUES (?,?)").run(5, JSON.stringify({ kind: "pi.tool-result", model: [result] }));
	await writeFile(path.replace(/sqlite$/u, "json"), JSON.stringify({ storageId: "storage" }));
	const before = await readFile(`${path}-wal`);
	const report = await collect(o);
	assert.equal(report.total.topLevelToolCalls, 3);
	assert.equal(report.total.nestedCodemodeCalls, 6);
	assert.equal(report.total.nestedToolTasks, 1);
	assert.equal(report.total.generationStarts, 1);
	assert.equal(report.total.modelResponses, 3);
	assert.equal(report.total.tokens.totalTokens, 30);
	assert.ok(Math.abs(report.total.recordedCost - 0.3) < 1e-10);
	assert.equal(report.modelRequests.exactProviderAttempts, null);
	assert.deepEqual(await readFile(`${path}-wal`), before);
	for (const store of report.stores) { assert.equal(store.coverage.filesRead, 1); assert.equal(store.coverage.filesUnreadable, 0); assert.deepEqual(store.coverage.capsReached, []); }
	assert.equal(report.stores[1].coverage.catalogRead, 1);
});
test("reports malformed lines, missing timestamps, window exclusions, and trailing partial records", async t => {
	const o = await fixture(t);
	await writeFile(join(o.agentDir, "sessions", "sample.jsonl"), `invalid\n${line(assistant, "bad")}${line(assistant, new Date(time + 1).toISOString())}${line(assistant)}{"type":`);
	const report = await collectStore(join(o.agentDir, "sessions"), "primary", o);
	assert.equal(report.units.modelResponses, 1);
	assert.equal(report.coverage.malformedRecords, 1);
	assert.equal(report.coverage.missingTimestamps, 1);
	assert.equal(report.coverage.outsideWindow, 1);
	assert.equal(report.coverage.trailingFragments, 1);
	assert.equal(report.coverage.partialFiles, 1);
});
test("bounds records, bytes, file discovery and oversized records", async t => {
	const o = await fixture(t);
	await writeFile(join(o.agentDir, "sessions", "a.jsonl"), line(assistant).repeat(3));
	await writeFile(join(o.agentDir, "sessions", "b.jsonl"), line(assistant));
	for (const [key, value] of [["records", 1], ["bytes", 4], ["files", 1], ["recordBytes", 5]] as const) {
		const report = await collectStore(join(o.agentDir, "sessions"), "primary", { ...o, limits: { ...defaults, [key]: value } });
		assert.ok(report.coverage.capsReached.includes(key), key);
		if (key === "records") assert.equal(report.coverage.recordsRead, 1);
		if (key === "bytes") assert.equal(report.coverage.bytesRead, 4);
	}
});
test("reports unavailable stores, catalogs and corrupt SQLite without treating them as zero coverage", async t => {
	const o = await fixture(t);
	await writeFile(join(o.agentSessionsDir, "durable", "broken.sqlite"), "broken");
	const report = await collectStore(join(o.agentSessionsDir, "durable"), "durable", o);
	assert.equal(report.coverage.filesUnreadable, 1);
	assert.equal(report.coverage.catalogUnavailable, 1);
	const absent = await collectStore(join(o.agentDir, "absent"), "native", o);
	assert.equal(absent.coverage.storesVisited, 0);
	assert.equal(absent.coverage.discoveryComplete, false);
});
test("missing usage is unknown and nested duplicates never increase top-level counts", () => {
	const u = units();
	countMessage({ role: "assistant", content: [] }, u, false);
	countMessage({ ...result, details: { calls: [{ id: "a", name: "read" }, { id: "a", name: "read" }, {}] } }, u, false);
	countMessage({ ...result, details: {} }, u, false);
	assert.equal(u.missingUsage, 1); assert.equal(u.missingCost, 1);
	assert.equal(u.nestedCodemodeCalls, 1); assert.equal(u.duplicateNestedCalls, 1);
	assert.equal(u.malformedNestedCalls, 1); assert.equal(u.codemodeResultsWithoutCalls, 1);
	assert.equal(u.topLevelToolCalls, 0);
});
test("requires explicit zoned windows and finite positive bounds", () => {
	const args = ["--from", "2026-10-20T00:00:00Z", "--to", "2026-10-21T00:00:00Z"];
	assert.equal(parseArgs(args).from, Date.parse(args[1]));
	for (const extra of [["--bytes", "Infinity"], ["--files", "0"], ["--unknown", "1"], ["--from", args[1]]]) assert.throws(() => parseArgs([...args, ...extra]));
	assert.throws(() => parseArgs([]));
	assert.throws(() => parseArgs(["--from", "2026-10-20", "--to", "2026-10-21"]));
});
