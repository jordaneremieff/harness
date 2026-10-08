import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { collectSettings, parseSettingsPublication, SETTINGS_PUBLISH, SETTINGS_REQUEST, type SettingsPublication } from "./configuration-protocol.ts";
import { fakePublisher, publication } from "./configuration-fixtures.mts";

const fact = { field: "document", source: "file" as const, code: "document" as const, message: "untrusted error text" };

test("publication parsing copies only protocol fields and sanitizes diagnostic messages", () => {
	const input = { ...publication(), values: { token: "private-value" }, execute: () => {} };
	input.records[0] = { ...input.records[0], type: "json", value: { nested: [1, true, null] } };
	input.diagnostics = [fact];
	const parsed = parseSettingsPublication(input);
	assert.ok(parsed);
	assert.equal(parsed.diagnostics[0].message, "Configuration document is invalid or unavailable.");
	assert.doesNotMatch(JSON.stringify(parsed), /private-value|untrusted error text|execute/);
	assert.equal(Object.hasOwn(parsed, "values"), false);
	assert.notEqual(parsed.records[0].value, input.records[0].value);
	input.records[0].value = "changed";
	assert.deepEqual(parsed.records[0].value, { nested: [1, true, null] });
});

test("publication parsing rejects malformed envelopes, records, sources and diagnostics", () => {
	const changes: ((input: SettingsPublication) => void)[] = [
		(input) => { Object.assign(input, { version: 2 }); },
		(input) => { input.slice = "invalid-slice"; },
		(input) => { input.source.path = "relative"; },
		(input) => { input.source.digest = "not-a-digest"; },
		(input) => { Object.assign(input.source, { status: "other" }); },
		(input) => { input.source.observedAt = "x".repeat(65); },
		(input) => { input.records.push(input.records[0]); },
		(input) => { input.records[0].name = "other.count"; },
		(input) => { input.records[0].env = "NOT_AN_ENV"; },
		(input) => { input.records[0].description = "bad\u0000text"; },
		(input) => { input.records[0].description = "x".repeat(2049); },
		(input) => { Object.assign(input.records[0], { type: "other" }); },
		(input) => { Object.assign(input.records[0], { origin: "other" }); },
		(input) => { Object.assign(input.records[0], { status: "other" }); },
		(input) => { delete input.records[0].value; },
		(input) => { input.records[0].status = "unset"; },
		(input) => { input.records[0].secretState = "unset"; },
		(input) => { input.records[1].value = "private-value"; },
		(input) => { Object.assign(input.records[1], { value: undefined }); },
		(input) => { input.records[1].type = "json"; },
		(input) => { input.records[1].secretState = "set"; },
		(input) => { input.records[1].status = "valid"; },
		(input) => { input.diagnostics = [{ ...fact, field: "x".repeat(257) }]; },
		(input) => { input.diagnostics = [{ ...fact, code: "other" } as never]; },
	];
	for (const change of changes) {
		const input = publication();
		change(input);
		assert.equal(parseSettingsPublication(input), undefined, String(change));
	}
	for (const input of [null, [], "text", {}, { get version() { throw new Error("private-error"); } }]) {
		assert.equal(parseSettingsPublication(input), undefined);
	}
});

test("publication values enforce type, JSON depth, node and byte bounds", () => {
	const input = publication();
	const record = input.records[0];
	for (const [type, valid, invalid] of [
		["string", "text", "bad\u0000text"], ["enum", "choice", false],
		["path", "/absolute", "relative"], ["integer", 2, 1.5],
		["number", 1.5, Infinity], ["boolean", true, 1],
	] as const) {
		record.type = type;
		record.value = valid;
		assert.ok(parseSettingsPublication(input), type);
		record.value = invalid;
		assert.equal(parseSettingsPublication(input), undefined, type);
	}
	record.type = "json";
	let nested: unknown = null;
	for (let depth = 0; depth < 33; depth++) nested = [nested];
	const cyclic: unknown[] = []; cyclic.push(cyclic);
	for (const value of [nested, cyclic, Array(10000).fill(null), "x".repeat(131073), "\ud800", { ["x".repeat(4097)]: 1 }, new Date(), { "bad\u0000key": true }]) {
		record.value = value as never;
		assert.equal(parseSettingsPublication(input), undefined);
	}
	record.value = Array(9999).fill(null);
	assert.ok(parseSettingsPublication(input));
});

test("publication record, diagnostic and combined byte limits admit their bounded edge", () => {
	const input = publication();
	input.records = Array.from({ length: 128 }, (_, index) => ({ ...input.records[0], key: `key${index}`, name: `example.key${index}` }));
	input.diagnostics = Array.from({ length: 385 }, () => ({ ...fact }));
	assert.ok(parseSettingsPublication(input));
	input.diagnostics.push(fact);
	assert.equal(parseSettingsPublication(input), undefined);
	input.diagnostics.pop();
	input.records.push({ ...input.records[0], key: "extra", name: "example.extra" });
	assert.equal(parseSettingsPublication(input), undefined);
	input.records = Array.from({ length: 3 }, (_, index) => ({ ...input.records[0], key: `key${index}`, name: `example.key${index}`, type: "string", value: "x".repeat(100000) }));
	assert.equal(parseSettingsPublication(input), undefined);
});

test("collector replaces slices, clones snapshots, refreshes coverage and disposes once", () => {
	const bus = createEventBus();
	let current = publication();
	const stop = fakePublisher(bus, () => current);
	const collector = collectSettings(bus);
	try {
		assert.equal(collector.snapshots()[0].records[0].value, 2);
		current.records[0].value = 7;
		bus.emit(SETTINGS_PUBLISH, current);
		assert.equal(collector.snapshots().length, 1);
		const snapshots = collector.snapshots(); snapshots[0].records[0].value = 99;
		assert.equal(collector.snapshots()[0].records[0].value, 7);
		bus.emit(SETTINGS_PUBLISH, null);
		assert.equal(collector.coverage().malformed, 1);
		current = { ...publication(), slice: "another", records: [] };
		collector.refresh();
		assert.deepEqual(collector.coverage(), { status: "available", slices: ["another"], malformed: 0, omitted: 0 });
		stop();
		collector.refresh();
		assert.deepEqual(collector.snapshots(), []);
		collector.dispose(); collector.dispose(); collector.refresh();
		bus.emit(SETTINGS_PUBLISH, publication());
		assert.deepEqual(collector.coverage(), { status: "disposed", slices: [], malformed: 0, omitted: 0 });
	} finally { collector.dispose(); stop(); bus.clear(); }
});

test("collector caps slices but still replaces admitted slices at capacity", () => {
	const bus = createEventBus();
	const collector = collectSettings(bus);
	try {
		for (let index = 0; index < 66; index++) bus.emit(SETTINGS_PUBLISH, { ...publication(), slice: `slice${index}`, records: [] });
		assert.equal(collector.snapshots().length, 64);
		assert.equal(collector.coverage().omitted, 2);
		bus.emit(SETTINGS_PUBLISH, { ...publication(), slice: "slice0", records: [], diagnostics: [fact] });
		assert.equal(collector.snapshots()[0].diagnostics.length, 1);
		assert.equal(collector.coverage().omitted, 2);
		collector.refresh();
		assert.deepEqual(collector.coverage(), { status: "available", slices: [], malformed: 0, omitted: 0 });
	} finally { collector.dispose(); bus.clear(); }
});

test("collector releases failed setup and exposes refresh failure without raw error data", () => {
	let releases = 0;
	let requests = 0;
	let fail = true;
	const bus = {
		on: () => () => { releases++; },
		emit: (channel: string, request: unknown) => {
			assert.equal(channel, SETTINGS_REQUEST);
			assert.deepEqual(request, { version: 1 });
			requests++;
			if (fail) throw new Error("private-error");
		},
	};
	assert.throws(() => collectSettings(bus), /private-error/);
	assert.equal(releases, 1);
	fail = false;
	const collector = collectSettings(bus);
	fail = true;
	assert.throws(() => collector.refresh(), /private-error/);
	assert.equal(collector.coverage().status, "unavailable");
	assert.doesNotMatch(JSON.stringify(collector.coverage()), /private-error/);
	fail = false;
	collector.refresh();
	assert.equal(collector.coverage().status, "available");
	collector.dispose(); collector.dispose(); collector.refresh();
	assert.equal(releases, 2);
	assert.equal(requests, 4);
});
