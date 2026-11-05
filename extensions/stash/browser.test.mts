/** The ordinary /stash browser in the shared frame: pickup, notes and lifecycle effects over the real store. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, type ExtensionContext, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { NavigationFrame } from "../../operator-ui/index.ts";
import registerStash from "./index.ts";
import { listStashes, readStash, transitionStash, writeStash } from "./store.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const STASH_ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
const identity = (text: string) => text;
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: identity, italic: identity, underline: identity, strikethrough: identity } as unknown as Theme;

let dir: string;
const saved = ["PI_STASH_DIR", "PI_STASH_CHECKPOINT_DIR", "PI_CODING_AGENT_DIR", "PI_HARNESS_FILE"].map((key) => [key, process.env[key]] as const);

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "stash-browser-test-"));
	delete process.env.PI_STASH_CHECKPOINT_DIR;
	process.env.PI_STASH_DIR = dir;
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_HARNESS_FILE = join(dir, "harness.json");
});

after(async () => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(dir, { recursive: true, force: true });
});

/** The extension over a fake Pi with a working event bus and its own /stash registration. */
function extension(copied: string[] = []) {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const shortcuts = new Map<string, { handler(ctx: ExtensionContext): Promise<void> }>();
	const sent: Array<{ content: string; options?: unknown }> = [];
	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, command),
		registerShortcut: (key: string, shortcut: { handler(ctx: ExtensionContext): Promise<void> }) => shortcuts.set(key, shortcut),
		exec: async () => ({ code: 0, stdout: "main\n", stderr: "", killed: false }),
		sendUserMessage: (content: string, options?: unknown) => sent.push({ content, options }),
		sendMessage: () => {},
		appendEntry: () => {},
		getCommands: () => [...commands.keys()].map((name) => ({ name, source: "extension", sourceInfo: { path: STASH_ENTRY, source: "local", scope: "user", origin: "top-level" } })),
		events: {
			on(name: string, handler: (data: unknown) => void) {
				const set = handlers.get(name) ?? new Set();
				set.add(handler);
				handlers.set(name, set);
				return () => set.delete(handler);
			},
			emit(name: string, data: unknown) {
				for (const handler of [...(handlers.get(name) ?? [])]) handler(data);
			},
		},
		on: () => () => {},
	};
	registerStash(pi as unknown as ExtensionAPI, { copyText: async (text) => void copied.push(text) });
	const command = commands.get("stash");
	const shortcut = shortcuts.get("ctrl+alt+s");
	assert.ok(command && shortcut);
	return { command, shortcut, sent };
}

interface Run {
	readonly frames: number;
	readonly notices: string[];
}

/** A TUI context whose custom UI hosts the frame and runs `script` against it; the script closes or leaves it open. */
let sessions = 0;

function context(script: (frame: NavigationFrame) => Promise<void>, patch: { idle?: boolean; session?: string } = {}) {
	const run = { frames: 0, notices: [] as string[] };
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/workspace",
		isIdle: () => patch.idle ?? true,
		sessionManager: { getSessionId: () => patch.session ?? `browser-session-${++sessions}` },
		ui: {
			notify: (message: string) => run.notices.push(message),
			custom: async <T,>(factory: (tui: unknown, theme: Theme, keys: unknown, done: (value: T) => void) => unknown, options?: { overlay?: boolean }) =>
				new Promise<T>((resolve, reject) => {
					assert.notEqual(options?.overlay, true, "the browser opens in the editor slot below the transcript");
					run.frames++;
					const frame = factory({ terminal: { rows: 40, columns: 120 }, requestRender() {} }, theme, { getKeys: () => [] }, resolve) as NavigationFrame;
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
	};
	return { ctx: ctx as unknown as ExtensionContext, run: run as Run };
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

function act(frame: NavigationFrame, label: string): void {
	const found = action(frame, label);
	assert.equal(found.disabled, undefined, `${label} is unavailable: ${found.disabled}`);
	found.run();
}

/** The footer row as drawn, without colour codes. */
function footer(frame: NavigationFrame, width = 200): string {
	const lines = frame.render(width);
	return stripVTControlCharacters(lines.at(-1) ?? "");
}

/** Click the footer control drawn as `label`, at the position the last render gave it. */
function clickFooter(frame: NavigationFrame, label: string, width = 200): void {
	const lines = frame.render(width);
	const row = stripVTControlCharacters(lines.at(-1) ?? "");
	const at = row.indexOf(label);
	assert.ok(at >= 0, `no footer control ${label} in: ${row}`);
	const event: TuiMouseEvent = { type: "click", button: "left", x: at, y: lines.length - 1, screenX: at, screenY: lines.length - 1, width, height: lines.length, shift: false, alt: false, ctrl: false };
	assert.ok(frame.handleMouse(event)?.handled, `${label} is clickable`);
}

/** Wait until `check` holds, for effects that answer asynchronously. */
async function settled(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Focus the search field with `/`, type a title to filter to it, wait until that exact record was read, and return to the list. */
async function choose(frame: NavigationFrame, record: { id: string; title: string }): Promise<void> {
	await until(frame, /stashes/);
	frame.handleInput("/");
	for (const key of record.title) frame.handleInput(key);
	frame.handleInput("\r");
	await until(frame, new RegExp(`id: ${escapePattern(record.id)}`));
}

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("ordinary stash browser", () => {
	it("opens and closes from the shortcut and the command without pickup, creation or file changes", async () => {
		await writeStash(dir, { title: "Unchanged record", summary: "STAYS" });
		const names = await readdir(dir);
		const before = await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")));
		const { command, shortcut, sent } = extension();
		const { ctx, run } = context(async (frame) => {
			await until(frame, /Unchanged record/);
		});
		await shortcut.handler(ctx);
		await command.handler("", ctx);
		assert.equal(run.frames, 2);
		assert.deepEqual(sent, []);
		assert.deepEqual(await readdir(dir), names);
		assert.deepEqual(await Promise.all(names.map((name) => readFile(join(dir, name), "utf8"))), before);
	});

	for (const idle of [true, false]) {
		it(`picks up the selected record in one message ${idle ? "at once when idle" : "as a follow-up while busy"}, after the browser closes`, async () => {
			const title = `Pickup ${idle ? "idle" : "busy"} ${Date.now()}`;
			const { record } = await writeStash(dir, { title, summary: "SELECTED_HANDOVER" });
			const { command, sent } = extension();
			let sentWhileOpen = -1;
			const { ctx, run } = context(
				async (frame) => {
					await choose(frame, record);
					act(frame, "Pick up");
					sentWhileOpen = sent.length;
				},
				{ idle },
			);
			await command.handler("", ctx);
			assert.equal(sentWhileOpen, 0, "delivery waits until the browser has closed");
			assert.equal(sent.length, 1);
			assert.match(sent[0]?.content ?? "", /SELECTED_HANDOVER/);
			assert.deepEqual(sent[0]?.options, idle ? undefined : { deliverAs: "followUp" });
			assert.equal(run.notices.length, idle ? 0 : 1, "a queued pickup says so");
			const stored = await readStash(dir, record.id);
			assert.ok(stored.ok && /^state: "active"$/m.test(stored.content));
		});
	}

	it("delivers an operator note ahead of the handover; Cancel returns without pickup and an empty note is a plain pickup", async () => {
		const title = `Noted pickup ${Date.now()}`;
		const { record } = await writeStash(dir, { title, summary: "NOTED_HANDOVER" });
		const { command, sent } = extension();
		const cancelled = context(async (frame) => {
			await choose(frame, record);
			act(frame, "Pick up with note…");
			for (const key of "draft note") frame.handleInput(key);
			act(frame, "Cancel");
			await until(frame, new RegExp(escapePattern(title)));
		});
		await command.handler("", cancelled.ctx);
		assert.equal(sent.length, 0, "a cancelled note picks nothing up");
		const unchanged = await readStash(dir, record.id);
		assert.ok(unchanged.ok && /^state: "open"$/m.test(unchanged.content), "a cancelled note activates nothing");
		const noted = context(async (frame) => {
			await choose(frame, record);
			act(frame, "Pick up with note…");
			for (const key of "remember the flag") frame.handleInput(key);
			act(frame, "Pick up");
		});
		await command.handler("", noted.ctx);
		assert.equal(sent.length, 1);
		const content = sent[0]?.content ?? "";
		assert.ok(content.indexOf("remember the flag") >= 0 && content.indexOf("remember the flag") < content.indexOf("NOTED_HANDOVER"), "the note goes ahead of the handover");
		const second = await writeStash(dir, { title: `${title} empty`, summary: "PLAIN_HANDOVER" });
		const plain = context(async (frame) => {
			await choose(frame, second.record);
			act(frame, "Pick up with note…");
			act(frame, "Pick up");
		});
		await command.handler("", plain.ctx);
		assert.equal(sent.length, 2);
		assert.match(sent[1]?.content ?? "", /PLAIN_HANDOVER/);
		assert.ok((await readStash(dir, second.record.id)).ok);
	});

	it("opens one browser for overlapping command and shortcut opens, and opens again after it closes", async () => {
		const { command, shortcut } = extension();
		let inner = 0;
		const { ctx, run } = context(async (frame) => {
			await until(frame, /stashes/);
			await shortcut.handler(ctx);
			await command.handler("", ctx);
			inner = run.frames;
			assert.equal(frame.viewTitle, "Stashes");
		});
		await command.handler("", ctx);
		assert.equal(inner, 1, "a second open moves the open browser instead of opening another");
		await shortcut.handler(ctx);
		assert.equal(run.frames, 2);
	});

	it("reports a UI failure to the caller and shows an unreadable store in the view itself", async () => {
		const { command, shortcut } = extension();
		const failing = {
			mode: "tui",
			hasUI: true,
			cwd: "/workspace",
			isIdle: () => true,
			sessionManager: { getSessionId: () => "browser-session" },
			ui: {
				notify: () => {},
				custom: async () => {
					throw new Error("panel failed");
				},
			},
		} as unknown as ExtensionContext;
		await assert.rejects(shortcut.handler(failing), /panel failed/);
		const previous = process.env.PI_STASH_DIR;
		// A store path that is a file cannot be listed.
		const { path: notADirectory } = await writeStash(dir, { title: "Not a store", summary: "file" });
		process.env.PI_STASH_DIR = notADirectory;
		try {
			const broken = context(async (frame) => {
				await until(frame, /could not be read/);
			});
			await command.handler("", broken.ctx);
			assert.deepEqual(broken.run.notices, [], "the failure stays in the view");
		} finally {
			process.env.PI_STASH_DIR = previous;
		}
	});

	it("rotates only after its confirming form, and the record leaves the listing", async () => {
		const title = `Rotation ${Date.now()}`;
		const { record } = await writeStash(dir, { title, summary: "rotate me" });
		const { command } = extension();
		const { ctx } = context(async (frame) => {
			await choose(frame, record);
			act(frame, "Rotate…");
			assert.ok((await until(frame, /Rotate \S+ to the archive/)).includes(".trash"));
			assert.ok((await listStashes(dir, { limit: 200 })).some((entry) => entry.meta.id === record.id), "nothing moved before the confirming action");
			act(frame, "Rotate");
			await until(frame, /Rotated stash/);
		});
		await command.handler("", ctx);
		assert.ok(!(await listStashes(dir, { limit: 200 })).some((entry) => entry.meta.id === record.id));
	});

	it("copies the resume command without leaving the browser", async () => {
		const title = `Copy ${Date.now()}`;
		const { record } = await writeStash(dir, { title, summary: "copy me" });
		const copied: string[] = [];
		const { command, sent } = extension(copied);
		const { ctx } = context(async (frame) => {
			await choose(frame, record);
			act(frame, "Copy resume command");
			await until(frame, /Copied pi/);
			assert.equal(frame.viewTitle, "Stashes", "copying leaves the browser open");
		});
		await command.handler("", ctx);
		assert.deepEqual(copied, [`pi "/stash get ${record.id}"`]);
		assert.deepEqual(sent, []);
	});

	it("shows the keyed controls in the footer, and a click on copy runs the same copy as its key", async () => {
		const title = `Footer ${Date.now()}`;
		const { record } = await writeStash(dir, { title, summary: "footer copy" });
		const copied: string[] = [];
		const { command, sent } = extension(copied);
		const { ctx } = context(async (frame) => {
			await choose(frame, record);
			const row = footer(frame);
			for (const control of ["enter pick up", "a note", "c copy", "h help", "r refresh", "x more", "esc close"])
				assert.ok(row.includes(control), `${control} in: ${row}`);
			clickFooter(frame, "c copy");
			await until(frame, /Copied pi/);
			frame.handleInput("c");
			await settled(() => copied.length === 2);
			assert.equal(frame.viewTitle, "Stashes", "copying leaves the browser open");
		});
		await command.handler("", ctx);
		assert.deepEqual(copied, [`pi "/stash get ${record.id}"`, `pi "/stash get ${record.id}"`], "the click and the key copy the same command");
		assert.deepEqual(sent, []);
	});

	it("cancels a note from its key and from its footer control without picking up", async () => {
		const title = `Note cancel ${Date.now()}`;
		const { record } = await writeStash(dir, { title, summary: "NOTE_CANCEL" });
		const { command, sent } = extension();
		const cancelFrom = (open: (frame: NavigationFrame) => void) =>
			context(async (frame) => {
				await choose(frame, record);
				open(frame);
				await until(frame, /Pick up with note/);
				frame.handleInput("\u001b");
				await settled(() => frame.viewTitle === "Stashes");
				assert.equal(frame.viewTitle, "Stashes", "Cancel returns to the browser");
			});
		await command.handler("", cancelFrom((frame) => frame.handleInput("a")).ctx);
		await command.handler("", cancelFrom((frame) => clickFooter(frame, "a note")).ctx);
		assert.equal(sent.length, 0, "a cancelled note picks nothing up");
		const stored = await readStash(dir, record.id);
		assert.ok(stored.ok && /^state: "open"$/m.test(stored.content), "a cancelled note activates nothing");
	});

	it("closes an active record with a required outcome and releases another back to open", async () => {
		const closing = await writeStash(dir, { title: `Closing ${Date.now()}`, summary: "active work" });
		const releasing = await writeStash(dir, { title: `Releasing ${Date.now()}`, summary: "active work" });
		await transitionStash(dir, closing.record.id, { action: "activate" });
		await transitionStash(dir, releasing.record.id, { action: "activate" });
		const { command, sent } = extension();
		const { ctx } = context(async (frame) => {
			await choose(frame, closing.record);
			const row = footer(frame);
			for (const control of ["enter pick up", "a note", "o close stash", "c copy", "h help", "r refresh", "x more", "esc close"])
				assert.ok(row.includes(control), `${control} in: ${row}`);
			act(frame, "Close with outcome…");
			act(frame, "Close stash");
			await until(frame, /Write the concrete outcome first\./);
			for (const key of "Shipped the fix.") frame.handleInput(key);
			act(frame, "Close stash");
			await until(frame, /Closed stash/);
		});
		await command.handler("", ctx);
		const closed = await readStash(dir, closing.record.id);
		assert.ok(closed.ok && /^state: "closed"$/m.test(closed.content) && closed.content.includes("Shipped the fix."));
		const release = context(async (frame) => {
			await choose(frame, releasing.record);
			act(frame, "Release…");
			act(frame, "Release");
			await until(frame, /Released stash/);
		});
		await command.handler("", release.ctx);
		const released = await readStash(dir, releasing.record.id);
		assert.ok(released.ok && /^state: "open"$/m.test(released.content));
		assert.deepEqual(sent, [], "no lifecycle change starts conversation work");
	});

	it("offers no lifecycle action for an unknown state and picks nothing up", async () => {
		const id = "20270725T000000Z-invalid-browser";
		await writeFile(join(dir, `${id}.md`), '---\ntitle: "Unknown record"\nstate: "mystery"\n---\nbody\n', "utf8");
		const { command, sent } = extension();
		const { ctx } = context(async (frame) => {
			await choose(frame, { id, title: "Unknown record" });
			assert.match(text(frame), /unknown \(mystery\)/);
			const labels = frame.viewActions.map((candidate) => candidate.label);
			for (const label of ["Pick up", "Pick up with note…", "Close with outcome…", "Release…", "Reopen…", "Rotate…"]) assert.ok(!labels.includes(label), `${label} must not be offered`);
			assert.ok(labels.includes("Copy resume command"), "the resume command stays available");
		});
		await command.handler("", ctx);
		assert.equal(sent.length, 0);
	});

	it("offers Reopen instead of pickup for a closed record, and keeps the filter text while acting", async () => {
		const title = `Closed ${Date.now()}`;
		const { record } = await writeStash(dir, { title, summary: "done" });
		await transitionStash(dir, record.id, { action: "close", outcome: "Finished." });
		const { command } = extension();
		const { ctx } = context(async (frame) => {
			await choose(frame, record);
			const row = footer(frame);
			for (const control of ["enter reopen", "c copy", "h help", "r refresh", "x more", "esc close"])
				assert.ok(row.includes(control), `${control} in: ${row}`);
			const labels = frame.viewActions.map((candidate) => candidate.label);
			assert.ok(!labels.includes("Pick up"), "a closed record never offers pickup");
			act(frame, "Reopen…");
			act(frame, "Reopen");
			await until(frame, /Reopened stash/);
			assert.match(text(frame), new RegExp(escapePattern(title)), "the filter still shows the record");
		});
		await command.handler("", ctx);
		const reopened = await readStash(dir, record.id);
		assert.ok(reopened.ok && /^state: "open"$/m.test(reopened.content));
	});
});
