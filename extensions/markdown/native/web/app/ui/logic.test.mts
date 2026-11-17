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
	assert.equal(logic.promptTransition("unknown", "sent"), "unknown");
	assert.equal(logic.promptTransition("unknown", "answered"), "answered");
	assert.equal(logic.promptTransition("failed", "sending"), "sending");
	assert.equal(logic.promptTransition("sent", "failed"), "failed");
	assert.equal(logic.promptTransition("admitted", "working"), "working");
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
