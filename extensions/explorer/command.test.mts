import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandInput, commandScope, completions } from "./command.ts";
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
		const absent = await paneLaunch(app, dir, target);
		assert.deepEqual("build" in absent && absent.build, BUILD_COMMAND);
		await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
		await mkdir(resources, { recursive: true });
		await writeFile(executable, "#!/bin/sh\nexit 0\n");
		await chmod(executable, 0o700);
		await writeFile(manifest, JSON.stringify({ contract: 1, pane: 1 }));
		assert.deepEqual(await paneLaunch(app, dir, target), {
			show: [executable, "--pane", "--store", dir, ...targetArgs(target)],
			live: false,
		});
		await writeFile(manifest, JSON.stringify({ contract: 1, pane: 1, paneOpen: 1, live: 1 }));
		const result = await paneLaunch(app, dir, target);
		assert.ok("show" in result);
		assert.equal(result.live, true);
		assert.equal(
			result.paneInput,
			`:open --root ${JSON.stringify(target.root)} --path ${JSON.stringify(target.path)} --line 3 --end 8 --review ${JSON.stringify(JSON.stringify(target.review))}\r`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
