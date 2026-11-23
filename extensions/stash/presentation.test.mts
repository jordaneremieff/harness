import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { before, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme, type ToolDefinition, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { toolDisplay } from "./display.ts";
import { renderReadResult } from "./presentation.ts";

const nativeTui = await import(
	createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")
);
before(() => initTheme("dark", false));
const line = (row: string) => stripVTControlCharacters(row).trimEnd();
const tool = (name: string) => toolDisplay().tools.find((item) => item.name === name) as ToolDefinition;
const view = (name: string, args: unknown) =>
	new ToolExecutionComponent(
		name,
		`call-${name}`,
		args,
		undefined,
		tool(name),
		{ requestRender() {} } as unknown as TUI,
		".",
	);
const text = (value: string, details: unknown = {}, isError = false) => ({
	content: [{ type: "text" as const, text: value }],
	details,
	isError,
});
const screen = (card: ToolExecutionComponent, width = 120) => card.render(width).map(line).join("\n");
const click = (card: ToolExecutionComponent, width = 120) => {
	const rows = card.render(width).map(line);
	const y = rows.findIndex((row) => row.trimStart().startsWith("stash_"));
	return card.handleMouse({
		type: "click",
		button: "left",
		x: 4,
		y,
		screenX: 4,
		screenY: y,
		width,
		height: rows.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	} as never);
};
function keys(t: import("node:test").TestContext, defaultKeys: string[]) {
	const previous = nativeTui.getKeybindings();
	nativeTui.setKeybindings(
		new nativeTui.KeybindingsManager({
			...nativeTui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys, description: "Expand tool output" },
		}),
	);
	t.after(() => nativeTui.setKeybindings(previous));
}

it("hands a call-only hint to the result slot and only accepts clicks after a result", (t) => {
	keys(t, ["alt+e"]);
	const card = view("stash_write", {
		title: "Release notes",
		summary: "keep this content off the card",
		tags: ["work"],
	});
	const rows = screen(card).split("\n");
	assert.match(rows[2] ?? "", /stash_write Release notes/u);
	assert.match(rows[3] ?? "", /summary 30 characters/u);
	assert.match(rows[4] ?? "", /\.\.\. \((?:alt|option)\+e to expand\)/u);
	assert.equal(click(card)?.handled, undefined);
	card.updateResult(text("model instructions", { id: "saved-id", state: "open" }));
	const collapsed = screen(card);
	assert.equal(collapsed.match(/to expand/gu)?.length, 1);
	assert.match(
		collapsed,
		/summary 30 characters · tags 1\n\n\s+Saved open stash saved-id\.\n\s+\.\.\. \((?:alt|option)\+e to expand\)/u,
	);
	assert.equal(click(card)?.handled, true);
	assert.match(screen(card), /4 characters/u);
	assert.doesNotMatch(screen(card), /keep this content|model instructions|to expand/u);
});

it("omits a pre-result hint without a key and omits placeholders in partial or malformed calls", (t) => {
	keys(t, []);
	const card = view("stash_complete", { outcome: "one\ntwo\nthree\nfour\nfive\nsix" });
	assert.doesNotMatch(screen(card), /to expand|pending|six/u);
	card.updateResult(text("Closed.", { id: "closed-id", state: "closed" }));
	assert.match(screen(card), /\.\.\. \(1 more line, click to expand\)/u);
	const empty = view("stash_read", undefined);
	assert.match(screen(empty), /stash_read/u);
	assert.doesNotMatch(screen(empty), /pending|unknown|expand/u);
});

it("reports a producer page and expands to an exact continuation, including on an empty page", (t) => {
	keys(t, ["ctrl+o"]);
	const args = { query: "release notes", tag: "continuity", limit: 5, collection: "handovers", state: "active" };
	const card = view("stash_list", { ...args, cursor: "previous" });
	const cursor = `opaque.${"7AB56pX".repeat(26)}`;
	card.updateResult(
		text("{}", { matches: [], skipped: [], coverage: { from: 12, next: 24, complete: false }, nextCursor: cursor }),
	);
	assert.match(screen(card), /Found 0 matches on this page, candidates \[12, 24\); continuation available\./u);
	assert.doesNotMatch(screen(card), /(?:Partial coverage|Excerpt|Truncated|more lines)/u);
	assert.equal(screen(card).match(/to expand/gu)?.length, 1);
	card.setExpanded(true);
	const expanded = screen(card);
	const exact = expanded
		.slice(expanded.indexOf("Continue with stash_list:") + "Continue with stash_list:".length)
		.replace(/\n\s*/gu, "")
		.trim();
	assert.deepEqual(JSON.parse(exact), { ...args, cursor });
	assert.doesNotMatch(expanded, /to expand/u);
});

it("shows first visual rows of read results and counts exactly what is hidden", (t) => {
	keys(t, ["ctrl+o"]);
	const card = view("stash_read", { id: "full-id" });
	const body = "0123456789".repeat(42);
	card.updateResult(text(body, { id: "full-id", totalLines: 1 }));
	const collapsed = screen(card, 62);
	assert.match(collapsed, /Read stash \(1 line\)\./u);
	assert.equal(collapsed.split("\n").filter((row) => /^\s*[0-9]+$/u.test(row)).length, 5);
	assert.match(collapsed, /\.\.\. \(2 more lines, ctrl\+o to expand\)/u);
	assert.equal(click(card, 62)?.handled, true);
	assert.equal(
		screen(card, 62)
			.split("\n")
			.filter((row) => /^\s*[0-9]+$/u.test(row)).length,
		7,
	);
});

it("reports a recent selection without absent states or provenance", () => {
	const card = view("stash_list", { collection: "checkpoints" });
	card.updateResult(
		text("Producer content unchanged", {
			count: 3,
			provisional: true,
			records: [{ id: "checkpoint:one", title: "Start", state: "unknown", source: null, workspace: "unknown" }],
			omittedRecords: 2,
		}),
	);
	assert.match(screen(card), /3 recent checkpoints listed/u);
	assert.match(screen(card), /checkpoint:one\n\s+Start/u);
	assert.match(screen(card), /\[Excerpt: 2 selected records not retained in the list\]/u);
	assert.doesNotMatch(screen(card), /null|unknown|pending/u);
});

it("restores a long archive path on expansion and keeps archive distinct from deletion", () => {
	const card = view("stash_rotate", { id: "stash-id" });
	const archive = `${homedir()}/archive/${"retained-".repeat(18)}.md`;
	card.updateResult(text("Rotated.", { id: "stash-id", state: "closed", archivePath: archive }));
	assert.match(screen(card), /Archived the stash; the artifact remains recoverable\./u);
	assert.doesNotMatch(screen(card), /retained-retained/u);
	assert.equal(click(card)?.handled, true);
	assert.ok(screen(card).replace(/\n\s*/gu, "").includes(archive.replace(homedir(), "~")));
	assert.doesNotMatch(screen(card), /deleted|to expand/u);
});

it("reports close redaction counts and withholds credentials in call, result and safe contexts", () => {
	const token = "sk-abcdefgh" + "ijklmnop1234";
	const card = view("stash_complete", { id: "one", outcome: `Verified ${token}` });
	const details = {
		id: "one",
		state: "closed",
		outcome: "Verified [REDACTED]",
		redactions: { count: 2, classes: { "provider token": 2 }, contexts: [`Verified ${token}`] },
	};
	card.updateResult(text(`Raw ${token}`, details));
	assert.match(screen(card), /Closed the stash with 2 credential values redacted; the artifact remains\./u);
	assert.doesNotMatch(screen(card), new RegExp(token, "u"));
	card.setExpanded(true);
	assert.match(screen(card), /Verified \[REDACTED\]/u);
	assert.match(screen(card), /provider token: 2/u);
	assert.match(screen(card), /Reopen this stash before pickup/u);
	assert.doesNotMatch(screen(card), new RegExp(token, "u"));
});

it("reports unchanged lifecycle on edit and expands sizes and digest instead of replacement text", () => {
	const card = view("stash_edit", {
		id: "one",
		allowActive: true,
		expectedDigest: "requested-digest",
		edits: [{ oldText: "original body", newText: "private replacement" }],
	});
	card.updateResult(text("Unchanged.", { id: "one", state: "active", changed: false, digest: "result-digest" }));
	assert.match(screen(card), /The stash did not change; state remains active\./u);
	assert.match(screen(card), /1 replacement · active edit acknowledged/u);
	card.setExpanded(true);
	assert.match(screen(card), /oldText.*13 characters/u);
	assert.match(screen(card), /Digest: result-digest/u);
	assert.doesNotMatch(screen(card), /original body|private replacement/u);
});

it("reports an actual host error and restores its diagnostic rather than inferring cancellation", () => {
	const card = view("stash_rotate", { id: "one" });
	const diagnostic = `Rotate failed: write cancelled by another process\n${"evidence ".repeat(100)}\nLast diagnostic line`;
	card.updateResult(text(diagnostic.replace("Last", "\x1b[31mLast\x1b[0m"), {}, true));
	assert.match(screen(card), /Rotate failed: write cancelled by another process/u);
	assert.doesNotMatch(screen(card), /\n\s+Cancelled\b|Last diagnostic line/u);
	card.setExpanded(true);
	assert.match(screen(card), /Last diagnostic line/u);
});

it("keeps validation echoes out of collapsed writes and edits and discloses the safe diagnostic", () => {
	const secret = "private memo 🐠";
	for (const [name, args] of [
		["stash_write", { title: "Memo", summary: secret }],
		["stash_edit", { id: "memo", edits: [{ oldText: secret, newText: "next" }] }],
	] as const) {
		const card = view(name, args);
		const diagnostic = `Invalid field: ${secret}\nReceived arguments:\n${JSON.stringify(args)}`;
		card.updateResult(text(diagnostic, {}, true));
		assert.match(screen(card), /The stash (?:write|edit) failed\./u);
		assert.doesNotMatch(screen(card), /private memo|Received arguments/u);
		card.setExpanded(true);
		assert.match(screen(card), /14 characters/u);
		assert.match(screen(card), /Invalid field: private memo 🐠\n\s*Received arguments:/u);
	}
});

it("reuses the result component and reports the width-independent display limit", () => {
	const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
	const options = { expanded: true, isPartial: false };
	const card = renderReadResult(text("original"), options, theme, { isError: false });
	const updated = renderReadResult(text(`first row\n${"🌏".repeat(33000)}`), options, theme, {
		isError: false,
		lastComponent: card,
	});
	assert.equal(card, updated);
	assert.ok(card.render(120).includes("[Truncated: showing 32000 of 33000 characters]"));
});
