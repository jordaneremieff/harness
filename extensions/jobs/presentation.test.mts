import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { completionContent, type JobCompletionDetails } from "./completion.ts";
import { toolDisplay } from "./display.ts";
import { jobFromRecord, type JobInput } from "./durable.ts";
import { JobManager } from "./manager.ts";

initTheme("dark", false);
const nativeTui = await import(
	createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")
);
const initialKeys = nativeTui.getKeybindings();
test.after(() => nativeTui.setKeybindings(initialKeys));

function setExpandKeys(defaultKeys: string[]) {
	nativeTui.setKeybindings(
		new nativeTui.KeybindingsManager({
			...nativeTui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys, description: "Toggle tool output" },
		}),
	);
}

const fullId = "d5b9bde7-6e43-4a07-a284-f022679d4be9";

function card(name: string, args: unknown) {
	const renderers = toolDisplay().tools.find((tool) => tool.name === name);
	assert.ok(renderers);
	const component = new ToolExecutionComponent(
		name,
		"call",
		args,
		undefined,
		renderers,
		{ requestRender() {} } as unknown as TUI,
		"/work",
	);
	const rows = (width = 100) => component.render(width).map((row) => stripVTControlCharacters(row).trim());
	return {
		component,
		rows,
		text: (width = 100) => rows(width).join("\n"),
		result(details: unknown, text = "", isError = false) {
			component.updateResult({ details, content: [{ type: "text", text }], isError });
		},
		click(y: number, width = 100) {
			return component.handleMouse({
				type: "click",
				button: "left",
				x: 4,
				y,
				screenX: 4,
				screenY: y,
				width,
				height: rows(width).length,
			} as never);
		},
	};
}

function assertHintAtEnd(rows: string[], hint: RegExp) {
	assert.match(rows.at(-2) ?? "", hint);
	assert.equal(rows.filter((row) => row.includes("to expand")).length, 1);
}

test("Pi shows a managed status with full identity and a bounded snapshot clock", () => {
	setExpandKeys([]);
	const status = card("jobs", { action: "status", id: fullId });
	status.result(
		{
			job: {
				id: fullId,
				commandPreview: "npm test",
				cwd: `${homedir()}/work`,
				owner: "session",
				status: "running",
				startedAt: 0,
				observedAt: 1500,
				cancellationRequested: false,
			},
		},
		"Do not poll for completion.",
	);
	assert.deepEqual(status.rows().slice(2, 6), [
		`jobs status ${fullId}`,
		"",
		"Job recorded as running at observation.",
		"elapsed 1.5s at observation",
	]);
	assert.match(status.text(), /elapsed 1\.5s at observation\ndirectory: ~\/work\nsession\ncommand preview: npm test/u);
	assert.doesNotMatch(status.text(), /unknown|to expand|Do not poll/u);
	const narrow = status.rows(32);
	assert.match(narrow[2] ?? "", /^jobs status .+…$/u);
	assert.ok(status.component.render(32).every((row) => visibleWidth(row) <= 32));
	assertHintAtEnd(narrow, /^\.\.\. \(click to expand\)$/u);
	assert.equal(status.click(2, 32)?.handled, true);
	assert.match(status.text(32).replace(/\n/gu, ""), new RegExp(fullId, "u"));
	assert.doesNotMatch(status.text(32), /to expand/u);
});

test("Pi supplies the error bit separately and the card shows the original diagnostic without guessing cancellation", () => {
	setExpandKeys(["ctrl+p"]);
	const failed = card("jobs", { action: "cancel", id: "27" });
	const errorRows = [
		"Cancelled was not confirmed.\x1b[2J",
		"First fact",
		"Second fact",
		"Third fact",
		"Fourth fact",
		"Fifth fact",
		"Last diagnostic",
	];
	failed.result(undefined, errorRows.join("\n"), true);
	assert.match(failed.text(), /jobs cancel 27\n\nCancelled was not confirmed\./u);
	assert.doesNotMatch(failed.text(), /\nCancelled\n|Last diagnostic|unknown/u);
	assertHintAtEnd(failed.rows(), /^\.\.\. \(1 more line, ctrl\+p to expand\)$/u);
	assert.doesNotMatch(failed.component.render(100).join("\n"), /\x1b\[2J/u);
	assert.equal(failed.click(4)?.handled, true);
	assert.match(failed.text(), /Last diagnostic/u);
	assert.doesNotMatch(failed.text(), /to expand/u);

	const cancelled = card("jobs", { action: "cancel", id: "27" });
	cancelled.result({ job: { id: "27", status: "running", cancellationRequested: true } });
	assert.match(cancelled.text(), /^Cancellation requested\.$/mu);
	cancelled.result({
		job: {
			id: "27",
			status: "cancelled",
			cancellationRequested: true,
			error: "non-abort diagnostic",
			startedAt: 0,
			endedAt: 90_000,
		},
	});
	assert.match(cancelled.text(), /^Cancelled$/mu);
	assert.match(cancelled.text(), /final 1m 30s/u);
	assert.match(cancelled.text(), /Backend error after cancellation: non-abort diagnostic/u);
	assert.doesNotMatch(cancelled.text(), /unknown|not retained/u);
});

test("known failure, timeout and host loss facts stay distinct without synthesising an exit or clock", () => {
	setExpandKeys([]);
	for (const [job, expected] of [
		[{ status: "failed", exitCode: 2, error: "bad\x1b[2J thing" }, /Job failed\.\nexit 2\nExecution error: bad thing/u],
		[
			{ status: "timed_out", exitCode: null, timeoutSeconds: 5, error: "backend stopped" },
			/Job timed out\.\ntimeout 5s\nBackend error after timeout: backend stopped/u,
		],
		[
			{ status: "lost", observedAt: 1000, startedAt: 0 },
			/Job lost its host\.\nOutput is unavailable after host loss; the command was not run again\./u,
		],
	] as const) {
		const status = card("jobs", { action: "status" });
		status.result({ job });
		assert.match(status.text(), expected);
		assert.doesNotMatch(status.text(), /unknown|at observation/u);
	}
});

test("list pages distinguish an empty list, an empty partial page and the exact continuation", () => {
	setExpandKeys(["ctrl+p"]);
	const cursor = { after: 41, scope: "conversation" };
	const list = card("jobs", { action: "list", taskCursor: { before: 45 } });
	assertHintAtEnd(list.rows(), /^\.\.\. \(ctrl\+p to expand\)$/u);
	assert.equal(list.click(2), undefined, "Pi only accepts clicks once a result exists");
	list.result({ jobs: [], nextTaskCursor: cursor });
	assert.match(list.text(), /Listed 0 jobs on this page; another page is available\./u);
	assert.doesNotMatch(list.text(), /taskCursor|Truncated/u);
	assertHintAtEnd(list.rows(), /^\.\.\. \(ctrl\+p to expand\)$/u);
	list.component.setExpanded(true);
	assert.ok(list.text().includes('taskCursor: {"before":45}'));
	assert.ok(list.text().includes(`Continue with jobs ${JSON.stringify({ action: "list", taskCursor: cursor })}`));
	assert.doesNotMatch(list.text(), /to expand/u);
	const complete = card("jobs", { action: "list" });
	complete.result({ jobs: [] });
	assert.match(complete.text(), /No jobs\./u);
	assert.doesNotMatch(complete.text(), /expand/u);
	complete.result({
		jobs: Array.from({ length: 6 }, (_, i) => ({ id: String(i), commandPreview: `fixture ${i}`, status: "succeeded" })),
	});
	assert.match(complete.text(), /Listed 6 jobs\.\nsucceeded · job 0 · command preview: fixture 0/u);
	assert.doesNotMatch(complete.text(), /fixture 5/u);
	assertHintAtEnd(complete.rows(), /1 more line, ctrl\+p to expand/u);
});

test("log pages show retained bytes, a real gap, pending UTF-8 and the full continuation call", () => {
	setExpandKeys([]);
	const logs = card("jobs", { action: "logs", id: fullId, cursor: 25 });
	logs.result(
		{
			id: fullId,
			text: "**literal**\nline\tred\x1b[31m!\x1b[0m",
			earliest: 100,
			next: 150,
			end: 170,
			pendingBytes: 2,
			gap: true,
			more: true,
			job: { id: fullId, status: "running", error: "backend detail" },
		},
		"Do not poll for completion.",
	);
	assert.match(
		logs.text(),
		/Read 50 bytes from retained logs; more output is available; 2 bytes in an incomplete UTF-8 suffix\./u,
	);
	assert.match(logs.text(), /\*\*literal\*\*\nline {3}red!\n\[Excerpt: earlier output was discarded\]/u);
	assert.doesNotMatch(logs.text(), /backend detail|Do not poll|cursor":150/u);
	assertHintAtEnd(logs.rows(), /^\.\.\. \(click to expand\)$/u);
	logs.component.setExpanded(true);
	assert.match(logs.text(), /earliest byte: 100\nnext byte: 150\nend byte: 170\nExecution error: backend detail/u);
	assert.ok(logs.text().includes(`Continue with jobs ${JSON.stringify({ action: "logs", id: fullId, cursor: 150 })}`));
	assert.doesNotMatch(logs.text(), /Truncated|to expand/u);
});

test("managed Bash distinguishes the launch command, admission and an actual launch error", () => {
	setExpandKeys([]);
	const args = { background: true, timeout: 10, command: "one\ntwo\nthree\nfour\nfive\nsix" };
	const pending = card("bash", args);
	assert.match(pending.text(), /bash launch\ntimeout 10s\none\ntwo\nthree\nfour\nfive/u);
	assert.doesNotMatch(pending.text(), /six|expand/u);
	setExpandKeys(["ctrl+p"]);
	const launch = card("bash", args);
	assertHintAtEnd(launch.rows(), /^\.\.\. \(1 more line, ctrl\+p to expand\)$/u);
	const receipt = { job: { id: fullId, status: "running", startedAt: 0, observedAt: 0 } };
	launch.result(receipt, "Do not poll for completion.");
	assert.match(launch.text(), new RegExp(`Accepted job ${fullId}\\.`, "u"));
	assert.doesNotMatch(launch.text(), /ready|succeeded|elapsed|Do not poll|^six$/mu);
	assertHintAtEnd(launch.rows(), /^\.\.\. \(1 more line, ctrl\+p to expand\)$/u);
	launch.component.setExpanded(true);
	assert.match(launch.text(), /^six$/mu);
	assert.doesNotMatch(launch.text(), /expand/u);
	const refused = card("bash", args);
	refused.result(undefined, "Active job limit reached", true);
	assert.match(refused.text(), /Active job limit reached/u);
	assert.doesNotMatch(refused.text(), /Accepted job/u);
	const retained = card("bash", { command: "printf hello" });
	retained.result(receipt, "Do not poll for completion.");
	assert.match(
		retained.text(),
		/Accepted job/u,
		"the typed admission selects the owner result even without a launch flag",
	);
	assert.doesNotMatch(retained.text(), /Do not poll/u);
});

test("foreground Bash keeps its native prompt, output and measured time", () => {
	setExpandKeys(["ctrl+p"]);
	const shell = card("bash", { command: "printf hello" });
	shell.component.updateResult({
		content: [{ type: "text", text: "hello" }],
		details: undefined,
		isError: false,
		durationMs: 4200,
	});
	assert.match(shell.text(), /^\$ printf hello$/mu);
	assert.match(shell.text(), /^hello$/mu);
	assert.match(shell.text(), /^Took 4.2s$/mu);
	assert.doesNotMatch(shell.text(), /launch|Accepted job/u);
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

test("native snapshots preserve known identity and distinguish observation from job completion", () => {
	const input = { conversationId: 9, createdAt: 100, requestId: "r" } as JobInput;
	const base = { id: 4, conversationId: 9, kind: "jobs.run", input, abortRequested: false };
	const missing = jobFromRecord(
		{ ...base, state: { status: "running", checkpoint: { phase: "run", startedAt: 100 } } } as never,
		150,
	);
	assert.equal(missing.commandPreview, undefined);
	assert.equal(missing.cwd, undefined);
	assert.equal(missing.owner, "conversation:9");
	assert.equal(missing.status, "running");
	const result = { status: "lost", startedAt: 110, endedAt: 140, outputBytes: 0 };
	const record = {
		...base,
		input: { ...input, command: "printf lost", cwd: "/work", owner: "storage:9" },
		startedAt: 110,
		endedAt: 140,
		state: { status: "running", checkpoint: { phase: "deliver", result } },
	};
	const lost = jobFromRecord(record as never, 160);
	assert.equal(lost.commandPreview, "printf lost");
	assert.equal(lost.cwd, "/work");
	assert.equal(lost.owner, "storage:9");
	assert.equal(lost.status, "lost");
	assert.equal(lost.endedAt, 140);
	assert.equal(lost.observedAt, 160);
	assert.equal(jobFromRecord(record as never, 200).observedAt, 200);
	assert.equal(jobFromRecord(record as never).observedAt, undefined);
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
