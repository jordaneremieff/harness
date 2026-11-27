import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { IntentParams, validateIntentInput } from "./effort-schema.ts";

it("registers every ordinary agent tool with a plain object parameter schema", async () => {
	const tools: Array<{ name: string; parameters: Record<string, unknown> }> = [];
	await register({
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		registerFlag() {},
		registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		registerCommand() {},
	} as unknown as ExtensionAPI);
	assert.ok(tools.length > 0);
	for (const tool of tools) {
		assert.equal(tool.parameters.type, "object", tool.name);
		assert.ok(tool.parameters.properties, tool.name);
		assert.equal(tool.parameters.anyOf, undefined, tool.name);
		assert.equal(tool.parameters.oneOf, undefined, tool.name);
	}
});

it("validates read, publish and clear at execution without a union declaration", () => {
	const publish = {
		action: "publish",
		purpose: "Review parser",
		integration: "Send findings",
		authority: "Operator requests review",
		scope: { paths: ["parser"], branches: ["main"] },
	};
	assert.doesNotThrow(() => validateIntentInput(publish));
	assert.doesNotThrow(() => validateIntentInput({ action: "clear" }));
	assert.doesNotThrow(() => validateIntentInput({ action: "read" }));
	assert.throws(() => validateIntentInput({ ...publish, action: "read" }), /Read intent takes only action/u);
	assert.throws(() => validateIntentInput({ action: "publish" }), /Publish intent requires/u);
	assert.throws(() => validateIntentInput({ ...publish, action: "clear" }), /Clear intent takes only action/u);
	assert.throws(() => validateIntentInput({ action: "clear", purpose: "extra" }), /Clear intent takes only action/u);
	assert.throws(() => validateIntentInput({ ...publish, scope: {} }), /missing: scope\.paths, scope\.branches\./u);
	assert.throws(() => validateIntentInput({ action: "other" }), /action read, publish or clear/u);
});

it("names the missing publish fields and the empty scope form", () => {
	assert.throws(() => validateIntentInput({ action: "publish", purpose: "Fix the parser" }), {
		message:
			"Publish intent requires purpose, integration, authority, and scope with paths and branches; missing: integration, authority, scope. Use empty paths and branches arrays when no path or branch is shared.",
	});
	assert.throws(
		() =>
			validateIntentInput({ action: "publish", purpose: "p", integration: "i", authority: "a", scope: { paths: [] } }),
		/missing: scope\.branches\./u,
	);
	validateIntentInput({
		action: "publish",
		purpose: "p",
		integration: "i",
		authority: "a",
		scope: { paths: [], branches: [] },
	});
	const action = (IntentParams as { properties: { action: { description?: string } } }).properties.action;
	assert.match(
		action.description ?? "",
		/publish requires purpose, integration, authority and scope with paths and branches/u,
	);
});
