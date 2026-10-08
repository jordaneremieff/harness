import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import { createEventBus, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SETTINGS_PUBLISH } from "./configuration-protocol.ts";
import { fakePublisher, publication } from "./configuration-fixtures.mts";
import { settingsReader, type SettingsSnapshot } from "./configuration.ts";
import { lookup } from "./lookup.ts";
import { parseQuery } from "./query.ts";
import { RegistryOutputSchema } from "./output.ts";
import registerRegistry from "./index.ts";

function snapshot(): SettingsSnapshot {
	return { publications: [publication()], available: true,
		collection: { status: "available", slices: ["example"], malformed: 0, omitted: 0 } };
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
	const bus = createEventBus();
	const current = publication();
	current.records[0] = { ...current.records[0], value: 7, origin: "env" };
	current.records[1] = { ...current.records[1], secretState: "set", status: "valid", origin: "env" };
	current.source.status = "loaded";
	current.diagnostics = [
		{ field: "example.token", source: "file", code: "secret", message: "Secret settings are environment-only; document input was rejected." },
		{ field: "example.unknown", source: "file", code: "unknown", message: "Unknown setting in this section." },
	];
	const dispose = fakePublisher(bus, () => current);
	const reader = settingsReader(bus);
	try {
		const inspect = (params: Record<string, unknown>) => lookup({ params, snapshot: hostSnapshot, settings: reader.read(), session: {}, epoch: "fixture" });
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
		const originalCursor = first.details.cursor;
		current.source.observedAt = "2026-01-02T00:00:00.000Z";
		current.source.digest = "a".repeat(64);
		assert.equal((await inspect({ cursor: originalCursor })).outcome, "ok", "observation time and document digest do not enter fingerprints");
		current.records[0] = { ...current.records[0], value: 2, status: "invalid", origin: "default" };
		current.diagnostics.push({ field: "example.count", source: "env", code: "invalid", message: "Selected input is invalid; the safe default is in effect." });
		const rejected = await inspect({ name: "example.count", kind: "setting" });
		assert.equal(verify(rejected)[0].status, "invalid");
		assert.equal(verify(rejected)[0].value, 2);
		assert.equal((verify(rejected)[0].diagnostics as unknown[]).length, 1);
		assert.equal((await inspect({ cursor: originalCursor })).outcome, "stale_cursor");
		current.records[0] = { ...current.records[0], value: 5, status: "valid", origin: "file" };
		current.diagnostics.pop();
		const file = await inspect({ kind: "setting", search: "bounded" });
		assert.equal(verify(file)[0].origin, "file");
		assert.equal(verify(file)[0].value, 5);
		assert.equal(verify(await inspect({ kind: "setting", name: "example", match: "substring" })).length, 2);
		current.source.status = "invalid";
		current.records[0] = { ...current.records[0], value: 2, origin: "default" };
		current.diagnostics = [{ field: "document", source: "file", code: "document", message: "Configuration document is invalid or unavailable." }];
		const malformed = await inspect({ kind: "setting" });
		assert.match(malformed.text, /example.document: file document/);
		assert.equal(verify(malformed)[0].origin, "default");
		assert.equal((await inspect({ kind: "setting", name: "absent" })).outcome, "missing");
	} finally { reader.dispose(); dispose(); bus.clear(); }
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
	const huge = publication();
	huge.records = [{ ...huge.records[0], name: "example.value", key: "value", type: "string", env: "PI_EXAMPLE_VALUE", value: "x".repeat(20000) }];
	const dispose = fakePublisher(bus, () => huge);
	const reader = settingsReader(bus);
	try {
		const result = await lookup({ params: { kind: "setting" }, snapshot: hostSnapshot, settings: reader.read(), session: {}, epoch: "fixture" });
		verify(result);
		assert.equal(result.details.pageBlocked, true);
		assert.equal(result.details.returnedRecords, 0);
		assert.equal(result.details.cursor, undefined);
	} finally { reader.dispose(); dispose(); bus.clear(); }
});

test("partial publication coverage prevents absence and invalidates cursors without rejected bytes", async () => {
	const configured = snapshot();
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

test("local collector rejects secret-bearing malformed publications with sanitized coverage", () => {
	const bus = createEventBus();
	bus.on("harness:settings:request", () => {
		const malformed = publication();
		malformed.records[1].value = "private-rejected-value";
		bus.emit(SETTINGS_PUBLISH, malformed);
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
	const configured = snapshot();
	configured.publications[0].records[0].status = "invalid";
	configured.publications[0].diagnostics = JSON.parse('[{"field":"example.count","source":"default","code":"relation","message":"Configured settings violate an owning constraint."}]');
	const result = await lookup({ params: { kind: "setting", name: "example.count" }, snapshot: hostSnapshot, settings: configured, session: {}, epoch: "fixture" });
	const rows = verify(result);
	assert.equal(rows[0].value, 2);
	assert.equal(rows[0].status, "invalid");
	assert.equal((rows[0].diagnostics as { code: string }[])[0].code, "relation");
});

test("setting metadata keeps Unicode line separators off terminal rows", async () => {
	const configured = snapshot();
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
	const agentDir = "/fixtures";
	const bus = createEventBus();
	let requests = 0;
	bus.on("harness:settings:request", () => { requests++; });
	const current = publication();
	current.records[0] = { ...current.records[0], value: 9, origin: "env" };
	const dispose = fakePublisher(bus, () => current);
	let subscriptions = 0;
	let releases = 0;
	const observedBus = { ...bus, on(channel: string, handler: (data: unknown) => void) {
		const unsubscribe = bus.on(channel, handler);
		if (channel === SETTINGS_PUBLISH) subscriptions++;
		return () => { if (channel === SETTINGS_PUBLISH) releases++; unsubscribe(); };
	} };
	const handlers = new Map<string, () => Promise<void>>();
	let tool: ToolDefinition | undefined;
	registerRegistry({ events: observedBus, on: (event: string, callback: () => Promise<void>) => handlers.set(event, callback),
		registerTool: (value: ToolDefinition) => { tool = value; }, getAllTools: () => [], getActiveTools: () => [], getCommands: () => [],
	} as unknown as ExtensionAPI);
	assert.ok(tool);
	const context = { tools: [], cwd: agentDir } as never;
	try {
		const result = await tool.execute("settings", { kind: "setting", name: "example.count" }, undefined, undefined, context);
		assert.equal((result.details as { records: { value: number }[] }).records[0].value, 9);
		assert.equal(requests, 1);
		current.records[0].value = 10;
		const refreshed = await tool.execute("settings", { kind: "setting" }, undefined, undefined, context);
		assert.equal((refreshed.details as { records: { value: number }[] }).records[0].value, 10);
		await tool.execute("cancel", { kind: "setting" }, AbortSignal.abort(), undefined, context);
		await tool.execute("invalid", { kind: "setting", contains: "value" }, undefined, undefined, context);
		assert.equal(requests, 2);
		assert.equal(subscriptions, 1);
		assert.equal(releases, 0);
		await handlers.get("session_shutdown")?.();
		assert.equal(releases, 1);
		bus.emit(SETTINGS_PUBLISH, { private: "ignored" });
		const stopped = await tool.execute("stopped", { kind: "setting" }, undefined, undefined, context);
		assert.equal((stopped.details as { outcome: string }).outcome, "cancelled");
		assert.equal(requests, 2);
		assert.equal(subscriptions, 1);
		await handlers.get("session_shutdown")?.();
		assert.equal(releases, 1);
	} finally { dispose(); bus.clear(); }
});
