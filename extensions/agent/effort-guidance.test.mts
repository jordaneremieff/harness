import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { AGENT_CONTROL_GUIDANCE } from "./control-guidance.ts";

it("gives ordinary coordination tools completion and low-message guidance", async () => {
	const descriptions = new Map<string, string>();
	await register({
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		registerTool: (tool: { name: string; description: string }) => descriptions.set(tool.name, tool.description),
		registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, registerCommand() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	assert.match(descriptions.get("agent_intent") ?? "", /update or clear intent when integration completes/u);
	assert.match(descriptions.get("agent_send") ?? "", /one concise proposal containing its conditions and one answer/u);
	assert.match(descriptions.get("agent_send") ?? "", /not repeated acknowledgments/u);
	assert.match(descriptions.get("agent_send") ?? "", /agreements that others must see in a thread when a participant storage exists/u);
});

it("keeps native await off ordinary primaries and treats waiting as a capability, not staffing", async () => {
	const tools = new Set<string>();
	await register({
		events: { emit() {}, on: () => () => {} }, on: () => () => {},
		registerTool: (tool: { name: string }) => { tools.add(tool.name); },
		registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, registerCommand() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	assert.equal(tools.has("agent_await"), false);
	assert.ok(tools.has("agent_spawn"));
	const awaiting = AGENT_CONTROL_GUIDANCE.agent_await.guidelines?.join("\n") ?? "";
	assert.match(awaiting, /Waiting is a capability, not a staffing rule/u);
	assert.match(awaiting, /free to do substantive work yourself/u);
	assert.match(awaiting, /Ordinary primaries have no native await; they stay responsive and receive each result through normal delivery/u);
});

it("declares quiet gate windows and attributes member conditions without permission", () => {
	const status = AGENT_CONTROL_GUIDANCE.agent_status.guidelines?.join("\n") ?? "";
	assert.match(status, /Before a full suite, read untargeted agent_status/u);
	assert.match(status, /scope.fullGate true; clear the claim on release/u);
	assert.match(status, /Notify only efforts that requested release/u);
	const threads = AGENT_CONTROL_GUIDANCE.agent_collaborate.guidelines?.join("\n") ?? "";
	assert.match(threads, /Rejoin to replace your contribution/u);
	assert.match(threads, /declarations, not consensus or permission/u);
});
