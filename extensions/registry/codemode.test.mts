import assert from "node:assert/strict";
import { it } from "node:test";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createCodemodeExtension, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import registerRegistry from "./index.ts";
import { RegistryOutputSchema } from "./output.ts";

// Public native factory and its real QuickJS executor; only host accessors and nested dispatch are fixtures.
it("native codemode receives registry objects and filters records without parsing prose", { timeout: 30000 }, async () => {
	const definitions = new Map<string, ToolDefinition>();
	const sourceInfo = { path: "builtin:fixture", source: "builtin", scope: "temporary" as const, origin: "top-level" as const };
	const pi = { on: () => () => {}, events: { emit: () => {}, on: () => () => {} }, registerTool: (tool: ToolDefinition) => definitions.set(tool.name, tool),
		getAllTools: () => [{ name: "sample", description: "read a fixture", parameters: Type.Object({}), exposure: "codemode",
			namespace: { name: "fixture" }, annotations: { readOnlyHint: true }, sourceInfo }],
		getActiveTools: () => [], getCommands: () => [], getSettings: () => ({}), appendEntry: () => { throw new Error("No store writes expected"); },
	} as unknown as ExtensionAPI;
	registerRegistry(pi);
	await createCodemodeExtension({ models: false })(pi);
	const registry = definitions.get("registry");
	const codemode = definitions.get("codemode");
	assert.ok(registry && codemode);
	assert.equal(registry.outputSchema, RegistryOutputSchema);
	const ctx = {
		cwd: "/fixtures", mode: "print", hasUI: false,
		sessionManager: { getBranch: () => [] },
		tools: [{ ...registry, execute: async () => { throw new Error("Use nested dispatch"); } },
			{ name: "sample", label: "sample", description: "fixture", parameters: Type.Object({}),
				execute: async () => { throw new Error("Discovery must not execute discovered tools"); } }] as AgentTool[],
		executeTool: async (name: string, args: unknown) => {
			assert.equal(name, "registry");
			const result = await registry.execute("script/1", args, undefined, undefined, ctx);
			assert.ok(Check(RegistryOutputSchema, result.structuredContent));
			return { toolCall: { type: "toolCall" as const, id: "script/1", name, arguments: args as Record<string, never> }, result, isError: false };
		},
	} as unknown as ExtensionToolContext;
	const result = await codemode.execute("script", { code: `
const pages = await Promise.allSettled([
  tools.registry({kind: "tool"}),
  tools.registry({name: "absent", kind: "tool"})
]);
if (pages.some(p => p.status !== "fulfilled")) throw new Error("call failed");
const page = pages[0].value;
if (typeof page !== "object" || page.outcome !== "ok") throw new Error("not typed output");
return {names: page.records.filter(r => r.kind === "tool" && r.callable).map(r => r.name),
  exposure: page.records[0].exposure, active: page.records[0].active, declared: page.records[0].modelDeclared,
  empty: pages[1].value.outcome, count: pages[1].value.returnedRecords};
` }, undefined, undefined, ctx);
	assert.notEqual(result.isError, true, JSON.stringify(result.content));
	const text = result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
	assert.match(text, /"names":\s*\[\s*"sample"\s*\]/);
	assert.match(text, /"exposure":\s*"codemode"/);
	assert.match(text, /"active":\s*false/);
	assert.match(text, /"declared":\s*null/);
	assert.match(text, /"empty":\s*"missing"/);
	assert.match(text, /"count":\s*0/);
});
