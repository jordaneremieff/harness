import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { Value } from "typebox/value";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PrimaryInfo } from "./primary-channel.ts";
import { formatPrimaryObservation, OrdinaryPrimaryObservationSchema, PRIMARY_OBSERVATION_LIMITS as limits, readPrimaryObservation } from "./primary-observation.ts";

const at = "2026-10-05T12:00:00.000Z";
const entryId = (n: number) => n.toString(16).padStart(8, "0");
function message(n: number, parent: number | null, role = "assistant", content: unknown = [{ type: "text", text: `action ${n}` }], extra: Record<string, unknown> = {}) {
	const blocks = role === "assistant" && typeof content === "string" ? [{ type: "text", text: content }] : content;
	return { type: "message", id: entryId(n), parentId: parent === null ? null : entryId(parent), timestamp: at, message: { role, content: blocks, timestamp: 1791201600000, ...(role === "assistant" ? { stopReason: "stop" } : {}), ...(role === "toolResult" ? { toolName: "test", toolCallId: "call", isError: false } : {}), ...extra } };
}
function fixture(t: TestContext, rows: unknown[] = []) {
	const root = mkdtempSync(join(tmpdir(), "primary-observation-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	const primary: PrimaryInfo & { sessionFile?: string } = { id: randomUUID(), cwd: "/work/topic", name: "Topic", model: { provider: "test", modelId: "test-model" }, hostname: hostname(), pid: process.pid, socketPath: join(root, "absent.sock"), startedAt: at, sessionFile };
	const header = { type: "session", version: 3, id: primary.id, timestamp: at, cwd: primary.cwd };
	const write = (entries: unknown[]) => writeFileSync(sessionFile, `${[header, ...entries].map(value => JSON.stringify(value)).join("\n")}\n`);
	write(rows);
	return { root, sessionFile, primary, header, write };
}
it("returns factual status, newest retained action, and explicit live-only unknowns without writes", async t => {
	const f = fixture(t, [message(1, null, "user", "please inspect"), message(2, 1)]);
	const before = readFileSync(f.sessionFile);
	const result = await readPrimaryObservation(f.primary, {});
	assert.equal(Value.Check(OrdinaryPrimaryObservationSchema, result), true);
	assert.equal(result.presence.process.state, "live");
	assert.equal(result.presence.process.attribution, "process-existence-not-session-progress");
	assert.equal(result.source.latestKnown, true);
	assert.equal(result.source.head?.id, entryId(2));
	assert.deepEqual(result.entries.map(e => e.id), [entryId(2), entryId(1)]);
	assert.equal(result.coverage.complete, true);
	assert.equal(result.unknown.selectedLeaf, "unknown");
	assert.equal(result.unknown.tasks, "unknown");
	assert.deepEqual(readFileSync(f.sessionFile), before);
	assert.match(formatPrimaryObservation(result), /action 2/u);
	assert.match(formatPrimaryObservation(result), /not the live selected branch/u);
});
it("retains tool names and recorded error text but excludes arguments, thinking, signatures, images, and details", async t => {
	const f = fixture(t, [message(1, null, "assistant", [
		{ type: "thinking", thinking: "HIDDEN_THINKING", signature: "HIDDEN_SIGNATURE" },
		{ type: "image", data: "HIDDEN_IMAGE" }, { type: "toolCall", name: "read", arguments: { path: "HIDDEN_ARGS" } },
		{ type: "text", text: "read failed" },
	], { stopReason: "error", errorMessage: "file unavailable", details: "HIDDEN_DETAILS" }), message(2, 1, "toolResult", [{ type: "text", text: "not found" }], { toolName: "read", isError: true })]);
	const result = await readPrimaryObservation(f.primary, { view: "activity" });
	assert.equal(result.entries[0]?.isError, true);
	assert.deepEqual(result.entries[0]?.toolNames, ["read"]);
	assert.equal(result.entries[1]?.error, "file unavailable");
	assert.deepEqual(result.entries[1]?.toolNames, ["read"]);
	assert.doesNotMatch(JSON.stringify(result), /HIDDEN_/u);
	assert.match(formatPrimaryObservation(result), /ERROR/u);
});
it("follows only the final entry parent ancestry and excludes the other retained branch", async t => {
	const f = fixture(t, [message(1, null), message(2, 1, "assistant", "other branch"), message(3, 1, "assistant", "latest branch")]);
	const result = await readPrimaryObservation(f.primary, { view: "history" });
	assert.deepEqual(result.entries.map(e => e.id), [entryId(3), entryId(1)]);
	assert.doesNotMatch(JSON.stringify(result), /other branch/u);
});
it("returns pinned continuation and refuses append, replacement, mtime, and malformed cursors", async t => {
	const f = fixture(t, [message(1, null), message(2, 1), message(3, 2)]);
	const first = await readPrimaryObservation(f.primary, { view: "history", limit: 1 });
	assert.ok(first.nextCursor);
	const second = await readPrimaryObservation(f.primary, { view: "history", limit: 1, cursor: first.nextCursor });
	assert.deepEqual(second.entries.map(e => e.id), [entryId(2)]);
	assert.equal(Value.Check(OrdinaryPrimaryObservationSchema, second), true);
	for (const bad of [null, {}, { ...first.nextCursor, extra: true }, { ...first.nextCursor, nextId: "bad" }, { ...first.nextCursor, pin: { ...first.nextCursor.pin, size: -1 } }]) {
		const refused = await readPrimaryObservation(f.primary, { view: "history", cursor: bad });
		assert.deepEqual(refused.coverage.reasons, ["invalid-cursor"]);
		assert.equal(refused.coverage.bytesRead, 0);
	}
	appendFileSync(f.sessionFile, `${JSON.stringify(message(4, 3))}\n`);
	assert.ok((await readPrimaryObservation(f.primary, { view: "history", cursor: first.nextCursor })).coverage.reasons.includes("source-changed"));
	f.write([message(1, null), message(2, 1), message(3, 2)]);
	const fresh = await readPrimaryObservation(f.primary, { view: "history", limit: 1 });
	renameSync(f.sessionFile, join(f.root, "old.jsonl"));
	f.write([message(1, null), message(2, 1), message(3, 2)]);
	const replaced = await readPrimaryObservation(f.primary, { view: "history", cursor: fresh.nextCursor });
	assert.ok(replaced.coverage.reasons.includes("source-changed"));
	assert.equal(replaced.entries.length, 0);
});
it("refuses a cursor from another source, view, head, or ancestry", async t => {
	const f = fixture(t, [message(1, null), message(2, 1), message(3, 1)]);
	const first = await readPrimaryObservation(f.primary, { view: "activity", limit: 1 });
	assert.ok(first.nextCursor);
	assert.ok((await readPrimaryObservation(f.primary, { view: "history", cursor: first.nextCursor })).coverage.reasons.includes("cursor-source-mismatch"));
	const offBranch = await readPrimaryObservation(f.primary, { view: "activity", cursor: { ...first.nextCursor, nextId: entryId(2) } });
	assert.equal(offBranch.entries.length, 0);
	assert.ok(offBranch.coverage.reasons.includes("invalid-cursor-ancestry"));
	assert.ok((await readPrimaryObservation(f.primary, { view: "activity", cursor: { ...first.nextCursor, headId: entryId(2) } })).coverage.reasons.includes("source-changed"));
});
it("marks unknown parents and invalid forward parents instead of inventing ancestry", async t => {
	const f = fixture(t, [message(1, 9)]);
	const missing = await readPrimaryObservation(f.primary);
	assert.ok(missing.coverage.reasons.includes("unknown-parent"));
	f.write([message(1, null), message(2, 3), message(3, 2)]);
	assert.ok((await readPrimaryObservation(f.primary)).coverage.reasons.includes("invalid-parent-order"));
});
it("refuses mismatched, legacy, malformed, partial, and oversized headers", async t => {
	const f = fixture(t);
	for (const header of [{ ...f.header, id: randomUUID() }, { ...f.header, version: 2 }, { ...f.header, timestamp: "bad" }]) {
		writeFileSync(f.sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(message(1, null))}\n`);
		assert.ok((await readPrimaryObservation(f.primary)).coverage.reasons.includes("invalid-header-or-identity"));
	}
	for (const value of ["{bad}\n", JSON.stringify(f.header), `${JSON.stringify({ ...f.header, cwd: "x".repeat(limits.headerBytes) })}\n`]) {
		writeFileSync(f.sessionFile, value);
		assert.equal((await readPrimaryObservation(f.primary)).entries.length, 0);
	}
});
it("never labels an older record latest after malformed, partial, oversized, or unknown final records", async t => {
	const f = fixture(t);
	for (const tail of ["{bad}\n", "{partial", `${JSON.stringify(message(2, 1, "assistant", "x".repeat(limits.lineBytes)))}\n`, `${JSON.stringify({ ...message(2, 1), type: "future-kind" })}\n`]) {
		f.write([message(1, null)]); appendFileSync(f.sessionFile, tail);
		const result = await readPrimaryObservation(f.primary);
		assert.equal(result.source.latestKnown, false);
		assert.equal(result.source.head, undefined);
		assert.equal(result.entries.length, 0);
		assert.equal(result.coverage.complete, false);
	}
});
it("reports corrupt older records and duplicate IDs without hiding the coverage gap", async t => {
	const f = fixture(t);
	writeFileSync(f.sessionFile, `${JSON.stringify(f.header)}\n{bad}\n${JSON.stringify(message(2, 1))}\n`);
	const corrupt = await readPrimaryObservation(f.primary);
	assert.ok(corrupt.coverage.reasons.includes("malformed-record"));
	assert.ok(corrupt.coverage.reasons.includes("unknown-parent"));
	f.write([message(1, null), message(1, null)]);
	const duplicate = await readPrimaryObservation(f.primary);
	assert.ok(duplicate.coverage.reasons.includes("duplicate-entry-id"));
	assert.equal(duplicate.source.latestKnown, false);
});
it("omits recognizable credentials and preserves normal prose and UUIDs with value-free counts", async t => {
	const uuid = randomUUID();
	const token = `sk-${"aB3x".repeat(10)}`;
	const bearer = `Bearer ${"z9A1".repeat(8)}`;
	const prose = `The token budget is 30. The password prompt stays unchanged. Request ${uuid}.`;
	const f = fixture(t, [message(1, null, "user", `${prose} ${token} ${bearer}`)]);
	const result = await readPrimaryObservation(f.primary);
	assert.ok(result.entries[0]?.text?.includes(prose));
	assert.equal(result.coverage.omissions.credentials, 2);
	assert.doesNotMatch(JSON.stringify(result), new RegExp(token, "u"));
	assert.doesNotMatch(JSON.stringify(result), new RegExp(bearer, "u"));
	assert.match(formatPrimaryObservation(result), /credentials=2/u);
});
it("projects context edits, compaction, and system messages as kinds and locators only", async t => {
	const f = fixture(t, [
		message(1, null, "system", "HIDDEN_PROMPT"),
		{ type: "compaction", id: entryId(2), parentId: entryId(1), timestamp: at, summary: "HIDDEN_SUMMARY", tokensBefore: 50000, firstKeptEntryId: entryId(1), systemMessage: "HIDDEN_SYSTEM" },
		{ type: "context_edit", id: entryId(3), parentId: entryId(2), timestamp: at, targetId: entryId(1), replacement: { content: "HIDDEN_REPLACEMENT" } },
	]);
	const result = await readPrimaryObservation(f.primary, { view: "history" });
	assert.equal(result.entries[0]?.targetId, entryId(1));
	assert.equal(result.entries[1]?.firstKeptEntryId, entryId(1));
	assert.doesNotMatch(JSON.stringify(result), /HIDDEN_/u);
});
it("bounds bytes, lines, parent visits, items, scan, and serialized output independently", async t => {
	const f = fixture(t, Array.from({ length: 300 }, (_, i) => message(i + 1, i === 0 ? null : i, "assistant", "🙂".repeat(1000))));
	const result = await readPrimaryObservation(f.primary, { view: "history", limit: 10000 });
	assert.ok(result.coverage.bytesRead <= limits.bytes + limits.headerBytes);
	assert.ok(result.entries.length <= limits.items);
	assert.ok(result.coverage.textScanBytes <= limits.textScanBytes);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= limits.outputBytes);
	assert.ok(result.coverage.reasons.includes("byte-budget"));
	assert.ok(result.coverage.reasons.includes("item-budget"));
	for (const e of result.entries) if (e.text) {
		assert.ok(Buffer.byteLength(e.text) <= limits.textBytes);
		assert.equal(e.text, Buffer.from(e.text).toString("utf8"));
	}
	f.write(Array.from({ length: limits.lines + 20 }, (_, i) => message(i + 1, i === 0 ? null : i, "system", "")));
	const lines = await readPrimaryObservation(f.primary);
	assert.equal(lines.coverage.linesVisited, limits.lines);
	assert.ok(lines.coverage.reasons.includes("line-budget"));
	const one = await readPrimaryObservation(f.primary, { limit: 1 });
	assert.ok(one.nextCursor);
	const deep = await readPrimaryObservation(f.primary, { cursor: { ...one.nextCursor, nextId: entryId(1) } });
	assert.equal(deep.coverage.parentVisits, limits.parentVisits);
	assert.ok(deep.coverage.reasons.includes("parent-visit-budget"));
});
it("omits an oversized text slot intact rather than leaking a clipped credential", async t => {
	const f = fixture(t, [message(1, null, "assistant", `prose ${"x".repeat(limits.textScanBytes)}sk-${"a9B1".repeat(8)}`)]);
	const result = await readPrimaryObservation(f.primary);
	assert.equal(result.entries[0]?.text, undefined);
	assert.ok(result.coverage.omissions.fields > 0);
	assert.ok(result.coverage.reasons.includes("text-scan-budget"));
});
it("bounds content slots even when hidden blocks dominate the message", async t => {
	const f = fixture(t, [message(1, null, "assistant", Array.from({ length: 150 }, () => ({ type: "thinking", thinking: "hidden" })))]);
	assert.ok((await readPrimaryObservation(f.primary)).coverage.reasons.includes("text-slot-budget"));
});
it("returns explicit absence and regular-file refusal without contacting a socket or creating a store", async t => {
	const f = fixture(t);
	assert.deepEqual((await readPrimaryObservation({ ...f.primary, sessionFile: undefined })).coverage.reasons, ["no-session-file"]);
	assert.ok((await readPrimaryObservation({ ...f.primary, sessionFile: join(f.root, "missing.jsonl") })).coverage.reasons.includes("session-file-unavailable"));
	assert.ok((await readPrimaryObservation({ ...f.primary, sessionFile: f.root })).coverage.reasons.includes("not-regular-file"));
	assert.equal((await readPrimaryObservation({ ...f.primary, hostname: "another-host" })).presence.process.state, "unknown");
});
it("refuses a changed snapshot and closes the descriptor after a controlled read mutation", async t => {
	const f = fixture(t, [message(1, null)]);
	const sample = await open(f.sessionFile, "r");
	const prototype = Object.getPrototypeOf(sample);
	const original = prototype.read;
	await sample.close();
	let changed = false;
	t.mock.method(prototype, "read", async function(this: unknown, ...args: unknown[]) {
		const result = await Reflect.apply(original, this, args);
		if (!changed) { changed = true; appendFileSync(f.sessionFile, `${JSON.stringify(message(2, 1))}\n`); }
		return result;
	});
	const result = await readPrimaryObservation(f.primary);
	assert.equal(result.entries.length, 0);
	assert.equal(result.source.latestKnown, false);
	assert.ok(result.coverage.reasons.includes("source-changed"));
});
it("honors cancellation and rejects invalid limits without file reads", async t => {
	const f = fixture(t, [message(1, null)]);
	const controller = new AbortController(); controller.abort();
	const result = await readPrimaryObservation(f.primary, { signal: controller.signal });
	assert.ok(result.coverage.reasons.includes("aborted"));
	assert.equal(result.coverage.bytesRead, 0);
	for (const limit of [0, -1, 1.5, Number.NaN]) assert.deepEqual((await readPrimaryObservation(f.primary, { limit })).coverage.reasons, ["invalid-input"]);
});
it("accepts a header-only file without claiming an entry or a selected branch", async t => {
	const f = fixture(t);
	const result = await readPrimaryObservation(f.primary);
	assert.equal(result.source.latestKnown, false);
	assert.equal(result.coverage.complete, true);
	assert.deepEqual(result.entries, []);
});
it("refuses relative and recognizable sensitive source paths without echo or IO", async t => {
	const f = fixture(t, [message(1, null)]);
	const token = `sk-${"a1B9".repeat(8)}`;
	const unsafe = join(f.root, token, "session.jsonl");
	const result = await readPrimaryObservation({ ...f.primary, sessionFile: unsafe });
	assert.ok(result.coverage.reasons.includes("sensitive-session-path"));
	assert.equal(result.coverage.bytesRead, 0);
	assert.equal(result.source.path, undefined);
	assert.equal(result.nextCursor, undefined);
	assert.equal(result.coverage.omissions.credentials, 1);
	assert.ok(!JSON.stringify(result).includes(token));
	const relative = await readPrimaryObservation({ ...f.primary, sessionFile: "session.jsonl" });
	assert.deepEqual(relative.coverage.reasons, ["invalid-session-path"]);
	assert.equal(relative.source.path, undefined);
	assert.equal(relative.coverage.bytesRead, 0);
});
it("omits credential headers and explicit assignments but preserves UUID references and ordinary prose", async t => {
	const uuid = randomUUID();
	const values = ["Q2FtcGFpZ25TeW50aGV0aWM=", "SynthKey42OnlyForTests", "SynthSecret73OnlyForTests", "SynthPassword12!", "SynthAccess65OnlyForTests"];
	const text = [
		`Authorization: Basic ${values[0]}`, `X-Api-Key: ${values[1]}`,
		`"client_secret":"${values[2]}"`, `password=${values[3]}`, `AWS_SECRET_ACCESS_KEY=${values[4]}`,
		`api_key=${uuid}. Request ${uuid}.`, "The password prompt and token budget stay unchanged.",
	].join("\n");
	const f = fixture(t, [message(1, null, "user", text)]);
	const result = await readPrimaryObservation(f.primary);
	const serialized = JSON.stringify(result);
	for (const value of values) assert.ok(value !== undefined && !serialized.includes(value));
	assert.equal(result.coverage.omissions.credentials, 5);
	assert.ok(result.entries[0]?.text?.includes(`api_key=${uuid}. Request ${uuid}.`));
	assert.ok(result.entries[0]?.text?.includes("The password prompt and token budget stay unchanged."));
});
it("closes every object schema and rejects fields outside its output allowlist", async t => {
	const f = fixture(t, [message(1, null), message(2, 1)]);
	const result = await readPrimaryObservation(f.primary, { limit: 1 });
	assert.equal(Value.Check(OrdinaryPrimaryObservationSchema, result), true);
	function visit(value: unknown): void {
		if (value === null || typeof value !== "object") return;
		const schema = value as Record<string, unknown>;
		if (schema.type === "object") assert.equal(schema.additionalProperties, false);
		for (const child of Object.values(schema)) {
			if (Array.isArray(child)) child.forEach(visit);
			else if (child !== null && typeof child === "object") visit(child);
		}
	}
	visit(OrdinaryPrimaryObservationSchema);
	assert.equal(Value.Check(OrdinaryPrimaryObservationSchema, { ...result, raw: {} }), false);
	assert.equal(Value.Check(OrdinaryPrimaryObservationSchema, { ...result, presence: { ...result.presence, idle: true } }), false);
	assert.equal(Value.Check(OrdinaryPrimaryObservationSchema, { ...result, source: { ...result.source, raw: {} } }), false);
	assert.equal(Value.Check(OrdinaryPrimaryObservationSchema, { ...result, entries: [{ ...result.entries[0], arguments: {} }] }), false);
	assert.equal(Value.Check(OrdinaryPrimaryObservationSchema, { ...result, nextCursor: { ...result.nextCursor, raw: {} } }), false);
});
it("pins mtime independently from file identity and size", async t => {
	const f = fixture(t, [message(1, null), message(2, 1)]);
	const first = await readPrimaryObservation(f.primary, { limit: 1 });
	assert.ok(first.nextCursor);
	utimesSync(f.sessionFile, 100, 100);
	const changed = await readPrimaryObservation(f.primary, { cursor: first.nextCursor });
	assert.ok(changed.coverage.reasons.includes("source-changed"));
	assert.equal(changed.coverage.bytesRead, 0);
	assert.equal(changed.entries.length, 0);
});
it("reports local PID absence and permission gaps without a launch", async t => {
	const f = fixture(t);
	t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
	assert.equal((await readPrimaryObservation(f.primary)).presence.process.state, "dead");
	t.mock.method(process, "kill", () => { throw Object.assign(new Error("unverified"), { code: "EPERM" }); });
	assert.equal((await readPrimaryObservation(f.primary)).presence.process.state, "unknown");
});
it("keeps malformed roles, streaming messages, invalid UTF-8, and control text visible as coverage limits", async t => {
	const f = fixture(t);
	for (const row of [message(1, null, "constructor"), message(1, null, "assistant", [], { stopReason: "pending" })]) {
		f.write([row]);
		const result = await readPrimaryObservation(f.primary);
		assert.ok(result.coverage.reasons.includes("malformed-record"));
		assert.equal(result.source.latestKnown, false);
	}
	f.write([]); appendFileSync(f.sessionFile, Buffer.from([0xff, 10]));
	assert.ok((await readPrimaryObservation(f.primary)).coverage.reasons.includes("malformed-record"));
	f.write([message(1, null, "user", "safe\u001b[31m prose \ud800")]);
	const sanitized = await readPrimaryObservation(f.primary);
	assert.ok(sanitized.coverage.reasons.includes("control-text-escaped"));
	assert.ok(sanitized.coverage.reasons.includes("invalid-unicode-omitted"));
	const projected = sanitized.entries[0]?.text;
	assert.equal(projected, Buffer.from(projected ?? "").toString("utf8"));
	assert.ok(!formatPrimaryObservation(sanitized).includes("\u001b"));
});
it("limits projected output before serialization and returns a resumable item boundary", async t => {
	const content = [
		{ type: "text", text: "z".repeat(limits.textBytes) },
		...Array.from({ length: 16 }, (_, i) => ({ type: "toolCall", name: `tool-${i}-${"n".repeat(115)}`, arguments: { hidden: "raw arguments" } })),
	];
	const f = fixture(t, Array.from({ length: 20 }, (_, i) => message(i + 1, i === 0 ? null : i, "assistant", content, { stopReason: "error", errorMessage: "e".repeat(1024) })));
	const result = await readPrimaryObservation(f.primary, { view: "activity", limit: 20 });
	assert.ok(result.coverage.reasons.includes("output-budget"));
	assert.ok(result.nextCursor);
	assert.ok(result.entries.length > 0 && result.entries.length < 20);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= limits.outputBytes);
	assert.doesNotMatch(JSON.stringify(result), /raw arguments/u);
	const page = await readPrimaryObservation(f.primary, { view: "activity", limit: 1, cursor: result.nextCursor });
	assert.equal(page.entries[0]?.id, result.nextCursor.nextId);
});
it("reports malformed content fields instead of claiming complete useful text", async t => {
	const f = fixture(t, [message(1, null, "assistant", [{ type: "text", text: 12 }, null, { type: "unknown" }])]);
	const result = await readPrimaryObservation(f.primary);
	assert.ok(result.coverage.reasons.includes("malformed-content-block"));
	assert.equal(result.coverage.complete, false);
	assert.equal(result.entries[0]?.text, undefined);
});
it("escapes ESC, OSC, C0, C1, and bidi controls in producer data before presentation", async t => {
	const controls = "before\u001b]52;c;synthetic\u0007 middle \u009b31m after \u009d8;;https://example.test\u009c \u202e prose \u0000\t\r\n";
	const f = fixture(t, [message(1, null, "user", controls)]);
	const result = await readPrimaryObservation({ ...f.primary, name: controls });
	const forbidden = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
	assert.doesNotMatch(result.entries[0]?.text ?? "", forbidden);
	assert.doesNotMatch(result.presence.name ?? "", forbidden);
	for (const escaped of ["\\u001b", "\\u0007", "\\u009b", "\\u009d", "\\u009c", "\\u202e", "\\u0000", "\\u0009", "\\u000d", "\\u000a"]) assert.ok(result.entries[0]?.text?.includes(escaped));
	assert.ok(result.coverage.reasons.includes("control-text-escaped"));
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= limits.outputBytes);
});
it("redacts recognizable credentials interrupted by controls or escaped control spellings without joining output", async t => {
	const body = "aB3x".repeat(8), short = "aB3x".repeat(2), suffix = "aB3x".repeat(6);
	const uuid = randomUUID();
	const prose = `The token budget and password prompt stay unchanged. Request ${uuid}.`;
	const cases = [
		`sk-${short}\u0000${suffix}`, `s\u0000k-${body}`, `sk-\u001b[31m${body}`, `sk-\u009b31m${body}`,
		`sk-\u202e${body}`, `sk-${short}\\u0000${suffix}`, `sk-\\x1b[31m${body}`,
		`api_key=\\u001b[31m${body}`, `Authorization:\\tBasic ${body}`,
	];
	const f = fixture(t);
	for (const credential of cases) {
		f.write([message(1, null, "user", `${prose} ${credential} ordinary ending.`)]);
		const result = await readPrimaryObservation(f.primary);
		assert.equal(result.coverage.omissions.credentials, 1);
		assert.ok(result.entries[0]?.text?.includes(prose));
		assert.ok(result.entries[0]?.text?.includes("ordinary ending."));
		assert.ok(!JSON.stringify(result).includes(body));
		assert.ok(!JSON.stringify(result).includes(suffix));
		assert.ok(!formatPrimaryObservation(result).includes(body));
		assert.match(result.entries[0]?.text ?? "", /\[credential omitted\]/u);
	}
});
it("bounds the expanded control representation and its formatter without mutating observation data", async t => {
	const f = fixture(t, [message(1, null, "user", "\u0000".repeat(1000))]);
	const result = await readPrimaryObservation(f.primary);
	assert.ok(result.coverage.reasons.includes("text-output-budget"));
	assert.ok(Buffer.byteLength(result.entries[0]?.text ?? "") <= limits.textBytes);
	assert.ok(result.coverage.textScanBytes <= limits.textScanBytes);
	const raw = "\u001b]52;c;synthetic\u0007\u009b31m\u202e";
	const token = `sk-${"aB3x".repeat(8)}`;
	const unsafe = structuredClone(result);
	unsafe.sessionId = raw;
	unsafe.presence.name = raw;
	unsafe.presence.process.state = raw as "unknown";
	unsafe.source.path = `${raw}/${token}`;
	const entry = unsafe.entries[0];
	assert.ok(entry);
	entry.id = raw; entry.timestamp = raw; entry.role = raw; entry.text = `${raw} ordinary prose ${token}`; entry.error = raw; entry.toolNames = [raw];
	const before = JSON.stringify(unsafe);
	const formatted = formatPrimaryObservation(unsafe);
	assert.doesNotMatch(formatted, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
	assert.ok(!formatted.includes(token));
	assert.ok(formatted.includes("ordinary prose"));
	assert.ok(formatted.includes("\\u001b"));
	assert.ok(Buffer.byteLength(formatted) <= limits.outputBytes);
	assert.equal(JSON.stringify(unsafe), before);
});
it("accepts root-origin branch summaries emitted by the public current session writer", async t => {
	const f = fixture(t);
	const session = SessionManager.create(f.root, f.root, { id: f.primary.id });
	const origin = session.branchWithSummary(null, "HIDDEN_ROOT_SUMMARY");
	const user = session.appendMessage({ role: "user", content: "retained action", timestamp: 1791201600000 });
	const sessionFile = session.getSessionFile();
	assert.ok(sessionFile);
	const first = await readPrimaryObservation({ ...f.primary, sessionFile }, { view: "history" });
	assert.deepEqual(first.entries.map(value => value.id), [user, origin]);
	assert.equal(first.entries[1]?.kind, "branch_summary");
	assert.equal(first.entries[1]?.fromId, "root");
	assert.equal(first.coverage.complete, true);
	assert.doesNotMatch(JSON.stringify(first), /HIDDEN_ROOT_SUMMARY/u);
	session.resetLeaf();
	const final = session.branchWithSummary(null, "HIDDEN_FINAL_SUMMARY");
	const newest = await readPrimaryObservation({ ...f.primary, sessionFile });
	assert.equal(newest.source.head?.id, final);
	assert.equal(newest.source.latestKnown, true);
	assert.equal(newest.entries[0]?.fromId, "root");
	assert.equal(newest.coverage.complete, true);
	f.write([{ ...message(1, null), parentId: "root" }]);
	assert.ok((await readPrimaryObservation(f.primary)).coverage.reasons.includes("malformed-record"));
	f.write([{ ...message(1, null), id: "root" }]);
	assert.ok((await readPrimaryObservation(f.primary)).coverage.reasons.includes("malformed-record"));
});
it("refuses existing sensitive paths before reads or continuation and preserves an ordinary UUID path", async t => {
	const f = fixture(t, [message(1, null), message(2, 1)]);
	for (const name of [`sk-${"aB3x".repeat(8)}.jsonl`, "api_key=SynthKey42OnlyForTests.jsonl"]) {
		const sensitive = join(f.root, name);
		writeFileSync(sensitive, readFileSync(f.sessionFile));
		const result = await readPrimaryObservation({ ...f.primary, sessionFile: sensitive }, { limit: 1 });
		assert.ok(result.coverage.reasons.includes("sensitive-session-path"));
		assert.equal(result.coverage.bytesRead, 0);
		assert.equal(result.source.path, undefined);
		assert.equal(result.nextCursor, undefined);
		assert.ok(!JSON.stringify(result).includes(name));
		assert.ok(!formatPrimaryObservation(result).includes(name));
	}
	const ordinary = join(f.root, `${randomUUID()}.jsonl`);
	writeFileSync(ordinary, readFileSync(f.sessionFile));
	const first = await readPrimaryObservation({ ...f.primary, sessionFile: ordinary }, { limit: 1 });
	assert.equal(first.source.path, ordinary);
	assert.equal(first.nextCursor?.path, ordinary);
});
