import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	configuredPackage,
	createPaletteCollector,
	mergePalette,
	paletteRegistryPath,
	publishedCommands,
	readPaletteRegistry,
	withRegistryLock,
	writePaletteRegistry,
} from "./palette.ts";

const node = process.execPath;
const browse = {
	id: "files.browse",
	title: "Browse Files…",
	description: "Browse files beside this pane.",
	argv: [node, "/snapshot/extensions/files/palette-command.ts"],
};

test("a publication keeps only commands that meet the contract", () => {
	assert.deepEqual(
		publishedCommands({ version: 1, source: "files", commands: [browse, browse] }),
		{ source: "files", commands: [browse] },
		"a repeated ID counts once",
	);
	const refused = [
		{ ...browse, id: "tools.browse" },
		{ ...browse, id: "files.Read" },
		{ ...browse, id: `files.${"x".repeat(43)}` },
		{ ...browse, title: "" },
		{ ...browse, title: "Line\nbreak" },
		{ ...browse, title: "x".repeat(65) },
		{ ...browse, description: "x".repeat(201) },
		{ ...browse, argv: [] },
		{ ...browse, argv: ["node", "command.ts"] },
		{ ...browse, argv: [node, "a\0b"] },
		{ ...browse, argv: Array.from({ length: 17 }, () => node) },
		// biome-ignore lint/suspicious/noSparseArray: a sparse list is the malformed input under test.
		{ ...browse, argv: [node, , "/x.ts"] },
	];
	assert.deepEqual(publishedCommands({ version: 1, source: "files", commands: refused })?.commands, []);
	for (const publication of [
		{ version: 2, source: "files", commands: [browse] },
		{ version: 1, source: "Files", commands: [browse] },
		{ version: 1, source: "fi_les", commands: [browse] },
		{ version: 1, source: "files" },
		null,
		"files",
	])
		assert.equal(publishedCommands(publication), undefined, JSON.stringify(publication));
});

test("a merge replaces or removes the commands of heard sources", () => {
	const existing = { version: 1 as const, commands: [{ ...browse, title: "Prior title", source: "files" }] };
	const paneStacking = [node, "/snapshot/pane-stacking.mts"];
	assert.deepEqual(mergePalette(existing, new Map([["files", [browse]]]), paneStacking, "/snapshot"), {
		version: 1,
		commands: [{ ...browse, source: "files" }],
		paneStacking,
	});
	assert.deepEqual(mergePalette(existing, new Map([["files", []]]), undefined, "/snapshot").commands, []);
});

test("unheard commands with absolute first arguments stay only inside the real package root", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "rex-palette-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const root = join(dir, "snapshot");
	const other = join(dir, "snapshot-other");
	const alias = join(dir, "current");
	await mkdir(root);
	await mkdir(other);
	await symlink(root, alias);
	const script = join(root, "browse.ts");
	const outside = join(other, "browse.ts");
	const outsideLink = join(root, "escape.ts");
	await writeFile(script, "");
	await writeFile(outside, "");
	await symlink(outside, outsideLink);
	const command = (name: string, first: string) => ({
		id: `files.${name}`,
		title: name,
		argv: [node, first],
		source: "files",
	});
	const inside = command("inside", script);
	const linked = command("linked", join(alias, "browse.ts"));
	const existing = {
		version: 1 as const,
		commands: [
			command("other", outside),
			linked,
			command("escape", outsideLink),
			command("missing", join(root, "missing.ts")),
			inside,
		],
	};
	assert.deepEqual(mergePalette(existing, new Map(), undefined, alias).commands, [inside, linked]);
});

test("unheard commands without an absolute first argument stay only while their program exists", () => {
	const command = (name: string, argv: string[]) => ({ id: `tools.${name}`, title: name, argv, source: "tools" });
	const flag = command("flag", [node, "--help"]);
	const bare = command("bare", [node]);
	const existing = { version: 1 as const, commands: [flag, command("missing", ["/missing/node", "--help"]), bare] };
	assert.deepEqual(mergePalette(existing, new Map(), undefined, "/snapshot", (path) => path === node).commands, [
		bare,
		flag,
	]);
});

test("the registry is written in one rename only when it changes, and a broken file reads as absent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rex-palette-"));
	try {
		const path = paletteRegistryPath(dir);
		assert.equal(path, join(dir, "rex", "palette.json"));
		const registry = mergePalette(undefined, new Map([["files", [browse]]]), undefined, "/snapshot");
		assert.equal(writePaletteRegistry(path, registry), true);
		assert.equal(writePaletteRegistry(path, registry), false, "unchanged content is not written again");
		assert.deepEqual(readPaletteRegistry(path), registry);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(dir, "rex"))).mode & 0o777, 0o700);
		assert.deepEqual(await readdir(join(dir, "rex")), ["palette.json"], "no temporary file remains");
		await writeFile(path, "{broken");
		assert.equal(readPaletteRegistry(path), undefined);
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				commands: [
					{ ...browse, source: "tools" },
					{ ...browse, source: "files" },
				],
			}),
		);
		assert.deepEqual(
			readPaletteRegistry(path)?.commands,
			[{ ...browse, source: "files" }],
			"a recorded command must belong to its source",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the collector asks for publications, and only an interactive session records them", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rex-palette-"));
	try {
		const events = createEventBus();
		const requests: unknown[] = [];
		events.on("harness:palette:request", (request) => {
			requests.push(request);
			events.emit("harness:palette:publish", { version: 1, source: "files", commands: [browse] });
		});
		const notices: string[] = [];
		const ui = {
			notify: (message: string) => {
				notices.push(message);
			},
		};
		const collector = createPaletteCollector({
			events,
			agentDir: dir,
			packageRoot: "/snapshot",
			configured: () => true,
			paneStacking: () => [node, "/snapshot/pane-stacking.mts"],
		});
		assert.deepEqual(requests, [{ version: 1 }], "the collector asks once at setup");
		const path = paletteRegistryPath(dir);
		collector.start({ mode: "rpc", ui });
		assert.equal(readPaletteRegistry(path), undefined, "an RPC, JSON or print session records nothing");
		collector.start({ mode: "tui", ui });
		assert.deepEqual(readPaletteRegistry(path), {
			version: 1,
			commands: [{ ...browse, source: "files" }],
			paneStacking: [node, "/snapshot/pane-stacking.mts"],
		});
		events.emit("harness:palette:publish", {
			version: 1,
			source: "tools",
			commands: [{ id: "tools.open", title: "Open Tools…", argv: [node, "/snapshot/extensions/tools/palette.ts"] }],
		});
		assert.deepEqual(
			readPaletteRegistry(path)?.commands.map((command) => command.id),
			["files.browse", "tools.open"],
			"a later publication records again",
		);
		collector.shutdown();
		events.emit("harness:palette:publish", {
			version: 1,
			source: "stash",
			commands: [{ id: "stash.pick", title: "Pick", argv: [node, "/x.ts"] }],
		});
		assert.deepEqual(
			readPaletteRegistry(path)?.commands.map((command) => command.id),
			["files.browse", "tools.open"],
			"a stopped collector records nothing",
		);
		assert.deepEqual(notices, []);
		const blocked = await mkdtemp(join(tmpdir(), "rex-palette-"));
		await writeFile(join(blocked, "rex"), "a file where the directory belongs");
		const failing = createPaletteCollector({
			events,
			agentDir: blocked,
			packageRoot: "/snapshot",
			configured: () => true,
			paneStacking: () => undefined,
		});
		failing.start({ mode: "tui", ui });
		events.emit("harness:palette:publish", { version: 1, source: "files", commands: [browse] });
		assert.equal(notices.length, 1, "a failed record warns once per runtime");
		assert.match(notices[0] ?? "", /could not record its commands/);
		failing.shutdown();
		await rm(blocked, { recursive: true, force: true });
		assert.match(await readFile(path, "utf8"), /"files\.browse"/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a trial that Pi's settings do not load records nothing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rex-palette-"));
	try {
		const release = join(dir, "releases", "snapshot");
		const trial = join(dir, "worktree");
		await mkdir(release, { recursive: true });
		await mkdir(trial);
		await symlink(release, join(dir, "current"));
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({ packages: ["./current", { source: "npm:@example/tools" }] }),
		);
		assert.equal(
			configuredPackage(dir, release),
			true,
			"a relative package path resolves against the agent directory, through links",
		);
		assert.equal(configuredPackage(dir, trial), false);
		await writeFile(join(dir, "settings.json"), "{broken");
		assert.equal(configuredPackage(dir, release), false);
		const events = createEventBus();
		events.on("harness:palette:request", () =>
			events.emit("harness:palette:publish", { version: 1, source: "files", commands: [browse] }),
		);
		const collector = createPaletteCollector({
			events,
			agentDir: dir,
			packageRoot: trial,
			paneStacking: () => undefined,
		});
		collector.start({ mode: "tui", ui: { notify: () => {} } });
		assert.equal(readPaletteRegistry(paletteRegistryPath(dir)), undefined);
		collector.shutdown();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a session stops recording when Pi's settings load another package root", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "rex-palette-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const root = join(dir, "snapshot");
	const other = join(dir, "other");
	await mkdir(root);
	await mkdir(other);
	const settings = join(dir, "settings.json");
	await writeFile(settings, JSON.stringify({ packages: [root] }));
	const events = createEventBus();
	const publish = (title: string) =>
		events.emit("harness:palette:publish", { version: 1, source: "files", commands: [{ ...browse, title }] });
	const collector = createPaletteCollector({
		events,
		agentDir: dir,
		packageRoot: root,
		paneStacking: () => undefined,
	});
	t.after(() => collector.shutdown());
	publish(browse.title);
	collector.start({ mode: "tui", ui: { notify: (message) => assert.fail(message) } });
	const path = paletteRegistryPath(dir);
	assert.equal(readPaletteRegistry(path)?.commands[0]?.title, browse.title);
	await writeFile(settings, JSON.stringify({ packages: [other] }));
	const before = await readFile(path, "utf8");
	publish("Updated Files…");
	assert.equal(await readFile(path, "utf8"), before);
});

test("the registry lock lets one writer update at a time and leaves no lock behind", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rex-palette-"));
	try {
		const path = paletteRegistryPath(dir);
		let inner: boolean | undefined;
		const outer = withRegistryLock(path, () => {
			inner = withRegistryLock(path, () => assert.fail("a second writer must not run"));
		});
		assert.equal(outer, true);
		assert.equal(inner, false, "a contended lock skips the update");
		assert.deepEqual(await readdir(join(dir, "rex")), [], "the lock path is removed");
		assert.equal(
			withRegistryLock(path, () => {}),
			true,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
