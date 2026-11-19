import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MarkdownStore } from "./store.ts";

const exec = promisify(execFile);
const command = fileURLToPath(new URL("./palette-command.ts", import.meta.url));
const input = (title: string) => ({
	title,
	source: `# ${title}\n`,
	contentOrigin: { kind: "tool" as const, capturedAt: new Date().toISOString() },
});

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "markdown-palette-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new MarkdownStore(join(root, "store"));
	const app = join(root, "Markdown Reader.app");
	const executable = join(app, "Contents", "MacOS", "MarkdownReader");
	const manifest = join(app, "Contents", "Resources", "build.json");
	return {
		root,
		store,
		executable,
		manifest,
		async step(answers: unknown[] = []) {
			const request = { version: 1, command: "markdown.read", context: { origin: "palette" }, answers };
			const { stdout, stderr } = await exec(process.execPath, [command, store.root, app, JSON.stringify(request)], {
				cwd: root,
				env: {},
				timeout: 20_000,
			});
			assert.equal(stderr, "");
			return JSON.parse(stdout);
		},
		async install(markers = { contract: 1, pane: 1, paneRevision: 1 }) {
			await mkdir(join(app, "Contents", "Resources"), { recursive: true });
			await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
			await writeFile(manifest, JSON.stringify(markers));
			await writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		},
	};
}

test("the pick merges published documents and responses by newest change and caps the combined list", async (t) => {
	const f = await fixture(t);
	const published = await f.store.create(input("Published note"));
	const response = await f.store.snapshot("response", "response", input("Saved response"));
	await f.store.snapshot("file", "file", input("File snapshot"));
	const older = new Date(Date.now() - 3 * 3_600_000 - 60_000).toISOString();
	const directory = join(f.store.root, "documents");
	await writeFile(
		join(directory, published.document.id, "document.json"),
		JSON.stringify({ ...published.document, updatedAt: older }),
	);
	for (let i = 0; i < 200; i++) {
		const id = `md-${i.toString(16).padStart(20, "0")}`;
		const path = join(directory, id);
		await mkdir(path);
		await writeFile(
			join(path, "document.json"),
			JSON.stringify({ ...published.document, id, updatedAt: "2020-01-01T00:00:00.000Z" }),
		);
	}

	const reply = await f.step();
	assert.equal(reply.ask.kind, "pick");
	assert.equal(reply.ask.prompt.title, "Read a document");
	assert.equal(reply.ask.prompt.items.length, 200);
	assert.deepEqual(reply.ask.prompt.items.slice(0, 2), [
		{ id: response.document.id, title: "Saved response", subtitle: "Response · just now", icon: "document" },
		{
			id: published.document.id,
			title: "Published note",
			subtitle: "Published · 3 h ago",
			icon: "document",
			detail: "Revision 1",
		},
	]);
	assert.ok(reply.ask.prompt.items.every((item: { title: string }) => item.title !== "File snapshot"));
});

test("an absent store returns an empty-list error and creates no files", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await f.step(), { error: "There are no published documents or saved responses to read." });
	assert.deepEqual(await readdir(f.root), []);
});

test("the selection pins the revision current at step two in a right split", async (t) => {
	const f = await fixture(t);
	await f.install();
	const first = await f.store.create(input("First revision"));
	const id = first.document.id;
	assert.equal((await f.step()).ask.prompt.items[0].id, id);
	const prefix = `${"a".repeat(31)}📄`;
	const current = await f.store.update(id, 1, input(`${prefix}More title`));
	assert.deepEqual(await f.step([id]), {
		show: {
			argv: [
				f.executable,
				"--pane",
				"--store",
				f.store.root,
				id,
				"--revision",
				"2",
				"--digest",
				current.revision.digest,
			],
			label: prefix,
			placement: "right",
		},
	});
	assert.deepEqual(await readdir(join(f.store.root, "opens")), []);
});

test("a selection that no longer resolves returns an error", async (t) => {
	const f = await fixture(t);
	const { document } = await f.store.create(input("Removed document"));
	assert.equal((await f.step()).ask.prompt.items[0].id, document.id);
	await rm(join(f.store.root, "documents", document.id), { recursive: true });
	assert.deepEqual(await f.step([document.id]), { error: "Document not found." });
});

test("a missing or incompatible reader app names /markdown update", async (t) => {
	const f = await fixture(t);
	const { document } = await f.store.create(input("Saved document"));
	const choose = () => f.step([document.id]);
	assert.match((await choose()).error, /\/markdown update/u);
	await f.install({ contract: 1, pane: 1, paneRevision: 0 });
	assert.match((await choose()).error, /\/markdown update/u);
	await f.install();
	await rm(f.executable);
	assert.match((await choose()).error, /\/markdown update/u);
});
