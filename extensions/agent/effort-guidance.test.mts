import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { AGENT_CONTROL_GUIDANCE } from "./control-guidance.ts";

it("gives ordinary coordination tools completion and low-message guidance", () => {
	const descriptions = new Map<string, string>();
	register({
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

it("routes ordinary fan-out through one native lead without a primary wait", async () => {
	let execute: (() => Promise<unknown>) | undefined;
	register({
		events: { emit() {}, on: () => () => {} }, on: () => () => {},
		registerTool: (tool: { name: string; execute: () => Promise<unknown> }) => {
			if (tool.name === "agent_await") execute = tool.execute;
		},
		registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, registerCommand() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	assert.ok(execute);
	await assert.rejects(execute(), /one Durable lead.*awaits their exact results natively.*one composed answer/u);
	assert.match(AGENT_CONTROL_GUIDANCE.agent_await.guidelines?.join("\n") ?? "", /one Durable lead/u);
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
