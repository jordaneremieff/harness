import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { completionContent, type JobCompletionDetails } from "./completion.ts";
import { jobFromRecord, type JobInput } from "./durable.ts";
import { JobManager } from "./manager.ts";
import { renderBashResult, renderJobsCall, renderJobsResult, type JobView } from "./presentation.ts";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
// The native bash card reads the process theme singleton, as any rendering host does.
initTheme();

type RenderContext = Parameters<typeof renderJobsResult>[3];

function context(expanded = false): RenderContext {
	return {
		args: {},
		toolCallId: "call",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: "/work",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 0,
		keyText: () => "",
		keyHint: () => "",
	} as unknown as RenderContext;
}

function render(result: AgentToolResult<unknown>, expanded = false): string {
	const component = renderJobsResult(result, { expanded }, theme, context(expanded));
	assert.ok(component instanceof Text);
	return component.render(80).join("\n");
}

function jobResult(job: JobView, expanded = false): string {
	return render({ content: [{ type: "text", text: "" }], details: { job } }, expanded);
}

test("list cards distinguish complete pages from partial pages in both forms", () => {
	const cursor = { after: 41 };
	for (const jobs of [[], [{ id: "41", commandPreview: "fixture", status: "succeeded" }]]) {
		const complete = { content: [], details: { jobs } };
		const partial = { content: [], details: { jobs, nextTaskCursor: cursor } };
		for (const expanded of [false, true]) {
			const fullText = render(complete, expanded);
			const partialText = render(partial, expanded);
			assert.doesNotMatch(fullText, /partial page|nextTaskCursor/);
			assert.match(partialText, /More jobs: partial page/);
			if (expanded) assert.ok(partialText.includes(`nextTaskCursor: ${JSON.stringify(cursor)}`));
			else { assert.doesNotMatch(partialText, /nextTaskCursor/); assert.match(partialText, /expand/); }
			if (jobs.length === 0) assert.equal(fullText.trim(), "No jobs");
		}
	}
});

test("error cards retain non-abort diagnostics under the known outcome label", () => {
	for (const expanded of [false, true]) {
		for (const [status, label] of [["cancelled", "Backend error after cancellation"], ["timed_out", "Backend error after timeout"], ["failed", "Execution error"]]) {
			const text = jobResult({ id: "1", commandPreview: "fixture", status, error: "non-abort diagnostic" }, expanded);
			assert.ok(text.includes(`${label}: non-abort diagnostic`));
		}
	}
});

test("ordinary snapshots carry bounded command identity and omit a missing owner", async () => {
	const manager = new JobManager();
	const job = manager.start("printf ready", "/work/jobs", { exec: async () => ({ exitCode: 0 }) });
	assert.equal(job.commandPreview, "printf ready");
	assert.equal(job.cwd, "/work/jobs");
	assert.equal(job.owner, undefined);
	assert.equal(typeof job.observedAt, "number");
	await manager.dispose();
});

test("a durable record without command identity stays unknown rather than blank", () => {
	const input = { conversationId: 9, createdAt: 100, requestId: "r" } as JobInput;
	const missing = jobFromRecord({
		id: 4,
		conversationId: 9,
		kind: "jobs.run",
		input,
		abortRequested: false,
		state: { status: "running" },
	} as never, 150);
	assert.equal(missing.commandPreview, undefined);
	assert.equal(missing.cwd, undefined);
	assert.equal(missing.owner, "conversation:9");
	assert.equal(missing.status, "running");
	const present = jobFromRecord({
		id: 5,
		conversationId: 9,
		kind: "jobs.run",
		input: { ...input, command: "printf lost", cwd: "/work", owner: "storage:9" },
		abortRequested: false,
		startedAt: 110,
		endedAt: 140,
		state: { status: "terminal", outcome: { status: "completed", result: { status: "lost", startedAt: 110, endedAt: 140, outputBytes: 0 } } },
	} as never, 160);
	assert.equal(present.commandPreview, "printf lost");
	assert.equal(present.cwd, "/work");
	assert.equal(present.owner, "storage:9");
	assert.equal(present.status, "lost");
});

test("cards keep accepted, requested, settled, timeout, loss, and unavailable output distinct", () => {
	const running = jobResult({ id: "1", commandPreview: "npm test", cwd: "/work", owner: "session", status: "running", startedAt: 0, observedAt: 1500, cancellationRequested: false });
	assert.match(running, /^npm test/u);
	assert.match(running, /accepted, running/u);
	assert.match(running, /elapsed 1\.5s at observation/u);
	assert.match(running, /^job 1 \u00b7 in work \u00b7 session\s*$/mu, "a short identity and folder tell repeated commands apart");
	assert.doesNotMatch(running, /no cancel request|settled cancellation/u, "a routine absence says nothing");
	assert.match(running, /\.\.\. \(expand for full details\)\s*$/u);

	const requested = jobResult({ id: "2", commandPreview: "sleep 30", status: "running", startedAt: 0, observedAt: 2000, cancellationRequested: true });
	assert.match(requested, /cancellation requested/u);
	assert.doesNotMatch(requested, /settled cancellation/u);

	const settled = jobResult({ id: "3", commandPreview: "sleep 30", status: "cancelled", startedAt: 0, endedAt: 4000, cancellationRequested: true }, true);
	assert.match(settled, /settled cancellation/u);
	assert.match(settled, /final 4(?:\.0)?s/u);
	assert.match(settled, /id: 3/u);
	assert.match(settled, /owner: unknown/u);
	assert.match(settled, /working directory: unknown/u);
	assert.match(settled, /cancel request: yes/u);
	assert.doesNotMatch(settled, /to expand|expand for full/u, "expanded cards show no hint");
	const failed = jobResult({ id: "7", commandPreview: "npm test", cwd: "/work", status: "failed", startedAt: 0, endedAt: 4000, exitCode: 1, cancellationRequested: false, error: "Exit 1\x1b[2J\x1b]52;c;Zm9v\x07 with\nrest" });
	assert.match(failed, /^failed \u00b7 exit 1 \u00b7 final 4(?:\.0)?s\s*$/mu, "the exceptional state leads the facts line");
	assert.match(failed, /^Execution error: Exit 1 with rest\s*$/mu);
	assert.doesNotMatch(failed, /\x1b|Zm9v/u, "terminal sequences never reach the card");

	const timed = jobResult({ id: "4", commandPreview: "sleep 30", status: "timed_out", startedAt: 0, endedAt: 50, cancellationRequested: true, timeoutSeconds: 0.05 }, true);
	assert.match(timed, /timed out/u);
	assert.match(timed, /timeout: 0\.05s/u);
	assert.doesNotMatch(timed, /accepted, running/u);

	const lost = jobResult({ id: "5", commandPreview: "printf lost", status: "lost", startedAt: 0, endedAt: 10, cancellationRequested: false }, true);
	assert.match(lost, /host lost/u);
	assert.match(lost, /Output is unavailable/u);
	assert.match(lost, /does not mean the command produced no output/u);

	const gap = render({
		content: [{ type: "text", text: "" }],
		details: { id: "6", text: "tail", earliest: 100, next: 104, end: 104, gap: true, more: false, pendingBytes: 2, job: { id: "6", commandPreview: "yes", status: "succeeded", exitCode: 0, cancellationRequested: false } },
	}, true);
	assert.match(gap, /gap: yes, earlier output was discarded/u);
	assert.match(gap, /earlier output was discarded/u);
	assert.match(gap, /pending bytes: 2/u);
	assert.match(gap, /incomplete UTF-8 suffix/u);
	const hostile = render({
		content: [{ type: "text", text: "" }],
		details: { id: "8", text: "line\x1b[31m red\x1b[0m\n\x1b]52;c;Zm9v\x07tab\tend", earliest: 0, next: 10, end: 10, gap: false, more: true, pendingBytes: 0, job: { id: "8", commandPreview: "printf\x1b[2J hostile", cwd: "/work/deep", owner: "storage:8", status: "succeeded", exitCode: 0, cancellationRequested: false } },
	}, true);
	assert.match(hostile, /^printf hostile\s*$/mu);
	assert.match(hostile, /line red\s*\ntab\s+end/u, "log text keeps newlines and tabs without controls");
	assert.doesNotMatch(hostile, /\x1b|Zm9v/u);
	assert.match(hostile, /more: yes/u);
	const compactLogs = render({ content: [{ type: "text", text: "" }], details: { id: "8", text: "x", earliest: 0, next: 1, end: 1, gap: true, more: true, pendingBytes: 1, job: { id: "8", commandPreview: "printf hostile", status: "succeeded", exitCode: 0, cancellationRequested: false, error: "stderr noise" } } });
	assert.match(compactLogs, /output gap \u00b7 more output \u00b7 output pending/u);
	assert.doesNotMatch(compactLogs, /stderr noise/u, "a log page card shows the page marks, not the job error");
	assert.match(compactLogs, /expand for full details/u);

	const blank = jobResult({});
	assert.match(blank, /command unknown/u);
	assert.doesNotMatch(blank, /command unknown\n\n/u);
});

test("a job list identifies jobs by command", () => {
	const listed = render({
		content: [{ type: "text", text: "" }],
		details: { jobs: [{ id: "abc", commandPreview: "npm test", status: "running", startedAt: 0, observedAt: 1000, cancellationRequested: false }, { id: "def", status: "failed", cancellationRequested: false }] },
	});
	assert.match(listed, /npm test/u);
	assert.match(listed, /command unknown/u);
	assert.ok(listed.indexOf("npm test") < listed.indexOf("abc") || !listed.includes("\nabc\n"));
});

test("completion wording names the directory, keeps the error, and does not treat host loss as empty output", () => {
	const lost: JobCompletionDetails = {
		job: { id: "9", status: "lost", startedAt: 0, endedAt: 1000, cancellationRequested: false, error: "host stopped" },
		command: "",
		tail: { text: "", omitted: false, outputBytes: 0 },
	};
	const text = completionContent(lost);
	assert.match(text, /command unknown/u);
	assert.match(text, /Working directory: unknown/u);
	assert.match(text, /Execution error: host stopped/u);
	assert.match(text, /does not mean the command produced no output/u);
	assert.doesNotMatch(text, /The command produced no output\./u);
});

test("background bash results use the job card and foreground results stay on the native renderer", () => {
	const background = renderBashResult({ content: [{ type: "text", text: "" }], details: { job: { commandPreview: "npm test", status: "running", startedAt: 0, observedAt: 1000, cancellationRequested: false } } }, { expanded: false, isPartial: false }, theme, context());
	assert.match(background.render(40).join("\n"), /npm test/u);
	const call = renderJobsCall({ action: "logs", id: "job-1" }, theme, context());
	assert.match(call.render(40).join("\n"), /jobs logs job-1/u);
	const foreground = renderBashResult({ content: [{ type: "text", text: "ready" }], details: { output: "ready" } }, { expanded: true, isPartial: false }, theme, context());
	assert.doesNotMatch(foreground.render(40).join("\n"), /command unknown/u);
});
