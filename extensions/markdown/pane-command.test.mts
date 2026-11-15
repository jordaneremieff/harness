import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { paneRequestCommand } from "./pane-command.ts";

test("pinned pane commands require the explicit native request capability", async () => {
	const root = await mkdtemp(join(tmpdir(), "markdown-pane-command-"));
	try {
		const resources = join(root, "Contents", "Resources");
		await mkdir(resources, { recursive: true });
		for (const build of [{ contract: 1 }, { contract: 1, pane: 1, paneOpen: 1 }, { contract: 1, pane: 1, paneOpenRequest: 2 }]) {
			await writeFile(join(resources, "build.json"), JSON.stringify(build));
			assert.ok("showUnavailable" in paneRequestCommand(root, "/store/opens/request.json"));
		}
		await writeFile(join(resources, "build.json"), JSON.stringify({ contract: 1, pane: 1, paneOpenRequest: 1 }));
		assert.deepEqual(paneRequestCommand(root, "/store/opens/request.json"), { show: [join(root, "Contents", "MacOS", "MarkdownReader"), "--pane", "/store/opens/request.json"] });
	} finally { await rm(root, { recursive: true, force: true }); }
});
