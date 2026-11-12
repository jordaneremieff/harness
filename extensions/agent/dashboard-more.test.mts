import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { fixture, keys, row, source, turn } from "./dashboard-test-fixture.mts";

type Fixture = ReturnType<typeof fixture>;

/** Visible text: styling and the zero-width cursor markers removed, so columns match the screen. */
const visible = (f: Fixture) => f.ui.render(f.tui.terminal.columns).map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));
const shown = (f: Fixture) => visible(f).join("\n");
const footer = (f: Fixture) => (visible(f).at(-1) ?? "").trimEnd();

async function settle(turns = 8): Promise<void> {
	for (let index = 0; index < turns; index++) await turn();
}

function click(f: Fixture, x: number, y: number): void {
	const event: TuiMouseEvent = { type: "click", button: "left", x, y, screenX: x, screenY: y, width: f.tui.terminal.columns, height: f.tui.terminal.rows, shift: false, alt: false, ctrl: false, clickCount: 1 };
	f.ui.handleMouse(event);
}

const thread = (id: string) => ({ id, title: `Thread ${id}`, purpose: `Purpose of ${id}`, updatedAt: 1000, closed: false, members: 2 });
const event = (sequence: number) => ({ threadId: "t1", sequence, at: sequence * 1000, atUtc: new Date(sequence * 1000).toISOString(), sender: "one", origin: "model" as const, kind: "contribution", message: `Message ${sequence}`, source: "", replyTo: null, revision: 1, notify: [] });
const threadPage = (id: string) => ({
	thread: {
		id, title: `Thread ${id}`, purpose: `Purpose of ${id}`, authority: "Operator direction", source: "Brief", restrictions: "None", acceptance: "Works",
		integrator: "one", creator: "one", revision: 1, sequence: 1, closed: false, createdAt: 1, updatedAt: 2,
		members: [{ identity: "one", contribution: "Design", joinedAt: 1 }, { identity: "two", contribution: "Review", joinedAt: 1 }],
	},
	events: [event(1)],
	nextBefore: null,
	pending: 0,
	coverage: { complete: true, bytes: 100 },
});

it("the message field offers the More chord at 60x20 and keeps x as draft text", async () => {
	const f = fixture(60, 20, source([row("one", { state: "idle", name: "Alpha" })]));
	try {
		await settle();
		f.ui.handleInput("\r");
		assert.equal(f.ui.focus.region, "composer");
		const row0 = footer(f);
		assert.match(row0, /ctrl\+n more/u, "a text field shows the chord");
		assert.doesNotMatch(row0, /x more/u, "x is draft text here");
		f.ui.handleInput("x");
		assert.equal(f.state.agents.get("one")?.draft, "x", "x reaches the draft");
		f.ui.handleInput("\u000e");
		assert.match(shown(f), /^More\s*$/mu, "the chord opens the menu");
		f.ui.handleInput("\x1b");
		assert.doesNotMatch(shown(f), /^More\s*$/mu, "Escape closes it");
		assert.equal(f.state.agents.get("one")?.draft, "x", "the draft survives the menu");
		assert.equal(f.ui.focus.region, "composer");
		assert.match(footer(f), /ctrl\+n more/u);
		f.ui.handleInput("\u000e");
		assert.match(shown(f), /^More\s*$/mu, "the chord opens the menu again");
		f.ui.handleInput("\u000e");
		assert.doesNotMatch(shown(f), /^More\s*$/mu, "the same chord closes it");
		assert.equal(f.state.agents.get("one")?.draft, "x", "the draft survives both directions");
	} finally {
		f.ui.dispose();
	}
});

it("the Threads message field offers the More chord at 60 columns and keeps x as draft text", async () => {
	const f = fixture(60, 20, source([row("one")]), {
		collaborate: async (input) => (input.action === "list" ? { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } } : threadPage("t1")),
	});
	try {
		await settle();
		f.ui.openNamedAction("threads");
		await settle();
		f.ui.handleInput("\r");
		for (let attempt = 0; attempt < 20 && !shown(f).includes("Message 1"); attempt++) await turn();
		assert.match(shown(f), /Message 1/u, "the selected exchange is loaded before its write action");
		assert.deepEqual(f.ui.focus, { region: "list", surface: "threads" }, "the thread's message field has focus");
		assert.match(footer(f), /ctrl\+n more/u, shown(f));
		assert.doesNotMatch(footer(f), /x more/u);
		f.ui.handleInput("x");
		assert.equal(f.state.threads?.drafts.get("t1")?.text, "x", "x reaches the thread draft");
		f.ui.handleInput("\u000e");
		assert.match(shown(f), /^More\s*$/mu, "the chord opens the menu");
		f.ui.handleInput("\x1b");
		assert.doesNotMatch(shown(f), /^More\s*$/mu, "Escape closes it");
		assert.equal(f.state.threads?.drafts.get("t1")?.text, "x", "the draft survives the menu");
		assert.match(footer(f), /ctrl\+n more/u);
		f.ui.handleInput("\u000e");
		assert.match(shown(f), /^More\s*$/mu, "the chord opens the menu again");
		f.ui.handleInput("\u000e");
		assert.doesNotMatch(shown(f), /^More\s*$/mu, "the same chord closes it");
		assert.equal(f.state.threads?.drafts.get("t1")?.text, "x", "the thread draft survives both directions");
	} finally {
		f.ui.dispose();
	}
});

it("a configured key with no clickable form states the limit and keeps the draft", async () => {
	keys.setUserBindings({ "tui.input.newLine": "alt+escape" });
	const f = fixture(100, 30, source([row("one", { state: "idle", name: "Alpha" })]));
	try {
		await settle();
		f.ui.handleInput("\r");
		const line = footer(f);
		assert.match(line, /alt\+esc newline/u, "the configured chord is shown");
		const x = line.indexOf("newline") - "alt+esc ".length + 1;
		click(f, x, visible(f).length - 1);
		await settle(5);
		assert.match(shown(f), /The alt\+esc key has no clickable form here\./u, "the row states the limit");
		assert.equal(f.state.agents.get("one")?.draft ?? "", "", "the click inserts nothing");
	} finally {
		keys.setUserBindings({});
		f.ui.dispose();
	}
});

it("a hint keeps its key and an action with the same key lists in More without one", async () => {
	let runs = 0;
	const f = fixture(100, 30, source([row("one", { state: "idle", name: "Alpha" }), row("two", { state: "idle", name: "Bravo" })]), {
		extraActions: () => [{ id: "restart", label: "Restart", key: "up", primary: true, run: () => { runs++; } }],
	});
	try {
		await settle();
		assert.doesNotMatch(footer(f), /↑ restart|up restart/u, "the claimed key keeps the row's select hint");
		f.ui.handleInput("\x1b[B");
		await settle(5);
		assert.equal(f.state.selected, "two", "the key selects as its hint says");
		assert.equal(runs, 0, "the action does not also run");
		f.ui.handleInput("x");
		const menu = visible(f);
		assert.ok(menu.some((line) => line.trimEnd() === "More"), "More opens");
		const entry = menu.findIndex((line) => /Restart/u.test(line));
		assert.ok(entry > 0, "the action stays reachable from More");
		assert.doesNotMatch(menu[entry] ?? "", /\bup\b|↑/u, "its key column is empty");
		click(f, 2, entry);
		await settle(5);
		assert.equal(runs, 1, "the listed action still runs");
	} finally {
		f.ui.dispose();
	}
});
