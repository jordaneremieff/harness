import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { dashboardHeading, fitHints } from "./dashboard-layout.ts";
import { DashboardMouse, mouseHints } from "./dashboard-mouse.ts";
import { fixture, row, source, theme, turn } from "./dashboard-test-fixture.mts";

it("each surface occupies the exact terminal rectangle and keeps Esc last", async () => {
	for (const [width, height] of [
		[140, 45],
		[80, 24],
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
	assert.match(fitHints(["one", "two", "three"], "Esc back", 12), /Esc back/);
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
it("tinted hint bars decorate keys after hit geometry and preserve the escape destination", () => {
	const regions: Array<[string, number, number]> = [];
	const line = fitHints(["Enter open", "r refresh"], "Esc back", 25, (...area) => regions.push(area), painted);
	assert.equal(visibleWidth(line), 25);
	assert.equal(stripVTControlCharacters(line).trim(), "Enter open · Esc back");
	assert.deepEqual(regions, [
		["Enter open", 0, 10],
		["Esc back", 13, 8],
	]);
	assert.match(line, /\x1b\[45m/);
	assert.match(line, /\x1b\[36mEnter\x1b\[39m/);
	assert.match(line, /\x1b\[90m open/);
	const mouse = new DashboardMouse();
	const keys: string[] = [];
	mouse.reset(80, 24);
	const hints = mouseHints(mouse, 23, ["↑↓ select", "Enter open"], "Esc back", 80, (key) => keys.push(key), painted);
	const x = stripVTControlCharacters(hints).indexOf("Enter");
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
	it(`conversation end, status and composer form one ordered bottom region at ${width}`, async () => {
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
			const lines = render();
			const boundary = lines.findIndex((line) => line.startsWith("─ Lines "));
			assert.ok(boundary > 1);
			assert.equal(lines[boundary - 1]?.trim(), "");
			assert.match(lines[boundary] ?? "", /of \d+ loaded.*End of loaded view/);
			assert.match(lines[boundary + 1] ?? "", /RETAINED.*partial history/);
			assert.match(lines[boundary + 2] ?? "", /\$0\.42.*idle/);
			assert.match(lines[boundary + 3] ?? "", /^╭─ Message to Recipient/);
			assert.match(lines[boundary + 4] ?? "", /^│.*│$/);
			assert.ok(lines.at(-2)?.startsWith("╰"));
			assert.equal(lines.filter((line) => line.includes("RETAINED")).length, 1);
			assert.equal(lines.filter((line) => line.includes("Message to Recipient")).length, 1);
			f.ui.handleInput("\x1b[5~");
			assert.doesNotMatch(render().find((line) => line.startsWith("─ Lines ")) ?? "", /End of loaded view/);
			const state = f.state.agents.get("one");
			assert.ok(state);
			state.receipt = "Delivery receipt";
			const updated = render();
			const receipt = updated.findIndex((line) => line.includes("Delivery receipt"));
			assert.ok(receipt > 0);
			assert.ok(updated[receipt + 1]?.startsWith("╭─ Message to"));
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
			assert.match(lines.at(-1) ?? "", /\x1b\[45m/);
			assert.match(stripVTControlCharacters(lines.at(-1) ?? ""), /Esc /);
			return lines.map(stripVTControlCharacters);
		};
		try {
			await turn();
			const roster = render();
			assert.match(roster[0] ?? "", /1\/2 ╮$/);
			assert.match(roster.join("\n"), /› [○●] /);
			assert.match(roster.join("\n"), /Updated /);
			f.ui.handleInput("\x1b[B");
			assert.match(render()[0] ?? "", /2\/2 ╮$/);
			f.ui.handleInput("\r");
			assert.match(render()[0] ?? "", /Agents > /);
			f.ui.handleInput("\x1b");
			f.ui.handleInput("a");
			assert.match(render()[0] ?? "", /1\/\d+ actions ╮$/);
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
		assert.match(header, /loaded agents/);
		assert.match(header, /1\/1\+ ╮$/);
	} finally {
		f.ui.dispose();
	}
});
