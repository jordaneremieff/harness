import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createEventBus, initTheme, ToolExecutionComponent, type ExtensionAPI, type ToolDefinition, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { collectToolDisplay, publishToolDisplay } from "./tool-display.ts";
import { createDashboardToolDefinitions } from "./dashboard-tool-definitions.ts";
import registerAgentExtension from "./index.ts";

initTheme("dark");
const renderCall: NonNullable<ToolDefinition["renderCall"]> = () => new Text("Published call", 0, 0);
const renderResult: NonNullable<ToolDefinition["renderResult"]> = () => new Text("Published result", 0, 0);

class FakeBus {
	readonly handlers = new Map<string, Set<(data: unknown) => void>>();
	readonly emitted: Array<{ channel: string; data: unknown }> = [];
	scope() {
		const releases: Array<() => void> = [];
		const events: ExtensionAPI["events"] = {
			emit: (channel, data) => {
				this.emitted.push({ channel, data });
				for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
			},
			on: (channel, handler) => {
				let handlers = this.handlers.get(channel);
				if (!handlers) {
					handlers = new Set();
					this.handlers.set(channel, handlers);
				}
				handlers.add(handler);
				const release = () => { handlers.delete(handler); };
				releases.push(release);
				return release;
			},
		};
		return { events, invalidate: () => { for (const release of releases) release(); } };
	}
}

function fakePublisher(events: ExtensionAPI["events"], name = "fixture_tool", presentation: ToolRenderers = { renderCall, renderResult }) {
	const publish = () => events.emit("harness:tool-display:publish", { version: 1, tools: [{ name, ...presentation }] });
	events.on("harness:tool-display:request", (data) => {
		if ((data as { version?: unknown } | null)?.version === 1) publish();
	});
	publish();
}

it("the public Pi event bus completes synchronous publication responses before request returns", () => {
	const events = createEventBus();
	fakePublisher(events);
	const lookup = collectToolDisplay(events);
	assert.equal(lookup("fixture_tool")?.renderCall, renderCall);
	events.clear();
});

it("collects fake publishers in either factory load order and uses their native card", async () => {
	for (const publisherFirst of [false, true]) {
		const bus = new FakeBus();
		const publisher = bus.scope();
		if (publisherFirst) fakePublisher(publisher.events);
		const lookup = collectToolDisplay(bus.scope().events);
		if (!publisherFirst) fakePublisher(publisher.events);
		assert.equal(lookup("fixture_tool")?.renderCall, renderCall);
		assert.equal(lookup("fixture_tool")?.renderResult, renderResult);
		const definition = createDashboardToolDefinitions("/work", lookup)("fixture_tool");
		await assert.rejects(definition.execute("display", {}, undefined, undefined, {} as never), /Transcript tools cannot execute/u);
		const tool = new ToolExecutionComponent("fixture_tool", "call", {}, { showImages: false }, definition, { requestRender() {} } as TUI, "/work");
		tool.updateResult({ content: [{ type: "text", text: "Unformatted result" }], isError: false });
		const visible = stripVTControlCharacters(tool.render(80).join("\n"));
		assert.match(visible, /Published call/u);
		assert.match(visible, /Published result/u);
		assert.doesNotMatch(visible, /Unformatted result/u);
	}
});

it("replaces same-name publication and reconstructs registry after tracked-handler reload", () => {
	const bus = new FakeBus();
	let publisher = bus.scope();
	let consumer = bus.scope();
	fakePublisher(publisher.events);
	const oldLookup = collectToolDisplay(consumer.events);
	const retainedDefinition = createDashboardToolDefinitions("/work", oldLookup)("fixture_tool");
	assert.equal(retainedDefinition.renderCall, renderCall);
	const replacement: NonNullable<ToolDefinition["renderCall"]> = () => new Text("Replacement", 0, 0);
	publisher.invalidate();
	publisher = bus.scope();
	fakePublisher(publisher.events, "fixture_tool", { renderCall: replacement });
	assert.equal(oldLookup("fixture_tool")?.renderCall, replacement);
	assert.equal(oldLookup("fixture_tool")?.renderResult, undefined);
	consumer.invalidate();
	consumer = bus.scope();
	const reloaded = collectToolDisplay(consumer.events);
	assert.equal(reloaded("fixture_tool")?.renderCall, replacement);
	assert.equal(createDashboardToolDefinitions("/work", reloaded)("fixture_tool").renderCall, replacement);
	assert.equal(retainedDefinition.renderCall, renderCall);
	assert.equal(bus.handlers.get("harness:tool-display:publish")?.size, 1);
	assert.equal(bus.handlers.get("harness:tool-display:request")?.size, 1);
	consumer.invalidate();
	publisher.invalidate();
	const empty = collectToolDisplay(bus.scope().events);
	assert.equal(empty("fixture_tool"), undefined);
	assert.equal(createDashboardToolDefinitions("/work", empty)("fixture_tool").renderCall, undefined);
	fakePublisher(bus.scope().events, "fresh_tool");
	assert.equal(empty("fresh_tool")?.renderCall, renderCall);
	assert.equal(oldLookup("fresh_tool"), undefined);
	assert.equal(reloaded("fresh_tool"), undefined);
});

it("copies only checked renderer fields, rejects malformed publications and never reads execute", () => {
	const bus = new FakeBus();
	const { events } = bus.scope();
	const lookup = collectToolDisplay(events);
	for (const payload of [null, [], {}, { version: 2, tools: [{ name: "wrong", renderCall }] }, { version: 1, tools: {} }]) events.emit("harness:tool-display:publish", payload);
	const published = { name: "fixture_tool", renderCall, renderResult, renderShell: "self", prepareLoadout() { throw new Error("unused"); }, get execute() { throw new Error("must not read"); } };
	events.emit("harness:tool-display:publish", { version: 1, tools: [published, null, {}, { name: "" }, { name: "empty" }, { name: "bad-call", renderCall: true }, { name: "bad-result", renderResult: true }, { name: "bad-shell", renderCall, renderShell: "bad" }] });
	assert.deepEqual(lookup("fixture_tool"), { renderCall, renderResult, renderShell: "self" });
	assert.ok(Object.isFrozen(lookup("fixture_tool")));
	published.renderCall = () => new Text("mutated", 0, 0);
	assert.equal(lookup("fixture_tool")?.renderCall, renderCall);
	for (const name of ["wrong", "empty", "bad-call", "bad-result", "bad-shell", "toString"]) assert.equal(lookup(name), undefined);
});

it("native builtin, codemode and agent cards take precedence over published names", () => {
	const bus = new FakeBus();
	const { events } = bus.scope();
	const lookup = collectToolDisplay(events);
	for (const name of ["read", "codemode", "agent_send"]) fakePublisher(events, name);
	const define = createDashboardToolDefinitions("/work", lookup);
	for (const name of ["read", "codemode", "agent_send"]) {
		if (name !== "agent_send") assert.equal(define(name).renderCall, createDashboardToolDefinitions("/work")(name).renderCall);
		assert.equal(typeof define(name).renderCall, "function");
		assert.notEqual(define(name).renderCall, renderCall);
	}
	assert.equal(define("read", false).renderCall, undefined);
	assert.equal(define("unpublished").renderCall, undefined);
	assert.equal(define("unpublished").renderResult, undefined);
	assert.equal(define("unpublished").renderShell, undefined);
});

it("agent publication emits only card fields and responds only to current requests", () => {
	const bus = new FakeBus();
	const { events } = bus.scope();
	publishToolDisplay(events, [{ name: "fixture_tool", renderCall, renderResult, renderShell: "default" }]);
	const first = bus.emitted[0];
	assert.equal(first.channel, "harness:tool-display:publish");
	assert.deepEqual(first.data, { version: 1, tools: [{ name: "fixture_tool", renderCall, renderResult, renderShell: "default" }] });
	for (const request of [null, {}, { version: 2 }]) events.emit("harness:tool-display:request", request);
	assert.equal(bus.emitted.filter((event) => event.channel === first.channel).length, 1);
	events.emit("harness:tool-display:request", { version: 1 });
	assert.equal(bus.emitted.filter((event) => event.channel === first.channel).length, 2);
});

it("agent factory collects before requests and publishes actual registered card references", () => {
	const bus = new FakeBus();
	const { events } = bus.scope();
	const definitions: ToolDefinition[] = [];
	registerAgentExtension({
		events,
		on() {}, registerToolRenderer() {}, registerShortcut() {}, registerMessageRenderer() {}, registerCommand() {},
		registerTool: (definition: ToolDefinition) => definitions.push(definition),
	} as unknown as ExtensionAPI);
	assert.equal(bus.emitted[0].channel, "harness:tool-display:request");
	assert.equal(bus.handlers.get("harness:tool-display:publish")?.size, 1);
	const publication = bus.emitted.find((event) => event.channel === "harness:tool-display:publish")?.data as { tools: Array<{ name: string } & ToolRenderers> };
	assert.ok(publication);
	for (const definition of definitions.filter((tool) => tool.renderCall || tool.renderResult)) {
		const display = publication.tools.find((tool) => tool.name === definition.name);
		assert.ok(display, definition.name);
		assert.equal(display.renderCall, definition.renderCall);
		assert.equal(display.renderResult, definition.renderResult);
		assert.equal("execute" in display, false);
		assert.equal("prepareLoadout" in display, false);
	}
});
