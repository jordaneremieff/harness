import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Browser, type BrowserOptions, SPLIT_MIN_WIDTH } from "./browser.ts";
import type { OperatorView, ViewHost } from "./view.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

interface Item {
	readonly id: string;
	readonly text: string;
}

const ITEMS: Item[] = [
	{ id: "a", text: "Alpha record" },
	{ id: "b", text: "Beta record" },
];

function host(pushed: OperatorView[]): ViewHost {
	const self: ViewHost = {
		theme,
		target: { id: "t", label: "Target" },
		signal: new AbortController().signal,
		requestRender: () => {},
		notify: () => {},
		push: (open) => pushed.push(open(self)),
		back: () => {},
		focusActions: () => {},
		close: () => {},
	};
	return self;
}

function browser(patch: Partial<BrowserOptions<Item>> = {}, pushed: OperatorView[] = []) {
	const events: string[] = [];
	let scope = "all";
	const view = new Browser<Item>({
		title: "Records",
		host: host(pushed),
		key: (item) => item.id,
		line: (item) => item.text,
		detail: (item) => (item ? `Detail of ${item.text}` : "Nothing selected"),
		actions: (item) => [{ id: "act", label: "Act", primary: true, run: () => events.push(`act:${item?.id}`) }],
		scopes: [
			{ id: "all", label: "All" },
			{ id: "mine", label: "Mine" },
		],
		scope: () => scope,
		onScope: (id) => {
			scope = id;
			events.push(`scope:${id}`);
		},
		search: { change: (query) => events.push(`query:${query}`) },
		onSelect: (item) => events.push(`select:${item?.id}`),
		...patch,
	});
	view.setItems(ITEMS);
	return { view, events, pushed, screen: (width: number) => view.render(width, 10).map((line) => stripVTControlCharacters(line)).join("\n") };
}

it("a wide view shows the list and the selected detail side by side", () => {
	const b = browser();
	const screen = b.screen(SPLIT_MIN_WIDTH);
	assert.ok(screen.includes("Alpha record"));
	assert.ok(screen.includes("Detail of Alpha record"));
	assert.ok(b.screen(SPLIT_MIN_WIDTH - 1).includes("Alpha record"));
	assert.ok(!b.screen(SPLIT_MIN_WIDTH - 1).includes("Detail of"), "a narrow view shows the list alone");
});

it("Enter in a narrow view opens the detail as a nested view with the item's actions", () => {
	const b = browser();
	b.screen(60);
	b.view.handleInput("\r");
	assert.equal(b.pushed.length, 1);
	const detail = b.pushed[0];
	assert.ok(detail?.render(60, 4).join("\n").includes("Detail of Alpha record"));
	detail?.actions?.()[0]?.run();
	assert.deepEqual(b.events.filter((event) => event.startsWith("act")), ["act:a"]);
});

it("selection is a read: moving it reports the item and runs no action", () => {
	const b = browser();
	b.screen(SPLIT_MIN_WIDTH);
	b.view.handleInput("\u001b[B");
	assert.equal(b.view.selected?.id, "b");
	assert.ok(b.events.includes("select:b"));
	assert.ok(!b.events.some((event) => event.startsWith("act")));
	assert.ok(b.screen(SPLIT_MIN_WIDTH).includes("Detail of Beta record"));
});

it("typing over the list writes into the search field, and Escape clears an active search first", () => {
	const b = browser();
	b.screen(SPLIT_MIN_WIDTH);
	b.view.handleInput("x");
	assert.equal(b.view.query, "x");
	assert.ok(b.events.includes("query:x"));
	assert.equal(b.view.escape(), true, "the first Escape clears the search");
	assert.equal(b.view.query, "");
	assert.ok(b.events.includes("query:"));
	assert.equal(b.view.escape(), false, "without a search, Escape belongs to the frame");
});

it("scopes switch through the owner and the active scope is marked", () => {
	const b = browser();
	b.screen(SPLIT_MIN_WIDTH);
	// The regions run search, scopes, list, detail; the list starts focused.
	assert.equal(b.view.focusNext(true), true);
	b.view.handleInput("\u001b[C");
	assert.ok(b.events.includes("scope:mine"));
	assert.ok(b.screen(SPLIT_MIN_WIDTH).includes("Mine"));
});

it("an empty list shows the owner's empty text, distinct from its status", () => {
	const b = browser({ empty: () => "No records yet.", status: () => "2 sources read" });
	b.view.setItems([]);
	const screen = b.screen(SPLIT_MIN_WIDTH);
	assert.ok(screen.includes("No records yet."));
	assert.ok(screen.includes("2 sources read"));
});
