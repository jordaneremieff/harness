import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CustomMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { type KeyId, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { parseDetectors } from "./catalog.ts";
import { CHECK_REQUEST, renderCheckRequest } from "./check-request.ts";
import { checkPrompt, checkRequestDetails } from "./command.ts";
import { toolDisplay } from "./display.ts";
import { inspectCatalog, inspectStarter } from "./operations.ts";
import type { SlopTool } from "./presentation.ts";
import { compareStarter, importEntries, removeEntry } from "./store.ts";

const nativeTui: typeof import("@earendil-works/pi-tui") = await import(
	createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")
);
initTheme("dark", false);

function binding(t: TestContext, keys: KeyId | KeyId[]) {
	const previous = nativeTui.getKeybindings();
	nativeTui.setKeybindings(
		new nativeTui.KeybindingsManager({
			...nativeTui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys: keys, description: "Expand tool output" },
		}),
	);
	t.after(() => nativeTui.setKeybindings(previous));
}

function tool(name: SlopTool, args: unknown) {
	const def = toolDisplay().tools.find((tool) => tool.name === name);
	assert.ok(def);
	return new ToolExecutionComponent(
		name,
		"call",
		args,
		{ outputPad: 2 },
		def,
		{
			requestRender() {},
		} as unknown as TUI,
		".",
	);
}

function request(hint: string) {
	return new CustomMessageComponent(
		{
			role: "custom",
			customType: CHECK_REQUEST,
			content: checkPrompt(hint),
			details: checkRequestDetails(hint),
			display: true,
			timestamp: 1,
		},
		renderCheckRequest,
		undefined,
		2,
	);
}

function rendered(component: { render(width: number): readonly string[] }, width = 100) {
	return component.render(width).map((line) => stripVTControlCharacters(line).trim());
}

function click(y: number, width: number, height: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 4,
		y,
		screenX: 4,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

const blocks = (text: string) => [{ type: "text", text }];

test("Slop calls name real operations and keep arbitrary argument values out of both views", (t) => {
	binding(t, "ctrl+e");
	assert.ok(rendered(tool("slop", { entry: "field-note", starter: true })).includes("slop read field-note"));
	assert.ok(rendered(tool("slop", { starter: true })).includes("slop compare starter set"));
	const query = tool("slop", { scope: "code", query: "private search text" });
	assert.match(rendered(query).join("\n"), /slop search catalog\ncode\n\.\.\. \(ctrl\+e to expand\)/);
	query.setExpanded(true);
	assert.match(rendered(query).join("\n"), /query: 19 characters/);
	assert.doesNotMatch(rendered(query).join("\n"), /private search text/);
	assert.ok(rendered(tool("slop_check", { path: "src/notes.ts" })).includes("slop_check check src/notes.ts"));
	assert.ok(rendered(tool("slop_check", { diff: { staged: true } })).includes("slop_check check staged diff"));
	const diff = tool("slop_check", {
		diff: { range: "main..HEAD", paths: ["src/x.ts", "src/y.ts"] },
		entries: ["plain-language"],
	});
	assert.match(rendered(diff).join("\n"), /slop_check check main\.\.HEAD\n2 paths · entries plain-language/);
	diff.setExpanded(true);
	assert.match(rendered(diff).join("\n"), /paths: \["src\/x.ts","src\/y.ts"\]/);
	const save = tool("slop_record", {
		action: "save",
		id: "field-note",
		operator: "operator's private wording",
		detectors: [{ pattern: "sensitive pattern" }],
	});
	assert.ok(rendered(save).includes("slop_record save field-note"));
	save.setExpanded(true);
	assert.match(rendered(save).join("\n"), /operator: 26 characters\ndetectors: 1 detector/);
	assert.doesNotMatch(rendered(save).join("\n"), /private wording|sensitive pattern/);
});

test("one binding-aware hint moves from the call to the result and expands on a click", (t) => {
	binding(t, []);
	const card = tool("slop_check", { text: "long arbitrary prose", kind: "document" });
	const width = 100;
	let lines = rendered(card, width);
	const titleRow = lines.indexOf("slop_check check text");
	assert.ok(titleRow > 0);
	assert.equal(card.handleMouse(click(titleRow, width, lines.length)), undefined);
	assert.doesNotMatch(lines.join("\n"), /to expand|arbitrary prose/);
	card.updateResult({
		content: blocks("Detector report:\nsource excerpt\n\x1b[32mLast finding\x1b[0m"),
		details: { ok: false, findingCount: 1, skippedCount: 2, locationsLimited: true, reportLimited: true },
		isError: false,
	});
	lines = rendered(card, width);
	assert.ok(lines.includes("1 slop detector finding."));
	assert.ok(lines.includes("[2 inputs skipped; 8 KiB report limit reached; at most 20 locations per detector]"));
	assert.deepEqual(
		lines.filter((line) => line.includes("to expand")),
		["... (click to expand)"],
	);
	assert.doesNotMatch(lines.join("\n"), /failed|source excerpt/);
	assert.equal(card.handleMouse(click(titleRow, width, lines.length))?.handled, true);
	assert.match(rendered(card).join("\n"), /text: 20 characters/);
	assert.match(rendered(card).join("\n"), /source excerpt\nLast finding/);
	assert.doesNotMatch(rendered(card).join("\n"), /to expand|arbitrary prose/);
});

test("safe errors show the cause; errors that can quote withheld arguments disclose their full diagnostic", (t) => {
	binding(t, "ctrl+g");
	const file = tool("slop_check", { path: "missing.ts" });
	file.updateResult({ content: blocks("missing.ts: file does not exist"), isError: true });
	assert.ok(rendered(file).includes("missing.ts: file does not exist"));
	assert.doesNotMatch(rendered(file).join("\n"), /to expand|No slop findings/);
	const detectors = [{ id: "pattern", pattern: "private-pattern(", in: ["reply"] }];
	const corrupt = tool("slop_record", { action: "save", id: "field-note", operator: "operator quote", detectors });
	assert.ok(rendered(corrupt).includes("... (ctrl+g to expand)"));
	assert.throws(
		() => parseDetectors(detectors, ["reply"]),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /private-pattern\(/);
			corrupt.updateResult({ content: blocks(error.message), isError: true });
			return true;
		},
	);
	const compact = rendered(corrupt).join("\n");
	assert.match(compact, /The catalog change failed\.\n\.\.\. \(ctrl\+g to expand\)/);
	assert.equal(compact.match(/to expand/gu)?.length, 1);
	assert.doesNotMatch(compact, /private-pattern|operator quote/);
	corrupt.setExpanded(true);
	assert.match(
		rendered(corrupt, 180).join("\n"),
		/Detector 1 \(pattern\): invalid regular expression: SyntaxError: Invalid regular expression: \/private-pattern\(\/giu: Unterminated group/,
	);
	assert.doesNotMatch(rendered(corrupt).join("\n"), /operator quote|to expand/);
});

test("catalog result counts hidden visual lines and never applies an independent character cut", (t) => {
	binding(t, "ctrl+o");
	const long = "entry-name ".repeat(20).trim();
	const rows = Array.from({ length: 8 }, (_, i) => `Item ${i + 1}`);
	const card = tool("slop", { entry: "field-note" });
	card.updateResult({ content: blocks(rows.join("\n")), details: { summary: long }, isError: false });
	const wide = rendered(card, 300);
	assert.ok(wide.includes(long));
	assert.ok(wide.includes("Item 5"));
	assert.ok(!wide.includes("Item 6"));
	assert.ok(wide.includes("... (3 more lines, ctrl+o to expand)"));
	const narrow = rendered(card, 65);
	assert.ok(narrow.some((line) => line.endsWith("…")));
	assert.ok(narrow.includes("... (3 more lines, ctrl+o to expand)"));
	for (const row of card.render(65)) assert.ok(visibleWidth(row) <= 65);
	card.setExpanded(true);
	assert.ok(rendered(card, 65).includes("Item 8"));
});

function catalogFixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "slop-display-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "slop");
	mkdirSync(join(dir, "catalog"), { recursive: true });
	writeFileSync(
		join(dir, "catalog", "field-note.md"),
		`---
 id: field-note
 title: Field note
 domain: prose
 applies: ["reply"]
 prompt: false
 ---

 # Field note

 ## Recognition

 The title replaces the result.

 ## Cost

 The result is harder to find.

 ## Repair

 Put the result first.
`.replace(/^ /gmu, ""),
	);
	return { dir, options: { agentDir: root, env: {} } };
}

test("catalog inventory keeps starter guidance and zero counts out of the preview", (t) => {
	binding(t, "ctrl+o");
	const { options } = catalogFixture(t);
	const result = inspectCatalog(options, {});
	const modelText = result.content[0].text;
	assert.match(modelText, /^Starter set: [1-9]\d* new, 0 updated\. Read with slop \{"starter":true\}\./u);
	assert.match(modelText, /field-note · Field note · starter · active · 0 detector\(s\)/u);
	const card = tool("slop", {});
	card.updateResult({ ...result, isError: false });
	const compact = rendered(card, 180).join("\n");
	assert.match(compact, /1 slop entry; [1-9]\d* new starter entr/u);
	assert.match(compact, /field-note · Field note · prose · starter · active · The title replaces the result\./u);
	assert.doesNotMatch(compact, /Read with slop|detector|0 updated|more lines/u);
	assert.match(compact, /\.\.\. \(ctrl\+o to expand\)/u);
	card.setExpanded(true);
	assert.equal(rendered(card, 180).filter(Boolean).slice(1).join("\n"), modelText);
});

test("starter comparisons hide import guidance, even when no entry compares", (t) => {
	binding(t, "ctrl+o");
	const { dir } = catalogFixture(t);
	const one = compareStarter(dir, []).slice(0, 1);
	assert.equal(one.length, 1);
	for (const [comparison, outcome] of [
		[[], "No starter entries."],
		[one, "1 starter entry."],
	] as const) {
		const result = inspectStarter([...comparison]);
		const modelText = result.content[0].text;
		assert.match(modelText, /Import new entries with slop_record/u);
		const card = tool("slop", { starter: true });
		card.updateResult({ ...result, isError: false });
		const compact = rendered(card, 180).filter(Boolean);
		assert.ok(compact.includes(outcome));
		assert.equal(compact.length, 3 + comparison.length);
		assert.doesNotMatch(compact.join("\n"), /Import new entries|0 starter entries|more lines/u);
		assert.ok(compact.includes("... (ctrl+o to expand)"));
		card.setExpanded(true);
		assert.equal(rendered(card, 180).filter(Boolean).slice(1).join("\n"), modelText);
	}
});

test("a complete compact catalog page does not offer expansion for cosmetic differences", (t) => {
	binding(t, "ctrl+o");
	const { dir, options } = catalogFixture(t);
	for (const id of importEntries(dir)) removeEntry(dir, id, { session: "fixture", model: null });
	const result = inspectCatalog(options, {});
	assert.doesNotMatch(result.content[0].text, /Read with slop/u);
	const card = tool("slop", {});
	card.updateResult({ ...result, isError: false });
	assert.deepEqual(rendered(card, 180).filter(Boolean), [
		"slop list catalog",
		"1 slop entry.",
		"- field-note · Field note · prose · starter · active · The title replaces the result.",
	]);
});

test("ordinary request shows at most three wrapped rows of the hint, then reveals the full instructions on click", (t) => {
	binding(t, []);
	const width = 48;
	const hint = [`Hint one ${"wide words ".repeat(6)}`, "Hint two", "Last hint fragment"].join("\n");
	const card = request(hint);
	const collapsed = rendered(card, width);
	const titleRow = collapsed.indexOf("[slop] Check requested");
	const hintRow = collapsed.indexOf("... (click to expand)");
	assert.ok(titleRow > 0);
	assert.equal(collapsed[titleRow + 1], "");
	assert.equal(hintRow - titleRow - 2, 3);
	assert.doesNotMatch(collapsed.join("\n"), /Last hint fragment|task scaffolding|more lines/);
	assert.equal(card.handleMouse(click(titleRow, width, collapsed.length))?.handled, true);
	assert.match(rendered(card, width).join("\n"), /task scaffolding/);
	assert.match(rendered(card, width).join("\n"), /Last hint fragment/);
	assert.doesNotMatch(rendered(card, width).join("\n"), /to expand/);
	card.invalidate();
	assert.match(rendered(card, width).join("\n"), /Last hint fragment/);
	card.setExpanded(true);
	card.setExpanded(false);
	assert.doesNotMatch(rendered(card, width).join("\n"), /Last hint fragment/);
});

test("hint-free request has no placeholder in either view", (t) => {
	binding(t, "ctrl+e");
	const card = request("");
	assert.deepEqual(rendered(card).filter(Boolean), ["[slop] Check requested", "... (ctrl+e to expand)"]);
	card.setExpanded(true);
	assert.match(rendered(card).join("\n"), /Say in a few plain sentences/);
	assert.doesNotMatch(rendered(card).join("\n"), /Operator hint:|\(none\)|to expand/);
	assert.match(checkPrompt(""), /Operator hint:\n\(none\)$/);
});
