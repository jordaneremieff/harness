import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";
import { createEventBus, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineSettings, integerSetting, publishSettings, readSettings, settingsPublication, stringSetting, SETTINGS_PUBLISH } from "../../settings/index.ts";
import { settingsReader, type SettingsSnapshot } from "./configuration.ts";
import { lookup } from "./lookup.ts";
import { parseQuery } from "./query.ts";
import { RegistryOutputSchema } from "./output.ts";
import registerRegistry from "./index.ts";

const declaration = defineSettings("example", {
	count: integerSetting({ default: 2, min: 1, description: "A bounded count." }),
	token: stringSetting({ secret: true, description: "An environment-only secret." }),
});
function snapshot(agentDir: string, env: Record<string, string | undefined> = {}, declared = declaration): SettingsSnapshot {
	return { publications: [settingsPublication(readSettings(declared, { agentDir, env }))], available: true,
		collection: { status: "available", slices: [declared.slice], malformed: 0, omitted: 0 } };
}
const hostSnapshot = { tools: [], activeTools: [], commands: [], observation: null,
	availability: { tools: false, activeTools: false, commands: false }, at: 1 };
function verify(result: Awaited<ReturnType<typeof lookup>>) {
	assert.ok(Check(RegistryOutputSchema, result.structuredContent), JSON.stringify(result.structuredContent));
	const envelope = JSON.stringify({ content: [{ type: "text", text: result.text }], details: result.details, structuredContent: result.structuredContent });
	assert.ok(Buffer.byteLength(envelope) <= 50 * 1024);
	assert.ok(envelope.replace(/\\n/g, "\n").split("\n").length <= 2000);
	return result.details.records as Record<string, unknown>[];
}

test("setting queries inspect fresh public snapshots, origins and diagnostics without secret bytes", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "registry-settings-"));
	const bus = createEventBus();
	const env = { PI_EXAMPLE_COUNT: "7", PI_EXAMPLE_TOKEN: "private-fixture-value" };
	const dispose = publishSettings(bus, declaration, { agentDir, env });
	const reader = settingsReader(bus);
	try {
		await writeFile(join(agentDir, "harness.json"), JSON.stringify({ version: 1, example: { count: 5, token: "rejected-private-value", unknown: true } }));
		const inspect = (params: Record<string, unknown>) => lookup({ params, snapshot: hostSnapshot, settings: snapshot(agentDir, env), session: {}, epoch: "fixture" });
		const first = await inspect({ kind: "setting", limit: 1 });
		const rows = verify(first);
		assert.equal(first.outcome, "ok");
		assert.equal(rows[0].name, "example.count");
		assert.equal(rows[0].value, 7);
		assert.equal(rows[0].origin, "env");
		assert.match(first.text, /not proof a running runtime applied/);
		assert.match(first.text, /example.unknown: file unknown/);
		assert.equal(typeof first.details.cursor, "string");
		const continuation = await inspect({ cursor: first.details.cursor });
		assert.equal(continuation.outcome, "ok", "observation time does not invalidate cursors");
		assert.equal(verify(continuation)[0].secretState, "set");
		assert.equal(Object.hasOwn(verify(continuation)[0], "value"), false);
		assert.doesNotMatch(JSON.stringify([first, continuation]), /private-fixture-value|rejected-private-value/);
		const originalCursor = first.details.cursor;
		env.PI_EXAMPLE_TOKEN = "another-private-value";
		await writeFile(join(agentDir, "harness.json"), JSON.stringify({ version: 1, example: { count: 5, token: "different-rejected-secret", unknown: true } }));
		assert.equal((await inspect({ cursor: originalCursor })).outcome, "ok", "secret bytes and document digest do not enter fingerprints");
		env.PI_EXAMPLE_COUNT = "invalid";
		const rejected = await inspect({ name: "example.count", kind: "setting" });
		assert.equal(verify(rejected)[0].status, "invalid");
		assert.equal(verify(rejected)[0].value, 2);
		assert.equal((verify(rejected)[0].diagnostics as unknown[]).length, 1);
		assert.equal((await inspect({ cursor: originalCursor })).outcome, "stale_cursor");
		delete (env as { PI_EXAMPLE_COUNT?: string }).PI_EXAMPLE_COUNT;
		const file = await inspect({ kind: "setting", search: "bounded" });
		assert.equal(verify(file)[0].origin, "file");
		assert.equal(verify(file)[0].value, 5);
		assert.equal(verify(await inspect({ kind: "setting", name: "example", match: "substring" })).length, 2);
		await writeFile(join(agentDir, "harness.json"), "{");
		const malformed = await inspect({ kind: "setting" });
		assert.match(malformed.text, /example.document: file document/);
		assert.equal(verify(malformed)[0].origin, "default");
		assert.equal((await inspect({ kind: "setting", name: "absent" })).outcome, "missing");
	} finally { reader.dispose(); dispose(); bus.clear(); await rm(agentDir, { recursive: true, force: true }); }
});

test("setting source absence and collection failure have explicit coverage", async () => {
	const bus = createEventBus();
	const reader = settingsReader(bus);
	try {
		const result = await lookup({ params: { kind: "setting" }, snapshot: hostSnapshot,
			settings: { publications: [], available: true, collection: { status: "available", slices: [], malformed: 0, omitted: 0 } },
			session: {}, epoch: "fixture" });
		verify(result);
		assert.equal(result.outcome, "unavailable");
		assert.match(result.text, /No loaded publisher responded/);
		assert.deepEqual((result.details.settingsCoverage as { respondingSlices: string[] }).respondingSlices, []);
		const unavailable = await lookup({ params: { kind: "setting" }, snapshot: hostSnapshot, session: {}, epoch: "fixture" });
		verify(unavailable);
		assert.equal(unavailable.outcome, "unavailable");
		const failed = settingsReader({ on: () => { throw new Error("private error"); }, emit: () => {} }).read();
		assert.equal(failed.available, false);
	} finally { reader.dispose(); bus.clear(); }
});

test("setting output bounds drop whole rows or report a blocked page", async () => {
	const bus = createEventBus();
	const agentDir = await mkdtemp(join(tmpdir(), "registry-settings-bounds-"));
	const huge = defineSettings("example", { value: stringSetting({ default: "x".repeat(20000), maxLength: 24000, description: "Large value." }) });
	const dispose = publishSettings(bus, huge, { agentDir, env: {} });
	const reader = settingsReader(bus);
	try {
		const result = await lookup({ params: { kind: "setting" }, snapshot: hostSnapshot, settings: {
			publications: [settingsPublication(readSettings(huge, { agentDir, env: {} }))], available: true,
			collection: { status: "available", slices: [huge.slice], malformed: 0, omitted: 0 },
		}, session: {}, epoch: "fixture" });
		verify(result);
		assert.equal(result.details.pageBlocked, true);
		assert.equal(result.details.returnedRecords, 0);
		assert.equal(result.details.cursor, undefined);
	} finally { reader.dispose(); dispose(); bus.clear(); await rm(agentDir, { recursive: true, force: true }); }
});

test("partial publication coverage prevents absence and invalidates cursors without rejected bytes", async () => {
	const configured = snapshot("/fixtures", { PI_EXAMPLE_COUNT: "3" });
	const run = (params: Record<string, unknown>, settings = configured) => lookup({ params, snapshot: hostSnapshot, settings, session: {}, epoch: "fixture" });
	const first = await run({ kind: "setting", limit: 1 });
	assert.equal(typeof first.details.cursor, "string");
	const partial = { ...configured, collection: { ...configured.collection, malformed: 1, omitted: 2 } };
	const result = await run({ kind: "setting", name: "absent" }, partial);
	verify(result);
	assert.equal(result.outcome, "partial");
	assert.equal(result.details.cursor, undefined);
	assert.match(result.text, /malformed publications: 1 \| omitted publications: 2/);
	assert.equal((await run({ cursor: first.details.cursor }, partial)).outcome, "stale_cursor");
});

test("shared collector rejects secret-bearing malformed publications with sanitized coverage", () => {
	const bus = createEventBus();
	bus.on("harness:settings:request", () => {
		bus.emit(SETTINGS_PUBLISH, { version: 1, slice: "example", records: [{ secret: true, value: "private-rejected-value" }] });
	});
	const reader = settingsReader(bus);
	try {
		const observed = reader.read();
		assert.equal(observed.collection.malformed, 1);
		assert.equal(observed.available, true);
		assert.doesNotMatch(JSON.stringify(observed), /private-rejected-value/);
	} finally { reader.dispose(); bus.clear(); }
});

test("setting pages preserve owning relation diagnostics without altering scalar values", async () => {
	const configured = snapshot("/fixtures");
	configured.publications[0].records[0].status = "invalid";
	configured.publications[0].diagnostics = JSON.parse('[{"field":"example.count","source":"default","code":"relation","message":"Configured settings violate an owning constraint."}]');
	const result = await lookup({ params: { kind: "setting", name: "example.count" }, snapshot: hostSnapshot, settings: configured, session: {}, epoch: "fixture" });
	const rows = verify(result);
	assert.equal(rows[0].value, 2);
	assert.equal(rows[0].status, "invalid");
	assert.equal((rows[0].diagnostics as { code: string }[])[0].code, "relation");
});

test("setting metadata keeps Unicode line separators off terminal rows", async () => {
	const configured = snapshot("/fixtures");
	configured.publications[0].records[0].description = "first\u2028second\u2029third";
	configured.publications[0].source.path = "/fixtures/first\u2028second.json";
	const result = await lookup({ params: { kind: "setting" }, snapshot: hostSnapshot, settings: configured, session: {}, epoch: "fixture" });
	verify(result);
	assert.doesNotMatch(result.text, /[\u2028\u2029]/u);
	assert.equal((result.details.records as { description: string }[])[0].description, "first\u2028second\u2029third");
});

test("setting selectors reject content scans and tool/model-only parameters", () => {
	for (const params of [{ contains: "value" }, { detail: true, name: "example.count" }, { provider: "acme" }, { available: true }, { health: true }]) {
		assert.throws(() => parseQuery({ kind: "setting", ...params }));
	}
});

test("ordinary registry refreshes the public bus only for valid live setting queries and releases its collector", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "registry-ordinary-settings-"));
	const bus = createEventBus();
	let requests = 0;
	bus.on("harness:settings:request", () => { requests++; });
	const env = { PI_EXAMPLE_COUNT: "9" };
	const dispose = publishSettings(bus, declaration, { agentDir, env });
	const handlers = new Map<string, () => Promise<void>>();
	let tool: ToolDefinition | undefined;
	registerRegistry({ events: bus, on: (event: string, callback: () => Promise<void>) => handlers.set(event, callback),
		registerTool: (value: ToolDefinition) => { tool = value; }, getAllTools: () => [], getActiveTools: () => [], getCommands: () => [],
	} as unknown as ExtensionAPI);
	assert.ok(tool);
	const context = { tools: [], cwd: agentDir } as never;
	try {
		const result = await tool.execute("settings", { kind: "setting", name: "example.count" }, undefined, undefined, context);
		assert.equal((result.details as { records: { value: number }[] }).records[0].value, 9);
		assert.equal(requests, 1);
		env.PI_EXAMPLE_COUNT = "10";
		const refreshed = await tool.execute("settings", { kind: "setting" }, undefined, undefined, context);
		assert.equal((refreshed.details as { records: { value: number }[] }).records[0].value, 10);
		await tool.execute("cancel", { kind: "setting" }, AbortSignal.abort(), undefined, context);
		await tool.execute("invalid", { kind: "setting", contains: "value" }, undefined, undefined, context);
		assert.equal(requests, 2);
		await handlers.get("session_shutdown")?.();
		bus.emit(SETTINGS_PUBLISH, { private: "ignored" });
		const stopped = await tool.execute("stopped", { kind: "setting" }, undefined, undefined, context);
		assert.equal((stopped.details as { outcome: string }).outcome, "cancelled");
		assert.equal(requests, 2);
	} finally { dispose(); bus.clear(); await rm(agentDir, { recursive: true, force: true }); }
});
