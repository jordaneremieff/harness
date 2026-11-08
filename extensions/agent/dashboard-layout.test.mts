import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { dashboardGeometry, dashboardHeading, fitLine, LIST_BLOCK_ROWS, listBlock, readingGeometry } from "./dashboard-layout.ts";
import { fixture, row, source, theme, turn } from "./dashboard-test-fixture.mts";
import { agentState, updateDraft } from "./dashboard-state.ts";

/** Visible text: styling and the zero-width cursor markers removed, so columns match the screen. */
const visible = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));

it("line fitting preserves truncation and padding for styled and Unicode text", () => {
	const hyperlink = "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\";
	const cases: Array<[string, number[]]> = [
		["\x1b[31mstyled row\x1b[0m", [0, 1, 5, 10, 15]],
		[`${hyperlink}${CURSOR_MARKER}`, [0, 1, 3, 4, 8]],
		["界e\u0301🙂", [0, 1, 2, 4, 5, 8]],
		["a\tb", [0, 1, 4, 5, 8]],
		["x".repeat(4097), [0, 1, 80]],
	];
	for (const [text, widths] of cases) for (const width of widths) {
		const value = truncateToWidth(text, Math.max(1, width), "…");
		assert.equal(fitLine(text, width), value + " ".repeat(Math.max(0, width - visibleWidth(value))), `width ${width}, length ${text.length}`);
	}
});

it("the roster keeps its share of the window and the conversation keeps the body", () => {
	for (const [width, expected] of [[100, 32], [120, 32], [164, 44], [240, 60]]) {
		const geometry = dashboardGeometry(width, 44, 3);
		assert.equal(geometry.rosterWidth, expected);
		assert.equal(geometry.wide, true);
		assert.equal(geometry.paneHeight, 43);
		assert.equal(geometry.rosterWidth + geometry.conversationWidth + 1, width);
	}
	assert.equal(dashboardGeometry(99, 30, 3).wide, false);
	assert.equal(dashboardGeometry(164, 44, 3, true).conversationWidth, 164);
	assert.equal(dashboardGeometry(200, 56, 3, false, 0, 4, { rosterRatio: 0.2727 }).rosterWidth, 54);
	assert.equal(dashboardGeometry(100, 30, 3, false, 0, 4, { rosterRatio: 0.01 }).rosterWidth, 32);
});

it("reading geometry keeps a two-column margin and a 100-column text maximum", () => {
	for (const [paneWidth, textWidth] of [[159, 100], [89, 86], [80, 77], [60, 57]]) {
		assert.deepEqual(readingGeometry(paneWidth), { margin: 2, textWidth });
	}
	assert.deepEqual(readingGeometry(2), { margin: 2, textWidth: 1 });
});

/** The target header's state line: a divider or the row start, the state glyph, then the state label. */
const STATE_LINE = /(^|│) [◌●○✓!■↯·?] (Starting|Working|Idle|Done|Failed|Stopped|Interrupted|New|Unavailable)\b/u;

it("the target header keeps identity and state without activity", async () => {
	const observed = source([row("one", { name: "Selected recipient", state: "working", currentTool: { name: "read", argument: JSON.stringify({ path: `/${"long-path/".repeat(40)}` }) } })]);
	const f = fixture(60, 20, observed);
	try {
		await turn();
		await turn();
		f.ui.handleInput("\r");
		const lines = visible(f.ui.render(60));
		const state = lines.findIndex((line, index) => index > 0 && STATE_LINE.test(line));
		assert.ok(state > 0);
		const title = state - 1;
		assert.match(lines[title] ?? "", /Selected recipient/);
		assert.doesNotMatch(lines.slice(title, title + 2).join("\n"), /read|long-path/);
		assert.equal(visibleWidth(lines[title] ?? ""), 60);
	} finally { f.ui.dispose(); }
});

it("every view occupies the exact terminal rectangle and keeps the way out in the footer", async () => {
	for (const [width, height] of [
		[164, 44],
		[120, 40],
		[100, 30],
		[80, 24],
		[60, 20],
	]) {
		const f = fixture(
			width,
			height,
			source(Array.from({ length: 100 }, (_, index) => row(String(index), { name: "界🙂".repeat(60) }))),
		);
		try {
			await turn();
			await turn();
			const steps: Array<string | (() => void)> = ["", "\t", "\x1b", "\r", "\x1b", () => f.ui.openNamedAction("configure"), "\x1b", () => f.ui.openNamedAction("help"), "\x1b", "x", "\x1b", () => f.ui.openNamedAction("new")];
			for (const [index, step] of steps.entries()) {
				if (typeof step === "function") step();
				else if (step) f.ui.handleInput(step);
				await turn();
				const lines = f.ui.render(width);
				assert.equal(lines.length, height, `step ${index}`);
				assert.ok(lines.every((line) => visibleWidth(line) <= width), `step ${index}`);
				assert.doesNotMatch(stripVTControlCharacters(lines[0] ?? ""), /Close/u, `step ${index}: the header holds no commands`);
				assert.match(stripVTControlCharacters(lines.at(-1) ?? "").trimEnd(), /(^|· )esc [^·]+$/u, `step ${index}: the way out is the last footer control`);
			}
			f.ui.handleInput("first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh\neighth");
			const lines = f.ui.render(width);
			assert.equal(lines.length, height);
			assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)), "the New conversation purpose holds the cursor");
		} finally {
			f.ui.dispose();
		}
	}
});
for (const width of [60, 80]) for (const height of [20, 21]) for (const focus of ["list", "composer", "conversation"] as const) for (const notice of [false, true]) {
	it(`compact failed conversations keep warnings, draft, status and targets at ${width}x${height} from the ${focus}, notice ${notice}`, async () => {
		const observed = source([row("one", { state: "failed", error: "quota limit" })]);
		observed.availability = () => ({ state: "unavailable", at: new Date(0).toISOString() });
		const f = fixture(width, height, observed);
		try {
			await turn();
			await turn();
			const state = agentState(f.state, "one");
			const draft = Array.from({ length: 10 }, (_, index) => `draft ${index}`).join("\n");
			updateDraft(state, draft);
			if (focus === "composer") f.ui.handleInput("\r");
			if (focus === "conversation") f.ui.handleInput("\t");
			assert.equal(f.ui.focus.region, focus);
			if (notice) f.ui.notify("Layout could not be saved", "warning");
			f.ui.focused = true;
			const lines = f.ui.render(width);
			const plain = visible(lines);
			assert.equal(lines.length, height, `${width}x${height} ${focus}`);
			assert.ok(plain.every((line) => visibleWidth(line) === width));
			const text = plain.join("\n");
			assert.match((plain.at(-1) ?? "").trimEnd(), /esc (list|close|cancel)$/u, "the way out is the last footer control");
			if (notice) {
				assert.match(text, /Layout could not be saved/);
				assert.doesNotMatch(plain[1] ?? "", /quota limit/, "the notice takes the header line");
			} else {
				assert.match(text, /quota limit · A new message runs the work again/, "the header states the reason and the way forward");
				assert.doesNotMatch(text, /Not connected/, "the reason takes the line the connection warning would use");
			}
			const statusY = plain.findIndex((line) => /model │ ~\$0\.42/.test(line));
			assert.ok(statusY > 0, "the model and cost line stays visible");
			assert.match(plain[statusY + 1] ?? "", /\/work/);
			assert.doesNotMatch(plain[0] ?? "", /Close/u, "the header holds no commands");
			const click = (y: number, x = 2) => f.ui.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, clickCount: 1 });
			for (const y of [statusY, statusY + 1]) assert.equal(click(y), undefined, "status rows are not editor targets");
			const top = plain.findIndex((line, index) => index > 0 && line.startsWith("╭─"));
			assert.ok(top >= 0, focus);
			assert.ok(plain.some((line, index) => index > top && line.startsWith("╰─")), "the message field keeps its bottom border and controls");
			assert.equal(click(top + 1)?.focus, true, "visible draft rows target the native editor");
			assert.equal(f.ui.focus.region, "composer");
			const updated = f.ui.render(width);
			assert.equal(updated.length, height);
			assert.ok(updated.some((line) => line.includes(CURSOR_MARKER)));
			assert.equal(state.draft, draft);
			const heading = visible(updated)[0] ?? "";
			assert.doesNotMatch(heading, /Close/u, "the header holds no commands");
			const composerFooter = visible(updated).at(-1) ?? "";
			assert.equal(click(height - 1, composerFooter.lastIndexOf("esc") + 1)?.handled, true, "the way out stays clickable");
			assert.equal(f.ui.focus.region, "list", "the composer's Escape returns to the list");
			const listFooter = visible(f.ui.render(width)).at(-1) ?? "";
			assert.equal(click(height - 1, listFooter.lastIndexOf("esc") + 1)?.handled, true, "the list's way out stays clickable");
			assert.equal(f.counts().closes, 1);
		} finally { f.ui.dispose(); }
	});
}
it("narrow strips preserve the composer, two status lines and two conversation rows above the key footer", async () => {
	for (const [width, height, stripRows, visibleAgents] of [[80, 25, 8, 2], [60, 21, 5, 1]] as const) {
		const f = fixture(width, height, source([row("one", { modifiedAt: 3 }), row("two", { modifiedAt: 2 }), row("three", { modifiedAt: 1 })]));
		try {
			await turn();
			await turn();
			const plain = visible(f.ui.render(width));
			const state = plain.findIndex((line, index) => index > 0 && STATE_LINE.test(line));
			assert.ok(state > 0);
			const title = state - 1;
			assert.equal(title - 1, stripRows, `${width}x${height} list strip`);
			const strip = plain.slice(1, title).join("\n");
			assert.match(strip, /one/);
			assert.equal(strip.includes("two"), visibleAgents === 2);
			assert.doesNotMatch(strip, /three/);
			assert.match(strip, /more|\d agents/);
			const composerTop = plain.findIndex((line) => line.startsWith("╭─ To "));
			const composerBottom = plain.findIndex((line) => line.startsWith("╰─"));
			assert.ok(composerTop - title - 3 >= 2, "at least two conversation rows remain");
			assert.ok(composerBottom > composerTop);
			assert.match(plain[composerBottom + 1] ?? "", /model │/);
			assert.match(plain[composerBottom + 2] ?? "", /\/work/);
		} finally { f.ui.dispose(); }
	}
});

const painted = {
	...theme,
	fg: (color: string, text: string) => `\x1b[${color === "accent" ? 36 : color === "muted" ? 90 : 37}m${text}\x1b[39m`,
	bg: (color: string, text: string) => `\x1b[${color === "customMessageBg" ? 45 : 44}m${text}\x1b[49m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Theme;

it("framed headings reserve the visible right-side position before a long title", () => {
	for (const width of [20, 60, 80, 140]) {
		const heading = dashboardHeading(`Agents > ${"界".repeat(200)}`, "2/9+", width, painted);
		assert.equal(visibleWidth(heading), width);
		const plain = stripVTControlCharacters(heading);
		assert.ok(plain.startsWith("╭─ "));
		assert.ok(plain.endsWith(" 2/9+ ╮"));
		assert.match(heading, /\x1b\[36m/);
	}
});
it("framed headings keep multiline metadata within one physical row", () => {
	for (const width of [60, 90, 120]) {
		for (const separator of ["\n", "\r\n", "\r", "\t", "\u2028", "\u2029"]) {
			const heading = dashboardHeading(`Agents > Threads > First${separator}Second`, "Frame 1", width, painted);
			const plain = stripVTControlCharacters(heading);
			assert.doesNotMatch(plain, /[\r\n\t\u2028\u2029]/);
			assert.match(plain, /First Second/);
			assert.ok(plain.endsWith(" Frame 1 ╮"));
			assert.equal(visibleWidth(heading), width);
		}
	}
});
it("the list labels incomplete loaded coverage rather than a global total", async () => {
	const observed = source([row()]);
	const list = observed.list;
	observed.list = async (input) => {
		const page = await list(input);
		return { ...page, coverage: { ...page.coverage, complete: false, nextCursor: "more" } };
	};
	const f = fixture(100, 30, observed);
	try {
		await turn();
		await turn();
		const lines = visible(f.ui.render(100));
		assert.doesNotMatch(lines[0] ?? "", /retained|\$|\d+\/\d+/, "the heading claims no total");
		const listX = lines[1]?.indexOf("│") ?? 0;
		assert.match(lines.map((line) => line.slice(0, listX)).join("\n"), /Load more/);
	} finally {
		f.ui.dispose();
	}
});

it("a list block keeps a short title on one row, then its detail, then a gap", () => {
	const block = listBlock({ title: "Recipient", glyph: "●", glyphColor: "accent", detail: "model high · $0.42", time: "5m ago", selected: false }, 40, painted);
	assert.equal(block.lines.length, LIST_BLOCK_ROWS);
	const plain = visible(block.lines);
	assert.match(plain[0] ?? "", /^ {2}● Recipient +5m ago$/u);
	assert.equal(plain[1]?.trim(), "model high · $0.42");
	assert.equal(plain[2]?.trim(), "", "a blank gap row follows a title that fits");
	assert.equal(block.timeLine, 0);
	assert.equal(block.timeWidth, visibleWidth("5m ago"));
	assert.ok(block.lines.every((line) => visibleWidth(line) === 40));
});

it("a long list title continues on the second row and the detail moves to the third", () => {
	const title = "A very long agent name that does not fit in one list row";
	const block = listBlock({ title, glyph: "○", glyphColor: "muted", detail: "model high", time: "5m ago", selected: false }, 32, painted);
	assert.equal(block.lines.length, LIST_BLOCK_ROWS);
	const plain = visible(block.lines);
	assert.match(plain[0] ?? "", /^ {2}○ A very long agent +5m ago$/u);
	assert.match(plain[1] ?? "", /^ {4}name that does not fit in/u, "the title continues on the second row");
	assert.match(plain[2] ?? "", /^ {4}model high/u);
	assert.equal(block.timeLine, 0);
	assert.ok(block.lines.every((line) => visibleWidth(line) === 32));
});

it("timeOnDetail moves the time to the right of the detail row", () => {
	const stamp = "Oct 3, 2026, 1:24 PM";
	const block = listBlock({ title: "Recipient", glyph: "✓", glyphColor: "success", detail: "model high", time: stamp, timeOnDetail: true, selected: false }, 44, painted);
	assert.equal(block.lines.length, LIST_BLOCK_ROWS);
	const plain = visible(block.lines);
	assert.doesNotMatch(plain[0] ?? "", /Oct 3/u);
	assert.match(plain[1] ?? "", /Oct 3, 2026, 1:24 PM/u);
	assert.equal(block.timeLine, 1);
	assert.equal(block.timeX, 44 - visibleWidth(stamp));
	assert.equal(plain[2]?.trim(), "");
});

it("the selection background covers content rows and leaves the blank row plain", () => {
	const block = listBlock({ title: "Recipient", glyph: "●", glyphColor: "accent", detail: "model high", selected: true }, 30, painted);
	assert.equal(block.lines.length, LIST_BLOCK_ROWS);
	for (const line of block.lines.slice(0, 2)) {
		assert.ok(line.includes("\x1b[44m"), "a content row carries the selection background");
		assert.ok(line.startsWith("\x1b[36m▌ "), "the rail keeps the pane colour");
	}
	assert.equal(block.lines[2]?.includes("\x1b[44m"), false, "the blank row stays plain");
	assert.ok(block.lines.every((line) => visibleWidth(line) === 30));
});

it("a saved or dragged list width stays between 32 and 60 columns", () => {
	assert.equal(dashboardGeometry(100, 44, 3).rosterWidth, 32);
	assert.equal(dashboardGeometry(400, 44, 3, false, 0, 4, { rosterRatio: 0.9 }).rosterWidth, 60);
	assert.equal(dashboardGeometry(164, 44, 3, false, 0, 4, { rosterRatio: 0.9 }).rosterWidth, 60);
	assert.equal(dashboardGeometry(100, 44, 3, false, 0, 4, { rosterRatio: 0.001 }).rosterWidth, 32);
});
