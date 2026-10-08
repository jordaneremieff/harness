import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { readSettings, SETTINGS_PUBLISH, type SettingsPublication } from "./settings.ts";
import type { MemoryDurableContribution, MemoryDurableContributionHost } from "./durable.ts";
import memory from "./index.ts";

function observeSettings(bus: ReturnType<typeof createEventBus>) {
	let publications: SettingsPublication[] = [];
	const dispose = bus.on("harness:settings:publish", (value) => {
		const publication = value as SettingsPublication;
		assert.equal(publication.slice, "memory");
		assert.equal(Object.hasOwn(publication, "values"), false);
		publications = [publication];
	});
	const refresh = () => {
		publications = [];
		bus.emit("harness:settings:request", { version: 1 });
	};
	refresh();
	return { snapshots: () => publications, refresh, dispose };
}

function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "memory-settings-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	return { root, agentDir };
}
function document(agentDir: string, dir: unknown): void {
	writeFileSync(join(agentDir, "harness.json"), JSON.stringify({ version: 1, memory: { dir } }));
}
function environment(t: { after(fn: () => void): void }, agentDir: string): void {
	const old = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_MEMORY_DIR: process.env.PI_MEMORY_DIR,
		PI_HARNESS_FILE: process.env.PI_HARNESS_FILE,
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_MEMORY_DIR;
	delete process.env.PI_HARNESS_FILE;
	t.after(() => {
		for (const [key, value] of Object.entries(old)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}
function corpus(root: string, name: string): string {
	const dir = join(root, name);
	mkdirSync(dir);
	writeFileSync(join(dir, "README.md"), `# ${name}\n`);
	return dir;
}
function ordinary() {
	const bus = createEventBus();
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, (...args: never[]) => unknown>();
	let contribution: MemoryDurableContribution | undefined;
	bus.on("durable:contribution", (value) => {
		contribution = value as MemoryDurableContribution;
	});
	memory({
		events: bus,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		on: (name: string, handler: (...args: never[]) => unknown) => handlers.set(name, handler),
	} as unknown as ExtensionAPI);
	return { bus, tools, handlers, contribution: contribution as MemoryDurableContribution };
}
function content(details: unknown): unknown {
	assert.ok(details !== null && typeof details === "object" && "content" in details);
	return details.content;
}
const signal = new AbortController().signal;
function read(tool: ToolDefinition) {
	return tool.execute("fixture", { slug: "README" }, signal, () => {}, {} as never);
}

test("dir selects file or environment and rejects invalid selected input without a fallback corpus", (t) => {
	const { root, agentDir } = fixture(t);
	const fromFile = join(root, "file");
	document(agentDir, fromFile);
	const file = readSettings({ agentDir, env: {} });
	assert.equal(file.values.dir, fromFile);
	assert.equal(file.records[0].origin, "file");
	const override = readSettings({ agentDir, env: { PI_MEMORY_DIR: join(root, "env") } });
	assert.equal(override.records[0].origin, "env");
	assert.equal(override.values.dir, join(root, "env"));
	for (const value of ["", "relative", "/bad\nroot", "/bad\u200broot", "/bad\ud800root", `/${"a".repeat(1024)}`]) {
		const result = readSettings({ agentDir, env: { PI_MEMORY_DIR: value } });
		assert.equal(result.values.dir, undefined);
		assert.equal(result.records[0].status, "invalid");
		assert.equal(result.records[0].origin, "default");
		assert.deepEqual(
			result.diagnostics.map(({ field, source, code }) => ({ field, source, code })),
			[{ field: "memory.dir", source: "env", code: "invalid" }],
		);
	}
	for (const value of [null, 17, "", "relative"]) {
		document(agentDir, value);
		const result = readSettings({ agentDir, env: {} });
		assert.equal(result.values.dir, undefined);
		assert.equal(result.records[0].status, "invalid");
	}
	rmSync(join(agentDir, "harness.json"));
	const missing = readSettings({ agentDir, env: {} });
	assert.equal(missing.values.dir, undefined);
	assert.equal(missing.records[0].status, "unset");
	assert.deepEqual(readdirSync(agentDir), []);
});

test("ordinary tools and prompt read the current file on each invocation and publish fresh snapshots", async (t) => {
	const { root, agentDir } = fixture(t);
	environment(t, agentDir);
	const first = corpus(root, "first");
	const second = corpus(root, "second");
	document(agentDir, first);
	const owner = ordinary();
	const collector = observeSettings(owner.bus);
	t.after(() => collector.dispose());
	assert.equal(collector.snapshots()[0].records[0].value, first);
	const reader = owner.tools.get("memory_read") as ToolDefinition;
	assert.equal(content((await read(reader)).details), "# first\n");
	document(agentDir, second);
	assert.equal(content((await read(reader)).details), "# second\n");
	collector.refresh();
	assert.equal(collector.snapshots()[0].records[0].value, second);
	process.env.PI_MEMORY_DIR = first;
	assert.equal(content((await read(reader)).details), "# first\n");
	process.env.PI_MEMORY_DIR = "";
	await assert.rejects(read(reader), /Memory unavailable/);
	const event = { systemPromptOptions: { sections: { memory_index: "old" } } };
	await owner.handlers.get("before_agent_start")?.(event as never, { signal } as never);
	assert.equal(event.systemPromptOptions.sections.memory_index, undefined);
	delete process.env.PI_MEMORY_DIR;
	const absent = join(root, "absent");
	document(agentDir, absent);
	await assert.rejects(read(reader));
	assert.equal(existsSync(absent), false);
	assert.deepEqual(readdirSync(agentDir), ["harness.json"]);
	owner.handlers.get("session_shutdown")?.();
	collector.refresh();
	assert.deepEqual(collector.snapshots(), []);
});

test("native tools use their host directory rather than the ordinary agent directory", async (t) => {
	const { root, agentDir } = fixture(t);
	environment(t, agentDir);
	const ordinaryCorpus = corpus(root, "ordinary");
	document(agentDir, ordinaryCorpus);
	const nativeAgentDir = join(root, "native-agent");
	mkdirSync(nativeAgentDir);
	const nativeCorpus = corpus(root, "native");
	document(nativeAgentDir, nativeCorpus);
	const owner = ordinary();
	const collector = observeSettings(owner.bus);
	t.after(() => collector.dispose());
	assert.equal(collector.snapshots()[0].source.path, join(agentDir, "harness.json"));
	const publications: SettingsPublication[] = [];
	t.after(owner.bus.on(SETTINGS_PUBLISH, (value) => publications.push(value as SettingsPublication)));
	const closers: Array<() => void | Promise<void>> = [];
	const extension = await owner.contribution.create({
		durable: Durable,
		agentDir: nativeAgentDir,
		onClose: (dispose: () => void | Promise<void>) => closers.push(dispose),
	} as unknown as MemoryDurableContributionHost);
	publications.length = 0;
	collector.refresh();
	assert.equal(publications.length, 1);
	assert.equal(publications[0].source.path, join(nativeAgentDir, "harness.json"));
	assert.equal(collector.snapshots().length, 1);
	assert.equal(collector.snapshots()[0].source.path, join(nativeAgentDir, "harness.json"));
	assert.equal(collector.snapshots()[0].records[0].value, nativeCorpus);
	const reader = extension.tools?.find((tool) => tool.name === "memory_read");
	assert.ok(reader);
	const result = await reader.execute({ slug: "README" }, {} as never, { abortSignal: signal } as never);
	assert.equal(content(result.details), "# native\n");
	document(nativeAgentDir, ordinaryCorpus);
	assert.equal(
		content((await reader.execute({ slug: "README" }, {} as never, { abortSignal: signal } as never)).details),
		"# ordinary\n",
	);
	process.env.PI_MEMORY_DIR = nativeCorpus;
	assert.equal(
		content((await reader.execute({ slug: "README" }, {} as never, { abortSignal: signal } as never)).details),
		"# native\n",
	);
	process.env.PI_MEMORY_DIR = "relative";
	await assert.rejects(
		reader.execute({ slug: "README" }, {} as never, { abortSignal: signal } as never),
		/Memory unavailable/,
	);
	collector.refresh();
	assert.equal(collector.snapshots()[0].records[0].status, "invalid");
	delete process.env.PI_MEMORY_DIR;
	rmSync(join(nativeAgentDir, "harness.json"));
	await assert.rejects(
		reader.execute({ slug: "README" }, {} as never, { abortSignal: signal } as never),
		/Memory unavailable/,
	);
	assert.deepEqual(readdirSync(nativeAgentDir), []);
	for (const dispose of closers) await dispose();
	collector.refresh();
	assert.deepEqual(collector.snapshots(), []);
});
