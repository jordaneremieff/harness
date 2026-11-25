import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { type JobSnapshot, pageLogs } from "./manager.ts";
import {
	elapsedText,
	emptyText,
	folderText,
	type JobsSource,
	JobsView,
	jobRows,
	outcomeText,
	outputLines,
	summaryText,
	viewRows,
} from "./view.ts";

const NOW = 1_000_000;
const plain = {
	fg: (_colour: string, text: string) => text,
	bg: (_colour: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
/** Colours as tags, so a test can read which theme colour a glyph has. */
const tagged = {
	fg: (colour: string, text: string) => `<${colour}>${text}`,
	bg: (_colour: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function job(id: string, fields: Partial<JobSnapshot>): JobSnapshot {
	return { id, status: "running", startedAt: NOW - 5_000, cancellationRequested: false, ...fields };
}

const JOBS: JobSnapshot[] = [
	job("ok", {
		status: "succeeded",
		commandPreview: "git log --oneline -12",
		startedAt: NOW - 60_000,
		endedAt: NOW - 59_000,
		exitCode: 0,
	}),
	job("run", { commandPreview: "npm test", startedAt: NOW - 125_000, cwd: "/work/harness" }),
	job("bad", {
		status: "failed",
		commandPreview: "npm run typecheck",
		startedAt: NOW - 30_000,
		endedAt: NOW - 26_000,
		exitCode: 2,
	}),
];

function source(jobs: JobSnapshot[], output: Record<string, string> = {}, earlier = 0) {
	const cancelled: string[] = [];
	const value: JobsSource = {
		list: () => jobs,
		logs: (id, cursor) => {
			const buffer = Buffer.from(output[id] ?? "");
			return pageLogs(id, buffer, buffer.length, false, cursor);
		},
		cancel: (id) => {
			cancelled.push(id);
			const target = jobs.find((entry) => entry.id === id);
			if (target) target.cancellationRequested = true;
		},
		started: () => earlier + jobs.length,
	};
	return { value, cancelled };
}

function view(jobs: JobSnapshot[], output: Record<string, string> = {}, theme = plain) {
	const { value, cancelled } = source(jobs, output);
	let closes = 0;
	const selected: { id?: string } = {};
	const component = new JobsView({
		source: value,
		theme,
		rows: () => 14,
		requestRender: () => {},
		close: () => {
			closes += 1;
		},
		now: () => NOW,
		selected,
	});
	return { component, cancelled, selected, closes: () => closes };
}

function click(x: number, y: number, width = 80, height = 14): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
	} as TuiMouseEvent;
}

describe("jobs view", () => {
	it("lists the jobs that run first, then the jobs that ended, newest first in each", () => {
		const rows = jobRows(JOBS, NOW);
		assert.deepEqual(
			rows.map((row) => [row.id, row.word, row.elapsed, row.command]),
			[
				["run", "running", "2m 05s", "npm test"],
				["bad", "failed", "4s", "npm run typecheck"],
				["ok", "succeeded", "1s", "git log --oneline -12"],
			],
		);
		const states = jobRows(
			[
				job("b", { status: "timed_out", endedAt: NOW - 1, timeoutSeconds: 5 }),
				job("c", { status: "cancelled", endedAt: NOW }),
				job("a", { cancellationRequested: true }),
			],
			NOW,
		);
		assert.deepEqual(
			states.map((row) => row.word),
			["stopping", "cancelled", "timed out"],
		);
	});

	it("writes elapsed time in at most two units", () => {
		assert.equal(elapsedText(-5), "0s");
		assert.equal(elapsedText(59_999), "59s");
		assert.equal(elapsedText(65_000), "1m 05s");
		assert.equal(elapsedText(3_840_000), "1h 04m");
	});

	it("names the outcome and folder of the selected job on its output rule", () => {
		const [run, bad, ok] = jobRows(JOBS, NOW);
		assert.ok(bad && ok && run);
		assert.equal(outcomeText(bad), "exit 2");
		assert.equal(outcomeText(ok), "", "a success needs no exit code");
		assert.equal(outcomeText({ ...run, cwd: "/work/\x1b[31mred\nfolder" }), "/work/red folder");
		assert.equal(outcomeText(run), "/work/harness");
		const [timedOut] = jobRows([job("t", { status: "timed_out", endedAt: NOW, timeoutSeconds: 5 })], NOW);
		assert.ok(timedOut);
		assert.equal(outcomeText(timedOut), "limit 5s");
		assert.equal(folderText("/accounts/me/work", "/accounts/me"), "~/work");
		assert.equal(folderText("/accounts/meadow", "/accounts/me"), "/accounts/meadow");
	});

	it("keeps the last output lines as a terminal leaves them", () => {
		const { value } = source([], { a: "one\r\ntwo\rTWO\n\x1b[31mred\x1b[0m\tend\n" });
		assert.deepEqual(outputLines(value, "a"), ["one", "TWO", "red  end"]);
		assert.deepEqual(outputLines(value, "none"), []);
	});

	it("summarises the jobs outside the interactive terminal", () => {
		assert.equal(summaryText([], NOW, 0), "No background jobs in this session.");
		assert.equal(summaryText([], NOW, 3), emptyText(3));
		assert.match(emptyText(3), /^No background jobs since Pi started\./u);
		assert.equal(
			summaryText(JOBS, NOW, 5),
			[
				"Jobs: 1 running · 5 started",
				"● running 2m 05s  npm test",
				"● failed 4s  npm run typecheck",
				"○ succeeded 1s  git log --oneline -12",
			].join("\n"),
		);
	});

	it("takes 60% of the rows and leaves transcript rows above it", () => {
		assert.equal(viewRows(40), 24);
		assert.equal(viewRows(10), 8);
		assert.equal(viewRows(200), 120);
	});

	it("draws the title, the list, the selected job's output and the key row in exactly its rows", () => {
		const { component } = view(JOBS, { run: "ok 11 - parse\nok 12 - suite\n" });
		const lines = component.render(60);
		assert.equal(lines.length, 14);
		assert.ok(lines.every((line) => line.length === 60));
		assert.match(lines[0] ?? "", /^─ Jobs ─+ 1 running · 3 started ─$/u);
		assert.match(lines[1] ?? "", /^›● running {4}2m 05s {2}npm test/u);
		assert.match(lines[2] ?? "", /^ ● failed {9}4s {2}npm run typecheck/u);
		assert.match(lines[3] ?? "", /^ ○ succeeded {6}1s {2}git log/u);
		assert.match(lines[4] ?? "", /^─ Output ─+ \/work\/harness ─$/u);
		assert.equal(lines[5]?.trimEnd(), " ok 11 - parse");
		assert.equal(lines[6]?.trimEnd(), " ok 12 - suite");
		assert.equal(lines[13]?.trimEnd(), " ↑↓ select  c cancel  esc close");
	});

	it("colours dots as the footer does: yellow running, red failed, grey hollow otherwise", () => {
		const { component } = view(JOBS, {}, tagged);
		const lines = component.render(80);
		assert.ok(lines[1]?.includes("<warning>●"));
		assert.ok(lines[2]?.includes("<error>●"));
		assert.ok(lines[3]?.includes("<muted>○"));
	});

	it("selects with the arrow keys, cancels only a running job, and closes on Escape", () => {
		const jobs = JOBS.map((entry) => ({ ...entry }));
		const { component, cancelled, selected, closes } = view(jobs, {
			bad: "src/a.ts(3,1): error TS2304\nFound 1 error.\n",
		});
		component.handleInput("c");
		assert.deepEqual(cancelled, ["run"]);
		let lines = component.render(60);
		assert.match(lines[1] ?? "", /● stopping/u);
		assert.equal(lines[13]?.trimEnd(), " ↑↓ select  esc close", "a stopping job is not cancelled again");
		component.handleInput("\x1b[B");
		lines = component.render(60);
		assert.match(lines[4] ?? "", /^─ Output ─+ exit 2 ─$/u);
		assert.equal(lines[5]?.trimEnd(), " src/a.ts(3,1): error TS2304");
		assert.equal(lines[13]?.trimEnd(), " ↑↓ select  esc close", "a finished job offers no cancel");
		component.handleInput("c");
		assert.deepEqual(cancelled, ["run"], "a finished job is not cancelled");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		assert.equal(selected.id, "ok", "the selection stops at the last row");
		component.handleInput("q");
		assert.equal(closes(), 0, "q is not a way out");
		component.handleInput("\x1b");
		assert.equal(closes(), 1);
	});

	it("selects a clicked row and runs a clicked key-row control", () => {
		const jobs = JOBS.map((entry) => ({ ...entry }));
		const { component, cancelled, selected, closes } = view(jobs);
		component.render(80);
		assert.deepEqual(component.handleMouse({ ...click(10, 3), type: "press" }), { handled: true });
		assert.equal(selected.id, "run", "a press claims the row but only a click selects it");
		assert.deepEqual(component.handleMouse(click(10, 3)), { handled: true });
		assert.equal(selected.id, "ok");
		let row = component.render(80)[13] ?? "";
		assert.deepEqual(component.handleMouse(click(row.indexOf("↑"), 13)), { handled: true });
		assert.equal(selected.id, "bad");
		assert.deepEqual(component.handleMouse(click(row.indexOf("↑"), 13)), { handled: true });
		assert.equal(selected.id, "run");
		row = component.render(80)[13] ?? "";
		assert.deepEqual(component.handleMouse(click(row.indexOf("c cancel"), 13)), { handled: true });
		assert.deepEqual(cancelled, ["run"]);
		component.render(80);
		assert.equal(component.handleMouse(click(10, 3, 79)), undefined, "a click at another size does nothing");
		const keys = component.render(80)[13] ?? "";
		component.handleMouse(click(keys.indexOf("esc"), 13));
		assert.equal(closes(), 1);
	});

	it("keeps the selection when a newer job starts, and moves it when its job leaves", () => {
		const jobs = JOBS.map((entry) => ({ ...entry }));
		const { component, selected } = view(jobs);
		component.handleInput("\x1b[B");
		assert.equal(selected.id, "bad");
		jobs.push(job("new", { commandPreview: "npm run lint", startedAt: NOW }));
		component.refresh();
		assert.equal(selected.id, "bad");
		jobs.splice(0, jobs.length);
		component.refresh();
		assert.equal(selected.id, undefined);
	});

	it("says when the session has no jobs in three rows and offers only Escape", () => {
		const { component } = view([]);
		const lines = component.render(60);
		assert.equal(lines.length, 3);
		assert.match(lines[0] ?? "", /^─ Jobs ─+$/u, "no counts while nothing started");
		assert.equal(lines[1]?.trimEnd(), " No background jobs in this session.");
		assert.equal(lines[2]?.trimEnd(), " esc close");
	});

	it("wraps long output lines and keeps the newest rows", () => {
		const long = `error: ${"x".repeat(70)} end`;
		const { component } = view([job("run", { commandPreview: "npm test" })], { run: `first\n${long}\n` });
		const lines = component.render(40).map((line) => line.trimEnd());
		const output = lines.slice(lines.findIndex((line) => line.startsWith("─ Output")) + 1, 13);
		assert.deepEqual(output.slice(0, 4), [" first", " error:", ` ${"x".repeat(39)}`, ` ${"x".repeat(31)} end`]);
	});

	it("shows that a running job has no output yet", () => {
		const { component } = view([job("run", { commandPreview: "npm test" })]);
		const lines = component.render(60);
		assert.equal(lines[3]?.trimEnd(), " No output yet.");
	});
});
