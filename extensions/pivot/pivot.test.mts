import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	SessionEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import pivot from "./index.ts";

function fixture() {
	const hooks = new Map<string, unknown>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const shortcuts = new Map<string, Parameters<ExtensionAPI["registerShortcut"]>[1]>();
	const clipboard: string[] = [];
	const notifications: string[] = [];
	let entries: SessionEntry[] = [];
	const state = {
		cwd: "/work",
		dir: "/test/sessions",
		file: undefined as string | undefined,
		id: "session-a",
		parent: undefined as string | undefined,
		ui: true,
		flag: false,
		copyError: undefined as Error | undefined,
	};
	const ctx = {
		get cwd() {
			return state.cwd;
		},
		get hasUI() {
			return state.ui;
		},
		ui: { notify: (text: string) => notifications.push(text) },
		sessionManager: {
			getSessionFile: () => state.file,
			getSessionDir: () => state.dir,
			getSessionId: () => state.id,
			getHeader: () => ({ id: state.id, parentSession: state.parent }),
			getEntries: () => entries,
		},
	} as unknown as ExtensionContext;
	function load() {
		const api = {
			on: (name: string, handler: unknown) => hooks.set(name, handler),
			registerCommand: (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
				commands.set(name, options),
			registerShortcut: (key: string, options: Parameters<ExtensionAPI["registerShortcut"]>[1]) =>
				shortcuts.set(key, options),
			registerFlag: () => {},
			getFlag: (name: string) => name === "pivot" && state.flag,
			appendEntry: (customType: string, data: unknown) => {
				entries = [...entries, { type: "custom", customType, data, id: "intent", parentId: null, timestamp: "" }];
			},
		};
		pivot(api as unknown as ExtensionAPI, async (text) => {
			if (state.copyError) throw state.copyError;
			clipboard.push(text);
		});
	}
	load();
	return {
		clipboard,
		notifications,
		state,
		load,
		entries: () => entries,
		rememberMessage: (content: string) => {
			entries = [
				...entries,
				{
					type: "message",
					id: "message",
					parentId: null,
					timestamp: "",
					message: { role: "user", content, timestamp: 0 },
				},
			];
		},
		start: (reason: SessionStartEvent["reason"]) => {
			const handler = hooks.get("session_start") as (event: SessionStartEvent, ctx: ExtensionContext) => void;
			handler({ type: "session_start", reason }, ctx);
		},
		input: (text: string, source: InputEvent["source"] = "interactive", images?: InputEvent["images"]) => {
			const handler = hooks.get("input") as (event: InputEvent, ctx: ExtensionContext) => InputEventResult | undefined;
			return handler({ type: "input", text, source, images }, ctx);
		},
		command: () => commands.get("pivot")?.handler("", ctx as ExtensionCommandContext),
		shortcut: () => shortcuts.get("ctrl+alt+n")?.handler(ctx),
	};
}

test("command and shortcut copy a launch with shell-safe cwd, session path and session directory", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pivot-command-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const harness = fixture();
	harness.state.cwd = join(root, "project's space $(false)");
	harness.state.dir = join(root, "sessions' dir");
	harness.state.file = join(harness.state.dir, "source's session.jsonl");
	await mkdir(harness.state.cwd);
	await mkdir(harness.state.dir);
	await writeFile(harness.state.file, "{}");
	await harness.command();
	await harness.shortcut();
	const [command, shortcut] = harness.clipboard;
	assert.ok(command);
	assert.equal(command, shortcut);
	const { stdout } = await promisify(execFile)("/bin/sh", ["-c", `pi() { printf '%s\\0' "$PWD" "$@"; }; ${command}`]);
	assert.deepEqual(stdout.split("\0").slice(0, -1), [
		harness.state.cwd,
		"--fork",
		harness.state.file,
		"--session-dir",
		harness.state.dir,
		"--pivot",
	]);
	assert.match(harness.notifications.at(-1) ?? "", /Paste the pivot command/);
	const copies = harness.clipboard.length;
	harness.state.copyError = new Error("clipboard unavailable");
	await harness.command();
	assert.equal(harness.clipboard.length, copies);
	assert.match(harness.notifications.at(-1) ?? "", /Could not copy the pivot command.*clipboard unavailable/);
});

test("does not touch the clipboard when a session is unsaved or the caller has no UI", async () => {
	const harness = fixture();
	await harness.command();
	assert.match(harness.notifications[0] ?? "", /no saved session/);
	harness.state.ui = false;
	await harness.command();
	assert.equal(harness.notifications.length, 1);
	assert.deepEqual(harness.clipboard, []);
});

test("frames the first real input after slash commands, RPC, extension input and reload", () => {
	const harness = fixture();
	harness.state.parent = "/test/source.jsonl";
	harness.state.flag = true;
	harness.start("startup");
	assert.equal(harness.entries().length, 1);
	assert.equal(harness.input("/model"), undefined);
	assert.equal(harness.input("  /skill:read"), undefined);
	assert.equal(harness.input("send through RPC", "rpc"), undefined);
	assert.equal(harness.input("send through extension", "extension"), undefined);
	assert.equal(harness.input("  "), undefined);
	harness.state.ui = false;
	assert.equal(harness.input("headless Pi labels input interactive"), undefined);
	harness.state.ui = true;

	harness.load();
	harness.start("reload");
	const result = harness.input("New question");
	assert.equal(result?.action, "transform");
	assert.match(result.text, /background only/);
	assert.match(result.text, /Do not resume work from the parent session/);
	assert.ok(result.text.endsWith("\n\nNew question"));
	assert.equal(harness.input("Next question"), undefined);

	harness.rememberMessage(result.text);
	harness.state.flag = false;
	harness.load();
	harness.start("startup");
	assert.equal(harness.input("Reopen after the framed prompt"), undefined);
	assert.equal(harness.entries().length, 2);
});

test("a resumed pivot accepts image-only input and lets Pi retain the attachment", () => {
	const harness = fixture();
	harness.state.parent = "/test/source.jsonl";
	harness.state.flag = true;
	harness.start("startup");
	harness.state.flag = false;
	harness.load();
	harness.start("resume");
	const result = harness.input("", "interactive", [{ type: "image", data: "AA==", mimeType: "image/png" }]);
	assert.equal(result?.action, "transform");
	assert.match(result.text, /background only/);
	assert.equal(result.images, undefined);
});

test("lineage, an inherited intent and a flag from another launch do not arm plain children", () => {
	const harness = fixture();
	harness.state.flag = true;
	harness.start("startup");
	assert.equal(harness.input("Root with flag"), undefined);
	harness.state.parent = "/test/source.jsonl";
	harness.state.flag = false;
	harness.start("startup");
	assert.equal(harness.input("Plain CLI fork"), undefined);
	harness.state.flag = true;
	harness.start("startup");
	assert.equal(harness.entries().length, 1);

	harness.state.id = "session-b";
	harness.start("fork");
	assert.equal(harness.input("Fork or clone inside the same Pi process"), undefined);
	harness.state.id = "session-c";
	harness.start("new");
	assert.equal(harness.input("Extension-created child inside that process"), undefined);
	harness.state.flag = false;
	harness.start("startup");
	assert.equal(harness.input("Plain CLI fork with inherited intent"), undefined);
	assert.equal(harness.entries().length, 1);
});
