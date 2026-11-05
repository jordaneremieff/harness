/** The clipboard history view over a real archive in a temporary directory: query identity and refresh recovery. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { Browser, OperatorView, ViewHost } from "../../operator-ui/index.ts";
import { loadRecentEntries, PREVIEW_CONTENT_CHARS, readExactEntry, searchArchive } from "./browser-operations.ts";
import { appendEntry, makeEntry, type ClipboardEntry } from "./store.ts";
import { clipboardView, createClipboardViewState, type ClipboardOperations } from "./operator-view.ts";

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
 * Wait until the condition holds, within a bounded number of event-loop turns. The archive reads
 * run on the filesystem, so a fixed number of turns is not evidence that they finished.
 */
const waitFor = async (condition: () => boolean, rounds = 2000): Promise<boolean> => {
	for (let round = 0; round < rounds; round++) {
		if (condition()) return true;
		await new Promise((resolve) => setImmediate(resolve));
	}
	return condition();
};

function viewHost(): ViewHost {
	return {
		theme,
		target: { id: "session", label: "This session · work" },
		signal: new AbortController().signal,
		requestRender: () => {},
		notify: () => {},
		push: () => {},
		back: () => {},
		close: () => {},
	};
}

function screenOf(view: OperatorView, width = 120, height = 30): string {
	return (view.render(width, height) ?? []).map((line) => stripVTControlCharacters(line)).join("\n");
}

/** Run one labelled action, as its footer control would. */
function act(view: OperatorView, label: string): void {
	const action = view.actions?.().find((candidate) => candidate.label === label);
	assert.ok(action, `no ${label}: ${view.actions?.().map((candidate) => candidate.label).join(", ")}`);
	assert.equal(action.disabled, undefined, `${label} is unavailable: ${action.disabled}`);
	action.run();
}

const typeInto = (view: OperatorView, text: string) => {
	for (const character of text) view.handleInput(character);
};

/** Move the focus to the scope row, step in the given direction, and return to the list. */
function switchScope(view: Browser<ClipboardEntry>, direction: "left" | "right"): void {
	assert.ok(view.focusNext?.(true), "focus reaches the scope row");
	view.handleInput(direction === "right" ? "\u001b[C" : "\u001b[D");
	view.handleInput("\u001b[B");
}

/** Focus the shared search field, replace its text, and submit it from the field. */
function setQuery(view: Browser<ClipboardEntry>, text: string): void {
	view.handleInput("/");
	if (view.query) view.escape();
	typeInto(view, text);
	view.handleInput("\r");
}

/** Focus the shared search field and append to its text without submitting. */
function extendQuery(view: Browser<ClipboardEntry>, text: string): void {
	view.handleInput("/");
	typeInto(view, text);
}

test("a query change from either scope invalidates the archive, and a late old search never marks it fresh", async () => {
	const dir = await mkdtemp(join(tmpdir(), "clipboard-view-"));
	await appendEntry(dir, makeEntry("alpha body text one", "alpha label"));
	await appendEntry(dir, makeEntry("beta body text two", "beta label"));
	const searches: Array<{ query: string; settled: boolean }> = [];
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let firstSearch = true;
	const ops: ClipboardOperations = {
		recent: (signal) => loadRecentEntries(dir, signal),
		search: async (query, cursor, signal) => {
			if (firstSearch) {
				firstSearch = false;
				await held;
			}
			try {
				return await searchArchive(dir, query, cursor, signal);
			} finally {
				searches.push({ query, settled: true });
			}
		},
		preview: (entry, signal) => readExactEntry(dir, entry, PREVIEW_CONTENT_CHARS, signal),
		/** The system clipboard stays untouched here; the exact-record read is the part under test. */
		restore: async (entry, signal) => {
			await readExactEntry(dir, entry, Number.POSITIVE_INFINITY, signal);
			return { ok: true };
		},
	};
	const view = clipboardView(viewHost(), ops, createClipboardViewState()) as Browser<ClipboardEntry>;
	assert.ok(await waitFor(() => screenOf(view).includes("beta body text two")), "the recent entries are listed");
	switchScope(view, "right");
	setQuery(view, "alpha");
	assert.ok(await waitFor(() => screenOf(view).includes("Searching the archive…")), "the alpha search runs");
	switchScope(view, "left");
	setQuery(view, "beta");
	release();
	assert.ok(await waitFor(() => searches.length === 1 && searches[0]?.query === "alpha"), "the late search settles");
	switchScope(view, "right");
	const stale = screenOf(view);
	assert.equal(view.query, "beta", "the field keeps the new query");
	assert.ok(!stale.includes("alpha body text one"), "the late old search installs no results for the new query");
	assert.match(stale, /Query changed · press Enter or choose Search archive/, "the archive asks for the new query");
	assert.equal(view.actions?.().find((action) => action.label === "Restore")?.disabled, "Select an entry first");
	assert.equal(view.actions?.().find((action) => action.label === "Continue")?.disabled, "The scan has no further page");
	view.handleInput("/");
	view.handleInput("\r");
	assert.ok(await waitFor(() => /End of the archive scan/.test(screenOf(view))), "the new query searches the archive");
	assert.ok(screenOf(view).includes("beta body text two"));
	extendQuery(view, "s");
	assert.equal(view.query, "betas", "an edit after a completed search reaches the view");
	assert.match(screenOf(view), /Query changed · press Enter or choose Search archive/);
	assert.equal(view.actions?.().find((action) => action.label === "Restore")?.disabled, "The archive results are stale; search again first");
	view.handleInput("\r");
	assert.ok(await waitFor(() => (searches.at(-1)?.query === "betas" && /End of the archive scan/.test(screenOf(view)))), "the edited query searches again");
});

test("Refresh retries the selected record's failed read, and Restore stays unavailable until it succeeds", async () => {
	const dir = await mkdtemp(join(tmpdir(), "clipboard-view-"));
	assert.equal(await appendEntry(dir, makeEntry("the exact copied text", "kept label")), null);
	const previewCalls: Array<{ id: string; archiveDate?: string }> = [];
	const restoreCalls: Array<{ id: string; archiveDate?: string }> = [];
	const notices: string[] = [];
	let failedOnce = false;
	const host: ViewHost = { ...viewHost(), notify: (text: string) => notices.push(text) };
	const ops: ClipboardOperations = {
		recent: (signal) => loadRecentEntries(dir, signal),
		search: undefined as never,
		preview: async (entry, signal) => {
			previewCalls.push({ id: entry.id, archiveDate: entry.archiveDate });
			if (!failedOnce) {
				failedOnce = true;
				throw new Error("transient read failure");
			}
			return readExactEntry(dir, entry, PREVIEW_CONTENT_CHARS, signal);
		},
		restore: async (entry, signal) => {
			restoreCalls.push({ id: entry.id, archiveDate: entry.archiveDate });
			await readExactEntry(dir, entry, Number.POSITIVE_INFINITY, signal);
			return { ok: true };
		},
	};
	const view = clipboardView(host, ops, createClipboardViewState()) as Browser<ClipboardEntry>;
	assert.ok(
		await waitFor(() => screenOf(view).includes("The record could not be read: transient read failure")),
		"the failed read is shown",
	);
	assert.equal(view.actions?.().find((action) => action.label === "Restore")?.disabled, "The exact record has not been read yet");
	const selected = view.selected;
	assert.ok(selected);
	act(view, "Refresh");
	assert.ok(await waitFor(() => previewCalls.length === 2), "Refresh retries the exact failed read");
	assert.deepEqual(previewCalls[1], previewCalls[0], "the retry addresses the same id and archive date");
	assert.ok(
		await waitFor(() => view.actions?.().find((action) => action.label === "Restore")?.disabled === undefined),
		"the retried read succeeds and Restore becomes available",
	);
	assert.ok(screenOf(view).includes("Entry "), "the exact record is read");
	act(view, "Restore");
	assert.ok(await waitFor(() => notices.some((notice) => notice.startsWith("Restored (1L/"))), "the restore receipt shows");
	assert.deepEqual(restoreCalls, [{ id: selected.id, archiveDate: selected.archiveDate }], "restore resolves the same exact record");
});
