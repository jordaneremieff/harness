import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import * as durable from "@earendil-works/pi-durable";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { parseEntry } from "./catalog.ts";
import type { toolDisplay } from "./display.ts";
import { slopContribution } from "./durable.ts";
import slopExtension from "./index.ts";
import { openView } from "./view.ts";

const fixture = `---
id: field-note
title: Field note
domain: prose
applies: ["reply"]
---

# Field note

## Recognition

It uses a label in place of the result.

## Cost

The reader does not see the result.

## Repair

State the result first.

## Detectors

\`\`\`json
[{"id":"label","in":["reply"],"phrases":["field note"]}]
\`\`\`
`;

function settingsDirectory(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "slop-runtime-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "store");
	mkdirSync(join(dir, "entries"), { recursive: true });
	writeFileSync(join(dir, "entries", "field-note.md"), fixture);
	writeFileSync(join(root, "harness.json"), JSON.stringify({ version: 1, slop: { dir } }));
	return { root, dir };
}
function scopedEnv(t: TestContext, root: string, dir: string) {
	for (const [key, value] of Object.entries({
		PI_CODING_AGENT_DIR: root,
		PI_SLOP_DIR: dir,
		PI_SLOP_PROMPT: "on",
		PI_SLOP_LEXICON: "",
		PI_HARNESS_FILE: join(root, "harness.json"),
	})) {
		const old = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (old === undefined) delete process.env[key];
			else process.env[key] = old;
		});
	}
}

function bus() {
	const events = new EventEmitter();
	return {
		emit(channel: string, value: unknown) {
			events.emit(channel, value);
		},
		on(channel: string, handler: (value: unknown) => void) {
			events.on(channel, handler);
			return () => {
				events.off(channel, handler);
			};
		},
		count(channel: string) {
			return events.listenerCount(channel);
		},
	};
}

test("ordinary Pi registers direct tools, publishes cards and flags only on explicit command", async (t) => {
	const { root, dir } = settingsDirectory(t);
	scopedEnv(t, root, dir);
	const events = bus();
	const registered: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
	const hooks = new Map<string, (event: unknown) => void>();
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const messages: [string, unknown][] = [];
	const seen: ReturnType<typeof toolDisplay>[] = [];
	events.on("harness:tool-display:publish", (value) => {
		seen.push(value as ReturnType<typeof toolDisplay>);
	});
	const host = {
		events,
		registerTool: (tool: (typeof registered)[number]) => registered.push(tool),
		registerCommand: (_name: string, spec: typeof command) => {
			command = spec;
		},
		on: (name: string, handler: (event: unknown) => void) => hooks.set(name, handler),
		sendUserMessage: (text: string, options: unknown) => messages.push([text, options]),
	};
	slopExtension(host as unknown as ExtensionAPI);
	assert.deepEqual(
		registered.map((tool) => [tool.name, tool.exposure]),
		[
			["slop", undefined],
			["slop_check", undefined],
			["slop_record", undefined],
		],
	);
	assert.deepEqual([...hooks.keys()].sort(), ["before_agent_start", "session_shutdown"]);
	events.emit("harness:tool-display:request", { version: 1 });
	assert.equal(seen.length, 2);
	assert.equal(seen[1].tools[0].renderResult, registered[0].renderResult);
	const prompt = { systemPromptOptions: { sections: {} as Record<string, string> } };
	hooks.get("before_agent_start")?.(prompt);
	assert.match(prompt.systemPromptOptions.sections.slop, /Field note: State the result first/);
	assert.throws(() => readdirSync(join(dir, "flags")), { code: "ENOENT" });
	const ctx = {
		cwd: root,
		model: { provider: "now", id: "current" },
		sessionManager: {
			getSessionId: () => "session",
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						provider: "then",
						model: "reply-model",
						content: [
							{ type: "thinking", thinking: "private thought" },
							{ type: "text", text: "The saved reply." },
						],
					},
				},
				{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "tool" }] } },
			],
		},
		ui: { notify: assert.fail },
	};
	assert.ok(command);
	await command.handler("flag Please shorten it.", ctx as unknown as Parameters<typeof command.handler>[1]);
	const [file] = readdirSync(join(dir, "flags"));
	const saved = JSON.parse(readFileSync(join(dir, "flags", file), "utf8"));
	assert.equal(saved.model, "then/reply-model");
	assert.equal(saved.reply, "The saved reply.");
	assert.match(messages[0][0], /slop_record.*\n\nPlease shorten it\./s);
	assert.deepEqual(messages[0][1], { deliverAs: "followUp" });
	hooks.get("session_shutdown")?.({});
	assert.equal(events.count("harness:tool-display:request"), 0);
	assert.equal(events.count("harness:settings:request"), 0);
});

test("native Pi installs the same tools, example-backed check and prompt section", async (t) => {
	const { root, dir } = settingsDirectory(t);
	scopedEnv(t, root, dir);
	const events = bus();
	const closures: (() => void)[] = [];
	const contribution = slopContribution("/fixture/index.ts", events, () => {});
	assert.deepEqual(contribution.display, { version: 1, entry: "./display.ts", export: "toolDisplay" });
	const installed = contribution.create({
		durable,
		agentDir: root,
		cwd: root,
		storageId: "store",
		onClose: (dispose) => closures.push(dispose),
	});
	assert.deepEqual(
		installed.tools?.map((tool) => [tool.name, tool.replay]),
		[
			["slop", "safe"],
			["slop_check", "safe"],
			["slop_record", "unsafe"],
		],
	);
	const [read, check, mutate] = installed.tools ?? [];
	const api = {
		conversationId: "root",
		agent: async () => ({ cwd: root, model: { provider: "fixture", modelId: "demo" } }),
	} as unknown as durable.ToolExecutionApi;
	const context = {} as Parameters<typeof read.execute>[2];
	const checked = (await check.execute(
		{ text: "field note", entries: ["field-note"] },
		api,
		context,
	)) as durable.ToolExecutionResult;
	assert.deepEqual(checked.structuredOutput, { ok: false, findingCount: 1, skippedCount: 0 });
	const section = installed.sections?.[0];
	assert.ok(section);
	assert.match((await section.render({} as durable.PromptInput, context)) ?? "", /State the result first/);
	await mutate.execute({ action: "disable", id: "field-note" }, api, context);
	assert.doesNotMatch((await section.render({} as durable.PromptInput, context)) ?? "", /Field note:/);
	for (const close of closures) close();
	assert.equal(events.count("harness:settings:request"), 0);
});

test("catalog view confirms state changes and cancellation preserves the selection", async () => {
	const entry = { ...parseEntry(fixture, "field-note", "local"), disabled: false };
	const plain = (text: string) => text;
	const theme = {
		fg: (_key: string, text: string) => text,
		bold: plain,
		italic: plain,
		underline: plain,
		strikethrough: plain,
	} as unknown as Theme;
	const tui = { terminal: { rows: 25 }, requestRender() {} } as unknown as TUI;
	const state = { query: "", selected: undefined as string | undefined };
	let component: Component | undefined;
	let closed = false;
	const ctx = {
		ui: {
			custom(factory: (tui: TUI, theme: Theme, keys: unknown, done: () => void) => Component) {
				component = factory(tui, theme, {}, () => {
					closed = true;
				});
			},
		},
	} as unknown as ExtensionContext;
	await openView(ctx, state, {
		entries: () => [entry],
		setDisabled: (_, disabled) => {
			entry.disabled = disabled;
		},
		attach() {},
	});
	assert.ok(component);
	const render = (width: number) => component?.render(width).join("\n") ?? "";
	const key = (input: string) => component?.handleInput?.(input);
	assert.match(render(55), /Field note/);
	key("\r");
	assert.match(render(55), /Catalog \/ field-note/);
	key("e");
	assert.match(render(55), /Disable Field note\?/);
	key("\u001b");
	assert.equal(entry.disabled, false);
	assert.equal(state.selected, entry.id);
	key("e");
	key("\r");
	assert.equal(entry.disabled, true);
	assert.match(render(100), /local · disabled/);
	assert.doesNotMatch(render(100), /\bid: field-note\b/, "the detail renders the entry body without its front matter");
	key("\u001b");
	key("\u001b");
	assert.equal(closed, true);
});
