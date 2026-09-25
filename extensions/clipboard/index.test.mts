import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerClipboard from "./index.ts";
import type { SearchPage } from "./search.ts";
import { appendEntry, makeEntry } from "./store.ts";

interface ClipboardDetails {
	id: string;
	count: number;
	hasMore: boolean;
	ids: string[];
	truncated: boolean;
	nextOffset: number;
}
interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: ClipboardDetails;
}
interface Tool {
	name: string;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		update: unknown,
		ctx: unknown,
	): Promise<ToolResult>;
}
interface PanelComponent {
	render(width: number): string[];
	handleInput(data: string): void;
}
type PanelFactory = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
	done: (result: unknown) => void,
) => PanelComponent;
interface ClipboardCommandCtx {
	hasUI: boolean;
	mode: string;
	ui: {
		notify(message: string): void;
		custom(factory: PanelFactory, options?: unknown): Promise<unknown>;
	};
}
interface MockCommand {
	description: string;
	handler(args: string, ctx: ClipboardCommandCtx): unknown;
}
interface MockTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

class Registry<T> {
	readonly #entries = new Map<string, T>();
	set(name: string, value: T): void {
		this.#entries.set(name, value);
	}
	get(name: string): T {
		const value = this.#entries.get(name);
		if (value === undefined) throw new Error(`missing entry: ${name}`);
		return value;
	}
	has(name: string): boolean {
		return this.#entries.has(name);
	}
	keys(): IterableIterator<string> {
		return this.#entries.keys();
	}
}

function registry(): { tools: Registry<Tool>; commands: Registry<MockCommand> } {
	const tools = new Registry<Tool>();
	const commands = new Registry<MockCommand>();
	const pi = {
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: MockCommand) => commands.set(name, command),
	};
	registerClipboard(pi as unknown as ExtensionAPI);
	return { tools, commands };
}

const execute = (tool: Tool, params: Record<string, unknown>) =>
	tool.execute("call", params, new AbortController().signal, undefined, {});

const theme: MockTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

let root: string;
let archiveDir: string;
let clipboardFile: string;
let oldPath: string;
let oldArchive: string | undefined;
let oldClipboardFile: string | undefined;
let oldFail: string | undefined;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "clipboard-index-test-"));
	archiveDir = join(root, "archive");
	clipboardFile = join(root, "clipboard.txt");
	const bin = join(root, "bin");
	await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
	const pbcopy = join(bin, "pbcopy");
	const pbpaste = join(bin, "pbpaste");
	await writeFile(
		pbcopy,
		'#!/bin/sh\nif [ "$FAKE_PBCOPY_FAIL" = "1" ]; then exit 7; fi\nif [ "$FAKE_PBCOPY_SLOW" = "1" ]; then exec sleep 20; fi\ncat > "$FAKE_CLIPBOARD_FILE"\n',
	);
	await writeFile(pbpaste, '#!/bin/sh\ncat "$FAKE_CLIPBOARD_FILE" 2>/dev/null || true\n');
	await chmod(pbcopy, 0o755);
	await chmod(pbpaste, 0o755);
	oldPath = process.env.PATH ?? "";
	oldArchive = process.env.PI_CLIPBOARD_DIR;
	oldClipboardFile = process.env.FAKE_CLIPBOARD_FILE;
	oldFail = process.env.FAKE_PBCOPY_FAIL;
	process.env.PATH = `${bin}:${oldPath}`;
	process.env.PI_CLIPBOARD_DIR = archiveDir;
	process.env.FAKE_CLIPBOARD_FILE = clipboardFile;
	delete process.env.FAKE_PBCOPY_FAIL;
});

after(async () => {
	process.env.PATH = oldPath;
	if (oldArchive === undefined) delete process.env.PI_CLIPBOARD_DIR;
	else process.env.PI_CLIPBOARD_DIR = oldArchive;
	if (oldClipboardFile === undefined) delete process.env.FAKE_CLIPBOARD_FILE;
	else process.env.FAKE_CLIPBOARD_FILE = oldClipboardFile;
	if (oldFail === undefined) delete process.env.FAKE_PBCOPY_FAIL;
	else process.env.FAKE_PBCOPY_FAIL = oldFail;
	await rm(root, { recursive: true, force: true });
});

describe("clipboard entrypoint", () => {
	it("registers all tools and /clipboard", () => {
		const { tools, commands } = registry();
		assert.deepEqual(
			[...tools.keys()],
			["clipboard_copy", "clipboard_paste", "clipboard_list", "clipboard_get", "clipboard_restore"],
		);
		assert.ok(commands.has("clipboard"));
	});

	it("restores a listed stable id after later writes shift list order", async () => {
		const { tools } = registry();
		const copy = tools.get("clipboard_copy");
		const list = tools.get("clipboard_list");
		const restore = tools.get("clipboard_restore");
		const first = await execute(copy, { content: "first", label: "one" });
		await execute(copy, { content: "second", label: "two" });
		const listed = await execute(list, { limit: 10 });
		assert.match(listed.content[0].text, new RegExp(first.details.id));
		const one = await execute(list, { limit: 1 });
		assert.equal(one.details.count, 1);
		assert.equal(one.details.hasMore, true);
		await execute(copy, { content: "new arrival" });
		await execute(restore, { id: first.details.id });
		assert.equal(await readFile(clipboardFile, "utf8"), "first");
	});

	it("aborts a restore promptly instead of waiting out the pbcopy timeout", async () => {
		const { tools } = registry();
		const list = tools.get("clipboard_list");
		const restore = tools.get("clipboard_restore");
		const listed = await execute(list, { limit: 10 });
		const target = listed.details.ids[0];
		const controller = new AbortController();
		process.env.FAKE_PBCOPY_SLOW = "1";
		const started = Date.now();
		try {
			const pending = restore.execute("call", { id: target }, controller.signal, undefined, {});
			setTimeout(() => controller.abort(), 50);
			await assert.rejects(pending, /pbcopy failed/);
			assert.ok(Date.now() - started < 5_000, "the abort must reach the child, not wait for the 30s timeout");
		} finally {
			delete process.env.FAKE_PBCOPY_SLOW;
		}
	});

	it("throws on tool failure and leaves the current clipboard untouched", async () => {
		const { tools } = registry();
		const list = tools.get("clipboard_list");
		const restore = tools.get("clipboard_restore");
		const get = tools.get("clipboard_get");
		const listed = await execute(list, { limit: 10 });
		const target = listed.details.ids[0];
		await writeFile(clipboardFile, "keep me");
		process.env.FAKE_PBCOPY_FAIL = "1";
		try {
			await assert.rejects(execute(restore, { id: target }), /pbcopy failed/);
			assert.equal(await readFile(clipboardFile, "utf8"), "keep me");
		} finally {
			delete process.env.FAKE_PBCOPY_FAIL;
		}
		await assert.rejects(execute(get, {}), /requires a stable id/);
		await assert.rejects(execute(restore, { id: "no-such-id" }), /no clipboard entry/);
	});

	it("pages and bounds large history retrieval", async () => {
		const { tools } = registry();
		const copy = tools.get("clipboard_copy");
		const get = tools.get("clipboard_get");
		const copied = await execute(copy, { content: "🙂".repeat(9000), label: "large" });
		const result = await execute(get, { id: copied.details.id });
		assert.equal(result.details.truncated, true);
		assert.equal(result.details.nextOffset, 8000);
		assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 50 * 1024);
		assert.match(result.content[0].text, /offset 8000/);
	});

	it("keeps query output, stable ids and continuation intact under hostile text and maximum ids", async () => {
		const { tools } = registry();
		for (let index = 0; index < 50; index++) {
			const id = `output-${index}-`.padEnd(200, "x");
			assert.equal(
				await appendEntry(
					archiveDir,
					makeEntry(`needle ${"\x1b\u202e🙂".repeat(200)}`, "\u202e".repeat(200), new Date(), id),
				),
				null,
			);
		}
		let cursor: string | undefined;
		const ids: string[] = [];
		for (let request = 0; request < 100; request++) {
			const result = await execute(tools.get("clipboard_list"), { query: "needle", limit: 50, cursor });
			assert.ok(Buffer.byteLength(JSON.stringify(result)) < 50 * 1024);
			assert.ok(result.content[0].text.split("\n").length <= 2000);
			assert.ok(!result.content[0].text.includes("\x1b"));
			const page = JSON.parse(result.content[0].text) as SearchPage;
			ids.push(...page.matches.map((match) => match.id));
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		assert.equal(ids.length, 50);
		assert.equal(new Set(ids).size, 50);
		assert.ok(ids.every((id) => id.length === 200));
		await assert.rejects(execute(tools.get("clipboard_list"), { cursor: "invalid" }), /requires the original query/);
	});

	it("uses a useful RPC notification instead of the TUI-only overlay", async () => {
		const { commands } = registry();
		const notifications: string[] = [];
		await commands.get("clipboard").handler("", {
			hasUI: true,
			mode: "rpc",
			ui: {
				notify: (message: string) => notifications.push(message),
				custom: () => assert.fail("RPC must not open the terminal overlay"),
			},
		});
		assert.ok(notifications.some((message) => message.includes("clipboard_list")));
	});

	it("contains early stdin closure for large failed copies without a false archive entry", async () => {
		const { tools } = registry();
		const before = await execute(tools.get("clipboard_list"), { limit: 50 });
		process.env.FAKE_PBCOPY_FAIL = "1";
		try {
			await assert.rejects(
				execute(tools.get("clipboard_copy"), { content: "x".repeat(8 * 1024 * 1024) }),
				/pbcopy failed/,
			);
		} finally {
			delete process.env.FAKE_PBCOPY_FAIL;
		}
		const after = await execute(tools.get("clipboard_list"), { limit: 50 });
		assert.deepEqual(after.details.ids, before.details.ids);
	});

	it("restores the full archived entry from a bounded browser preview", async () => {
		const { tools, commands } = registry();
		const full = `${"preview ".repeat(5000)}FULL_TAIL`;
		await execute(tools.get("clipboard_copy"), { content: full, label: "browser-large" });
		const notifications: string[] = [];
		const ctx: ClipboardCommandCtx = {
			hasUI: true,
			mode: "tui",
			ui: {
				notify: (message: string) => notifications.push(message),
				custom: async (factory) =>
					new Promise((resolve) => {
						const component = factory({ terminal: { rows: 24 }, requestRender: () => {} }, theme, {}, resolve);
						assert.match(component.render(72).join("\n"), /preview truncated/);
						component.handleInput("\r");
					}),
			},
		};
		await commands.get("clipboard").handler("", ctx);
		assert.equal(await readFile(clipboardFile, "utf8"), full);
		assert.ok(notifications.some((message) => /Restored/.test(message)));
	});
});
