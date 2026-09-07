import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerRegistry, { RegistryParams, readSnapshot } from "./index.ts";

const sourceInfo = { path: "/fixtures/SKILL.md", source: "fixture", scope: "temporary" as const, origin: "top-level" as const };
const context = { cwd: "/fixtures", mode: "rpc", hasUI: true, isProjectTrusted: () => true } as ExtensionContext;
function fixture() {
	const handlers = new Map<string, (event: Record<string, unknown>) => Promise<void>>();
	const registeredNames: string[] = [];
	let tool: ToolDefinition<typeof RegistryParams, Record<string, unknown>> | undefined;
	const pi = {
		on: (event: string, handler: (event: Record<string, unknown>) => Promise<void>) => { handlers.set(event, handler); },
		registerTool: (value: NonNullable<typeof tool>) => { registeredNames.push(value.name); tool = value; },
		getAllTools: () => ["one", "two"].map((name) => ({ name, sourceInfo })),
		getActiveTools: () => ["one"],
		getCommands: () => [{ name: "skill:example", source: "skill", sourceInfo }],
	} as unknown as ExtensionAPI;
	registerRegistry(pi);
	assert.deepEqual(registeredNames, ["registry"]);
	assert.ok(tool);
	return { pi, handlers, tool };
}

describe("Pi adapter", () => {
	it("registers the tool and executes without a UI or model", async () => {
		const { tool } = fixture();
		assert.equal(tool.name, "registry");
		assert.equal(tool.label, "Registry");
		assert.ok(tool.description.trim().length > 0);
		assert.ok(tool.promptSnippet?.trim().length);
		assert.ok(tool.promptGuidelines?.length);
		assert.ok(tool.promptGuidelines?.every((guideline) => guideline.includes("registry")));
		const result = await tool.execute("lookup", {}, undefined, undefined, { ...context, hasUI: false });
		assert.equal(result.details?.outcome, "host_summary");
		assert.equal(result.content[0].type, "text");
		if (result.content[0].type === "text") assert.match(result.content[0].text, /^registry outcome=host_summary\n/);
		assert.equal((RegistryParams as unknown as Record<string, unknown>).additionalProperties, false);
	});
	it("copies selected observation metadata and clears it at both lifecycle boundaries", async () => {
		const { tool, handlers } = fixture();
		await handlers.get("session_start")!({});
		const options = { cwd: "/fixtures", customPrompt: "private prompt", appendSystemPrompt: "private append",
			contextFiles: [{ path: "/fixtures/AGENTS.md", content: "private context" }], selectedTools: ["one"],
			skills: [{ name: "example", filePath: sourceInfo.path, baseDir: "/fixtures", disableModelInvocation: true, sourceInfo: { ...sourceInfo } }] };
		await handlers.get("before_agent_start")!({ systemPromptOptions: options, prompt: "private event" });
		options.skills[0].disableModelInvocation = false;
		options.skills[0].sourceInfo.path = "/changed";
		const result = await tool.execute("lookup", { name: "example" }, undefined, undefined, context);
		assert.ok(result.details);
		assert.equal((result.details.records as { modelInvocable: { value: boolean } }[])[0].modelInvocable.value, false);
		assert.doesNotMatch(JSON.stringify(result), /private prompt|private append|private context|private event/);
		await handlers.get("session_shutdown")!({});
		const stopped = await tool.execute("lookup", {}, undefined, undefined, context);
		assert.equal(stopped.details?.outcome, "cancelled");
		await handlers.get("session_start")!({});
		const restarted = await tool.execute("lookup", {}, undefined, undefined, context);
		assert.equal(restarted.details?.observed, false);
	});
	it("invalidates a cursor across both reset and fresh extension instances", async () => {
		const first = fixture();
		const result = await first.tool.execute("lookup", { kind: "tool", limit: 1 }, undefined, undefined, context);
		const cursor = result.details?.cursor as string;
		assert.equal(typeof cursor, "string");
		await first.handlers.get("session_start")!({});
		const reset = await first.tool.execute("lookup", { cursor }, undefined, undefined, context);
		assert.equal(reset.details?.outcome, "stale_cursor");
		const second = fixture();
		const fresh = await second.tool.execute("lookup", { cursor }, undefined, undefined, context);
		assert.equal(fresh.details?.outcome, "stale_cursor");
	});
	it("does not probe host metadata after cancellation", async () => {
		const { tool, pi, handlers } = fixture();
		const probes: string[] = [];
		pi.getAllTools = () => { probes.push("tools"); return []; };
		pi.getActiveTools = () => { probes.push("active"); return []; };
		pi.getCommands = () => { probes.push("commands"); return []; };
		const ctx = new Proxy(context, { get(target, key, receiver) { probes.push(String(key)); return Reflect.get(target, key, receiver); } });
		const result = await tool.execute("cancelled", { kind: "model" }, AbortSignal.abort(), undefined, ctx);
		assert.equal(result.details?.outcome, "cancelled");
		assert.deepEqual(probes, []);
		await handlers.get("session_shutdown")!({});
		const stopped = await tool.execute("stopped", { kind: "model" }, undefined, undefined, ctx);
		assert.equal(stopped.details?.outcome, "cancelled");
		assert.deepEqual(probes, []);
	});
	it("reports each failed host accessor independently", () => {
		const { pi } = fixture();
		pi.getAllTools = () => { throw new Error("tool surface unavailable"); };
		pi.getActiveTools = () => { throw new Error("active surface unavailable"); };
		const snapshot = readSnapshot(pi, null, 1);
		assert.deepEqual(snapshot.availability, { tools: false, activeTools: false, commands: true });
		pi.getCommands = () => { throw new Error("commands unavailable"); };
		assert.equal(readSnapshot(pi, null, 1).availability.commands, false);
	});
});
