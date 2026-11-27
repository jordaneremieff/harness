import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { AGENT_CONTROL_GUIDANCE } from "./control-guidance.ts";

it("gives ordinary coordination tools completion and low-message guidance", async () => {
	const tools = new Map<
		string,
		{ description: string; parameters: { properties: Record<string, { description?: string }> } }
	>();
	await register({
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		registerFlag() {},
		registerTool: (tool: {
			name: string;
			description: string;
			parameters: { properties: Record<string, { description?: string }> };
		}) => tools.set(tool.name, tool),
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		registerCommand() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	assert.match(tools.get("agent_intent")?.description ?? "", /update or clear intent when integration completes/u);
	const send = tools.get("agent_send");
	assert.ok(send);
	assert.match(send.description, /one proposal with conditions and one answer/u);
	assert.match(send.description, /without repeated acknowledgments/u);
	assert.match(send.description, /agreements that others must see in a thread\./u);
	assert.match(send.parameters.properties.checkInMinutes.description ?? "", /agent\.checkInMinutes \(0 disables\)/u);
});

it("omits held-await controls from ordinary primaries and retains background spawn", async () => {
	const tools = new Set<string>();
	await register({
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		registerFlag() {},
		registerTool: (tool: { name: string }) => {
			tools.add(tool.name);
		},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		registerCommand() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	assert.equal(tools.has("agent_await"), false);
	assert.ok(tools.has("agent_spawn"));
});

it("declares quiet gate windows and attributes member conditions without permission", () => {
	const status = AGENT_CONTROL_GUIDANCE.agent_status.guidelines?.join("\n") ?? "";
	assert.match(status, /A full suite needs no claim and no prior status read/u);
	assert.match(status, /hold your own full suite until that claim clears/u);
	assert.match(status, /scope.fullGate true; clear the claim on release/u);
	assert.match(status, /Notify only efforts that requested release/u);
	const threads = AGENT_CONTROL_GUIDANCE.agent_collaborate.guidelines?.join("\n") ?? "";
	assert.match(threads, /Rejoin to replace your contribution/u);
	assert.match(threads, /declarations, not consensus or permission/u);
});
