import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, it, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CustomMessageComponent, initTheme, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { BUDGET_NOTICE, budgetNotice, budgetStatus, ORDINARY_COST } from "./budget.ts";
import { CAPACITY_NOTICE_HEADER, capacityDirectiveLines } from "./capacity.ts";
import {
	renderBudgetMessage,
	renderBudgetStatusMessage,
	renderCapacityMessage,
	renderRedactionMessage,
	STASH_MESSAGES,
} from "./message-cards.ts";

const nativeTui = await import(
	createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")
);
before(() => initTheme("dark", false));
const message = (customType: string, content: string, details?: unknown) => ({
	role: "custom" as const,
	customType,
	display: true,
	timestamp: 0,
	content,
	details,
});
const card = (renderer: MessageRenderer, customType: string, content: string, details?: unknown) =>
	new CustomMessageComponent(message(customType, content, details), renderer, undefined, 2);
const rows = (component: CustomMessageComponent, width = 90) =>
	component.render(width).map((row) => stripVTControlCharacters(row).trimEnd());
const text = (component: CustomMessageComponent, width = 90) => rows(component, width).join("\n");
function keys(t: TestContext, defaultKeys: string[]) {
	const previous = nativeTui.getKeybindings();
	nativeTui.setKeybindings(
		new nativeTui.KeybindingsManager({
			...nativeTui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys, description: "Expand tool output" },
		}),
	);
	t.after(() => nativeTui.setKeybindings(previous));
}
function mouse(component: CustomMessageComponent, type = "click", button = "left") {
	const lines = rows(component);
	const y = lines.findIndex((row) => row.includes("[stash]"));
	return component.handleMouse({
		type,
		button,
		x: 4,
		y,
		screenX: 4,
		screenY: y,
		width: 90,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	} as never);
}
const budget = { contextTokens: 200_000, costUsd: 5 };

it("renders the redaction count and class facts above safe contexts and counts hidden rows of the same body", (t) => {
	keys(t, ["alt+e"]);
	const token = "sk-abcdefgh" + "ijklmnop1234";
	const report = {
		count: 4,
		classes: { "provider token": 4 },
		contexts: [`Fetched ${token}.`, `Confirmed ${token}.`, `Checked ${token}.`, `Closed with ${token}.`],
	};
	const component = card(renderRedactionMessage, STASH_MESSAGES.redaction, `Never render fallback ${token}`, {
		redactions: report,
	});
	assert.deepEqual(rows(component).slice(2, 9), [
		"  [stash] Credentials redacted",
		"  4 values · provider token 4",
		"",
		"  Fetched [REDACTED].",
		"  Confirmed [REDACTED].",
		"  Checked [REDACTED].",
		`  ... (1 more line, ${process.platform === "darwin" ? "option" : "alt"}+e to expand)`,
	]);
	assert.equal(mouse(component)?.handled, true);
	assert.match(text(component), /Closed with \[REDACTED\]\./u);
	assert.doesNotMatch(text(component), new RegExp(`${token}|fallback|to expand`, "u"));
});

it("renders budget measurements from retained details without the model-facing tag", () => {
	const context = { kind: "host_estimate" as const, tokens: 210_000 };
	const cost = { kind: "recorded" as const, usd: 2 };
	const component = card(renderBudgetMessage, STASH_MESSAGES.budget, budgetNotice(budget, context, cost), {
		budget,
		context,
		cost,
	});
	assert.deepEqual(rows(component).slice(2, 5), [
		"  [stash] Budget reached",
		"  context 105% of 200k · cost 40% of USD 5",
		"",
	]);
	assert.doesNotMatch(text(component), /\[stash-budget\]|Local budget notice/u);
	const unavailable = { kind: "unavailable" as const };
	const unknown = card(renderBudgetMessage, STASH_MESSAGES.budget, budgetNotice(budget, unavailable, ORDINARY_COST), {
		budget,
		context: unavailable,
		cost: ORDINARY_COST,
	});
	assert.equal(rows(unknown)[3], "", "unobserved facts do not produce a fact row");
	assert.equal(rows(unknown)[2], "  [stash] Budget notice");
	const noDetails = card(
		renderBudgetMessage,
		STASH_MESSAGES.budget,
		`${BUDGET_NOTICE}\nRecorded cost: USD 200.`,
		undefined,
	);
	assert.match(text(noDetails), /\[stash\] Budget notice/u);
	assert.doesNotMatch(text(noDetails), /Budget reached/u);
});

it("names the budget selection without interpreting text as state or hinting for a full preview", () => {
	const component = card(renderBudgetStatusMessage, STASH_MESSAGES.budgetStatus, budgetStatus(budget), {
		state: "enabled",
		budget,
	});
	assert.deepEqual(rows(component).slice(2, 4), ["  [stash] Budget notices on", "  200k tokens · USD 5"]);
	const off = card(renderBudgetStatusMessage, STASH_MESSAGES.budgetStatus, budgetStatus(undefined), {
		state: "disabled",
	});
	assert.match(text(off), /\[stash\] Budget off/u);
	assert.doesNotMatch(text(off), /to expand/u);
	assert.match(
		text(card(renderBudgetStatusMessage, STASH_MESSAGES.budgetStatus, budgetStatus(undefined))),
		/\[stash\] Budget status/u,
	);
});

it("keeps capacity instructions expanded-only and uses the real click and global expansion state", (t) => {
	keys(t, []);
	const observation = "Pi estimates context use at 90%.";
	const content = [CAPACITY_NOTICE_HEADER, observation, ...capacityDirectiveLines(false, true)].join("\n\n");
	const component = card(renderCapacityMessage, STASH_MESSAGES.capacity, content, {
		request: "decision",
		observation,
		usage: { kind: "host_estimate", percent: 90 },
	});
	assert.deepEqual(rows(component).slice(2, 7), [
		"  [stash] Continuity decision requested",
		"  context 90%",
		"",
		`  ${observation}`,
		"  ... (click to expand)",
	]);
	assert.doesNotMatch(text(component), /Follow the governing|more lines/u);
	assert.equal(mouse(component, "click", "right")?.handled, undefined);
	assert.equal(mouse(component)?.handled, true);
	assert.match(text(component), /Follow the governing/u);
	component.invalidate();
	assert.match(text(component), /Follow the governing/u, "ordinary redraw preserves local expansion");
	component.setExpanded(true);
	assert.match(text(component), /Follow the governing/u);
	component.setExpanded(false);
	assert.doesNotMatch(text(component), /Follow the governing/u, "global changes discard the prior local choice");
});

it("does not paint a placeholder or raw safety text when details are missing", () => {
	const malformed = card(renderRedactionMessage, STASH_MESSAGES.redaction, "Unvalidated context", {
		redactions: { count: 8 },
	});
	assert.match(text(malformed), /\[stash\] Redaction notice/u);
	assert.doesNotMatch(text(malformed), /Unvalidated|no text|unknown|expand/u);
});
