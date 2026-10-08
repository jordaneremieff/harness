import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { readSettings, settingsReadme, SETTINGS_PUBLISH, SETTINGS_REQUEST, type SettingsPublication } from "../../settings/index.ts";
import type { PolicyDurableContribution, PolicyDurableHost } from "./durable.ts";
import registerPolicy from "./index.ts";
import { settings } from "./settings.ts";

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "policy-settings-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function environment(t: { after: (cleanup: () => void) => void }, values: Record<string, string | undefined>): void {
	const prior = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	t.after(() => {
		for (const [name, value] of prior) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
}

function hostAdapter(flag?: string) {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const publications: SettingsPublication[] = [];
	let contribution: PolicyDurableContribution | undefined;
	const handlers = new Map<string, Array<() => unknown>>();
	const tools = new Map<string, ToolDefinition>();
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const pi = {
		events: {
			on(channel: string, handler: (value: unknown) => void) {
				const entries = listeners.get(channel) ?? new Set();
				entries.add(handler);
				listeners.set(channel, entries);
				return () => { entries.delete(handler); };
			},
			emit(channel: string, value: unknown) {
				if (channel === SETTINGS_PUBLISH) publications.push(value as SettingsPublication);
				if (channel === "durable:contribution") contribution = value as PolicyDurableContribution;
				for (const handler of listeners.get(channel) ?? []) handler(value);
			},
		},
		on(name: string, handler: () => unknown) {
			const entries = handlers.get(name) ?? [];
			entries.push(handler);
			handlers.set(name, entries);
		},
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
		registerFlag() {}, getFlag() { return flag; },
		registerCommand(_name: string, definition: Parameters<ExtensionAPI["registerCommand"]>[1]) { command = definition; },
		registerShortcut() {}, registerEntryRenderer() {},
	} as unknown as ExtensionAPI;
	return { pi, tools, publications, handlers, listeners, contribution: () => required(contribution), command: () => required(command) };
}

function required<T>(value: T | undefined): T {
	assert.ok(value);
	return value;
}

function record(snapshot: SettingsPublication, key: string) {
	return required(snapshot.records.find((entry) => entry.key === key));
}

test("policy settings select environment, file, and portable defaults with rejected-source diagnostics", async (t) => {
	const agentDir = await fixture(t);
	const path = join(agentDir, "harness.json");
	const defaults = readSettings(settings, { agentDir, env: {} });
	assert.deepEqual({ ...defaults.values }, { dir: join(agentDir, "policy"), mode: "observe" });
	assert.ok(defaults.records.every((entry) => entry.origin === "default"));
	await writeFile(path, JSON.stringify({ version: 1, policy: { dir: "file-store", mode: "enforce" } }));
	const file = readSettings(settings, { agentDir, env: {} });
	assert.deepEqual({ ...file.values }, { dir: join(agentDir, "file-store"), mode: "enforce" });
	assert.ok(file.records.every((entry) => entry.origin === "file"));
	const env = readSettings(settings, { agentDir, env: { PI_POLICY_DIR: "env-store", PI_POLICY_MODE: "notice" } });
	assert.deepEqual({ ...env.values }, { dir: join(agentDir, "env-store"), mode: "notice" });
	assert.ok(env.records.every((entry) => entry.origin === "env"));
	for (const value of ["", "   ", "Observe", "invalid"]) {
		const rejected = readSettings(settings, { agentDir, env: { PI_POLICY_MODE: value, PI_POLICY_DIR: "" } });
		assert.deepEqual(rejected.values, defaults.values);
		assert.ok(rejected.records.every((entry) => entry.origin === "default" && entry.status === "invalid"));
		assert.deepEqual(rejected.diagnostics.map(({ field, source }) => ({ field, source })), [
			{ field: "policy.dir", source: "env" }, { field: "policy.mode", source: "env" },
		]);
	}
	await writeFile(path, JSON.stringify({ version: 1, policy: { dir: 7, mode: "invalid", rules: [] } }));
	const rejectedFile = readSettings(settings, { agentDir, env: {} });
	assert.deepEqual(rejectedFile.values, defaults.values);
	assert.ok(rejectedFile.diagnostics.some((entry) => entry.field === "policy.mode" && entry.source === "file"));
	assert.ok(rejectedFile.diagnostics.some((entry) => entry.field === "policy.rules" && entry.code === "unknown"));
});

test("ordinary flag overrides applied mode but publication stays a fresh machine snapshot", async (t) => {
	const agentDir = await fixture(t);
	environment(t, { PI_CODING_AGENT_DIR: agentDir, PI_HARNESS_FILE: join(agentDir, "harness.json"), PI_POLICY_DIR: undefined, PI_POLICY_MODE: "notice" });
	await writeFile(join(agentDir, "harness.json"), JSON.stringify({ version: 1, policy: { mode: "enforce" } }));
	for (const [flag, expected] of [[undefined, "notice"], ["annotate", "annotate"], ["invalid", "unavailable"]] as const) {
		const warn = mock.method(console, "warn", () => {});
		const adapter = hostAdapter(flag);
		registerPolicy(adapter.pi);
		const result = await required(adapter.tools.get("policy_control")).execute("mode", { operation: "mode" }, undefined, undefined, {} as never);
		assert.equal((result.details as { mode: string }).mode, expected);
		assert.equal(record(required(adapter.publications.at(-1)), "mode").value, "notice");
		assert.equal(record(required(adapter.publications.at(-1)), "mode").origin, "env");
		process.env.PI_POLICY_MODE = "notice";
		for (const shutdown of adapter.handlers.get("session_shutdown") ?? []) await shutdown();
		assert.equal(adapter.listeners.get(SETTINGS_REQUEST)?.size, 0);
		warn.mock.restore();
	}
	delete process.env.PI_POLICY_MODE;
	const adapter = hostAdapter();
	registerPolicy(adapter.pi);
	assert.equal(record(required(adapter.publications.at(-1)), "mode").origin, "file");
	process.env.PI_POLICY_MODE = "observe";
	adapter.pi.events.emit(SETTINGS_REQUEST, { version: 1 });
	assert.equal(record(required(adapter.publications.at(-1)), "mode").value, "observe");
	const result = await required(adapter.tools.get("policy_control")).execute("mode", { operation: "mode" }, undefined, undefined, {} as never);
	assert.equal((result.details as { mode: string }).mode, "enforce");
	for (const shutdown of adapter.handlers.get("session_shutdown") ?? []) await shutdown();
});

test("ordinary mode source distinguishes flag, environment, file, and default", async (t) => {
	const agentDir = await fixture(t);
	const path = join(agentDir, "harness.json");
	environment(t, { PI_CODING_AGENT_DIR: agentDir, PI_HARNESS_FILE: path, PI_POLICY_DIR: undefined, PI_POLICY_MODE: undefined });
	for (const [file, env, flag, source] of [
		[undefined, undefined, undefined, "default"],
		["enforce", undefined, undefined, "policy.mode"],
		["enforce", "notice", undefined, "PI_POLICY_MODE"],
		["enforce", "notice", "annotate", "--policy-mode"],
	] as const) {
		await writeFile(path, JSON.stringify({ version: 1, policy: { dir: "file-store", ...(file === undefined ? {} : { mode: file }) } }));
		if (env === undefined) delete process.env.PI_POLICY_MODE;
		else process.env.PI_POLICY_MODE = env;
		const adapter = hostAdapter(flag);
		registerPolicy(adapter.pi);
		const messages: string[] = [];
		await adapter.command().handler("mode", {
			mode: "tui", hasUI: true, cwd: agentDir, model: undefined,
			ui: { notify: (message: string) => messages.push(message) },
		} as never);
		assert.ok(messages.at(-1)?.includes(source));
		assert.ok((await readFile(join(agentDir, "file-store", "rules.jsonl"), "utf8")).length > 0);
		for (const shutdown of adapter.handlers.get("session_shutdown") ?? []) await shutdown();
	}
});

test("native creation replaces the ordinary publisher with the host directory and cleans up", async (t) => {
	const ordinaryDir = await fixture(t);
	const nativeDir = await fixture(t);
	environment(t, { PI_CODING_AGENT_DIR: ordinaryDir, PI_HARNESS_FILE: undefined, PI_POLICY_DIR: undefined, PI_POLICY_MODE: undefined });
	await writeFile(join(ordinaryDir, "harness.json"), JSON.stringify({ version: 1, policy: { dir: "ordinary-store", mode: "enforce" } }));
	await writeFile(join(nativeDir, "harness.json"), JSON.stringify({ version: 1, policy: { dir: "native-store", mode: "notice" } }));
	const adapter = hostAdapter("annotate");
	registerPolicy(adapter.pi);
	assert.equal(required(adapter.publications.at(-1)).source.path, join(ordinaryDir, "harness.json"));
	const cleanups: Array<() => void | Promise<void>> = [];
	const host = { durable: Durable, agentDir: nativeDir, harness: {}, storageId: "fixture", cwd: nativeDir, onClose: (cleanup: () => void | Promise<void>) => cleanups.push(cleanup) } as unknown as PolicyDurableHost;
	adapter.contribution().create(host);
	assert.equal(adapter.listeners.get(SETTINGS_REQUEST)?.size, 1);
	adapter.pi.events.emit(SETTINGS_REQUEST, { version: 1 });
	assert.equal(required(adapter.publications.at(-1)).source.path, join(nativeDir, "harness.json"));
	assert.equal(record(required(adapter.publications.at(-1)), "dir").value, join(nativeDir, "native-store"));
	assert.equal(record(required(adapter.publications.at(-1)), "mode").value, "notice");
	for (const shutdown of adapter.handlers.get("session_shutdown") ?? []) await shutdown();
	assert.equal(adapter.listeners.get(SETTINGS_REQUEST)?.size, 1);
	const beforeRequest = adapter.publications.length;
	adapter.pi.events.emit(SETTINGS_REQUEST, { version: 1 });
	assert.equal(adapter.publications.length, beforeRequest + 1);
	assert.equal(required(adapter.publications.at(-1)).source.path, join(nativeDir, "harness.json"));
	for (const cleanup of cleanups) await cleanup();
	assert.equal(adapter.listeners.get(SETTINGS_REQUEST)?.size, 0);
	const count = adapter.publications.length;
	adapter.pi.events.emit(SETTINGS_REQUEST, { version: 1 });
	assert.equal(adapter.publications.length, count);
});

test("policy README contains the exact generated settings table", async () => {
	const readme = await readFile(new URL("./README.md", import.meta.url), "utf8");
	assert.ok(readme.includes(settingsReadme(settings)));
});
