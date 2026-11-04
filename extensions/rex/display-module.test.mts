import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createEventBus, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Schema } from "@earendil-works/pi-schema";
import { toolDisplay } from "./display.ts";
import { registerRex } from "./index.ts";
import { toolSpecs } from "./schema.ts";

type Publication = { version: number; tools: Array<Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">> };
type Contribution = { name: string; source: string; display?: { version: number; entry: string; export: string } };

test("display.ts is a pure presentation module: one export, no operational imports", async () => {
	const namespace = await import("./display.ts");
	assert.deepEqual(Object.keys(namespace).sort(), ["toolDisplay"]);
	const source = await readFile(new URL("./display.ts", import.meta.url), "utf8");
	assert.equal(/from "\.\/(index|durable)\.ts"/.test(source), false, "display.ts must not import the factory");
	assert.equal(/registerTool|registerCommand|events\.|emit\(/.test(source), false, "display.ts must not register or emit");
});

test("toolDisplay() returns version 1 with a renderer record for every Rex tool", () => {
	const publication = toolDisplay();
	assert.equal(publication.version, 1);
	assert.deepEqual(publication.tools.map((tool) => tool.name), toolSpecs.map((spec) => spec.name));
	for (const record of publication.tools) {
		assert.equal(typeof record.renderCall, "function");
		assert.equal(typeof record.renderResult, "function");
		assert.equal(record.renderShell, "default");
	}
	assert.notEqual(toolDisplay().tools, publication.tools, "each call returns a fresh record array");
});

test("the factory publishes the display module's records and the contribution carries the descriptor", () => {
	const bus = createEventBus();
	const publications: Publication[] = [];
	const contributions: Contribution[] = [];
	const tools = new Map<string, ToolDefinition<Schema>>();
	bus.on("harness:tool-display:publish", (publication) => publications.push(publication as Publication));
	bus.on("durable:contribution", (contribution) => contributions.push(contribution as Contribution));
	const pi = {
		events: bus,
		on: () => () => {},
		registerTool: (tool: ToolDefinition<Schema>) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI;
	registerRex(pi, { createCore: () => { throw new Error("Rendering fixtures must not execute tools."); } });
	const records = toolDisplay().tools;
	for (const publication of publications) {
		assert.equal(publication.version, 1);
		assert.deepEqual(publication.tools.map((tool) => tool.name), records.map((tool) => tool.name));
		for (const display of publication.tools) {
			const record = records.find((tool) => tool.name === display.name);
			const definition = tools.get(display.name);
			assert.ok(record && definition);
			// One record set: the publication, the pure module, and the registration share renderer references.
			assert.equal(display.renderCall, record.renderCall);
			assert.equal(display.renderResult, record.renderResult);
			assert.equal(display.renderShell, record.renderShell);
			assert.equal(definition.renderCall, record.renderCall);
			assert.equal(definition.renderResult, record.renderResult);
		}
	}
	bus.emit("harness:tool-display:request", { version: 1 });
	assert.equal(publications.length, 2);
	const contribution = contributions.at(-1);
	assert.equal(contribution?.name, "rex");
	assert.deepEqual(contribution?.display, { version: 1, entry: "./display.ts", export: "toolDisplay" });
});
