import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import type { ContinuityFact } from "./continuity-facts.ts";
import { dashboardClock } from "./dashboard-time.ts";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { ORDINARY_COMPLETE_ANSWER, ORDINARY_COMPLETE_ANSWER_TYPE, ORDINARY_CONTINUE_TEXT, ORDINARY_NOTE_CHARS, ORDINARY_TEXT_ANSWER, ORDINARY_TEXT_REFUSED, ORDINARY_TEXT_REQUESTS, ORDINARY_YIELD_TOOL, ORDINARY_WAITING_ROWS, ORDINARY_WORK_DESCRIPTION, OrdinaryWorkOutputSchema, OrdinaryWorkParams, registerOrdinaryWork, type OrdinaryWorkOptions } from "./ordinary-work.ts";
import { matchesSchema } from "./schema-check.ts";
import { ordinaryWorkCard, type AgentCardLookup } from "./tool-cards.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value, bg: (color: string, value: string) => `<${color}>${value}`, getBgAnsi: () => "" } as unknown as Theme;

/** An object whose every member except the named ones throws, so a test shows what the code does not use. */
function only<T extends object>(members: T, name: string): T {
	return new Proxy(members, { get: (target, key) => { if (key in target) return target[key as keyof T]; throw new Error(`${name} must not use ${String(key)}`); } });
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function fixture(mode = "tui", options: OrdinaryWorkOptions = {}, lookup: AgentCardLookup = () => []) {
	let tool: ToolDefinition | undefined;
	const handlers = new Map<string, Handler>();
	const card = ordinaryWorkCard(ORDINARY_YIELD_TOOL, lookup);
	const registration = { registerTool: (definition: ToolDefinition) => { tool = definition; }, on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => {}; } };
	registerOrdinaryWork(only(registration, "the registration") as unknown as ExtensionAPI, card, options);
	assert.ok(tool);
	const registered = tool;
	assert.equal(registered.renderCall, card.renderCall, "the registered renderers are the caller's card references");
	assert.equal(registered.renderResult, card.renderResult);
	assert.equal(registered.renderShell, "self", "the card draws its own background, not a tool outcome background");
	let aborts = 0;
	const members: Record<string, unknown> = { mode, abort: () => { aborts++; } };
	if (options.waiting) members.sessionManager = { getSessionId: () => "primary-session" };
	const context = only(members, "the tool") as unknown as ExtensionContext;
	return {
		tool: registered,
		aborts: () => aborts,
		run: (input: unknown) => registered.execute("call", input as never, undefined, undefined, context as never),
		/** A message that the agent loop delivers. */
		deliver: (message: Record<string, unknown>) => handlers.get("message_end")?.({ type: "message_end", message }, context),
		settle: () => handlers.get("agent_before_settle")?.({ type: "agent_before_settle", entries: [], continue: false }, context),
		/** The run has fully settled. */
		settled: () => handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, context),
	};
}

const USER = { role: "user", content: [{ type: "text", text: "Review it." }] };
const FOLLOW_UP = { role: "custom", customType: "fixture.completion", content: "The background check finished." };
const PEER = { role: "custom", customType: "agent.peer", content: "The reviewer finished." };
const text = (value: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: value }] });

it("continues a print or JSON run to a text answer, because its output is its last text message", async () => {
	const note = "The review finished; its findings are in the answer above.";
	for (const mode of ["print", "json"]) {
		const result = await fixture(mode).run({ note });
		assert.notEqual(result.terminate, true, mode);
		assert.deepEqual(result.content, [{ type: "text", text: ORDINARY_TEXT_ANSWER }], mode);
		assert.deepEqual(result.details, { note }, mode);
	}
	for (const mode of ["tui", "rpc"]) assert.equal((await fixture(mode).run({ note })).terminate, true, mode);
	assert.match(ORDINARY_TEXT_ANSWER, /complete final answer/u);
});

it("never ends a print run in the call, and stops a run that calls it again after two reminders since the latest input", async () => {
	const note = "Nothing remains.";
	const reminder = [{ type: "text", text: ORDINARY_TEXT_ANSWER }];
	for (const mode of ["print", "json"]) {
		const f = fixture(mode);
		f.deliver(USER);
		assert.deepEqual((await f.run({ note })).content, reminder, `${mode}: the first reminder`);
		assert.deepEqual((await f.run({ note })).content, reminder, `${mode}: a second reminder`);
		await assert.rejects(f.run({ note }), (error: Error) => error.message === ORDINARY_TEXT_REFUSED, mode);
		assert.equal(f.aborts(), 1, `${mode}: a further call aborts the run`);
	}

	const f = fixture("print");
	f.deliver(USER);
	await f.run({ note });
	await f.run({ note });
	f.deliver(USER);
	assert.deepEqual((await f.run({ note })).content, reminder, "a user message starts a new count");
	await f.run({ note });
	f.deliver(FOLLOW_UP);
	assert.deepEqual((await f.run({ note })).content, reminder, "a delivered custom message of any extension starts a new count");
	await f.run({ note });
	f.deliver({ role: "custom", customType: ORDINARY_COMPLETE_ANSWER_TYPE, content: ORDINARY_COMPLETE_ANSWER });
	await assert.rejects(f.run({ note }), (error: Error) => error.message === ORDINARY_TEXT_REFUSED, "the extension's own request is not an input");
	assert.equal(f.aborts(), 1);
	assert.equal(ORDINARY_TEXT_REQUESTS, 2);
});

it("asks once more for the complete answer when a message from another session arrives after the answer of a print or JSON run", async () => {
	const request = { entries: [{ type: "custom_message", customType: ORDINARY_COMPLETE_ANSWER_TYPE, content: ORDINARY_COMPLETE_ANSWER, display: false }], continue: true };
	for (const mode of ["print", "json"]) {
		const f = fixture(mode);
		f.deliver(USER);
		f.deliver(text("Report: three findings."));
		f.deliver(PEER);
		f.deliver(text("The reviewer agrees."));
		assert.deepEqual(f.settle(), request, `${mode}: the reply to the message alone would be printed`);
		f.deliver(text("Report: three findings. The reviewer agrees."));
		assert.equal(f.settle(), undefined, `${mode}: one request for each later message`);
	}

	const other = fixture("print");
	other.deliver(USER);
	other.deliver(text("Report: three findings."));
	other.deliver(FOLLOW_UP);
	other.deliver(text("The check passed."));
	assert.equal(other.settle(), undefined, "a follow-up of another extension is that extension's to answer");

	const first = fixture("print");
	first.deliver(USER);
	first.deliver(PEER);
	first.deliver(text("The reviewer agrees."));
	assert.equal(first.settle(), undefined, "a message before the first answer needs no restatement");

	const reminded = fixture("print");
	reminded.deliver(USER);
	reminded.deliver(text("Report."));
	reminded.deliver(PEER);
	await reminded.run({ note: "Done." });
	reminded.deliver(text("Report. The reviewer agrees."));
	assert.equal(reminded.settle(), undefined, "the reminder already asked for the complete answer");

	const failed = fixture("print");
	failed.deliver(USER);
	failed.deliver({ role: "assistant", stopReason: "error", content: [{ type: "text", text: "partial" }] });
	failed.deliver(PEER);
	assert.equal(failed.settle(), undefined, "an error is no answer");

	const nextRun = fixture("print");
	nextRun.deliver(USER);
	nextRun.deliver(text("Report."));
	assert.equal(nextRun.settle(), undefined);
	nextRun.settled();
	nextRun.deliver(PEER);
	nextRun.deliver(text("Noted."));
	assert.equal(nextRun.settle(), undefined, "a custom message that starts a new run follows no answer of that run");

	const interactive = fixture("tui");
	interactive.deliver(USER);
	interactive.deliver(text("Report."));
	interactive.deliver(PEER);
	assert.equal(interactive.settle(), undefined, "an operator reads the whole interactive transcript");
});

it("ends the turn in the call, takes only a note, and keeps the note nowhere outside the call", async () => {
	const f = fixture("tui", { now: () => 1_800_000_000_000 });
	const note = "Two workers review the parser. Their results arrive as events and start the next turn.";
	const result = await f.run({ note });
	assert.equal(result.terminate, true, "no model request follows the only call of its batch");
	assert.deepEqual(result.content, [{ type: "text", text: ORDINARY_CONTINUE_TEXT }], "the model receives only the instruction, not the card facts");
	assert.deepEqual(result.details, { note, at: 1_800_000_000_000, waiting: [] }, "no widget and no session entry: the card facts live in the call's result");
	assert.deepEqual((result as { structuredContent?: unknown }).structuredContent, result.details);
	assert.equal(matchesSchema(OrdinaryWorkOutputSchema, result.details), true);
	assert.equal((await f.run({ note: "One result is in; one worker still runs." })).terminate, true, "each call stands alone");

	for (const input of [{}, { note: "" }, { note, results: [] }, { action: "continue", note }, { action: "complete" }]) {
		await assert.rejects(f.run(input), (error: Error) => error.message === "agent_yield takes a note", JSON.stringify(input));
	}
	assert.equal(matchesSchema(OrdinaryWorkParams, { note: "x".repeat(ORDINARY_NOTE_CHARS) }), true);
	assert.equal(matchesSchema(OrdinaryWorkParams, { note: "x".repeat(ORDINARY_NOTE_CHARS + 1) }), false);

	assert.match(ORDINARY_WORK_DESCRIPTION, /Put no internal identifier in the note \(no session, submission or request ID\)/u, "the note is text for the operator");
	assert.doesNotMatch(ORDINARY_WORK_DESCRIPTION, /widget|complete|result references\)/u, "the tool keeps no state to clear and asks for no reference");
	assert.match(ORDINARY_WORK_DESCRIPTION, /work that this session sent to agents is still open/u, "the use condition is the state of the agent work");
	assert.match(ORDINARY_WORK_DESCRIPTION, /every call in the last tool batch ends the turn: make this call in the last batch, alone or with other calls that also end the turn/u);
	assert.match(ORDINARY_WORK_DESCRIPTION, /cover only work sent to agents: when other work of this session also runs and has its own tool that ends the turn, call that tool in the same batch/u, "other open work gets its own card");
	const texts = [ORDINARY_WORK_DESCRIPTION, f.tool.promptSnippet ?? "", f.tool.label, ORDINARY_CONTINUE_TEXT].join("\n");
	assert.doesNotMatch(texts, /\bwait|background job|jobs?\b|nothing (is )?(needed|needs) (from )?you|needs? nothing from|nothing for you/iu, "no wait wording, no job vocabulary and no pseudo-state line");
	assert.match(f.tool.promptSnippet ?? "", /no chat text/u);
});

it("records when the turn ended and the open requests of the session for the card", async () => {
	const open: ContinuityFact[] = [
		{ phase: "admitted", sessionId: "worker-a", requestId: "a", replyTo: "primary-session", submissionId: 1 },
		{ phase: "requested", sessionId: "worker-b", requestId: "b", replyTo: "primary-session" },
		{ phase: "requested", sessionId: "worker-c", requestId: "c", replyTo: "primary-session", timerId: 2 },
	];
	const asked: string[] = [];
	const f = fixture("tui", { now: () => 7, waiting: (sessionId) => { asked.push(sessionId); return open; } });
	const result = await f.run({ note: "Three requests are open." });
	assert.deepEqual(asked, ["primary-session"], "the open requests of the calling session");
	assert.deepEqual(result.details, { note: "Three requests are open.", at: 7, waiting: [
		{ sessionId: "worker-a", state: "admitted" }, { sessionId: "worker-b", state: "unconfirmed" }, { sessionId: "worker-c", state: "scheduled" },
	] });

	const many = Array.from({ length: ORDINARY_WAITING_ROWS + 3 }, (_, index): ContinuityFact => ({ phase: "admitted", sessionId: `worker-${index}`, requestId: `r${index}`, replyTo: "primary-session", submissionId: index + 1 }));
	const bounded = await fixture("tui", { now: () => 7, waiting: () => many }).run({ note: "Many requests are open." });
	const details = bounded.details as { waiting: unknown[]; waitingOmitted?: number };
	assert.equal(details.waiting.length, ORDINARY_WAITING_ROWS);
	assert.equal(details.waitingOmitted, 3, "rows beyond the bound are counted, not listed");
	assert.equal(matchesSchema(OrdinaryWorkOutputSchema, bounded.details), true);

	const printed = await fixture("print", { now: () => 7, waiting: () => open }).run({ note: "Done." });
	assert.deepEqual(printed.details, { note: "Done." }, "a run without an operator view records no card facts");
});

describe("the state note card", () => {
	const rows = [
		{ id: "worker-a", name: "Parser review", model: { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" }, state: "working" },
		{ id: "worker-b", name: "Lint sweep", state: "done" },
	] as unknown as AgentConversationSummary[];
	const at = Date.UTC(2026, 10, 14, 11, 58);
	const note = "Two workers run the parser review; their results arrive as events and start the next turn. ".repeat(4).trim();
	const details = { note, at, waiting: [{ sessionId: "worker-a", state: "admitted" }, { sessionId: "worker-b", state: "admitted" }, { sessionId: "worker-z", state: "scheduled" }] };
	const base = { expanded: false, isError: false, keyText: (id: string) => id === "app.tools.expand" ? "ctrl+o" : "", outputPad: 1 };

	function row(context: Record<string, unknown>, value: Record<string, unknown> = details, output = ORDINARY_CONTINUE_TEXT) {
		const f = fixture("tui", {}, () => rows);
		const state: Record<string, unknown> = {};
		const shared = { ...base, ...context, state, args: { note: value.note } };
		const call = f.tool.renderCall?.({ note: value.note } as never, theme, shared as never);
		const result = f.tool.renderResult?.({ content: [{ type: "text", text: output }], details: value } as never, { expanded: shared.expanded === true, isPartial: false }, theme, shared as never);
		return { f, call, result, state, shared };
	}
	const plain = (lines: readonly string[] | undefined) => (lines ?? []).map((line) => stripVTControlCharacters(line).replace(/<[A-Za-z]+>/gu, "").trimEnd());

	it("draws the call in the message background while the note arrives, and hides it once the result draws the card", () => {
		const f = fixture();
		const state: Record<string, unknown> = {};
		const call = f.tool.renderCall?.({ note: "Two workers run;\ntheir results follow." } as never, theme, { ...base, state } as never);
		const streaming = call?.render(60) ?? [];
		assert.deepEqual(plain(streaming), ["", " agent_yield · ending turn", " Two workers run; their results follow.", ""], "white space collapses, and an unsettled call shows no hint");
		assert.ok(streaming.every((line) => line.startsWith("<customMessageBg>")), "the message background, not a tool outcome background");
		assert.ok(streaming.every((line) => stripVTControlCharacters(line).replace(/<[A-Za-z]+>/gu, "").length === 60), "every line keeps the background to the edge");
		const again = f.tool.renderCall?.({ note: "later" } as never, theme, { ...base, state, lastComponent: call } as never);
		assert.equal(again, call, "a rerender reuses the component");
		f.tool.renderResult?.({ content: [{ type: "text", text: ORDINARY_CONTINUE_TEXT }], details: { note: "later", at, waiting: [] } } as never, { expanded: false, isPartial: false }, theme, { ...base, state, args: { note: "later" } } as never);
		assert.deepEqual(call?.render(60), [], "the result slot draws the settled card");
	});

	it("says that the turn ended, which results are due and when, and shows three note lines with Pi's expansion hint", () => {
		const { result } = row({});
		const lines = plain(result?.render(100));
		assert.equal(lines[1], ` agent_yield · turn ended · 2 agent results due · 1 scheduled input · ${dashboardClock(at)}`, "the title names the tool, then what happened");
		assert.equal(lines.length, 1 + 1 + 3 + 1 + 1, "padding, title, three note lines, hint, padding");
		assert.match(lines[5] ?? "", /^ \.\.\. \(\d+ more lines?, ctrl\+o to expand\)$/u, "the hint of Pi's tool cards, without a click instruction");
		assert.ok(lines.slice(2, 5).every((line) => !line.endsWith("…")), "collapsed note lines end at word boundaries without a clipped tail");
		assert.doesNotMatch(lines.join("\n"), /Parser review|starts the next turn/u, "details stay hidden until expansion");
		const short = plain(row({}, { ...details, note: "Short note." }).result?.render(100));
		assert.equal(short.at(-2), " ... (ctrl+o to expand)", "a note that fits still points to the details");
		const hinted = plain(row({ keyHint: (id: string, description: string) => `[${id}] ${description}` }).result?.render(100));
		assert.match(hinted[5] ?? "", /^ \.\.\. \(\d+ more lines?, \[app\.tools\.expand\] to expand\)$/u, "Pi's own key hint formats the key when the context supplies it");
	});

	it("expands to the whole note, the agents whose results were due with their current state, and what ended the turn", () => {
		const { result } = row({ expanded: true });
		const lines = plain(result?.render(100));
		const text = lines.join("\n");
		assert.equal(lines.slice(2).join(" ").replace(/\s+/gu, " ").includes(note), true, "the complete note");
		assert.match(text, /Results due from:/u);
		assert.match(text, /^ {3}Parser review · anthropic\/claude-opus-5-5 · high · now working$/mu);
		assert.match(text, /^ {3}Lint sweep · now done$/mu);
		assert.match(text, /^ {3}worker-z · scheduled input$/mu, "an unknown agent keeps its exact identity");
		assert.match(lines.join(" ").replace(/\s+/gu, " "), /A result or message from an agent, or your input, starts the next turn\./u, "the expanded card says whose turn ended and what starts the next one");
		assert.doesNotMatch(text, /to expand/u);
	});

	it("draws a failed call in the error background with its error", () => {
		const { result } = row({ isError: true }, { note: "Short note." }, "agent_yield takes a note");
		const drawn = result?.render(60) ?? [];
		assert.ok(drawn.every((line) => line.startsWith("<toolErrorBg>")));
		assert.deepEqual(plain(drawn), ["", " agent_yield · could not end the turn", " Short note.", " agent_yield takes a note", ""], "no expansion hint when nothing is hidden");
	});

	it("expands and collapses on a plain click anywhere on the card inside Pi's tool row", async (t) => {
		initTheme("dark", false);
		// Pi's renderer context formats the key from the pi-tui copy that the coding agent resolves.
		const nativeTui = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));
		const previous = nativeTui.getKeybindings();
		nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ ...nativeTui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
		t.after(() => nativeTui.setKeybindings(previous));
		const f = fixture("tui", {}, () => rows);
		const component = new ToolExecutionComponent("agent_yield", "call-wait", { note }, undefined, f.tool, { requestRender() {} } as unknown as TUI, ".");
		component.updateResult({ content: [{ type: "text", text: ORDINARY_CONTINUE_TEXT }], details, isError: false });
		const width = 100;
		const lines = () => component.render(width).map((line) => stripVTControlCharacters(line));
		const click = (y: number) => component.handleMouse({ type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width, height: lines().length, shift: false, alt: false, ctrl: false, clickCount: 1 } as never);
		const collapsed = lines();
		assert.match(collapsed.join("\n"), /\.\.\. \(\d+ more lines?, ctrl\+o to expand\)/u);
		assert.doesNotMatch(collapsed.join("\n"), /Results due from:|click/u);
		const noteRow = collapsed.findIndex((line) => line.includes("Two workers run the parser review"));
		assert.ok(noteRow > 0);
		assert.equal(click(noteRow)?.handled, true, "a click on the note text expands the card");
		assert.match(lines().join("\n"), /Results due from:/u);
		assert.doesNotMatch(lines().join("\n"), /to expand/u);
		const titleRow = lines().findIndex((line) => line.includes("agent_yield · turn ended"));
		assert.equal(click(titleRow)?.handled, true, "a click on the title collapses it again");
		assert.doesNotMatch(lines().join("\n"), /Results due from:/u);
	});

	it("keeps narrow widths inside the card", () => {
		for (const width of [8, 20, 33]) {
			const lines = row({}).result?.render(width) ?? [];
			assert.ok(lines.every((line) => stripVTControlCharacters(line).replace(/<[A-Za-z]+>/gu, "").length === width), `width ${width}`);
		}
	});
});
