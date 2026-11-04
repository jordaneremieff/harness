/** Behavioral drive tests for ClipboardPanel with fake I/O, real rendering, and fake pointer geometry. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { ClipboardPanel, type PanelDeps, type RestoreOutcome } from "./panel.ts";
import { SEARCH_LIMITS, type SearchMatch, type SearchPage } from "./search.ts";
import { type ClipboardEntry, makeEntry } from "./store.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const flush = () => new Promise((resolve) => setImmediate(resolve));

function at<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error(`missing fixture item ${index}`);
	return item;
}

function sampleEntries(): ClipboardEntry[] {
	return [
		makeEntry("latest copy", "new", new Date("2026-07-24T12:00:00Z"), "11111111-1111-4111-8111-111111111111"),
		makeEntry(
			Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"),
			"long",
			new Date("2026-07-24T11:00:00Z"),
			"22222222-2222-4222-8222-222222222222",
		),
		makeEntry("oldest copy", undefined, new Date("2026-07-24T10:00:00Z"), "33333333-3333-4333-8333-333333333333"),
	];
}

const scan = { directoryEntries: 1, archives: 1, files: 1, bytes: 10, records: 1, malformed: 0, oversized: 0, duplicates: 0 };

function searchPage(entries: ClipboardEntry[], nextCursor: string | null): SearchPage {
	const matches: SearchMatch[] = entries.map((entry) => ({
		id: entry.id,
		date: "2026-07-24",
		timestamp: entry.timestamp,
		label: entry.label,
		lines: entry.lines,
		chars: entry.chars,
		match: { field: "content", offset: 0, excerpt: entry.preview },
	}));
	return {
		matches,
		nextCursor,
		hasMore: nextCursor !== null,
		stop: nextCursor === null ? "end" : "records",
		scan,
		limits: SEARCH_LIMITS,
	};
}

interface Rig {
	panel: ClipboardPanel;
	calls: { renders: number; restores: ClipboardEntry[]; done: unknown; searches: Array<[string, string | undefined]> };
	size: { rows: number };
}

function rig(overrides: Partial<PanelDeps> = {}, rows = 20, entries = sampleEntries()): Rig {
	const size = { rows };
	const calls: Rig["calls"] = { renders: 0, restores: [], done: undefined, searches: [] };
	const panel = new ClipboardPanel({
		entries,
		theme,
		tui: { requestRender: () => calls.renders++ },
		getMaxRows: () => size.rows,
		done: (result) => {
			calls.done = result;
		},
		onRestore: async (entry): Promise<RestoreOutcome> => {
			calls.restores.push(entry);
			return { ok: true };
		},
		onSearch: async (query, cursor) => {
			calls.searches.push([query, cursor]);
			return searchPage([], null);
		},
		...overrides,
	});
	return { panel, calls, size };
}

/** Clicks the first rendered row containing `needle`; the hit starts at that column. */
function clickAt(panel: ClipboardPanel, lines: string[], width: number, needle: string) {
	const y = lines.findIndex((line) => line.includes(needle));
	assert.notEqual(y, -1, `no rendered row contains ${needle}`);
	const x = lines[y].indexOf(needle);
	return panel.handleMouse({
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	} as TuiMouseEvent);
}

function wheelAt(panel: ClipboardPanel, lines: string[], width: number, needle: string, delta: number) {
	const y = lines.findIndex((line) => line.includes(needle));
	assert.notEqual(y, -1, `no rendered row contains ${needle}`);
	return panel.handleMouse({
		type: "wheel",
		button: "none",
		x: 3,
		y,
		screenX: 3,
		screenY: y,
		width,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		wheelDelta: delta,
	} as TuiMouseEvent);
}

describe("ClipboardPanel layout and controls", () => {
	it("shows labelled controls and the Recent scope at 80 and 100 columns", () => {
		for (const width of [80, 100]) {
			const { panel } = rig();
			const text = panel.render(width).join("\n");
			for (const label of ["[Recent", "[Search archive]", "[Refresh]", "[Help]", "[Search]", "[Restore]", "[Detail]", "[Close]", "[Previous page]", "[Next page]"])
				assert.match(text, new RegExp(label.replace(/[[\]]/g, "\\$&")), `${label} at width ${width}`);
			assert.doesNotMatch(text, /\[Continue\]/, "Continue is offered only while an archive scan has a next page");
			assert.doesNotMatch(text, /Ctrl\+A|↑↓ Select/, "the footer carries state, not a shortcut legend");
			assert.match(text, /Clipboard history · Recent 3/);
		}
	});

	it("Help shows the shortcut legend in the preview pane and leaves on Esc", () => {
		const { panel } = rig();
		let lines = panel.render(80);
		clickAt(panel, lines, 80, "[Help]");
		lines = panel.render(80);
		assert.match(lines.join("\n"), /Rows select; labelled controls act/);
		assert.match(lines.join("\n"), /\[Help ✓\]/);
		panel.handleInput("\x1b");
		assert.doesNotMatch(panel.render(80).join("\n"), /Rows select; labelled controls act/);
	});

	it("renders every row within the requested width", () => {
		const { panel } = rig();
		for (const width of [40, 60, 80]) for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width);
	});

	it("wraps a long preview line instead of cutting it off", () => {
		const long = `${"A".repeat(100)}TAILMARK`;
		const { panel } = rig({}, 24, [makeEntry(long, "wide", new Date("2026-07-24T12:00:00Z"), "44444444-4444-4444-8444-444444444444")]);
		const lines = panel.render(60);
		assert.ok(lines.some((line) => line.includes(`${"A".repeat(42)}TAILMARK`)), "tail must reach a wrapped row");
	});

	it("neutralizes terminal controls in labels and content", () => {
		const hostile = makeEntry("body\x1b[31mred\x1b[0m", "title\x1b]0;owned\x07", new Date(), "safe-id");
		const output = rig({}, 20, [hostile]).panel.render(60).join("\n");
		assert.ok(!output.includes("\x1b"));
		assert.match(output, /\\x1b/);
	});

	it("renders a keyboard-addressable empty state with its controls", () => {
		const output = rig({}, 20, []).panel.render(80).join("\n");
		assert.match(output, /No clipboard history matches\./);
		assert.match(output, /\[Close\]/);
	});

	it("shows a resize message and a reachable Close at unsupported sizes", () => {
		const { panel } = rig({}, 10);
		const lines = panel.render(40);
		assert.match(lines.join("\n"), /Resize to 48x12 or larger/);
		assert.match(lines.join("\n"), /\[Close\]/);
	});
});

describe("ClipboardPanel pointer interaction", () => {
	it("selects a row on click without restoring it", () => {
		const { panel, calls } = rig();
		let lines = panel.render(80);
		assert.equal(clickAt(panel, lines, 80, "oldest copy")?.handled, true);
		lines = panel.render(80);
		assert.match(lines.find((line) => line.includes("oldest copy")) ?? "", /›/);
		assert.deepEqual(calls.restores, []);
		assert.equal(calls.done, undefined);
	});

	it("restores only through the labelled Restore control, never on selection", async () => {
		const { panel, calls } = rig();
		let lines = panel.render(80);
		clickAt(panel, lines, 80, "oldest copy");
		lines = panel.render(80);
		assert.equal(calls.restores.length, 0);
		clickAt(panel, lines, 80, "[Restore]");
		await flush();
		assert.equal(calls.restores.length, 1);
		assert.equal(calls.restores[0]?.id, "33333333-3333-4333-8333-333333333333");
		assert.deepEqual(calls.done, { restored: calls.restores[0] });
	});

	it("scrolls the preview pane under the pointer without changing the selection", () => {
		const { panel, calls } = rig({}, 16);
		let lines = panel.render(80);
		clickAt(panel, lines, 80, "long");
		lines = panel.render(80);
		wheelAt(panel, lines, 80, "line 1", 3);
		lines = panel.render(80);
		assert.ok(lines.some((line) => line.includes("line 4")), "preview scrolls to line 4");
		assert.match(lines.find((line) => line.includes("line 4")) ?? "", /line 4/);
		assert.deepEqual(calls.restores, []);
	});

	it("ignores clicks whose geometry predates a resize", () => {
		const { panel, calls, size } = rig({}, 20);
		const lines = panel.render(80);
		size.rows = 16;
		assert.equal(clickAt(panel, lines, 80, "[Restore]"), undefined);
		assert.equal(clickAt(panel, lines, 80, "oldest copy"), undefined);
		assert.deepEqual(calls.restores, []);
	});

	it("ignores clicks whose geometry predates a width change", () => {
		const { panel } = rig();
		const lines = panel.render(80);
		assert.equal(clickAt(panel, lines, 100, "oldest copy"), undefined);
	});

	it("drops hit regions when the entries are replaced", () => {
		const { panel, calls } = rig();
		const lines = panel.render(80);
		panel.replaceEntries([makeEntry("replacement row", undefined, new Date(), "55555555-5555-4555-8555-555555555555")]);
		assert.equal(clickAt(panel, lines, 80, "oldest copy"), undefined);
		assert.deepEqual(calls.restores, []);
	});

	it("drops hit regions when the panel is hidden", () => {
		const { panel } = rig();
		const lines = panel.render(80);
		panel.hide();
		assert.equal(clickAt(panel, lines, 80, "oldest copy"), undefined);
	});
});

describe("ClipboardPanel archive scope", () => {
	it("keeps Continue reachable after an empty bounded page", async () => {
		const { panel, calls } = rig({
			onSearch: async (query, cursor) => {
				calls.searches.push([query, cursor]);
				return cursor === undefined ? searchPage([], "cursor-2") : searchPage([at(sampleEntries(), 0)], null);
			},
		});
		let lines = panel.render(80);
		clickAt(panel, lines, 80, "[Search archive]");
		panel.handleInput("a");
		panel.handleInput("\r");
		await flush();
		lines = panel.render(80);
		assert.match(lines.join("\n"), /No matches on this page/);
		assert.match(lines.join("\n"), /Partial scan; Continue remains available/);
		clickAt(panel, lines, 80, "[Continue]");
		await flush();
		assert.deepEqual(calls.searches, [
			["a", undefined],
			["a", "cursor-2"],
		]);
		assert.match(panel.render(80).join("\n"), /End of observed scan/);
	});

	it("stale archive state offers Refresh and never restores the selected record", async () => {
		const match = at(sampleEntries(), 0);
		const { panel, calls } = rig({
			onSearch: async (query, cursor) => {
				calls.searches.push([query, cursor]);
				return searchPage([match], "cursor-1");
			},
		});
		let lines = panel.render(80);
		clickAt(panel, lines, 80, "[Search archive]");
		panel.handleInput("a");
		panel.handleInput("\r");
		await flush();
		panel.handleInput("b");
		panel.handleInput("\x1b");
		panel.handleInput("\r");
		await flush();
		lines = panel.render(80);
		assert.match(lines.join("\n"), /Query changed/);
		assert.match(lines.join("\n"), /Restore unavailable/);
		assert.deepEqual(calls.restores, []);
		assert.equal(calls.done, undefined);
		clickAt(panel, lines, 80, "[Refresh]");
		await flush();
		assert.deepEqual(calls.searches[1], ["ab", undefined]);
		assert.deepEqual(calls.restores, []);
	});

	it("discards a late search result after the query changes", async () => {
		let release!: (page: SearchPage) => void;
		const { panel, calls } = rig({
			onSearch: (query, cursor) => {
				calls.searches.push([query, cursor]);
				return new Promise<SearchPage>((resolve) => {
					release = resolve;
				});
			},
		});
		const lines = panel.render(80);
		clickAt(panel, lines, 80, "[Search archive]");
		panel.handleInput("a");
		panel.handleInput("\r");
		panel.handleInput("b");
		release(searchPage([at(sampleEntries(), 2)], null));
		await flush();
		assert.match(panel.render(80).join("\n"), /Query changed/);
		assert.doesNotMatch(panel.render(80).join("\n"), /oldest copy/);
	});

	it("reports an unavailable archive read as stale rather than empty", async () => {
		const { panel } = rig({
			onSearch: async () => {
				throw new Error("archive read failed");
			},
		});
		let lines = panel.render(80);
		clickAt(panel, lines, 80, "[Search archive]");
		panel.handleInput("a");
		panel.handleInput("\r");
		await flush();
		lines = panel.render(80);
		assert.match(lines.join("\n"), /Archive state unavailable or stale. Refresh required: archive read failed/);
	});
});

describe("ClipboardPanel keyboard and lifecycle", () => {
	it("filters live on printable input and escape clears, then closes", () => {
		const { panel, calls } = rig();
		panel.handleInput("o");
		panel.handleInput("l");
		panel.handleInput("d");
		assert.match(panel.render(80).join("\n"), /oldest copy/);
		assert.doesNotMatch(panel.render(80).join("\n"), /latest copy/);
		// First Escape leaves edit mode, the second clears the filter, the third closes.
		panel.handleInput("\x1b");
		panel.handleInput("\x1b");
		assert.equal(calls.done, undefined);
		panel.handleInput("\x1b");
		assert.deepEqual(calls.done, {});
	});

	it("filters on Kitty CSI-u printable events", () => {
		const { panel } = rig();
		for (const seq of ["\x1b[111u", "\x1b[108u", "\x1b[100u"]) panel.handleInput(seq);
		assert.match(panel.render(80).join("\n"), /oldest copy/);
	});

	it("restores the selected entry on Enter and closes", async () => {
		const { panel, calls } = rig();
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		await flush();
		assert.equal(calls.restores[0]?.id, "33333333-3333-4333-8333-333333333333");
		assert.deepEqual(calls.done, { restored: calls.restores[0] });
	});

	it("cancels an active restore with Escape and keeps the failure visible", async () => {
		let signal: AbortSignal | undefined;
		const { panel, calls } = rig({
			onRestore: async (_entry, current) => {
				signal = current;
				return new Promise((resolve) => {
					current.addEventListener("abort", () => resolve({ ok: false, error: "cancelled" }), { once: true });
				});
			},
		});
		panel.handleInput("\r");
		assert.match(panel.render(80).join("\n"), /Escape cancels/);
		panel.handleInput("\x1b");
		await flush();
		assert.equal(signal?.aborted, true);
		assert.equal(calls.done, undefined);
		assert.match(panel.render(80).join("\n"), /cancelled/);
	});

	it("disposes active work and suppresses late callbacks", async () => {
		let settle!: (outcome: RestoreOutcome) => void;
		let signal: AbortSignal | undefined;
		const { panel, calls } = rig({
			onRestore: async (_entry, current) => {
				signal = current;
				return new Promise((resolve) => {
					settle = resolve;
				});
			},
		});
		panel.handleInput("\r");
		panel.dispose();
		panel.dispose();
		assert.equal(signal?.aborted, true);
		const renders = calls.renders;
		settle({ ok: true });
		await flush();
		assert.equal(calls.done, undefined);
		assert.equal(calls.renders, renders);
	});

	it("reports a completed restore with an archive warning and closes", async () => {
		const { panel, calls } = rig({ onRestore: async () => ({ ok: true, warning: "archive unavailable" }) });
		panel.handleInput("\r");
		await flush();
		assert.deepEqual(calls.done, { restored: sampleEntries()[0], warning: "archive unavailable" });
	});

	it("surfaces a clipboard-write failure in place and stays open", async () => {
		const { panel, calls } = rig({ onRestore: async () => ({ ok: false, error: "pbcopy exploded" }) });
		panel.handleInput("\r");
		await flush();
		assert.equal(calls.done, undefined);
		assert.match(panel.render(80).join("\n"), /Restore failed: pbcopy exploded/);
	});

	it("fences a late preview by selection generation", async () => {
		const pending = new Map<string, (entry: ClipboardEntry) => void>();
		const entries = sampleEntries();
		const { panel } = rig({
			onPreview: (entry) =>
				new Promise<ClipboardEntry>((resolve) => {
					pending.set(entry.id, resolve);
				}),
		}, 20, entries);
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		const last = at(entries, 2);
		pending.get(last.id)?.(last);
		await flush();
		pending.get(at(entries, 0).id)?.(makeEntry("STALE PREVIEW", undefined, new Date(), "66666666-6666-4666-8666-666666666666"));
		await flush();
		const text = panel.render(80).join("\n");
		assert.match(text, /oldest copy/);
		assert.doesNotMatch(text, /STALE PREVIEW/);
	});

	it("renders repeated identical frames from cache until state changes", () => {
		const { panel } = rig();
		const first = panel.render(80);
		assert.equal(panel.render(80), first);
		panel.handleInput("\x1b[B");
		assert.notEqual(panel.render(80), first);
	});
});
