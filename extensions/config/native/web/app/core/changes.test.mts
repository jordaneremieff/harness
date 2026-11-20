import assert from "node:assert/strict";
import test from "node:test";
import type { ValueSchema } from "../../../../protocol.ts";
import { describeChanges } from "./changes.ts";

const presets: ValueSchema = {
	type: "map",
	values: {
		type: "object",
		properties: {
			model: { type: "string", label: "Model" },
			thinkingLevel: { type: "enum", choices: ["high", "max"], labels: ["High", "Max"], label: "Thinking level" },
			tags: { type: "array", items: { type: "string" }, label: "Tags" },
		},
		additional: false,
	},
};

test("a review names each changed part of a structured value", () => {
	const before = { judge: { model: "a/b", thinkingLevel: "high", tags: ["x"] }, old: { model: "c/d" } };
	const after = { judge: { model: "a/b", thinkingLevel: "max", tags: ["x", "y"] }, fresh: { model: "e/f" } };
	assert.deepEqual(describeChanges(before, after, presets), [
		"judge › Thinking level: High → Max",
		"judge › Tags: added y",
		"old: removed",
		"fresh › Model: added e/f",
	]);
	assert.deepEqual(describeChanges(["a", "b"], ["b", "a"]), ["Value: new order"]);
	assert.deepEqual(describeChanges("text", "other"), []);
	assert.deepEqual(describeChanges(undefined, { a: 1 }), []);
});

test("a long review stays bounded", () => {
	const before = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, index]));
	const after = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, index + 1]));
	const lines = describeChanges(before, after);
	assert.equal(lines.length, 12);
	assert.equal(lines.at(-1), "9 more changes");
});
