import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { paneCommand, paneRequestCommand } from "./pane-command.ts";

test("direct pane launches preserve explicit revision pins or refuse", async () => {
	const app = await mkdtemp(join(tmpdir(), "markdown-pane-pin-"));
	try {
		const resources = join(app, "Contents", "Resources");
		await mkdir(resources, { recursive: true });
		const manifest = join(resources, "build.json");
		const build = { contract: 1, pane: 1, paneOpen: 1 };
		const id = "md-0123456789abcdef0123";
		const command = [join(app, "Contents", "MacOS", "MarkdownReader"), "--pane", "--store", "/store", id];
		const pin = { revision: 2, digest: `sha256:${"b".repeat(64)}` };
		await writeFile(manifest, JSON.stringify(build));
		assert.deepEqual(paneCommand(app, "/store", id), { show: command });
		const refused = paneCommand(app, "/store", id, pin);
		assert.ok("showUnavailable" in refused && !("show" in refused));
		assert.match(refused.showUnavailable, /exact revision/u);
		await writeFile(manifest, JSON.stringify({ ...build, paneRevision: 1 }));
		assert.deepEqual(paneCommand(app, "/store", id, pin), {
			show: [...command, "--revision", "2", "--digest", pin.digest],
		});
	} finally {
		await rm(app, { recursive: true, force: true });
	}
});

test("pinned pane commands require the explicit native request capability", async () => {
	const root = await mkdtemp(join(tmpdir(), "markdown-pane-command-"));
	try {
		const resources = join(root, "Contents", "Resources");
		await mkdir(resources, { recursive: true });
		for (const build of [
			{ contract: 1 },
			{ contract: 1, pane: 1, paneOpen: 1 },
			{ contract: 1, pane: 1, paneOpenRequest: 2 },
		]) {
			await writeFile(join(resources, "build.json"), JSON.stringify(build));
			assert.ok("showUnavailable" in paneRequestCommand(root, "/store/opens/request.json"));
		}
		await writeFile(join(resources, "build.json"), JSON.stringify({ contract: 1, pane: 1, paneOpenRequest: 1 }));
		assert.deepEqual(paneRequestCommand(root, "/store/opens/request.json"), {
			show: [join(root, "Contents", "MacOS", "MarkdownReader"), "--pane", "/store/opens/request.json"],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
