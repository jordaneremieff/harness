import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { finishCall, MAX_PENDING, startCall, trackPending, type PendingCall, type SessionFacts } from "./record.ts";

const facts: SessionFacts = { session: "s1", mode: "tui", cwd: "/work", projectContext: true };

describe("startCall", () => {
	it("classifies the call and stores redacted command text", () => {
		const call = startCall("bash", "c1", { command: "TOKEN=abcdef cat notes.md" }, new Date("2026-09-01T10:00:00Z"), 1000);
		assert.deepEqual(call.classes, ["routing.cat-read"]);
		assert.equal(call.command, "TOKEN=[redacted] cat notes.md");
		assert.equal(call.at, "2026-09-01T10:00:00.000Z");
	});

	it("stores no input for a tool without a declared capture", () => {
		const call = startCall("read", "c2", { path: "/etc/hosts" });
		assert.equal(call.command, undefined);
		assert.deepEqual(call.classes, []);
	});
});

describe("finishCall", () => {
	const pending = (): PendingCall => startCall("bash", "c1", { command: "cat a" }, new Date("2026-09-01T10:00:00Z"), 1000);

	it("measures duration and output size", () => {
		const record = finishCall(pending(), { content: [{ type: "text", text: "abcd" }] }, facts, 1250);
		assert.equal(record.durationMs, 250);
		assert.equal(record.outputBytes, 4);
		assert.equal(record.error, false);
		assert.equal(record.errorKind, null);
		assert.equal(record.session, "s1");
		assert.equal(record.projectContext, true);
	});

	it("never reports a negative duration", () => {
		assert.equal(finishCall(pending(), {}, facts, 500).durationMs, 0);
	});

	it("infers the error kind from error text", () => {
		const kind = (text: string) =>
			finishCall(pending(), { isError: true, content: [{ type: "text", text }] }, facts, 1001).errorKind;
		assert.equal(kind("Command timed out after 120s"), "timeout");
		assert.equal(kind("aborted"), "aborted");
		assert.equal(kind("No such file or directory"), "other");
	});

	it("carries truncation and reported tokens", () => {
		const record = finishCall(pending(), { truncated: true, tokens: 42 }, facts, 1001);
		assert.equal(record.truncated, true);
		assert.equal(record.tokens, 42);
	});

	it("reports absent token usage as null", () => {
		assert.equal(finishCall(pending(), {}, facts, 1001).tokens, null);
	});
});

describe("trackPending", () => {
	it("evicts the oldest call when the map is full", () => {
		const map = new Map<string, PendingCall>();
		for (let index = 0; index < MAX_PENDING + 5; index++) {
			trackPending(map, startCall("bash", `c${index}`, { command: "ls" }));
		}
		assert.equal(map.size, MAX_PENDING);
		assert.equal(map.has("c0"), false);
		assert.equal(map.has(`c${MAX_PENDING + 4}`), true);
	});
});
