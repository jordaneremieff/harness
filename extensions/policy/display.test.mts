import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { toolDisplay } from "./display.ts";
import register from "./index.ts";

function load() {
	const registered = new Map<string, ToolDefinition>();
	const emitted: Array<{ channel: string; value: unknown }> = [];
	const pi = {
		events: {
			on: () => () => {},
			emit(channel: string, value: unknown) {
				emitted.push({ channel, value });
			},
		},
		registerTool(definition: ToolDefinition) {
			registered.set(definition.name, definition);
		},
		on() {},
		registerCommand() {},
		registerShortcut() {},
		registerEntryRenderer() {},
		registerFlag() {},
		getFlag() {},
	} as unknown as ExtensionAPI;
	register(pi);
	return { registered, emitted };
}

describe("policy display module", () => {
	it("is advertised by the contribution as a bare relative entry beside its source", () => {
		const { emitted } = load();
		const contribution = emitted.find((entry) => entry.channel === "durable:contribution")?.value as {
			source: string;
			display?: { version: number; entry: string; export: string };
		};
		assert.deepEqual(contribution.display, { version: 1, entry: "./display.ts", export: "toolDisplay" });
		assert.equal(contribution.display?.entry.includes(".."), false);
		assert.ok(contribution.source.endsWith("index.ts"));
	});

	it("returns version 1 with function renderers that are the registered tool renderers", () => {
		const { registered } = load();
		const publication = toolDisplay();
		assert.equal(publication.version, 1);
		assert.deepEqual(publication.tools.map((tool) => tool.name), ["policy_propose", "policy_rules"]);
		for (const display of publication.tools) {
			assert.equal(typeof display.renderCall, "function");
			assert.equal(typeof display.renderResult, "function");
			const definition = registered.get(display.name);
			assert.equal(display.renderCall, definition?.renderCall);
			assert.equal(display.renderResult, definition?.renderResult);
		}
		assert.notEqual(toolDisplay().tools, publication.tools);
	});

	it("imports only presentation code and public Pi types, with no registration or store access", async () => {
		const source = await readFile(fileURLToPath(new URL("./display.ts", import.meta.url)), "utf8");
		const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
		assert.deepEqual(specifiers.sort(), ["./presentation.ts", "@earendil-works/pi-coding-agent"]);
		assert.doesNotMatch(source, /registerTool|events\.|process\.|readFile|getAgentDir/);
		const presentation = await readFile(fileURLToPath(new URL("./presentation.ts", import.meta.url)), "utf8");
		assert.deepEqual(
			[...presentation.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort(),
			["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
		);
	});
});
