import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { dashboardGeometry, dashboardHeading, fitHints } from "./dashboard-layout.ts";
import { DashboardMouse, mouseHints } from "./dashboard-mouse.ts";
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
				assert.match(lines.at(-1) ?? "", /esc/);
			}
			f.ui.handleInput("first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh\neighth");
			const lines = f.ui.render(width);
			assert.equal(lines.length, height);
			assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
		} finally {
			f.ui.dispose();
		}
	}
	assert.match(fitHints(["one", "two", "three"], "esc back", 12), /esc back/);
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
			assert.match(plain.at(-1) ?? "", /esc/);
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
			assert.equal(click(height - 1, hint.indexOf("esc"))?.handled, true, "footer hint stays clickable");
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
it("plain hint bars decorate keys after hit geometry and preserve the escape destination", () => {
	const regions: Array<[string, number, number]> = [];
	const line = fitHints(["enter open", "r refresh"], "esc back", 25, (...area) => regions.push(area), painted);
	assert.equal(visibleWidth(line), 25);
	assert.equal(stripVTControlCharacters(line).trim(), "enter open · esc back");
	assert.deepEqual(regions, [
		["enter open", 0, 10],
		["esc back", 13, 8],
	]);
	assert.doesNotMatch(line, /\x1b\[45m/);
	assert.match(line, /\x1b\[36menter\x1b\[39m/);
	assert.match(line, /\x1b\[90m open/);
	const mouse = new DashboardMouse();
	const keys: string[] = [];
	mouse.reset(80, 24);
	const hints = mouseHints(mouse, 23, ["↑↓ select", "enter open"], "esc back", 80, (key) => keys.push(key), painted);
	const x = stripVTControlCharacters(hints).indexOf("enter");
	mouse.handle({
		type: "click",
		button: "left",
		clickCount: 1,
		x,
		y: 23,
		screenX: x,
		screenY: 23,
		width: 80,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
	});
	assert.deepEqual(keys, ["\r"]);
});
for (const width of [80, 140]) {
	it(`selected header, scroll position and padded composer share a conversation pane at ${width}`, async () => {
		const observed = source([row("one", { name: "Recipient", state: "idle" })]);
		observed.snapshot = async () => ({
			entries: [
				{
					id: "1",
					kind: "pi.user",
					model: [
						{
							role: "user",
							content: Array.from({ length: 100 }, (_, index) => `Transcript ${index}`).join("\n"),
							timestamp: 0,
						},
					],
				},
			],
			partial: true,
			revision: "1",
			nextBefore: 1,
		});
		const f = fixture(width, 32, observed, undefined, undefined, painted);
		const render = () => f.ui.render(width).map(stripVTControlCharacters);
		try {
			await turn();
			const paneX = width >= 100 ? dashboardGeometry(width, 32, 3).rosterWidth + 1 : 0;
			const pane = () => render().map((line) => line.slice(paneX));
			const lines = pane();
			const model = lines.findIndex((line) => /^model │/.test(line));
			const composer = lines.findIndex((line) => line.includes("╭─ send"));
			assert.ok(model > composer);
			assert.doesNotMatch(lines[composer] ?? "", /ctx|\$|model/);
			assert.match(lines[model] ?? "", /~\$0\.42/);
			assert.match(lines[model + 1] ?? "", /\/work/);
			assert.equal(lines[composer - 1]?.trim(), "", "output has bottom padding");
			assert.match(lines[composer + 1] ?? "", /^│.*│$/);
			assert.match(lines.at(-4) ?? "", /^╰─+╯$/);
			assert.doesNotMatch(lines.join("\n"), /Lines \d|End of loaded view|Partial history/);
			assert.ok(lines.some((line) => line.endsWith("┃")), "long output has a scroll thumb");
			f.ui.handleInput("\x1b[5~");
			assert.match(pane().join("\n"), /↓ \d+ lines below/);
			const state = f.state.agents.get("one");
			assert.ok(state);
			state.receipt = "Delivery receipt";
			const updated = pane();
			assert.match(updated.at(-4) ?? "", /^╰─ Delivery receipt/);
			assert.equal(updated.length, 32);
		} finally {
			f.ui.dispose();
		}
	});
	it(`roster, console, actions and help share heading and hint hierarchy at ${width}`, async () => {
		const observed = source([
			row("one", { name: "Design", state: "idle" }),
			row("two", { name: "Review", state: "working" }),
		]);
		const f = fixture(width, 32, observed, undefined, undefined, painted);
		const render = () => {
			const lines = f.ui.render(width);
			assert.equal(lines.length, 32);
			assert.ok(lines.every((line) => visibleWidth(line) === width));
			assert.match(stripVTControlCharacters(lines[0] ?? ""), /^╭─ Agents/);
			assert.doesNotMatch(lines.at(-1) ?? "", /\x1b\[45m/);
			assert.match(stripVTControlCharacters(lines.at(-1) ?? ""), /esc /);
			return lines.map(stripVTControlCharacters);
		};
		try {
			await turn();
			const roster = render();
			assert.match(roster[0] ?? "", /1\/2 ╮$/);
			assert.match(roster.join("\n"), /▌ [○●] /);
			assert.match(roster.join("\n"), /d ago/);
			f.ui.handleInput("\x1b[B");
			assert.match(render()[0] ?? "", /2\/2 ╮$/);
			f.ui.handleInput("\r");
			assert.match(render()[0] ?? "", /Agents > /);
			f.ui.handleInput("\x1b");
			f.ui.handleInput("a");
			assert.match(render()[0] ?? "", /1\/\d+ actions ╮$/);
			assert.match(render().at(-1) ?? "", /^pgup\/pgdn read/);
			assert.match(f.ui.render(width).join("\n"), /\x1b\[44m/);
			f.ui.handleInput("\x1b");
			f.ui.handleInput("?");
			assert.match(render()[0] ?? "", /Agents > Help/);
			assert.match(f.ui.render(width).join("\n"), /\x1b\[36mDashboard/);
		} finally {
			f.ui.dispose();
		}
	});
}
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
