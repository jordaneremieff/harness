import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CURSOR_MAX_BYTES,
	decodeCursor,
	encodeCursor,
	fingerprintRecords,
	hasAnySelector,
	LIMIT_DEFAULT,
	matchesName,
	paginate,
	parseQuery,
	QueryError,
	selectRecords,
	stampsEqual,
} from "./query.ts";
import type { ResourceRecord } from "./records.ts";

const info = { path: "/p", source: "package", scope: "user" as const, origin: "package" as const };

const record = (over: Partial<ResourceRecord> = {}): ResourceRecord => ({
	kind: "skill",
	name: "pillars",
	invocation: "/skill:pillars",
	sourceInfo: info,
	evidence: "registration",
	at: 1,
	...over,
});

describe("argument validation", () => {
	it("defaults match to exact and limit to the documented default", () => {
		const query = parseQuery({ name: "read" });
		assert.equal(query.match, "exact");
		assert.equal(query.limit, LIMIT_DEFAULT);
	});

	it("rejects out-of-range and unknown values with invalid_arguments", () => {
		for (const params of [
			{ name: "" },
			{ name: "x".repeat(257) },
			{ match: "fuzzy" },
			{ kind: "provider" },
			{ limit: 0 },
			{ limit: 101 },
			{ limit: 1.5 },
			{ contains: "" },
			{ contains: "x".repeat(1025), name: "a" },
		]) {
			assert.throws(
				() => parseQuery(params as Record<string, unknown>),
				(error: unknown) => error instanceof QueryError && error.reason === "invalid_arguments",
				`expected rejection for ${JSON.stringify(params)}`,
			);
		}
	});

	it("allows contains alone for a uniquely resolved file-backed resource", () => {
		assert.doesNotThrow(() => parseQuery({ contains: "memory" }));
		assert.doesNotThrow(() => parseQuery({ contains: "memory", name: "prime" }));
		assert.doesNotThrow(() => parseQuery({ contains: "memory", kind: "prompt" }));
	});

	it("detects any selector accompanying a cursor", () => {
		assert.equal(hasAnySelector({ cursor: "c" }), false);
		assert.equal(hasAnySelector({ cursor: "c", limit: 5 }), true);
		assert.equal(hasAnySelector({ kind: "tool" }), true);
	});
});

describe("name matching", () => {
	it("is case-sensitive in both modes", () => {
		assert.equal(matchesName(record(), parseQuery({ name: "pillars" })), true);
		assert.equal(matchesName(record(), parseQuery({ name: "Pillars" })), false);
		assert.equal(matchesName(record(), parseQuery({ name: "illar", match: "substring" })), true);
		assert.equal(matchesName(record(), parseQuery({ name: "Illar", match: "substring" })), false);
	});

	it("accepts a skill's resource name and its invocation alias", () => {
		assert.equal(matchesName(record(), parseQuery({ name: "skill:pillars" })), true);
		assert.equal(matchesName(record(), parseQuery({ name: "/skill:pillars" })), true);
	});

	it("filters by kind and name together", () => {
		const records = [record(), record({ kind: "prompt", name: "pillars", invocation: "/pillars" })];
		assert.equal(selectRecords(records, parseQuery({ name: "pillars", kind: "prompt" })).length, 1);
		assert.equal(selectRecords(records, parseQuery({ name: "pillars" })).length, 2);
	});
});

describe("metadata search", () => {
	it("searches tool guidance but not parameter schemas or source paths", () => {
		const records = [record({ kind: "tool", name: "inspect", invocation: undefined,
			description: "Inspect documents", promptGuidelines: ["Use inspect to verify a draft."],
			parameters: { type: "object", description: "schema-only" },
			sourceInfo: { ...info, path: "/fixtures/path-only.ts" } })];
		assert.equal(selectRecords(records, parseQuery({ search: "VERIFY" })).length, 1);
		assert.equal(selectRecords(records, parseQuery({ search: "schema-only" })).length, 0);
		assert.equal(selectRecords(records, parseQuery({ search: "path-only" })).length, 0);
		assert.equal(selectRecords(records, parseQuery({ kind: "skill", search: "verify" })).length, 0);
	});
	it("keeps each field literal without joins across names, descriptions, or guidelines", () => {
		const records = [record({ kind: "tool", name: "inspect", invocation: undefined,
			description: "documents", promptGuidelines: ["first", "second"] })];
		assert.equal(selectRecords(records, parseQuery({ search: "inspect\ndocuments" })).length, 0);
		assert.equal(selectRecords(records, parseQuery({ search: "first\nsecond" })).length, 0);
		assert.equal(selectRecords(records, parseQuery({ search: "first" })).length, 1);
	});
});

describe("cursor continuation", () => {
	const state = {
		query: parseQuery({ kind: "tool", limit: 2 }),
		offset: 2,
		fingerprint: "abc",
		epoch: "session-3",
	};

	it("round-trips its encoded query without new selectors", () => {
		const decoded = decodeCursor(encodeCursor(state));
		assert.deepEqual(decoded.query, state.query);
		assert.equal(decoded.offset, 2);
		assert.equal(decoded.fingerprint, "abc");
		assert.equal(decoded.epoch, "session-3");
	});

	it("carries a file stamp for a content query", () => {
		const file = { path: "/a", size: 10, mtimeMs: 5, ctimeMs: 5, ino: 1, dev: 1, digest: "abc" };
		const decoded = decodeCursor(encodeCursor({ ...state, file }));
		assert.deepEqual(decoded.file, file);
		assert.equal(stampsEqual(decoded.file, file), true);
		assert.equal(stampsEqual(decoded.file, { ...file, mtimeMs: 6 }), false);
		assert.equal(stampsEqual(decoded.file, { ...file, size: 11 }), false);
		assert.equal(stampsEqual(undefined, file), false);
	});

	it("rejects foreign, malformed, and oversized cursors", () => {
		for (const cursor of ["", "not-a-cursor", Buffer.from("{}").toString("base64url"), "x".repeat(CURSOR_MAX_BYTES + 1)]) {
			assert.throws(
				() => decodeCursor(cursor),
				(error: unknown) => error instanceof QueryError && error.reason === "invalid_arguments",
			);
		}
	});
});

describe("fingerprint and paging", () => {
	it("moves when a record is added, renamed, or re-sourced", () => {
		const base = [record()];
		const start = fingerprintRecords(base);
		assert.equal(fingerprintRecords([record()]), start);
		assert.notEqual(fingerprintRecords([record({ name: "other" })]), start);
		assert.notEqual(fingerprintRecords([record({ sourceInfo: { ...info, path: "/q" } })]), start);
		assert.notEqual(fingerprintRecords([...base, record({ name: "second" })]), start);
	});

	it("is order-independent for the same set", () => {
		const a = [record({ name: "a" }), record({ name: "b" })];
		assert.equal(fingerprintRecords(a), fingerprintRecords([...a].reverse()));
	});

	it("pages deterministically and reports the next offset only when more remain", () => {
		const items = [1, 2, 3, 4, 5];
		const first = paginate(items, 0, 2);
		assert.deepEqual(first.items, [1, 2]);
		assert.equal(first.nextOffset, 2);
		const last = paginate(items, 4, 2);
		assert.deepEqual(last.items, [5]);
		assert.equal(last.nextOffset, null);
		assert.equal(paginate(items, 99, 2).items.length, 0);
	});
});
