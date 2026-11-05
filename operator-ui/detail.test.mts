import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Browser } from "./browser.ts";
import { Form } from "./form.ts";
import { NavigationFrame } from "./frame.ts";
import type { Action, ViewHost } from "./view.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const plain = (line: string) => stripVTControlCharacters(line).trimEnd();
const ENTER = "\r";
const ESCAPE = "\u001b";

interface Item {
	readonly id: string;
	readonly text: string;
}

const ITEMS: Item[] = [
	{ id: "a", text: "Alpha record" },
	{ id: "b", text: "Beta record" },
];

/** A narrow browser whose item action opens a form through the browser's own push. */
function narrow() {
	let browser: Browser<Item> | undefined;
	const forms: string[] = [];
	const open = (host: ViewHost) => {
		const view = new Browser<Item>({
			title: "Records",
			host,
			key: (item) => item.id,
			line: (item) => item.text,
			detail: (item) => (item ? `Detail of ${item.text}` : "Nothing selected"),
			actions: (item) =>
				item
					? [
							{
								id: "note",
								label: `Note ${item.text}`,
								key: "n",
								primary: true,
								run: () => {
									forms.push(item.text);
									view.push(
										(child) =>
											new Form({
												title: "Add a note",
												heading: `Note on ${item.text}`,
												fields: [{ kind: "text", id: "note", label: "Note" }],
												action: { label: "Save" },
												host: child,
												submit: async () => undefined,
											}),
									);
								},
							},
						]
					: [],
		});
		view.setItems(ITEMS);
		browser = view;
		return view;
	};
	const frame = new NavigationFrame({
		theme,
		target: { id: "session", label: "This session" },
		destinations: () => [{ key: "records", label: "Records", open }],
		rows: () => 20,
		requestRender: () => {},
		close: () => {},
	});
	return {
		frame,
		browser: () => browser,
		forms,
		text: (width = 80) => frame.render(width).map(plain).join("\n"),
		action(label: string): Action {
			const action = frame.viewActions.find((candidate) => candidate.label === label);
			assert.ok(action, `no action ${label}: ${frame.viewActions.map((candidate) => candidate.label).join(", ")}`);
			return action;
		},
	};
}

it("a form opened from the narrow detail returns to the same record on Cancel", () => {
	const n = narrow();
	n.text();
	n.frame.handleInput(ENTER);
	assert.equal(n.frame.viewTitle, "Alpha record");
	assert.ok(n.text().includes("Detail of Alpha record"));
	n.action("Note Alpha record").run();
	assert.equal(n.frame.viewTitle, "Add a note", "the form opened above the detail, not beside the list");
	assert.ok(n.text().includes("Note on Alpha record"));
	assert.deepEqual(n.forms, ["Alpha record"]);
	n.action("Cancel").run();
	assert.equal(n.frame.viewTitle, "Alpha record", "Cancel returned to the detail it came from");
	assert.ok(n.text().includes("Detail of Alpha record"));
	assert.equal(n.browser()?.selected?.id, "a", "the list never moved");
});

it("the open detail and its actions follow the current record after a refresh", () => {
	const n = narrow();
	n.text();
	n.frame.handleInput(ENTER);
	n.browser()?.setItems([
		{ id: "a", text: "Alpha updated" },
		{ id: "b", text: "Beta record" },
	]);
	assert.ok(n.text().includes("Detail of Alpha updated"), "the detail renders the current state");
	assert.ok(!n.text().includes("Detail of Alpha record"));
	assert.equal(n.action("Note Alpha updated").id, "note");
});

it("a removed record explains itself, offers no item action, and never shows another record", () => {
	const n = narrow();
	n.text();
	n.frame.handleInput(ENTER);
	n.browser()?.setItems([{ id: "b", text: "Beta record" }]);
	const screen = n.text();
	assert.ok(screen.includes("This record is no longer listed."));
	assert.ok(!screen.includes("Detail of Beta record"), "the list selection never becomes the detail's record");
	assert.deepEqual(n.frame.viewActions, [], "a removed record has no item actions");
	n.frame.handleInput(ESCAPE);
	assert.equal(n.frame.viewTitle, "Records", "Escape still leaves the detail");
	assert.ok(n.text().includes("Beta record"));
});
