import assert from "node:assert/strict";
import test from "node:test";
import { completionContent, completionTail, type JobCompletionDetails } from "./completion.ts";
import { pageLogs } from "./manager.ts";

test("completion retains the actual final line across every page of the tail window", () => {
	const output = Buffer.from(`${"ab\n".repeat(29999)}LAST\n`);
	const tail = completionTail((cursor) => pageLogs("dense", output, output.length, false, cursor));
	assert.equal(tail.text.split("\n").length, 40);
	assert.equal(tail.text.split("\n").at(-1), "LAST");
	assert.equal(tail.omitted, true);
	assert.equal(tail.outputBytes, output.length);
});

test("a nonadvancing log reader fails instead of looping or returning a false tail", () => {
	assert.throws(() => completionTail(() => ({ id: "stuck", text: "", earliest: 0, next: 0, end: 10, gap: false, more: true, pendingBytes: 0 })), /did not advance/);
});

test("completion labels retained backend errors by terminal status", () => {
	for (const [status, label] of [["cancelled", "Backend error after cancellation"], ["timed_out", "Backend error after timeout"], ["failed", "Execution error"]] as const) {
		const details: JobCompletionDetails = { job: { id: "job", status, startedAt: 1, endedAt: 2, cancellationRequested: status === "cancelled", error: "retained diagnostic" }, command: "fixture", tail: { text: "", omitted: false, outputBytes: 0 } };
		assert.ok(completionContent(details).includes(`${label}: retained diagnostic`));
	}
});
