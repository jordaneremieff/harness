import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { validateIntentInput } from "./effort-schema.ts";

it("registers every ordinary agent tool with a plain object parameter schema", () => {
	const tools: Array<{ name: string; parameters: Record<string, unknown> }> = [];
	register({ events: { emit() {}, on: () => () => {} }, on: () => () => {}, registerTool: (tool: typeof tools[number]) => tools.push(tool), registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, registerCommand() {} } as unknown as ExtensionAPI);
	assert.ok(tools.length > 0);
	for (const tool of tools) {
		assert.equal(tool.parameters.type, "object", tool.name);
		assert.ok(tool.parameters.properties, tool.name);
		assert.equal(tool.parameters.anyOf, undefined, tool.name);
		assert.equal(tool.parameters.oneOf, undefined, tool.name);
	}
});

it("validates publish and clear at execution without a union declaration", () => {
	const publish = { action: "publish", purpose: "Review parser", integration: "Send findings", authority: "Operator requests review", scope: { paths: ["parser"], branches: ["main"] } };
	assert.doesNotThrow(() => validateIntentInput(publish));
	assert.doesNotThrow(() => validateIntentInput({ action: "clear" }));
	assert.throws(() => validateIntentInput({ action: "publish" }), /Publish intent requires/u);
	assert.throws(() => validateIntentInput({ ...publish, action: "clear" }), /Clear intent takes only action/u);
	assert.throws(() => validateIntentInput({ action: "clear", purpose: "extra" }), /Clear intent takes only action/u);
	assert.throws(() => validateIntentInput({ ...publish, scope: {} }), /valid publish fields/u);
	assert.throws(() => validateIntentInput({ action: "other" }), /action publish or clear/u);
});
