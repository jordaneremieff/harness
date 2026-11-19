import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { editorCommand } from "./pane-command.ts";
import { openEditorFile, openEditorStored, openScratchpad, type RevealRuntime } from "./reveal.ts";
import { MarkdownStore } from "./store.ts";

const origin = {
	version: 1,
	terminal: "Rex",
	application: { bundleId: "com.superlogical.rex" },
	exact: { opaque: "invoking-conversation" },
};
async function fixture(t: TestContext, build: unknown = { contract: 1, pane: 1, editorOpen: 1 }) {
	const root = await mkdtemp(join(tmpdir(), "markdown-editor-reveal-"));
	const app = join(root, "Reader.app");
	const dir = join(root, "selected-store");
	await mkdir(join(app, "Contents", "Resources"), { recursive: true });
	await writeFile(join(app, "Contents", "Resources", "build.json"), JSON.stringify(build));
	const prior = { app: process.env.PI_MARKDOWN_APP, dir: process.env.PI_MARKDOWN_DIR };
	process.env.PI_MARKDOWN_APP = app;
	process.env.PI_MARKDOWN_DIR = dir;
	t.after(async () => {
		if (prior.app === undefined) delete process.env.PI_MARKDOWN_APP;
		else process.env.PI_MARKDOWN_APP = prior.app;
		if (prior.dir === undefined) delete process.env.PI_MARKDOWN_DIR;
		else process.env.PI_MARKDOWN_DIR = prior.dir;
		await rm(root, { recursive: true, force: true });
	});
	return { root, app, dir };
}

test("New dispatches a fixed editor command beside the captured conversation without publishing a scratchpad", async (t) => {
	const f = await fixture(t);
	let dispatches = 0;
	const runtime: RevealRuntime = {
		platform: "darwin",
		run: async (executable, args, options) => {
			assert.equal(executable, process.execPath);
			if (args[1] === "capture") return { stdout: JSON.stringify(origin) };
			dispatches++;
			assert.match(args[0], /extensions\/rex\/terminal-pane\.ts$/u);
			const request = JSON.parse(options.input ?? "null");
			assert.deepEqual(request.origin, origin);
			assert.deepEqual(request.argv, [
				join(f.app, "Contents", "MacOS", "MarkdownReader"),
				"--editor",
				"--surface",
				"pane",
				"--store",
				f.dir,
				"--intent",
				"scratchpad",
				"--origin",
				JSON.stringify(origin),
			]);
			return {
				stdout: JSON.stringify({
					version: 1,
					outcome: "created",
					detail: "Created.",
					receipt: { opaque: "placement" },
				}),
			};
		},
	};
	const notice = await openScratchpad(new AbortController().signal, { runtime });
	assert.equal(dispatches, 1);
	assert.match(notice, /focus and readiness are not yet confirmed/u);
	assert.equal(await new MarkdownStore(f.dir).identity(), undefined);
});

test("explicit file editing passes the literal absolute path to a new standalone process", async (t) => {
	const f = await fixture(t);
	const path = join(f.root, "notes $(no-shell); spaces.md");
	await writeFile(path, "\uFEFFfirst\r\nsecond\n");
	const before = await readFile(path);
	const calls: string[][] = [];
	const runtime: RevealRuntime = {
		platform: "darwin",
		run: async (exe, args) => {
			calls.push([exe, ...args]);
			return { stdout: JSON.stringify(origin) };
		},
	};
	await openEditorFile(path, new AbortController().signal, { runtime, presentation: "window" });
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1].slice(0, 5), ["/usr/bin/open", "-n", "-a", f.app, "--args"]);
	assert.equal(calls[1].at(-1), path);
	assert.ok(calls[1].includes("--origin"));
	assert.deepEqual(await readFile(path), before);
	assert.equal(await new MarkdownStore(f.dir).identity(), undefined);
});

test("Edit a Copy passes an exact pinned revision and never edits the stored source", async (t) => {
	const f = await fixture(t);
	const store = new MarkdownStore(f.dir);
	const first = await store.create({
		title: "Stored",
		source: "first source",
		contentOrigin: { kind: "tool", capturedAt: "2026-01-01T00:00:00Z" },
	});
	const identity = await store.initialise();
	await store.update(first.document.id, 1, {
		title: "Stored",
		source: "later source",
		contentOrigin: { kind: "tool", capturedAt: "2026-01-02T00:00:00Z" },
	});
	const runtime: RevealRuntime = {
		platform: "darwin",
		acceptanceMs: 5,
		run: async (_exe, args, options) => {
			if (args[1] === "capture") return { stdout: JSON.stringify(origin) };
			const payload = JSON.parse(options.input ?? "null");
			assert.equal(payload.argv[payload.argv.indexOf("--intent") + 1], "copy");
			const requestPath = payload.argv.at(-1);
			const request = JSON.parse(await readFile(requestPath, "utf8"));
			assert.equal(request.document, first.document.id);
			assert.equal(request.revision, 1);
			assert.equal(request.digest, first.revision.digest);
			assert.equal(request.storeId, identity.storeId);
			assert.deepEqual(request.launchOrigin, origin);
			await rm(requestPath);
			return {
				stdout: JSON.stringify({
					version: 1,
					outcome: "created",
					detail: "Created.",
					receipt: { opaque: "placement" },
				}),
			};
		},
	};
	const result = await openEditorStored(f.dir, first.document.id, "copy", new AbortController().signal, {
		runtime,
		storeId: identity.storeId,
		pin: { revision: 1, digest: first.revision.digest },
	});
	assert.match(result, /accepted the selected revision/u);
	assert.equal((await store.get(first.document.id, 1)).source, "first source");
	assert.equal((await store.get(first.document.id)).source, "later source");
	assert.equal((await store.list()).documents.length, 1);
	assert.deepEqual(await readdir(join(f.dir, "opens")), []);
});

for (const state of ["unavailable", "stale", "uncertain"] as const)
	test(`an editor pane ${state} result never retries or selects a separate window`, async (t) => {
		await fixture(t);
		let dispatches = 0;
		const runtime: RevealRuntime = {
			platform: "darwin",
			run: async (exe, args) => {
				assert.equal(exe, process.execPath);
				if (args[1] === "capture") return { stdout: "null" };
				dispatches++;
				return { stdout: JSON.stringify({ version: 1, outcome: state, detail: "No exact origin." }) };
			},
		};
		const notice = await openScratchpad(new AbortController().signal, { runtime });
		assert.equal(dispatches, 1);
		assert.match(notice, state === "uncertain" ? /unconfirmed/u : /No separate window/u);
	});

test("old installed readers do not accept editor requests and cancelled actions never launch", async (t) => {
	const f = await fixture(t, { contract: 1, pane: 1 });
	assert.ok("showUnavailable" in editorCommand(f.app, f.dir, "scratchpad", "pane"));
	let calls = 0;
	const controller = new AbortController();
	const runtime: RevealRuntime = {
		platform: "darwin",
		run: async () => {
			calls++;
			controller.abort();
			return { stdout: JSON.stringify(origin) };
		},
	};
	await assert.rejects(openScratchpad(controller.signal, { runtime }));
	assert.equal(calls, 1);
	assert.equal(await new MarkdownStore(f.dir).identity(), undefined);
});
