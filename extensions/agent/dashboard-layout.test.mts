import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { dashboardGeometry, dashboardHeading } from "./dashboard-layout.ts";
import { fixture, row, source, theme, turn } from "./dashboard-test-fixture.mts";
import { agentState, updateDraft } from "./dashboard-state.ts";

/** Visible text: styling and the zero-width cursor markers removed, so columns match the screen. */
const visible = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));

it("the roster stays narrow and owns the full body beside the conversation", () => {
	for (const [width, expected] of [[100, 30], [120, 30], [164, 36], [240, 40]]) {
		const geometry = dashboardGeometry(width, 44, 3);
		assert.equal(geometry.rosterWidth, expected);
		assert.equal(geometry.wide, true);
		assert.equal(geometry.paneHeight, 42);
		assert.equal(geometry.rosterWidth + geometry.conversationWidth + 1, width);
	}
	assert.equal(dashboardGeometry(99, 30, 3).wide, false);
	assert.equal(dashboardGeometry(164, 44, 3, true).conversationWidth, 164);
});

it("the target header keeps identity and state without activity", async () => {
	const observed = source([row("one", { name: "Selected recipient", state: "working", currentTool: { name: "read", argument: JSON.stringify({ path: `/${"long-path/".repeat(40)}` }) } })]);
	const f = fixture(60, 20, observed);
	try {
		await turn();
		await turn();
		f.ui.handleInput("\r");
		const lines = visible(f.ui.render(60));
		const header = lines.find((line) => line.includes("● Working") && line.includes("More…")) ?? "";
		assert.match(header, /Selected recipient/);
		assert.doesNotMatch(header, /read|long-path/);
		assert.equal(visibleWidth(header), 60);
	} finally { f.ui.dispose(); }
});

it("every view occupies the exact terminal rectangle and keeps the way out at the top right", async () => {
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
				assert.match(stripVTControlCharacters(lines[0] ?? ""), /Close\s*$/, `step ${index}`);
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
for (const width of [60, 80]) for (const height of [20, 21]) for (const focus of ["list", "composer", "conversation", "controls"] as const) for (const notice of [false, true]) {
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
			if (focus === "controls") for (let step = 0; step < 3; step++) f.ui.handleInput("\t");
			assert.equal(f.ui.focus.region, focus);
			if (notice) f.ui.notify("Layout could not be saved", "warning");
			f.ui.focused = true;
			const lines = f.ui.render(width);
			const plain = visible(lines);
			assert.equal(lines.length, height, `${width}x${height} ${focus}`);
			assert.ok(plain.every((line) => visibleWidth(line) === width));
			const text = plain.join("\n");
			assert.match(text, /quota limit/);
			assert.match(text, /Not connected; stored messages shown/);
			if (notice) assert.match(text, /Layout could not be saved/);
			const statusY = plain.findIndex((line) => /model │ ~\$0\.42/.test(line));
			assert.ok(statusY > 0, "the model and cost line stays visible");
			assert.match(plain[statusY + 1] ?? "", /\/work/);
			assert.match(plain[0] ?? "", /Close\s*$/);
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
			assert.equal(click(0, heading.lastIndexOf("Close"))?.handled, true, "the way out stays clickable");
			assert.equal(f.counts().closes, 1);
		} finally { f.ui.dispose(); }
	});
}
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
