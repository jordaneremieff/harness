import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { StatusPanel, statusEntries, statusText } from "./statuses.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const strip = (text: string) => text.replace(/\x1b\[[0-9;:]*m/g, "");

function click(x: number, y: number, width: number): TuiMouseEvent {
	return { type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: 20, shift: false, alt: false, ctrl: false };
}

function wheel(delta: number, width: number): TuiMouseEvent {
	return { ...click(0, 5, width), type: "wheel", button: "none" as TuiMouseEvent["button"], wheelDelta: delta };
}

describe("status reader text", () => {
	it("keeps values opaque: sequences removed, controls spaced, nothing parsed", () => {
		assert.equal(statusText("\x1b[31mworkers 3\x1b[0m · $1.23\n\x1b]0;title\x07next"), "workers 3 · $1.23 next");
		assert.deepEqual(statusEntries(new Map([["agent", "idle"], ["", ""]])), [
			{ key: "agent", value: "idle" },
			{ key: "(unnamed)", value: "(empty)" },
		]);
	});
});

describe("StatusPanel", () => {
	function makePanel(map: Map<string, string>, rows = 20) {
		let reads = 0;
		let closed = 0;
		const panel = new StatusPanel({
			theme,
			rows: () => rows,
			read: () => {
				reads += 1;
				return map;
			},
			done: () => {
				closed += 1;
			},
		});
		return { panel, reads: () => reads, closed: () => closed };
	}

	it("labels every value with its owner key and wraps long values", () => {
		const long = "x".repeat(70);
		const { panel } = makePanel(new Map([["jobs", "1 running"], ["agent", long]]));
		const lines = panel.render(40).map(strip);
		assert.match(lines[0], /^Extension statuses 2 entries/);
		assert.equal(lines[1].trim(), "[Close]  [Refresh]");
		assert.ok(lines.includes("jobs") && lines.includes("  1 running"));
		assert.ok(lines.includes("agent"));
		assert.ok(lines.filter((line) => line.startsWith("  xxx")).length >= 2, "long value wraps instead of truncating");
		for (const line of panel.render(40)) assert.ok(strip(line).length <= 40);
	});

	it("closes and refreshes from the buttons and ignores stale geometry", () => {
		const map = new Map([["agent", "first"]]);
		const { panel, reads, closed } = makePanel(map);
		const lines = panel.render(60).map(strip);
		const closeX = lines[1].indexOf("[Close]");
		const refreshX = lines[1].indexOf("[Refresh]");
		assert.equal(panel.handleMouse(click(refreshX, 1, 61)), undefined, "another width is ignored");
		map.set("agent", "second");
		assert.equal(panel.handleMouse(click(refreshX, 1, 60))?.handled, true);
		assert.equal(reads(), 2, "refresh re-reads the map");
		assert.ok(panel.render(60).map(strip).includes("  second"));
		assert.equal(panel.handleMouse(click(closeX, 1, 60))?.handled, true);
		assert.equal(closed(), 1);
		assert.deepEqual(panel.render(60), [], "a closed panel renders nothing");
	});

	it("scrolls with the wheel and keys within bounds and closes on Escape", () => {
		const map = new Map(Array.from({ length: 30 }, (_, i) => [`key-${i}`, `value ${i}`] as const));
		const { panel, closed } = makePanel(map, 12);
		const first = panel.render(50).map(strip);
		assert.ok(first.includes("key-0"));
		assert.equal(panel.handleMouse(wheel(5, 50))?.handled, true);
		const scrolled = panel.render(50).map(strip);
		assert.ok(!scrolled.includes("key-0"), "wheel moved the window");
		panel.handleInput("\x1b[5~");
		panel.handleInput("\x1b[5~");
		assert.ok(panel.render(50).map(strip).includes("key-0"), "page up returns to the top and clamps");
		panel.handleInput("\x1b");
		assert.equal(closed(), 1);
	});
});
