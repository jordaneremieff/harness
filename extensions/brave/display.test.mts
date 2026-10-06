import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerBraveSearch from "./index.ts";

type Display = Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">;
interface Publication {
	version: 1;
	tools: Display[];
}

function publisher(bus: EventEmitter) {
	const registered = new Map<string, ToolDefinition>();
	const subscriptions: (() => void)[] = [];
	registerBraveSearch({
		registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
		registerCommand: () => {},
		on: () => {},
		events: {
			emit: (event: string, data: unknown) => {
				bus.emit(event, data);
			},
			on: (event: string, handler: (data: unknown) => void) => {
				bus.on(event, handler);
				const unsubscribe = () => {
					bus.off(event, handler);
				};
				subscriptions.push(unsubscribe);
				return unsubscribe;
			},
		},
	} as unknown as ExtensionAPI);
	return {
		registered,
		unload: () => {
			for (const unsubscribe of subscriptions) unsubscribe();
		},
	};
}

function assertPublication(publication: Publication, registered: Map<string, ToolDefinition>) {
	assert.equal(publication.version, 1);
	assert.deepEqual(Object.keys(publication).sort(), ["tools", "version"]);
	assert.deepEqual(
		publication.tools.map((tool) => tool.name),
		["web_read", "web_search"],
	);
	assert.deepEqual(
		[...registered.keys()],
		publication.tools.map((tool) => tool.name),
	);
	for (const display of publication.tools) {
		const tool = registered.get(display.name);
		assert.ok(tool);
		assert.deepEqual(Object.keys(display).sort(), ["name", "renderCall", "renderResult", "renderShell"]);
		assert.equal(typeof display.renderCall, "function");
		assert.equal(typeof display.renderResult, "function");
		assert.equal(display.renderCall, tool.renderCall);
		assert.equal(display.renderResult, tool.renderResult);
		assert.equal(display.renderShell, tool.renderShell);
	}
}

test("publishes registered renderers at factory time and for current display requests", () => {
	const bus = new EventEmitter();
	const publications: Publication[] = [];
	bus.on("harness:tool-display:publish", (publication: Publication) => {
		assert.equal(bus.listenerCount("harness:tool-display:request"), 1);
		publications.push(publication);
	});
	const first = publisher(bus);
	assert.equal(publications.length, 1);
	assertPublication(publications[0], first.registered);
	for (const request of [undefined, null, 1, "1", {}, { version: 2 }, { version: "1" }]) {
		bus.emit("harness:tool-display:request", request);
	}
	assert.equal(publications.length, 1);
	bus.emit("harness:tool-display:request", { version: 1 });
	assert.equal(publications.length, 2);
	assertPublication(publications[1], first.registered);
	first.unload();
	assert.equal(bus.listenerCount("harness:tool-display:request"), 0);
	bus.emit("harness:tool-display:request", { version: 1 });
	assert.equal(publications.length, 2);
	const second = publisher(bus);
	assert.equal(publications.length, 3);
	assertPublication(publications[2], second.registered);
	bus.emit("harness:tool-display:request", { version: 1 });
	assert.equal(publications.length, 4);
	assertPublication(publications[3], second.registered);
	second.unload();
});
