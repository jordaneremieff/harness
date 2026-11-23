import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { commandHelp } from "./command.ts";
import { toolDisplay } from "./display.ts";
import configExtension from "./index.ts";

type Tool = {
	name: string;
	execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }>;
};

test("ordinary tools run the shared backend with the session's own controls", { timeout: 20000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "config-ordinary-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir);
	await mkdir(cwd);
	const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_HARNESS_FILE: process.env.PI_HARNESS_FILE };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_HARNESS_FILE;
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
	const tools = new Map<string, Tool>();
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const contributions: unknown[] = [];
	const displays: unknown[] = [];
	let active = ["read", "bash"];
	const events = createEventBus();
	events.on("durable:contribution", (value) => contributions.push(value));
	events.on("harness:tool-display:publish", (value) => displays.push(value));
	const pi = {
		events,
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: (
			name: string,
			definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => commands.set(name, definition.handler),
		getSettings: () => ({ theme: "dark" }),
		getAllTools: () => [
			{ name: "read", exposure: "direct", sourceInfo: { source: "builtin" } },
			{ name: "bash", exposure: "direct", sourceInfo: { source: "builtin" } },
			{ name: "grep", exposure: "deferred", sourceInfo: { source: "builtin" } },
		],
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = names;
		},
	};
	const ctx = {
		cwd,
		mode: "print",
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "session-1", getSessionName: () => undefined },
		ui: { notify: () => {} },
	};
	const call = async (name: string, input: unknown) => {
		const result = await tools.get(name)?.execute("call", input, undefined, undefined, ctx);
		assert.ok(result);
		return { error: result.isError === true, value: JSON.parse(result.content[0].text) };
	};
	try {
		configExtension(pi as never);
		assert.deepEqual([...tools.keys()], ["config_find", "config_get", "config_edit", "config_tools"]);
		assert.deepEqual([...commands.keys()], ["config"]);
		assert.equal(contributions.length, 1);
		assert.deepEqual(displays, [toolDisplay()]);
		assert.deepEqual(
			toolDisplay().tools.map((tool) => tool.name),
			[...tools.keys()],
		);
		for (const presentation of toolDisplay().tools) {
			const { renderCall, renderResult } = tools.get(presentation.name) as Tool & typeof presentation;
			assert.equal(renderCall, presentation.renderCall);
			assert.equal(renderResult, presentation.renderResult);
		}
		events.emit("harness:tool-display:request", { version: 2 });
		events.emit("harness:tool-display:request", { version: 1 });
		assert.deepEqual(displays, [toolDisplay(), toolDisplay()]);
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);

		const get = await call("config_get", { ids: ["pi:/theme"] });
		assert.equal(get.value.context.projectTrusted, false);
		assert.equal(get.value.entries[0].session.differs, false);
		const revision = get.value.context.documents.find(
			(item: { document: string }) => item.document === "pi-global",
		).revision;

		const project = await call("config_edit", {
			mode: "commit",
			changes: [{ id: "pi:/theme", scope: "project", action: "set", value: "light", base: { present: false } }],
		});
		assert.equal(project.value.outcome, "rejected");

		const edit = await call("config_edit", {
			mode: "commit",
			changes: [{ id: "pi:/theme", scope: "global", action: "set", value: "light" }],
			revisions: { "pi-global": revision },
		});
		assert.equal(edit.value.outcome, "committed", edit.value.summary);
		assert.equal(edit.value.documents[0].changes[0].apply.state, "pending-reload");
		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), { theme: "light" });

		const tool = await call("config_tools", { activate: ["grep"], deactivate: ["bash"] });
		assert.deepEqual(tool.value.change.active, ["read", "grep"]);
		assert.deepEqual(active, ["read", "grep"]);
		assert.equal(tool.value.tools.find((row: { name: string }) => row.name === "grep").active, true);

		const bad = await call("config_get", { ids: ["nonsense"] });
		assert.deepEqual(bad.value.missing, ["nonsense"]);
		assert.equal(bad.error, false);
		await writeFile(
			join(agentDir, "harness.json"),
			JSON.stringify({
				version: 1,
				config: {
					custom: {
						a: { type: "string", value: "x".repeat(30_000) },
						b: { type: "string", value: "y".repeat(30_000) },
					},
				},
			}),
		);
		const oversized = await call("config_get", { ids: ["custom:/a", "custom:/b"] });
		assert.deepEqual(oversized, {
			error: true,
			value: { error: "The result exceeds 98304 bytes; request fewer ids or a smaller page." },
		});

		const command = commands.get("config");
		assert.ok(command);
		const notices: [string, string][] = [];
		const ui = { notify: (text: string, level: string) => notices.push([text, level]) };
		await command("help", { ...ctx, ui } as never);
		assert.deepEqual(notices.splice(0), [[commandHelp(), "info"]]);
		await command("update", { ...ctx, ui } as never);
		assert.deepEqual(notices.splice(0), [
			["Config needs interactive Pi to open or update its app; use the config_* tools here.", "warning"],
		]);
		const theme = { bold: (text: string) => text, fg: (_role: string, text: string) => text } as Theme;
		const tui = { terminal: { rows: 6 }, requestRender() {} } as TUI;
		let opened = false;
		await command("help", {
			...ctx,
			mode: "tui",
			ui: {
				...ui,
				async custom(create: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) {
					const view = await create(tui, theme, {} as never, () => {
						opened = true;
					});
					const first = view.render(24);
					assert.equal(first.length, 5);
					view.handleInput?.("\x1b[B");
					assert.notDeepEqual(view.render(24), first);
					view.handleInput?.("\x1b");
				},
			},
		} as never);
		assert.equal(opened, true);
		assert.deepEqual(notices, []);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
		const displayCount = displays.length;
		events.emit("harness:tool-display:request", { version: 1 });
		assert.equal(displays.length, displayCount);
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});
