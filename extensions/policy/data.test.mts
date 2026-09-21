import assert from "node:assert/strict";
import { test } from "node:test";
import {
	checkToolSchema,
	cloneJson,
	DATA_LIMITS,
	lookupData,
	type NamedData,
	readPath,
	snapshotData,
	UNKNOWN,
	validateNamedData,
	validPath,
} from "./data.ts";

const binding = (changes: Partial<NamedData> = {}): NamedData =>
	({
		name: "teams",
		revision: "123456789abc",
		source: "operator-table",
		capturedAt: 100,
		maxAgeMs: 1000,
		kind: "table",
		rows: [{ key: "blue", value: "team-2" }],
		...changes,
	}) as NamedData;

test("named tables retain exact identity and expose freshness", () => {
	assert.equal(validateNamedData(binding()), undefined);
	const snapshots = snapshotData([binding()], 300);
	assert.equal(snapshots.teams.status, "ready");
	assert.equal(snapshots.teams.ageMs, 200);
	assert.equal(snapshots.teams.revision, "123456789abc");
	assert.deepEqual(lookupData(snapshots.teams, "blue"), { status: "unique", value: "team-2" });
	assert.deepEqual(lookupData(snapshots.teams, "Blue"), { status: "missing" });
	assert.equal(snapshotData([binding()], 1100).teams.status, "stale");
	assert.equal(snapshotData([binding()], 99).teams.status, "invalid");
	assert.deepEqual(lookupData(undefined, "blue"), { status: "unavailable" });
	assert.deepEqual(lookupData(snapshotData([binding()], 1100).teams, "blue"), { status: "unavailable" });
});

test("revision-controlled operator data has no forced time expiry", () => {
	const permanent = binding();
	delete permanent.maxAgeMs;
	assert.equal(validateNamedData(permanent), undefined);
	assert.equal(snapshotData([permanent], 9999999999).teams.status, "ready");
	assert.equal(snapshotData([permanent], 9999999999).teams.ageMs, 9999999899);
	assert.ok(validateNamedData({ ...permanent, maxAgeMs: 0 }));
});

test("tables distinguish duplicate same destinations from ambiguity without coercion", () => {
	const table = binding({
		rows: [
			{ key: 1, value: "a" },
			{ key: "1", value: "b" },
			{ key: 1, value: "a" },
		],
	});
	assert.deepEqual(lookupData(snapshotData([table], 100).teams, 1), { status: "unique", value: "a" });
	assert.deepEqual(lookupData(snapshotData([table], 100).teams, "1"), { status: "unique", value: "b" });
	if (table.kind === "table") table.rows.push({ key: 1, value: "c" });
	assert.deepEqual(lookupData(snapshotData([table], 100).teams, 1), { status: "ambiguous" });
});

test("ASCII collation folds only string keys and retains all collision choices", () => {
	const table = binding({
		collation: "ascii-case-insensitive",
		rows: [
			{ key: "Blue", value: "A" },
			{ key: "bLUE", value: "A" },
			{ key: "Å", value: "accent" },
			{ key: "1", value: "string" },
			{ key: 1, value: "number" },
			{ key: true, value: false },
			{ key: null, value: null },
		],
	});
	assert.equal(validateNamedData(table), undefined);
	const snapshot = snapshotData([table], 100).teams;
	assert.deepEqual(lookupData(snapshot, "BLUE"), { status: "unique", value: "A" });
	assert.deepEqual(lookupData(snapshot, "å"), { status: "missing" });
	assert.deepEqual(lookupData(snapshot, 1), { status: "unique", value: "number" });
	assert.deepEqual(lookupData(snapshot, "1"), { status: "unique", value: "string" });
	assert.deepEqual(lookupData(snapshot, true), { status: "unique", value: false });
	assert.deepEqual(lookupData(snapshot, null), { status: "unique", value: null });
	if (table.kind === "table") table.rows.push({ key: "BLUE", value: "a" });
	assert.deepEqual(lookupData(snapshotData([table], 100).teams, "BLUE"), { status: "ambiguous" });
	assert.deepEqual(lookupData(snapshot, "BLUE"), { status: "unique", value: "A" });
	assert.ok(validateNamedData({ ...table, collation: "unicode" }));
	assert.deepEqual(lookupData(snapshotData([binding({ collation: "exact" })], 100).teams, "Blue"), {
		status: "missing",
	});
});

test("data snapshots own independent copies and reject repeated names", () => {
	const table = binding();
	const first = snapshotData([table], 200);
	if (table.kind === "table") table.rows[0].value = "altered";
	assert.deepEqual(lookupData(first.teams, "blue"), { status: "unique", value: "team-2" });
	assert.equal(snapshotData([binding(), binding()], 200).teams.status, "invalid");
	assert.throws(() =>
		snapshotData(
			Array.from({ length: DATA_LIMITS.bindings + 1 }, () => binding()),
			200,
		),
	);
	assert.ok(
		validateNamedData(
			binding({ rows: Array.from({ length: DATA_LIMITS.rows + 1 }, () => ({ key: "a", value: "b" })) }),
		),
	);
	assert.ok(validateNamedData({ ...binding(), command: "execute" }));
});

test("registered tool checks do not convert, remove properties, or insert defaults", () => {
	const schema = {
		type: "object",
		properties: { size: { type: "integer", minimum: 2 }, mode: { enum: ["brief", "full"], default: "brief" } },
		required: ["size"],
		additionalProperties: false,
	};
	const input = { size: "2" };
	assert.equal(checkToolSchema(schema, input), false);
	assert.deepEqual(input, { size: "2" });
	const valid = { size: 2 };
	assert.equal(checkToolSchema(schema, valid), true);
	assert.deepEqual(valid, { size: 2 });
	assert.equal(checkToolSchema(schema, { size: 2, extra: true }), false);
	assert.equal(
		checkToolSchema(
			{
				anyOf: [
					{ type: "string", minLength: 2 },
					{ type: "number", minimum: 4 },
				],
			},
			"x",
		),
		false,
	);
	assert.equal(checkToolSchema({ allOf: [{ type: "number" }, { minimum: 3 }], not: { const: 4 } }, 4), false);
	assert.equal(checkToolSchema({ type: "array", uniqueItems: true, items: { type: "number" } }, [1, 1]), false);
	assert.equal(checkToolSchema(undefined, {}), "unknown");
	assert.equal(checkToolSchema({ type: "object" }, UNKNOWN), "unknown");
	let reads = 0;
	const getter = Object.defineProperty({}, "size", {
		enumerable: true,
		get: () => {
			reads++;
			return 2;
		},
	});
	assert.equal(checkToolSchema(schema, getter), "unknown");
	assert.equal(reads, 0);
});

test("tool checks retain bounded copies and cache eviction", () => {
	const cycle: Record<string, unknown> = { type: "object" };
	cycle.properties = cycle;
	assert.equal(checkToolSchema(cycle, {}), "unknown");
	for (let index = 0; index <= 64; index++) assert.equal(checkToolSchema({ const: index }, index), true);
	assert.equal(checkToolSchema({ const: 0 }, 1), false);
});

test("named data rejects schema bindings and extra schema fields", () => {
	assert.ok(validateNamedData({ ...binding(), kind: "schema", schema: { type: "object" } }));
	assert.ok(validateNamedData({ ...binding(), schema: { type: "object" } }));
});

test("JSON copies reject cycles, getters, nonfinite values, unsafe keys, and oversized data", () => {
	let getterCalls = 0;
	const getter = Object.defineProperty({}, "secret", {
		enumerable: true,
		get: () => {
			getterCalls++;
			return "not read";
		},
	});
	assert.throws(() => cloneJson(getter));
	assert.equal(getterCalls, 0);
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	for (const value of [
		cycle,
		NaN,
		Infinity,
		new Date(),
		new Map(),
		undefined,
		JSON.parse('{"__proto__":{"polluted":true}}'),
		Array(3),
	])
		assert.throws(() => cloneJson(value));
	assert.throws(() => cloneJson("x".repeat(DATA_LIMITS.bytes + 1)));
	assert.deepEqual(cloneJson({ a: [1, null, true] }), { a: [1, null, true] });
	assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("fixed paths never traverse inherited or accessor properties", () => {
	assert.equal(validPath(["input", "constructor"]), false);
	assert.equal(validPath(Array.from({ length: 17 }, () => "x")), false);
	assert.equal(validPath(["input", "valid"]), true);
	assert.deepEqual(readPath(Object.create({ inherited: true }), ["inherited"]), { exists: false, value: undefined });
	assert.deepEqual(readPath({ input: UNKNOWN }, ["input", "x"]), { exists: false, value: UNKNOWN });
	assert.deepEqual(readPath({ input: {} }, ["input", "x"]), { exists: false, value: undefined });
	assert.equal(
		readPath(
			Object.defineProperty({}, "x", {
				get: () => {
					throw new Error("never");
				},
			}),
			["x"],
		).value,
		UNKNOWN,
	);
});
