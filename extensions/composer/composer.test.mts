import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { type ComposerConfig, type ComposerState, DRAFT_BYTES } from "./composer-bridge.ts";
import type { ComposerEditor } from "./composer-editor.ts";
import { type ComposerEnvironment, folderLabel, registerComposer, splitComposer } from "./composer.ts";

type Factory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
const tui = { requestRender() {}, terminal: { rows: 30 } } as unknown as TUI;
const theme: EditorTheme = { borderColor: x => x, selectList: { selectedPrefix: x => x, selectedText: x => x, description: x => x, scrollInfo: x => x, noMatch: x => x } };
const keys = { matches: (data: string, action: string) => ({ "\r": "tui.input.submit", "\x04": "app.exit", "\x1b": "app.interrupt", "\x16": "app.clipboard.pasteImage" })[data as "\r"] === action } as unknown as KeybindingsManager;
function host(env: ComposerEnvironment, initial = "") {
	let factory: Factory;
	let editor: ComposerEditor | undefined;
	let text = initial;
	let onSubmit: (text: string) => void = () => {};
	let onFollowUp = () => {};
	let onEscape = () => {};
	let onDequeue = () => {};
	let thinking = "off";
	let idle = true;
	const models = [{ provider: "fixture", id: "a", name: "Model A", reasoning: false }, { provider: "fixture", id: "b", name: "Model B", reasoning: false }];
	const notices: string[] = [];
	const branch: object[] = [];
	const workingVisible: boolean[] = [];
	const presence: unknown[] = [];
	const listeners = new Map<string, (payload: unknown) => void>();
	const bus = {
		on(name: string, handler: (payload: unknown) => void) { listeners.set(name, handler); return () => listeners.delete(name); },
		emit(name: string, payload: unknown) {
			if (name === "harness:composer:presence") presence.push(payload);
			listeners.get(name)?.(payload);
		},
	};
	const handlers = new Map<string, (event: object, ctx: ExtensionContext) => unknown>();
	let compose: (args: string, ctx: ExtensionContext) => Promise<void>;
	const ctx = {
		mode: "tui", hasUI: true, cwd: env.agentDir, isIdle: () => idle, sessionManager: { getSessionId: () => "id", getBranch: () => branch },
		model: models[0], modelRegistry: { getAvailable: () => models }, getContextUsage: () => ({ percent: 25, tokens: 50, contextWindow: 200 }),
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent(next: Factory) {
				text = editor?.getExpandedText() ?? text;
				factory = next;
				editor = next?.(tui, theme, keys) as ComposerEditor | undefined;
				if (editor) {
					editor.onSubmit = (text) => onSubmit(text);
					editor.onEscape = () => onEscape();
					editor.onAction("app.message.followUp", () => onFollowUp());
					editor.onAction("app.message.dequeue", () => onDequeue());
					editor.setText(text);
					// Pi focuses an installed editor unless an extension dialog holds the slot.
					editor.focused = true;
				}
			},
			notify(message: string) { notices.push(message); },
			setWorkingVisible(visible: boolean) { workingVisible.push(visible); },
		},
	} as unknown as ExtensionContext;
	const pi = {
		events: bus,
		on(event: string, handler: (event: object, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
		registerCommand(name: string, spec: { handler: typeof compose }) { assert.equal(name, "composer"); compose = spec.handler; },
		getThinkingLevel: () => thinking, getSessionName: () => undefined, getCommands: () => [{ name: "composer", source: "extension" }, { name: "stash", source: "extension" }, { name: "review", source: "prompt" }, { name: "skill:harness", source: "skill" }],
		setModel: async () => true, setThinkingLevel: (level: string) => { thinking = level === "off" ? level : "low"; },
	} as unknown as ExtensionAPI;
	registerComposer(pi, env);
	return {
		command: (args = "") => compose(args, ctx),
		event: (name: string, event: string | object = name) => handlers.get(name)?.(typeof event === "string" ? { reason: event } : event, ctx),
		editor: () => { assert.ok(editor); return editor; },
		text: () => editor?.getExpandedText() ?? text,
		installed: () => Boolean(editor),
		reset: () => ctx.ui.setEditorComponent(undefined),
		onSubmit: (handler: typeof onSubmit) => { onSubmit = handler; },
		onFollowUp: (handler: typeof onFollowUp) => { onFollowUp = handler; },
		onEscape: (handler: typeof onEscape) => { onEscape = handler; },
		onDequeue: (handler: typeof onDequeue) => { onDequeue = handler; },
		setIdle: (value: boolean) => { idle = value; },
		notices, branch, workingVisible, presence,
		requestPresence: (payload: unknown) => bus.emit("harness:composer:presence-request", payload),
	};
}
async function setup(t: TestContext) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-composer-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	let launch: string;
	const env: ComposerEnvironment = { agentDir, alive: pid => pid === 100, async launch(file) { launch = await file(); return undefined; } };
	return { env, launch: () => launch };
}
function client(config: ComposerConfig) {
	return async (path: string, body: Record<string, unknown> = {}, options: { headers?: Record<string, string>; raw?: string; signal?: AbortSignal } = {}) => {
		const response = await fetch(config.endpoint + path, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", ...options.headers }, body: options.raw ?? JSON.stringify({ composer: config.composer, ...body }), signal: options.signal });
		return { status: response.status, ...(await response.json() as { ok: boolean; error?: string; outcome?: string; text?: string; sequence: number; message?: string; events?: { type: string; text?: string }[]; state?: ComposerState; reset?: boolean; stopped?: boolean; cursor?: number; prefix?: string; items?: unknown[]; history?: string[]; restored?: number; level?: string; applied?: boolean; models?: Array<{ id: string; current: boolean }> }) };
	};
}
async function consume(path: string): Promise<ComposerConfig & { share: number }> {
	const cfg = JSON.parse(await readFile(path, "utf8")) as ComposerConfig & { share: number };
	await unlink(path);
	return cfg;
}

test("authenticates one composer, validates requests, and delivers bounded long polls", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const pi = host(files.env, "terminal draft");
	t.after(() => pi.event("session_shutdown", "quit") as Promise<void>);
	await pi.command();
	assert.equal(pi.installed(), false);
	assert.equal((await stat(files.launch())).mode & 0o777, 0o600);
	const config = await consume(files.launch());
	const ask = client(config);
	const hello = { pid: 100, draft: { text: "" } };
	assert.equal((await ask("/hello", hello, { headers: { Origin: "http://example.com" } })).status, 403);
	assert.equal((await ask("/hello", hello, { headers: { Authorization: "Bearer invalid" } })).status, 403);
	assert.equal((await ask("/hello", hello, { headers: { "Content-Type": "text/plain" } })).status, 403);
	assert.equal((await ask("/unknown")).status, 404);
	assert.equal((await ask("/hello", { ...hello, composer: randomUUID() })).status, 409);
	assert.equal((await ask("/hello", hello, { raw: "[]" })).status, 409);
	assert.equal((await ask("/hello", { ...hello, draft: { text: "\uD800" } })).status, 409);
	assert.equal((await ask("/draft", { generation: 0, text: "x" })).status, 409);
	const start = await ask("/hello", hello);
	assert.equal(start.text, "terminal draft");
	const controller = new AbortController();
	t.after(() => controller.abort());
	const pending = ask("/events", { after: start.sequence }, { signal: controller.signal });
	const second = ask("/events", { after: start.sequence }, { signal: controller.signal });
	assert.equal((await Promise.race([pending, second])).status, 409);
	await pi.event("agent_start");
	const changed = (await Promise.all([pending, second])).find(result => result.ok);
	assert.equal(changed?.state?.phase, "working");
	assert.deepEqual(changed?.events, []);
	for (let i = 0; i < 257; i++) pi.editor().insertTextAtCursor("x");
	const reset = await ask("/events", { after: start.sequence });
	assert.equal(reset.reset, true);
	assert.deepEqual(reset.events, []);
});

test("routes submit, follow-up, abort, and restores terminal input without duplicate submissions", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const pi = host(files.env);
	t.after(() => pi.event("session_shutdown", "quit") as Promise<void>);
	await pi.command();
	const ask = client(await consume(files.launch()));
	const start = await ask("/hello", { pid: 100, draft: { text: "native" } });
	assert.deepEqual(await ask("/draft", { generation: 2, text: "newer" }), { ok: true, status: 200 });
	await ask("/draft", { generation: 1, text: "old" });
	assert.equal(pi.text(), "newer");
	const touched: string[] = [];
	let exits = 0;
	pi.editor().onCtrlD = () => { exits++; };
	pi.editor().handleInput("\x04");
	pi.editor().setText("");
	pi.editor().handleInput("\x04");
	assert.equal(exits, 1);
	pi.editor().handleInput("🚀");
	pi.editor().handleInput("\x1b[27;1;32~");
	pi.editor().handleInput("\x1b[27;2;128640~");
	for (const key of ["\x1b[27;3;65~", "\x1b[27;1;10~", "\x1b[27;1;127~", "\x1b[27;1;55296~", "\x1b[27;1;1114112~", "\x1b[27;1;00000065~", "\x1b[27;1;65~\n", "\x1b[D", "\x1b[200~\x1b[201~"]) pi.editor().handleInput(key);
	pi.editor().handleInput("\x1b[200~one\r\ntwo\x1b[201~");
	pi.editor().handleInput("\r");
	pi.editor().onPasteImage = () => pi.editor().insertTextAtCursor("/image.png");
	pi.editor().handleInput("\x16");
	pi.onSubmit(async text => {
		touched.push(text);
		pi.editor().setText(text);
		await new Promise(() => {});
	});
	const message = { id: randomUUID(), behavior: "send", text: "!echo test" };
	assert.equal((await ask("/submit", message)).outcome, "accepted");
	assert.equal((await ask("/submit", message)).outcome, "accepted");
	assert.equal((await ask("/submit", { ...message, text: "other" })).outcome, "refused");
	assert.equal((await ask("/submit", { ...message, id: randomUUID(), text: "a".repeat(DRAFT_BYTES + 1) })).outcome, "refused");
	assert.equal((await ask("/submit", { ...message, id: "bad" })).status, 409);
	pi.onFollowUp(() => { touched.push(pi.text()); pi.editor().setText(""); });
	assert.equal((await ask("/submit", { id: randomUUID(), behavior: "followUp", text: "queued" })).outcome, "accepted");
	assert.deepEqual(touched, ["!echo test", "queued"]);
	pi.onSubmit(() => { throw new Error("refused\nextra line"); });
	assert.equal((await ask("/submit", { ...message, id: randomUUID() })).outcome, "refused");
	assert.deepEqual((await ask("/events", { after: start.sequence })).events?.map(({ type, text }) => [type, text]), [
		["insert", "🚀"], ["insert", " "], ["insert", "🚀"], ["insert", "one\ntwo"], ["focus", undefined], ["insert", "/image.png"], ["setText", "!echo test"],
	]);
	assert.equal((await ask("/abort")).stopped, false);
	await pi.event("agent_start");
	pi.onEscape(() => { pi.editor().setText("restored queue"); });
	assert.equal((await ask("/abort")).stopped, true);
	assert.equal(pi.text(), "restored queue");
	assert.ok((await ask("/close", { draft: { text: "last native draft" } })).ok);
	assert.equal(pi.installed(), false);
	assert.equal(pi.text(), "last native draft");
});

test("reconnects through the exact record and preserves fallback edits", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const old = host(files.env);
	await old.command();
	const config = await consume(files.launch());
	const oldAsk = client(config);
	const start = await oldAsk("/hello", { pid: 100, draft: { text: "mirror" } });
	old.reset(); // Pi reload clears extension UI before shutdown.
	const stopping = old.event("session_shutdown", "reload");
	assert.equal((await oldAsk("/events", { after: start.sequence })).events?.[0].type, "detach");
	await stopping;
	assert.deepEqual(old.workingVisible, [false, true]);
	assert.deepEqual(old.presence, [{ version: 1, present: true }, { version: 1, present: false }]);
	old.requestPresence({ version: 1 });
	assert.equal(old.presence.length, 2);
	const pi = host(files.env, old.text());
	t.after(() => pi.event("session_shutdown", "quit") as Promise<void>);
	await pi.event("session_start", "reload");
	assert.equal(pi.text(), "mirror");
	pi.editor().setText("");
	const path = join(files.env.agentDir, "composer-live", `composer-${config.composer}.json`);
	const updated = await consume(path);
	assert.equal(updated.composer, config.composer);
	assert.notEqual(updated.token, config.token);
	assert.notEqual(basename(path), basename(files.launch()));
	const ask = client(updated);
	const hello = await ask("/hello", { pid: 100, draft: { text: "native draft" } });
	assert.equal(hello.text, "");
	assert.equal(pi.text(), "");
});

test("hands off an empty fallback draft only once on return to visibility", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const pi = host(files.env);
	t.after(() => pi.event("session_shutdown", "quit") as Promise<void>);
	await pi.command();
	const ask = client(await consume(files.launch()));
	const start = await ask("/hello", { pid: 100, draft: { text: "draft" } });
	await ask("/visibility", { visible: false });
	pi.editor().setText("");
	await ask("/visibility", { visible: true });
	const visible = await ask("/events", { after: start.sequence });
	assert.deepEqual(visible.events, [{ seq: start.sequence + 1, type: "setText", text: "" }]);
	pi.editor().setText("put back");
	pi.editor().setText("");
	await ask("/visibility", { visible: false });
	await ask("/visibility", { visible: true });
	assert.deepEqual((await ask("/events", { after: visible.sequence })).events, [{ seq: visible.sequence + 1, type: "setText", text: "put back" }]);
});

test("recovers presence after a poll gap without overriding visibility or terminal edits", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const pi = host(files.env);
	t.after(() => { t.mock.timers.reset(); return pi.event("session_shutdown", "quit") as Promise<void>; });
	await pi.command();
	const ask = client(await consume(files.launch()));
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const shown = () => pi.editor().render(60).length === 0;
	assert.equal(pi.workingVisible.length, 0);
	const hello = { pid: 100, draft: { text: "native draft" } };
	const start = await ask("/hello", hello);
	assert.ok(shown());
	t.mock.timers.tick(3001);
	assert.equal(shown(), false);
	pi.editor().setText("");
	await ask("/draft", { generation: 1, text: "stale" });
	assert.equal(pi.text(), "");
	const resumed = await ask("/events", { after: start.sequence });
	assert.deepEqual(resumed.events, [{ seq: start.sequence + 1, type: "setText", text: "" }]);
	assert.ok(shown());

	await ask("/visibility", { visible: false });
	pi.editor().handleInput("x");
	t.mock.timers.tick(3001);
	assert.equal((await ask("/hello", { ...hello, pid: 101 })).status, 409);
	assert.equal((await ask("/events", { after: resumed.sequence + 1 })).status, 409);
	await pi.event("agent_start");
	const hidden = await ask("/events", { after: resumed.sequence });
	assert.deepEqual(hidden.events, []);
	assert.equal(shown(), false);
	await ask("/visibility", { visible: true });
	const visible = await ask("/events", { after: hidden.sequence });
	assert.deepEqual(visible.events, [{ seq: hidden.sequence + 1, type: "setText", text: "x" }]);
	assert.ok(shown());

	t.mock.timers.tick(3001);
	assert.equal(shown(), false);
	pi.editor().setText("");
	const reconnected = await ask("/hello", hello);
	assert.equal(reconnected.text, "");
	assert.equal(reconnected.sequence, visible.sequence);
	assert.ok(shown());
	assert.deepEqual(pi.workingVisible, [false, true, false, true, false, true, false]);
	assert.deepEqual(pi.presence, pi.workingVisible.map(value => ({ version: 1, present: !value })));
});

test("publishes current presence and restores the terminal presentation on close", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const pi = host(files.env);
	t.after(() => pi.event("session_shutdown", "quit") as Promise<void>);
	pi.requestPresence({ version: 2 });
	assert.deepEqual(pi.presence, []);
	pi.requestPresence({ version: 1 });
	await pi.command();
	const ask = client(await consume(files.launch()));
	await ask("/hello", { pid: 100, draft: { text: "draft" } });
	assert.deepEqual(pi.editor().render(60), []);
	pi.requestPresence({ version: 1 });
	await pi.command("close");
	assert.deepEqual(pi.workingVisible, [false, true]);
	assert.deepEqual(pi.presence, [false, true, true, false].map(present => ({ version: 1, present })));
});

test("publishes the current branch cost at hello, message end and tree change", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const pi = host(files.env);
	t.after(() => pi.event("session_shutdown", "quit") as Promise<void>);
	const assistant = (total: number) => ({ role: "assistant", usage: { cost: { total } } });
	const message = (message: object) => ({ type: "message", message });
	pi.branch.push(message(assistant(0.25)), message({ role: "user", usage: { cost: { total: 50 } } }));
	await pi.command();
	const ask = client(await consume(files.launch()));
	const start = await ask("/hello", { pid: 100, draft: { text: "" } });
	assert.equal(start.state?.cost, 0.25);
	await pi.event("message_end", message(assistant(0.5)));
	assert.equal((await ask("/events", { after: start.sequence })).state?.cost, 0.75);
	pi.branch.push(message(assistant(0.5)));
	await pi.event("message_end", message(assistant(0.125)));
	assert.equal((await ask("/events", { after: start.sequence })).state?.cost, 0.875);
	pi.branch.splice(0);
	await pi.event("session_tree");
	assert.equal((await ask("/events", { after: start.sequence })).state?.cost, 0);
});

test("requests a 20 percent split below the exact invoking pane", async () => {
	const origin = { version: 1, terminal: "Rex", application: { bundleId: "com.superlogical.rex" }, exact: { blockId: "block:fixture" } } as const;
	const argv = ["/composer", "--composer", "/connection.json"];
	const signal = new AbortController().signal;
	let payload: unknown;
	const result = await splitComposer(argv, origin, "/project", signal, async (file, operation, _timeout, receivedSignal, input) => {
		assert.deepEqual([file, operation, receivedSignal], ["terminal-pane.ts", "split", signal]);
		payload = JSON.parse(input ?? "null");
		return { version: 1, outcome: "created", receipt: { direction: "vertical" } };
	});
	assert.deepEqual(result, { receipt: { direction: "vertical" } });
	assert.deepEqual(payload, { version: 1, origin, argv, cwd: "/project", placement: { side: "below", share: 0.2 }, label: "Composer" });
});

test("completes through the installed provider with UTF-16 cursors and cancels stale requests", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const pi = host(files.env);
	t.after(() => pi.event("session_shutdown", "quit") as Promise<void>);
	await pi.command();
	const ask = client(await consume(files.launch()));
	await ask("/hello", { pid: 100, draft: { text: "" } });
	let didStart = () => {};
	const started = new Promise<void>(resolve => { didStart = resolve; });
	let calls = 0;
	const provider: AutocompleteProvider = {
		async getSuggestions(lines, line, col, options) {
			assert.deepEqual([lines, line, col, options.force], [["row", "🚀@f"], 1, 4, true]);
			if (++calls === 1) {
				didStart();
				await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
			}
			return { prefix: "@f", items: Array.from({ length: 60 }, () => ({ value: "@file", label: "file" })) };
		},
		applyCompletion(lines, line, col, item, prefix) {
			assert.deepEqual([lines, line, col, item, prefix], [["row", "🚀@f"], 1, 4, { value: "@file", label: "file" }, "@f"]);
			return { lines: ["row", "🚀@file"], cursorLine: 1, cursorCol: 7 };
		},
	};
	pi.editor().setAutocompleteProvider(provider);
	const input = { text: "row\n🚀@f", cursor: 8, force: true };
	assert.equal((await ask("/complete", { ...input, cursor: 5 })).status, 409);
	const stale = ask("/complete", input);
	await started;
	const found = await ask("/complete", input);
	assert.equal(found.prefix, "@f");
	assert.equal(found.items?.length, 50);
	assert.equal((await stale).status, 409);
	assert.deepEqual(await ask("/applyCompletion", { ...input, item: found.items?.[0], prefix: found.prefix }), { ok: true, status: 200, text: "row\n🚀@file", cursor: 11 });
});

test("updates model, thinking, history and queue state, and returns hidden edits", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const pi = host(files.env);
	t.after(() => pi.event("session_shutdown", "quit") as Promise<void>);
	await pi.command();
	const ask = client(await consume(files.launch()));
	const start = await ask("/hello", { pid: 100, draft: { text: "native" } });
	assert.deepEqual(start.history, []);
	assert.deepEqual(start.state?.context, { percent: 25, tokens: 50, window: 200 });
	assert.deepEqual((await ask("/models")).models?.map(({ current }) => current), [true, false]);
	assert.equal((await ask("/setModel", { provider: "fixture", id: "missing" })).applied, false);
	assert.equal((await ask("/setModel", { provider: "fixture", id: "b" })).applied, true);
	assert.equal((await ask("/setThinking", { level: "high" })).level, "low");
	assert.ok((await ask("/visibility", { visible: false })).ok);
	pi.editor().handleInput("!");
	assert.equal(pi.text(), "native!");
	await ask("/draft", { generation: 2, text: "stale native" });
	assert.equal(pi.text(), "native!");
	assert.ok((await ask("/visibility", { visible: true })).ok);
	const shown = await ask("/events", { after: start.sequence });
	assert.deepEqual(shown.events?.[0], { seq: 1, type: "setText", text: "native!" });
	assert.equal(shown.state?.model?.id, "b");
	assert.equal(shown.state?.thinking, "low");
	pi.setIdle(false);
	await pi.event("agent_start");
	pi.onSubmit(text => pi.editor().addToHistory(text));
	const send = (text: string) => ask("/submit", { id: randomUUID(), behavior: "send", text });
	await send("steering");
	await send("queued");
	await pi.event("message_start", { message: { role: "user", content: [{ type: "text", text: "steering" }] } });
	const working = await ask("/events", { after: shown.sequence });
	assert.deepEqual(working.state?.queued, [{ behavior: "steer", text: "queued" }]);
	assert.deepEqual(working.events?.map(event => event.type), ["history", "history"]);
	pi.onDequeue(() => pi.editor().setText("queued"));
	assert.equal((await ask("/dequeue")).restored, 1);
	const restored = await ask("/events", { after: working.sequence });
	assert.deepEqual(restored.state?.queued, []);
	assert.equal(restored.events?.[0]?.text, "queued");
});

test("resize validates the request and refuses hidden or unconfirmed panes", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const pi = host(files.env);
	t.after(() => pi.event("session_shutdown", "quit") as Promise<void>);
	await pi.command();
	const ask = client(await consume(files.launch()));
	await ask("/hello", { pid: 100, draft: { text: "" } });
	for (const share of [0.09, 0.401, 3.5, "0.2", null]) assert.equal((await ask("/resize", { share })).status, 409);
	assert.equal((await ask("/resize", { rows: 9, currentRows: 9 })).status, 409);
	assert.equal((await ask("/resize", { share: 0.2, composer: randomUUID() })).status, 409);
	const noReceipt = await ask("/resize", { share: 0.2 });
	assert.equal(noReceipt.applied, false);
	assert.match(noReceipt.message ?? "", /receipt/u);
	await ask("/visibility", { visible: false });
	const hidden = await ask("/resize", { share: 0.2 });
	assert.equal(hidden.applied, false);
	assert.match(hidden.message ?? "", /not visible/u);
});

test("resize waits for the split receipt and keeps only the latest queued size", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const receipt = { direction: "vertical" };
	const gate = () => {
		let signal = () => {};
		const promise = new Promise<void>(resolve => { signal = resolve; });
		return { promise, resolve: signal };
	};
	const split = gate();
	const fileWritten = gate();
	const first = gate();
	const mutated = gate();
	const shares: number[] = [];
	const pi = host({ ...files.env, async launch(file, cwd, signal) {
		await files.env.launch(file, cwd, signal);
		fileWritten.resolve();
		await split.promise;
		return { receipt };
	}, async resize(target, share) {
		assert.equal(target, receipt);
		shares.push(share);
		if (shares.length === 1) { mutated.resolve(); await first.promise; }
		return { applied: true };
	} });
	t.after(() => { split.resolve(); first.resolve(); return pi.event("session_shutdown", "quit") as Promise<void>; });
	const opening = pi.command();
	await fileWritten.promise;
	const launch = await consume(files.launch());
	assert.equal(launch.share, 0.2);
	const ask = client(launch);
	await ask("/hello", { pid: 100, draft: { text: "" } });
	const active = ask("/resize", { share: 0.3 });
	split.resolve();
	await opening;
	await mutated.promise;
	const waiting = [0.1, 0.4].map(async share => ({ share, response: await ask("/resize", { share }) }));
	const superseded = await Promise.race(waiting);
	assert.equal(superseded.response.applied, false);
	assert.match(superseded.response.message ?? "", /newer/u);
	assert.deepEqual(shares, [0.3]);
	first.resolve();
	assert.equal((await active).applied, true);
	const latest = (await Promise.all(waiting)).find(entry => entry.share !== superseded.share);
	assert.equal(latest?.response.applied, true);
	assert.deepEqual(shares, [0.3, latest?.share]);
});

test("reports Pi's terminal as waiting while anything else holds the editor's focus", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const pi = host(files.env);
	t.after(() => pi.event("session_shutdown", "quit") as Promise<void>);
	await pi.command();
	const ask = client(await consume(files.launch()));
	let cursor = (await ask("/hello", { pid: 100, draft: { text: "" } })).sequence;
	const waiting = async () => {
		const result = await ask("/events", { after: cursor });
		cursor = result.sequence;
		return result.state?.waiting;
	};
	pi.event("ui_prompt_start", { kind: "custom" });
	await pi.event("agent_start");
	assert.equal(await waiting(), undefined, "a prompt that leaves the editor focused does not wait");
	pi.editor().focused = false;
	assert.deepEqual(await waiting(), { kind: "custom" });
	pi.event("ui_prompt_end", {});
	assert.deepEqual(await waiting(), { kind: "view" }, "a built-in selector also holds the input");
	pi.event("ui_prompt_start", { kind: "select", title: "Choose a stash" });
	assert.deepEqual(await waiting(), { kind: "select", title: "Choose a stash" });
	pi.editor().focused = true;
	assert.equal(await waiting(), undefined);
	pi.event("ui_prompt_end", {});
});

test("marks a view that opens soon after the composer sends a command as that command's answer", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const pi = host(files.env);
	t.after(() => pi.event("session_shutdown", "quit") as Promise<void>);
	await pi.command();
	const ask = client(await consume(files.launch()));
	let cursor = (await ask("/hello", { pid: 100, draft: { text: "" } })).sequence;
	const waiting = async () => {
		const result = await ask("/events", { after: cursor });
		cursor = result.sequence;
		return result.state?.waiting;
	};
	let opens = true;
	pi.onSubmit(() => { if (opens) pi.editor().focused = false; });
	const send = (text: string) => ask("/submit", { id: randomUUID(), behavior: "send", text });
	assert.equal((await send("/stash recent")).outcome, "accepted");
	assert.deepEqual(await waiting(), { kind: "view", command: "stash" }, "Pi opened the view before the handler returned");
	pi.event("ui_prompt_start", { kind: "custom" });
	assert.deepEqual(await waiting(), { kind: "custom", command: "stash" });
	pi.event("ui_prompt_end", {});
	pi.editor().focused = true;
	assert.equal(await waiting(), undefined);
	pi.editor().focused = false;
	assert.deepEqual(await waiting(), { kind: "view" }, "one command answers one view");
	pi.editor().focused = true;
	assert.equal(await waiting(), undefined);
	opens = false;
	for (const text of ["/review this", "/skill:harness", "plain text"]) {
		await send(text);
		pi.editor().focused = false;
		assert.deepEqual(await waiting(), { kind: "view" }, `${text} goes to the model`);
		pi.editor().focused = true;
		assert.equal(await waiting(), undefined);
	}
	await send("/model");
	await ask("/draft", { generation: 1, text: "next message" });
	pi.editor().focused = false;
	assert.deepEqual(await waiting(), { kind: "view" }, "typing after the command ends its claim on a view");
	pi.editor().focused = true;
	assert.equal(await waiting(), undefined);
});

test("terminal focus asks Rex for Pi's pane only through a confirmed receipt", { timeout: 6000 }, async t => {
	const files = await setup(t);
	const receipt = { direction: "vertical" };
	const focused: unknown[] = [];
	let withReceipt = false;
	let launch = "";
	const pi = host({ ...files.env, async launch(file) { launch = await file(); return withReceipt ? { receipt } : undefined; }, async focus(target) {
		focused.push(target);
		return { focused: true };
	} });
	t.after(() => pi.event("session_shutdown", "quit") as Promise<void>);
	await pi.command();
	let ask = client(await consume(launch));
	await ask("/hello", { pid: 100, draft: { text: "" } });
	assert.equal((await ask("/terminal", { extra: true })).status, 409);
	const missing = await ask("/terminal");
	assert.equal((missing as { focused?: boolean }).focused, false);
	assert.match(missing.message ?? "", /receipt/u);
	assert.deepEqual(focused, []);
	await pi.command("close");
	withReceipt = true;
	await pi.command();
	ask = client(await consume(launch));
	await ask("/hello", { pid: 100, draft: { text: "" } });
	assert.equal((await ask("/terminal") as { focused?: boolean }).focused, true);
	assert.deepEqual(focused, [receipt]);
	await ask("/visibility", { visible: false });
	assert.match((await ask("/terminal")).message ?? "", /not visible/u);
	assert.equal(focused.length, 1);
});

test("the folder label is home-relative only for paths inside the home directory", () => {
	assert.equal(folderLabel("/people/x", "/people/x"), "~");
	assert.equal(folderLabel("/people/x/work/app", "/people/x/"), "~/work/app");
	assert.equal(folderLabel("/people/x2/app", "/people/x"), "/people/x2/app");
	assert.equal(folderLabel("/srv/app", "/people/x"), "/srv/app");
	assert.equal(folderLabel("/srv/app", ""), "/srv/app");
});
