import assert from "node:assert/strict";
import test from "node:test";
import { normalize, settingShape, validateValue } from "./json-schema.ts";

const model = {
	type: "string",
	title: "Model",
	format: "model",
	minLength: 3,
	maxLength: 512,
	pattern: "^[^/\\s]+/[^\\s]+$",
};
const presets = {
	type: "object",
	title: "Presets",
	description: "Named presets.",
	propertyNames: { type: "string", title: "Name", pattern: "^[a-z]+$", maxLength: 64 },
	additionalProperties: {
		type: "object",
		title: "Preset",
		properties: {
			model,
			thinkingLevel: {
				title: "Thinking level",
				anyOf: [
					{ const: "low", title: "Low", description: "Less reasoning." },
					{ const: "high", title: "High" },
				],
			},
			notes: { type: "string", maxLength: 2000 },
			enforce: { type: "boolean", default: false },
		},
		required: ["model"],
		additionalProperties: false,
	},
	maxProperties: 8,
	default: {},
};

test("a declared schema becomes a labelled form descriptor", () => {
	assert.deepEqual(normalize(presets, presets), {
		type: "map",
		keys: { type: "string", maxLength: 64, pattern: "^[a-z]+$", label: "Name" },
		maxEntries: 8,
		label: "Presets",
		help: "Named presets.",
		default: {},
		values: {
			type: "object",
			label: "Preset",
			required: ["model"],
			additional: false,
			properties: {
				model: {
					type: "string",
					minLength: 3,
					maxLength: 512,
					pattern: model.pattern,
					format: "model",
					label: "Model",
				},
				thinkingLevel: {
					type: "enum",
					choices: ["low", "high"],
					labels: ["Low", "High"],
					notes: ["Less reasoning.", undefined],
					label: "Thinking level",
				},
				notes: { type: "string", maxLength: 2000, multiline: true, label: "Notes" },
				enforce: { type: "boolean", default: false, label: "Enforce" },
			},
		},
	});
	const { label, help, default: fallback } = settingShape(presets, presets);
	assert.deepEqual([label, help, fallback], [undefined, undefined, undefined]);
});

test("lists, pattern maps and open schemas keep their shape", () => {
	const list = { type: "array", items: model, maxItems: 4, uniqueItems: true };
	assert.deepEqual(normalize(list, list), {
		type: "array",
		items: { type: "string", minLength: 3, maxLength: 512, pattern: model.pattern, format: "model", label: "Model" },
		maxItems: 4,
		unique: true,
	});
	const patterned = { type: "object", patternProperties: { "^a": { type: "integer", minimum: 1 } } };
	assert.deepEqual(normalize(patterned, patterned), {
		type: "map",
		values: { type: "integer", minimum: 1 },
		keys: { type: "string", pattern: "^a" },
	});
	assert.deepEqual(normalize({}, {}), { type: "json" });
	assert.deepEqual(normalize({ not: {} }, { not: {} }), { type: "json", unsupported: ["not"] });
});

test("values are checked against every declared keyword", () => {
	const check = (value: unknown) => validateValue(presets, presets, value, "presets");
	assert.deepEqual(check({ judge: { model: "a/b", thinkingLevel: "high" } }), []);
	assert.match(check({ Judge: { model: "a/b" } }).join(" "), /name that is not allowed: "Judge"/);
	assert.match(check({ judge: { model: "ab" } }).join(" "), /presets.judge.model must have at least 3 characters/);
	assert.match(check({ judge: { model: "a b/c" } }).join(" "), /presets.judge.model does not have the required form/);
	assert.match(check({ judge: { model: "a/b", other: 1 } }).join(" "), /other is not allowed/);
	assert.match(check({ judge: { model: "a/b", thinkingLevel: "max" } }).join(" "), /one of "low", "high"/);
	const many = Object.fromEntries("abcdefghi".split("").map((key) => [key, { model: "a/b" }]));
	assert.match(check(many).join(" "), /at most 8 entries/);
	const list = { type: "array", items: { type: "string" }, uniqueItems: true };
	assert.match(validateValue(list, list, ["x", "x"], "list").join(" "), /must not repeat an item/);
});
