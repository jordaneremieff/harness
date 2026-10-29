import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolResultEvent, type ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import registerRegistry from "./index.ts";
import { SETTINGS_PUBLISH, SETTINGS_REQUEST } from "./configuration-protocol.ts";

type Handler = (event: ToolResultEvent, ctx: ExtensionContext) => Promise<ToolResultEventResult | undefined>;
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "registry-notes-ordinary-"));
	const file = join(root, "harness.json");
	writeFileSync(file, '{"version":1,"registry":{"notes":true}}');
	const previous = process.env.PI_HARNESS_FILE;
	process.env.PI_HARNESS_FILE = file;
	const bus = createEventBus();
	bus.on(SETTINGS_REQUEST, () => bus.emit(SETTINGS_PUBLISH, { version: 1, slice: "example",
		source: { path: file, status: "loaded", digest: null, observedAt: new Date().toISOString() }, diagnostics: [],
		records: [{ name: "example.limit", key: "limit", type: "integer", env: "PI_EXAMPLE_LIMIT", description: "Limit", secret: false, origin: "env", status: "valid", value: 7 }] }));
	// Pi runs every handler registered for an event, in registration order.
	const handlers = new Map<string, Handler[]>();
	const pi = { events: bus, on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]), registerTool: () => {},
		getAllTools: () => [{ name: "example", sourceInfo: { path: join(root, "extensions/example/index.ts"), source: "local", scope: "temporary", origin: "top-level" } }], getActiveTools: () => [], getCommands: () => [] } as unknown as ExtensionAPI;
	registerRegistry(pi);
	const ctx = { cwd: join(root, "workspace") } as ExtensionContext;
	const invoke = async (event: string, input: ToolResultEvent = {} as ToolResultEvent) => {
		let result: Awaited<ReturnType<Handler>> | undefined;
		for (const handler of handlers.get(event) ?? []) result = (await handler(input, ctx)) ?? result;
		return result;
	};
	return { root, file, invoke, close: async () => {
		await invoke("session_shutdown");
		if (previous === undefined) delete process.env.PI_HARNESS_FILE; else process.env.PI_HARNESS_FILE = previous;
		rmSync(root, { recursive: true, force: true });
	} };
}
function event(path: string, id: string, parent?: string): ToolResultEvent {
	return { type: "tool_result", toolName: "read", toolCallId: id, ...(parent ? { parentToolCallId: parent } : {}), input: { path },
		content: [{ type: "text", text: "original" }], structuredContent: { original: true }, details: { marker: "details" }, isError: true } as ToolResultEvent;
}
test("ordinary note appends one part and preserves the original result carriers", async () => {
	const sample = fixture();
	try {
		const input = event(sample.file, "first");
		const result = await sample.invoke("tool_result", input);
		assert.ok(result?.content);
		assert.equal(result.content.length, 2);
		assert.ok(result.content[0] === input.content[0]);
		assert.match(result.content[1].type === "text" ? result.content[1].text : "", /^\[registry\]/);
		assert.ok(result.structuredContent === input.structuredContent);
		assert.equal(Object.hasOwn(result, "details"), false);
		assert.equal(Object.hasOwn(result, "isError"), false);
		assert.equal(Object.hasOwn(result, "usage"), false);
		assert.equal(input.isError, true);
		assert.equal(await sample.invoke("tool_result", event(sample.file, "second")), undefined);
		await sample.invoke("session_start");
		assert.equal((await sample.invoke("tool_result", event(sample.file, "third")))?.content?.length, 2);
	} finally { await sample.close(); }
});
test("ordinary nested notes roll directly to the outermost result and clear at reset", async () => {
	const sample = fixture();
	try {
		const nested = event(sample.file, "outer/1/1", "outer/1");
		assert.equal(await sample.invoke("tool_result", nested), undefined);
		assert.equal(nested.content.length, 1);
		const middle = { ...event("/unrelated", "outer/1", "outer"), toolName: "wrapper" } as ToolResultEvent;
		assert.equal(await sample.invoke("tool_result", middle), undefined);
		const outer = { ...event("/unrelated", "outer"), toolName: "wrapper" } as ToolResultEvent;
		assert.equal((await sample.invoke("tool_result", outer))?.content?.length, 2);
		await sample.invoke("session_start");
		await sample.invoke("tool_result", event(sample.file, "next/1", "next"));
		await sample.invoke("session_start");
		assert.equal(await sample.invoke("tool_result", { ...outer, toolCallId: "next" }), undefined);
	} finally { await sample.close(); }
});
test("ordinary source and Pi settings notes retain loaded provenance and known tool calls", async () => {
	const sample = fixture();
	try {
		const source = await sample.invoke("tool_result", event(join(sample.root, "extensions/example/runtime.ts"), "source"));
		const text = source?.content?.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "";
		assert.match(text, /example is loaded in this session from/);
		assert.match(text, /example.limit = 7 \(origin env, env PI_EXAMPLE_LIMIT\)/);
		assert.match(text, /"kind":"tool","name":"example","detail":true/);
		const settings = await sample.invoke("tool_result", event(join(getAgentDir(), "settings.json"), "pi-settings"));
		const note = settings?.content?.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "";
		assert.match(note, /This session loaded 1 extensions; Pi settings list configured sources, not load results/);
		assert.match(note, /example.limit = 7/);
	} finally { await sample.close(); }
});
test("ordinary notes read the off switch fresh and leave registry calls alone", async () => {
	const sample = fixture();
	const previous = process.env.PI_REGISTRY_NOTES;
	try {
		writeFileSync(sample.file, '{"version":1,"registry":{"notes":false}}');
		assert.equal(await sample.invoke("tool_result", event(sample.file, "off")), undefined);
		writeFileSync(sample.file, '{"version":1,"registry":{"notes":true}}');
		assert.equal((await sample.invoke("tool_result", event(sample.file, "on")))?.content?.length, 2);
		await sample.invoke("session_start");
		process.env.PI_REGISTRY_NOTES = "0";
		assert.equal(await sample.invoke("tool_result", event(sample.file, "env-off")), undefined);
		delete process.env.PI_REGISTRY_NOTES;
		assert.equal(await sample.invoke("tool_result", { ...event(sample.file, "lookup"), toolName: "registry" }), undefined);
		assert.equal((await sample.invoke("tool_result", event(sample.file, "after-lookup")))?.content?.length, 2);
	} finally {
		if (previous === undefined) delete process.env.PI_REGISTRY_NOTES; else process.env.PI_REGISTRY_NOTES = previous;
		await sample.close();
	}
});
