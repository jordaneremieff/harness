import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import markdown, { ordinaryLifecycle, ordinaryOperations, readerUpdates } from "./index.ts";
import type { checkReader } from "./reader-update.ts";

type CheckReader = typeof checkReader;
import { MarkdownStore } from "./store.ts";

for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) {
	test(`${event} withdraws an ordinary read during acquisition; a later read succeeds`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "markdown-lifecycle-"));
		const environment = { PI_MARKDOWN_DIR: process.env.PI_MARKDOWN_DIR, PI_HARNESS_FILE: process.env.PI_HARNESS_FILE };
		process.env.PI_MARKDOWN_DIR = join(root, "store");
		process.env.PI_HARNESS_FILE = join(root, "harness.json");
		try {
			const handlers = new Map<string, () => void>();
			const lifecycle = ordinaryLifecycle({ on: (name: string, handler: () => void) => { handlers.set(name, handler); } } as unknown as Pick<ExtensionAPI, "on">);
			const source = { getLeafId: () => "response", getSessionId: () => "session", getCwd: () => root,
				getEntry: () => ({ type: "message", id: "response", parentId: null, timestamp: new Date().toISOString(), message: fauxAssistantMessage("Exact retained response") }),
			};
			const operations = ordinaryOperations({ mode: "print", sessionManager: source } as unknown as ExtensionContext, lifecycle);
			const signal = new AbortController().signal;
			const list = await operations.load("recent", signal);
			const store = new MarkdownStore(process.env.PI_MARKDOWN_DIR);
			await store.initialise();
			const snapshot = t.mock.method(MarkdownStore.prototype, "snapshot");
			const request = t.mock.method(MarkdownStore.prototype, "writeOpenRequest");
			const pending = operations.read(list.rows[0], signal);
			const withdraw = handlers.get(event);
			assert.ok(withdraw);
			withdraw();
			await assert.rejects(pending, /abort/iu);
			assert.equal(signal.aborted, false, "the view signal stays live");
			assert.equal(snapshot.mock.callCount(), 0);
			assert.equal(request.mock.callCount(), 0);
			assert.deepEqual(await readdir(join(store.root, "snapshots")), []);
			assert.deepEqual(await readdir(join(store.root, "opens")), []);
			assert.match(await operations.read(list.rows[0], signal), /^Saved .*No window was opened\.$/u);
			assert.equal(snapshot.mock.callCount(), 1);
			assert.equal(request.mock.callCount(), 0);
		} finally {
			for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("headless commands notify without session messages or stdout and resolve both stored collections", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "markdown-command-"));
	const environment = { PI_MARKDOWN_DIR: process.env.PI_MARKDOWN_DIR, PI_MARKDOWN_APP: process.env.PI_MARKDOWN_APP, PI_HARNESS_FILE: process.env.PI_HARNESS_FILE };
	process.env.PI_MARKDOWN_DIR = join(root, "store");
	process.env.PI_MARKDOWN_APP = join(root, "missing.app");
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	try {
		let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
		let shortcut: ((ctx: ExtensionContext) => Promise<void>) | undefined;
		const messages = t.mock.fn();
		const stdout = t.mock.method(console, "log", () => {});
		const notify = t.mock.fn();
		const registered: string[] = [];
		const pi = { events: createEventBus(), on: () => {}, registerShortcut: (_key: string, definition: { handler: typeof shortcut }) => { shortcut = definition.handler; }, registerTool: ({ name }: { name: string }) => registered.push(name), sendMessage: messages,
			registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
		} as unknown as ExtensionAPI;
		markdown(pi);
		assert.ok(handler);
		assert.ok(registered.includes("markdown_brief"));
		const source = { getLeafId: () => "response", getSessionId: () => "session", getCwd: () => root,
			getEntry: () => ({ type: "message", id: "response", parentId: null, timestamp: new Date().toISOString(), message: fauxAssistantMessage("Exact retained response") }),
		};
		const context = (mode: string) => ({ mode, cwd: root, sessionManager: source, ui: { notify } }) as unknown as ExtensionContext;
		for (const mode of ["print", "json", "rpc"]) {
			await handler("", context(mode));
			assert.match(notify.mock.calls.at(-1)?.arguments[0] ?? "", { print: /^Saved md-[a-f0-9]{8} revision 1\. No window was opened\.$/u, json: /^Selected md-[a-f0-9]{8} revision 1\. No window was opened\.$/u, rpc: /^Selected md-[a-f0-9]{8} revision 1\. No window was opened\.$/u }[mode] as RegExp);
		}
		const store = new MarkdownStore(process.env.PI_MARKDOWN_DIR);
		const snapshot = (await store.list({ kind: "response" })).documents[0];
		assert.equal((await store.get(snapshot.id)).source, "Exact retained response");
		const published = await store.create({ title: "Published", source: "Deliberate document", contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() } });
		const lookups = [snapshot.id, published.document.id].flatMap((id) => [[id, id], [id, id.slice(0, -1)]]);
		for (const [id, lookup] of lookups) {
			await handler(lookup, context("json"));
			assert.equal(notify.mock.calls.at(-1)?.arguments[0], `Selected ${id.slice(0, 11)} revision 1. No window was opened.`);
		}
		await handler("help file", context("json"));
		assert.match(notify.mock.calls.at(-1)?.arguments[0] ?? "", /\/markdown file <path>\nCapture and read/u);
		assert.equal(notify.mock.calls.at(-1)?.arguments[1], "info");
		for (const word of ["Recent", "md-xyz"]) {
			await handler(word, context("json"));
			assert.deepEqual(notify.mock.calls.at(-1)?.arguments, ["Usage: /markdown new | recent | published | edit <id> | edit file <path> | copy <id> | <id> | file <path> | window [new|edit|copy|file|<id>] | update | help [command]", "error"]);
		}
		for (const argument of ["window", `window ${published.document.id}`]) {
			await handler(argument, context("json"));
			assert.match(notify.mock.calls.at(-1)?.arguments[0] ?? "", /No window was opened\.$/u);
			assert.equal(notify.mock.calls.at(-1)?.arguments[1], "info");
		}
		assert.ok(shortcut);
		await shortcut(context("json"));
		assert.equal(notify.mock.calls.at(-1)?.arguments[0], `Selected ${snapshot.id.slice(0, 11)} revision 1. No window was opened.`);
		assert.equal(notify.mock.callCount(), 13);
		for (const argument of ["new", `edit ${published.document.id}`, `copy ${snapshot.id}`, "edit file notes.md", "window new", `window edit ${published.document.id}`]) {
			await handler(argument, context("json"));
			assert.equal(notify.mock.calls.at(-1)?.arguments[1], "error");
			assert.match(notify.mock.calls.at(-1)?.arguments[0] ?? "", /operator view or native app/u);
		}
		assert.equal((await store.list()).documents.length, 1);
		assert.equal((await store.get(snapshot.id)).source, "Exact retained response");
		assert.equal(messages.mock.callCount(), 0);
		assert.equal(stdout.mock.callCount(), 0);
	} finally {
		for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await rm(root, { recursive: true, force: true });
	}
});

test("the file command reads a path under the home directory written with a leading tilde", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "markdown-home-"));
	const names = ["PI_MARKDOWN_DIR", "PI_MARKDOWN_APP", "PI_HARNESS_FILE", "HOME"];
	const environment = names.map((name) => [name, process.env[name]] as const);
	process.env.PI_MARKDOWN_DIR = join(root, "store");
	process.env.PI_MARKDOWN_APP = join(root, "missing.app");
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	process.env.HOME = root;
	try {
		await writeFile(join(root, "notes.md"), "# Home note\n");
		let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
		const notify = t.mock.fn();
		const pi = { events: createEventBus(), on: () => {}, registerShortcut: () => {}, registerTool: () => {},
			registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
		} as unknown as ExtensionAPI;
		markdown(pi);
		assert.ok(handler);
		const source = { getLeafId: () => null, getSessionId: () => "session" };
		await handler("file ~/notes.md", { mode: "print", cwd: join(root, "elsewhere"), sessionManager: source, ui: { notify } } as unknown as ExtensionContext);
		assert.match(notify.mock.calls.at(-1)?.arguments[0] ?? "", /^Saved md-[a-f0-9]{8} revision 1\. No window was opened\. References not inspected: the reader app is not installed; build it with node extensions\/markdown\/native\/build\.mts\. Local images are not retained\.$/u);
		const store = new MarkdownStore(process.env.PI_MARKDOWN_DIR);
		const snapshot = (await store.list({ kind: "file" })).documents[0];
		assert.equal((await store.get(snapshot.id)).source, "# Home note\n");
	} finally {
		for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await rm(root, { recursive: true, force: true });
	}
});

test("only an interactive start or reload on macOS checks the reader app, and an ended session hears nothing", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "markdown-reader-start-"));
	const environment = { PI_MARKDOWN_DIR: process.env.PI_MARKDOWN_DIR, PI_MARKDOWN_APP: process.env.PI_MARKDOWN_APP, PI_HARNESS_FILE: process.env.PI_HARNESS_FILE };
	process.env.PI_MARKDOWN_DIR = join(root, "store");
	process.env.PI_MARKDOWN_APP = join(root, "Reader.app");
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	t.after(async () => {
		for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await rm(root, { recursive: true, force: true });
	});
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => { handlers.set(name, handler); } } as unknown as Pick<ExtensionAPI, "on">;
	const checks: Parameters<CheckReader>[0][] = [];
	const check: CheckReader = async (options) => { checks.push(options); return { state: "current" }; };
	const updates: Parameters<CheckReader>[0][] = [];
	const update = readerUpdates(pi, check, async (options) => { updates.push(options); });
	const notify = t.mock.fn();
	const setStatus = t.mock.fn();
	const context = (mode: string) => ({ mode, ui: { notify, setStatus } }) as unknown as ExtensionContext;
	const start = handlers.get("session_start");
	assert.ok(start);
	for (const [reason, mode] of [["new", "tui"], ["resume", "tui"], ["fork", "tui"], ["startup", "json"], ["startup", "rpc"], ["reload", "print"]]) start({ reason }, context(mode));
	assert.equal(checks.length, 0);
	start({ reason: "startup" }, context("tui"));
	start({ reason: "reload" }, context("tui"));
	assert.equal(checks.length, process.platform === "darwin" ? 2 : 0);
	await update(context("rpc"));
	assert.equal(updates.length, 1);
	assert.equal(updates[0].app, join(root, "Reader.app"));
	assert.equal(updates[0].store, join(root, "store"));
	updates[0].reporter.notify("Visible");
	updates[0].reporter.status("Markdown reader: updating");
	assert.equal(updates[0].reporter.active(), true);
	handlers.get("session_shutdown")?.({ reason: "quit" }, context("tui"));
	updates[0].reporter.notify("After the session ended");
	updates[0].reporter.status(undefined);
	assert.equal(updates[0].reporter.active(), false);
	assert.deepEqual(notify.mock.calls.map((call) => call.arguments), [["Visible", "info"]]);
	assert.deepEqual(setStatus.mock.calls.map((call) => call.arguments), [["markdown-update", "Markdown reader: updating"]]);
});
