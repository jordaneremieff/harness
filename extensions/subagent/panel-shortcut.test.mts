import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";

const agentDir = mkdtempSync(join(tmpdir(), "subagent-shortcut-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: registerSubagent } = await import("./index.ts");
after(() => rmSync(agentDir, { recursive: true, force: true }));

function unexpected(): never {
	throw new Error("Opening the dashboard must not perform this action");
}

function strictStub<T extends object>(fields: Partial<T>): T {
	return new Proxy(fields as T, {
		get(target, key, receiver) {
			assert.ok(Reflect.has(target, key), `Unexpected access: ${String(key)}`);
			return Reflect.get(target, key, receiver);
		},
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

type Panel = Component & { dispose?(): void };
const theme = strictStub<Theme>({
	getBgAnsi: () => "",
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	strikethrough: (text) => text,
	inverse: (text) => text,
});

function fixture() {
	type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
	type Shortcut = Parameters<ExtensionAPI["registerShortcut"]>[1];
	let command: Command | undefined;
	let shortcut: Shortcut | undefined;
	const entries: unknown[] = [];
	const notifications: string[] = [];
	registerSubagent(
		strictStub<ExtensionAPI>({
			registerTool() {},
			registerMessageRenderer() {},
			registerCommand(name, registration) {
				assert.equal(name, "subagent");
				command = registration;
			},
			registerShortcut(key, registration) {
				assert.equal(key, "ctrl+alt+a");
				assert.equal(shortcut, undefined);
				assert.equal(registration.description, "Open the subagent dashboard");
				shortcut = registration;
			},
			on: () => () => {},
			appendEntry: (type, data) => entries.push({ type, data }),
		}),
	);
	assert.ok(command);
	assert.ok(shortcut);
	const sessionManager = SessionManager.inMemory(agentDir);
	let customCalls = 0;
	let startup = deferred<void>();
	let mounted = deferred<Panel>();
	let close = () => {};
	const ui = strictStub<ExtensionContext["ui"]>({
		setStatus() {},
		notify: (text) => notifications.push(text),
		custom: async <T,>(
			factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
			options?: Parameters<ExtensionContext["ui"]["custom"]>[1],
		) => {
			customCalls++;
			assert.equal(options?.overlay, true);
			await startup.promise;
			const closed = deferred<T>();
			close = () => closed.resolve(undefined as T);
			const panel = await factory(
				strictStub<TUI>({ terminal: { rows: 30 } as TUI["terminal"], requestRender() {} }),
				theme,
				strictStub<Parameters<typeof factory>[2]>({ getKeys: () => [], matches: () => false }),
				close,
			);
			mounted.resolve(panel);
			try {
				return await closed.promise;
			} finally {
				panel.dispose?.();
			}
		},
	});
	const ctx: ExtensionContext = {
		ui,
		mode: "tui",
		hasUI: true,
		cwd: agentDir,
		sessionManager,
		modelRegistry: strictStub<ExtensionContext["modelRegistry"]>({}),
		model: undefined,
		scopedModels: [],
		isIdle: () => false,
		isProjectTrusted: () => true,
		signal: new AbortController().signal,
		abort: unexpected,
		hasPendingMessages: () => false,
		shutdown: unexpected,
		getContextUsage: unexpected,
		compact: unexpected,
		getSystemPrompt: unexpected,
	};
	const commandCtx: ExtensionCommandContext = {
		...ctx,
		getSystemPromptOptions: unexpected,
		waitForIdle: unexpected,
		newSession: unexpected,
		fork: unexpected,
		navigateTree: unexpected,
		switchSession: unexpected,
		reload: unexpected,
	};
	return {
		ctx,
		commandCtx,
		command,
		shortcut,
		entries,
		notifications,
		calls: () => customCalls,
		mount: async () => {
			startup.resolve();
			return mounted.promise;
		},
		fail: () => startup.reject(new Error("custom UI unavailable")),
		close: () => close(),
		next: () => {
			startup = deferred<void>();
			mounted = deferred<Panel>();
		},
	};
}

describe("subagent dashboard shortcut", () => {
	it("opens the same unfiltered panel from ExtensionContext without worker or editor actions", async () => {
		const f = fixture();
		const store = join(agentDir, "subagent", "workers");
		const paths = ["alpha", "beta"].map((label) => {
			const id = `bg-shortcut${label}`;
			const dir = join(store, id);
			mkdirSync(dir, { recursive: true });
			const path = join(dir, "worker.json");
			writeFileSync(
				path,
				JSON.stringify({
					id,
					label,
					task: `${label} task`,
					model: "test/model",
					state: "done",
					ownerSession: f.ctx.sessionManager.getSessionId(),
					ownerPid: process.pid,
					createdAt: 1,
					startedAt: 1,
					exitedAt: 2,
				}),
			);
			return path;
		});
		const before = paths.map((path) => readFileSync(path, "utf8"));
		const snapshot = () => paths.map((path) => readFileSync(path, "utf8"));
		const text = (panel: Panel) => panel.render(120).map(stripTerminalSequences).join("\n");
		const filtered = f.command.handler("alpha", f.commandCtx);
		const first = await f.mount();
		assert.match(text(first), /alpha/);
		assert.doesNotMatch(text(first), /beta/);
		first.handleInput?.("\x1b");
		await filtered;
		f.next();
		assert.equal("waitForIdle" in f.ctx, false);
		const opened = f.shortcut.handler(f.ctx);
		const second = await f.mount();
		const unfiltered = text(second);
		assert.match(unfiltered, /alpha/);
		assert.match(unfiltered, /beta/);
		second.handleInput?.("\x1b");
		await opened;
		f.next();
		const bare = f.command.handler("", f.commandCtx);
		const third = await f.mount();
		assert.equal(text(third), unfiltered);
		third.handleInput?.("\x1b");
		await bare;
		assert.equal(f.calls(), 3);
		assert.deepEqual(snapshot(), before);
		assert.equal(readdirSync(store).length, 2);
		assert.deepEqual(f.ctx.sessionManager.getEntries(), []);
		assert.deepEqual(f.entries, []);
		assert.deepEqual(f.notifications, []);
	});

	it("shares one guard before construction, while open, and after close", async () => {
		const f = fixture();
		const first = f.shortcut.handler(f.ctx);
		await f.command.handler("alpha", f.commandCtx);
		await f.shortcut.handler(f.ctx);
		assert.equal(f.calls(), 1, "the guard covers pending UI construction");
		await f.mount();
		await f.command.handler("", f.commandCtx);
		await f.shortcut.handler(f.ctx);
		assert.equal(f.calls(), 1, "the guard covers the open panel");
		f.close();
		await first;
		f.next();
		const second = f.command.handler("", f.commandCtx);
		await f.shortcut.handler(f.ctx);
		assert.equal(f.calls(), 2, "the command also owns the shared guard");
		await f.mount();
		f.close();
		await second;
	});

	it("releases the guard after a rejected open from either route", async () => {
		const f = fixture();
		const failedShortcut = Promise.resolve(f.shortcut.handler(f.ctx));
		const shortcutRejection = assert.rejects(failedShortcut, /custom UI unavailable/);
		f.fail();
		await shortcutRejection;
		f.next();
		const failedCommand = f.command.handler("", f.commandCtx);
		const commandRejection = assert.rejects(failedCommand, /custom UI unavailable/);
		f.fail();
		await commandRejection;
		f.next();
		const opened = f.shortcut.handler(f.ctx);
		await f.mount();
		f.close();
		await opened;
		assert.equal(f.calls(), 3);
	});

	it("releases the guard after preparation throws before the custom UI call", async () => {
		const f = fixture();
		await assert.rejects(
			Promise.resolve(
				f.shortcut.handler({
					...f.ctx,
					sessionManager: strictStub<ExtensionContext["sessionManager"]>({ getSessionId: unexpected }),
				}),
			),
			/Opening the dashboard must not perform this action/,
		);
		assert.equal(f.calls(), 0);
		const opened = f.shortcut.handler(f.ctx);
		await f.mount();
		f.close();
		await opened;
		assert.equal(f.calls(), 1);
	});

	it("does nothing outside TUI and retains the command's structured status routes", async () => {
		const f = fixture();
		for (const mode of ["rpc", "json", "print"] as const) {
			await f.shortcut.handler({ ...f.ctx, mode, hasUI: mode === "rpc" });
		}
		assert.equal(f.calls(), 0);
		assert.deepEqual(f.entries, []);
		assert.deepEqual(f.notifications, []);
		for (const mode of ["rpc", "json"] as const) {
			await f.command.handler("", { ...f.commandCtx, mode, hasUI: mode === "rpc" });
		}
		assert.equal(f.calls(), 0);
		assert.equal(f.entries.length, 2);
		assert.equal(f.notifications.length, 1);
	});

	it("retains the command's print output without custom UI", async (t) => {
		const f = fixture();
		const output: string[] = [];
		const write = t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
			output.push(String(chunk));
			return true;
		});
		try {
			await f.command.handler("", { ...f.commandCtx, mode: "print", hasUI: false });
		} finally {
			write.mock.restore();
		}
		assert.equal(output.length, 1);
		assert.match(output[0], /subagent|worker/i);
		assert.equal(f.calls(), 0);
		assert.deepEqual(f.entries, []);
		assert.deepEqual(f.notifications, []);
	});
});
