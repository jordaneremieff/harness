import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import settingsExtension from "./index.ts";

type Tool = {
	name: string;
	execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }>;
};

test("ordinary tools run the shared backend with the session's own controls", { timeout: 20000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "settings-ordinary-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir);
	await mkdir(cwd);
	const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_HARNESS_FILE: process.env.PI_HARNESS_FILE };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_HARNESS_FILE;
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
	const tools = new Map<string, Tool>();
	const commands: string[] = [];
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const contributions: unknown[] = [];
	let active = ["read", "bash"];
	const events = createEventBus();
	events.on("durable:contribution", (value) => contributions.push(value));
	const pi = {
		events,
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: (name: string) => commands.push(name),
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
		settingsExtension(pi as never);
		assert.deepEqual([...tools.keys()], ["settings_find", "settings_get", "settings_edit", "settings_tools"]);
		assert.deepEqual(commands, ["harness-settings"]);
		assert.equal(contributions.length, 1);
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);

		const get = await call("settings_get", { ids: ["pi:/theme"] });
		assert.equal(get.value.context.projectTrusted, false);
		assert.equal(get.value.entries[0].session.differs, false);
		const revision = get.value.context.documents.find(
			(item: { document: string }) => item.document === "pi-global",
		).revision;

		const project = await call("settings_edit", {
			mode: "commit",
			changes: [{ id: "pi:/theme", scope: "project", action: "set", value: "light", base: { present: false } }],
		});
		assert.equal(project.value.outcome, "rejected");

		const edit = await call("settings_edit", {
			mode: "commit",
			changes: [{ id: "pi:/theme", scope: "global", action: "set", value: "light" }],
			revisions: { "pi-global": revision },
		});
		assert.equal(edit.value.outcome, "committed", edit.value.summary);
		assert.equal(edit.value.documents[0].changes[0].apply.state, "pending-reload");
		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), { theme: "light" });

		const tool = await call("settings_tools", { activate: ["grep"], deactivate: ["bash"] });
		assert.deepEqual(tool.value.change.active, ["read", "grep"]);
		assert.deepEqual(active, ["read", "grep"]);
		assert.equal(tool.value.tools.find((row: { name: string }) => row.name === "grep").active, true);

		const bad = await call("settings_get", { ids: ["nonsense"] });
		assert.deepEqual(bad.value.missing, ["nonsense"]);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});
