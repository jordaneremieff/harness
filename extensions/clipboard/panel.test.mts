/** Behavioral drive tests for ClipboardPanel with mocked I/O and real rendering. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ClipboardPanel, type RestoreOutcome } from "./panel.ts";
import { makeEntry, type ClipboardEntry } from "./store.ts";

const theme: never = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

function rig(
	entries: ClipboardEntry[],
	onRestore?: (entry: ClipboardEntry) => Promise<RestoreOutcome>,
	rows = 20,
	hasMore = false,
) {
	const calls = { renders: 0, restores: [] as ClipboardEntry[], done: undefined as unknown };
	const tui = { requestRender: () => calls.renders++ };
	const panel = new ClipboardPanel({
		entries,
		theme,
		tui,
		getMaxRows: () => rows,
		hasMore,
		done: (result) => {
			calls.done = result;
		},
		onRestore:
			onRestore ??
			(async (entry) => {
				calls.restores.push(entry);
				return { ok: true };
			}),
	});
	return { panel, calls };
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("ClipboardPanel", () => {
	it("renders newest-first in a full-width opaque frame", () => {
		const { panel } = rig(sampleEntries());
		const lines = panel.render(72);
		assert.match(lines.join("\n"), /Clipboard history\s+— 3 entries/);
		assert.match(lines.join("\n"), /› .*latest copy/);
		for (const line of lines) assert.equal(visibleWidth(line), 72, `line does not paint width: ${JSON.stringify(line)}`);
		assert.match(rig(sampleEntries(), undefined, 20, true).panel.render(72).join("\n"), /3\+ entries/);
	});

	it("moves selection with arrows and clamps at both ends", () => {
		const { panel } = rig(sampleEntries());
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		assert.match(panel.render(72).join("\n"), /› .*oldest copy/);
		panel.handleInput("\x1b[A");
		panel.handleInput("\x1b[A");
		panel.handleInput("\x1b[A");
		assert.match(panel.render(72).join("\n"), /› .*latest copy/);
	});

	it("filters live on printable input; escape clears then closes", () => {
		const { panel, calls } = rig(sampleEntries());
		panel.handleInput("o");
		panel.handleInput("l");
		panel.handleInput("d");
		assert.match(panel.render(72).join("\n"), /1 of 3 match/);
		assert.match(panel.render(72).join("\n"), /oldest copy/);
		panel.handleInput("\x1b");
		assert.match(panel.render(72).join("\n"), /3 entries/);
		assert.equal(calls.done, undefined);
		panel.handleInput("\x1b");
		assert.deepEqual(calls.done, {});
	});

	it("filters on Kitty CSI-u printable events", () => {
		// A terminal with the Kitty keyboard protocol sends CSI-u for every key,
		// so raw single-character handling loses all typed text there.
		const { panel } = rig(sampleEntries());
		for (const seq of ["\x1b[111u", "\x1b[108u", "\x1b[100u"]) panel.handleInput(seq);
		assert.match(panel.render(72).join("\n"), /1 of 3 match/);
		assert.match(panel.render(72).join("\n"), /oldest copy/);
	});

	it("scrolls the preview of a long entry with Right/Left", () => {
		const { panel } = rig(sampleEntries(), undefined, 16);
		panel.handleInput("\x1b[B");
		assert.match(panel.render(72).join("\n"), /line 1/);
		panel.handleInput("\x1b[C");
		assert.doesNotMatch(panel.render(72).join("\n"), /line 1\s/);
		assert.match(panel.render(72).join("\n"), /more/);
		panel.handleInput("\x1b[D");
		assert.match(panel.render(72).join("\n"), /line 1/);
	});

	it("restores the selected entry on enter and closes", async () => {
		const { panel, calls } = rig(sampleEntries());
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		await flush();
		assert.equal(calls.restores.length, 1);
		assert.equal(calls.restores[0].label, "long");
		assert.deepEqual(calls.done, { restored: calls.restores[0] });
	});

	it("closes as restored with a warning when only archival fails", async () => {
		const { panel, calls } = rig(sampleEntries(), async () => ({ ok: true, warning: "archive unavailable" }));
		panel.handleInput("\r");
		await flush();
		assert.deepEqual(calls.done, { restored: sampleEntries()[0], warning: "archive unavailable" });
	});

	it("surfaces clipboard-write failure in place and stays open", async () => {
		const { panel, calls } = rig(sampleEntries(), async () => ({ ok: false, error: "pbcopy exploded" }));
		panel.handleInput("\r");
		await flush();
		assert.equal(calls.done, undefined);
		assert.match(panel.render(72).join("\n"), /restore failed: pbcopy exploded/);
	});

	it("keeps the footer visible at tiny heights and repaints after height-only resize", () => {
		let rows = 10;
		const calls = { renders: 0 };
		const panel = new ClipboardPanel({
			entries: sampleEntries(),
			theme,
			tui: { requestRender: () => calls.renders++ },
			getMaxRows: () => rows,
			done: () => {},
			onRestore: async () => ({ ok: true }),
		});
		const tall = panel.render(38);
		assert.ok(tall.length <= 10);
		assert.match(tall.at(-1) ?? "", /esc|close/i);
		rows = 3;
		const tiny = panel.render(38);
		assert.notEqual(tiny, tall);
		assert.ok(tiny.length <= 3);
		assert.match(tiny.at(-1) ?? "", /esc|close/i);
		for (const line of tiny) assert.equal(visibleWidth(line), 38);
	});

	it("neutralizes controls in arbitrary labels and content", () => {
		const hostile = makeEntry("body\x1b[31mred\x1b[0m", "title\x1b]0;owned\x07", new Date(), "safe-id");
		const output = rig([hostile]).panel.render(60).join("\n");
		assert.ok(!output.includes("\x1b"));
		assert.match(output, /\\x1b/);
	});

	it("renders a keyboard-addressable empty state", () => {
		const { panel } = rig([]);
		const output = panel.render(60).join("\n");
		assert.match(output, /Clipboard history/);
		assert.match(output, /No clipboard history yet/);
		assert.match(output, /esc close/);
	});

	it("caches renders until state or terminal dimensions change", () => {
		const { panel } = rig(sampleEntries());
		const first = panel.render(72);
		assert.equal(panel.render(72), first);
		panel.handleInput("\x1b[B");
		assert.notEqual(panel.render(72), first);
	});
});
