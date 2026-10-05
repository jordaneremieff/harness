import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";

it("gives ordinary coordination tools completion and low-message guidance", () => {
	const descriptions = new Map<string, string>();
	register({
		events: { emit() {} },
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
