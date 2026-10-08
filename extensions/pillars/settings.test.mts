import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readSettings, type SettingsBus, type SettingsPublication } from "./settings.ts";
import { corpusRoot, loadCatalog } from "./catalog.ts";
import pillarsExtension from "./index.ts";
import { defaultCorpusRoot, settings, publishSettings } from "./settings.ts";

test("configuration path resolution remains internal", async () => {
	assert.equal("settingsPath" in (await import("./settings.ts")), false);
});

async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(join(process.cwd(), ".pillars-settings-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const corpus = join(root, "corpus");
	await mkdir(agentDir);
	await mkdir(corpus);
	await writeFile(join(corpus, "README.md"), "# Inventory\n[Example](principle-example.md)\n");
	await writeFile(join(corpus, "GOVERNANCE.md"), "# Governance\n");
	await writeFile(join(corpus, "principle-example.md"), "# Example\n");
	return { root, agentDir, corpus };
}

function testBus(): SettingsBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel, handler) {
			const entries = handlers.get(channel) ?? new Set();
			handlers.set(channel, entries);
			entries.add(handler);
			return () => {
				entries.delete(handler);
			};
		},
		emit(channel, data) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
	};
}

function host(bus: SettingsBus) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		events: bus,
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(name, handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI;
	return { pi, handlers, tools };
}

test("settings select defaults, file fields, and environment fields independently", async (t) => {
	const f = await fixture(t);
	const defaults = readSettings({ agentDir: f.agentDir, env: {} });
	assert.deepEqual(
		{ ...defaults.values },
		{ dir: join(f.agentDir, "pillars"), corpus: defaultCorpusRoot(), collect: true },
	);
	assert.equal(corpusRoot({ agentDir: f.agentDir, env: {} }), defaultCorpusRoot());
	await writeFile(
		join(f.agentDir, "harness.json"),
		JSON.stringify({ version: 1, pillars: { dir: join(f.root, "store"), corpus: f.corpus, collect: false } }),
	);
	const fromFile = readSettings({ agentDir: f.agentDir, env: {} });
	assert.equal(fromFile.values.collect, false);
	assert.equal(fromFile.values.corpus, f.corpus);
	assert.ok(fromFile.records.every((record) => record.origin === "file"));
	const override = readSettings({
		agentDir: f.agentDir,
		env: { PI_PILLARS_COLLECT: "true", PI_PILLARS_DIR: join(f.root, "override") },
	});
	assert.equal(override.values.collect, true);
	assert.equal(override.values.dir, join(f.root, "override"));
	assert.equal(override.values.corpus, f.corpus);
	const catalog = await loadCatalog(undefined, { agentDir: f.agentDir, env: {} });
	assert.ok(catalog.resources.some((resource) => resource.resourceId === "principle-example"));
	const invalid = readSettings({
		agentDir: f.agentDir,
		env: { PI_PILLARS_COLLECT: "invalid", PI_PILLARS_CORPUS: "relative" },
	});
	assert.equal(invalid.values.collect, true);
	assert.equal(invalid.values.corpus, defaultCorpusRoot());
	assert.equal(invalid.records.find((record) => record.key === "collect")?.status, "invalid");
	assert.ok(invalid.diagnostics.some((issue) => issue.field === "pillars.collect" && issue.source === "env"));
});

for (const collect of [false, "invalid"] as const) {
	test(`ordinary source access and retained readback survive collection ${collect}`, async (t) => {
		const f = await fixture(t);
		await writeFile(
			join(f.agentDir, "harness.json"),
			JSON.stringify({ version: 1, pillars: { corpus: f.corpus, collect } }),
		);
		const bus = testBus();
		const collector = captureSettings(bus);
		const runtime = host(bus);
		pillarsExtension(runtime.pi, { agentDir: f.agentDir, env: {} });
		const notices: string[] = [];
		const ctx = {
			signal: new AbortController().signal,
			hasUI: true,
			ui: {
				notify(text: string) {
					notices.push(text);
				},
			},
		} as unknown as ExtensionToolContext;
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, ctx);
		try {
			const sourceTool = runtime.tools.get("pillars");
			const usageTool = runtime.tools.get("pillars_usage");
			assert.ok(sourceTool && usageTool);
			const source = await sourceTool.execute("source", {}, ctx.signal, undefined, ctx);
			assert.equal((source.details as { schema: string }).schema, "pillars-source");
			const usage = await usageTool.execute("usage", {}, ctx.signal, undefined, ctx);
			assert.equal((usage.details as { enabled: boolean }).enabled, false);
			const snapshot = collector.snapshots()[0];
			assert.equal(snapshot.source.path, join(f.agentDir, "harness.json"));
			assert.equal(
				snapshot.records.find((record) => record.key === "collect")?.status,
				collect === false ? "valid" : "invalid",
			);
			assert.equal(
				notices.some((text) => text.includes("collector is disabled")),
				collect === "invalid",
			);
		} finally {
			await runtime.handlers.get("session_shutdown")?.({}, ctx);
			collector.refresh();
			assert.deepEqual(collector.snapshots(), []);
			collector.dispose();
		}
	});
}

function captureSettings(bus: SettingsBus) {
	let publications: SettingsPublication[] = [];
	const dispose = bus.on("harness:settings:publish", (value) => {
		publications.push(value as SettingsPublication);
	});
	const refresh = () => {
		publications = [];
		bus.emit("harness:settings:request", { version: 1 });
	};
	refresh();
	return { snapshots: () => publications, refresh, dispose };
}

test("invalid safe defaults throw only a field-naming declaration error", async (t) => {
	const f = await fixture(t);
	const field = settings.fields.collect as unknown as { default: unknown };
	const original = field.default;
	try {
		field.default = "invalid";
		assert.throws(() => readSettings({ agentDir: f.agentDir, env: {} }), {
			message: "Invalid default for pillars.collect",
		});
	} finally {
		field.default = original;
	}
});
test("publisher ignores unsupported requests and omits local values", async (t) => {
	const f = await fixture(t);
	const bus = testBus();
	const publications: SettingsPublication[] = [];
	const off = bus.on("harness:settings:publish", (value) => publications.push(value as SettingsPublication));
	const stop = publishSettings(bus, { agentDir: f.agentDir, env: {} });
	assert.equal(publications.length, 1);
	assert.equal(Object.hasOwn(publications[0], "values"), false);
	assert.equal(publications[0].records.find((record) => record.key === "corpus")?.value, defaultCorpusRoot());
	bus.emit("harness:settings:request", { version: 2 });
	assert.equal(publications.length, 1);
	bus.emit("harness:settings:request", { version: 1 });
	assert.equal(publications.length, 2);
	stop();
	bus.emit("harness:settings:request", { version: 1 });
	assert.equal(publications.length, 2);
	off();
});
