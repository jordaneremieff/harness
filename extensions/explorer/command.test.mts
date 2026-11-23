import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { commandHelp, commandInput, commandScope, completions, ExplorerRefusal, showCommandReport } from "./command.ts";
import { paletteStep } from "./palette-command.ts";
import { BUILD_COMMAND, paneLaunch, targetArgs } from "./pane-command.ts";

test("command readers distinguish paths and review scopes", () => {
	assert.deepEqual(commandInput(""), { mode: "open" });
	assert.deepEqual(commandInput('"notes"'), { mode: "open", value: "notes" });
	assert.deepEqual(commandInput("  changes  HEAD~2..HEAD "), { mode: "changes", value: "HEAD~2..HEAD" });
	assert.deepEqual(commandScope("HEAD~2..HEAD"), { kind: "range", base: "HEAD~2", head: "HEAD" });
	assert.throws(() => commandScope("HEAD...HEAD"), /base\.\.head/u);
	assert.deepEqual(
		completions("changes since")?.map((choice) => choice.value),
		["changes since-review"],
	);
});

test("Explorer help keeps its headless form, and the local report scrolls through all forms", async () => {
	assert.equal(commandHelp("notes", true), "/explorer notes  Open the repository's Notes list.");
	assert.equal(commandHelp("notes"), "/explorer notes\nOpen the repository's Notes list.");
	assert.throws(() => commandHelp("missing"), ExplorerRefusal);
	const controller = new AbortController();
	const tui = { terminal: { rows: 8 }, requestRender() {} } as TUI;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const ui: Pick<ExtensionContext["ui"], "custom"> = {
		async custom(factory) {
			return await new Promise((resolve, reject) => {
				void (async () => {
					const component = await factory(tui, theme, {} as KeybindingsManager, resolve);
					assert.match(component.render(70).join("\n"), /Explorer help\n\/explorer \[path\]/u);
					assert.doesNotMatch(component.render(70).join("\n"), /Show command usage/u);
					for (let i = 0; i < 6; i++) component.handleInput?.("\x1b[6~");
					assert.match(component.render(70).join("\n"), /\/explorer help \[topic\]\nShow command usage\./u);
					controller.abort();
					component.dispose?.();
				})().catch(reject);
			});
		},
	};
	await showCommandReport(ui, "Explorer help", commandHelp(""), controller.signal);
});

test("the Rex picker keeps complete captions and exact selection identities", { timeout: 5000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "explorer-palette-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "directory".repeat(35), "full-path");
	const label = `${"Label ".repeat(25)}end`;
	await writeFile(join(dir, "recents.json"), JSON.stringify({ version: 1, roots: [{ path, label }] }));
	const request = JSON.stringify({ version: 1, command: "explorer.folder", context: {}, answers: [] });
	const result = await paletteStep([dir, join(dir, "missing.app"), dir, request]);
	assert.ok(result.ask);
	const [row] = result.ask.prompt.items;
	assert.equal(row.title, label);
	assert.equal(row.subtitle, path);
	assert.match(row.id, /^[a-f0-9]{32}$/u);
});

test("manifests gate fixed executable argv and same-pane navigation", { timeout: 5000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "explorer-build-"));
	try {
		const app = join(dir, "Explorer.app");
		const executable = join(app, "Contents", "MacOS", "Explorer");
		const resources = join(app, "Contents", "Resources");
		const manifest = join(resources, "build.json");
		const target = {
			root: join(dir, "space here"),
			path: 'a/b "quote".ts',
			line: 3,
			end: 8,
			review: { kind: "range" as const, base: "HEAD^", head: "HEAD" },
		};
		const absent = await paneLaunch(app, dir, target, dir);
		assert.deepEqual("build" in absent && absent.build, BUILD_COMMAND);
		await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
		await mkdir(resources, { recursive: true });
		await writeFile(executable, "#!/bin/sh\nexit 0\n");
		await chmod(executable, 0o700);
		await writeFile(manifest, JSON.stringify({ contract: 1, pane: 1 }));
		assert.deepEqual(await paneLaunch(app, dir, target, dir), absent);
		await writeFile(manifest, JSON.stringify({ contract: 1, pane: 1, ignoredOption: 1 }));
		assert.deepEqual(await paneLaunch(app, dir, target, dir), {
			show: [executable, "--pane", "--store", dir, "--ignored", "show", ...targetArgs(target)],
			live: false,
		});
		await writeFile(manifest, JSON.stringify({ contract: 1, pane: 1, paneOpen: 1, live: 1, ignoredOption: 1 }));
		await writeFile(join(dir, "harness.json"), JSON.stringify({ version: 1, explorer: { showIgnored: false } }));
		const result = await paneLaunch(app, dir, target, dir);
		assert.ok("show" in result);
		assert.deepEqual(result.show, [executable, "--pane", "--store", dir, "--ignored", "hide", ...targetArgs(target)]);
		assert.equal(result.live, true);
		assert.equal(
			result.paneInput,
			`:open --root ${JSON.stringify(target.root)} --path ${JSON.stringify(target.path)} --line 3 --end 8 --review ${JSON.stringify(JSON.stringify(target.review))}\r`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
