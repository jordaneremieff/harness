import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { Frame, type View, type ViewHost } from "./frame.ts";
import { markdownView, type MarkdownOperations, type MarkdownRow } from "./operator-view.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
const theme = {
	fg: (_: string, text: string) => text,
	bg: (_: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
} as Theme;
const row = (id: string): MarkdownRow => ({
	kind: "response",
	response: {
		entryId: id,
		preview: `Preview ${id}`,
		bytes: id === "substantial" ? 4096 : 100,
		timestamp: Date.now() - 15 * 60 * 1000,
		stop: "stop",
		completeness: { state: "complete" },
	},
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(
	ops: Omit<MarkdownOperations, "newScratchpad" | "edit"> & Partial<Pick<MarkdownOperations, "newScratchpad" | "edit">>,
) {
	const controller = new AbortController();
	const notices: string[] = [];
	const host: ViewHost = {
		theme,
		target: { id: "captured", label: "Selected conversation" },
		signal: controller.signal,
		requestRender: () => {},
		notify: (message) => notices.push(message),
		push: () => {},
		back: () => {},
		close: () => controller.abort(),
	};
	return {
		view: markdownView(host, { newScratchpad: async () => "new", edit: async () => "edit", ...ops }),
		controller,
		notices,
	};
}
function action(view: View, id: string) {
	const candidate = view.actions?.().find((item) => item.id === id);
	assert.ok(candidate);
	assert.equal(candidate.disabled, undefined);
	candidate.run();
}
test("the view lists prior responses and exposes matching read, recent and published actions", async () => {
	const read: string[] = [];
	const f = fixture({
		load: async () => ({ rows: [row("ack"), row("substantial")], coverage: "2 responses" }),
		read: async (item) => {
			read.push(item.kind === "response" ? item.response.entryId : "document");
			return "opened";
		},
		latest: async () => "latest",
	});
	await tick();
	const screen = f.view.render(120, 24).join("\n");
	assert.match(screen, /substantial/u);
	assert.match(screen, /4\.0 KB · 15m/u);
	assert.match(screen, /100 B · 15m/u);
	assert.match(screen, /Preview only/u);
	assert.deepEqual(
		f.view
			.actions?.()
			.slice(0, 6)
			.map((item) => [item.id, item.key]),
		[
			["read", "enter"],
			["new", "w"],
			["edit", "e"],
			["latest", "l"],
			["recent", "n"],
			["published", "p"],
		],
	);
	assert.equal(read.length, 0, "list, render and initial selection do not reveal");
	action(f.view, "read");
	await tick();
	assert.deepEqual(read, ["ack"]);
	f.controller.abort();
});
test("selection change and view close abort acquisition and drop late outcomes", async () => {
	let release: () => void = () => {};
	let received: AbortSignal | undefined;
	const f = fixture({
		load: async () => ({ rows: [row("one"), row("two")], coverage: "responses" }),
		read: async (_item, signal) => {
			received = signal;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return "late reveal notice";
		},
		latest: async () => "latest",
	});
	await tick();
	f.view.render(120, 24);
	action(f.view, "read");
	f.view.handleInput("\u001b[B");
	assert.equal(received?.aborted, true);
	release();
	await tick();
	assert.ok(!f.notices.includes("late reveal notice"));
	action(f.view, "read");
	f.controller.abort();
	assert.equal(received?.aborted, true);
	release();
	await tick();
	assert.ok(!f.notices.includes("late reveal notice"));
});
test("a published row shows the short stable ID, the revision and the age of its last change", async () => {
	const document: MarkdownRow = {
		kind: "document",
		root: "/store",
		storeId: "store",
		document: {
			id: "md-0123456789abcdef0123",
			title: "Release notes",
			revision: 3,
			bytes: 2048,
			kind: "published",
			digest: "sha256:0",
			updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
		},
	};
	const f = fixture({
		load: async () => ({ rows: [document], coverage: "1 document" }),
		read: async () => "opened",
		latest: async () => "latest",
	});
	await tick();
	const screen = f.view.render(120, 24).join("\n");
	assert.match(screen, /md-01234567 · r3 · 2h {2}Release notes/u);
	f.controller.abort();
});
test("Read latest pressed before the first list arrives completes", async () => {
	let finishLoad: () => void = () => {};
	let received: AbortSignal | undefined;
	let finishRead: () => void = () => {};
	const f = fixture({
		load: () =>
			new Promise((resolve) => {
				finishLoad = () => resolve({ rows: [row("one"), row("two")], coverage: "responses" });
			}),
		read: async () => "read",
		latest: async (signal) => {
			received = signal;
			await new Promise<void>((resolve) => {
				finishRead = resolve;
			});
			return "latest opened";
		},
	});
	await tick();
	action(f.view, "latest");
	finishLoad();
	await tick();
	await tick();
	assert.equal(received?.aborted, false, "the arriving list keeps the read");
	finishRead();
	await tick();
	assert.ok(f.notices.includes("latest opened"));
	f.controller.abort();
});
for (const [change, apply] of [
	[
		"a row change",
		(view: View) => {
			view.handleInput("\u001b[B");
		},
	],
	["a scope change", (view: View) => action(view, "published")],
	[
		"a query change",
		(view: View) => {
			view.handleInput("/");
			view.handleInput("t");
		},
	],
	["a closed view", (_view: View, controller: AbortController) => controller.abort()],
] as const)
	test(`${change} withdraws Read latest`, async () => {
		let received: AbortSignal | undefined;
		let finishRead: () => void = () => {};
		const f = fixture({
			load: async () => ({ rows: [row("one"), row("two")], coverage: "responses" }),
			read: async () => "read",
			latest: async (signal) => {
				received = signal;
				await new Promise<void>((resolve) => {
					finishRead = resolve;
				});
				return "late latest";
			},
		});
		await tick();
		f.view.render(120, 24);
		action(f.view, "latest");
		apply(f.view, f.controller);
		assert.equal(received?.aborted, true);
		finishRead();
		await tick();
		assert.ok(!f.notices.includes("late latest"));
		f.controller.abort();
	});

test("New and Edit require explicit actions and preserve the response copy label", async () => {
	const calls: string[] = [];
	const f = fixture({
		load: async () => ({ rows: [row("original")], coverage: "one response" }),
		read: async () => "read",
		latest: async () => "latest",
		newScratchpad: async () => {
			calls.push("new");
			return "scratchpad requested";
		},
		edit: async (item) => {
			calls.push(item.kind === "response" ? item.response.entryId : "document");
			return "copy requested";
		},
	});
	await tick();
	f.view.render(120, 24);
	assert.deepEqual(calls, []);
	assert.equal(f.view.actions?.().find((item) => item.id === "edit")?.label, "Edit a Copy");
	action(f.view, "new");
	await tick();
	action(f.view, "edit");
	await tick();
	assert.deepEqual(calls, ["new", "original"]);
	f.controller.abort();
});

test("key conflicts, More, and Escape follow the focus in the Markdown frame", () => {
	let closed = 0;
	let effect = 0;
	let typed = "";
	let editing = false;
	const frame = new Frame({
		theme,
		target: { id: "session", label: "This session" },
		expandKey: "ctrl+o",
		rows: (expanded) => (expanded ? 24 : 12),
		requestRender: () => {},
		close: () => closed++,
		open: () => ({
			title: "Markdown",
			render: () => [],
			keys: () => [
				{ keys: ["e"], label: "view key" },
				{ keys: ["pageUp", "pageDown"], label: "page" },
			],
			actions: () => [{ id: "edit", label: "Edit", key: "e", primary: true, run: () => effect++ }],
			editing: () => editing,
			escape: () => {
				if (!editing) return false;
				editing = false;
				return true;
			},
			handleInput: (data) => {
				if (data === "/") editing = true;
				else typed += data;
				return true;
			},
		}),
	});
	const screen = (width = 100) => frame.render(width).join("\n");
	assert.match(screen(), /e view key/);
	assert.doesNotMatch(screen(), /e edit/);
	frame.handleInput("e");
	assert.equal(typed, "e");
	assert.equal(effect, 0);
	frame.handleInput("x");
	assert.match(screen(), /More/);
	frame.handleInput("\r");
	assert.equal(effect, 1);
	frame.handleInput("/");
	frame.handleInput("x");
	assert.equal(typed, "ex");
	assert.match(screen(35), /ctrl\+n more/);
	frame.handleInput("\u000e");
	assert.match(screen(35), /More/);
	frame.handleInput("\u001b");
	assert.equal(editing, true);
	frame.handleInput("\u001b");
	assert.equal(editing, false);
	assert.equal(closed, 0);
	frame.handleInput("\u000f");
	assert.equal(frame.render(100).length, 24);
	frame.handleInput("\u001b");
	assert.equal(closed, 1);
});
