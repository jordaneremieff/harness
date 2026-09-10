import assert from "node:assert/strict";
import { test } from "node:test";
import {
	checkSchema,
	cloneJson,
	DATA_LIMITS,
	lookupData,
	readPath,
	snapshotData,
	UNKNOWN,
	validateNamedData,
	validPath,
	type NamedData,
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

test("schema checks use full public validation without conversion or default mutation", () => {
	const schema = {
		type: "object",
		properties: { size: { type: "integer", minimum: 2 }, mode: { enum: ["brief", "full"], default: "brief" } },
		required: ["size"],
		additionalProperties: false,
	};
	const input = { size: "2" };
	assert.equal(checkSchema(schema, input), false);
	assert.deepEqual(input, { size: "2" });
	assert.equal(checkSchema(schema, { size: 2 }), true);
	assert.equal(checkSchema(schema, { size: 2, extra: true }), false);
	assert.equal(
		checkSchema(
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
	assert.equal(checkSchema({ allOf: [{ type: "number" }, { minimum: 3 }], not: { const: 4 } }, 4), false);
	assert.equal(checkSchema({ type: "array", uniqueItems: true, items: { type: "number" } }, [1, 1]), false);
	assert.equal(checkSchema(undefined, {}), "unknown");
	assert.equal(checkSchema({ type: "object" }, UNKNOWN), "unknown");
	let reads = 0;
	const getter = Object.defineProperty({}, "size", {
		enumerable: true,
		get: () => {
			reads++;
			return 2;
		},
	});
	assert.equal(checkSchema(schema, getter), "unknown");
	assert.equal(reads, 0);
	assert.equal(checkSchema(false, {}), false);
	assert.equal(checkSchema(true, {}), true);
});

test("malformed schemas, unsupported contracts, and remote references remain unavailable", () => {
	for (const schema of [
		{ type: "unknown-type" },
		{ type: 4 },
		{ minimum: "bad" },
		{ type: "string", format: "undeclared-format" },
		{ type: "string", minLenght: 4 },
		{ $schema: "https://json-schema.org/draft/unknown/schema", type: "object" },
		{ $schema: "http://json-schema.org/draft-04/schema#", type: "object" },
		{ $ref: "https://example.invalid/schema.json" },
		{ $async: true, type: "number" },
	])
		assert.equal(checkSchema(schema, {}), "unknown", JSON.stringify(schema));
	assert.equal(checkSchema({ type: "string", format: "email" }, "not-an-address"), false);
	assert.equal(checkSchema({ type: "string", format: "email" }, "reader@example.test"), true);
});

test("declared JSON Schema drafts use their matching public validators", () => {
	const tuple = { type: "array", items: [{ type: "string" }], additionalItems: false };
	assert.equal(checkSchema(tuple, ["yes"]), true);
	assert.equal(checkSchema({ ...tuple, $schema: "https://json-schema.org/draft-07/schema#" }, [1]), false);
	const modern = {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		type: "array",
		prefixItems: [{ type: "string" }],
		items: false,
	};
	assert.equal(checkSchema(modern, ["yes"]), true);
	assert.equal(checkSchema(modern, [1]), false);
	assert.equal(checkSchema({ ...tuple, $schema: "https://json-schema.org/draft/2020-12/schema" }, ["yes"]), "unknown");
	const prior = {
		$schema: "https://json-schema.org/draft/2019-09/schema",
		type: "object",
		properties: { a: { type: "number" } },
		dependentRequired: { a: ["b"] },
	};
	assert.equal(checkSchema(prior, { a: 1 }), false);
	assert.equal(checkSchema(prior, { a: 1, b: 2 }), true);
	for (let index = 0; index < 70; index++) assert.equal(checkSchema({ const: index }, index), true);
	assert.equal(checkSchema(modern, ["yes"]), true);
});

test("schema data uses an approved named copy and schema tables are not alias tables", () => {
	const data: NamedData = {
		name: "arguments",
		revision: "123456789abc",
		source: "operator-schema",
		capturedAt: 1,
		maxAgeMs: 1000,
		kind: "schema",
		schema: { type: "object" },
	};
	assert.equal(validateNamedData(data), undefined);
	const snapshot = snapshotData([data], 2).arguments;
	assert.deepEqual(lookupData(snapshot, "x"), { status: "unavailable" });
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
