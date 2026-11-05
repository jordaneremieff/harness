/** Archive search in the ordinary stash browser: bounded pages, Continue, stale cursors and the exact pickup. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { NavigationFrame } from "../../operator-ui/index.ts";
import registerStash from "./index.ts";
import { listStashes, writeStash } from "./store.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const STASH_ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
const identity = (text: string) => text;
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: identity, italic: identity, underline: identity, strikethrough: identity } as unknown as Theme;

let dir = "";
let ancientId = "";
let saved: string | undefined;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "stash-archive-browser-"));
	saved = process.env.PI_STASH_DIR;
	process.env.PI_STASH_DIR = dir;
	await seed();
});
after(async () => {
	if (saved === undefined) delete process.env.PI_STASH_DIR;
	else process.env.PI_STASH_DIR = saved;
	await rm(dir, { recursive: true, force: true });
});

function command() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const sent: string[] = [];
	registerStash({
		events: {
			on(name: string, listener: (data: unknown) => void) {
				const set = handlers.get(name) ?? new Set();
				set.add(listener);
				handlers.set(name, set);
				return () => set.delete(listener);
			},
			emit(name: string, data: unknown) {
				for (const listener of [...(handlers.get(name) ?? [])]) listener(data);
			},
		},
		getCommands: () => [{ name: "stash", source: "extension", sourceInfo: { path: STASH_ENTRY, source: "local", scope: "user", origin: "top-level" } }],
		registerTool: () => {},
		registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			if (name === "stash") handler = definition.handler;
		},
		registerShortcut: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false, truncated: false }),
		sendUserMessage: (content: string) => {
			sent.push(content);
		},
		sendMessage: () => {},
		appendEntry: () => {},
		on: () => {},
	} as unknown as ExtensionAPI);
	assert.ok(handler);
	return { handler, sent };
}

/** A TUI context whose custom UI hosts the frame and runs the script; the frame closes after it. */
function drive(script: (frame: NavigationFrame) => Promise<void>) {
	return {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		cwd: "/workspace",
		sessionManager: { getSessionId: () => `archive-${Math.random()}` },
		ui: {
			notify: () => {},
			custom: <T,>(factory: (tui: unknown, theme: Theme, keys: unknown, done: (value: T) => void) => unknown) =>
				new Promise<T>((resolve, reject) => {
					const frame = factory({ terminal: { rows: 40, columns: 120 }, requestRender: () => {} }, theme, { getKeys: () => [] }, resolve) as NavigationFrame;
					script(frame).then(
						() => frame.close(),
						(error: unknown) => {
							// Reject first: closing resolves the custom view, and a settled promise ignores a later rejection.
							reject(error);
							frame.close();
						},
					);
				}),
		},
	} as unknown as ExtensionContext;
}

const text = (frame: NavigationFrame) => frame.render(120).join("\n");

/** Store reads are file I/O, so waits poll the rendered browser against a deadline instead of counting turns. */
async function until(frame: NavigationFrame, pattern: RegExp): Promise<string> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const shown = text(frame);
		if (pattern.test(shown)) return shown;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`the browser never showed ${pattern}\n${text(frame)}`);
}

function action(frame: NavigationFrame, label: string) {
	const found = frame.viewActions.find((candidate) => candidate.label === label);
	assert.ok(found, `no ${label}: ${frame.viewActions.map((candidate) => candidate.label).join(", ")}`);
	return found;
}

/** Move from the list to the scope row and step right to Search archive. */
function archiveScope(frame: NavigationFrame): void {
	frame.handleInput("\u001b[Z");
	frame.handleInput("\u001b[C");
	frame.handleInput("\r");
}

/** Focus the search field with `/`, type a query, and press Enter, which runs the archive search. */
function search(frame: NavigationFrame, query: string): void {
	frame.handleInput("/");
	for (const key of query) frame.handleInput(key);
	frame.handleInput("\r");
}

async function seed(): Promise<void> {
	const old = await writeStash(dir, { title: "Ancient effort", summary: `${"filler ".repeat(6000)} deep-archive-needle` }, new Date("2020-01-01T00:00:00Z"));
	ancientId = old.record.id;
	for (let index = 0; index < 300; index++) {
		await writeFile(join(dir, `20260101T${String(index).padStart(6, "0")}Z-recent-${index}.md`), `---\ntitle: "Recent ${index}"\nstate: "open"\ncreated: "20260101T000000Z"\ntags: []\n---\nbody\n`, "utf8");
	}
}

describe("stash archive browsing", () => {
	it("follows an empty bounded page with Continue to a match beyond the preload, then picks up the exact record", async () => {
		const { handler, sent } = command();
		await handler("", drive(async (frame) => {
			assert.match(await until(frame, /200 stashes \(newest 200\)/), /Recent/);
			archiveScope(frame);
			await until(frame, /Type text, then press Enter/);
			search(frame, "deep-archive-needle");
			const first = await until(frame, /coverage partial/);
			assert.match(first, /no matches on this page/);
			assert.equal(action(frame, "Continue").disabled, undefined);
			action(frame, "Continue").run();
			const found = await until(frame, /Ancient effort/);
			assert.match(found, /2020-01-01/);
			await until(frame, /coverage complete/);
			await until(frame, new RegExp(`id: ${ancientId}`));
			action(frame, "Pick up").run();
		}));
		assert.equal(sent.length, 1);
		assert.ok(sent[0]?.includes(ancientId));
		assert.match(sent[0] ?? "", /deep-archive-needle/);
	});

	it("marks a store change under a held cursor as stale, offers Refresh, and blocks every effect", async () => {
		const { handler, sent } = command();
		const before = (await listStashes(dir, { limit: 400 })).length;
		await handler("", drive(async (frame) => {
			await until(frame, /stashes/);
			archiveScope(frame);
			search(frame, "deep-archive-needle");
			await until(frame, /coverage partial/);
			await writeStash(dir, { title: "Arrives mid-query", summary: "new" }, new Date("2026-06-01T00:00:00Z"));
			action(frame, "Continue").run();
			await until(frame, /Stale:/);
			assert.match(text(frame), /Refresh restarts/);
			assert.equal(typeof action(frame, "Continue").disabled, "string", "a stale cursor reads no further page");
			assert.equal(action(frame, "Refresh").disabled, undefined);
		}));
		assert.equal(sent.length, 0);
		assert.ok((await listStashes(dir, { limit: 400 })).length > before);
	});

	it("leaving the archive search without a query keeps the recent view and changes nothing", async () => {
		const { handler, sent } = command();
		await handler("", drive(async (frame) => {
			await until(frame, /stashes/);
			archiveScope(frame);
			await until(frame, /Type text, then press Enter/);
			frame.handleInput("\u001b[Z");
			frame.handleInput("\u001b[D");
			frame.handleInput("\r");
			await until(frame, /200 stashes/);
		}));
		assert.equal(sent.length, 0);
	});
});
