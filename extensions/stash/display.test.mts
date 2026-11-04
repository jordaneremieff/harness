import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { toolDisplay } from "./display.ts";
import { toolDisplayPublisher } from "./tool-display.ts";

const NAMES = ["stash_write", "stash_list", "stash_read", "stash_edit", "stash_complete", "stash_rotate"];

it("display.ts is a pure presentation module: one export, no operational imports", async () => {
	const namespace = await import("./display.ts");
	assert.deepEqual(Object.keys(namespace).sort(), ["toolDisplay"]);
	const source = await readFile(new URL("./display.ts", import.meta.url), "utf8");
	assert.equal(/from "\.\/(index|durable)\.ts"/.test(source), false, "display.ts must not import the factory");
	assert.equal(/registerTool|registerCommand|events\./.test(source), false, "display.ts must not register or emit");
});

it("toolDisplay() returns version 1 with function renderers for every stash tool", () => {
	const publication = toolDisplay();
	assert.equal(publication.version, 1);
	assert.deepEqual(publication.tools.map((tool) => tool.name), NAMES);
	for (const record of publication.tools) {
		assert.equal(typeof record.renderCall, "function");
		assert.equal(typeof record.renderResult, "function");
		assert.deepEqual(Object.keys(record).sort(), ["name", "renderCall", "renderResult"]);
	}
});

it("the ordinary publication carries the same renderer records", () => {
	const published: Array<ReturnType<typeof toolDisplay>> = [];
	const listeners = new Map<string, (data: unknown) => void>();
	const events = {
		on: (channel: string, handler: (data: unknown) => void) => {
			listeners.set(channel, handler);
			return () => listeners.delete(channel);
		},
		emit: (channel: string, data: unknown) => {
			if (channel === "harness:tool-display:publish") published.push(data as ReturnType<typeof toolDisplay>);
		},
	};
	const { publish } = toolDisplayPublisher({ events, registerTool() {} } as never);
	publish();
	const pure = toolDisplay();
	assert.deepEqual(published[0].tools.map((tool) => tool.name), NAMES);
	for (const [index, record] of published[0].tools.entries()) {
		assert.equal(record.renderCall, pure.tools[index].renderCall);
		assert.equal(record.renderResult, pure.tools[index].renderResult);
	}
});

it("the durable contribution carries the display descriptor", async () => {
	const { stashDurableContribution } = await import("./durable.ts");
	const contribution = stashDurableContribution("/x/index.ts", { on: () => () => {}, emit: () => {} } as never, () => {});
	assert.deepEqual(contribution.display, { version: 1, entry: "./display.ts", export: "toolDisplay" });
});
