import type { Schema } from "@earendil-works/pi-schema";
import { ProfiledListOutputSchema } from "./profile-discovery.ts";
import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesSchema } from "./schema-check.ts";
import register from "./index.ts";
import { parseInspectParams } from "./durable-observation.ts";
import { AGENT_CONTROL_TOOL_NAMES, agentControlGuidance } from "./control-guidance.ts";
import { StatusToolOutputSchema, InspectToolOutputSchema } from "./observation-schema.ts";

interface ToolDeclaration { name: string; parameters: Schema; outputSchema?: Schema; promptSnippet?: string; promptGuidelines?: string[] }
async function declarations(): Promise<Map<string, ToolDeclaration>> {
	const tools = new Map<string, ToolDeclaration>();
	await register({
		events: { emit() {}, on: () => () => {} }, on: () => () => {},
		registerTool: (tool: ToolDeclaration) => tools.set(tool.name, tool),
		registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {},
	} as unknown as ExtensionAPI);
	return tools;
}

it("declares shared task guidance and exact observation results on primary tools", async () => {
	const tools = await declarations();
	assert.equal(tools.has("agent_await"), false, "native await is absent from ordinary primaries");
	for (const name of AGENT_CONTROL_TOOL_NAMES) {
		const declaration = tools.get(name);
		assert.ok(declaration);
		const guidance = agentControlGuidance(name, "ordinary");
		assert.equal(declaration.promptSnippet, guidance.snippet);
		assert.deepEqual(declaration.promptGuidelines, [...guidance.guidelines ?? []]);
	}
	assert.deepEqual(tools.get("agent_list")?.outputSchema, ProfiledListOutputSchema);
	assert.deepEqual(tools.get("agent_status")?.outputSchema, StatusToolOutputSchema);
	assert.deepEqual(tools.get("agent_inspect")?.outputSchema, InspectToolOutputSchema);
});

it("declares native result, exact-entry, and cursor inspection inputs on the primary", async () => {
	const schema = (await declarations()).get("agent_inspect")?.parameters;
	assert.ok(schema);
	const inputs = [
		{ sessionId: "storage", view: "result", submissionId: 7 },
		{ sessionId: "storage", view: "exact", entryId: 12, offset: 4 },
		{ sessionId: "storage", view: "history", cursor: { at: 5, bound: "native" } },
		{ sessionId: "storage", view: "result", operationId: "invocation" },
	];
	for (const input of inputs) {
		assert.equal(matchesSchema(schema, input), true, JSON.stringify(input));
		assert.doesNotThrow(() => parseInspectParams(input));
	}
	assert.equal(matchesSchema(schema, { sessionId: "storage", cursor: 5 }), false);
	assert.equal(matchesSchema(schema, { sessionId: "storage", continuation: "retired" }), false);
});

it("keeps receipt cursors separate from entry cursors and rejects non-result selectors", () => {
	const selected = { view: "result", submissionId: 7, receiptCursor: "recipient-page" };
	assert.equal(parseInspectParams(selected).receiptCursor, selected.receiptCursor);
	assert.equal(parseInspectParams({ ...selected, offset: 4095 }).offset, 4095);
	for (const view of [undefined, "activity", "history", "branch", "search", "exact"]) assert.throws(() => parseInspectParams({ ...selected, view }), /receiptCursor.*only the result view/u);
	for (const receiptCursor of [null, 1, {}, [], "", "x".repeat(2049)]) assert.throws(() => parseInspectParams({ ...selected, receiptCursor }), /receiptCursor/u);
	for (const offset of [-1, 0.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseInspectParams({ view: "result", submissionId: 7, offset }), /offset|integer/u);
});
