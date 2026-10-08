import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { checkSettingsReadme, readSettings, type SettingsPublication } from "../../settings/index.ts";
import type { DurableContribution } from "./durable.ts";
import registerClipboard from "./index.ts";
import { settings } from "./settings.ts";
import { appendEntry, makeEntry, resolveClipboardDir } from "./store.ts";

test("clipboard directory selects environment, document, or the host default", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "clipboard-settings-test-"));
	try {
		assert.equal(readSettings(settings, { agentDir, env: {} }).values.dir, join(agentDir, "clipboard"));
		await writeFile(join(agentDir, "harness.json"), JSON.stringify({ version: 1, clipboard: { dir: "file-archive" } }));
		const file = readSettings(settings, { agentDir, env: {} });
		assert.equal(file.values.dir, join(agentDir, "file-archive"));
		assert.equal(file.records[0].origin, "file");
		assert.equal(resolveClipboardDir({}, agentDir), file.values.dir);
		const env = readSettings(settings, { agentDir, env: { PI_CLIPBOARD_DIR: "env-archive" } });
		assert.equal(env.values.dir, join(agentDir, "env-archive"));
		assert.equal(env.records[0].origin, "env");
		for (const value of ["", "bad\u0000path", "bad\npath", "\ud800", "x".repeat(4097)]) {
			const invalid = readSettings(settings, { agentDir, env: { PI_CLIPBOARD_DIR: value } });
			assert.equal(invalid.values.dir, join(agentDir, "clipboard"));
			assert.equal(invalid.records[0].origin, "default");
			assert.equal(invalid.records[0].status, "invalid");
			assert.deepEqual(invalid.diagnostics.map(({ field, source, code }) => ({ field, source, code })), [
				{ field: "clipboard.dir", source: "env", code: "invalid" },
			]);
			assert.ok(!JSON.stringify(invalid.diagnostics).includes(value) || value === "");
		}
		for (const value of [null, false, 7, [], {}, "", "bad\npath"]) {
			await writeFile(join(agentDir, "harness.json"), JSON.stringify({ version: 1, clipboard: { dir: value } }));
			const invalid = readSettings(settings, { agentDir, env: {} });
			assert.equal(invalid.values.dir, join(agentDir, "clipboard"));
			assert.equal(invalid.records[0].status, "invalid");
			assert.equal(invalid.diagnostics[0].source, "file");
		}
		assert.equal(checkSettingsReadme(settings, await readFile(new URL("./README.md", import.meta.url), "utf8")), true);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("ordinary publication refreshes and native archive reads remain host-isolated", async () => {
	const root = await mkdtemp(join(tmpdir(), "clipboard-host-settings-test-"));
	const ordinaryDir = join(root, "ordinary");
	const nativeDir = join(root, "native");
	const previous = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		harnessFile: process.env.PI_HARNESS_FILE,
		dir: process.env.PI_CLIPBOARD_DIR,
	};
	const bus = new EventEmitter();
	const tools = new Map<string, ToolDefinition>();
	const publications: SettingsPublication[] = [];
	let shutdown = () => {};
	let nativeClose = () => {};
	let contribution: DurableContribution | undefined;
	bus.on("durable:contribution", (value: DurableContribution) => { contribution = value; });
	try {
		await Promise.all([mkdir(ordinaryDir), mkdir(nativeDir)]);
		process.env.PI_CODING_AGENT_DIR = ordinaryDir;
		delete process.env.PI_HARNESS_FILE;
		delete process.env.PI_CLIPBOARD_DIR;
		await writeFile(join(ordinaryDir, "harness.json"), JSON.stringify({ version: 1, clipboard: { dir: "ordinary-archive" } }));
		await writeFile(join(nativeDir, "harness.json"), JSON.stringify({ version: 1, clipboard: { dir: "native-archive" } }));
		assert.equal(await appendEntry(join(ordinaryDir, "ordinary-archive"), makeEntry("ordinary", undefined, new Date(), "ordinary-entry")), null);
		assert.equal(await appendEntry(join(nativeDir, "native-archive"), makeEntry("native", undefined, new Date(), "native-entry")), null);
		bus.on("harness:settings:publish", (publication: SettingsPublication) => {
			assert.equal(bus.listenerCount("harness:settings:request"), 1);
			publications.push(publication);
		});
		registerClipboard({
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerCommand: () => {},
			on: (event: string, handler: () => void) => {
				if (event === "session_shutdown") shutdown = handler;
			},
			events: {
				emit: (event: string, value: unknown) => { bus.emit(event, value); },
				on: (event: string, handler: (value: unknown) => void) => {
					bus.on(event, handler);
					return () => { bus.off(event, handler); };
				},
			},
		} as unknown as ExtensionAPI);
		assert.equal(publications.length, 1);
		assert.equal(publications[0].records[0].value, join(ordinaryDir, "ordinary-archive"));
		assert.equal(publications[0].records[0].origin, "file");
		assert.ok(!Object.hasOwn(publications[0], "values"));
		const ordinaryList = tools.get("clipboard_list");
		assert.ok(ordinaryList);
		const ordinary = await ordinaryList.execute("list", {}, undefined, undefined, {} as never);
		assert.match(JSON.stringify(ordinary.content), /ordinary-entry/);
		assert.doesNotMatch(JSON.stringify(ordinary.content), /native-entry/);
		assert.ok(contribution);
		const native = await contribution.create({
			durable: Durable,
			agentDir: nativeDir,
			onClose: (dispose) => { nativeClose = dispose as () => void; },
		});
		assert.equal(publications.length, 2);
		assert.equal(publications[1].source.path, join(nativeDir, "harness.json"));
		assert.equal(publications[1].records[0].value, join(nativeDir, "native-archive"));
		const nativeList = native.tools?.find((tool) => tool.name === "clipboard_list");
		assert.ok(nativeList);
		const nativeResult = await nativeList.execute({}, {} as never, { abortSignal: new AbortController().signal } as never);
		assert.match(JSON.stringify(nativeResult), /native-entry/);
		assert.doesNotMatch(JSON.stringify(nativeResult), /ordinary-entry/);
		for (const request of [null, {}, { version: 2 }]) bus.emit("harness:settings:request", request);
		assert.equal(publications.length, 2);
		process.env.PI_CLIPBOARD_DIR = "env-archive";
		bus.emit("harness:settings:request", { version: 1 });
		assert.equal(publications.at(-1)?.records[0].value, join(nativeDir, "env-archive"));
		assert.equal(publications.at(-1)?.records[0].origin, "env");
		process.env.PI_CLIPBOARD_DIR = "";
		bus.emit("harness:settings:request", { version: 1 });
		assert.equal(publications.at(-1)?.records[0].value, join(nativeDir, "clipboard"));
		assert.equal(publications.at(-1)?.diagnostics[0].source, "env");
		delete process.env.PI_CLIPBOARD_DIR;
		await writeFile(join(ordinaryDir, "harness.json"), JSON.stringify({ version: 1, clipboard: { dir: "changed-archive" } }));
		bus.emit("harness:settings:request", { version: 1 });
		assert.equal(publications.at(-1)?.records[0].value, join(nativeDir, "native-archive"));
		await writeFile(join(nativeDir, "harness.json"), JSON.stringify({ version: 1, clipboard: { dir: "changed-archive" } }));
		bus.emit("harness:settings:request", { version: 1 });
		assert.equal(publications.at(-1)?.records[0].value, join(nativeDir, "changed-archive"));
		shutdown();
		assert.equal(bus.listenerCount("harness:settings:request"), 1);
		nativeClose();
		nativeClose();
		assert.equal(bus.listenerCount("harness:settings:request"), 0);
		bus.emit("harness:settings:request", { version: 1 });
		assert.equal(publications.length, 6);
	} finally {
		shutdown();
		nativeClose();
		if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
		if (previous.harnessFile === undefined) delete process.env.PI_HARNESS_FILE;
		else process.env.PI_HARNESS_FILE = previous.harnessFile;
		if (previous.dir === undefined) delete process.env.PI_CLIPBOARD_DIR;
		else process.env.PI_CLIPBOARD_DIR = previous.dir;
		await rm(root, { recursive: true, force: true });
	}
});
