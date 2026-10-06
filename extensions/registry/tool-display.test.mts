import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";

type Display = Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">;
type Publication = { version: 1; tools: Display[] };

it("publishes only its registered display fields at load and on current requests", () => {
	const registered = new Map<string, ToolDefinition>();
	const listeners = new Map<string, (data: unknown) => void>();
	const publications: Publication[] = [];
	const cleanups: Array<() => void> = [];
	const order: string[] = [];
	const pi = {
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				order.push(channel);
				listeners.set(channel, handler);
				const unsubscribe = () => { listeners.delete(channel); };
				cleanups.push(unsubscribe);
				return unsubscribe;
			},
			emit(channel: string, data: unknown) {
				if (channel === "harness:tool-display:publish") {
					order.push(channel);
					publications.push(data as Publication);
				}
				listeners.get(channel)?.(data);
			},
		},
		registerTool(definition: ToolDefinition) { registered.set(definition.name, definition); },
		on() {},
		registerCommand() {},
		registerShortcut() {},
		registerEntryRenderer() {},
		registerFlag() {},
		getFlag() {},
	} as unknown as ExtensionAPI;
	register(pi);
	assert.deepEqual(order, ["harness:tool-display:request", "harness:tool-display:publish"]);
	assert.equal(publications.length, 1);
	const verify = (publication: Publication) => {
		assert.deepEqual(Object.keys(publication).sort(), ["tools", "version"]);
		assert.equal(publication.version, 1);
		assert.deepEqual(publication.tools.map((tool) => tool.name), ["registry"]);
		assert.equal(publication.tools.length, [...registered.values()].filter((tool) => tool.renderCall !== undefined || tool.renderResult !== undefined || tool.renderShell !== undefined).length);
		for (const display of publication.tools) {
			const definition = registered.get(display.name);
			assert.ok(definition);
			assert.equal(typeof display.renderCall, "function");
			assert.equal(typeof display.renderResult, "function");
			assert.equal(display.renderCall, definition.renderCall);
			assert.equal(display.renderResult, definition.renderResult);
			assert.equal(display.renderShell, definition.renderShell);
			assert.deepEqual(Object.keys(display).sort(), ["name", ...["renderCall", "renderResult", "renderShell"].filter((key) => definition[key as keyof Display] !== undefined)].sort());
		}
	};
	verify(publications[0]);
	assert.ok(listeners.has("harness:tool-display:request"));
	const request = (data: unknown) => pi.events.emit("harness:tool-display:request", data);
	for (const invalid of [undefined, null, {}, { version: 2 }, { version: "1" }]) request(invalid);
	assert.equal(publications.length, 1);
	request({ version: 1 });
	request({ version: 1 });
	assert.equal(publications.length, 3);
	for (const publication of publications) verify(publication);
	assert.notEqual(publications[0].tools, publications[1].tools);
	for (const cleanup of cleanups) cleanup();
	request({ version: 1 });
	assert.equal(publications.length, 3);
	assert.equal(listeners.size, 0);
});
