import assert from "node:assert/strict";
import { it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as Keys, setKeybindings, TUI_KEYBINDINGS, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { AgentRoster, coverageText, dashboardRecords, dashboardText, elapsed, sessionAppearance } from "./dashboard.ts";

setKeybindings(new Keys(TUI_KEYBINDINGS));
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const page = (sessions: readonly AgentConversationSummary[]) => ({ sessions, coverage: { complete: true, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: null }, observedAt: 0 });

function row(overrides: Partial<AgentConversationSummary> & { id: string }): AgentConversationSummary {
	return { storageId: "storage", cwd: "/work", owner: "here", state: "idle", cost: 0.5, partial: false, modifiedAt: 10, ...overrides };
}

function roster(rows: readonly AgentConversationSummary[], events: { selected: string[]; cancelled: number }, primary = true) {
	const instance = new AgentRoster({
		tui: { terminal: { rows: 24 }, requestRender() {} } as unknown as Pick<TUI, "requestRender" | "terminal">,
		theme,
		onSelect: (key) => events.selected.push(key),
		onCancel: () => { events.cancelled++; },
		...(primary ? { primary: { label: "Primary · this Pi", detail: "work · test/model" } } : {}),
	});
	instance.setSnapshot(page(rows));
	instance.focused = true;
	return instance;
}

it("filters and sorts records by title, directory, state, and section order", () => {
	const rows = [
		row({ id: "b", name: "Parser audit", state: "idle", modifiedAt: 5 }),
		row({ id: "a", name: "Review parser", state: "working", modifiedAt: 1 }),
		row({ id: "c", name: "Old job", state: "done", modifiedAt: 1 }),
	];
	const snapshot = page(rows);
	assert.deepEqual(dashboardRecords(snapshot, "").map((item) => item.id), ["a", "b", "c"]);
	assert.deepEqual(dashboardRecords(snapshot, "parser").map((item) => item.id), ["a", "b"]);
	assert.deepEqual(dashboardRecords(snapshot, "/work").map((item) => item.id), ["a", "b", "c"]);
	assert.deepEqual(dashboardRecords(snapshot, "working").map((item) => item.id), ["a"]);
	assert.deepEqual(dashboardRecords(snapshot, "zzz"), []);
	assert.equal(elapsed(3_600_000 + 120_000), "1h2m");
	assert.equal(sessionAppearance.working.glyph, "●");
});

it("renders the pinned primary row and selects it with Enter", () => {
	const events = { selected: [] as string[], cancelled: 0 };
	const view = roster([row({ id: "a", name: "Alpha" })], events);
	const lines = view.render(80, 10);
	const screen = lines.join("\n");
	assert.match(screen, /Primary · this Pi/);
	assert.match(screen, /work · test\/model/);
	assert.match(screen, /Alpha/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
	view.handleInput(ENTER);
	assert.deepEqual(events.selected, ["primary"]);
});

it("moves through sections with the arrow keys and selects an agent", () => {
	const events = { selected: [] as string[], cancelled: 0 };
	const view = roster([row({ id: "agent:one", name: "One", state: "working" }), row({ id: "agent:two", name: "Two" })], events);
	view.render(80, 12);
	view.handleInput(DOWN);
	view.handleInput(ENTER);
	assert.deepEqual(events.selected, ["agent:one"]);
	view.handleInput(DOWN);
	view.handleInput(ENTER);
	assert.deepEqual(events.selected, ["agent:one", "agent:two"]);
});

it("filters while typing and clears the filter before it cancels", () => {
	const events = { selected: [] as string[], cancelled: 0 };
	const view = roster([row({ id: "agent:one", name: "Parser audit" }), row({ id: "agent:two", name: "Other" })], events);
	view.handleInput("p");
	view.handleInput("a");
	view.handleInput("r");
	const screen = view.render(80, 10).join("\n");
	assert.match(screen, /1 of 2 · par/);
	assert.match(screen, /Parser audit/);
	assert.doesNotMatch(screen, /Other/);
	view.handleInput(ESCAPE);
	assert.equal(events.cancelled, 0, "the first escape clears the filter");
	assert.match(view.render(80, 10).join("\n"), /Other/);
	view.handleInput(ESCAPE);
	assert.equal(events.cancelled, 1);
});

it("adds ID suffixes for duplicate titles and shows coverage", () => {
	const events = { selected: [] as string[], cancelled: 0 };
	const first = row({ id: "sameprefix-one", name: "Review parser" });
	const second = row({ id: "sameprefix-two", name: "Review parser" });
	const view = new AgentRoster({
		tui: { terminal: { rows: 24 }, requestRender() {} } as unknown as Pick<TUI, "requestRender" | "terminal">,
		theme,
		onSelect: (key) => events.selected.push(key),
		onCancel: () => { events.cancelled++; },
	});
	view.setSnapshot({ ...page([first, second]), coverage: { complete: false, storagesVisited: 2, skipped: 1, omitted: 2, nextCursor: null } });
	const screen = view.render(120, 10).join("\n");
	assert.match(screen, /Review parser ix-one/);
	assert.match(screen, /Review parser ix-two/);
	assert.match(screen, /1 store skipped \(unknown, not absent\)/);
	assert.match(screen, /2 rows not loaded/);
	assert.match(screen, /coverage incomplete/);
	assert.equal(coverageText(undefined), "");
});

it("keeps the selected row across snapshots and renders safely at narrow widths", () => {
	const events = { selected: [] as string[], cancelled: 0 };
	const view = roster([row({ id: "agent:one", name: "One" }), row({ id: "agent:two", name: "Two" })], events);
	view.handleInput(DOWN);
	view.setSnapshot({ ...page([row({ id: "agent:two", name: "Two" })]), observedAt: 5 });
	view.handleInput(ENTER);
	assert.deepEqual(events.selected, ["agent:two"]);
	for (const width of [80, 40, 24]) {
		assert.ok(view.render(width, 12).every((line) => visibleWidth(line) <= width), `width ${width}`);
	}
});

it("renders a bounded plain-text summary for status reads", () => {
	const snapshot = page([row({ id: "a", name: "Alpha", state: "working", cost: 1.25, partial: true })]);
	const text = dashboardText(snapshot);
	assert.match(text, /Alpha/);
	assert.match(text, /≥\$1.25/);
	assert.match(text, /● Working/);
	assert.match(text, /1 working/);
});
