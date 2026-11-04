import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJobsContribution } from "./durable.ts";
import { toolDisplay } from "./display.ts";
import registerJobs from "./index.ts";

test("display.ts is presentation-only and the contribution names it", () => {
	const source = readFileSync(fileURLToPath(new URL("./display.ts", import.meta.url)), "utf8");
	assert.doesNotMatch(source, /index\.ts|durable\.ts|registerTool|events\.emit|createJobsContribution/u);
	const publication = toolDisplay();
	assert.equal(publication.version, 1);
	assert.deepEqual(publication.tools.map((tool) => tool.name), ["jobs", "bash"]);
	for (const tool of publication.tools) {
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
		assert.equal("execute" in tool, false);
	}
	assert.equal(toolDisplay().tools[0]?.renderResult, publication.tools[0]?.renderResult);
	const contribution = createJobsContribution({ source: fileURLToPath(new URL("./index.ts", import.meta.url)) });
	assert.deepEqual(contribution.display, { version: 1, entry: "./display.ts", export: "toolDisplay" });
});

test("ordinary publication answers a version 1 request and stops after unsubscribe", () => {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	let unsubscribe: (() => void) | undefined;
	const pi = {
		events: {
			emit(channel: string, data: unknown) {
				emitted.push({ channel, data });
				for (const handler of listeners.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				const handlers = listeners.get(channel) ?? new Set<(data: unknown) => void>();
				handlers.add(handler);
				listeners.set(channel, handlers);
				unsubscribe = () => handlers.delete(handler);
				return unsubscribe;
			},
		},
		registerTool() {},
		on() {},
		sendMessage() {},
	};
	registerJobs(pi as unknown as ExtensionAPI);
	const first = emitted.filter((event) => event.channel === "harness:tool-display:publish");
	assert.equal(first.length, 1);
	const published = first[0]?.data as ReturnType<typeof toolDisplay>;
	assert.equal(published.version, 1);
	assert.deepEqual(published.tools.map((tool) => tool.name), ["jobs", "bash"]);
	assert.equal(published.tools[0]?.renderCall, toolDisplay().tools[0]?.renderCall);
	assert.equal(published.tools[1]?.renderResult, toolDisplay().tools[1]?.renderResult);
	assert.deepEqual(Object.keys(published.tools[0] ?? {}).sort(), ["name", "renderCall", "renderResult"]);
	pi.events.emit("harness:tool-display:request", { version: 1 });
	pi.events.emit("harness:tool-display:request", { version: 2 });
	pi.events.emit("harness:tool-display:request", null);
	assert.equal(emitted.filter((event) => event.channel === "harness:tool-display:publish").length, 2);
	unsubscribe?.();
	pi.events.emit("harness:tool-display:request", { version: 1 });
	assert.equal(emitted.filter((event) => event.channel === "harness:tool-display:publish").length, 2);
});
