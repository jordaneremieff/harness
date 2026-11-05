import assert from "node:assert/strict";
import { it } from "node:test";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { type ExtensionContext, initTheme, type SlashCommandInfo, type Theme } from "@earendil-works/pi-coding-agent";
import type { NavigationFrame } from "./frame.ts";
import {
	collectOperatorViews,
	dispatchCommand,
	type FrameApi,
	frameRows,
	OPERATOR_VIEW_PUBLISH,
	openOperatorFrame,
	ordinaryTarget,
	publishOperatorViews,
	readPublication,
	resolveOwner,
} from "./ordinary.ts";
import type { OperatorView } from "./view.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

type Handler = (data: unknown) => void;

function bus() {
	const handlers = new Map<string, Set<Handler>>();
	return {
		on(name: string, handler: Handler) {
			const set = handlers.get(name) ?? new Set<Handler>();
			set.add(handler);
			handlers.set(name, set);
			return () => set.delete(handler);
		},
		emit(name: string, data: unknown) {
			for (const handler of [...(handlers.get(name) ?? [])]) handler(data);
		},
	};
}

function command(name: string, path: string): SlashCommandInfo {
	return { name, source: "extension", sourceInfo: { path, source: "local", scope: "user", origin: "top-level" } } as unknown as SlashCommandInfo;
}

function pi(commands: SlashCommandInfo[] = []) {
	const events = bus();
	const sent: string[] = [];
	const shutdown: Array<() => void> = [];
	const api = {
		events,
		getCommands: () => commands,
		on: (name: string, handler: () => void) => {
			if (name === "session_shutdown") shutdown.push(handler);
		},
		sendUserMessage: (text: string) => sent.push(text),
	};
	return { api: api as unknown as FrameApi & { sendUserMessage(text: string): void }, sent, shutdown, commands };
}

const view = (title: string): OperatorView => ({ title, render: (_width, height) => Array.from({ length: height }, () => title), handleInput: () => false });

it("a publication of another version or a malformed view is refused, never guessed", () => {
	assert.equal(readPublication({ version: 1, owner: "/x", views: [] }), undefined);
	assert.equal(readPublication({ version: 2, owner: "", views: [] }), undefined);
	const read = readPublication({
		version: 2,
		owner: "/owner/index.ts",
		views: [
			{ id: "ok", label: "Fine", command: { name: "fine" }, view: () => view("Fine") },
			{ id: "Bad Id", label: "Bad", command: { name: "bad" }, view: () => view("Bad") },
			{ id: "long", label: "x".repeat(30), command: { name: "long" }, view: () => view("Long") },
			{ id: "nocommand", label: "No command", view: () => view("No command") },
			{ id: "noview", label: "No view", command: { name: "noview" } },
		],
	});
	assert.deepEqual(read?.views.map((entry) => entry.id), ["ok"], "a view without content is refused too");
});

it("collected views follow publications in both load orders and stop after dispose", () => {
	const host = pi();
	publishOperatorViews(host.api, { version: 2, owner: "/early.ts", views: [{ id: "early", label: "Early", command: { name: "early" }, order: 20, view: () => view("Early") }] });
	const registry = collectOperatorViews(host.api.events);
	assert.deepEqual(registry.views().map((entry) => entry.id), ["early"], "a consumer that loads later asks and receives");
	publishOperatorViews(host.api, { version: 2, owner: "/late.ts", views: [{ id: "late", label: "Late", command: { name: "late" }, order: 10, view: () => view("Late") }] });
	assert.deepEqual(registry.views().map((entry) => entry.id), ["late", "early"], "views sort by order");
	host.api.events.emit(OPERATOR_VIEW_PUBLISH, { version: 2, owner: "/late.ts", views: [] });
	assert.deepEqual(registry.views().map((entry) => entry.id), ["early"], "a publication replaces that owner's views only");
	registry.dispose();
	publishOperatorViews(host.api, { version: 2, owner: "/third.ts", views: [{ id: "third", label: "Third", command: { name: "third" }, view: () => view("Third") }] });
	assert.deepEqual(registry.views().map((entry) => entry.id), ["early"]);
});

it("a destination binds to its owner's single registration of the command", () => {
	const view = { owner: "/owner/index.ts", command: { name: "stash" } };
	assert.ok("registration" in resolveOwner(view, [command("stash", "/owner/index.ts")]));
	assert.ok("registration" in resolveOwner(view, [command("stash:2", "/owner/index.ts"), command("stash", "/other/index.ts")]), "Pi's collision suffix still resolves to the owner");
	const missing = resolveOwner(view, [command("stash", "/other/index.ts")]);
	assert.ok("unavailable" in missing && /not registered by its owner/.test(missing.unavailable));
	const twice = resolveOwner(view, [command("stash", "/owner/index.ts"), command("stash:2", "/owner/index.ts")]);
	assert.ok("unavailable" in twice && /more than once/.test(twice.unavailable));
});

it("dispatch sends the command only while its exact registration is current", () => {
	const registration = command("agent", "/agent/index.ts");
	const host = pi([registration]);
	assert.deepEqual(dispatchCommand(host.api, registration, " browse "), { kind: "sent", line: "/agent browse" });
	assert.deepEqual(host.sent, ["/agent browse"]);
	host.commands.splice(0, 1, command("agent", "/replaced/index.ts"));
	assert.deepEqual(dispatchCommand(host.api, registration, ""), { kind: "changed" });
	assert.deepEqual(host.sent, ["/agent browse"], "a replaced registration sends nothing");
});

it("the inline frame keeps transcript rows above it and expands within bounds", () => {
	assert.equal(frameRows(40, false), 24);
	assert.equal(frameRows(40, true), 36);
	assert.equal(frameRows(10, false), 8, "a small window still gets a usable frame");
	assert.ok(frameRows(100, false) <= 94);
});

it("the ordinary target names this session and its folder", () => {
	const ctx = { cwd: "/work/projects/harness", sessionManager: { getSessionId: () => "session-1" } } as unknown as ExtensionContext;
	assert.deepEqual(ordinaryTarget(ctx), { id: "session-1", label: "This session · harness" });
});

function tuiContext(mounted: { frame?: NavigationFrame; done?: () => void }) {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/work",
		sessionManager: { getSessionId: () => "session-1" },
		ui: {
			notify: () => {},
			custom: (factory: (tui: unknown, theme: Theme, keys: unknown, done: (value: undefined) => void) => NavigationFrame) =>
				new Promise<undefined>((resolve) => {
					mounted.frame = factory({ terminal: { rows: 40, columns: 100 }, requestRender: () => {} }, theme, {}, (value) => resolve(value));
					mounted.done = () => resolve(undefined);
				}),
		},
	} as unknown as ExtensionContext;
}

it("an open frame navigates instead of opening a second one, and close runs its continuation after the editor returns", async () => {
	const host = pi([command("one", "/one.ts"), command("two", "/two.ts")]);
	publishOperatorViews(host.api, { version: 2, owner: "/one.ts", views: [{ id: "one", label: "One", command: { name: "one" }, view: () => view("One") }] });
	publishOperatorViews(host.api, { version: 2, owner: "/two.ts", views: [{ id: "two", label: "Two", command: { name: "two" }, view: () => view("Two") }] });
	const mounted: { frame?: NavigationFrame } = {};
	const ctx = tuiContext(mounted);
	const opened = openOperatorFrame(host.api, ctx, { owner: "/one.ts", id: "one" });
	assert.equal(mounted.frame?.viewTitle, "One");
	const frame = mounted.frame;
	await openOperatorFrame(host.api, ctx, { owner: "/two.ts", id: "two" });
	assert.equal(mounted.frame, frame, "no second frame opened");
	assert.equal(frame?.viewTitle, "Two", "the open frame moved to the requested destination");
	const order: string[] = [];
	frame?.close(() => order.push("continuation"));
	order.push("closed");
	await opened;
	assert.deepEqual(order, ["closed", "continuation"], "the continuation runs after the custom view resolves");
});

it("outside the interactive terminal the frame only explains itself", async () => {
	const notes: string[] = [];
	const ctx = { mode: "print", hasUI: true, ui: { notify: (text: string) => notes.push(text) } } as unknown as ExtensionContext;
	await openOperatorFrame(pi().api, ctx, { owner: "/one.ts", id: "one" });
	assert.deepEqual(notes, ["This view needs the interactive terminal."]);
});

it("session shutdown closes an open frame", async () => {
	const host = pi([command("one", "/one.ts")]);
	publishOperatorViews(host.api, { version: 2, owner: "/one.ts", views: [{ id: "one", label: "One", command: { name: "one" }, view: () => view("One") }] });
	const mounted: { frame?: NavigationFrame } = {};
	const opened = openOperatorFrame(host.api, tuiContext(mounted), { owner: "/one.ts", id: "one" });
	assert.equal(host.shutdown.length, 1);
	host.shutdown[0]?.();
	await opened;
	assert.equal(mounted.frame?.viewTitle, undefined, "the frame disposed its views");
});
