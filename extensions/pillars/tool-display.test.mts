import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { toolDisplay } from "./display.ts";
import register from "./index.ts";

type Display = Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">;
type Publication = { version: 1; tools: Display[] };
type Contribution = { name: string; source: string; display?: { version: number; entry: string; export: string } };

it("publishes the display module's records at load and on current requests, and stops at shutdown", async () => {
	const registered = new Map<string, ToolDefinition>();
	const listeners = new Map<string, (data: unknown) => void>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const publications: Publication[] = [];
	const contributions: Contribution[] = [];
	const order: string[] = [];
	const pi = {
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				order.push(channel);
				listeners.set(channel, handler);
				return () => { listeners.delete(channel); };
			},
			emit(channel: string, data: unknown) {
				if (channel === "harness:tool-display:publish") { order.push(channel); publications.push(data as Publication); }
				if (channel === "durable:contribution") contributions.push(data as Contribution);
				listeners.get(channel)?.(data);
			},
		},
		registerTool(definition: ToolDefinition) { registered.set(definition.name, definition); },
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, handler); return () => handlers.delete(name); },
		registerCommand() {},
		registerShortcut() {},
		registerEntryRenderer() {},
		registerFlag() {},
		getFlag() {},
	} as unknown as ExtensionAPI;
	register(pi);
	assert.deepEqual(order.filter((channel) => channel.startsWith("harness:tool-display:")), ["harness:tool-display:request", "harness:tool-display:publish"]);
	assert.equal(publications.length, 1);
	const verify = (publication: Publication) => {
		assert.deepEqual(Object.keys(publication).sort(), ["tools", "version"]);
		assert.equal(publication.version, 1);
		const records = toolDisplay().tools;
		assert.deepEqual(publication.tools.map((tool) => tool.name), records.map((tool) => tool.name));
		for (const display of publication.tools) {
			const definition = registered.get(display.name);
			assert.ok(definition);
			const record = records.find((tool) => tool.name === display.name);
			assert.ok(record);
			// One record set: the publication, the pure module, and the registration share renderer references.
			assert.equal(display.renderCall, record.renderCall);
			assert.equal(display.renderResult, record.renderResult);
			assert.equal(display.renderShell, record.renderShell);
			assert.equal(definition.renderCall, record.renderCall);
			assert.equal(definition.renderResult, record.renderResult);
			assert.deepEqual(Object.keys(display).sort(), ["name", ...["renderCall", "renderResult", "renderShell"].filter((key) => record[key as keyof Display] !== undefined)].sort());
		}
	};
	verify(publications[0]);
	assert.ok(listeners.has("harness:tool-display:request"));
	const request = (data: unknown) => pi.events.emit("harness:tool-display:request", data);
	for (const invalid of [undefined, null, {}, { version: 2 }, { version: "1" }]) request(invalid);
	assert.equal(publications.length, 1);
	request({ version: 1 });
	assert.equal(publications.length, 2);
	for (const publication of publications) verify(publication);
	const contribution = contributions.at(-1);
	assert.equal(contribution?.name, "pillars");
	assert.deepEqual(contribution?.display, { version: 1, entry: "./display.ts", export: "toolDisplay" });
	await handlers.get("session_shutdown")?.({}, {});
	request({ version: 1 });
	assert.equal(publications.length, 2, "the request listener is removed at shutdown");
	assert.equal(listeners.has("harness:tool-display:request"), false);
});
