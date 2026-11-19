import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	initTheme,
	type EntryRenderOptions,
	type ExtensionAPI,
	type MessageRenderOptions,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { COMMAND_HELP, judgmentPrompt, judgmentRequestOf } from "./commands.ts";
import pillarsExtension from "./index.ts";
import {
	JUDGMENT_REQUEST_MESSAGE,
	renderJudgmentRequestMessage,
	renderViewEntry,
	requestSummary,
	VIEW_ENTRY,
	type ViewEntryData,
} from "./request-card.ts";

initTheme();

const colors: Array<{ color: string; value: string }> = [];
const theme = {
	fg: (color: string, value: string) => {
		colors.push({ color, value });
		return value;
	},
	bg: (_color: string, value: string) => value,
	bold: (value: string) => value,
	getBgAnsi: () => "",
} as unknown as Theme;
const ansiTheme = {
	fg: (_color: string, value: string) => `\x1b[38;5;1m${value}\x1b[39m`,
	bg: (_color: string, value: string) => `\x1b[48;5;2m${value}\x1b[49m`,
	bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
	getBgAnsi: () => "\x1b[48;5;2m",
} as unknown as Theme;

function options(expanded: boolean, key = "ctrl+o"): MessageRenderOptions {
	return {
		expanded,
		outputPad: 1,
		keyText: () => key,
		keyHint: (_binding: string, description: string) => `${key} ${description}`,
	} as unknown as MessageRenderOptions;
}

function render(content: string, expanded = false, key = "ctrl+o", width = 80): string[] {
	const message = {
		role: "custom" as const,
		customType: JUDGMENT_REQUEST_MESSAGE,
		display: true,
		timestamp: 0,
		content,
	};
	const component = renderJudgmentRequestMessage(message, options(expanded, key), theme);
	assert.ok(component);
	return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

function view(data: ViewEntryData, width = 80, card = theme): string[] {
	const component = renderViewEntry(
		{ type: "custom", customType: VIEW_ENTRY, data, id: "e", parentId: null, timestamp: "" },
		{ expanded: false } as EntryRenderOptions,
		card,
	);
	assert.ok(component);
	return component.render(width).map((line) => (card === theme ? stripVTControlCharacters(line).trimEnd() : line));
}

test("the ordinary entry registers the request and view renderers for the types it sends", () => {
	const renderers = new Map<string, unknown>();
	const entries = new Map<string, unknown>();
	pillarsExtension({
		registerTool() {},
		registerCommand() {},
		registerEntryRenderer: (type: string, renderer: unknown) => entries.set(type, renderer),
		registerMessageRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		getAllTools: () => [],
	} as unknown as ExtensionAPI);
	assert.equal(renderers.get(JUDGMENT_REQUEST_MESSAGE), renderJudgmentRequestMessage);
	assert.equal(entries.get(VIEW_ENTRY), renderViewEntry);
});

test("the request text round-trips to its action and hint", () => {
	for (const request of [
		{ action: "check", hint: "" },
		{ action: "derive", hint: "the retry rule" },
		{ action: "review", hint: "line one\nline two" },
	] as const)
		assert.deepEqual(judgmentRequestOf(judgmentPrompt(request)), request);
	assert.equal(judgmentRequestOf("Another message."), undefined);
});

test("each action has its own header: what was requested, then the command on a muted line", () => {
	assert.deepEqual(render(judgmentPrompt({ action: "check", hint: "" })).slice(1, 4), [
		" [pillars] Alignment check requested",
		" /pillars check",
		"",
	]);
	assert.equal(render(judgmentPrompt({ action: "derive", hint: "" }))[1], " [pillars] Candidate derivation requested");
	assert.equal(render(judgmentPrompt({ action: "review", hint: "" }))[1], " [pillars] Guidance review requested");
	assert.deepEqual(
		render("Another message.").slice(1, 4),
		[" [pillars] Request", "", " Another message."],
		"no facts, no second line",
	);
	colors.length = 0;
	render(judgmentPrompt({ action: "check", hint: "focus" }));
	assert.ok(colors.some(({ color, value }) => color === "customMessageLabel" && value === "[pillars]"));
	assert.ok(colors.some(({ color, value }) => color === "text" && value === "Alignment check requested"));
	assert.ok(colors.some(({ color, value }) => color === "muted" && value === "/pillars check"));
	assert.ok(colors.some(({ color, value }) => color === "text" && value.includes("focus")));
	assert.equal(
		colors.some(({ color }) => color === "customMessageText"),
		false,
	);
});

test("a collapsed request shows the operator hint, or how the subject is found, then Pi's expansion hint", () => {
	const lines = render(judgmentPrompt({ action: "check", hint: "the jobs card design" }));
	assert.equal(lines[4], " the jobs card design");
	assert.match(lines[5] ?? "", /^ \.\.\. \(\d+ more lines, ctrl\+o to expand\)$/u);
	assert.equal(lines.length, 7);
	assert.match(
		render(judgmentPrompt({ action: "check", hint: "" }))[4] ?? "",
		/^ Infer the subject from the current conversation/u,
	);
	assert.equal(requestSummary(judgmentPrompt({ action: "check", hint: "a b" })).preview, "a b");
	assert.match(render(judgmentPrompt({ action: "check", hint: "" }), false, "")[6] ?? "", /click to expand\)$/u);
});

test("a long hint wraps at word boundaries within three visual lines", () => {
	const hint = `Check ${"the message label convention ".repeat(8)}END`;
	const lines = render(judgmentPrompt({ action: "check", hint }), false, "ctrl+o", 40);
	const body = lines.slice(4, 7);
	assert.ok(body.every((line) => line.length > 0 && !line.endsWith("…")));
	assert.match(lines[7] ?? "", /^ \.\.\. \(/u);
	assert.doesNotMatch(lines.join("\n"), /END/u);
});

test("an expanded request shows the header, a blank line and the whole task text without a hint", () => {
	const lines = render(judgmentPrompt({ action: "review", hint: "the stash notices" }), true);
	assert.deepEqual(lines.slice(1, 4), [" [pillars] Guidance review requested", " /pillars review", ""]);
	const text = lines.join(" ").replace(/\s+/gu, " ");
	assert.match(text, /The operator invoked \/pillars review\./u);
	assert.match(text, /Operator hint \(free text\): the stash notices/u);
	assert.doesNotMatch(text, /to expand/u);
});

test("a command output entry has the [pillars] header, a blank line and its whole Markdown body", () => {
	const lines = view({ text: COMMAND_HELP, title: "Commands" });
	assert.deepEqual(lines.slice(1, 3), [" [pillars] Commands", ""]);
	assert.match(lines.join("\n"), /\/pillars check \[hint\]/u);
	assert.doesNotMatch(lines.join("\n"), /to expand/u);
	assert.deepEqual(view({ text: "Body", title: "Source", subject: "governance" }).slice(1, 4), [
		" [pillars] Source · governance",
		"",
		" Body",
	]);
	assert.deepEqual(view({ text: "Body", title: "Source unavailable", facts: ["not_found"] }).slice(1, 4), [
		" [pillars] Source unavailable",
		" not_found",
		"",
	]);
	assert.equal(view({ text: "Body" })[1], " [pillars] Command output", "an entry without a title keeps a plain header");
});

test("long headers clip with one ellipsis in their own colour and keep the row background", () => {
	const narrow = view({ text: "Body", title: "Source", subject: "a-very-long-resource-name-for-the-corpus" }, 30);
	assert.match(narrow[1] ?? "", /^ \[pillars\] Source · a-very-l.*…$/u);
	for (const row of view(
		{ text: "Body", title: "Source", subject: "a-very-long-resource-name-for-the-corpus" },
		30,
		ansiTheme,
	)) {
		assert.equal(visibleWidth(row), 30);
		assert.ok(row.startsWith("\x1b[48;5;2m"));
		assert.doesNotMatch(row, /\x1b\[0m(?!\x1b\[48;5;2m)/u);
	}
	assert.match(
		view({ text: "Body", title: "Source", subject: "a-very-long-resource-name-for-the-corpus" }, 30, ansiTheme)[1] ??
			"",
		/…\x1b\[[\d;]*39m/u,
		"the ellipsis keeps the colour of the text it cuts",
	);
});

test("terminal control sequences in the hint and the entry never reach the card", () => {
	const content = judgmentPrompt({ action: "check", hint: "focus \x1b[31mred\x1b[0m \x1b]0;title\x07 here" });
	for (const expanded of [false, true]) {
		const component = renderJudgmentRequestMessage(
			{ role: "custom", customType: JUDGMENT_REQUEST_MESSAGE, display: true, timestamp: 0, content },
			options(expanded),
			theme,
		);
		assert.ok(component);
		assert.doesNotMatch(component.render(80).join("\n"), /\x1b|\x07/u);
	}
	assert.match(render(content)[4] ?? "", /^ focus red\s+here$/u);
	assert.doesNotMatch(
		view({ text: "a \x1b[2J b", title: "Source \x1b]0;x\x07", subject: "gov\x1b[31m" }).join("\n"),
		/\x1b|\x07/u,
	);
});

/** Every reset inside a row restores the message background, so the row background never breaks. */
function assertContinuousBackground(row: string): void {
	assert.ok(row.startsWith("\x1b[48;5;2m"), "the row starts on the message background");
	const body = row.endsWith("\x1b[49m") ? row.slice(0, -5) : row;
	for (const match of body.matchAll(/\x1b\[(?:0|49)?m/gu))
		assert.ok(
			body.startsWith("\x1b[48;5;2m", (match.index ?? 0) + match[0].length),
			"every reset restores the background",
		);
}

const piKeyHint = (expanded: boolean) =>
	({
		...options(expanded),
		keyHint: (_binding: string, description: string) => `\x1b[2mctrl+o\x1b[22m\x1b[38;5;3m ${description}\x1b[39m`,
	}) as unknown as MessageRenderOptions;

test("the hint dims the key from Pi's keyHint, mutes the rest and keeps the row background", () => {
	const content = judgmentPrompt({ action: "check", hint: "focus" });
	const component = renderJudgmentRequestMessage(
		{ role: "custom", customType: JUDGMENT_REQUEST_MESSAGE, display: true, timestamp: 0, content },
		piKeyHint(false),
		ansiTheme,
	);
	assert.ok(component);
	const rows = component.render(80);
	const hint = rows.find((row) => stripVTControlCharacters(row).includes("to expand")) ?? "";
	assert.match(stripVTControlCharacters(hint).trim(), /^\.\.\. \(\d+ more lines, ctrl\+o to expand\)$/u);
	assert.ok(hint.includes("\x1b[2mctrl+o"), "the key comes from Pi's keyHint");
	assert.match(hint, /\x1b\[38;5;1m\.\.\. \(\d+ more lines, \x1b\[39m/u, "the rest is muted");
	for (const row of rows) assertContinuousBackground(row);
	for (const row of view({ text: "Body", title: "Commands" }, 80, ansiTheme)) assertContinuousBackground(row);
});

test("display text keeps tabs and removes control sequences", () => {
	const text = view({ text: "col\tvalue \x1b[31mred\x1b[0m \u202ebidi", title: "Commands" }).join("\n");
	assert.match(text, /col\s+value red bidi/u, "the tab stays whitespace; Pi's Markdown draws it as spaces");
	assert.doesNotMatch(text, /\\t|\\u|\u202e/u);
});

test("a left click anywhere on the card toggles it, as on Pi's cards, and Pi's global expansion resets the choice", () => {
	const stored = {
		role: "custom" as const,
		customType: JUDGMENT_REQUEST_MESSAGE,
		display: true,
		timestamp: 0,
		content: judgmentPrompt({ action: "check", hint: "focus" }),
	};
	const card = (expanded: boolean) => {
		const component = renderJudgmentRequestMessage(stored, options(expanded), theme);
		assert.ok(component);
		return component;
	};
	const at = (component: { handleMouse?(event: never): unknown }, y: number, patch: Record<string, unknown> = {}) =>
		component.handleMouse?.({
			type: "click",
			button: "left",
			x: 2,
			y,
			width: 80,
			height: 40,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
			...patch,
		} as never) as { handled?: boolean } | undefined;
	const text = (component: { render(width: number): string[] }) =>
		component
			.render(80)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
	const collapsed = card(false);
	const body = collapsed
		.render(80)
		.findIndex((line, index) => index > 2 && stripVTControlCharacters(line).trim() !== "");
	assert.match(text(collapsed), /to expand\)/u);
	assert.equal(at(collapsed, 0), undefined, "a click on the padding row passes through");
	assert.equal(at(collapsed, body, { button: "right" }), undefined, "a right click passes through");
	assert.equal(
		at(collapsed, body, { type: "press" }),
		undefined,
		"a press or a drag passes through, so text selection works",
	);
	assert.equal(at(collapsed, body)?.handled, true, "a click on the body toggles, as Pi's MouseRegion does");
	assert.doesNotMatch(text(collapsed), /to expand\)/u);
	assert.equal(
		at(collapsed, 1, { shift: true })?.handled,
		true,
		"a modified click on the header toggles too; Pi does not filter modifiers",
	);
	assert.match(text(collapsed), /to expand\)/u);
	assert.equal(
		at(collapsed, body, { clickCount: 2 })?.handled,
		true,
		"each click of a multi-click toggles; Pi does not filter the click count",
	);
	assert.doesNotMatch(
		text(card(false)),
		/to expand\)/u,
		"a rebuild over the same stored message keeps the local choice",
	);
	assert.doesNotMatch(text(card(true)), /to expand\)/u);
	assert.match(text(card(false)), /to expand\)/u, "a change of Pi's global expansion discards the local choice");
});
