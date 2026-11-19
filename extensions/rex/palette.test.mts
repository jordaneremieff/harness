import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { mkdir, symlink } from "node:fs/promises";
import { configuredPackage, createPaletteCollector, mergePalette, paletteRegistryPath, publishedCommands, readPaletteRegistry, withRegistryLock, writePaletteRegistry } from "./palette.ts";

const node = process.execPath;
const read = { id: "markdown.read", title: "Read a Document…", description: "Open a stored document beside this pane.", argv: [node, "/snapshot/extensions/markdown/palette-command.ts"] };

test("a publication keeps only commands that meet the contract", () => {
	assert.deepEqual(publishedCommands({ version: 1, source: "markdown", commands: [read, read] }), { source: "markdown", commands: [read] }, "a repeated ID counts once");
	const refused = [
		{ ...read, id: "agent.read" },
		{ ...read, id: "markdown.Read" },
		{ ...read, id: `markdown.${"x".repeat(40)}` },
		{ ...read, title: "" },
		{ ...read, title: "Line\nbreak" },
		{ ...read, title: "x".repeat(65) },
		{ ...read, description: "x".repeat(201) },
		{ ...read, argv: [] },
		{ ...read, argv: ["node", "command.ts"] },
		{ ...read, argv: [node, "a\0b"] },
		{ ...read, argv: Array.from({ length: 17 }, () => node) },
		// biome-ignore lint/suspicious/noSparseArray: a sparse list is the malformed input under test.
		{ ...read, argv: [node, , "/x.ts"] },
	];
	assert.deepEqual(publishedCommands({ version: 1, source: "markdown", commands: refused })?.commands, []);
	for (const publication of [{ version: 2, source: "markdown", commands: [read] }, { version: 1, source: "Markdown", commands: [read] }, { version: 1, source: "mark_down", commands: [read] }, { version: 1, source: "markdown" }, null, "markdown"])
		assert.equal(publishedCommands(publication), undefined, JSON.stringify(publication));
});

test("a merge replaces the commands of heard sources and keeps others while their program exists", () => {
	const open = { id: "agent.open", title: "Open an Agent…", argv: ["/old/node", "/old/agent/palette.ts"], source: "agent" };
	const gone = { id: "stash.pick", title: "Pick Up a Handover…", argv: ["/missing/node", "/missing/stash.ts"], source: "stash" };
	const stale = { ...read, title: "Old title", source: "markdown" };
	const removed = { id: "jobs.list", title: "List Jobs…", argv: ["/old/node", "/removed/snapshot/jobs/palette.ts"], source: "jobs" };
	const merged = mergePalette({ version: 1, commands: [stale, open, gone, removed] }, new Map([["markdown", [read]]]), [node, "/snapshot/pane-stacking.mts"], (path) => path === "/old/node" || path === "/old/agent/palette.ts");
	assert.deepEqual(merged, { version: 1, commands: [open, { ...read, source: "markdown" }], paneStacking: [node, "/snapshot/pane-stacking.mts"] }, "sorted by ID; a heard source replaces its commands; a missing program or script drops");
	assert.deepEqual(mergePalette(merged, new Map(), undefined, () => true).commands, merged.commands, "a process that heard nothing removes nothing");
	assert.deepEqual(mergePalette(merged, new Map([["markdown", []]]), undefined, () => true).commands, [open], "a heard source without commands removes its commands");
});

test("the registry is written in one rename only when it changes, and a broken file reads as absent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rex-palette-"));
	try {
		const path = paletteRegistryPath(dir);
		assert.equal(path, join(dir, "rex", "palette.json"));
		const registry = mergePalette(undefined, new Map([["markdown", [read]]]), undefined);
		assert.equal(writePaletteRegistry(path, registry), true);
		assert.equal(writePaletteRegistry(path, registry), false, "unchanged content is not written again");
		assert.deepEqual(readPaletteRegistry(path), registry);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(dir, "rex"))).mode & 0o777, 0o700);
		assert.deepEqual(await readdir(join(dir, "rex")), ["palette.json"], "no temporary file remains");
		await writeFile(path, "{broken");
		assert.equal(readPaletteRegistry(path), undefined);
		await writeFile(path, JSON.stringify({ version: 1, commands: [{ ...read, source: "agent" }, { ...read, source: "markdown" }] }));
		assert.deepEqual(readPaletteRegistry(path)?.commands, [{ ...read, source: "markdown" }], "a recorded command must belong to its source");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("the collector asks for publications, and only an interactive session records them", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rex-palette-"));
	try {
		const events = createEventBus();
		const requests: unknown[] = [];
		events.on("harness:palette:request", (request) => {
			requests.push(request);
			events.emit("harness:palette:publish", { version: 1, source: "markdown", commands: [read] });
		});
		const notices: string[] = [];
		const ui = { notify: (message: string) => { notices.push(message); } };
		const collector = createPaletteCollector({ events, agentDir: dir, packageRoot: "/snapshot", configured: () => true, paneStacking: () => [node, "/snapshot/pane-stacking.mts"] });
		assert.deepEqual(requests, [{ version: 1 }], "the collector asks once at setup");
		const path = paletteRegistryPath(dir);
		collector.start({ mode: "rpc", ui });
		assert.equal(readPaletteRegistry(path), undefined, "an RPC, JSON or print session records nothing");
		collector.start({ mode: "tui", ui });
		assert.deepEqual(readPaletteRegistry(path), { version: 1, commands: [{ ...read, source: "markdown" }], paneStacking: [node, "/snapshot/pane-stacking.mts"] });
		events.emit("harness:palette:publish", { version: 1, source: "agent", commands: [{ id: "agent.open", title: "Open an Agent…", argv: [node, "/snapshot/extensions/agent/palette.ts"] }] });
		assert.deepEqual(readPaletteRegistry(path)?.commands.map((command) => command.id), ["agent.open", "markdown.read"], "a later publication records again");
		collector.shutdown();
		events.emit("harness:palette:publish", { version: 1, source: "stash", commands: [{ id: "stash.pick", title: "Pick", argv: [node, "/x.ts"] }] });
		assert.deepEqual(readPaletteRegistry(path)?.commands.map((command) => command.id), ["agent.open", "markdown.read"], "a stopped collector records nothing");
		assert.deepEqual(notices, []);
		const blocked = await mkdtemp(join(tmpdir(), "rex-palette-"));
		await writeFile(join(blocked, "rex"), "a file where the directory belongs");
		const failing = createPaletteCollector({ events, agentDir: blocked, packageRoot: "/snapshot", configured: () => true, paneStacking: () => undefined });
		failing.start({ mode: "tui", ui });
		events.emit("harness:palette:publish", { version: 1, source: "markdown", commands: [read] });
		assert.equal(notices.length, 1, "a failed record warns once per runtime");
		assert.match(notices[0] ?? "", /could not record its commands/);
		failing.shutdown();
		await rm(blocked, { recursive: true, force: true });
		assert.match(await readFile(path, "utf8"), /"markdown\.read"/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("a trial that Pi's settings do not load records nothing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rex-palette-"));
	try {
		const release = join(dir, "releases", "snapshot");
		const trial = join(dir, "worktree");
		await mkdir(release, { recursive: true });
		await mkdir(trial);
		await symlink(release, join(dir, "current"));
		await writeFile(join(dir, "settings.json"), JSON.stringify({ packages: ["./current", { source: "npm:@example/tools" }] }));
		assert.equal(configuredPackage(dir, release), true, "a relative package path resolves against the agent directory, through links");
		assert.equal(configuredPackage(dir, trial), false);
		await writeFile(join(dir, "settings.json"), "{broken");
		assert.equal(configuredPackage(dir, release), false);
		const events = createEventBus();
		events.on("harness:palette:request", () => events.emit("harness:palette:publish", { version: 1, source: "markdown", commands: [read] }));
		const collector = createPaletteCollector({ events, agentDir: dir, packageRoot: trial, paneStacking: () => undefined });
		collector.start({ mode: "tui", ui: { notify: () => {} } });
		assert.equal(readPaletteRegistry(paletteRegistryPath(dir)), undefined);
		collector.shutdown();
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("the registry lock lets one writer update at a time and leaves no lock behind", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rex-palette-"));
	try {
		const path = paletteRegistryPath(dir);
		let inner: boolean | undefined;
		const outer = withRegistryLock(path, () => { inner = withRegistryLock(path, () => assert.fail("a second writer must not run")); });
		assert.equal(outer, true);
		assert.equal(inner, false, "a contended lock skips the update");
		assert.deepEqual(await readdir(join(dir, "rex")), [], "the lock path is removed");
		assert.equal(withRegistryLock(path, () => {}), true);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
