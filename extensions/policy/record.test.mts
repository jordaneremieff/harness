import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	finishCall,
	MAX_PENDING,
	MAX_PENDING_AGE_MS,
	startCall,
	trackPending,
	type PendingCall,
	type SessionFacts,
} from "./record.ts";

const facts: SessionFacts = { session: "s1", mode: "tui", cwd: "/work", projectContext: true };

describe("startCall", () => {
	it("classifies the call and stores redacted command text", () => {
		const call = startCall("bash", "c1", { command: "TOKEN=abcdef cat notes.md" }, new Date("2026-09-01T10:00:00Z"), 1000);
		assert.deepEqual(call.classes, ["routing.cat-read"]);
		assert.equal(call.captured, "TOKEN=[redacted] cat notes.md");
		assert.equal(call.at, "2026-09-01T10:00:00.000Z");
	});

	it("stores no input for a tool without a declared capture", () => {
		const call = startCall("read", "c2", { path: "/etc/hosts" });
		assert.equal(call.captured, undefined);
		assert.deepEqual(call.classes, []);
	});

	it("reads the captured input exactly once", () => {
		let reads = 0;
		const input = {
			get command() {
				reads++;
				return reads === 1 ? "cat notes.md" : "rg -n x src/";
			},
		};
		const call = startCall("bash", "c1", input);
		assert.equal(reads, 1);
		assert.deepEqual(call.classes, ["routing.cat-read"]);
		assert.equal(call.captured, "cat notes.md");
	});
});

describe("finishCall", () => {
	const pending = (): PendingCall => startCall("bash", "c1", { command: "cat a" }, new Date("2026-09-01T10:00:00Z"), 1000);

	it("measures duration and output size", () => {
		const record = finishCall(pending(), { content: [{ type: "text", text: "abcd" }] }, facts, "observe", {}, 1250);
		assert.equal(record.durationMs, 250);
		assert.equal(record.outputBytes, 4);
		assert.equal(record.error, false);
		assert.equal(record.errorKind, null);
		assert.equal(record.session, "s1");
		assert.equal(record.projectContext, true);
	});

	it("never reports a negative duration", () => {
		assert.equal(finishCall(pending(), {}, facts, "observe", {}, 500).durationMs, 0);
	});

	it("infers the error kind from error text", () => {
		const kind = (text: string) =>
			finishCall(pending(), { isError: true, content: [{ type: "text", text }] }, facts, "observe", {}, 1001)
				.errorKind;
		assert.equal(kind("Command timed out after 120s"), "timeout");
		assert.equal(kind("aborted"), "aborted");
		assert.equal(kind("No such file or directory"), "other");
	});

	it("carries truncation and reported tokens", () => {
		const record = finishCall(pending(), { truncated: true, tokens: 42 }, facts, "observe", {}, 1001);
		assert.equal(record.truncated, true);
		assert.equal(record.tokens, 42);
	});

	it("reports absent token usage as null", () => {
		assert.equal(finishCall(pending(), {}, facts, "observe", {}, 1001).tokens, null);
	});

	it("records the active mode on every call", () => {
		assert.equal(finishCall(pending(), {}, facts, "annotate", {}, 1001).policyMode, "annotate");
		assert.equal(finishCall(pending(), {}, facts, "observe", {}, 1001).policyMode, "observe");
	});

	it("carries mechanism effects only when a mechanism acted", () => {
		const quiet = finishCall(pending(), {}, facts, "observe", {}, 1001);
		assert.equal(quiet.notified, undefined);
		assert.equal(quiet.annotated, undefined);
		assert.equal(quiet.annotationBytes, undefined);

		const noticed = finishCall(pending(), {}, facts, "notice", { notified: true }, 1001);
		assert.equal(noticed.notified, true);
		assert.equal(noticed.annotated, undefined);

		const annotated = finishCall(pending(), {}, facts, "annotate", { annotationBytes: 40 }, 1001);
		assert.equal(annotated.annotated, true);
		assert.equal(annotated.annotationBytes, 40);
	});

	it("treats an empty annotation as no annotation", () => {
		const record = finishCall(pending(), {}, facts, "annotate", { annotationBytes: 0 }, 1001);
		assert.equal(record.annotated, undefined);
		assert.equal(record.annotationBytes, undefined);
	});

	it("records a block only when the call was blocked", () => {
		assert.equal(finishCall(pending(), {}, facts, "enforce", { blocked: true }, 1001).blocked, true);
		assert.equal(finishCall(pending(), {}, facts, "enforce", { blocked: false }, 1001).blocked, undefined);
		assert.equal(finishCall(pending(), {}, facts, "observe", {}, 1001).blocked, undefined);
	});
});

describe("trackPending", () => {
	it("evicts the oldest call when the map is full", () => {
		const map = new Map<string, PendingCall>();
		for (let index = 0; index < MAX_PENDING + 5; index++) {
			trackPending(map, startCall("bash", `c${index}`, { command: "ls" }, new Date(), index), index);
		}
		assert.equal(map.size, MAX_PENDING);
		assert.equal(map.has("c0"), false);
		assert.equal(map.has(`c${MAX_PENDING + 4}`), true);
	});

	it("drops unresolved calls after the age bound", () => {
		const map = new Map<string, PendingCall>();
		trackPending(map, startCall("bash", "stale", { command: "ls" }, new Date(), 0), 0);
		trackPending(
			map,
			startCall("bash", "live", { command: "ls" }, new Date(), MAX_PENDING_AGE_MS + 1),
			MAX_PENDING_AGE_MS + 1,
		);
		assert.equal(map.has("stale"), false);
		assert.equal(map.has("live"), true);
	});
});
