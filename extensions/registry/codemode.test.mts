import { compile, obj } from "@earendil-works/pi-schema";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createCodemodeExtension, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import registerRegistry from "./index.ts";
import { RegistryOutputSchema } from "./output.ts";

// Public native factory and its real QuickJS executor; only host accessors and nested dispatch are fixtures.
it("native codemode receives registry objects and filters records without parsing prose", { timeout: 30000 }, async () => {
	const definitions = new Map<string, ToolDefinition>();
	const sourceInfo = { path: "builtin:fixture", source: "builtin", scope: "temporary" as const, origin: "top-level" as const };
	const pi = { on: () => () => {}, events: { emit: () => {}, on: () => () => {} }, registerTool: (tool: ToolDefinition) => definitions.set(tool.name, tool),
		getAllTools: () => [{ name: "sample", description: "read a fixture", parameters: obj({}, { open: true }), exposure: "codemode",
			namespace: { name: "fixture", aliases: ["reference-guide"] }, annotations: { readOnlyHint: true }, sourceInfo }],
		getActiveTools: () => [], getCommands: () => [], getSettings: () => ({}), appendEntry: () => { throw new Error("No store writes expected"); },
	} as unknown as ExtensionAPI;
	registerRegistry(pi);
	const failure = { name: "fixture_failure", label: "Failure", description: "Return a fixture error without a declared value.",
		parameters: obj({}, { open: true }), execute: async () => ({ content: [{ type: "text" as const, text: "Fixture failure" }], details: {}, isError: true }) } satisfies ToolDefinition;
	pi.registerTool(failure);
	await createCodemodeExtension({ models: false })(pi);
	const registry = definitions.get("registry");
	const codemode = definitions.get("codemode");
	assert.ok(registry && codemode);
	assert.equal(registry.outputSchema, RegistryOutputSchema);
	const ctx = {
		cwd: "/fixtures", mode: "print", hasUI: false,
		sessionManager: { getBranch: () => [] },
		tools: [{ ...registry, execute: async () => { throw new Error("Use nested dispatch"); } },
			{ name: "sample", label: "sample", description: "fixture", parameters: obj({}, { open: true }),
				execute: async () => { throw new Error("Discovery must not execute discovered tools"); } }, failure] as AgentTool[],
		executeTool: async (name: string, args: unknown) => {
			const nested = definitions.get(name);
			assert.ok(nested);
			const result = await nested.execute("script/1", args, undefined, undefined, ctx);
			if (name === "registry") assert.ok(compile(RegistryOutputSchema).check(result.structuredContent));
			return { toolCall: { type: "toolCall" as const, id: "script/1", name, arguments: args as Record<string, never> }, result, isError: result.isError === true };
		},
	} as unknown as ExtensionToolContext;
	const result = await codemode.execute("script", { code: `
const pages = await Promise.allSettled([
  tools.registry({kind: "tool", search: "REFERENCE-GUIDE"}),
  tools.registry({name: "absent", kind: "tool"}),
  tools.registry({cursor: "malformed"}),
  tools.fixture_failure({})
]);
if (pages.slice(0, 3).some(p => p.status !== "fulfilled")) throw new Error("call failed");
const page = pages[0].value;
if (typeof page !== "object" || page.outcome !== "ok") throw new Error("not typed output");
return {names: page.records.filter(r => r.kind === "tool" && r.callable).map(r => r.name),
  exposure: page.records[0].exposure, active: page.records[0].active, declared: page.records[0].modelDeclared,
  aliases: page.records[0].namespace.aliases,
  empty: pages[1].value.outcome, count: pages[1].value.returnedRecords,
  pageTruncated: page.pageTruncated, continuation: page.continuationStatus,
  emptyContinuation: pages[1].value.continuationStatus,
  invalid: pages[2].value.outcome, failureRejected: pages[3].status === "rejected"};
` }, undefined, undefined, ctx);
	assert.notEqual(result.isError, true, JSON.stringify(result.content));
	const text = result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
	assert.match(text, /"names":\s*\[\s*"sample"\s*\]/);
	assert.match(text, /"exposure":\s*"codemode"/);
	assert.match(text, /"active":\s*false/);
	assert.match(text, /"declared":\s*null/);
	assert.match(text, /"empty":\s*"missing"/);
	assert.match(text, /"count":\s*0/);
	assert.match(text, /"pageTruncated":\s*false/);
	assert.match(text, /"continuation":\s*"complete"/);
	assert.match(text, /"emptyContinuation":\s*"complete"/);
	assert.match(text, /"aliases":\s*\[\s*"reference-guide"\s*\]/);
	assert.match(text, /"invalid":\s*"invalid_arguments"/);
	assert.match(text, /"failureRejected":\s*true/);
	const calls = (result.details as { calls: { name: string; status: string }[] }).calls;
	assert.deepEqual(calls.filter((call) => call.name === "registry").map((call) => call.status), ["ok", "ok", "error"]);
	assert.equal(calls.find((call) => call.name === "fixture_failure")?.status, "error");
	const uncaught = await codemode.execute("uncaught", { code: "await tools.fixture_failure({})" }, undefined, undefined, ctx);
	assert.equal(uncaught.isError, true);
});
