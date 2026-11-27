import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	initTheme,
	ToolExecutionComponent,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { compile } from "@earendil-works/pi-schema";
import type { TUI } from "@earendil-works/pi-tui";
import { JOB_COMPLETION_MESSAGE } from "./completion.ts";
import { toolDisplay } from "./display.ts";
import { yieldClock, yieldSummary } from "./presentation.ts";
import {
	COMPLETE_ANSWER,
	COMPLETE_ANSWER_TYPE,
	registerYield,
	YIELD_DESCRIPTION,
	YIELD_ENDED_TEXT,
	YIELD_GUIDELINE,
	YIELD_NOTE_CHARS,
	YIELD_REFUSED,
	YIELD_ROWS,
	YIELD_SNIPPET,
	YIELD_TOOL,
	YieldOutputSchema,
	YieldParams,
	type YieldRow,
} from "./yield.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
const display = toolDisplay().tools.find((tool) => tool.name === YIELD_TOOL);

function fixture(mode = "tui", open: () => readonly YieldRow[] = () => [], now = () => 1_800_000_000_000) {
	let tool: ToolDefinition | undefined;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => {};
		},
	};
	registerYield(pi as unknown as ExtensionAPI, {
		open,
		now,
		renderCall: display?.renderCall,
		renderResult: display?.renderResult,
		renderShell: display?.renderShell,
	});
	assert.ok(tool);
	const registered = tool;
	const ctx = { mode };
	const emit = (name: string, event: Record<string, unknown>) =>
		(handlers.get(name) ?? []).map((handler) => handler({ type: name, ...event }, ctx)).at(-1);
	return {
		tool: registered,
		run: (input: unknown) => registered.execute("call", input as never, undefined, undefined, ctx as never),
		deliver: (message: Record<string, unknown>) => emit("message_end", { message }),
		settle: () => emit("agent_before_settle", { entries: [], continue: false }),
		settled: () => emit("agent_settled", { aborted: false }),
		start: (selectedTools: string[]) => {
			emit("before_agent_start", { systemPromptOptions: { selectedTools } });
			return selectedTools;
		},
	};
}

const USER = { role: "user", content: [{ type: "text", text: "Run the checks." }] };
const COMPLETION = { role: "custom", customType: JOB_COMPLETION_MESSAGE, content: "Background job succeeded." };
const PEER = { role: "custom", customType: "fixture.note", content: "Another message." };
const text = (value: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: value }] });
const RUNNING: YieldRow = { id: "4f2a9c1e-0000-4000-8000-000000000001", commandPreview: "npm test", state: "running" };
const SETTLED: YieldRow = {
	id: "7b3d2e10-0000-4000-8000-000000000002",
	commandPreview: "npm run lint",
	state: "settled",
};

describe("jobs_yield", () => {
	it("ends the turn with the note, the time and the jobs still to deliver", async () => {
		const result = await fixture(
			"tui",
			() => [RUNNING, SETTLED],
			() => 42,
		).run({ note: "The suite and the lint run; their results follow." });
		assert.equal(result.terminate, true);
		assert.deepEqual(result.content, [{ type: "text", text: YIELD_ENDED_TEXT }]);
		assert.deepEqual(result.details, {
			note: "The suite and the lint run; their results follow.",
			at: 42,
			jobs: [RUNNING, SETTLED],
		});
		assert.deepEqual((result as { structuredContent?: unknown }).structuredContent, result.details);
		assert.equal(compile(YieldOutputSchema).check(result.details), true);
	});

	it("bounds the listed jobs and counts the rest", async () => {
		const open = Array.from(
			{ length: YIELD_ROWS + 3 },
			(_, index): YieldRow => ({ id: `job-${index}`, state: "running" }),
		);
		const result = await fixture("tui", () => open).run({ note: "Many checks run." });
		const details = result.details as { jobs: YieldRow[]; omitted?: number };
		assert.deepEqual(details.jobs, open.slice(0, YIELD_ROWS));
		assert.equal(details.omitted, 3);
		assert.equal(compile(YieldOutputSchema).check(details), true);
	});

	it("fails without terminating when no job completion is coming", async () => {
		await assert.rejects(fixture().run({ note: "Done." }), (error: Error) => error.message === YIELD_REFUSED);
		assert.match(YIELD_REFUSED, /No job completion is coming/u);
		assert.match(YIELD_REFUSED, /text message/u);
		for (const input of [{}, { note: "" }, { note: "  " }, { note: "x".repeat(YIELD_NOTE_CHARS + 1) }])
			await assert.rejects(fixture("tui", () => [RUNNING]).run(input), /takes a note/u, JSON.stringify(input));
		const params = compile(YieldParams);
		assert.equal(params.check({ note: "x".repeat(YIELD_NOTE_CHARS) }), true);
		assert.equal(params.check({ note: "x".repeat(YIELD_NOTE_CHARS + 1) }), false);
		assert.equal(params.check({ note: "x", extra: true }), false);
	});

	it("describes its use, its note and Pi's batch rule in its own terms", () => {
		const f = fixture();
		assert.equal(f.tool.description, YIELD_DESCRIPTION);
		assert.equal(f.tool.promptSnippet, YIELD_SNIPPET);
		assert.deepEqual(f.tool.promptGuidelines, [YIELD_GUIDELINE]);
		assert.match(YIELD_DESCRIPTION, /background jobs of this session still run and no other work of yours is ready/u);
		assert.match(YIELD_DESCRIPTION, /what still runs and what happens next/u);
		assert.match(YIELD_DESCRIPTION, /every call in the last tool batch ends the turn/u);
		assert.match(YIELD_DESCRIPTION, /alone or with other calls that also end the turn/u);
		assert.match(
			YIELD_DESCRIPTION,
			/cover only this session's jobs: when other work of this session is also open and has its own tool that ends the turn, call that tool in the same batch/u,
		);
		const texts = [
			YIELD_DESCRIPTION,
			YIELD_SNIPPET,
			YIELD_GUIDELINE,
			YIELD_ENDED_TEXT,
			YIELD_REFUSED,
			COMPLETE_ANSWER,
		].join("\n");
		assert.doesNotMatch(
			texts,
			/\bagent_|delegat|nothing (is )?(needed|needs) (from )?you|needs? nothing from|nothing for you|\bwait/iu,
			"no sibling vocabulary, no wait wording and no pseudo-state line",
		);
	});

	it("is not offered in print and JSON runs", () => {
		for (const mode of ["print", "json"])
			assert.deepEqual(fixture(mode).start(["bash", "jobs", YIELD_TOOL, "read"]), ["bash", "jobs", "read"], mode);
		for (const mode of ["tui", "rpc"])
			assert.deepEqual(fixture(mode).start(["bash", YIELD_TOOL]), ["bash", YIELD_TOOL], mode);
	});

	it("asks print and JSON runs once for the complete answer after a job completion that follows their answer", () => {
		const request = {
			entries: [{ type: "custom_message", customType: COMPLETE_ANSWER_TYPE, content: COMPLETE_ANSWER, display: false }],
			continue: true,
		};
		for (const mode of ["print", "json"]) {
			const f = fixture(mode);
			f.deliver(USER);
			f.deliver(text("Report: the suite runs."));
			f.deliver(COMPLETION);
			f.deliver(text("The suite passed."));
			assert.deepEqual(f.settle(), request, mode);
			f.deliver(text("Report: the suite passed."));
			assert.equal(f.settle(), undefined, `${mode}: once for each late completion`);
		}

		const early = fixture("print");
		early.deliver(USER);
		early.deliver(COMPLETION);
		early.deliver(text("The suite passed."));
		assert.equal(early.settle(), undefined, "a completion before the first answer needs no restatement");

		const other = fixture("print");
		other.deliver(USER);
		other.deliver(text("Report."));
		other.deliver(PEER);
		other.deliver(text("Noted."));
		assert.equal(other.settle(), undefined, "only a job completion is this extension's input");

		const failed = fixture("print");
		failed.deliver(USER);
		failed.deliver({ role: "assistant", stopReason: "error", content: [{ type: "text", text: "partial" }] });
		failed.deliver(COMPLETION);
		assert.equal(failed.settle(), undefined, "an error is no answer");

		const nextRun = fixture("print");
		nextRun.deliver(USER);
		nextRun.deliver(text("Report."));
		nextRun.settled();
		nextRun.deliver(COMPLETION);
		nextRun.deliver(text("The suite passed."));
		assert.equal(nextRun.settle(), undefined, "a completion that starts a new run follows no answer of that run");

		const interactive = fixture("tui");
		interactive.deliver(USER);
		interactive.deliver(text("Report."));
		interactive.deliver(COMPLETION);
		assert.equal(interactive.settle(), undefined, "an operator reads the whole interactive transcript");
	});
});

describe("the jobs_yield card", () => {
	const theme = {
		fg: (_color: string, value: string) => value,
		bold: (value: string) => value,
		bg: (color: string, value: string) => `<${color}>${value}`,
		getBgAnsi: () => "",
	} as unknown as Theme;
	const today = new Date();
	const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 5).getTime();
	const note = "The test suite and the lint run in the background; each result follows as it settles. "
		.repeat(4)
		.trim();
	const details = { note, at, jobs: [RUNNING, SETTLED] };
	const base = {
		expanded: false,
		isError: false,
		keyText: (id: string) => (id === "app.tools.expand" ? "ctrl+o" : ""),
		outputPad: 1,
	};
	const plain = (lines: readonly string[] | undefined) =>
		(lines ?? []).map((line) =>
			stripVTControlCharacters(line)
				.replace(/<[A-Za-z]+>/gu, "")
				.trimEnd(),
		);

	function row(context: Record<string, unknown>, value: Record<string, unknown> = details, output = YIELD_ENDED_TEXT) {
		const f = fixture();
		const state: Record<string, unknown> = {};
		const shared = { ...base, ...context, state, args: { note: value.note } };
		const call = f.tool.renderCall?.({ note: value.note } as never, theme, shared as never);
		const result = f.tool.renderResult?.(
			{ content: [{ type: "text", text: output }], details: value } as never,
			{ expanded: shared.expanded === true, isPartial: false },
			theme,
			shared as never,
		);
		return { call, result };
	}

	it("is published by the jobs display and draws its own shell", () => {
		const f = fixture();
		assert.equal(display?.renderShell, "self");
		assert.equal(f.tool.renderShell, "self");
		assert.equal(f.tool.renderCall, display?.renderCall);
		assert.equal(f.tool.renderResult, display?.renderResult);
	});

	it("counts the jobs that remain with correct singulars", () => {
		assert.deepEqual(yieldSummary([RUNNING], 0), ["1 job still runs"]);
		assert.deepEqual(yieldSummary([RUNNING, RUNNING], 0), ["2 jobs still run"]);
		assert.deepEqual(yieldSummary([SETTLED], 0), ["1 job completion pending"]);
		assert.deepEqual(yieldSummary([RUNNING, SETTLED, SETTLED], 0), ["1 job still runs", "2 job completions pending"]);
		assert.deepEqual(yieldSummary([RUNNING], 4), ["5 jobs open"]);
	});

	it("draws the call in the message background while the note arrives and hides it once the result draws the card", () => {
		const f = fixture();
		const state: Record<string, unknown> = {};
		const call = f.tool.renderCall?.({ note: "The suite\nruns." } as never, theme, { ...base, state } as never);
		const streaming = call?.render(60) ?? [];
		assert.deepEqual(plain(streaming), [
			"",
			" jobs_yield Ending turn",
			"",
			" The suite",
			" ... (1 more line, ctrl+o to expand)",
			"",
		]);
		assert.ok(streaming.every((line) => line.startsWith("<customMessageBg>")));
		assert.ok(
			streaming.every((line) => stripVTControlCharacters(line).replace(/<[A-Za-z]+>/gu, "").length === 60),
			"the background reaches the edge",
		);
		f.tool.renderResult?.(
			{ content: [{ type: "text", text: YIELD_ENDED_TEXT }], details } as never,
			{ expanded: false, isPartial: false },
			theme,
			{ ...base, state, args: { note } } as never,
		);
		assert.deepEqual(call?.render(60), [], "the result slot draws the settled card");
	});

	it("shows the turn outcome, one note line and Pi's expansion hint when collapsed", () => {
		const lines = plain(row({}).result?.render(100));
		assert.equal(lines[1], " jobs_yield Turn ended · 1 job still runs · 1 job completion pending");
		assert.equal(lines.length, 6, "padding, title, blank, note, hint, padding");
		assert.match(lines[4] ?? "", /^ \.\.\. \(\d+ more lines?, ctrl\+o to expand\)$/u);
		assert.doesNotMatch(lines.join("\n"), /9:05 AM|npm test|starts the next turn/u, "details wait for expansion");
		assert.equal(
			plain(row({}, { ...details, note: "Short note." }).result?.render(100)).at(-2),
			" ... (ctrl+o to expand)",
		);
		const hinted = plain(
			row({ keyHint: (id: string, description: string) => `[${id}] ${description}` }).result?.render(100),
		);
		assert.match(hinted[4] ?? "", /^ \.\.\. \(\d+ more lines?, \[app\.tools\.expand\] to expand\)$/u);
	});

	it("expands to the whole note, the jobs and what starts the next turn", () => {
		const lines = plain(row({ expanded: true }).result?.render(100));
		const joined = lines.join("\n");
		assert.equal(lines.slice(2).join(" ").replace(/\s+/gu, " ").includes(note), true);
		assert.ok(joined.includes(`job ${RUNNING.id} · running · command preview: npm test`));
		assert.ok(joined.includes(`job ${SETTLED.id} · completion pending · command preview: npm run lint`));
		const long = plain(
			row(
				{ expanded: true },
				{ ...details, jobs: [{ ...RUNNING, commandPreview: `npm test -- ${"--flag ".repeat(30)}` }] },
			).result?.render(60),
		);
		assert.ok(
			long.some((row) => row.includes(`job ${RUNNING.id}`)),
			"the known ID is complete",
		);
		assert.ok(
			long.some((row) => row.includes("--flag")),
			"the expansion wraps the retained command preview",
		);
		assert.match(joined, /^ Each job completion starts the next turn\.$/mu);
		assert.doesNotMatch(joined, /to expand|nothing/iu);
		const omitted = plain(row({ expanded: true }, { ...details, omitted: 2 }).result?.render(100));
		assert.match(omitted.join("\n"), /^ \[Excerpt: 2 jobs not listed\]$/mu);
		assert.equal(omitted[2], " 4 jobs open · 9:05 AM");
	});

	it("shows local 12-hour time and includes the date outside today", () => {
		const now = new Date(2026, 10, 15, 18, 0).getTime();
		assert.equal(yieldClock(new Date(2026, 10, 15, 0, 5).getTime(), now), "12:05 AM");
		assert.equal(yieldClock(new Date(2026, 10, 15, 12, 0).getTime(), now), "12:00 PM");
		assert.equal(yieldClock(new Date(2026, 10, 14, 21, 30).getTime(), now), "14 Nov 9:30 PM");
		assert.equal(yieldClock(new Date(2025, 11, 31, 23, 59).getTime(), now), "31 Dec 2025 11:59 PM");
	});

	it("draws a refused call in the error background with its error", () => {
		const drawn = row({ isError: true }, { note: "Short note." }, YIELD_REFUSED).result?.render(200) ?? [];
		assert.ok(drawn.every((line) => line.startsWith("<toolErrorBg>")));
		assert.deepEqual(plain(drawn), [
			"",
			" jobs_yield Could not end the turn",
			"",
			" Short note.",
			"",
			` ${YIELD_REFUSED}`,
			"",
		]);
	});

	it("keeps narrow widths inside the card", () => {
		for (const width of [8, 20, 33]) {
			for (const expanded of [false, true]) {
				const lines = row({ expanded }).result?.render(width) ?? [];
				assert.ok(
					lines.every((line) => stripVTControlCharacters(line).replace(/<[A-Za-z]+>/gu, "").length === width),
					`width ${width}`,
				);
			}
		}
	});

	it("expands and collapses on a click inside Pi's tool row", async (t) => {
		initTheme("dark", false);
		const nativeTui = await import(
			createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")
		);
		const previous = nativeTui.getKeybindings();
		nativeTui.setKeybindings(
			new nativeTui.KeybindingsManager({
				...nativeTui.TUI_KEYBINDINGS,
				"app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" },
			}),
		);
		t.after(() => nativeTui.setKeybindings(previous));
		const f = fixture();
		const component = new ToolExecutionComponent(
			YIELD_TOOL,
			"call-yield",
			{ note },
			undefined,
			f.tool,
			{ requestRender() {} } as unknown as TUI,
			".",
		);
		component.updateResult({ content: [{ type: "text", text: YIELD_ENDED_TEXT }], details, isError: false });
		const width = 100;
		const lines = () => component.render(width).map((line) => stripVTControlCharacters(line));
		const click = (y: number) =>
			component.handleMouse({
				type: "click",
				button: "left",
				x: 4,
				y,
				screenX: 4,
				screenY: y,
				width,
				height: lines().length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			} as never);
		assert.match(lines().join("\n"), /\.\.\. \(\d+ more lines?, ctrl\+o to expand\)/u);
		const noteRow = lines().findIndex((line) => line.includes("The test suite and the lint"));
		assert.ok(noteRow > 0);
		assert.equal(click(noteRow)?.handled, true);
		assert.match(lines().join("\n"), /Each job completion starts the next turn\./u);
		const titleRow = lines().findIndex((line) => line.includes("jobs_yield Turn ended"));
		assert.equal(click(titleRow)?.handled, true);
		assert.doesNotMatch(lines().join("\n"), /Each job completion starts the next turn\./u);
	});
});
