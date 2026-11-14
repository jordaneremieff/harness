/**
 * The answer of real `pi -p` and `pi --mode json` runs with the agent extension loaded, against a scripted
 * provider. Text print mode prints only a final assistant message, so `agent_work` there never ends the
 * turn: it asks for a text answer, and a run that keeps calling it stops with an error instead of an empty
 * success.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { ORDINARY_TEXT_ANSWER, ORDINARY_TEXT_REFUSED } from "./ordinary-work.ts";
import { call, lastWorkResult, printRun, text, work } from "./print-run-fixture.mts";
import { FOLLOW_UP_TEXT } from "./testdata/print-run/follow-up.ts";

const followUpExtension = fileURLToPath(new URL("./testdata/print-run/follow-up.ts", import.meta.url));
const timeout = 90000;

function inputTexts(context: TranscriptContext): string[] {
	return context.messages.flatMap((message) => message.role !== "user" ? [] : typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => part.type === "text" ? [part.text] : []));
}

type JsonEvent = { type: string; message?: { role: string; content: Array<{ type: string; text?: string }>; stopReason?: string } };

function events(stdout: string): JsonEvent[] {
	return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as JsonEvent);
}

/** The message of the last `message_end` before the first `agent_end`. */
function finalMessage(stream: JsonEvent[]): JsonEvent["message"] {
	const end = stream.findIndex((event) => event.type === "agent_end");
	assert.ok(end > 0, "the stream has agent_end");
	return stream.slice(0, end).findLast((event) => event.type === "message_end")?.message;
}

it("prints a standalone final text answer", { timeout }, async () => {
	const run = await printRun({ mode: "text", prompt: "Review it.", script: () => text("Findings: none.") });
	assert.deepEqual({ stdout: run.stdout, stderr: run.stderr, code: run.code, requests: run.requests.length }, { stdout: "Findings: none.\n", stderr: "", code: 0, requests: 1 });
});

it("asks for a text answer when agent_work follows text in one message, and prints that answer", { timeout }, async () => {
	const run = await printRun({
		mode: "text", prompt: "Review it.",
		script: (context, index) => {
			if (index === 0) return work("Findings: none.");
			assert.equal(lastWorkResult(context), ORDINARY_TEXT_ANSWER, "the reminder reaches the provider as the tool result");
			return index === 1 ? text("Findings: none. Nothing else remains.") : undefined;
		},
	});
	assert.deepEqual({ stdout: run.stdout, stderr: run.stderr, code: run.code, requests: run.requests.length }, { stdout: "Findings: none. Nothing else remains.\n", stderr: "", code: 0, requests: 2 });
});

it("stops a run that keeps calling agent_work after two reminders, with an error and no answer", { timeout }, async () => {
	const run = await printRun({ mode: "text", prompt: "Review it.", script: (_context, index) => index < 10 ? work() : text("unreachable") });
	assert.equal(run.stdout, "", "no answer is printed");
	assert.equal(run.code, 1);
	assert.ok(run.stderr.startsWith(`${ORDINARY_TEXT_REFUSED}\n`), "stderr states why the run stopped");
	assert.equal(run.requests.length, 3, "two reminders, then the third call stops the run without another request");
	assert.equal(lastWorkResult(run.requests[2]), ORDINARY_TEXT_ANSWER);
	const [refusal, stop] = run.entries.slice(-2).map((entry) => entry.message);
	assert.deepEqual({ role: refusal?.role, toolName: refusal?.toolName, isError: refusal?.isError, content: refusal?.content }, { role: "toolResult", toolName: "agent_work", isError: true, content: [{ type: "text", text: ORDINARY_TEXT_REFUSED }] }, "the retained session says why the run stopped");
	assert.equal(stop?.role, "assistant");
	assert.equal(stop?.stopReason, "aborted");
	assert.ok(stop?.errorMessage && run.stderr.includes(stop.errorMessage), "stderr carries the message of the aborted turn");
});

it("prints the answer to a follow-up that arrives after an earlier text report", { timeout }, async () => {
	const run = await printRun({
		mode: "text", prompt: "Run the check.", extensions: [followUpExtension],
		script: (context, index) => {
			if (index === 0) return call("fixture_background", {});
			if (index === 1) return text("The check started; its result follows when it finishes.");
			if (index === 2) {
				assert.ok(inputTexts(context).includes(FOLLOW_UP_TEXT), "the follow-up starts the next turn");
				return work();
			}
			assert.equal(lastWorkResult(context), ORDINARY_TEXT_ANSWER);
			return index === 3 ? text("The check passed: 42 files.") : undefined;
		},
	});
	assert.deepEqual({ stdout: run.stdout, stderr: run.stderr, code: run.code, requests: run.requests.length }, { stdout: "The check passed: 42 files.\n", stderr: "", code: 0, requests: 4 });
});

it("ends a JSON stream with the final text message when agent_work follows text", { timeout }, async () => {
	const run = await printRun({ mode: "json", prompt: "Review it.", script: (_context, index) => index === 0 ? work("Findings: none.") : index === 1 ? text("Findings: none. Nothing else remains.") : undefined });
	assert.equal(run.code, 0);
	assert.equal(run.stderr, "");
	const message = finalMessage(events(run.stdout));
	assert.deepEqual({ role: message?.role, stopReason: message?.stopReason, content: message?.content }, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Findings: none. Nothing else remains." }] });
});

it("ends a JSON stream with the aborted message when a run keeps calling agent_work; JSON mode exits 0", { timeout }, async () => {
	const run = await printRun({ mode: "json", prompt: "Review it.", script: (_context, index) => index < 10 ? work() : text("unreachable") });
	assert.equal(run.code, 0, "JSON mode never sets the exit code from the last message");
	assert.equal(run.requests.length, 3);
	const stream = events(run.stdout);
	const message = finalMessage(stream);
	assert.equal(message?.role, "assistant");
	assert.equal(message?.stopReason, "aborted");
	assert.ok(stream.some((event) => event.type === "message_end" && event.message?.role === "toolResult" && event.message.content.some((part) => part.text === ORDINARY_TEXT_REFUSED)), "the stream carries why the run stopped");
});
