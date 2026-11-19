import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

const reader = {} as ReaderCoreAPI;
runInNewContext(stripTypeScriptTypes(readFileSync(new URL("./logic.ts", import.meta.url), "utf8")), { reader });
const logic = reader.uiLogic;
const key = (key: string, writing = false, extra: Partial<ReaderKey> = {}, input = false) =>
	logic.keyCommand({ key, metaKey: true, ...extra }, { writing, input });

test("pending comments preserve an exact range or recover a single occurrence", () => {
	const exact = { start: 4, end: 7 };
	assert.equal(logic.reanchorPassage("one one", "one", exact), exact);
	const recovered = logic.reanchorPassage("😀 then one", "one", exact);
	assert.equal(recovered?.start, 8);
	assert.equal(recovered?.end, 11);
	assert.equal(logic.reanchorPassage("one one", "one", { start: 2, end: 5 }), undefined);
	assert.equal(logic.reanchorPassage("aaa", "aa"), undefined);
	assert.equal(logic.reanchorPassage("changed", "one", exact), undefined);
	assert.equal(logic.reanchorPassage("whole document", undefined, exact), undefined);
});

test("a formatted passage re-anchors with its source rather than its rendered quote", () => {
	const source = "Start **bold** and `code`.\n\nNext block.";
	const old = { start: 0, end: source.length };
	const anchor = source.slice(old.start, old.end);
	const prefix = "# Heading\n\n";
	assert.equal(logic.reanchorPassage(source, anchor, old), old);
	const moved = logic.reanchorPassage(prefix + source, anchor, old);
	assert.equal(moved?.start, prefix.length);
	assert.equal(moved?.end, prefix.length + source.length);
});

test("the mirrored Mac keys select one command for each context", () => {
	for (const [keyName, name] of [
		["f", "find"],
		["o", "open"],
		["e", "toggleLock"],
		["g", "findNext"],
		["=", "zoomIn"],
		["-", "zoomOut"],
		["0", "zoomReset"],
		["[", "back"],
		["]", "forward"],
	])
		assert.equal(key(keyName)?.name, name);
	assert.equal(key("g", false, { shiftKey: true })?.name, "findPrevious");
	assert.equal(key("f", false, { altKey: true })?.name, "replace");
	assert.equal(key("s", false, { ctrlKey: true })?.name, "toggleOutline");
	assert.equal(key("m", false, { shiftKey: true })?.name, "askSelection");
	assert.equal(key("m", false, { altKey: true })?.name, "askDocument");
	assert.equal(key("c", false, { shiftKey: true })?.name, "copyMarkdown");
	assert.equal(key("c", false, { altKey: true })?.name, "copyPassage");
});

test("writing format shortcuts do not displace reading navigation", () => {
	assert.equal(key("i")?.name, "showDetails");
	assert.equal(key("i", true)?.args?.command, "italic");
	assert.equal(key("k")?.name, "open");
	assert.equal(key("k", true)?.args?.command, "link");
	assert.equal(key("k", true, { shiftKey: true })?.args?.command, "code");
	assert.equal(key("b", true)?.args?.command, "bold");
});

test("composition and ordinary text controls retain their editing keys", () => {
	assert.equal(key("f", true, { isComposing: true }), null);
	assert.equal(key("z", true, {}, true), null);
	assert.equal(key("i", true, {}, true), null);
	assert.equal(key("k", true, {}, true), null);
	assert.equal(key("f", false, {}, true)?.name, "find");
	assert.equal(key("q"), null);
	assert.equal(key("x", false, { metaKey: false }), null);
});

test("find status never reports a current match beyond its count", () => {
	assert.equal(logic.findStatus(0, 0), "No matches");
	assert.equal(logic.findStatus(11, 5), "6 of 11");
	assert.equal(logic.findStatus(2, 9), "2 of 2");
	assert.equal(logic.findStatus(2, -1), "1 of 2");
});

test("text zoom follows host steps and resets to the base size", () => {
	const steps = [0.8125, 0.875, 0.9375, 1, 1.0625, 1.125, 1.25, 1.375, 1.5, 1.6875];
	assert.equal(logic.zoomStep(1, steps, 1), 1.0625);
	assert.equal(logic.zoomStep(1, steps, -1), 0.9375);
	assert.equal(logic.zoomStep(1.6875, steps, 1), 1.6875);
	assert.equal(logic.zoomStep(0.8125, steps, -1), 0.8125);
	assert.equal(logic.zoomStep(1.5, steps, null), 1);
	assert.equal(logic.zoomStep(1, [], 1), 1);
	assert.equal(logic.zoomStep(1, [NaN, 0, -1, 1, 1.25], 1), 1.25);
});

test("outline current row follows measured heading positions without a delay", () => {
	assert.equal(logic.currentHeading([], 74), -1);
	assert.equal(
		logic.currentHeading(
			[
				{ start: 0, top: 110 },
				{ start: 20, top: 200 },
			],
			74,
		),
		0,
	);
	assert.equal(
		logic.currentHeading(
			[
				{ start: 0, top: -30 },
				{ start: 20, top: 74 },
				{ start: 50, top: 200 },
			],
			74,
		),
		1,
	);
});

test("prompt progress cannot regress or resubmit an unknown admission", () => {
	assert.equal(logic.promptTransition("working", "sent"), "working");
	assert.equal(logic.promptTransition("answered", "failed"), "answered");
	assert.equal(logic.promptTransition("unanswered", "sent"), "unanswered");
	assert.equal(logic.promptTransition("unknown", "sent"), "unknown");
	assert.equal(logic.promptTransition("unknown", "answered"), "answered");
	assert.equal(logic.promptTransition("failed", "sending"), "sending");
	assert.equal(logic.promptTransition("sent", "failed"), "failed");
	assert.equal(logic.promptTransition("admitted", "working"), "working");
});

test("inline change context preserves unchanged text around mapped UTF-16 ranges", () => {
	const source = "before\r\nThe agent makes this 👩‍💻 passage clearer. Every change stays.\r\nafter";
	const start = source.indexOf("makes"),
		end = source.indexOf(" Every");
	const context = logic.changeContext(
		source,
		{ start: 8, end: source.length - 7 },
		{
			start,
			end,
			oldText: "works on this passage.",
			newText: source.slice(start, end),
		},
	);
	assert.equal(context?.prefix, "The agent ");
	assert.equal(context?.suffix, " Every change stays.");
	assert.equal(
		logic.changeContext(
			source,
			{ start: 8, end: source.length },
			{
				start,
				end,
				oldText: "old",
				newText: "later overlap",
			},
		),
		null,
	);
	assert.equal(
		logic.changeContext(
			source,
			{ start: end, end: source.length },
			{
				start,
				end,
				oldText: "old",
				newText: source.slice(start, end),
			},
		),
		null,
	);
});

test("inline change context spans paragraphs and preserves insertion and deletion neighbours", () => {
	for (const [source, edit, old] of [
		["A new\n\npassage Z", { start: 2, end: 15, oldText: "old words", newText: "new\n\npassage " }, "A old wordsZ"],
		["A Z", { start: 2, end: 2, oldText: "removed ", newText: "" }, "A removed Z"],
		["A added Z", { start: 2, end: 8, oldText: "", newText: "added " }, "A Z"],
	] as const) {
		const context = logic.changeContext(source, { start: 0, end: source.length }, edit);
		assert.ok(context);
		assert.equal(context.prefix + edit.oldText + context.suffix, old);
		assert.equal(context.prefix + edit.newText + context.suffix, source);
	}
});

test("inline differences preserve exact original and replacement text", () => {
	for (const [before, after] of [
		["Read the old words.", "Read the new words."],
		["", "One"],
		["One", ""],
		["A\r\nB", "A\r\nC"],
		["same", "same"],
		["A 👩‍💻 é", "B 👩‍💻 é"],
	]) {
		const parts = logic.diffWords(before, after);
		assert.ok(parts);
		assert.equal(
			parts
				.filter((p) => p.kind !== "added")
				.map((p) => p.text)
				.join(""),
			before,
		);
		assert.equal(
			parts
				.filter((p) => p.kind !== "removed")
				.map((p) => p.text)
				.join(""),
			after,
		);
	}
});

test("separated edits leave shared words, emoji and punctuation unmarked", () => {
	const parts = logic.diffWords("Meet Tuesday, 👩‍💻, at two.", "Meet Thursday, 👩‍💻, at four!");
	assert.ok(parts);
	assert.deepEqual(Array.from(parts.filter(p => p.kind === "same"), p => p.text), ["Meet ", ", 👩‍💻, at "]);
	assert.deepEqual(Array.from(parts.filter(p => p.kind === "added"), p => p.text), ["Thursday", "four!"]);
	const punctuation = logic.diffWords("Keep it.", "Keep it?");
	assert.equal(punctuation?.[0].text, "Keep it");
});

test("an oversized word comparison yields plain versions, not guessed highlights", () => {
	assert.equal(logic.diffWords("one ".repeat(1000), "two ".repeat(1000)), null);
	assert.equal(logic.diffWords("x".repeat(100_000), "y"), null);
	const prefix = "Shared ".repeat(1000);
	assert.equal(logic.diffWords(`${prefix}one`, `${prefix}two`)?.[0].text, prefix);
});

test("the ask card floats beside its anchor inside the pane and never covers it", () => {
	const pane = { width: 452, height: 880, top: 46 };
	const card = { width: 428, height: 300 };
	const overlaps = (p: { top: number; maxHeight: number }, height: number, a: { top: number; bottom: number }) =>
		p.top < a.bottom && p.top + Math.min(height, p.maxHeight) > a.top;
	const middle = { top: 300, bottom: 340, left: 60 };
	const below = logic.cardPlacement(middle, card, pane);
	assert.equal(below.side, "below");
	assert.equal(below.top, 350);
	assert.equal(below.left, 12);
	assert.ok(!overlaps(below, card.height, middle));
	const low = { top: 700, bottom: 740, left: 60 };
	const above = logic.cardPlacement(low, card, pane);
	assert.equal(above.side, "above");
	assert.equal(above.top, 390);
	assert.ok(!overlaps(above, card.height, low));
	const tall = logic.cardPlacement({ top: 360, bottom: 520, left: 30 }, { width: 360, height: 500 }, pane);
	assert.equal(tall.side, "below");
	assert.ok(tall.maxHeight >= 120 && tall.top + tall.maxHeight <= pane.height - 12);
	assert.ok(!overlaps(tall, 500, { top: 360, bottom: 520 }));
	const wide = logic.cardPlacement(
		{ top: 200, bottom: 230, left: 700 },
		{ width: 360, height: 300 },
		{ width: 800, height: 760, top: 46 },
	);
	assert.equal(wide.left, 800 - 360 - 12);
	const offscreen = logic.cardPlacement({ top: -400, bottom: -360, left: 60 }, card, pane);
	assert.ok(offscreen.top >= pane.top && offscreen.top + card.height <= pane.height - 12);
});

const target = (partial: Partial<ReaderMenuTarget>): ReaderMenuTarget => ({
	area: "document",
	lock: "reading",
	selection: false,
	selectionInOneBlock: false,
	editor: false,
	block: true,
	heading: false,
	image: false,
	imageAlt: false,
	code: false,
	table: false,
	inputSelection: false,
	inputEditable: false,
	...partial,
});
const ids = (t: ReaderMenuTarget) =>
	Array.from(logic.contextMenuItems(t), (e) => (e.separator ? "|" : e.enabled ? e.id : `(${e.id})`));

test("the context menu offers the actions that apply where the person clicks", () => {
	assert.deepEqual(ids(target({ selection: true, selectionInOneBlock: true })), [
		"ask",
		"|",
		"copy",
		"copyPassage",
		"|",
		"editSelection",
		"find",
		"toggleLock",
	]);
	assert.deepEqual(ids(target({})), ["askDocument", "|", "editHere", "find", "toggleLock"]);
	assert.deepEqual(ids(target({ lock: "writing", editor: true })), [
		"askDocument",
		"|",
		"(cut)",
		"(copy)",
		"paste",
		"|",
		"bold",
		"italic",
		"code",
		"link",
		"|",
		"heading",
		"bulletList",
		"numberedList",
		"taskList",
		"quote",
		"|",
		"find",
		"toggleLock",
	]);
	assert.deepEqual(
		ids(target({ lock: "writing", editor: true, selection: true, selectionInOneBlock: true, heading: true })).slice(
			0,
			7,
		),
		["ask", "|", "cut", "copy", "paste", "copyPassage", "|"],
	);
	assert.ok(ids(target({ lock: "writing", editor: true, heading: true })).includes("bodyText"));
	assert.deepEqual(ids(target({ lock: "writing", selection: true, selectionInOneBlock: false })), [
		"ask",
		"|",
		"cut",
		"copy",
		"paste",
		"copyPassage",
		"|",
		"editSelection",
		"find",
		"toggleLock",
	]);
	assert.deepEqual(ids(target({ link: { internal: false } })).slice(0, 5), [
		"askDocument",
		"|",
		"openLink",
		"copyLink",
		"|",
	]);
	assert.deepEqual(ids(target({ link: { internal: true } })).slice(2, 3), ["openLink"]);
	assert.deepEqual(ids(target({ image: true, imageAlt: true })).slice(2, 4), ["inspectImage", "copyImageText"]);
	assert.deepEqual(ids(target({ code: true })).slice(2, 3), ["copyCode"]);
	assert.deepEqual(ids(target({ table: true })).slice(2, 3), ["copyTable"]);
	assert.deepEqual(ids(target({ area: "input", inputEditable: true })), ["(cut)", "(copy)", "paste", "|", "selectAll"]);
	assert.deepEqual(ids(target({ area: "input", inputEditable: true, inputSelection: true })).slice(0, 3), [
		"cut",
		"copy",
		"paste",
	]);
	assert.deepEqual(ids(target({ area: "other" })), []);
	const keys = Object.fromEntries(
		logic
			.contextMenuItems(target({ lock: "writing", editor: true, selection: true, selectionInOneBlock: true }))
			.map((e) => [e.id, e.key]),
	);
	assert.equal(keys.ask, "⇧⌘M");
	assert.equal(keys.cut, "⌘X");
	assert.equal(keys.paste, "⌘V");
	assert.equal(keys.bold, "⌘B");
});

test("the context menu opens at the pointer and stays inside the pane", () => {
	const pane = { width: 452, height: 880 },
		size = { width: 240, height: 300 };
	assert.deepEqual({ ...logic.menuPlacement({ x: 100, y: 200 }, size, pane) }, { left: 102, top: 202, maxHeight: 868 });
	const right = logic.menuPlacement({ x: 400, y: 200 }, size, pane);
	assert.equal(right.left, 400 - 240 - 2);
	const low = logic.menuPlacement({ x: 100, y: 800 }, size, pane);
	assert.equal(low.top, 800 - 300 - 2);
	const tall = logic.menuPlacement({ x: 10, y: 10 }, { width: 240, height: 1000 }, pane);
	assert.ok(tall.top >= 6 && tall.maxHeight === 868);
});

test("the selection strip never covers the selected lines", () => {
	const strip = { width: 220, height: 30 },
		pane = { width: 775, height: 880, top: 46 };
	const low = logic.stripPlacement({ top: 300, bottom: 320, left: 300, right: 360 }, strip, pane);
	assert.equal(low.side, "above");
	assert.equal(low.top, 300 - 8 - 30);
	assert.equal(low.left, 330 - 110);
	// Right under the bar: no room above, so the strip goes below the line.
	const top = logic.stripPlacement({ top: 64, bottom: 93, left: 300, right: 360 }, strip, pane);
	assert.equal(top.side, "below");
	assert.equal(top.top, 93 + 8);
	assert.ok(top.top >= 93 && top.top + strip.height <= pane.height);
	// Near the bottom edge, above still wins.
	assert.equal(logic.stripPlacement({ top: 840, bottom: 860, left: 10, right: 40 }, strip, pane).side, "above");
	// The strip stays inside the pane sideways.
	assert.equal(logic.stripPlacement({ top: 300, bottom: 320, left: 0, right: 10 }, strip, pane).left, 8);
	assert.equal(logic.stripPlacement({ top: 300, bottom: 320, left: 760, right: 770 }, strip, pane).left, 775 - 220 - 8);
	// A selection taller than the page takes the side with more room, inside the page.
	const tall = logic.stripPlacement({ top: 60, bottom: 2000, left: 100, right: 600 }, strip, pane);
	assert.equal(tall.side, "above");
	assert.ok(tall.top >= pane.top + 8 && tall.top + strip.height <= pane.height - 8);
	const tallLow = logic.stripPlacement({ top: 300, bottom: 2000, left: 100, right: 600 }, strip, pane);
	assert.deepEqual([tallLow.side, tallLow.top], ["above", 300 - 8 - 30]);
});
