import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { InMemoryCredentialStore, InMemoryModelsStore, type TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import * as durable from "@earendil-works/pi-durable";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { parseEntry } from "./catalog.ts";
import { CHECK_REQUEST, renderCheckRequest } from "./check-request.ts";
import { checkPrompt } from "./command.ts";
import type { toolDisplay } from "./display.ts";
import { slopContribution } from "./durable.ts";
import slopExtension from "./index.ts";
import { inspectCatalog } from "./operations.ts";
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
	mkdirSync(join(dir, "catalog"), { recursive: true });
	writeFileSync(join(dir, "catalog", "field-note.md"), fixture);
	writeFileSync(join(root, "harness.json"), JSON.stringify({ version: 1, slop: { dir } }));
	return { root, dir };
}
function scopedEnv(t: TestContext, root: string, dir: string) {
	for (const [key, value] of Object.entries({
		PI_CODING_AGENT_DIR: root,
		PI_SLOP_DIR: dir,
		PI_SLOP_PROMPT: "on",
		PI_SLOP_PROMPT_BUDGET: undefined,
		PI_SLOP_LEXICON: "",
		PI_HARNESS_FILE: join(root, "harness.json"),
	})) {
		const old = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
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

test("ordinary Pi registers direct tools and submits one slop check with the verbatim hint", async (t) => {
	const { root, dir } = settingsDirectory(t);
	scopedEnv(t, root, dir);
	const events = bus();
	const registered: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
	const hooks = new Map<string, (event: unknown) => void>();
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const messages: Parameters<ExtensionAPI["sendMessage"]>[] = [];
	const notices: [string, string][] = [];
	const renderers = new Map<string, unknown>();
	const seen: ReturnType<typeof toolDisplay>[] = [];
	events.on("harness:tool-display:publish", (value) => {
		seen.push(value as ReturnType<typeof toolDisplay>);
	});
	const host = {
		events,
		registerTool: (tool: (typeof registered)[number]) => registered.push(tool),
		registerMessageRenderer: (name: string, render: unknown) => renderers.set(name, render),
		registerCommand: (_name: string, spec: typeof command) => {
			command = spec;
		},
		on: (name: string, handler: (event: unknown) => void) => hooks.set(name, handler),
		sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => messages.push(args),
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
	const record = registered.find((tool) => tool.name === "slop_record");
	assert.ok(
		registered.every((tool) => tool.promptSnippet),
		"each tool has a line in the tool list",
	);
	assert.ok(record?.promptGuidelines?.length, "the record tool carries prompt rules");
	for (const rule of record?.promptGuidelines ?? []) assert.match(rule, /\bslop_record\b/, "each rule names its tool");
	assert.match(record?.promptGuidelines?.[0] ?? "", /in other words/);
	assert.deepEqual([...hooks.keys()].sort(), ["before_agent_start", "session_shutdown"]);
	events.emit("harness:tool-display:request", { version: 1 });
	assert.equal(seen.length, 2);
	assert.equal(seen[1].tools[0].renderResult, registered[0].renderResult);
	const prompt = { systemPromptOptions: { sections: {} as Record<string, string> } };
	hooks.get("before_agent_start")?.(prompt);
	assert.match(prompt.systemPromptOptions.sections.slop, /Field note: State the result first/);
	const ctx = {
		ui: { notify: (text: string, level: string) => notices.push([text, level]) },
	} as unknown as ExtensionCommandContext;
	assert.ok(command);
	assert.deepEqual(await command.getArgumentCompletions?.("ch"), [{ value: "check", label: "check" }]);
	await command.handler("browse", ctx);
	assert.equal(messages.length, 0);
	assert.deepEqual(notices[0], [
		"Use /slop to browse the catalog or /slop check [hint] to check your work.",
		"warning",
	]);
	await command.handler("", ctx);
	assert.deepEqual(notices[1], [
		"Slop catalog did not open: The slop browser requires the interactive terminal.",
		"error",
	]);
	assert.equal(renderers.get(CHECK_REQUEST), renderCheckRequest);
	const hint = '  The heading: "Results".\nLook at its sequence.  ';
	await command.handler(`check ${hint}`, ctx);
	assert.equal(messages.length, 1);
	const [message, delivery] = messages[0];
	assert.equal(message.display, true);
	assert.equal(message.customType, CHECK_REQUEST);
	assert.equal(message.content, checkPrompt(hint));
	assert.ok(String(message.content).endsWith(`Operator hint:\n${hint}`));
	assert.deepEqual(message.details, { hint });
	assert.deepEqual(delivery, { triggerTurn: true, deliverAs: "steer" });
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
	const catalog = (await read.execute({}, api, context)) as durable.ToolExecutionResult;
	assert.deepEqual(catalog.output, inspectCatalog({ agentDir: root }, {}).content);
	assert.equal(catalog.structuredOutput, undefined);
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

test("ordinary and Durable model requests reflect prompt budget changes on the next turn", {
	timeout: 20_000,
}, async (t) => {
	const { root, dir } = settingsDirectory(t);
	scopedEnv(t, root, dir);
	writeFileSync(
		join(dir, "catalog", "long-note.md"),
		fixture
			.split("## Detectors")[0]
			.replace("field-note", "long-note")
			.replaceAll("Field note", "Long note")
			.replace("State the result first.", `Check ${"each cited source and ".repeat(20)}the result.`),
	);
	const faux = fauxProvider({ tokensPerSecond: 0 });
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [slopExtension],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		model,
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(root),
	});
	t.after(() => session.dispose());
	await session.bindExtensions({ mode: "json" });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = durable.createRegistry();
	const closures: Array<() => void> = [];
	registry.install(
		slopContribution("/fixture/index.ts", bus(), () => {}).create({
			durable,
			agentDir: root,
			cwd: root,
			storageId: "store",
			onClose: (close) => closures.push(close),
		}),
	);
	const harness = await durable.Harness.open(new durable.MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	t.after(async () => {
		await harness.close(BACKGROUND_CONTEXT);
		for (const close of closures) close();
	});
	const conversation = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: model.provider, modelId: model.id } },
	});
	const capture = async (send: () => Promise<unknown>) => {
		let slop: string | null | undefined;
		faux.setResponses([
			(request: TranscriptContext) => {
				slop = getCurrentSystemMessage(request.messages)?.sections?.slop;
				return fauxAssistantMessage("Captured.");
			},
		]);
		await send();
		assert.equal(faux.getPendingResponseCount(), 0);
		return slop;
	};
	const ordinary = () => capture(() => session.prompt("Review the draft."));
	const native = () =>
		capture(async () => {
			const submission = await conversation.submit({ type: "input", content: "Review the draft." }, BACKGROUND_CONTEXT);
			await submission.wait(BACKGROUND_CONTEXT);
		});
	for (const promptBudget of [256, 1500]) {
		writeFileSync(join(root, "harness.json"), JSON.stringify({ version: 1, slop: { dir, promptBudget } }));
		const prompts = [await ordinary(), await native()];
		assert.equal(prompts[0], prompts[1]);
		const prompt = prompts[0];
		assert.ok(prompt);
		assert.match(prompt, /Field note: State the result first/);
		if (promptBudget === 256) {
			assert.match(prompt, /1 of 2 eligible slop repairs omitted.*prompt omitted/);
			assert.doesNotMatch(prompt, /Long note:/);
		} else {
			assert.match(prompt, /Long note: Check/);
			assert.doesNotMatch(prompt, /omitted/);
		}
	}
	process.env.PI_SLOP_PROMPT = "off";
	assert.equal(await ordinary(), undefined);
	assert.equal(await native(), undefined);
});

test("Durable Pi submits the slop check as a steer with the invocation's request id", async () => {
	const [command] = slopContribution("/fixture/index.ts", bus(), () => {}).commands;
	assert.equal(command.name, "slop");
	const submitted: unknown[] = [];
	const call = {
		args: "check The lead.\nKeep the warning.",
		origin: "operator" as const,
		conversation: {
			submit: async (input: unknown) => {
				submitted.push(input);
				return { id: 7 };
			},
		} as unknown as durable.Conversation,
		context: {} as Context,
		invocationId: "invocation-1",
	};
	assert.match(await command.run({ ...call, args: "browse" }), /Use \/slop check/);
	assert.match(await command.run({ ...call, origin: "model" }), /Only the operator/);
	assert.equal(submitted.length, 0);
	assert.match(await command.run(call), /submission 7/);
	assert.equal(submitted.length, 1);
	assert.partialDeepStrictEqual(submitted[0], { type: "input", requestId: "slop:invocation-1", whenBusy: "steer" });
	assert.match((submitted[0] as { content: string }).content, /Operator hint:\nThe lead\.\nKeep the warning\.$/);
	await command.run({ ...call, args: "check", invocationId: "invocation-2" });
	assert.match((submitted[1] as { content: string }).content, /Operator hint:\n\(none\)$/);
});

test("catalog view confirms state changes and cancellation preserves the selection", async () => {
	const entry = { ...parseEntry(fixture, "field-note"), disabled: false };
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
	assert.match(render(55), /Field note \(prompt\)/);
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
	assert.match(render(100), /starter · off/);
	assert.match(render(100), /field-note is off\./);
	assert.doesNotMatch(render(100), /\bid: field-note\b/, "the detail renders the entry body without its front matter");
	key("\u001b");
	key("\u001b");
	assert.equal(closed, true);
});
