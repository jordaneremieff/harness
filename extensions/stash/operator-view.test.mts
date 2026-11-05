/** The ordinary stash browser over a real store in a temporary directory: lifecycle journeys and read invalidation. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { Browser, OperatorView, ViewHost } from "../../operator-ui/index.ts";
import { NavigationFrame } from "../../operator-ui/index.ts";
import { loadArchive, loadRecent, loadSelectedPreview } from "./browser-views.ts";
import { createStashViewState, type StashOperations, stashView } from "./operator-view.ts";
import { rotateStash, transitionStash, writeStash, type StashEntry } from "./store.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;

/**
 * Wait until the condition holds, within a bounded number of event-loop turns. The store reads run
 * on the filesystem, so a fixed number of turns is not evidence that they finished.
 */
const waitFor = async (condition: () => boolean, rounds = 2000): Promise<boolean> => {
	for (let round = 0; round < rounds; round++) {
		if (condition()) return true;
		await new Promise((resolve) => setImmediate(resolve));
	}
	return condition();
};

async function storeWithTwoRecords(): Promise<{ dir: string; bodies: Map<string, string> }> {
	const dir = await mkdtemp(join(tmpdir(), "stash-view-"));
	const alpha = await writeStash(dir, { title: "Alpha effort", summary: "alpha summary text", project: "/work", sessionId: "session-1" });
	const beta = await writeStash(dir, { title: "Beta effort", summary: "beta summary text", project: "/work", sessionId: "session-1" });
	return { dir, bodies: new Map([[alpha.record.id, "alpha summary text"], [beta.record.id, "beta summary text"]]) };
}

/** A frame-like host that keeps the nested form layers a real frame would keep. */
function layeredHost() {
	const layers: Array<{ view: OperatorView; controller: AbortController }> = [];
	const notices: string[] = [];
	const make = (controller: AbortController): ViewHost => ({
		theme,
		target: { id: "session", label: "This session · work" },
		signal: controller.signal,
		requestRender: () => {},
		notify: (text) => notices.push(text),
		push: (open) => {
			const child = new AbortController();
			layers.push({ view: open(make(child)), controller: child });
		},
		back: () => {
			const index = layers.findIndex((layer) => layer.controller === controller);
			for (const layer of layers.splice(Math.max(0, index))) layer.controller.abort();
		},
		close: () => {},
	});
	return {
		notices,
		open: (ops: StashOperations) => {
			const controller = new AbortController();
			const view = stashView(make(controller), ops, createStashViewState()) as Browser<StashEntry>;
			layers.push({ view, controller });
			return view;
		},
		top: (): OperatorView => layers.at(-1)?.view ?? assert.fail("no open layer"),
	};
}

/**
 * The store operations the ordinary browser binds, with the first preview read held until the test
 * releases it, so a late read can be observed against a newer selection.
 */
function storeOperations(dir: string, holdFirstPreview?: Promise<void>): StashOperations {
	let held = false;
	return {
		recent: (signal) => loadRecent(dir, signal),
		archive: (query, cursor, prior, signal) => loadArchive(dir, query, cursor, prior, signal),
		preview: async (entry: StashEntry, signal) => {
			if (holdFirstPreview && !held) {
				held = true;
				await holdFirstPreview;
			}
			return loadSelectedPreview(dir, entry, signal);
		},
		pickup: async (id) => {
			await transitionStash(dir, id, { action: "activate" });
			return `Picked up ${id}.`;
		},
		close: async (id, outcome) => `Closed stash ${(await transitionStash(dir, id, { action: "close", outcome })).id}.`,
		release: async (id) => `Released stash ${(await transitionStash(dir, id, { action: "release" })).id} back to open.`,
		reopen: async (id) => `Reopened stash ${(await transitionStash(dir, id, { action: "reopen" })).id}.`,
		rotate: async (id) => `Rotated stash ${(await rotateStash(dir, id)).id} to the stash archive.`,
		copy: async () => {},
	};
}

function screenOf(view: OperatorView, width = 120, height = 30): string {
	return (view.render(width, height) ?? []).map((line) => stripVTControlCharacters(line)).join("\n");
}

/** The state line of the selected record's detail, once its read has settled. */
const showsState = (view: OperatorView, state: string) => new RegExp(`${state} · stashed`).test(screenOf(view));

/** Run one labelled action of the current layer, as its footer control would. */
function act(view: OperatorView, label: string): void {
	const action = view.actions?.().find((candidate) => candidate.label === label);
	assert.ok(action, `no ${label}: ${view.actions?.().map((candidate) => candidate.label).join(", ")}`);
	assert.equal(action.disabled, undefined, `${label} is unavailable: ${action.disabled}`);
	action.run();
}

function typeInto(view: OperatorView, text: string): void {
	view.focused = true;
	for (const character of text) view.handleInput(character);
}

test("close, reopen, and pick up follow the store, and release returns to open with its valid actions", async () => {
	const { dir } = await storeWithTwoRecords();
	const host = layeredHost();
	const view = host.open(storeOperations(dir));
	assert.ok(await waitFor(() => screenOf(view).includes("Alpha effort")), "the newest records are listed");
	const selected = view.selected;
	assert.ok(selected, "a record is selected");
	act(view, "Pick up");
	assert.ok(await waitFor(() => showsState(view, "active")), "pickup activates the selected record");
	act(view, "Close with outcome…");
	const form = host.top();
	assert.equal(form.title, "Close with outcome");
	typeInto(form, "shipped the feature");
	act(form, "Close stash");
	assert.ok(await waitFor(() => /closed · stashed/.test(screenOf(host.top()))), "the closed record is shown after its effect");
	const closed = host.top();
	assert.ok(screenOf(closed).includes("outcome: shipped the feature"), "the recorded outcome is shown");
	assert.ok(closed.actions?.().some((action) => action.label === "Reopen…"), "a closed record offers Reopen");
	assert.ok(!closed.actions?.().some((action) => action.label === "Pick up"), "a closed record offers no pickup");
	act(closed, "Reopen…");
	act(host.top(), "Reopen");
	assert.ok(await waitFor(() => /open · stashed/.test(screenOf(host.top()))), "the reopened record is shown as open");
	const reopened = host.top();
	assert.ok(reopened.actions?.().some((action) => action.label === "Pick up"), "an open record offers Pick up again");
	act(reopened, "Pick up");
	assert.ok(await waitFor(() => showsState(host.top(), "active")), "the reopened record can be picked up");
	const active = host.top();
	act(active, "Release…");
	act(host.top(), "Release");
	assert.ok(await waitFor(() => /open · stashed/.test(screenOf(host.top()))), "release returns the record to open");
	const released = host.top();
	assert.ok(released.actions?.().some((action) => action.label === "Pick up"), "a released record offers Pick up");
	assert.ok(!released.actions?.().some((action) => action.label === "Close with outcome…"), "a released record offers no close");
});

test("an external change, then Refresh, rereads the selected preview even when its id is unchanged", async () => {
	const { dir } = await storeWithTwoRecords();
	const host = layeredHost();
	const view = host.open(storeOperations(dir));
	assert.ok(await waitFor(() => screenOf(view).includes("Alpha effort")));
	const selected = view.selected;
	assert.ok(selected);
	act(view, "Pick up");
	assert.ok(await waitFor(() => showsState(view, "active")));
	await transitionStash(dir, selected.meta.id, { action: "close", outcome: "closed elsewhere" });
	assert.ok(showsState(view, "active"), "the view keeps its read state until it refreshes");
	act(host.top(), "Refresh");
	assert.ok(await waitFor(() => /closed · stashed/.test(screenOf(host.top()))), "Refresh rereads the selected record");
	const refreshed = host.top();
	assert.ok(refreshed.actions?.().some((action) => action.label === "Reopen…"), "the refreshed actions follow the store");
	assert.ok(!refreshed.actions?.().some((action) => action.label === "Close with outcome…"));
});

test("a late older preview read never overwrites the newer selection and leaves no pending read", async () => {
	const { dir, bodies } = await storeWithTwoRecords();
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const host = layeredHost();
	const view = host.open(storeOperations(dir, held));
	assert.ok(await waitFor(() => view.selected !== undefined && screenOf(view).includes("Reading the stash…")), "the first preview read is held");
	const first = view.selected;
	assert.ok(first);
	view.handleInput("\u001b[B");
	const second = view.selected;
	assert.ok(second && second.meta.id !== first.meta.id, "the selection moved to the other record");
	assert.ok(await waitFor(() => screenOf(view).includes(bodies.get(second.meta.id) ?? "")), "the next record is read on selection");
	release();
	assert.ok(
		await waitFor(() => !screenOf(view).includes("Reading the stash…") && screenOf(view).includes(bodies.get(second.meta.id) ?? "")),
		"the late older read settles without disturbing the newer selection",
	);
	assert.ok(!screenOf(view).includes(bodies.get(first.meta.id) ?? ""), "the superseded record stays unread until it is selected again");
	view.handleInput("\u001b[A");
	assert.ok(
		await waitFor(() => screenOf(view).includes(bodies.get(first.meta.id) ?? "")),
		"reselecting the record starts a fresh read",
	);
	assert.ok(!screenOf(view).includes("Reading the stash…"), "no preview read stays pending forever");
});

/** A real frame at a narrow size: the whole ordinary terminal is 80x24, so its body gets 14 rows. */
function narrowFrame(ops: StashOperations) {
	return new NavigationFrame({
		theme,
		target: { id: "session", label: "This session · work" },
		destinations: () => [{ key: "stash", label: "Stashes", open: (host: ViewHost) => stashView(host, ops) }],
		rows: () => 14,
		requestRender: () => {},
		close: () => {},
	});
}

const visibleWidthFit = (line: string) => stripVTControlCharacters(line).trimEnd();

test("at 80 columns the narrow detail opens the note form from itself and Cancel returns to the same record", async () => {
	const { dir } = await storeWithTwoRecords();
	const frame = narrowFrame(storeOperations(dir));
	const shown = () => frame.render(80).map(visibleWidthFit).join("\n");
	assert.ok(await waitFor(() => /Beta effort/.test(shown())), `the newest records are listed: ${shown()}`);
	assert.match(shown(), /Beta effort/);
	frame.handleInput("\u001b[C");
	assert.ok(await waitFor(() => /open · stashed/.test(shown())), `Right opens the narrow detail: ${shown()}`);
	assert.match(frame.viewTitle ?? "", /Beta effort/, "the detail names the selected record");
	assert.match(shown(), /id: \d{8}T\d{6}Z-beta-effort/);
	frame.handleInput("a");
	await waitFor(() => /The note goes ahead of the handover/.test(shown()));
	assert.equal(frame.viewTitle, "Pick up with note", `the note form opens from the visible detail: ${shown()}`);
	const cancel = frame.viewActions.find((action) => action.label === "Cancel");
	assert.ok(cancel, "the form offers Cancel");
	cancel.run();
	assert.ok(await waitFor(() => /open · stashed/.test(shown())), `Cancel returns to the record's detail: ${shown()}`);
	assert.match(frame.viewTitle ?? "", /Beta effort/, "the detail of the same record is shown again");
	assert.match(shown(), /id: \d{8}T\d{6}Z-beta-effort/);
	assert.doesNotMatch(shown(), /The note goes ahead of the handover/);
	const entries = await loadRecent(dir);
	assert.equal(entries.entries.find((entry) => entry.meta.id.includes("beta"))?.meta.state, "open", "Cancel picked nothing up");
});
