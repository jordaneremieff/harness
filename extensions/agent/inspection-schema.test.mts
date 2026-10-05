import { ProfiledListOutputSchema } from "./profile-discovery.ts";
import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import register from "./index.ts";
import { parseInspectParams } from "./durable-observation.ts";
import { AGENT_CONTROL_TOOL_NAMES, AGENT_CONTROL_GUIDANCE } from "./control-guidance.ts";
import { StatusToolOutputSchema, InspectOutputSchema } from "./observation-schema.ts";

interface ToolDeclaration { name: string; parameters: TSchema; outputSchema?: TSchema; promptSnippet?: string; promptGuidelines?: string[] }
function declarations(): Map<string, ToolDeclaration> {
	const tools = new Map<string, ToolDeclaration>();
	register({
		events: { emit() {}, on: () => () => {} }, on: () => () => {},
		registerTool: (tool: ToolDeclaration) => tools.set(tool.name, tool),
		registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {},
	} as unknown as ExtensionAPI);
	return tools;
}

it("declares shared task guidance and exact observation results on primary tools", () => {
	const tools = declarations();
	for (const name of AGENT_CONTROL_TOOL_NAMES) {
		const declaration = tools.get(name);
		assert.ok(declaration);
		assert.equal(declaration.promptSnippet, AGENT_CONTROL_GUIDANCE[name].snippet);
		assert.deepEqual(declaration.promptGuidelines, [...AGENT_CONTROL_GUIDANCE[name].guidelines ?? []]);
	}
	assert.deepEqual(tools.get("agent_list")?.outputSchema, ProfiledListOutputSchema);
	assert.deepEqual(tools.get("agent_status")?.outputSchema, StatusToolOutputSchema);
	assert.deepEqual(tools.get("agent_inspect")?.outputSchema, InspectOutputSchema);
});

it("declares native result, exact-entry, and cursor inspection inputs on the primary", () => {
	const schema = declarations().get("agent_inspect")?.parameters;
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
