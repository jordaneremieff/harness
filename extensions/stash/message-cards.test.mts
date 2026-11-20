import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	initTheme,
	type MessageRenderer,
	type MessageRenderOptions,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	BUDGET_NOTICE,
	budgetNotice,
	budgetNoticeFacts,
	budgetStatus,
	budgetStatusFacts,
	ORDINARY_COST,
} from "./budget.ts";
import { CAPACITY_NOTICE_HEADER, capacityDirectiveLines, type CapacityState } from "./capacity.ts";
import {
	renderBudgetMessage,
	renderBudgetStatusMessage,
	renderCapacityMessage,
	renderRedactionMessage,
	STASH_MESSAGES,
} from "./message-cards.ts";
import { redactionNotice, type RedactionReport } from "./redact.ts";

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

function render(
	renderer: MessageRenderer,
	customType: string,
	content: string,
	details?: unknown,
	expanded = false,
	key = "ctrl+o",
	width = 80,
): string[] {
	const component = renderer(
		{ role: "custom", customType, display: true, timestamp: 0, content, details },
		options(expanded, key),
		theme,
	);
	assert.ok(component);
	return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

const PLACEHOLDERS = /unavailable|unknown/u;
const report: RedactionReport = {
	count: 3,
	classes: { JWT: 2, Bearer: 1 },
	contexts: ["token=[REDACTED] in summary", "Authorization: Bearer [REDACTED]"],
};
const budget = { contextTokens: 200_000, costUsd: 5 };
const capacity = (overrides: Partial<CapacityState>): CapacityState => ({
	sessionId: "s",
	turnEntryId: "e",
	checkpointRequested: true,
	decisionRequested: false,
	intakeChars: 0,
	usage: { kind: "host_estimate", tokens: 170_000, contextWindow: 200_000, percent: 85.2 },
	...overrides,
});
const capacityText = [
	CAPACITY_NOTICE_HEADER,
	"Pi estimates context use at 85.2% (170000 tokens). This is not a safe remaining budget.",
	...capacityDirectiveLines(true, false),
].join("\n\n");

it("a redaction notice names the removed values on the facts line and previews their contexts", () => {
	const lines = render(renderRedactionMessage, STASH_MESSAGES.redaction, redactionNotice(report), {
		redactions: report,
	});
	assert.deepEqual(lines.slice(1, 4), [" [stash] Credentials redacted", " 3 values · JWT 2, Bearer 1", ""]);
	assert.deepEqual(lines.slice(4, 8), [
		" token=[REDACTED] in summary",
		" Authorization: Bearer [REDACTED]",
		" Context shown for 2 of 3 replacements.",
		" ... (1 more line, ctrl+o to expand)",
	]);
	colors.length = 0;
	render(renderRedactionMessage, STASH_MESSAGES.redaction, redactionNotice(report), { redactions: report });
	assert.ok(colors.some(({ color, value }) => color === "customMessageLabel" && value === "[stash]"));
	assert.ok(colors.some(({ color, value }) => color === "text" && value === "Credentials redacted"));
	assert.ok(colors.some(({ color, value }) => color === "muted" && value === "3 values · JWT 2, Bearer 1"));
	assert.equal(
		colors.some(({ color }) => color === "customMessageText"),
		false,
	);
});

it("a budget notice states whether a budget is reached and only the known shares", () => {
	const below = budgetNotice(budget, { kind: "host_estimate", tokens: 120_000 }, ORDINARY_COST);
	assert.deepEqual(budgetNoticeFacts(below), { context: { tokens: 120_000, budget: 200_000 } });
	assert.deepEqual(render(renderBudgetMessage, STASH_MESSAGES.budget, below).slice(1, 4), [
		" [stash] Budget notice",
		" context 60% of 200k",
		"",
	]);
	const reached = budgetNotice(budget, { kind: "host_estimate", tokens: 210_000 }, { kind: "recorded", usd: 2 });
	assert.deepEqual(render(renderBudgetMessage, STASH_MESSAGES.budget, reached).slice(1, 3), [
		" [stash] Budget reached",
		" context 105% of 200k · cost 40% of USD 5",
	]);
	const unknown = render(
		renderBudgetMessage,
		STASH_MESSAGES.budget,
		budgetNotice(budget, { kind: "unavailable" }, ORDINARY_COST),
	);
	assert.deepEqual(unknown.slice(1, 3), [" [stash] Budget notice", ""], "unknown shares add no facts line");
	assert.doesNotMatch(unknown.slice(1, 3).join("\n"), PLACEHOLDERS);
	const lines = render(renderBudgetMessage, STASH_MESSAGES.budget, below);
	assert.match(lines[4] ?? "", /^ Absolute context host estimate: 120000 tokens/u);
	assert.equal(lines.slice(4, -2).length, 3, "three visual body lines");
	assert.ok(
		lines.slice(4, 7).every((line) => !line.endsWith("…")),
		"prose wraps instead of clipping",
	);
	assert.match(lines.at(-2) ?? "", /^ \.\.\. \(\d+ more lines, ctrl\+o to expand\)$/u);
});

it("an expanded budget notice hides the model-facing tag line and keeps the rest of the text", () => {
	const text = render(
		renderBudgetMessage,
		STASH_MESSAGES.budget,
		budgetNotice(budget, { kind: "unavailable" }, ORDINARY_COST),
		undefined,
		true,
	).join("\n");
	assert.equal(text.includes(BUDGET_NOTICE), false);
	assert.doesNotMatch(text, /\[stash-budget\]|to expand/u);
	assert.match(text.replace(/\s+/gu, " "), /Absolute context tokens: unavailable; selected budget 200000 tokens\./u);
});

it("a budget status names the selection and both budgets", () => {
	assert.deepEqual(budgetStatusFacts(budgetStatus(budget)), { state: "enabled", budget });
	assert.deepEqual(render(renderBudgetStatusMessage, STASH_MESSAGES.budgetStatus, budgetStatus(budget)).slice(1, 3), [
		" [stash] Budget notices on",
		" 200k tokens · USD 5",
	]);
	assert.equal(
		render(renderBudgetStatusMessage, STASH_MESSAGES.budgetStatus, budgetStatus(budget, "command"))[1],
		" [stash] Budget selected",
	);
	const off = render(renderBudgetStatusMessage, STASH_MESSAGES.budgetStatus, budgetStatus(undefined));
	assert.deepEqual(off.slice(1, 4), [
		" [stash] Budget off",
		"",
		" Stash budget: disabled for this conversation. Select budgets with /stash",
	]);
	assert.doesNotMatch(off.join("\n"), /to expand/u, "a body shown in full has no hint");
	assert.equal(
		render(renderBudgetStatusMessage, STASH_MESSAGES.budgetStatus, "Another text.")[1],
		" [stash] Budget status",
	);
});

it("a capacity request names the requested act and the context share only when Pi estimates it", () => {
	assert.deepEqual(render(renderCapacityMessage, STASH_MESSAGES.capacity, capacityText, capacity({})).slice(1, 4), [
		" [stash] Capacity checkpoint requested",
		" context 85%",
		"",
	]);
	assert.deepEqual(
		render(
			renderCapacityMessage,
			STASH_MESSAGES.capacity,
			capacityText,
			capacity({
				decisionRequested: true,
				usage: { kind: "host_estimate", tokens: 180_000, contextWindow: 200_000, percent: 90 },
			}),
		).slice(1, 3),
		[" [stash] Continuity decision requested", " context 90%"],
	);
	const unknown = render(
		renderCapacityMessage,
		STASH_MESSAGES.capacity,
		capacityText,
		capacity({ usage: { kind: "unknown" } }),
	);
	assert.deepEqual(unknown.slice(1, 3), [" [stash] Capacity checkpoint requested", ""]);
	const lines = render(renderCapacityMessage, STASH_MESSAGES.capacity, capacityText, capacity({}));
	assert.match(
		lines[4] ?? "",
		/^ Pi estimates context use at 85\.2%/u,
		"the preview starts after the model-facing header",
	);
	assert.deepEqual(
		lines.slice(4, 6),
		[" Pi estimates context use at 85.2% (170000 tokens). This is not a safe", " remaining budget."],
		"a preview that reaches a paragraph break stops before the blank line",
	);
	assert.equal(lines.length, 8);
	assert.match(lines[6] ?? "", /^ \.\.\. \(\d+ more lines, ctrl\+o to expand\)$/u);
	assert.match(
		render(renderCapacityMessage, STASH_MESSAGES.capacity, capacityText, capacity({}), false, "")[6] ?? "",
		/click to expand\)$/u,
	);
});

it("an expanded card shows the header, a blank line and the whole message text without a hint", () => {
	const lines = render(renderCapacityMessage, STASH_MESSAGES.capacity, capacityText, capacity({}), true);
	assert.deepEqual(lines.slice(1, 4), [" [stash] Capacity checkpoint requested", " context 85%", ""]);
	const text = lines.join(" ").replace(/\s+/gu, " ");
	for (const sentence of [
		CAPACITY_NOTICE_HEADER,
		"Pi estimates context use at 85.2% (170000 tokens).",
		"Do not reset the capacity episode merely to repeat this notice.",
	])
		assert.ok(text.includes(sentence), sentence);
	assert.doesNotMatch(text, /to expand/u);
});

it("long facts clip with one ellipsis in their own colour and keep the row background", () => {
	const many: RedactionReport = {
		count: 7,
		classes: { JWT: 2, Bearer: 1, Basic: 1, "provider token": 1, "labeled credential": 1, "URL password": 1 },
		contexts: [],
	};
	const narrow = render(
		renderRedactionMessage,
		STASH_MESSAGES.redaction,
		redactionNotice(many),
		{ redactions: many },
		false,
		"ctrl+o",
		30,
	);
	assert.match(narrow[2] ?? "", /^ 7 values · JWT 2, .*…$/u);
	const component = renderRedactionMessage(
		{
			role: "custom",
			customType: STASH_MESSAGES.redaction,
			display: true,
			timestamp: 0,
			content: redactionNotice(many),
			details: { redactions: many },
		},
		options(false),
		ansiTheme,
	);
	assert.ok(component);
	const rows = component.render(30);
	for (const row of rows) {
		assert.equal(visibleWidth(row), 30);
		assert.ok(row.startsWith("\x1b[48;5;2m"));
		assert.doesNotMatch(row, /\x1b\[0m(?!\x1b\[48;5;2m)/u);
	}
	assert.match(rows[2] ?? "", /…\x1b\[[\d;]*39m/u, "the ellipsis keeps the colour of the text it cuts");
});

it("terminal control sequences in details and content never reach the card", () => {
	const hostile: RedactionReport = { count: 1, classes: { "JWT\x1b[31m": 1 }, contexts: ["ctx \x1b]0;title\x07 here"] };
	const content = `Redaction notice: 1 credential value(s) removed.\n  ctx \x1b]0;title\x07 \x1b[2J here`;
	for (const expanded of [false, true]) {
		const component = renderRedactionMessage(
			{
				role: "custom",
				customType: STASH_MESSAGES.redaction,
				display: true,
				timestamp: 0,
				content,
				details: { redactions: hostile },
			},
			options(expanded),
			theme,
		);
		assert.ok(component);
		assert.doesNotMatch(component.render(80).join("\n"), /\x1b|\x07/u);
	}
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

it("the hint dims the key from Pi's keyHint, mutes the rest and keeps the row background", () => {
	const component = renderCapacityMessage(
		{
			role: "custom",
			customType: STASH_MESSAGES.capacity,
			display: true,
			timestamp: 0,
			content: capacityText,
			details: capacity({}),
		},
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
});

it("display text keeps tabs and removes control sequences", () => {
	const text = render(
		renderBudgetStatusMessage,
		STASH_MESSAGES.budgetStatus,
		"col\tvalue \x1b[31mred\x1b[0m \u202ebidi",
	).join("\n");
	assert.match(text, /col\s+value red bidi/u, "the tab stays whitespace; Pi's Markdown draws it as spaces");
	assert.doesNotMatch(text, /\\t|\\u|\\x|\u202e/u, "no visible escape text and no raw control");
});

it("a left click anywhere on the card toggles it, as on Pi's cards, and Pi's global expansion resets the choice", () => {
	const stored = {
		role: "custom" as const,
		customType: STASH_MESSAGES.capacity,
		display: true,
		timestamp: 0,
		content: capacityText,
		details: capacity({}),
	};
	const card = (expanded: boolean) => {
		const component = renderCapacityMessage(stored, options(expanded), theme);
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
	const text = (component: { render(width: number): readonly string[] }) =>
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
