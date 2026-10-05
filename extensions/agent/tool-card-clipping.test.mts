import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CustomMessageComponent, defineTool, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createAgentToolCards, renderAgentPeerMessage, type AgentCardContext } from "./tool-cards.ts";
import { fixtures, fixtureResult, rows } from "./tool-card-fixture.mts";

process.env.PI_TRUE_COLOR = "1";
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const themeModule = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const nativeTui = await import(requirePi.resolve("@earendil-works/pi-tui"));
const ui = { requestRender() {} } as unknown as TUI;
const plain = (line: string) => stripVTControlCharacters(line).trim();
const args = { action: "post", threadId: `thread-${"界é🙂".repeat(30)}`, message: `Call ${"界é🙂".repeat(60)}` };
const output = `Result ${"界é🙂".repeat(60)}`;

function nativeRow(name = "agent_collaborate", value: unknown = args): ToolExecutionComponent {
	const card = createAgentToolCards(() => rows)[name];
	const tool = defineTool({ name, label: name, description: "Renderer fixture", parameters: Type.Object({}), ...card, async execute() { throw new Error("Renderer fixtures must not execute."); } });
	const component = new ToolExecutionComponent(name, "fixture", value as Record<string, unknown>, undefined, tool, ui, ".");
	component.setArgsComplete();
	component.markExecutionStarted();
	return component;
}

function assertBackground(lines: string[], width: number, color: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg"): void {
	const background = themeModule.theme.getBgAnsi(color);
	assert.ok(background.startsWith("\x1b["), "the real theme paints the fixture");
	for (const line of lines.filter(Boolean)) {
		assert.ok(visibleWidth(line) <= width, `row exceeds ${width} columns: ${JSON.stringify(line)}`);
		assert.ok(line.startsWith(background), "Pi selects the outer background");
		assert.ok(line.endsWith("\x1b[49m"), "Pi closes the outer background");
		assert.doesNotMatch(line.slice(0, -5), /\x1b\[(?:0|49)?m/u, "content does not end Pi's background");
	}
}

function foregroundAt(line: string, index: number): string | undefined {
	let foreground: string | undefined;
	for (const match of line.slice(0, index).matchAll(/\x1b\[([\d;]*)m/gu)) {
		const codes = match[1];
		if (codes.startsWith("38;")) foreground = codes;
		else if (!codes.startsWith("48;") && codes.split(";").some((code) => ["", "0", "39"].includes(code))) foreground = undefined;
	}
	return foreground;
}

for (const themeName of ["dark", "light"] as const) {
	for (const rowName of ["metadata", "hint"] as const) it(`${themeName} clipped peer ${rowName} keeps muted through its ellipsis`, (t) => {
		initTheme(themeName, false);
		const previousKeys = nativeTui.getKeybindings();
		nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ ...nativeTui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
		t.after(() => nativeTui.setKeybindings(previousKeys));
		const modelId = `model-${"界é🙂".repeat(24)}`;
		const message = { role: "custom" as const, customType: "agent.peer", display: true, timestamp: 0, content: "First body line\nSecond body line\nThird body line\nFinal body line", details: { kind: "report", threadId: "source/thread", threadTitle: `Parser contract ${"界é🙂".repeat(24)}`, name: "Parser review", provider: "provider", modelId, thinkingLevel: "xhigh" } };
		const mutedAnsi = themeModule.theme.getFgAnsi("muted");
		const muted = foregroundAt(mutedAnsi, mutedAnsi.length);
		assert.ok(muted);
		for (const padding of [0, 1]) {
			const component = new CustomMessageComponent(message, renderAgentPeerMessage, undefined, padding);
			const wide = component.render(240);
			const wideFirst = wide.findIndex((line) => plain(line));
			assert.equal(plain(wide[wideFirst + 1]), `from Parser review · provider/${modelId} · xhigh`);
			assert.equal(wide.filter((line) => plain(line) === "... (ctrl+o to expand)").length, 1);
			const widths = [2, 3, 4, 5, 8, 16, 20];
			if (rowName === "metadata") widths.push(60);
			for (const width of widths) {
				const lines = component.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width), `${padding} padding at ${width} columns`);
				const first = lines.findIndex((line) => plain(line));
				const line = rowName === "metadata" ? lines[first + 1] : lines.at(-2);
				assert.ok(line);
				const ellipsis = line.lastIndexOf("…");
				assert.ok(ellipsis >= 0, `${rowName} clips at ${width} columns`);
				assert.doesNotMatch(line.slice(0, ellipsis), /\x1b\[(?:0|49)?m/u, "the clipped prefix does not reset the foreground or background");
				if (width - padding * 2 > 1) assert.equal(foregroundAt(line, ellipsis), muted, "the ellipsis retains muted when a styled prefix fits");
				assert.equal(foregroundAt(line, line.lastIndexOf("\x1b[49m")), undefined, "padding does not inherit the foreground");
			}
			component.setExpanded(true);
			assert.doesNotMatch(component.render(240).map(plain).join("\n"), /to expand/u);
		}
	});

	it(`${themeName} all native tool hints use muted without changing their text or count`, (t) => {
		initTheme(themeName, false);
		const previousKeys = nativeTui.getKeybindings();
		nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ ...nativeTui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
		t.after(() => nativeTui.setKeybindings(previousKeys));
		const mutedAnsi = themeModule.theme.getFgAnsi("muted");
		const muted = foregroundAt(mutedAnsi, mutedAnsi.length);
		assert.ok(muted);
		for (const [name, fixture] of Object.entries(fixtures)) {
			const component = nativeRow(name, fixture.args);
			component.updateResult({ ...fixtureResult(fixture.details), isError: false });
			for (const width of [80, 160, 240]) {
				const hints = component.render(width).filter((line) => plain(line) === "... (ctrl+o to expand)");
				assert.equal(hints.length, 1, `${name} has one native hint`);
				const line = hints[0];
				for (const text of ["...", "ctrl+o", "expand"]) assert.equal(foregroundAt(line, line.indexOf(text)), muted, `${name} hint uses muted at ${text}`);
			}
			component.setExpanded(true);
			assert.doesNotMatch(component.render(240).map(plain).join("\n"), /to expand/u);
		}
	});

	for (const state of ["pending", "success", "error"] as const) it(`${themeName} clipped call and result rows preserve the ${state} background and foreground`, () => {
		initTheme(themeName, false);
		const component = nativeRow();
		assertBackground(component.render(40), 40, "toolPendingBg");
		component.updateResult({ content: [{ type: "text", text: output }], isError: state === "error" }, state === "pending");
		const color = state === "pending" ? "toolPendingBg" : state === "error" ? "toolErrorBg" : "toolSuccessBg";
		for (const width of [2, 3, 4, 5, 8, 16, 40, 80, 160]) {
			const lines = component.render(width);
			assertBackground(lines, width, color);
			assert.ok(lines.some((line) => plain(line).endsWith("…")), "clipped content uses the preview ellipsis");
			if (width >= 40) {
				for (const prefix of ["Call", "Result"]) {
					const line = lines.find((value) => plain(value).startsWith(prefix));
					assert.ok(line);
					const ellipsis = line.lastIndexOf("…");
					assert.ok(ellipsis > 0);
					assert.ok(foregroundAt(line, ellipsis), "the ellipsis retains a foreground");
					assert.equal(foregroundAt(line, ellipsis), foregroundAt(line, line.indexOf(prefix) + prefix.length));
					assert.equal(foregroundAt(line, line.lastIndexOf("\x1b[49m")), undefined, "padding does not inherit the foreground");
				}
			}
		}
	});

	it(`${themeName} expanded cards retain complete source and wrap without a background reset`, (t) => {
		initTheme(themeName, false);
		const previousKeys = nativeTui.getKeybindings();
		nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ ...nativeTui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
		t.after(() => nativeTui.setKeybindings(previousKeys));
		const component = nativeRow();
		component.updateResult({ content: [{ type: "text", text: output }], isError: false });
		const collapsed = component.render(80);
		assert.equal(collapsed.filter((line) => plain(line) === "... (ctrl+o to expand)").length, 1, "the native expansion hint is unchanged");
		component.setExpanded(true);
		const wide = component.render(1000).map(plain).join("\n");
		assert.ok(wide.includes(args.message));
		assert.ok(wide.includes(args.threadId));
		assert.ok(wide.includes(output));
		assert.doesNotMatch(wide, /to expand/u);
		for (const width of [3, 8, 40, 80, 160]) assertBackground(component.render(width), width, "toolSuccessBg");
		component.setExpanded(false);
		assert.deepEqual(component.render(80), collapsed, "expansion does not change the collapsed source");
	});

	it(`${themeName} all agent tool renderers preserve Pi backgrounds at narrow and full widths`, () => {
		initTheme(themeName, false);
		for (const [name, fixture] of Object.entries(fixtures)) {
			const component = nativeRow(name, fixture.args);
			component.updateResult({ ...fixtureResult(fixture.details), isError: false });
			for (const width of [2, 8, 40, 160, 240]) assertBackground(component.render(width), width, "toolSuccessBg");
		}
	});
}

it("collapsed clipping uses Pi's grapheme width and leaves exact-fit and zero-width source intact", () => {
	initTheme("dark", false);
	const card = createAgentToolCards(() => []).agent_status;
	const context: AgentCardContext = { expanded: false };
	for (const identity of ["ascii-identity", "界界界", "ééé", "🙂🙂🙂", "🇺🇸🇨🇦🇯🇵"]) {
		const component = card.renderCall({ sessionId: identity }, themeModule.theme, context);
		const source = component.render(240)[0];
		assert.ok(plain(source).includes(identity));
		assert.deepEqual(component.render(0), [""]);
		assert.deepEqual(component.render(-1), [""]);
		assert.equal(component.render(visibleWidth(source))[0], source);
		for (const width of [1, 2, 3, 4, 8, 16]) {
			const line = component.render(width)[0];
			assert.ok(visibleWidth(line) <= width);
			assert.equal(stripVTControlCharacters(line), stripVTControlCharacters(truncateToWidth(source, width, "…")));
			assert.doesNotMatch(line, /\x1b\[(?:0|49)?m/u);
		}
	}
});
