import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { searchHistory, type HistorySource } from "./core.ts";

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
