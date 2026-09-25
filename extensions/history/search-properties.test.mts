import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { LIMITS, searchHistory, toolResult, type HistorySource } from "./core.ts";

function message(
	id: string,
	parentId: string | null,
	content: string | { type: "text"; text: string }[],
): SessionEntry {
	return {
		id,
		parentId,
		type: "message",
		timestamp: "2026-01-01T00:00:00Z",
		message: { role: "user", content, timestamp: 1 },
	};
}

function positions(text: string, query: string): number[] {
	const found: number[] = [];
	let offset = text.indexOf(query);
	while (offset !== -1) {
		found.push(offset);
		offset = text.indexOf(query, offset + 1);
	}
	return found;
}

test("search continuations preserve every literal match across byte and result boundaries", () => {
	const cases = [
		{ query: "needle", text: `${"x".repeat(2045)}needle${" needle".repeat(35)}` },
		{ query: "🧭λ", text: `${"x".repeat(2047)}🧭λ${"🧭λ".repeat(35)}` },
		{ query: "aba", text: `${"x".repeat(2046)}${"ab".repeat(90)}a` },
		{ query: "界".repeat(85), text: `${"x".repeat(1920)}${"界".repeat(90)}` },
	];
	for (const { query, text } of cases) {
		const entry = message("root", null, [
			{ type: "text", text: "z".repeat(2000) },
			{ type: "text", text },
		]);
		let calls = 0;
		const source: HistorySource = {
			getSessionId: () => "test-session",
			getLeafId: () => "root",
			getEntry: (id) => {
				calls++;
				return id === "root" ? entry : undefined;
			},
		};
		let cursor: Record<string, unknown> = {};
		const actual: number[] = [];
		let complete = false;
		for (let page = 0; page < 100; page++) {
			const before = calls;
			const result = searchHistory(source, { query, maxScanBytes: 2048, maxMatches: 7, ...cursor });
			assert.ok(calls - before <= 128);
			assert.ok((result.scannedBytes as number) <= 2048);
			for (const hit of result.matches as { pointer: string; offset: number; endOffset: number }[]) {
				assert.equal(hit.pointer, "/message/content/1/text");
				assert.equal(text.slice(hit.offset, hit.endOffset), query);
				actual.push(hit.offset);
			}
			if (result.next === null) {
				complete = true;
				break;
			}
			assert.notDeepEqual(result.next, cursor, "a continuation must advance within the selected ancestry");
			cursor = result.next as Record<string, unknown>;
		}
		assert.ok(complete, "bounded pages must eventually exhaust this fixture");
		assert.deepEqual(actual, positions(text, query));
	}
});

function mixedFixture(source: string, query: string | undefined) {
	const text = `${"x".repeat(2047)}${"🧭λ\u0001".repeat(25)}`;
	const entries = new Map<string, SessionEntry>();
	const expected: { id: string; pointer: string; offset?: number }[] = [];
	for (let i = 0; i < 5; i++) {
		const id = `selected-${i}`;
		const parentId = i === 0 ? null : `excluded-${i - 1}`;
		const timestamp = "2026-01-01";
		const content = [
			...Array.from({ length: 513 }, () => ({ type: "text" as const, text: "" })),
			{ type: "text" as const, text },
		];
		const entry: SessionEntry =
			source === "summary"
				? { id, parentId, timestamp, type: "compaction", summary: text, firstKeptEntryId: id, tokensBefore: 1 }
				: {
						id,
						parentId,
						timestamp,
						type: "message",
						message:
							source === "user"
								? { role: "user", content, timestamp: 1 }
								: { role: "toolResult", toolName: "probe", toolCallId: "call", isError: true, content, timestamp: 1 },
					};
		entries.set(id, entry);
		entries.set(`excluded-${i}`, {
			id: `excluded-${i}`,
			parentId: id,
			timestamp,
			type: "custom_message",
			customType: "note",
			display: true,
			content: "irrelevant".repeat(10000),
		});
		const pointer = source === "summary" ? "/summary" : "/message/content/513/text";
		const hits =
			query === undefined ? [{ id, pointer: "" }] : positions(text, query).map((offset) => ({ id, pointer, offset }));
		expected.unshift(...hits);
	}
	return { entries, expected };
}

function collectFilteredPages(
	entries: Map<string, SessionEntry>,
	filter: Record<string, unknown>,
	query: string | undefined,
	maxVisits: number,
	maxMatches: number,
	statuses: Set<unknown>,
) {
	let calls = 0;
	const source: HistorySource = {
		getSessionId: () => "s",
		getLeafId: () => "excluded-4",
		getEntry(id) {
			calls++;
			return entries.get(id);
		},
	};
	let cursor: Record<string, unknown> = { filter };
	const actual: { id: string; pointer: string; offset?: number }[] = [];
	for (let page = 0; page < 500; page++) {
		const before = calls;
		const result = searchHistory(source, {
			query,
			maxVisits,
			maxMatches,
			maxScanBytes: 2048,
			maxOutputBytes: 4096,
			...cursor,
		});
		statuses.add(result.status);
		assert.ok(calls - before <= maxVisits);
		assert.equal(result.visited, calls - before);
		assert.ok(Number(result.scannedBytes) <= 2048);
		assert.ok(Number(result.slotsVisited) <= LIMITS.slots);
		assert.ok(Buffer.byteLength(JSON.stringify(toolResult(result))) <= 4096);
		assert.deepEqual(result.filter, filter);
		for (const hit of result.matches as { entry: { id: string }; pointer: string; offset?: number }[])
			actual.push({ id: hit.entry.id, pointer: hit.pointer, ...(query === undefined ? {} : { offset: hit.offset }) });
		if (result.next === null) return actual;
		assert.notDeepEqual(result.next, cursor);
		cursor = result.next as Record<string, unknown>;
		assert.deepEqual(cursor.filter, filter);
	}
	assert.fail("bounded pages must eventually exhaust this fixture");
}

test("filtered pages compose visit, slot, byte, match, and output bounds without lost or duplicate matches", () => {
	const statuses = new Set<unknown>();
	const filters = [
		{ source: "user" },
		{ source: "summary" },
		{ source: "toolResult", toolName: "probe", errorsOnly: true },
	];
	for (const filter of filters) {
		for (const query of [undefined, "🧭λ", "\u0001"]) {
			const { entries, expected } = mixedFixture(filter.source, query);
			for (const maxVisits of [1, 128]) {
				for (const maxMatches of [1, 20]) {
					assert.deepEqual(collectFilteredPages(entries, filter, query, maxVisits, maxMatches, statuses), expected);
				}
			}
		}
	}
	assert.deepEqual([...statuses].sort(), [
		"ancestry_exhausted",
		"match_limit",
		"output_limit",
		"scan_limit",
		"slot_limit",
		"visit_limit",
	]);
});

test("entry visit limits retain the original ancestry when the current leaf changes", () => {
	const entries = new Map<string, SessionEntry>();
	for (let index = 0; index < 40; index++)
		entries.set(`entry-${index}`, message(`entry-${index}`, index ? `entry-${index - 1}` : null, "no match"));
	let calls = 0;
	let leaf = "entry-39";
	const source: HistorySource = {
		getSessionId: () => "test-session",
		getLeafId: () => leaf,
		getEntry: (id) => {
			calls++;
			return entries.get(id);
		},
	};
	let cursor: Record<string, unknown> = {};
	let complete = false;
	for (let page = 0; page < 20; page++) {
		const before = calls;
		const result = searchHistory(source, { query: "missing-needle", maxVisits: 3, ...cursor });
		assert.ok(calls - before <= 3);
		assert.equal(result.visited, calls - before);
		if (result.next === null) {
			complete = true;
			break;
		}
		assert.equal(result.status, "visit_limit");
		cursor = result.next as Record<string, unknown>;
		leaf = "new-unrelated-tip";
	}
	assert.ok(complete);
	assert.equal(calls, entries.size);
});
