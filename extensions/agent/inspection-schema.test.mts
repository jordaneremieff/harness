import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import register from "./index.ts";
import { parseInspectParams } from "./durable-observation.ts";

it("declares native result, exact-entry, and cursor inspection inputs on the primary", () => {
	const tools = new Map<string, TSchema>();
	register({
		events: { emit() {} },
		on: () => () => {},
		registerTool: (tool: { name: string; parameters: TSchema }) => tools.set(tool.name, tool.parameters),
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
	} as unknown as ExtensionAPI);
	const schema = tools.get("agent_inspect");
	assert.ok(schema);
	const inputs = [
		{ sessionId: "storage", view: "result", submissionId: 7 },
		{ sessionId: "storage", view: "exact", entryId: 12, offset: 4 },
		{ sessionId: "storage", view: "history", cursor: { at: 5, bound: "native" } },
		{ sessionId: "storage", view: "result", operationId: "invocation" },
	];
	for (const input of inputs) {
		assert.equal(Check(schema, input), true, JSON.stringify(input));
		assert.doesNotThrow(() => parseInspectParams(input));
	}
	assert.equal(Check(schema, { sessionId: "storage", cursor: 5 }), false);
	assert.equal(Check(schema, { sessionId: "storage", continuation: "retired" }), false);
});
