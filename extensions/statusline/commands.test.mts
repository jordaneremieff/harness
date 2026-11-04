import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareDraft, restoreDraft } from "./commands.ts";

describe("draft preparation", () => {
	function editor(initial: string) {
		const calls: string[] = [];
		let text = initial;
		return {
			calls,
			getEditorText: () => text,
			setEditorText: (value: string) => {
				calls.push(`set:${value}`);
				text = value;
			},
			pasteToEditor: (value: string) => {
				calls.push(`paste:${value}`);
				text += value;
			},
		};
	}

	it("fills an empty editor directly", () => {
		const e = editor("");
		assert.deepEqual(prepareDraft(e, "/recap", "replace"), {});
		assert.deepEqual(e.calls, ["set:/recap"]);
	});

	it("inserts through paste handling and keeps the draft", () => {
		const e = editor("half-written");
		assert.deepEqual(prepareDraft(e, "/skill:dig why", "insert"), {});
		assert.deepEqual(e.calls, ["paste:/skill:dig why"]);
	});

	it("replaces only on request and returns the replaced draft for recovery", () => {
		const e = editor("half-written");
		assert.deepEqual(prepareDraft(e, "/recap", "replace"), { replaced: "half-written" });
		assert.deepEqual(e.calls, ["set:/recap"]);
		restoreDraft(editor(""), "half-written");
		const busy = editor("new text");
		restoreDraft(busy, "half-written");
		assert.deepEqual(busy.calls, ["paste:half-written"]);
	});
});
