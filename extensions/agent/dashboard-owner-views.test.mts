import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { agentState } from "./dashboard-state.ts";
import { deferred, fixture, page, row, source, turn } from "./dashboard-test-fixture.mts";
import type { AgentConversationPage } from "./dashboard-types.ts";
import type { OwnerView } from "./panel-modules.ts";

type Fixture = ReturnType<typeof fixture>;

/** Visible text: styling and the zero-width cursor markers removed, so columns match the screen. */
const visible = (f: Fixture) =>
	f.ui.render(f.tui.terminal.columns).map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));
const shown = (f: Fixture) => visible(f).join("\n");

function press(f: Fixture, ...keys: string[]): void {
	for (const key of keys) {
		f.ui.render(f.tui.terminal.columns);
		f.ui.handleInput(key);
	}
}

function type(f: Fixture, text: string): void {
	for (const character of text) f.ui.handleInput(character);
}

function clickLabel(f: Fixture, label: string): void {
	const lines = visible(f);
	for (let y = lines.length - 1; y >= 0; y--) {
		const x = lines[y]?.indexOf(label) ?? -1;
		if (x < 0) continue;
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: x + 1,
			y,
			screenX: x + 1,
			screenY: y,
			width: f.tui.terminal.columns,
			height: f.tui.terminal.rows,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		f.ui.handleMouse(event);
		return;
	}
	assert.fail(`no visible ${label}`);
}

/** An owner view whose label is all it shows. */
const destination = (label: string): OwnerView => ({
	key: label.toLocaleLowerCase(),
	contribution: label.toLocaleLowerCase(),
	label,
	open: () => ({ title: label, render: (width) => [label.padEnd(width)], handleInput: () => true }),
});

it("an owner-view read that finishes after Configure opened leaves the form and its staged name", async () => {
	const panels = deferred<readonly OwnerView[]>();
	const f = fixture(140, 40, source([row("one", { state: "idle", name: "Alpha" })]), { panels: () => panels.promise });
	try {
		await turn();
		await turn();
		press(f, "o");
		assert.match(shown(f), /Reading the owner views of Alpha/u);
		press(f, "c");
		await turn();
		assert.equal(f.ui.focus.inspector, "Configure");
		type(f, "Re");
		assert.match(shown(f), /Name +AlphaRe/u, "the staged name is shown");
		panels.resolve([destination("Stash")]);
		await turn();
		await turn();
		assert.equal(f.ui.focus.inspector, "Configure", "the newer form keeps the view");
		assert.match(shown(f), /Configure Alpha/u);
		assert.match(shown(f), /Name +AlphaRe/u, "the staged name survives the late read");
		assert.doesNotMatch(shown(f), /Reading the owner views|Owner views could not be read/u);
		assert.deepEqual(f.calls, [], "opening a form and a late read send nothing");
	} finally {
		f.ui.dispose();
	}
});

for (const outcome of ["resolves", "fails"] as const) {
	it(`an owner-view read that ${outcome} after the operator returns to the agent opens nothing`, async () => {
		let finish!: (opened: boolean) => void;
		const panels = new Promise<readonly OwnerView[]>((resolve, reject) => {
			finish = (opened) => (opened ? resolve([destination("Stash")]) : reject(new Error("host unavailable")));
		});
		const f = fixture(
			140,
			40,
			source([row("one", { state: "idle", name: "Alpha" }), row("two", { state: "idle", name: "Bravo" })]),
			{
				panels: () => panels,
			},
		);
		try {
			await turn();
			await turn();
			press(f, "o");
			assert.match(shown(f), /Reading the owner views of Alpha/u);
			press(f, "\x1b[B");
			assert.equal(f.state.selected, "two");
			assert.doesNotMatch(shown(f), /Reading the owner views/u, "a pending line for another target goes");
			press(f, "\x1b[A");
			assert.equal(f.state.selected, "one");
			if (outcome === "resolves") finish(true);
			else finish(false);
			await turn();
			await turn();
			assert.equal(f.ui.focus.inspector, undefined, "no inspector opens for the earlier request");
			assert.equal(f.ui.focus.region, "list");
			assert.equal(f.state.selected, "one");
			assert.doesNotMatch(shown(f), /Owner views could not be read|Reading the owner views/u);
		} finally {
			f.ui.dispose();
		}
	});
}

it("New, leave, select B, then onCreated keeps B and its draft and retains the created record", async () => {
	const ordinary = "11111111-1111-1111-1111-111111111111";
	const rows = [
		row("one", { name: "Alpha", creatingOwnerId: ordinary }),
		row("two", { name: "Bravo", creatingOwnerId: ordinary }),
	];
	const observed = source(rows);
	observed.list = async (): Promise<AgentConversationPage> => page(rows);
	let createdCallback: ((value: ReturnType<typeof row>) => void) | undefined;
	const creation = deferred();
	const f = fixture(
		140,
		40,
		observed,
		{
			newAgent: async ({ onCreated }) => {
				createdCallback = onCreated;
				await creation.promise;
				return { text: "Started", sessionId: "three" };
			},
		},
		undefined,
		undefined,
		ordinary,
	);
	try {
		await turn();
		await turn();
		f.ui.openNamedAction("new");
		await turn();
		type(f, "make it");
		press(f, "\r", "\r");
		clickLabel(f, "start");
		await turn();
		assert.equal(f.ui.focus.inspector, "New conversation");
		press(f, "\x1b");
		assert.equal(f.ui.focus.inspector, undefined);
		assert.equal(f.ui.focus.region, "list");
		press(f, "\x1b[B");
		assert.equal(f.state.selected, "two", "B is selected while creation is pending");
		press(f, "\r");
		type(f, "draft for bravo");
		assert.equal(agentState(f.state, "two").draft, "draft for bravo");
		createdCallback?.(row("three", { name: "Charlie", state: "starting", creatingOwnerId: ordinary }));
		rows.push(row("three", { name: "Charlie", state: "starting", creatingOwnerId: ordinary }));
		await turn();
		await turn();
		assert.equal(f.state.selected, "two", "a stale creation does not take the selection");
		assert.equal(f.ui.focus.region, "composer");
		assert.equal(agentState(f.state, "two").draft, "draft for bravo");
		assert.match(shown(f), /To Bravo/u, "the message field keeps B as its recipient");
		assert.doesNotMatch(shown(f), /To Charlie/u);
		creation.resolve(undefined);
		for (let step = 0; step < 8; step++) await turn();
		assert.equal(f.state.selected, "two");
		assert.equal(agentState(f.state, "two").draft, "draft for bravo");
		assert.equal(agentState(f.state, "three").receipt, "Started", "the created record keeps its result");
		assert.match(shown(f), /Charlie/u, "the created conversation stays in the list");
		assert.doesNotMatch(shown(f), /To Charlie/u);
	} finally {
		creation.resolve(undefined);
		f.ui.dispose();
	}
});

it("several owner views open as a list, and Open shows the chosen one alone with Escape back to the list", async () => {
	const body = (label: string): OwnerView => ({
		key: label.toLocaleLowerCase(),
		contribution: label.toLocaleLowerCase(),
		label,
		open: () => ({ title: label, render: (width) => [`${label} body`.padEnd(width)], handleInput: () => true }),
	});
	const f = fixture(140, 40, source([row("one", { state: "idle", name: "Alpha" })]), {
		panels: async () => [body("Stash"), body("Notes")],
	});
	try {
		await turn();
		await turn();
		press(f, "o");
		await turn();
		await turn();
		assert.equal(f.ui.focus.inspector, "Owner views");
		assert.match(shown(f), /Owner views of Alpha/u);
		assert.match(shown(f), /● Stash/u, "the list names each owner view");
		assert.match(shown(f), /○ Notes/u);
		assert.doesNotMatch(shown(f), /Stash body|Notes body/u, "choosing waits for Open");
		assert.match(visible(f).at(-1) ?? "", /↑↓ choose · enter open/u, "the key row shows the list's keys");
		press(f, "\x1b[B");
		assert.doesNotMatch(shown(f), /Notes body/u, "selection alone opens nothing");
		press(f, "\r");
		assert.equal(f.ui.focus.inspector, "Notes");
		assert.match(shown(f), /Notes body/u, "the chosen owner view opens");
		assert.doesNotMatch(shown(f), /Stash body|○ Stash/u, "it shows alone");
		assert.match(shown(f), /Owner views › Notes/u, "the trail names the way back");
		press(f, "\x1b");
		assert.equal(f.ui.focus.inspector, "Owner views", "Escape returns to the list");
		assert.doesNotMatch(shown(f), /Notes body/u);
		assert.deepEqual(f.calls, [], "choosing and opening an owner view send nothing");
	} finally {
		f.ui.dispose();
	}
});

it("one owner view opens alone under its own title, and Escape returns to the agent", async () => {
	const stash: OwnerView = {
		key: "stash",
		contribution: "stash",
		label: "Stash",
		open: () => ({ title: "Stashes", render: (width) => ["Stash body".padEnd(width)], handleInput: () => true }),
	};
	const f = fixture(140, 40, source([row("one", { state: "idle", name: "Alpha" })]), { panels: async () => [stash] });
	try {
		await turn();
		await turn();
		press(f, "o");
		await turn();
		await turn();
		assert.equal(f.ui.focus.inspector, "Stashes");
		assert.match(shown(f), /─ Stash ─+ +Alpha · work ─/u, "the title row names the owner view and its bound agent");
		assert.match(shown(f), /Stash body/u);
		assert.match(visible(f).at(-1) ?? "", /esc close stash/u, "the way out names the view");
		press(f, "\x1b");
		assert.equal(f.ui.focus.inspector, undefined);
		assert.deepEqual(f.calls, []);
	} finally {
		f.ui.dispose();
	}
});
