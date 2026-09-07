import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { lookup, type LookupRequest, type LookupResult } from "./lookup.ts";
import { decodeCursor } from "./query.ts";
import type { HostSnapshot } from "./records.ts";
import { SCAN_MAX_BYTES } from "./scan.ts";

const source = (path: string) => ({ path, source: "fixture", scope: "temporary" as const, origin: "top-level" as const, baseDir: "/fixtures" });
function snapshot(commands: HostSnapshot["commands"] = []): HostSnapshot {
	return { tools: [{ name: "tool", sourceInfo: source("/fixtures/extension.ts") }], activeTools: [], commands,
		observation: null, availability: { tools: true, activeTools: true, commands: true }, at: 1000 };
}
const request = (over: Partial<LookupRequest> = {}): LookupRequest => ({ params: {}, snapshot: snapshot(), session: { cwd: "/fixtures", mode: "rpc" }, epoch: "session", ...over });
const cursor = (result: LookupResult) => { assert.equal(typeof result.details.cursor, "string"); return result.details.cursor as string; };
let dir = "";
before(async () => { dir = await mkdtemp(join(tmpdir(), "registry-lookup-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

describe("lookup outcomes", () => {
	it("returns an explicit no-argument host summary without scanning", async () => {
		const result = await lookup(request({ scan: async () => { throw new Error("unexpected scan"); } }));
		assert.equal(result.outcome, "host_summary");
		assert.match(result.text, /not_yet_observed/);
		assert.match(result.text, /BOUNDARIES/);
		assert.match(result.text, /mode: rpc/);
	});
	it("keeps missing, unavailable and cancelled distinct", async () => {
		assert.equal((await lookup(request({ params: { name: "absent" } }))).outcome, "missing");
		const host = snapshot(); host.availability.commands = false;
		assert.equal((await lookup(request({ params: { name: "absent" }, snapshot: host }))).outcome, "unavailable");
		assert.equal((await lookup(request({ params: { name: "tool", kind: "tool" }, snapshot: host }))).outcome, "ok");
		assert.equal((await lookup(request({ signal: AbortSignal.abort() }))).outcome, "cancelled");
	});
	it("returns bounded invalid argument outcomes", async () => {
		for (const params of [{ name: "" }, { limit: 101 }, { cursor: "x" }, { cursor: "x", kind: "tool" }, { path: "/arbitrary" }]) {
			const result = await lookup(request({ params }));
			assert.equal(result.outcome, "invalid_arguments");
			assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
		}
	});
	it("reports every source field, evidence time, and configured versus active status", async () => {
		const result = await lookup(request({ params: { name: "tool" } }));
		const records = result.details.records as Record<string, unknown>[];
		assert.deepEqual(records[0].sourceInfo, source("/fixtures/extension.ts"));
		assert.equal(records[0].at, 1000);
		assert.equal(records[0].evidence, "registration");
		assert.equal(records[0].configured, true);
		assert.equal(records[0].active, false);
	});
	it("reports synthetic sources as unavailable instead of missing", async () => {
		const host = snapshot([{ name: "skill:example", source: "skill", sourceInfo: source("<sdk>") }]);
		assert.equal((await lookup(request({ params: { name: "example", contains: "needle" }, snapshot: host }))).outcome, "unavailable");
	});
});

describe("registration pages", () => {
	it("resumes cursor-only pages and invalidates session or source changes", async () => {
		const host = snapshot(Array.from({ length: 5 }, (_, i) => ({ name: `command-${i}`, source: "extension" as const, sourceInfo: source(`/fixtures/${i}.ts`) })));
		const first = await lookup(request({ params: { kind: "command", limit: 2 }, snapshot: host }));
		const next = await lookup(request({ params: { cursor: cursor(first) }, snapshot: host }));
		assert.equal(next.details.offset, 2);
		assert.deepEqual((next.details.records as { name: string }[]).map((r) => r.name), ["command-2", "command-3"]);
		assert.equal((await lookup(request({ params: { cursor: cursor(first) }, snapshot: host, epoch: "new-session" }))).outcome, "stale_cursor");
		host.commands[0].sourceInfo.path = "/fixtures/changed.ts";
		assert.equal((await lookup(request({ params: { cursor: cursor(first) }, snapshot: host }))).outcome, "stale_cursor");
	});
	it("does not skip records when full-envelope bounds reduce a page", async () => {
		const host = snapshot(Array.from({ length: 100 }, (_, i) => ({ name: `command-${String(i).padStart(3, "0")}`, source: "extension" as const, sourceInfo: source(`/fixtures/${"x".repeat(2000)}${i}`) })));
		let result = await lookup(request({ params: { kind: "command", limit: 100 }, snapshot: host }));
		const names: string[] = [];
		assert.equal(result.details.resultBounded, true);
		for (let page = 0; page < 100; page += 1) {
			const returned = result.details.records as { name: string }[];
			assert.equal(result.details.returnedRecords, returned.length);
			assert.ok(result.text.includes(`records: ${returned.length} shown of 100 matched | offset ${names.length} | limit 100`));
			names.push(...returned.map((r) => r.name));
			if (result.details.cursor === undefined) break;
			assert.equal(decodeCursor(cursor(result)).offset, names.length);
			result = await lookup(request({ params: { cursor: cursor(result) }, snapshot: host }));
		}
		assert.equal(names.length, 100);
		assert.equal(new Set(names).size, 100);
	});
});

describe("incomplete inventories", () => {
	const threeDocs = (padding = 0): HostSnapshot => ({ tools: ["alpha", "beta", "gamma"].map((name) => ({
		name, description: "reads documents",
		sourceInfo: source(`/fixtures/${"x".repeat(padding)}${name}.ts`),
	})), activeTools: [], commands: [], observation: null,
		availability: { tools: true, activeTools: true, commands: false }, at: 1000 });
	it("reports shown of known matches and incomplete inventory without a cursor", async () => {
		const result = await lookup(request({ params: { search: "documents", limit: 2 }, snapshot: threeDocs() }));
		assert.equal(result.outcome, "unavailable");
		assert.equal(result.details.total, 3);
		assert.equal(result.details.incompleteInventory, true);
		assert.equal(result.details.returnedRecords, 2);
		assert.deepEqual((result.details.records as { name: string }[]).map((r) => r.name), ["alpha", "beta"]);
		assert.ok(result.text.includes("records: 2 shown of 3 known matches | limit 2 (inventory incomplete)"));
		assert.match(result.text, /no continuation/);
		assert.match(result.text, /query an available resource kind/);
		assert.equal(result.details.cursor, undefined);
		assert.doesNotMatch(result.text, /pass cursor=/);
	});
	it("keeps the shown count aligned with returned records when bounds drop blocks", async () => {
		const result = await lookup(request({ params: { search: "documents", limit: 100 }, snapshot: threeDocs(20000) }));
		assert.equal(result.outcome, "unavailable");
		assert.equal(result.details.resultBounded, true);
		assert.equal(result.details.total, 3);
		assert.equal(result.details.incompleteInventory, true);
		const returned = result.details.returnedRecords as number;
		assert.ok(returned > 0 && returned < 3, `expected a reduced page, got ${returned}`);
		assert.equal((result.details.records as unknown[]).length, returned);
		assert.ok(result.text.includes(`records: ${returned} shown of 3 known matches | limit 100 (inventory incomplete)`));
		assert.equal(result.details.cursor, undefined);
		assert.doesNotMatch(result.text, /pass cursor=/);
	});
});

describe("file-backed lookup", () => {
	it("requires a unique file-backed match and bounds ambiguous pages", async () => {
		const host = snapshot(Array.from({ length: 5 }, (_, i) => ({ name: `skill:example-${i}`, source: "skill" as const, sourceInfo: source(`/fixtures/${i}/SKILL.md`) })));
		const result = await lookup(request({ params: { kind: "skill", contains: "needle", limit: 2 }, snapshot: host,
			scan: async () => { throw new Error("ambiguous queries must not scan"); } }));
		assert.equal(result.outcome, "ambiguous");
		assert.equal((result.details.records as unknown[]).length, 2);
		assert.equal(decodeCursor(cursor(result)).offset, 2);
	});
	it("finds literal content with context in one call and invalidates affected-file continuation", async () => {
		const path = join(dir, "content.md");
		await writeFile(path, "---\ndisable-model-invocation: true\n---\nBefore\nMemory instruction\nMEMORY second\nAfter\n");
		const host = snapshot([{ name: "skill:example", source: "skill", sourceInfo: source(path) }]);
		const first = await lookup(request({ params: { name: "example", contains: "memory", limit: 1 }, snapshot: host }));
		assert.equal(first.outcome, "ok");
		assert.match(first.text, /Before/);
		assert.match(first.text, /Memory instruction/);
		assert.equal((first.details.modelInvocable as { value: boolean }).value, false);
		const second = await lookup(request({ params: { cursor: cursor(first) }, snapshot: host }));
		assert.equal(second.outcome, "ok");
		assert.match(second.text, /MEMORY second/);
		const stamp = decodeCursor(cursor(first)).file!;
		await writeFile(path, "---\ndisable-model-invocation: true\n---\nBefore\nmemory instruction\nMEMORY second\nAfter\n");
		await utimes(path, new Date(), stamp.mtimeMs / 1000);
		assert.equal((await lookup(request({ params: { cursor: cursor(first) }, snapshot: host }))).outcome, "stale_cursor");
		await rm(path);
		assert.equal((await lookup(request({ params: { cursor: cursor(first) }, snapshot: host }))).outcome, "stale_cursor");
	});
	it("reports only retained content matches after result bounds reduce a page", async () => {
		const path = join(dir, "many-matches.md");
		await writeFile(path, `${`needle ${"x".repeat(2000)}\n`.repeat(100)}`);
		const host = snapshot([{ name: "skill:example", source: "skill", sourceInfo: source(path) }]);
		let result = await lookup(request({ params: { name: "example", contains: "needle", limit: 100 }, snapshot: host }));
		assert.equal(result.details.resultBounded, true);
		const lines: number[] = [];
		for (let page = 0; page < 100; page += 1) {
			const returned = result.details.records as { line: number }[];
			assert.equal(result.details.returnedRecords, returned.length);
			assert.ok(result.text.includes(`matches: ${returned.length} shown of 100 found | offset ${lines.length} | limit 100`));
			lines.push(...returned.map((match) => match.line));
			if (result.details.cursor === undefined) break;
			assert.equal(decodeCursor(cursor(result)).offset, lines.length);
			result = await lookup(request({ params: { cursor: cursor(result) }, snapshot: host }));
		}
		assert.deepEqual(lines, Array.from({ length: 100 }, (_, i) => i + 1));
	});
	it("reports partial, missing, invalid metadata, I/O failure, and cancellation separately", async () => {
		const path = join(dir, "outcomes.md");
		const host = snapshot([{ name: "skill:example", source: "skill", sourceInfo: source(path) }]);
		const run = () => lookup(request({ params: { contains: "needle" }, snapshot: host }));
		assert.equal((await run()).outcome, "io_error");
		await writeFile(path, `${"x".repeat(SCAN_MAX_BYTES + 10)}needle`);
		assert.equal((await run()).outcome, "partial");
		await writeFile(path, "no match");
		assert.equal((await run()).outcome, "missing");
		await writeFile(path, "---\ninvalid: [\n---");
		assert.equal((await run()).outcome, "unavailable");
		const cancelled = await lookup(request({ params: { contains: "needle" }, snapshot: host,
			scan: async () => ({ outcome: "cancelled", matches: [], bytesRead: 0, fileSize: 0, truncated: false }) }));
		assert.equal(cancelled.outcome, "cancelled");
	});
});
