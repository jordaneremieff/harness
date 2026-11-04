import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { dashboardGeometry, dashboardHeading } from "./dashboard-layout.ts";
import { fixture, row, source, theme, turn } from "./dashboard-test-fixture.mts";
import { agentState, updateDraft } from "./dashboard-state.ts";

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

it("console header keeps identity and state without activity", async () => {
	const observed = source([row("one", { name: "Selected recipient", state: "working", currentTool: { name: "read", argument: JSON.stringify({ path: `/${"long-path/".repeat(40)}` }) } })]);
	const f = fixture(60, 20, observed);
	try {
		await turn();
		f.ui.handleInput("\r");
		const lines = f.ui.render(60).map(stripVTControlCharacters);
		assert.match(lines[1], /Selected recipient/);
		assert.match(lines[1], /● Working/);
		assert.doesNotMatch(lines[1], /read|long-path|…/);
		assert.equal(visibleWidth(lines[1]), 60);
	} finally { f.ui.dispose(); }
});

it("each surface occupies the exact terminal rectangle and keeps Esc last", async () => {
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
			for (const key of ["", "\t", "\x1b", "\r", "\x1b", "a", "\x1b", "?", "\x1b", "/", "\x1b", "n"]) {
				if (key) f.ui.handleInput(key);
				const lines = f.ui.render(width);
				assert.equal(lines.length, height, key);
				assert.ok(
					lines.every((line) => visibleWidth(line) <= width),
					key,
				);
				assert.match(lines.at(-1) ?? "", /Esc/);
			}
			f.ui.handleInput("first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh\neighth");
			const lines = f.ui.render(width);
			assert.equal(lines.length, height);
			assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
		} finally {
			f.ui.dispose();
		}
	}
});
for (const width of [60, 80]) for (const height of [20, 21]) for (const mode of ["roster", "find", "message", "console"] as const) for (const notice of [false, true]) {
	it(`compact failed conversations retain warnings, draft, status and mouse targets at ${width}x${height} in ${mode}, notice ${notice}`, async () => {
		const observed = source([row("one", { state: "failed", error: "quota limit" })]);
		observed.availability = () => ({ state: "unavailable", at: new Date(0).toISOString() });
		const f = fixture(width, height, observed);
		try {
			await turn();
			const state = agentState(f.state, "one");
			const draft = Array.from({ length: 10 }, (_, index) => `draft ${index}`).join("\n");
			updateDraft(state, draft);
			if (mode === "find") f.ui.handleInput("/");
			if (mode === "message") f.ui.handleInput("\t");
			if (mode === "console") f.ui.handleInput("\r");
			if (notice) Reflect.set(f.ui, "notice", "Layout could not be saved");
			f.ui.focused = true;
			const lines = f.ui.render(width);
			const plain = lines.map(stripVTControlCharacters);
			assert.equal(lines.length, height, `${width}x${height} ${mode}`);
			if (mode === "find" && height === 20 && notice) assert.doesNotMatch(plain.join("\n"), /Preferences:/u);
			else if (mode !== "console") assert.match(plain.join("\n"), /Preferences: absent/u);
			assert.ok(plain.every((line) => visibleWidth(line) === width));
			assert.match(plain.join("\n"), /quota limit/);
			assert.match(plain.join("\n"), /Conversation unavailable; stored messages shown/);
			if (notice) assert.match(plain.join("\n"), /Layout could not be saved/);
			assert.match(plain.at(-3) ?? "", /model │ ~\$0.42/);
			assert.match(plain.at(-2) ?? "", /\/work/);
			assert.match(plain.at(-1) ?? "", /Esc/);
			const click = (y: number, x = 2) => f.ui.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, clickCount: 1 });
			for (const y of [height - 3, height - 2]) assert.equal(click(y), undefined, "status rows are not editor targets");
			const top = plain.findIndex((line, index) => index > 0 && line.startsWith("╭─"));
			assert.ok(top >= 0, mode);
			assert.equal(click(top + 1)?.focus, true, "visible draft rows target the native editor");
			const updated = f.ui.render(width);
			assert.equal(updated.length, height);
			assert.ok(updated.some((line) => line.includes(CURSOR_MARKER)));
			assert.equal(state.draft, draft);
			const hint = stripVTControlCharacters(updated.at(-1) ?? "");
			assert.equal(click(height - 1, hint.indexOf("Esc"))?.handled, true, "footer hint stays clickable");
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
it("a roster heading labels incomplete loaded coverage rather than a global total", async () => {
	const observed = source([row()]);
	const list = observed.list;
	observed.list = async (input) => {
		const page = await list(input);
		return { ...page, coverage: { ...page.coverage, complete: false, nextCursor: "more" } };
	};
	const f = fixture(100, 30, observed);
	try {
		await turn();
		const header = f.ui.render(100)[0] ?? "";
		assert.doesNotMatch(header, /retained|\$/);
		assert.match(header, /1\/1\+ ╮$/);
	} finally {
		f.ui.dispose();
	}
});
