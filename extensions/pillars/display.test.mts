import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { toolDisplay } from "./display.ts";

it("display.ts is a pure presentation module: one export, no operational imports", async () => {
	const namespace = await import("./display.ts");
	assert.deepEqual(Object.keys(namespace).sort(), ["toolDisplay"]);
	const source = await readFile(new URL("./display.ts", import.meta.url), "utf8");
	assert.equal(/from "\.\/(index|durable)\.ts"/.test(source), false, "display.ts must not import the factory");
	assert.equal(/registerTool|registerCommand|events\./.test(source), false, "display.ts must not register or emit");
});

it("toolDisplay() returns version 1 with the two tool renderer records", () => {
	const publication = toolDisplay();
	assert.equal(publication.version, 1);
	assert.deepEqual(publication.tools.map((tool) => tool.name), ["pillars", "pillars_usage"]);
	for (const record of publication.tools) {
		assert.equal(typeof record.renderCall, "function");
		assert.equal(typeof record.renderResult, "function");
		assert.deepEqual(Object.keys(record).sort(), ["name", "renderCall", "renderResult"]);
	}
	assert.notEqual(toolDisplay().tools, publication.tools, "each call returns a fresh record array");
});
