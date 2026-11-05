import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Browser, type BrowserOptions, SPLIT_MIN_WIDTH } from "./browser.ts";
import { NavigationFrame } from "./frame.ts";
import type { OperatorView, ViewHost } from "./view.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const plain = (line: string) => stripVTControlCharacters(line);

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
		close: () => {},
	};
	return self;
}

function browser(patch: Partial<BrowserOptions<Item>> = {}, pushed: OperatorView[] = [], viewHost = host(pushed)) {
	const events: string[] = [];
	let scope = "all";
	const view = new Browser<Item>({
		title: "Records",
		host: viewHost,
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
	return {
		view,
		events,
		pushed,
		screen: (width: number) => view.render(width, 10).map(plain).join("\n"),
	};
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

it("/ focuses the search field, and typing over the list no longer reaches it", () => {
	const b = browser();
	b.screen(SPLIT_MIN_WIDTH);
	b.view.handleInput("x");
	assert.equal(b.view.query, "");
	assert.ok(!b.events.some((event) => event.startsWith("query")), "a letter on the list is not a search edit");
	assert.equal(b.view.editing(), false);
	b.view.handleInput("/");
	assert.equal(b.view.editing(), true);
	b.view.handleInput("x");
	assert.equal(b.view.query, "x");
	assert.ok(b.events.includes("query:x"), "the focused field takes the letter");
});

it("search Up and Down move the selection, and Enter submits before returning to the list", () => {
	const b = browser({
		search: {
			change: () => {},
			submit: (query) => b.events.push(`submit:${query}`),
			submitLabel: () => "search",
		},
	});
	b.screen(SPLIT_MIN_WIDTH);
	b.view.handleInput("/");
	const labels = b.view.keys().map((hint) => hint.label);
	assert.deepEqual(labels, ["select", "search", "focus", "list"]);
	b.view.handleInput("\u001b[B");
	assert.equal(b.view.selected?.id, "b");
	b.view.handleInput("\u001b[A");
	assert.equal(b.view.selected?.id, "a");
	b.view.handleInput("\r");
	assert.ok(b.events.includes("submit:"), "the owner's submit runs with the field value");
	assert.equal(b.view.editing(), false);
	assert.ok(b.view.keys().some((hint) => hint.label === "detail"), "the list keys return");
});

it("Escape clears the search text first, then returns to the list", () => {
	const b = browser();
	b.screen(SPLIT_MIN_WIDTH);
	assert.equal(b.view.escape(), false, "on the list, Escape belongs to the frame");
	b.view.handleInput("/");
	b.view.handleInput("a");
	b.view.handleInput("b");
	assert.equal(b.view.query, "ab");
	assert.equal(b.view.escape(), true, "the first Escape clears the text");
	assert.equal(b.view.query, "");
	assert.equal(b.view.escape(), true, "the next Escape returns to the list");
	assert.equal(b.view.editing(), false);
	assert.equal(b.view.escape(), false);
});

it("Escape in the detail returns to the list", () => {
	const b = browser();
	b.screen(SPLIT_MIN_WIDTH);
	b.view.handleInput("\u001b[C");
	assert.ok(b.view.keys().some((hint) => hint.label === "scroll"), "Right opens the detail");
	assert.equal(b.view.editing(), false);
	assert.equal(b.view.escape(), true);
	assert.ok(b.view.keys().some((hint) => hint.label === "select"));
});

it("the list footer names the reading key for the current width and the search key", () => {
	const b = browser();
	b.screen(SPLIT_MIN_WIDTH);
	const wide = b.view.keys();
	assert.ok(wide.some((hint) => hint.keys.includes("pageUp") && hint.label === "read"), "wide reads the detail");
	assert.ok(wide.some((hint) => hint.keys.includes("/") && hint.label === "search"));
	assert.ok(wide.some((hint) => hint.keys.includes("enter") && hint.label === "detail"));
	b.screen(SPLIT_MIN_WIDTH - 1);
	const narrow = b.view.keys();
	assert.ok(narrow.some((hint) => hint.keys.includes("pageUp") && hint.label === "page"), "narrow pages the list");
});

it("an owner action with key enter takes Enter, and Right opens the detail", () => {
	const ran: string[] = [];
	const frame = new NavigationFrame({
		theme,
		target: { id: "t", label: "Target" },
		destinations: () => [
			{
				key: "records",
				label: "Records",
				open: (viewHost) =>
					browser({ actions: () => [{ id: "act", label: "Act", key: "enter", primary: true, run: () => ran.push("act") }] }, [], viewHost).view,
			},
		],
		rows: () => 12,
		requestRender: () => {},
		close: () => {},
	});
	const footer = () => (frame.render(100).map(plain).at(-1) ?? "").trimEnd();
	assert.match(footer(), /enter act/);
	assert.match(footer(), /→ detail/, "Right replaces Enter when an action claims Enter");
	frame.handleInput("\r");
	assert.deepEqual(ran, ["act"]);
	assert.match(footer(), /→ detail/, "Enter ran the action and left the list in place");
	frame.handleInput("\u001b[C");
	assert.match(footer(), /↑↓ scroll/, "Right opened the detail");
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
