import assert from "node:assert/strict";
import test from "node:test";
import type { ValueSchema } from "../../../../protocol.ts";
import { initialValue, parseValue } from "./control.ts";

const layout = {
	type: "object",
	properties: {
		root: { type: "string", path: "absolute" },
		widths: {
			type: "array",
			minItems: 1,
			items: {
				type: "union",
				options: [
					{ type: "integer", minimum: 20 },
					{ type: "enum", choices: ["auto"] },
				],
			},
		},
		overrides: { type: "map", values: { type: "boolean" } },
	},
	required: ["root", "widths"],
	additional: false,
} as const satisfies ValueSchema;

test("initial values satisfy ordinary bounds and omit optional object fields", () => {
	const seed = initialValue(layout);
	assert.deepEqual(seed, { root: "/", widths: [20] });
	assert.deepEqual(parseValue(JSON.stringify(seed), layout), { value: seed });
	assert.equal(initialValue({ type: "number", maximum: -0.5 }), -0.5);
	assert.equal(initialValue({ type: "integer", minimum: 0.5 }), 1);
});

test("nested schema errors distinguish bounds, missing keys and extra keys", () => {
	assert.match(error(' {"widths": ["auto"]}', layout), /requires "root"/);
	assert.match(error('{"root": ".", "widths": ["auto"]}', layout), /must start with/);
	assert.match(error('{"root": "/", "widths": []}', layout), /at least 1 items/);
	assert.match(error('{"root": "/", "widths": [19]}', layout), /item 1/);
	assert.match(error('{"root": "/", "widths": ["auto"], "other": true}', layout), /does not allow "other"/);
	assert.match(
		error('{"root": "/", "widths": ["auto"], "overrides": {"small": 1}}', layout),
		/"small" must be true or false/,
	);
});

test("enum choices compare JSON structurally", () => {
	const schema: ValueSchema = { type: "enum", choices: [{ first: 1, second: [null] }, null] };
	assert.deepEqual(parseValue('{"second":[null],"first":1}', schema), { value: { first: 1, second: [null] } });
	assert.deepEqual(parseValue("null", schema), { value: null });
	assert.match(error('{"first":1}', schema), /listed choices/);
});

test("incomplete numbers and overflowing JSON numbers do not become values", () => {
	assert.match(error("-", { type: "number" }), /complete JSON/);
	assert.match(error("1e-", { type: "number" }), /complete JSON/);
	assert.match(error("1.5", { type: "integer" }), /whole number/);
	assert.match(error('{"nested":[1e1000]}', { type: "json" }), /finite/);
});

function error(raw: string, schema: ValueSchema): string {
	const parsed = parseValue(raw, schema);
	assert.ok("error" in parsed);
	return parsed.error;
}
