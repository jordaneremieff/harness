import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as Keys, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { AgentDashboard, type AgentInspectionOptions, type AgentObservationSources } from "./dashboard.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const keys = new Keys(TUI_KEYBINDINGS) as KeybindingsManager;
const identity = (text: string) => text;
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => `\x1b[1m${text}\x1b[22m`, underline: identity, italic: identity, strikethrough: identity } as Theme;
const prose = '# Result\n\nThe **parser** is correct.\n\n- Input passed.\n- Error passed.\n\n```ts\nconst result = "**literal**";\n```\n\n| Case | Result |\n| --- | --- |\n| Input | Passed |\n\nSafe\x1b[2J\x1b]52;c;hostile\x07 text\u202e.';
function fixture() {
	const calls: AgentInspectionOptions[] = [];
	const sources: AgentObservationSources = {
		sessions: async () => [{ sessionId: "session", name: "Parser", cwd: "/work", modifiedAt: 1, live: false }], runs: async () => [],
		inspect: async (sessionId, options) => {
			calls.push(options);
			const base = { sessionId, liveOwner: false, execution: { current: null, recovery: "snapshot" } };
			if (options.entryId) return { ...base, entryId: options.entryId, offset: options.offset ?? 0, text: `# Literal source\n**unchanged**\n\x1b[2J${options.offset ? "last" : "first"}`, truncated: !options.offset, nextOffset: options.offset ? null : 12000 };
			return { ...base, entries: [{ id: "entry-exact", parentId: null, type: "message", role: "assistant", text: "SOURCE-ONLY", preview: { text: prose, truncated: true }, truncated: true, nextOffset: 1200 }], result: { text: "**RESULT-SOURCE**", truncated: false, nextOffset: null }, nextCursor: 9, order: "newestFirst", detail: "source" };
		},
	};
	const dimensions = { rows: 60 };
	const panel = new AgentDashboard(sources, { terminal: dimensions as TUI["terminal"], requestRender() {} }, theme, keys, () => {});
	return { panel, dimensions, calls };
}
it("renders message headings, emphasis, lists, code and tables while leaving serialized evidence literal", async () => {
	const f = fixture(); await tick(); f.panel.handleInput("\r"); await tick();
	for (const width of [80, 120]) {
		const lines = f.panel.render(width); const raw = lines.join("\n"); const text = stripVTControlCharacters(raw);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(raw, /\x1b\[1mparser\x1b\[22m/);
		for (const expected of ["Result", "The parser is correct", "Input passed", "Error passed", "const result", "**literal**", "Passed", "Partial text", "entry-exact", "**RESULT-SOURCE**", "Safe text"]) assert.ok(text.includes(expected), expected);
		assert.doesNotMatch(text, /# Result|\*\*parser\*\*|SOURCE-ONLY|\| --- \|/);
		assert.doesNotMatch(raw, /\x1b\[2J|\x1b\]52|hostile|\u202e/);
	}
	f.panel.handleInput("\r"); await tick();
	const source = stripVTControlCharacters(f.panel.render(80).join("\n"));
	assert.match(source, /# Literal source/); assert.match(source, /\*\*unchanged\*\*/); assert.match(source, /entry-exact · offset 0/);
	f.panel.handleInput("n"); await tick(); assert.match(f.panel.render(80).join("\n"), /Final entry chunk/);
	assert.deepEqual(f.calls.slice(-2), [{ limit: 12, entryId: "entry-exact", offset: 0 }, { limit: 12, entryId: "entry-exact", offset: 12000 }]);
	f.panel.handleInput("\x1b"); f.panel.handleInput("o"); await tick(); assert.deepEqual(f.calls.at(-1), { limit: 12, cursor: 9 });
	f.panel.dispose();
});
it("reflows Markdown on resize, clamps scroll, and invalidates cached styles", async () => {
	const f = fixture(); await tick(); f.panel.handleInput("\r"); await tick();
	f.dimensions.rows = 12;
	for (const width of [120, 80, 25, 1, 80]) {
		const lines = f.panel.render(width); assert.ok(lines.every((line) => visibleWidth(line) <= width));
		f.panel.handleInput("\x1b[6~"); f.panel.render(width);
	}
	f.dimensions.rows = 60; f.panel.render(120); assert.equal(f.panel.state.reader?.scroll, 0);
	const original = f.panel.render(120).join("\n");
	theme.bold = (text) => `\x1b[3m${text}\x1b[23m`; f.panel.invalidate();
	assert.notEqual(f.panel.render(120).join("\n"), original);
	f.panel.dispose();
});
