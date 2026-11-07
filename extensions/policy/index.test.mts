import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { PACKAGE_CATALOG } from "./catalog.ts";
import registerPolicy from "./index.ts";
import { RULES_FILE, type RuleEvent, RuleRegistry, validateRuleEvent } from "./local-rules.ts";
import { fileURLToPath } from "node:url";
import type { NavigationFrame, OperatorView, ViewHost } from "../../operator-ui/index.ts";
import { OPERATOR_VIEW_PUBLISH, OPERATOR_VIEW_REQUEST } from "../../operator-ui/index.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PolicyProposeParams } from "./tools.ts";

/** The policy entrypoint; the ordinary frame binds the published view to this registration of /policy. */
const POLICY_ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
const PAGE_DOWN = "\u001b[6~";
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A small synchronous event bus, as Pi's extension bus delivers publications and frame requests. */
function eventBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(name: string, handler: (data: unknown) => void) {
			const set = handlers.get(name) ?? new Set();
			set.add(handler);
			handlers.set(name, set);
			return () => set.delete(handler);
		},
		emit(name: string, data: unknown) {
			for (const handler of [...(handlers.get(name) ?? [])]) handler(data);
		},
	};
}

interface RegisteredTool {
	name: string;
	parameters: unknown;
	execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
}

class FakePi {
	readonly events = eventBus();
	getCommands() {
		return [...this.commands.keys()].map((name) => ({ name, source: "extension", sourceInfo: { path: POLICY_ENTRY, source: "local", scope: "user", origin: "top-level" } }));
	}
	readonly handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
	readonly commands = new Map<
		string,
		{ handler: (args: string, ctx: never) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }
	>();
	readonly shortcuts = new Map<string, Parameters<ExtensionAPI["registerShortcut"]>[1]>();
	readonly tools = new Map<string, RegisteredTool>();
	readonly flags = new Map<string, unknown>();
	readonly entries: Array<{ customType: string; data: unknown }> = [];

	registerFlag(): void {}
	getFlag(name: string): unknown {
		return this.flags.get(name);
	}
	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}
	getAllTools() {
		return [
			{
				name: "bash",
				parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
			},
			{
				name: "read",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
			...[...this.tools.values()].map((tool) => ({ name: tool.name, parameters: tool.parameters })),
		];
	}
	getActiveTools(): string[] {
		return this.getAllTools().map((tool) => tool.name);
	}
	appendEntry(customType: string, data: unknown): void {
		this.entries.push({ customType, data });
	}
	registerCommand(
		name: string,
		command: {
			handler: (args: string, ctx: never) => Promise<void>;
			getArgumentCompletions?: (prefix: string) => unknown;
		},
	): void {
		this.commands.set(name, command);
	}
	registerShortcut(key: string, shortcut: Parameters<ExtensionAPI["registerShortcut"]>[1]): void {
		this.shortcuts.set(key, shortcut);
	}
	shortcut() {
		const shortcut = this.shortcuts.get("ctrl+alt+p");
		assert.ok(shortcut, "policy shortcut registered");
		return shortcut;
	}
	command() {
		const command = this.commands.get("policy");
		assert.ok(command, "policy command registered");
		return command;
	}
	tool(name: string): RegisteredTool {
		const tool = this.tools.get(name);
		assert.ok(tool, name);
		return tool;
	}
	completions() {
		const complete = this.command().getArgumentCompletions;
		assert.ok(complete, "policy command completions registered");
		return complete;
	}
	on(name: string, handler: (event: never, ctx: never) => unknown): void {
		const entries = this.handlers.get(name) ?? [];
		entries.push(handler);
		this.handlers.set(name, entries);
	}
	async emit(name: string, event: unknown, ctx?: unknown): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(name) ?? []) {
			const next = await handler(event as never, ctx as never);
			if (next !== undefined) result = next;
		}
		return result;
	}
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
};

function context(notifications: Array<{ message: string; type?: string }>, overrides: Record<string, unknown> = {}) {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/work/project",
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		thinkingLevel: "high",
		sessionManager: { getSessionId: () => "session-1" },
		getSystemPrompt: () => "<project_context>loaded</project_context>",
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			async custom<T>(
				factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown,
			): Promise<T> {
				return new Promise<T>((resolve) => {
					const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, { getKeys: () => [] }, resolve) as {
						handleInput(data: string): void;
					};
					component.handleInput("\u001b");
				});
			},
			async select(): Promise<undefined> {
				return undefined;
			},
			async confirm(): Promise<boolean> {
				return false;
			},
			async input(): Promise<undefined> {
				return undefined;
			},
		},
		...overrides,
	};
}

async function setup(mode = "observe") {
	const dir = join(await mkdtemp(join(tmpdir(), "policy-index-")), "policy");
	const previous = process.env.PI_POLICY_DIR;
	process.env.PI_POLICY_DIR = dir;
	const pi = new FakePi();
	pi.flags.set("policy-mode", mode);
	registerPolicy(pi as never);
	if (previous === undefined) delete process.env.PI_POLICY_DIR;
	else process.env.PI_POLICY_DIR = previous;
	const notifications: Array<{ message: string; type?: string }> = [];
	return { dir, pi, notifications, ctx: context(notifications) };
}

async function storedEvents(dir: string): Promise<RuleEvent[]> {
	return (await readFile(join(dir, RULES_FILE), "utf8"))
		.trim()
		.split("\n")
		.map((line) => validateRuleEvent(JSON.parse(line)));
}

async function telemetry(dir: string): Promise<Array<Record<string, unknown>>> {
	const segments = join(dir, "telemetry");
	const files = (await readdir(segments).catch(() => [] as string[])).filter((name) => /^\d{4}-\d{2}-\d{2}\.\d{6}\.jsonl$/.test(name)).sort();
	const records: Array<Record<string, unknown>> = [];
	for (const file of files) {
		for (const line of (await readFile(join(segments, file), "utf8")).trim().split("\n")) {
			if (line) records.push(JSON.parse(line) as Record<string, unknown>);
		}
	}
	return records;
}

async function callTool(tool: RegisteredTool, params: unknown, ctx: unknown): Promise<Record<string, unknown>> {
	return (await tool.execute("tool-id", params, undefined, () => {}, ctx)) as Record<string, unknown>;
}

/** Open the policy frame once through `open`, run the script against it, then close it with its Close control. */
async function driveFrame(ctx: { ui: Record<string, unknown> }, open: () => unknown, script: (frame: NavigationFrame) => Promise<void>): Promise<void> {
	ctx.ui.custom = async <T,>(factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: T) => void) => unknown): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const frame = factory({ terminal: { rows: 40, columns: 120 }, requestRender() {} }, theme, { getKeys: () => [] }, resolve) as NavigationFrame;
			script(frame).then(
				() => frame.close(),
				(error: unknown) => {
					// Reject first: closing resolves the custom view, and a settled promise ignores a later rejection.
					reject(error);
					frame.close();
				},
			);
		});
	await open();
}

const frameText = (frame: NavigationFrame) => frame.render(120).join("\n");

async function until(frame: NavigationFrame, pattern: RegExp): Promise<string> {
	for (let attempt = 0; attempt < 400; attempt++) {
		const text = frameText(frame);
		if (pattern.test(text)) return text;
		await turn();
	}
	throw new Error(`the view never showed ${pattern}\n${frameText(frame)}`);
}

/** Run one labelled action of the view the operator reads, as its control would. */
function act(frame: NavigationFrame, label: string): void {
	const action = frame.viewActions.find((candidate) => candidate.label === label);
	assert.ok(action, `no action ${label}: ${frame.viewActions.map((candidate) => candidate.label).join(", ")}`);
	assert.equal(action.disabled, undefined, `${label} is unavailable: ${action.disabled}`);
	action.run();
}

function typeText(frame: NavigationFrame, text: string): void {
	for (const character of text) frame.handleInput(character);
}

/** Focus the filter field with `/`, type to filter the list, then return to the list. */
function filterTo(frame: NavigationFrame, text: string): void {
	frame.handleInput("/");
	typeText(frame, text);
	frame.handleInput("\r");
}

/** Move from the list to the scope row, step right, and return to the list. */
function scopeRight(frame: NavigationFrame, steps: number): void {
	frame.handleInput("\u001b[Z");
	for (let step = 0; step < steps; step++) frame.handleInput("\u001b[C");
	frame.handleInput("\r");
}

/** Page through a complete artifact review until it reports every line read. */
async function readArtifact(frame: NavigationFrame): Promise<void> {
	for (let page = 0; page < 400; page++) {
		if (/All \d+ lines read/.test(frameText(frame))) return;
		frame.handleInput(PAGE_DOWN);
		await turn();
	}
	throw new Error("the review never reported a complete read");
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

/** The final action of an open artifact review. */
function decideAction(frame: NavigationFrame) {
	return frame.viewActions.find((action) => action.id === "decide");
}

describe("registration and lazy catalog use", () => {
	for (const [state, bytes, expected] of [
		["healthy", undefined, /No rule or pending proposal/],
		["degraded", "invalid\n", /registry health: degraded=true/],
		["incomplete", "{", /append in flight/],
	] as const) {
		it(`reports ${state} authority instead of false command lookup absence`, async () => {
			const { dir, pi, notifications, ctx } = await setup();
			await pi.command().handler("show missing.rule", ctx as never);
			if (bytes) await writeFile(join(dir, RULES_FILE), bytes, { mode: 0o600 });
			notifications.length = 0;
			await pi.command().handler("show missing.rule", ctx as never);
			const message = notifications.at(-1)?.message ?? "";
			assert.match(message, expected);
			if (state !== "healthy") assert.doesNotMatch(message, /No rule or pending proposal/);
		});
	}

	it("registers only the unified tools and performs no rule-store I/O at session startup", async () => {
		const { dir, pi, ctx } = await setup();
		assert.deepEqual([...pi.tools.keys()].sort(), [
			"policy_approve",
			"policy_control",
			"policy_propose",
			"policy_rules",
		]);
		assert.deepEqual([...pi.commands.keys()], ["policy"]);
		assert.equal(pi.handlers.has("user_bash"), false, "Operator shell commands remain outside model-tool policy");
		await pi.emit("session_start", { type: "session_start" }, ctx);
		await assert.rejects(stat(dir), /ENOENT/);
	});

	it("uses closed flat proposal fields without approval or state controls", () => {
		const schema = JSON.parse(JSON.stringify(PolicyProposeParams));
		assert.equal(schema.type, "object");
		assert.equal(schema.additionalProperties, false);
		assert.equal(schema.anyOf, undefined);
		assert.deepEqual(schema.required, ["operation", "id", "reason"]);
		assert.equal(schema.properties.operation.type, "string");
		assert.deepEqual(schema.properties.operation.enum, ["add", "replace", "retire", "disable"]);
		const propertyNames = new Set(Object.keys(schema.properties));
		for (const forbidden of ["approve", "reject", "decision", "state", "effect", "enable"]) {
			assert.equal(propertyNames.has(forbidden), false, `${forbidden} must not be exposed`);
		}
		assert.match(JSON.stringify(schema), /"maxLength":80/);
	});

	it("seeds the absent registry with the complete starter catalog on first use", async () => {
		const { dir, pi, ctx } = await setup();
		await callTool(pi.tool("policy_rules"), {}, ctx);
		const events = await storedEvents(dir);
		assert.equal(events.length, 1);
		assert.equal(events[0].kind, "catalog");
		if (events[0].kind === "catalog") {
			assert.deepEqual(
				events[0].rows,
				[...PACKAGE_CATALOG].sort((a, b) => a.id.localeCompare(b.id)),
			);
		}
	});
});

describe("panel command and shortcut", () => {
	it("registers the direct panel shortcut", async () => {
		const { pi } = await setup();
		assert.deepEqual([...pi.shortcuts.keys()], ["ctrl+alt+p"]);
		assert.equal(pi.shortcut().description, "Open the policy view");
	});

	for (const mode of ["observe", "notice", "annotate", "enforce"]) {
		it(`opens with only extension context and leaves existing rules unchanged in ${mode} mode`, async () => {
			const { dir, pi, ctx, notifications } = await setup(mode);
			await new RuleRegistry(dir).snapshot();
			const before = await readFile(join(dir, RULES_FILE), "utf8");
			const signal = new AbortController().signal;
			const shortcutContext = { ...ctx, signal, isIdle: () => false } as unknown as ExtensionContext;
			assert.equal("waitForIdle" in shortcutContext, false);
			assert.equal("sendUserMessage" in shortcutContext, false);
			await pi.shortcut().handler(shortcutContext);
			assert.equal(signal.aborted, false);
			assert.deepEqual(notifications, []);
			assert.deepEqual(pi.entries, []);
			assert.equal(await readFile(join(dir, RULES_FILE), "utf8"), before);
			assert.deepEqual(await readdir(dir), [RULES_FILE]);
		});
	}

	it("keeps the view's filter and selection between command and shortcut opens", async () => {
		const { pi, ctx } = await setup();
		let first = "";
		await driveFrame(ctx, () => pi.command().handler("", ctx as never), async (frame) => {
			await until(frame, /\d+ rules/);
			filterTo(frame, "routing");
			frame.handleInput("\u001b[B");
			first = await until(frame, /routing\./);
		});
		await driveFrame(ctx, () => pi.shortcut().handler(ctx as unknown as ExtensionContext), async (frame) => {
			assert.equal(await until(frame, /routing\./), first, "the reopened view shows the same filter and selection");
		});
	});

	it("opens one frame for overlapping command and shortcut opens and reads the registry once", async (t) => {
		const { pi, ctx } = await setup();
		const original = RuleRegistry.prototype.snapshot;
		let reads = 0;
		const snapshot = mock.method(RuleRegistry.prototype, "snapshot", async function (this: RuleRegistry) {
			reads++;
			return original.call(this);
		});
		t.after(() => snapshot.mock.restore());
		let frames = 0;
		await driveFrame(ctx, () => pi.command().handler("", ctx as never), async (frame) => {
			frames++;
			await until(frame, /\d+ rules/);
			await pi.shortcut().handler(ctx as unknown as ExtensionContext);
			await pi.command().handler("", ctx as never);
			assert.equal(frame.viewTitle, "Policy", "a second open moves the open frame to the policy view");
		});
		assert.equal(frames, 1, "no second frame opened");
		assert.equal(reads, 1, "the open view reads the registry once");
		await driveFrame(ctx, () => pi.shortcut().handler(ctx as unknown as ExtensionContext), async (frame) => {
			frames++;
			await until(frame, /\d+ rules/);
		});
		assert.equal(frames, 2);
		assert.equal(reads, 2, "a new frame reads again");
	});

	it("shows a registry read failure in the view, reports a UI failure, and opens again afterwards", async (t) => {
		const { pi, ctx, notifications } = await setup();
		const original = RuleRegistry.prototype.snapshot;
		let reads = 0;
		const snapshot = mock.method(RuleRegistry.prototype, "snapshot", async function (this: RuleRegistry) {
			if (++reads === 1) throw new Error("snapshot unavailable");
			return original.call(this);
		});
		t.after(() => snapshot.mock.restore());
		await driveFrame(ctx, () => pi.shortcut().handler(ctx as unknown as ExtensionContext), async (frame) => {
			await until(frame, /could not be read: snapshot unavailable/);
		});
		assert.deepEqual(notifications, [], "a read failure stays in the view");
		ctx.ui.custom = async () => {
			throw new Error("panel unavailable");
		};
		await pi.command().handler("", ctx as never);
		assert.deepEqual(notifications.at(-1), { message: "Policy registry action failed: panel unavailable", type: "error" });
		await driveFrame(ctx, () => pi.shortcut().handler(ctx as unknown as ExtensionContext), async (frame) => {
			await until(frame, /\d+ rules/);
		});
		assert.equal(reads, 2);
	});

	it("rejects invalid mode configuration through both entrypoints before store access", async (t) => {
		const { dir, pi, ctx, notifications } = await setup("invalid");
		const warn = mock.method(console, "warn", () => {});
		t.after(() => warn.mock.restore());
		await pi.shortcut().handler(ctx as unknown as ExtensionContext);
		await pi.command().handler("", ctx as never);
		assert.equal(warn.mock.callCount(), 1);
		assert.equal(notifications.length, 2);
		assert.ok(
			notifications.every(({ message, type }) => /mode configuration is invalid/.test(message) && type === "error"),
		);
		await assert.rejects(stat(dir), /ENOENT/);
	});

	/** The destinations this owner published, as the dashboard and the frame read them. */
	function publishedDestinations(pi: FakePi): Array<{ id: string; view: (ctx: unknown, host: ViewHost) => OperatorView }> {
		const views: Array<{ id: string; view: (ctx: unknown, host: ViewHost) => OperatorView }> = [];
		pi.events.on(OPERATOR_VIEW_PUBLISH, (value) => {
			const publication = value as { views: Array<{ id: string; view: (ctx: unknown, host: ViewHost) => OperatorView }> };
			views.push(...publication.views);
		});
		pi.events.emit(OPERATOR_VIEW_REQUEST, { version: 2 });
		return views;
	}

	function destinationHost(): ViewHost {
		return {
			theme: theme as unknown as Theme,
			target: { id: "session-1", label: "This session · work" },
			signal: new AbortController().signal,
			requestRender: () => {},
			notify: () => {},
			push: () => {},
			back: () => {},
			close: () => {},
		};
	}

	it("refuses the published destination on an invalid mode before creating the view or the store", async () => {
		const { dir, pi, ctx } = await setup("invalid");
		const policy = publishedDestinations(pi).find((view) => view.id === "policy");
		assert.ok(policy, "the policy destination is published");
		const view = policy.view(ctx as unknown, destinationHost());
		const text = (view.render(120, 20) ?? []).map((line) => stripVTControlCharacters(line)).join("\n");
		assert.match(text, /Policy is stopped because its mode configuration is invalid\./);
		await assert.rejects(stat(dir), /ENOENT/, "the store directory is never created");
	});

	it("opens the published destination with a valid mode and loads the store", async () => {
		const { dir, pi, ctx } = await setup("observe");
		const policy = publishedDestinations(pi).find((view) => view.id === "policy");
		assert.ok(policy, "the policy destination is published");
		const view = policy.view(ctx as unknown, destinationHost());
		let text = "";
		for (let attempt = 0; attempt < 400 && !/\d+ rules/.test(text); attempt++) {
			text = (view.render(120, 20) ?? []).map((line) => stripVTControlCharacters(line)).join("\n");
			await turn();
		}
		assert.match(text, /\d+ rules/, "the destination loads the registry");
		assert.ok((await stat(dir)).isDirectory(), "the store directory is created on first use");
	});

	for (const [mode, hasUI] of [
		["rpc", true],
		["json", false],
		["print", false],
		["tui", false],
	] as const) {
		it(`keeps the panel out of ${mode} mode with hasUI=${hasUI}`, async (t) => {
			const { dir, pi, notifications } = await setup();
			const ctx = context(notifications, { mode, hasUI });
			ctx.ui.custom = async () => assert.fail("No custom UI outside a usable TUI");
			const errors: string[] = [];
			const stderr = mock.method(process.stderr, "write", (value: string) => {
				errors.push(value);
				return true;
			});
			t.after(() => stderr.mock.restore());
			await pi.command().handler("", ctx as never);
			await pi.shortcut().handler(ctx as unknown as ExtensionContext);
			const messages = hasUI
				? notifications.map(({ message }) => message)
				: mode === "json"
					? pi.entries.map(({ data }) => (data as { text: string }).text)
					: errors;
			assert.equal(messages.length, 2);
			assert.ok(messages.every((text) => /requires TUI mode.*\/policy list/.test(text)));
			await assert.rejects(stat(dir), /ENOENT/);
		});
	}
});

describe("telemetry operator command", () => {
	it("reports an explicit date range without creating a rule or telemetry store", async () => {
		const { dir, pi, ctx, notifications } = await setup();
		await pi.command().handler("telemetry 2026-02-01 2026-02-02", ctx as never);
		assert.match(notifications.at(-1)?.message ?? "", /2026-02-01 through 2026-02-02/);
		assert.match(notifications.at(-1)?.message ?? "", /unavailable/);
		await assert.rejects(stat(dir), /ENOENT/);
		assert.deepEqual(await pi.completions()("tele"), [{ value: "telemetry", label: "telemetry" }]);
	});

	it("rejects missing, invalid, reversed, and overlong ranges", async () => {
		const { dir, pi, ctx, notifications } = await setup();
		for (const args of [
			"telemetry",
			"telemetry 2026-02-30 2026-03-01",
			"telemetry 2026-03-01 2026-02-01",
			"telemetry 2026-01-01 2026-03-01",
		]) {
			await pi.command().handler(args, ctx as never);
			assert.equal(notifications.at(-1)?.type, "error");
		}
		await assert.rejects(stat(dir), /ENOENT/);
	});

	it("uses protocol notifications in RPC and non-context entries in JSON mode", async () => {
		const { pi, notifications } = await setup();
		await pi.command().handler("telemetry 2026-02-01 2026-02-01",
			context(notifications, { mode: "rpc", hasUI: true }) as never);
		assert.match(notifications.at(-1)?.message ?? "", /Policy telemetry/);
		await pi.command().handler("telemetry 2026-02-01 2026-02-01",
			context(notifications, { mode: "json", hasUI: false }) as never);
		const entry = pi.entries.at(-1);
		assert.ok(entry);
		assert.equal(entry.customType, "policy_command");
		assert.match((entry.data as { text: string }).text, /Policy telemetry/);
	});
});

describe("unified tools and command gates", () => {
	it("validates command previews with the same bounded inspection contract as the tool", async () => {
		const { dir, pi, ctx, notifications } = await setup("enforce");
		const command = pi.command();
		const input = { tool: "read", input: { path: "sample.txt" }, result: { isError: false } };
		await command.handler(`preview ${JSON.stringify(input)}`, ctx as never);
		assert.equal(notifications.at(-1)?.type, "info");
		assert.match(notifications.at(-1)?.message ?? "", /"preview": true/);
		const before = await storedEvents(dir);
		for (const invalid of [
			null,
			[],
			{ ...input, view: "health" },
			{ ...input, unexpected: true },
			{ ...input, input: Object.fromEntries(Array.from({ length: 129 }, (_, n) => [`key${n}`, n])) },
			{ ...input, result: null },
			{ ...input, result: {} },
			{ ...input, result: { isError: "false" } },
			{ ...input, result: { isError: false, usage: { totalTokens: 1 } } },
			{ ...input, result: { isError: false, content: [{ type: "image", data: "sample" }] } },
			{ ...input, result: { isError: false, content: [{ type: "text", text: "body", extra: true }] } },
			{ ...input, result: { isError: false, details: "x".repeat(65_536) } },
		]) {
			await command.handler(`preview ${JSON.stringify(invalid)}`, ctx as never);
			assert.equal(notifications.at(-1)?.type, "error");
			assert.doesNotMatch(notifications.at(-1)?.message ?? "", /"preview": true/);
		}
		assert.deepEqual(await storedEvents(dir), before, "Preview validation never changes authority");
	});

	it("completes data actions, stored names, exact revisions, and whole-state reset", async () => {
		const { pi, ctx, notifications } = await setup();
		const command = pi.command();
		const completions = async (prefix: string) =>
			((await pi.completions()(prefix)) as Array<{ value: string }>).map((item) => item.value);
		assert.deepEqual(await completions("data "), [
			"data list",
			"data show",
			"data set",
			"data set-file",
			"data remove",
		]);
		assert.deepEqual(await completions("data show "), []);
		assert.deepEqual(await completions("reset --"), ["reset --all"]);
		const artifact = {
			expectedRevision: null,
			data: { name: "rooms", kind: "table", source: "test", capturedAt: 1, rows: [{ key: "lobby", value: "1" }] },
		};
		await command.handler(`data set ${JSON.stringify(artifact)}`, ctx as never);
		const approval = (notifications.at(-1)?.message ?? "").match(/\/policy data set (.+)/)?.[1];
		assert.ok(approval);
		await command.handler(`data set ${approval}`, ctx as never);
		assert.equal(notifications.at(-1)?.type, "info");
		assert.deepEqual(await completions("data show ro"), ["data show rooms"]);
		assert.deepEqual(await completions("data remove "), ["data remove rooms"]);
		const [remove] = await completions("data remove rooms ");
		assert.match(remove, /^data remove rooms [a-f0-9]{12}$/);
		assert.deepEqual(await completions(`${remove} `), [`${remove} exact`]);
		assert.deepEqual(await completions("data remove rooms 000000000000 "), []);
		await command.handler(`${remove} exact`, ctx as never);
		assert.deepEqual(await completions("data show "), []);
		assert.deepEqual(await completions("data remove rooms "), []);
	});
	it("resolves set-file paths against the command context and commits only after exact approval", async () => {
		const { dir, pi, notifications } = await setup();
		const cwd = await mkdtemp(join(tmpdir(), "policy-data-cwd-"));
		await writeFile(
			join(cwd, "table.json"),
			JSON.stringify({
				expectedRevision: null,
				data: {
					name: "rooms",
					kind: "table",
					collation: "ascii-case-insensitive",
					source: "operator-file",
					capturedAt: 1,
					rows: [{ key: "Lobby", value: "room-7" }],
				},
			}),
		);
		const ctx = context(notifications, { cwd, mode: "rpc", hasUI: true });
		const command = pi.command();
		await command.handler('data set-file {"path":"table.json"}', ctx as never);
		assert.equal(
			(await storedEvents(dir)).some((event) => event.kind === "data" && event.operation === "set"),
			false,
		);
		const message = notifications.at(-1)?.message ?? "";
		const revision = message.match(/"approveRevision":"([a-f0-9]{12})"/)?.[1];
		assert.ok(revision, message);
		await command.handler(
			`data set-file ${JSON.stringify({ path: "table.json", approveRevision: revision })}`,
			ctx as never,
		);
		const events = (await storedEvents(dir)).filter((event) => event.kind === "data" && event.operation === "set");
		assert.equal(events.length, 1);
		if (events[0].kind === "data" && events[0].operation === "set") {
			assert.equal(events[0].data.source, "operator-file");
			assert.equal(events[0].data.capturedAt, 1);
		}
	});
	it("policy_rules reports record definitions, overrides, proposals, context, and health", async () => {
		const { pi, ctx } = await setup();
		await pi.command().handler("effect routing.cat-read steer operator calibration", ctx as never);
		const proposed = await callTool(
			pi.tool("policy_propose"),
			{
				operation: "add",
				id: "local.pending",
				purpose: "Keep search output bounded.",
				authority: "steer-or-block",
				reason: "Inspect this proposal",
				note: "Use a bounded local command.",
				match: { command: "scan" },
			},
			ctx,
		);
		const proposalId = (proposed.details as { proposalId: string }).proposalId;
		const result = await callTool(pi.tool("policy_rules"), {}, ctx);
		const text = (result.content as Array<{ text: string }>)[0].text;
		assert.match(text, /SESSION CONTEXT/);
		assert.match(text, /model provider: openai-codex/);
		assert.match(
			text,
			/routing\.cat-read \| source=package \| purpose=.+ \| authority=steer-or-block \| matcher=code:routing\.cat-read/,
		);
		assert.match(text, /state=active \| effect=steer \| override reason=operator calibration/);
		assert.match(text, /definition: revision=[0-9a-f]{12} state=active effect=block/);
		assert.match(text, /override audit: command .*session=session-1 model=openai-codex\/gpt-5\.6-sol/);
		assert.match(text, /override against revision: [0-9a-f]{12}/);
		assert.match(
			text,
			new RegExp(`${proposalId} \\| add \\| local\\.pending \\| revision=[0-9a-f]{12} \\| Inspect this proposal`),
		);
		assert.match(text, /PENDING PROPOSALS/);
		assert.match(text, /registry health: degraded=false \| ok/);
	});

	it("agent add remains inert until exact operator approval, then declarative matching joins package dispatch", async () => {
		const { pi, ctx, notifications } = await setup("enforce");
		const propose = pi.tool("policy_propose");
		const result = await callTool(
			propose,
			{
				operation: "add",
				id: "local.scan",
				purpose: "Keep search output bounded.",
				authority: "steer-or-block",
				reason: "Bound scans",
				note: "Use a bounded scan command.",
				match: { command: "scan", flags: ["--all"], operands: { min: 1 } },
				suggestion: { command: "scan", flags: ["--limit", "50"] },
				scope: { modelProviders: ["openai-codex"], models: ["openai-codex/gpt-5.6-sol"], cwdPrefixes: ["/work"] },
			},
			ctx,
		);
		const proposalId = (result.details as { proposalId: string }).proposalId;
		assert.match((result.content as Array<{ text: string }>)[0].text, /inert until operator approval/);
		assert.equal(
			await pi.emit(
				"tool_call",
				{ toolName: "bash", toolCallId: "before", input: { command: "scan --all target" } },
				ctx,
			),
			undefined,
		);

		await pi.command().handler(`approve ${proposalId}`, ctx as never);
		assert.match(notifications.at(-1)?.message ?? "", /Policy approval canceled/);
		await pi.command().handler(`approve ${proposalId} block`, ctx as never);
		assert.match(notifications.at(-1)?.message ?? "", /Approved add proposal/);
		const blocked = (await pi.emit(
			"tool_call",
			{ toolName: "bash", toolCallId: "after", input: { command: "scan --all target" } },
			ctx,
		)) as { block?: boolean; reason?: string };
		assert.equal(blocked.block, true);
		assert.match(blocked.reason ?? "", /bounded scan/);
	});

	it("keeps a rule named all distinct from the explicit whole-runtime reset", async () => {
		const { pi, ctx } = await setup();
		const proposed = await callTool(
			pi.tool("policy_propose"),
			{
				operation: "add",
				id: "all",
				purpose: "Keep search output bounded.",
				authority: "steer-or-block",
				reason: "Use a distinct rule identity.",
				note: "Keep rule identity separate from command flags.",
				match: { command: "sample" },
			},
			ctx,
		);
		const proposalId = (proposed.details as { proposalId: string }).proposalId;
		const command = pi.command();
		await command.handler(`approve ${proposalId} block`, ctx as never);
		const periods = async () => {
			const result = await callTool(pi.tool("policy_rules"), { view: "state" }, ctx);
			return (
				JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
					observationPeriods: Array<{ id: string; generation: number }>;
				}
			).observationPeriods;
		};
		const before = await periods();
		await command.handler("reset all selected rule", ctx as never);
		const selected = await periods();
		assert.notEqual(
			selected.find((entry) => entry.id === "all")?.generation,
			before.find((entry) => entry.id === "all")?.generation,
		);
		const other = before.find((entry) => entry.id !== "all");
		assert.ok(other);
		assert.equal(selected.find((entry) => entry.id === other.id)?.generation, other.generation);
		await command.handler("reset --all whole runtime", ctx as never);
		assert.notEqual((await periods()).find((entry) => entry.id === other.id)?.generation, other.generation);
	});

	it("approves command replacements only with both effect and exact revision", async () => {
		const { pi, ctx, notifications } = await setup("enforce");
		const proposalTool = pi.tool("policy_propose");
		const added = await callTool(
			proposalTool,
			{
				operation: "add",
				id: "local.replace",
				purpose: "Keep search output bounded.",
				authority: "steer-or-block",
				reason: "Initial rule",
				note: "Bound the command.",
				match: { command: "scan" },
			},
			ctx,
		);
		const addId = (added.details as { proposalId: string }).proposalId;
		const command = pi.command();
		await command.handler(`approve ${addId} block`, ctx as never);
		const inspected = await callTool(pi.tool("policy_rules"), {}, ctx);
		const rulesText = (inspected.content as Array<{ text: string }>)[0].text;
		const revision = /local\.replace[^\n]*\n\s+definition: revision=([0-9a-f]{12})/.exec(rulesText)?.[1];
		assert.ok(revision);
		const replaced = await callTool(
			proposalTool,
			{
				operation: "replace",
				id: "local.replace",
				purpose: "Keep search output bounded.",
				authority: "steer-or-block",
				expectedRevision: revision,
				reason: "New command",
				note: "Bound the new command.",
				match: { command: "walk" },
			},
			ctx,
		);
		const details = replaced.details as { proposalId: string; proposalRevision: string };
		await command.handler(`approve ${details.proposalId} exact ${details.proposalRevision}`, ctx as never);
		assert.match(notifications.at(-1)?.message ?? "", /Selectable replacement approval requires/);
		const completions = (await pi.completions()(`approve ${details.proposalId} `)) as Array<{ value: string }>;
		assert.deepEqual(
			completions.map((row) => row.value),
			[
				`approve ${details.proposalId} steer ${details.proposalRevision}`,
				`approve ${details.proposalId} block ${details.proposalRevision}`,
			],
		);
		await command.handler(`approve ${details.proposalId} block ${details.proposalRevision}`, ctx as never);
		assert.match(notifications.at(-1)?.message ?? "", /Approved replace proposal/);
		assert.equal(
			(
				(await pi.emit(
					"tool_call",
					{ toolName: "bash", toolCallId: "replacement", input: { command: "walk" } },
					ctx,
				)) as { block: boolean }
			).block,
			true,
		);
	});

	it("the agent can only leave a disable proposal pending", async () => {
		const { pi, ctx } = await setup();
		const result = await callTool(
			pi.tool("policy_propose"),
			{ operation: "disable", id: "routing.cat-read", reason: "Context-specific false positive" },
			ctx,
		);
		const proposalId = (result.details as { proposalId: string }).proposalId;
		const rules = await callTool(pi.tool("policy_rules"), {}, ctx);
		assert.match((rules.content as Array<{ text: string }>)[0].text, new RegExp(proposalId));
	});

	it("requires reasons for every direct change and composes package overrides", async () => {
		const { dir, pi, ctx, notifications } = await setup();
		const command = pi.command();
		for (const verb of ["disable routing.cat-read", "enable routing.cat-read", "retire routing.cat-read"] as const) {
			await command.handler(verb, ctx as never);
			assert.match(notifications.at(-1)?.message ?? "", /Policy control canceled/);
		}
		await command.handler("effect routing.cat-read steer", ctx as never);
		assert.match(notifications.at(-1)?.message ?? "", /Policy control canceled/);
		assert.equal((await storedEvents(dir)).length, 1, "reasonless changes must append no authority event");

		await command.handler("effect routing.cat-read steer calibrated failure cost", ctx as never);
		await command.handler("disable routing.cat-read temporary context", ctx as never);
		let result = await callTool(pi.tool("policy_rules"), {}, ctx);
		let text = (result.content as Array<{ text: string }>)[0].text;
		assert.match(text, /routing\.cat-read.*state=disabled.*effect=steer.*override reason=temporary context/);
		await command.handler("enable routing.cat-read context restored", ctx as never);
		result = await callTool(pi.tool("policy_rules"), {}, ctx);
		text = (result.content as Array<{ text: string }>)[0].text;
		assert.match(text, /routing\.cat-read.*state=active.*effect=steer.*override reason=context restored/);
	});

	it("guides incomplete TUI controls with safe labels and refuses changes during a prompt", async () => {
		const { pi, ctx, dir, notifications } = await setup();
		const registry = new RuleRegistry(dir);
		const command = pi.command();
		const prompts: string[] = [];
		const guided = {
			...ctx,
			ui: {
				...(ctx as { ui: object }).ui,
				select: async (title: string, choices: string[]) => {
					prompts.push(title);
					for (const choice of choices) assert.doesNotMatch(choice, /[\u0000-\u001f\u007f-\u009f]/);
					return choices.find((choice) => choice.startsWith("local.guided")) ?? choices[0];
				},
				input: async () => "Selected reason.",
				custom: async () => true,
			},
		};
		await callTool(
			pi.tool("policy_propose"),
			{
				operation: "add",
				id: "local.guided",
				purpose: "Bound\u001b[31m scans.\nSafely.",
				authority: "steer-or-block",
				reason: "Selected rule.",
				note: "Bound scans.",
				match: { command: "scan" },
			},
			ctx,
		);
		await command.handler("approve", guided as never);
		assert.equal((await registry.snapshot()).pending.length, 0);
		assert.ok(prompts.some((title) => title.includes("which policy proposal")));
		for (const args of ["disable local.guided", "enable local.guided", "effect local.guided", "reset local.guided"]) {
			await command.handler(args, guided as never);
			assert.equal(notifications.at(-1)?.type, "info", notifications.at(-1)?.message);
			assert.doesNotMatch(notifications.at(-1)?.message ?? "", /Usage:|failed|canceled/);
		}
		const stale = {
			...guided,
			ui: {
				...guided.ui,
				input: async () => {
					await registry.setEffect("local.guided", "block", "Concurrent effect.", {
						surface: "command",
						at: new Date().toISOString(),
						session: "concurrent",
						model: null,
					});
					return "Pause this rule.";
				},
			},
		};
		await command.handler("disable local.guided", stale as never);
		assert.match(notifications.at(-1)?.message ?? "", /target revision changed/);
		assert.notEqual((await registry.snapshot()).records.get("local.guided")?.override?.state, "disabled");
		await callTool(
			pi.tool("policy_propose"),
			{ operation: "disable", id: "local.guided", reason: "Pending pause." },
			ctx,
		);
		await command.handler("reject", guided as never);
		assert.equal((await registry.snapshot()).pending.length, 0);
		const data = { name: "guided", kind: "table", rows: [{ key: "a", value: "b" }] };
		const dataUi = { ...guided, ui: { ...guided.ui, editor: async () => JSON.stringify({ data }) } };
		await command.handler("data set", dataUi as never);
		assert.equal((await registry.snapshot()).data.get("guided")?.rows[0].value, "b");
		data.rows[0].value = "c";
		await command.handler("data set", dataUi as never);
		assert.equal((await registry.snapshot()).data.get("guided")?.rows[0].value, "c");
		await command.handler("data set", {
			...dataUi,
			ui: { ...dataUi.ui, editor: async () => JSON.stringify({ data, expectedRevision: "000000000000" }) },
		} as never);
		assert.match(notifications.at(-1)?.message ?? "", /revision changed/);
		await command.handler("data remove guided", guided as never);
		assert.equal((await registry.snapshot()).data.size, 0);
		let asked = false;
		await command.handler("disable local.absent", {
			...guided,
			ui: {
				...guided.ui,
				input: async () => {
					asked = true;
					return "Pause.";
				},
			},
		} as never);
		assert.equal(asked, false);
		assert.match(notifications.at(-1)?.message ?? "", /existed at command admission/);
		await command.handler("reset local.guided", {
			...guided,
			ui: {
				...guided.ui,
				input: async () => {
					await command.handler("reset local.guided Concurrent reset", ctx as never);
					return "Reset after another command.";
				},
			},
		} as never);
		assert.match(notifications.at(-1)?.message ?? "", /Observation period revision changed/);
		await command.handler("reset", {
			...guided,
			ui: {
				...guided.ui,
				select: async (_title: string, choices: string[]) => {
					await command.handler("reset local.guided Concurrent picker reset", ctx as never);
					return choices.find((choice) => choice.startsWith("local.guided"));
				},
			},
		} as never);
		assert.match(notifications.at(-1)?.message ?? "", /Observation period revision changed/);
		await command.handler("disable local.guided Hide from reset", ctx as never);
		const resetChoices = await pi.completions()("reset local.guided");
		assert.deepEqual(resetChoices, []);
		assert.deepEqual(await pi.completions()("import invalid.catalog "), []);
		assert.ok(((await pi.completions()("import routing.cat-read ")) as unknown[])?.length);
	});

	it("reviews exact and replacement effects without asking for omitted revisions", async () => {
		const { pi, ctx, dir, notifications } = await setup();
		let reviews = 0;
		const guided = {
			...ctx,
			ui: {
				...(ctx as { ui: object }).ui,
				custom: async () => {
					reviews++;
					return true;
				},
			},
		};
		const base = {
			operation: "add",
			id: "local.exact",
			purpose: "Protect scans.",
			authority: "exact",
			reason: "Selected rule.",
			note: "Bound scans.",
			match: { command: "scan" },
		};
		await callTool(pi.tool("policy_propose"), base, ctx);
		await pi.command().handler("approve local.exact exact", guided as never);
		assert.equal(reviews, 1);
		assert.match(notifications.at(-1)?.message ?? "", /Approved add/);
		const registry = new RuleRegistry(dir);
		const record = (await registry.snapshot()).records.get("local.exact");
		assert.ok(record);
		await callTool(
			pi.tool("policy_propose"),
			{ ...base, operation: "replace", authority: "steer-or-block", expectedRevision: record.definition.revision },
			ctx,
		);
		await pi.command().handler("approve local.exact block", guided as never);
		assert.equal(reviews, 2);
		assert.match(notifications.at(-1)?.message ?? "", /Approved replace/);
		assert.equal((await registry.snapshot()).records.get("local.exact")?.definition.effect, "block");
	});

	it("keeps complete commands and the inspection route visible for oversized headless proposals", async () => {
		const { pi, ctx, notifications } = await setup();
		const at = Object.fromEntries(
			Array.from({ length: 4 }, (_, index) => [String(index), Array.from({ length: 64 }, () => "x".repeat(200))]),
		);
		const proposed = await callTool(
			pi.tool("policy_propose"),
			{
				operation: "add",
				id: "local.large",
				purpose: "Protect scans.",
				authority: "exact",
				reason: "Selected rule.",
				note: "Bound scans.",
				match: { command: "scan", operands: { at } },
			},
			ctx,
		);
		const p = proposed.details as { proposalId: string; proposalRevision: string };
		await pi.command().handler("approve local.large", { ...ctx, mode: "rpc" } as never);
		const output = notifications.at(-1)?.message ?? "";
		assert.match(output, /not a complete review/);
		assert.match(output, /policy_rules/);
		assert.ok(output.includes(`/policy approve ${p.proposalId} exact ${p.proposalRevision}`));
		assert.ok(Buffer.byteLength(output) < 32768);
	});

	it("completes references and effects at each command token position", async () => {
		const { pi, ctx } = await setup();
		const command = pi.command();
		const complete = pi.completions();
		const completions = async (prefix: string): Promise<string[]> =>
			((await complete(prefix)) as Array<{ value: string }>).map((item) => item.value);
		await callTool(pi.tool("policy_rules"), {}, ctx);
		const proposed = await callTool(
			pi.tool("policy_propose"),
			{
				operation: "add",
				id: "local.scan",
				purpose: "Keep search output bounded.",
				authority: "steer-or-block",
				reason: "Complete this proposal",
				note: "Use a bounded scan.",
				match: { command: "scan" },
			},
			ctx,
		);
		const { proposalId, proposalRevision: revision } = proposed.details as {
			proposalId: string;
			proposalRevision: string;
		};

		assert.ok((await completions("sh")).includes("show"));
		assert.ok((await completions("show rou")).includes("show routing.cat-read"));
		assert.ok((await completions("show ")).includes(`show ${proposalId}`));
		const shown = await complete("show local.scan") as Array<{ value: string; label: string; description: string }>;
		assert.deepEqual(shown, [{ value: `show ${proposalId}`, label: "local.scan · pending add", description: "Keep search output bounded." }]);
		assert.deepEqual(await completions("approve "), [
			`approve ${proposalId} steer ${revision}`,
			`approve ${proposalId} block ${revision}`,
		]);
		assert.deepEqual(await completions("reject "), [`reject ${proposalId} ${revision}`]);
		assert.deepEqual(await completions(`approve ${proposalId} `), [
			`approve ${proposalId} steer ${revision}`,
			`approve ${proposalId} block ${revision}`,
		]);
		assert.deepEqual(await completions("effect routing.cat-read "), [
			"effect routing.cat-read steer",
			"effect routing.cat-read block",
		]);
		assert.ok((await completions("disable routing.")).includes("disable routing.cat-read"));
		assert.deepEqual(await completions("enable routing.cat-read"), []);
		assert.ok((await completions("retire ")).includes("retire routing.cat-read"));

		await command.handler(`approve ${proposalId} steer`, ctx as never);
		assert.ok((await completions("retire ")).includes("retire local.scan"));
		assert.ok((await completions("catalog ")).includes("catalog routing.cat-read"));
		assert.ok((await completions("import ")).includes("import --all"));
		assert.ok((await completions("effect local.")).includes("effect local.scan"));
		await command.handler("disable routing.cat-read completion setup", ctx as never);
		assert.ok((await completions("enable routing.")).includes("enable routing.cat-read"));
	});

	it("approves disable through the view with panel audit and preserves an effect override", async () => {
		const { dir, pi, ctx } = await setup();
		await pi.command().handler("effect routing.cat-read steer panel composition setup", ctx as never);
		const proposed = await callTool(
			pi.tool("policy_propose"),
			{ operation: "disable", id: "routing.cat-read", reason: "Panel-approved pause" },
			ctx,
		);
		const proposalId = (proposed.details as { proposalId: string }).proposalId;
		ctx.ui.confirm = async () => assert.fail("Native confirmation must not approve complete artifacts");
		await driveFrame(ctx, () => pi.shortcut().handler(ctx as unknown as ExtensionContext), async (frame) => {
			await until(frame, /\d+ rules/);
			scopeRight(frame, 1);
			await until(frame, /Panel-approved pause/);
			act(frame, "Approve…");
			await readArtifact(frame);
			act(frame, "Approve disable");
			await until(frame, /Approved proposal/);
		});
		const events = await storedEvents(dir);
		const panelDecision = events.find((event) => event.kind === "decision" && event.proposalId === proposalId);
		assert.equal(panelDecision?.kind, "decision");
		if (panelDecision?.kind === "decision") assert.equal(panelDecision.audit.surface, "panel");
		const rules = await callTool(pi.tool("policy_rules"), {}, ctx);
		assert.match(
			(rules.content as Array<{ text: string }>)[0].text,
			/routing\.cat-read.*state=disabled.*effect=steer.*override reason=Panel-approved pause/,
		);
	});

	it("does not construct the custom panel outside TUI mode", async () => {
		const { pi, ctx, notifications } = await setup();
		await pi.command().handler("", {
			...ctx,
			mode: "rpc",
			ui: {
				...(ctx as { ui: Record<string, unknown> }).ui,
				custom: () => assert.fail("custom panel must not be constructed outside TUI mode"),
			},
		} as never);
		assert.match(notifications.at(-1)?.message ?? "", /requires TUI mode.*\/policy list/);
	});

	it("emits successful and failed command text as JSON custom entries without a UI", async () => {
		const { pi, ctx, notifications } = await setup();
		const command = pi.command();
		const jsonCtx = { ...ctx, mode: "json", hasUI: false };
		await command.handler("mode", jsonCtx as never);
		await command.handler("mode extra", jsonCtx as never);
		assert.deepEqual(notifications, []);
		assert.deepEqual(pi.entries, [
			{
				customType: "policy_command",
				data: {
					text: "observe (--policy-mode)\nRecords every tool call and applies no mechanism.\nRule store healthy.",
				},
			},
			{ customType: "policy_command", data: { text: "Usage: /policy mode" } },
		]);
	});

	it("writes successful and failed command text to print-mode streams without a UI", async () => {
		const { pi, ctx, notifications } = await setup();
		const command = pi.command();
		const printCtx = { ...ctx, mode: "print", hasUI: false };
		const stdout: string[] = [];
		const stderr: string[] = [];
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdout.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await command.handler("mode", printCtx as never);
			await command.handler("mode extra", printCtx as never);
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
		}
		assert.deepEqual(notifications, []);
		assert.deepEqual(pi.entries, []);
		assert.equal(
			stdout.join(""),
			"observe (--policy-mode)\nRecords every tool call and applies no mechanism.\nRule store healthy.\n",
		);
		assert.equal(stderr.join(""), "Usage: /policy mode\n");
	});

	it("lists exact help and rejects state mutation through the inspection verb", async () => {
		const { pi, ctx, notifications } = await setup();
		const command = pi.command();
		await command.handler("help", ctx as never);
		const usage = notifications.at(-1)?.message ?? "";
		assert.match(usage, /\/policy disable <id> <reason\.\.\.>/);
		assert.match(usage, /\/policy enable <id> <reason\.\.\.>/);
		assert.match(usage, /\/policy retire <id> <reason\.\.\.>/);
		assert.doesNotMatch(usage, /\/policy state/);
		await command.handler("state routing.cat-read active", ctx as never);
		assert.match(notifications.at(-1)?.message ?? "", /Usage: \/policy state/);
	});
});

describe("catalog command controls", () => {
	it("uses the complete artifact review instead of native confirmation for TUI imports", async () => {
		const { dir, pi, ctx } = await setup();
		let pages = 0;
		ctx.ui.confirm = async () => assert.fail("Native confirmation hides long artifacts");
		ctx.ui.custom = async <T,>(
			factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: T) => void) => unknown,
		): Promise<T> =>
			new Promise<T>((resolve) => {
				const frame = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, theme, { getKeys: () => [] }, resolve) as NavigationFrame;
				for (; pages < 1000; pages++) {
					assert.ok(frame.render(80).length <= 24);
					const final = frame.viewActions.find((action) => action.label === "Import");
					assert.ok(final, "the final action names the import");
					if (final.disabled === undefined) {
						final.run();
						return;
					}
					frame.handleInput(PAGE_DOWN);
				}
			});
		await pi.command().handler("import --all", ctx as never);
		assert.ok(pages > 1, "the artifact needed more than one page");
		const imports = (await storedEvents(dir)).filter((event) => event.kind === "import");
		assert.equal(imports.length, 1);
		assert.equal(imports[0].rows.length, PACKAGE_CATALOG.length);
	});

	it("inspects bundled rows and imports with revision-bound no-UI authority", async () => {
		const { dir, pi, notifications } = await setup();
		const ctx = context(notifications, { mode: "json", hasUI: false });
		const command = pi.command();
		await command.handler("catalog routing.cat-read", ctx as never);
		assert.match(JSON.stringify(pi.entries.at(-1)?.data), /bundled starter catalog/);
		const inspected = await callTool(pi.tool("policy_rules"), { view: "catalog", id: "routing.cat-read" }, ctx);
		assert.match(JSON.stringify(inspected), /routing.cat-read/);
		await command.handler("retire routing.cat-read Remove this rule.", ctx as never);
		await command.handler("import routing.cat-read", ctx as never);
		const preview = JSON.stringify(pi.entries.at(-1)?.data);
		assert.match(preview, /No rules changed/);
		const exactMatch = /\/policy import routing\.cat-read exact ([a-f0-9]{12})/.exec(preview);
		assert.ok(exactMatch);
		const exact = exactMatch[1];
		await command.handler(`import routing.cat-read exact ${exact}`, ctx as never);
		assert.match(JSON.stringify(pi.entries.at(-1)?.data), /Imported 1/);
		assert.equal((await storedEvents(dir)).at(-1)?.kind, "import");
		await command.handler(`import routing.cat-read exact ${exact}`, ctx as never);
		assert.match(JSON.stringify(pi.entries.at(-1)?.data), /revision changed/);
	});
});

describe("dispatch and telemetry", () => {
	it("preserves built-in blocking and records unified classes plus healthy rule-store status", async () => {
		const { dir, pi, ctx } = await setup("enforce");
		let reads = 0;
		const input = {
			get command() {
				reads++;
				return reads === 1 ? "cat notes.md" : "npm test";
			},
		};
		const blocked = (await pi.emit("tool_call", { toolName: "bash", toolCallId: "c1", input }, ctx)) as {
			block: boolean;
			reason: string;
		};
		assert.equal(reads, 1);
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /read tool/);
		await pi.emit(
			"tool_execution_end",
			{ toolCallId: "c1", isError: true, result: { content: [{ type: "text", text: blocked.reason }] } },
			ctx,
		);
		await pi.emit("session_shutdown", {}, ctx);
		const records = await telemetry(dir);
		assert.equal(records.length, 1);
		assert.deepEqual(records[0].classes, ["routing.cat-read"]);
		assert.equal(records[0].blocked, true);
		assert.equal(records[0].ruleStoreDegraded, false);
		assert.equal(records[0].captured, "cat notes.md");
	});

	it("prevents a disabled package rule from affecting enforcement", async () => {
		const { pi, ctx } = await setup("enforce");
		await pi.command().handler("disable routing.cat-read intentional exception", ctx as never);
		assert.equal(
			await pi.emit("tool_call", { toolName: "bash", toolCallId: "c1", input: { command: "cat notes.md" } }, ctx),
			undefined,
		);
	});

	it("loads no fallback rules and records degradation on every telemetry row", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "policy-index-degraded-")), "policy");
		await mkdir(dir, { mode: 0o700 });
		await writeFile(
			join(dir, RULES_FILE),
			`${JSON.stringify({ kind: "catalog", rows: PACKAGE_CATALOG, audit: { surface: "package" } })}\n{"bad":true}\n`,
			{ mode: 0o600 },
		);
		const previous = process.env.PI_POLICY_DIR;
		process.env.PI_POLICY_DIR = dir;
		const pi = new FakePi();
		pi.flags.set("policy-mode", "enforce");
		registerPolicy(pi as never);
		if (previous === undefined) delete process.env.PI_POLICY_DIR;
		else process.env.PI_POLICY_DIR = previous;
		const notifications: Array<{ message: string; type?: string }> = [];
		const ctx = context(notifications);
		for (let index = 1; index <= 3; index++) {
			const callId = `c${index}`;
			assert.equal(
				await pi.emit(
					"tool_call",
					{ toolName: "bash", toolCallId: callId, input: { command: `cat notes-${index}.md` } },
					ctx,
				),
				undefined,
			);
			await pi.emit(
				"tool_result",
				{ toolCallId: callId, content: [{ type: "text", text: "content" }], isError: false, usage: {} },
				ctx,
			);
			await pi.emit(
				"tool_execution_end",
				{
					toolName: "bash",
					toolCallId: callId,
					isError: false,
					result: { content: [{ type: "text", text: "content" }] },
				},
				ctx,
			);
		}
		await pi.emit("session_shutdown", {}, ctx);
		assert.equal(notifications.filter((entry) => /rule store unreadable/i.test(entry.message)).length, 1);
		assert.equal(notifications.filter((entry) => /\[policy\] routing\.cat-read/.test(entry.message)).length, 0);
		const records = await telemetry(dir);
		assert.equal(records.length, 3);
		assert.ok(records.every((record) => record.ruleStoreDegraded === true));
		assert.ok(records.every((record) => record.blocked === undefined));
		assert.ok(records.every((record) => record.notified === undefined));
	});

	it("annotates steer rules once per session and never annotates an errored result", async () => {
		const { pi, ctx } = await setup("enforce");
		await pi.command().handler("effect routing.cat-read steer lower cost", ctx as never);
		await pi.emit("tool_call", { toolName: "bash", toolCallId: "c1", input: { command: "cat notes.md" } }, ctx);
		const first = (await pi.emit(
			"tool_result",
			{ toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: false, usage: {} },
			ctx,
		)) as { content: Array<{ text: string }> };
		assert.match(first.content.at(-1)?.text ?? "", /^\[policy\]/);
		await pi.emit("tool_call", { toolName: "bash", toolCallId: "c2", input: { command: "cat other.md" } }, ctx);
		assert.equal(
			await pi.emit(
				"tool_result",
				{ toolCallId: "c2", content: [{ type: "text", text: "ok" }], isError: false, usage: {} },
				ctx,
			),
			undefined,
		);
		await pi.emit(
			"tool_call",
			{ toolName: "bash", toolCallId: "c3", input: { command: "cat third.md" } },
			{ ...ctx, sessionManager: { getSessionId: () => "session-2" } },
		);
		assert.equal(
			await pi.emit(
				"tool_result",
				{ toolCallId: "c3", content: [{ type: "text", text: "failed" }], isError: true, usage: {} },
				ctx,
			),
			undefined,
		);
	});
});

describe("view controls reach the owner operations", () => {
	const open = (pi: Awaited<ReturnType<typeof setup>>["pi"], ctx: Awaited<ReturnType<typeof setup>>["ctx"]) => () => pi.shortcut().handler(ctx as unknown as ExtensionContext);

	it("disables the selected rule with the entered reason, panel audit, and the displayed identity", async () => {
		const { dir, pi, ctx } = await setup();
		await driveFrame(ctx, open(pi, ctx), async (frame) => {
			await until(frame, /\d+ rules/);
			filterTo(frame, "routing.cat-read");
			act(frame, "Disable…");
			await until(frame, /Disable rule routing\.cat-read/);
			typeText(frame, "panel reason");
			act(frame, "Disable rule");
			await until(frame, /Disabled routing\.cat-read\./);
		});
		const events = await storedEvents(dir);
		const override = events.find((event) => event.kind === "override" && event.ruleId === "routing.cat-read");
		assert.ok(override && override.kind === "override" && override.operation === "set");
		if (override.kind === "override" && override.operation === "set") {
			assert.equal(override.override.state, "disabled");
			assert.equal(override.override.reason, "panel reason");
			assert.equal(override.override.audit.surface, "panel");
		}
	});

	it("writes nothing when the form is cancelled or its reason is empty", async () => {
		const { dir, pi, ctx } = await setup();
		await driveFrame(ctx, open(pi, ctx), async (frame) => {
			await until(frame, /\d+ rules/);
			filterTo(frame, "routing.cat-read");
			act(frame, "Disable…");
			act(frame, "Disable rule");
			await until(frame, /Write the reason first\./);
			act(frame, "Cancel");
			await until(frame, /\d+ rules/);
		});
		const events = await storedEvents(dir);
		assert.equal(events.some((event) => event.kind === "override"), false);
	});

	it("refuses an effect change after the target changed and reads the registry again", async () => {
		const { dir, pi, ctx } = await setup();
		await driveFrame(ctx, open(pi, ctx), async (frame) => {
			await until(frame, /\d+ rules/);
			filterTo(frame, "routing.cat-read");
			act(frame, "Effect…");
			await until(frame, /Choose the effect of routing\.cat-read/);
			await pi.command().handler("disable routing.cat-read external pause", ctx as never);
			frame.handleInput("\t");
			frame.handleInput("\u001b[B");
			typeText(frame, "late reason");
			act(frame, "Set effect");
			await until(frame, /target revision changed/);
			act(frame, "Cancel");
			await until(frame, /override reason: external pause/);
		});
		const events = await storedEvents(dir);
		assert.equal(events.some((event) => event.kind === "override" && JSON.stringify(event).includes("late reason")), false);
	});

	it("starts a pinned observation period for reset and reads State and Data through owner operations", async () => {
		const { pi, ctx, notifications } = await setup("enforce");
		await driveFrame(ctx, open(pi, ctx), async (frame) => {
			await until(frame, /\d+ rules/);
			filterTo(frame, "routing.cat-read");
			act(frame, "Reset observation…");
			await until(frame, /Start a new observation period for routing\.cat-read/);
			typeText(frame, "panel reset");
			act(frame, "Start new period");
			await until(frame, /Started a new policy observation period\./);
			scopeRight(frame, 4);
			await until(frame, /observationPeriods/);
			frame.handleInput("\u001b[Z");
			frame.handleInput("\u001b[D");
			frame.handleInput("\r");
			await until(frame, /\d+ named data/);
			const data = footer(frame);
			for (const control of ["s set data", "r refresh", "esc close"]) assert.ok(data.includes(control), `${control} in: ${data}`);
		});
		assert.deepEqual(notifications.filter((entry) => entry.type === "error"), []);
	});

	it("labels a rejection's final action Reject and never Approve", async () => {
		const { pi, ctx } = await setup();
		const proposed = await callTool(pi.tool("policy_propose"), { operation: "disable", id: "routing.cat-read", reason: "Reader label" }, ctx);
		assert.ok((proposed.details as { proposalId?: string }).proposalId);
		await driveFrame(ctx, open(pi, ctx), async (frame) => {
			await until(frame, /\d+ rules/);
			scopeRight(frame, 1);
			await until(frame, /Reader label/);
			act(frame, "Reject…");
			await until(frame, /Reject disable proposal/);
			const labels = frame.viewActions.map((action) => action.label);
			assert.deepEqual(labels, ["Reject", "Cancel"]);
			act(frame, "Cancel");
			await until(frame, /Cancelled\. No rule changed\./);
		});
	});

	it("shows the keyed rule and proposal controls, and approve opens the review by key or click", async () => {
		const { pi, ctx } = await setup();
		const proposed = await callTool(pi.tool("policy_propose"), { operation: "disable", id: "routing.cat-read", reason: "Footer approve" }, ctx);
		assert.ok((proposed.details as { proposalId?: string }).proposalId);
		await driveFrame(ctx, open(pi, ctx), async (frame) => {
			await until(frame, /\d+ rules/);
			const rules = footer(frame);
			for (const control of ["f effect", "e explain", "r refresh", "x more", "esc close"]) assert.ok(rules.includes(control), `${control} in: ${rules}`);
			assert.ok(rules.includes("d disable") || rules.includes("d enable"), rules);
			scopeRight(frame, 1);
			await until(frame, /Footer approve/);
			const proposals = footer(frame);
			for (const control of ["a approve", "r refresh", "esc close"]) assert.ok(proposals.includes(control), `${control} in: ${proposals}`);
			frame.handleInput("a");
			await until(frame, /Read the artifact|Read \d+ of \d+ lines/);
			if (frame.viewActions.some((action) => action.label === "Read the artifact")) frame.handleInput("\r");
			await until(frame, /Read \d+ of \d+ lines/);
			assert.equal(decideAction(frame)?.disabled, "Read every line of the artifact first", "Enter cannot decide before every line was read");
			const review = footer(frame);
			assert.ok(review.includes("enter approve disable"), review);
			assert.ok(review.includes("esc cancel"), review);
			frame.handleInput("\r");
			await until(frame, /Read every line of the artifact first/);
			frame.handleInput("\u001b");
			await until(frame, /Cancelled\. No rule changed\./);
		});
		await driveFrame(ctx, open(pi, ctx), async (frame) => {
			await until(frame, /\d+ rules/);
			scopeRight(frame, 1);
			await until(frame, /Footer approve/);
			clickFooter(frame, "a approve");
			await until(frame, /Read the artifact|Read \d+ of \d+ lines/);
			if (frame.viewActions.some((action) => action.label === "Read the artifact")) frame.handleInput("\r");
			await until(frame, /Read \d+ of \d+ lines/);
			assert.equal(decideAction(frame)?.disabled, "Read every line of the artifact first");
			await readArtifact(frame);
			assert.equal(decideAction(frame)?.disabled, undefined, "every line was read");
			frame.handleInput("\r");
			await until(frame, /Approved/);
		});
	});
});

test("captures the configured telemetry retention when its writer starts", async () => {
	const base = await mkdtemp(join(tmpdir(), "policy-index-retention-"));
	const priorHarness = process.env.PI_HARNESS_FILE;
	const priorDir = process.env.PI_POLICY_DIR;
	const path = join(base, "harness.json");
	await writeFile(path, JSON.stringify({ version: 1, policy: { mode: "observe", telemetryMaxBytes: 33554432, telemetryMaxAgeDays: 1 } }));
	process.env.PI_HARNESS_FILE = path;
	let fixture: Awaited<ReturnType<typeof setup>>;
	const priorHarnessFile = process.env.PI_HARNESS_FILE;
	try {
		fixture = await setup("observe");
	} finally {
		if (priorHarnessFile === undefined) delete process.env.PI_HARNESS_FILE;
		else process.env.PI_HARNESS_FILE = priorHarnessFile;
	}
	try {
		await mkdir(join(fixture.dir, "telemetry"), { recursive: true, mode: 0o700 });
		await writeFile(join(fixture.dir, "telemetry", "2020-01-01.000001.jsonl"), "", { mode: 0o600 });
		await fixture.pi.emit("tool_call", { toolName: "bash", toolCallId: "retention", input: { command: "ls" } }, fixture.ctx);
		await fixture.pi.emit(
			"tool_execution_end",
			{ toolCallId: "retention", isError: false, result: { content: [{ type: "text", text: "listed" }] } },
			fixture.ctx,
		);
		await fixture.pi.emit("session_shutdown", {}, fixture.ctx);
		const day = new Date();
		const name = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}.000001.jsonl`;
		assert.deepEqual((await readdir(join(fixture.dir, "telemetry"))).sort(), [name]);
		assert.equal((await telemetry(fixture.dir)).length, 1);
	} finally {
		await rm(base, { recursive: true, force: true });
		if (priorHarness === undefined) delete process.env.PI_HARNESS_FILE;
		else process.env.PI_HARNESS_FILE = priorHarness;
		if (priorDir === undefined) delete process.env.PI_POLICY_DIR;
		else process.env.PI_POLICY_DIR = priorDir;
	}
});
