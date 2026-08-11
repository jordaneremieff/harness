import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { listStashes, readStash, resolveStoreDir, rotateStash, transitionStash, writeStash } from "./store.ts";

let dir: string;

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "stash-store-test-"));
});

after(async () => {
	await rm(dir, { recursive: true, force: true });
});

const at = (iso: string) => new Date(iso);

describe("resolveStoreDir", () => {
	it("prefers PI_STASH_DIR", () => {
		assert.equal(resolveStoreDir({ PI_STASH_DIR: "/x/stash" } as NodeJS.ProcessEnv, "/agent"), "/x/stash");
	});
	it("anchors at the provided agentDir", () => {
		assert.equal(resolveStoreDir({} as NodeJS.ProcessEnv, "/agent"), "/agent/stash");
	});
	it("falls back to ~/.pi/agent without an agentDir", () => {
		assert.match(resolveStoreDir({} as NodeJS.ProcessEnv), /\/\.pi\/agent\/stash$/);
	});
});

describe("writeStash + listStashes", () => {
	it("writes a discoverable artifact named by timestamp and slug with private permissions", async () => {
		const { record, path } = await writeStash(dir, { title: "First Stash", summary: "s1" }, at("2026-07-24T10:00:00Z"));
		assert.equal(record.id, "20260724T100000Z-first-stash");
		assert.ok(path.endsWith("20260724T100000Z-first-stash.md"));
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		const entries = await listStashes(dir);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].meta.title, "First Stash");
	});

	it("never clobbers same-second stashes with the same title", async () => {
		const now = at("2026-07-24T10:30:00Z");
		const writes = await Promise.all([
			writeStash(dir, { title: "Collision", summary: "first body" }, now),
			writeStash(dir, { title: "Collision", summary: "second body" }, now),
		]);
		assert.deepEqual(
			writes.map((result) => result.record.id).sort(),
			["20260724T103000Z-collision", "20260724T103000Z-collision-2"],
		);
		assert.deepEqual(
			(await Promise.all(writes.map((result) => readFile(result.path, "utf8")))).map((body) =>
				body.includes("first body") ? "first" : "second",
			).sort(),
			["first", "second"],
		);
	});

	it("hardens an existing store and its artifacts when discovered", async () => {
		const legacyDir = join(dir, "legacy-store");
		await mkdir(legacyDir, { mode: 0o755 });
		await chmod(legacyDir, 0o755);
		const legacyPath = join(legacyDir, "20260724T103500Z-legacy.md");
		await writeFile(legacyPath, "# legacy\n", { mode: 0o644 });
		await chmod(legacyPath, 0o644);

		assert.equal((await listStashes(legacyDir)).length, 1);
		assert.equal((await stat(legacyDir)).mode & 0o777, 0o700);
		assert.equal((await stat(legacyPath)).mode & 0o777, 0o600);
	});

	it("lists newest-first and respects limit", async () => {
		await writeStash(dir, { title: "Second", summary: "s2" }, at("2026-07-24T11:00:00Z"));
		await writeStash(dir, { title: "Third", summary: "s3" }, at("2026-07-24T12:00:00Z"));
		const all = await listStashes(dir, { limit: 10 });
		assert.deepEqual(all.slice(0, 2).map((e) => e.meta.title), ["Third", "Second"]);
		assert.ok(all.some((entry) => entry.meta.title === "First Stash"));
		const top = await listStashes(dir, { limit: 1 });
		assert.equal(top.length, 1);
		assert.equal(top[0].meta.title, "Third");
	});

	it("filters by tag", async () => {
		await writeStash(dir, { title: "Tagged", summary: "s4", tags: ["release"] }, at("2026-07-24T13:00:00Z"));
		const hits = await listStashes(dir, { limit: 10, tag: "release" });
		assert.equal(hits.length, 1);
		assert.equal(hits[0].meta.title, "Tagged");
		assert.equal((await listStashes(dir, { tag: "nope" })).length, 0);
	});

	it("still lists malformed frontmatter and keeps the filename as the authoritative id", async () => {
		await writeFile(join(dir, "20260724T140000Z-corrupt.md"), '---\nid: "different-id"\ntitle: [broken\n---\nbody\n', "utf8");
		const entries = await listStashes(dir, { limit: 20 });
		const corrupt = entries.find((entry) => entry.meta.id === "20260724T140000Z-corrupt");
		assert.ok(corrupt);
		assert.equal(corrupt.meta.id, "20260724T140000Z-corrupt");
	});

	it("loads a bounded body preview for the browser", async () => {
		const entries = await listStashes(dir, { limit: 20, previewBytes: 64 });
		const first = entries.find((entry) => entry.meta.id === "20260724T100000Z-first-stash");
		assert.ok(first);
		assert.equal(typeof first.preview, "string");
		assert.equal(typeof first.previewTruncated, "boolean");
	});

	it("ignores symlinked artifacts and rejects a symlinked store", async () => {
		const target = join(dir, "outside.md");
		await writeFile(target, "# outside\n", "utf8");
		await symlink(target, join(dir, "20260724T150000Z-link.md"));
		assert.ok(!(await listStashes(dir, { limit: 50 })).some((entry) => entry.meta.id.endsWith("-link")));

		const linkedStore = join(dir, "linked-store");
		await symlink(dir, linkedStore);
		await assert.rejects(listStashes(linkedStore), /not a regular directory/);
	});

	it("returns an empty list for a missing store dir", async () => {
		assert.deepEqual(await listStashes(join(dir, "does-not-exist")), []);
	});

	it("never decodes a replacement character when the preview cut lands mid-codepoint", async () => {
		const scoped = join(dir, "multibyte-store");
		await mkdir(scoped);
		const id = "20260726T160000Z-multibyte";
		// A large body past the 16 KiB header scan so the byte-bounded preview
		// read cuts inside the two-byte body characters and the cut tail
		// survives the preview's own head-cut. One of the two preview budgets
		// below must split a codepoint regardless of alignment. The header
		// itself stays small so the state stays verifiable at the scan window.
		const artifact = `---\ntitle: "Multibyte"\n---\n${"é".repeat(17_000)}`;
		await writeFile(join(scoped, `${id}.md`), artifact, "utf8");
		for (const previewBytes of [200, 201]) {
			const [entry] = await listStashes(scoped, { limit: 1, previewBytes });
			assert.equal(entry.meta.id, id);
			assert.equal(entry.meta.state, "open");
			assert.equal(entry.previewError, undefined);
			assert.equal(entry.previewTruncated, true);
			assert.ok(!entry.preview?.includes("\uFFFD"), `previewBytes=${previewBytes} decoded a broken codepoint`);
			assert.match(entry.preview ?? "", /é$/);
		}
	});
});

describe("stash lifecycle transitions", () => {
	it("moves open to active to closed, requires an outcome, and deliberately reopens", async () => {
		const lifecycleDir = join(dir, "lifecycle-store");
		const { record, path } = await writeStash(
			lifecycleDir,
			{ title: "Lifecycle", summary: "stateful handover" },
			at("2026-07-26T10:00:00Z"),
		);
		assert.equal(record.state, "open");
		await writeFile(path, (await readFile(path, "utf8")).replace('state: "open"', 'custom: {"keep":true}\nstate: "open"'), "utf8");

		const active = await transitionStash(lifecycleDir, record.id, { action: "activate" }, at("2026-07-26T11:00:00Z"));
		assert.equal(active.meta.state, "active");
		assert.equal(active.meta.activatedAt, "20260726T110000Z");
		assert.match(active.content, /^custom: \{"keep":true\}$/m);
		assert.equal((await transitionStash(lifecycleDir, record.id, { action: "activate" })).changed, false);
		await assert.rejects(
			transitionStash(lifecycleDir, record.id, { action: "close", outcome: "   " }),
			/outcome must not be empty/i,
		);

		const closed = await transitionStash(
			lifecycleDir,
			record.id,
			{ action: "close", outcome: "Implemented and verified the requested behavior." },
			at("2026-07-26T12:00:00Z"),
		);
		assert.equal(closed.meta.state, "closed");
		assert.equal(closed.meta.closedAt, "20260726T120000Z");
		assert.equal(closed.meta.outcome, "Implemented and verified the requested behavior.");
		await assert.rejects(transitionStash(lifecycleDir, record.id, { action: "activate" }), /closed.*reopen/i);

		const reopened = await transitionStash(lifecycleDir, record.id, { action: "reopen" });
		assert.equal(reopened.meta.state, "open");
		assert.equal(reopened.meta.closedAt, undefined);
		assert.equal(reopened.meta.outcome, undefined);
		assert.equal(reopened.meta.activatedAt, "20260726T110000Z");
		assert.doesNotMatch(reopened.content, /^outcome:/m);
		assert.match(reopened.content, /^custom: \{"keep":true\}$/m);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	});

	it("normalizes metadata-less artifacts to open and filters lists by lifecycle state", async () => {
		const lifecycleDir = join(dir, "legacy-lifecycle-store");
		await mkdir(lifecycleDir);
		const legacyId = "20260726T130000Z-legacy-lifecycle";
		await writeFile(join(lifecycleDir, `${legacyId}.md`), "# Legacy handover\n", "utf8");
		const [legacy] = await listStashes(lifecycleDir, { state: "open" });
		assert.equal(legacy.meta.id, legacyId);
		assert.equal(legacy.meta.state, "open");
		await transitionStash(lifecycleDir, legacyId, { action: "activate" }, at("2026-07-26T13:30:00Z"));
		assert.equal((await listStashes(lifecycleDir, { state: "open" })).length, 0);
		assert.equal((await listStashes(lifecycleDir, { state: "active" }))[0].meta.id, legacyId);
	});

	it("rejects corrupt explicit lifecycle state instead of silently rewriting it", async () => {
		const lifecycleDir = join(dir, "invalid-lifecycle-store");
		await mkdir(lifecycleDir);
		const id = "20260726T140000Z-invalid-state";
		await writeFile(join(lifecycleDir, `${id}.md`), '---\nstate: "mystery"\n---\nbody\n', "utf8");
		await assert.rejects(transitionStash(lifecycleDir, id, { action: "activate" }), /invalid lifecycle state/i);
	});

	it("redacts credential-shaped completion outcomes before they are stored", async () => {
		const lifecycleDir = join(dir, "outcome-redact-store");
		await mkdir(lifecycleDir);
		const secret = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz123456";
		const { record } = await writeStash(lifecycleDir, { title: "Outcome redaction", summary: "s" }, at("2026-07-26T14:30:00Z"));
		await transitionStash(lifecycleDir, record.id, { action: "activate" });
		await transitionStash(lifecycleDir, record.id, { action: "close", outcome: `done; the key was ${secret}` });
		const read = await readStash(lifecycleDir, record.id);
		assert.equal(read.ok, true);
		if (!read.ok) return;
		assert.ok(!read.content.includes(secret), "a credential must not enter an artifact through the outcome");
		assert.match(read.content, /\[REDACTED\]/);
	});
});

describe("readStash", () => {
	it("reads by exact id and by unique prefix", async () => {
		const exact = await readStash(dir, "20260724T100000Z-first-stash");
		assert.equal(exact.ok, true);
		if (exact.ok) assert.match(exact.content, /# First Stash/);
		const prefix = await readStash(dir, "20260724T100000Z-first");
		assert.equal(prefix.ok, true);
	});

	it("fails with candidates on ambiguous prefixes", async () => {
		const result = await readStash(dir, "20260724T1");
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok((result.candidates?.length ?? 0) > 1);
	});

	it("rejects oversized existing artifacts without reading them into memory", async () => {
		const id = "20260724T160000Z-oversized";
		await writeFile(join(dir, `${id}.md`), "x".repeat(300 * 1024), "utf8");
		const result = await readStash(dir, id);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /maximum readable size/);
	});

	it("reports misses without throwing", async () => {
		const result = await readStash(dir, "no-such-stash");
		assert.equal(result.ok, false);
	});
});

describe("artifact header beyond the scan window", () => {
	/** An artifact whose frontmatter is longer than the 16 KiB header scan. */
	async function writeLongHeader(store: string, id: string): Promise<string> {
		const path = join(store, `${id}.md`);
		const filler = "x".repeat(20 * 1024);
		await writeFile(
			path,
			`---\nid: ${JSON.stringify(id)}\nnote: ${JSON.stringify(filler)}\nstate: "active"\n---\n\n# body\n`,
			{ mode: 0o600 },
		);
		return path;
	}

	it("never reports an unread header as an open state", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-longheader-"));
		await chmod(store, 0o700);
		const id = "20260726T100000Z-long-header";
		await writeLongHeader(store, id);
		const open = await listStashes(store, { state: "open" });
		assert.equal(open.some((entry) => entry.meta.id === id), false);
		const all = await listStashes(store, { limit: 50 });
		const entry = all.find((item) => item.meta.id === id);
		assert.ok(entry, "the artifact must still be listed without a state filter");
		assert.ok(entry?.previewError, "an unread header must be reported, not defaulted");
		assert.match(entry?.previewError ?? "", /scan window/, "a truncated scan must say so");
		// The browser requests a large preview; the lifecycle decision must still
		// use the bounded header window, so both surfaces agree on the state.
		const browser = await listStashes(store, { limit: 50, previewBytes: 32 * 1024 });
		const browserEntry = browser.find((item) => item.meta.id === id);
		assert.ok(browserEntry?.previewError, "the browser must not verify a state beyond the scan window");
		await rm(store, { recursive: true, force: true });
	});

	it("refuses to rotate an artifact whose state it cannot verify", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-longheader-"));
		await chmod(store, 0o700);
		const id = "20260726T110000Z-long-header";
		const path = await writeLongHeader(store, id);
		await assert.rejects(rotateStash(store, id), /state cannot be verified/);
		assert.ok((await stat(path)).isFile(), "the artifact must stay in place");
		await rm(store, { recursive: true, force: true });
	});
});

describe("unreadable and invalid lifecycle states", () => {
	it("never treats a small unclosed header as a verified state", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-unclosed-"));
		await chmod(store, 0o700);
		const id = "20260726T150000Z-unclosed";
		const path = join(store, `${id}.md`);
		await writeFile(path, '---\nstate: "active"\n\n# body\n', "utf8");
		// Unfiltered listing still shows the artifact, marked unread, never as open.
		const all = await listStashes(store, { limit: 50 });
		const entry = all.find((item) => item.meta.id === id);
		assert.ok(entry, "the artifact must still be listed without a state filter");
		assert.ok(entry?.previewError, "an unclosed header must be reported, not defaulted");
		assert.match(entry?.previewError ?? "", /never closes/);
		assert.equal(entry?.meta.state, "open", "the defaulted fallback must stay distinguishable");
		// No state filter may satisfy it.
		assert.equal((await listStashes(store, { state: "open" })).some((item) => item.meta.id === id), false);
		assert.equal((await listStashes(store, { state: "active" })).some((item) => item.meta.id === id), false);
		// Rotation and every lifecycle transition refuse it, leaving the bytes intact.
		const before = await readFile(path, "utf8");
		await assert.rejects(rotateStash(store, id), /state cannot be verified/);
		await assert.rejects(transitionStash(store, id, { action: "activate" }), /state cannot be verified/);
		assert.ok((await stat(path)).isFile(), "the artifact must stay in place");
		assert.equal(await readFile(path, "utf8"), before, "a refused transition must not rewrite the artifact");
		await rm(store, { recursive: true, force: true });
	});

	it("keeps a legacy artifact without any header open and mutable", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-legacy-open-"));
		await chmod(store, 0o700);
		const id = "20260726T160000Z-legacy-open";
		await writeFile(join(store, `${id}.md`), "# Legacy handover\n", "utf8");
		const [entry] = await listStashes(store, { state: "open" });
		assert.equal(entry.meta.id, id);
		assert.equal(entry.meta.state, "open");
		assert.equal(entry.previewError, undefined);
		await transitionStash(store, id, { action: "activate" });
		assert.equal((await listStashes(store, { state: "active" }))[0].meta.id, id);
		await rm(store, { recursive: true, force: true });
	});

	it("treats a closing fence with trailing characters as unread, like parseFrontmatter", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-trailing-close-"));
		await chmod(store, 0o700);
		const id = "20260726T170000Z-trailing-close";
		const path = join(store, `${id}.md`);
		await writeFile(path, '---\nstate: "active"\n--- done\nbody\n', "utf8");
		// The local parser only closes on a line that trims to exactly "---", so
		// "--- done" never closes the header: the state is UNKNOWN, never open.
		const all = await listStashes(store, { limit: 50 });
		const entry = all.find((item) => item.meta.id === id);
		assert.ok(entry, "the artifact must still be listed without a state filter");
		assert.ok(entry?.previewError, "a trailing-character fence must be reported as unread");
		assert.equal((await listStashes(store, { state: "open" })).some((item) => item.meta.id === id), false);
		const before = await readFile(path, "utf8");
		await assert.rejects(rotateStash(store, id), /state cannot be verified/);
		await assert.rejects(transitionStash(store, id, { action: "activate" }), /state cannot be verified/);
		assert.equal(await readFile(path, "utf8"), before, "a refused transition must not rewrite the artifact");
		await rm(store, { recursive: true, force: true });
	});

	it("treats an unclosed header with diff-rule or markdown-rule lines in the body as unread", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-unclosed-body-"));
		await chmod(store, 0o700);
		const diffId = "20260726T190000Z-unclosed-diff";
		await writeFile(join(store, `${diffId}.md`), '---\nstate: "active"\ntitle: "Live effort"\n\n# body\n--- a/src/foo.ts\n+++ b/src/foo.ts\n', "utf8");
		const ruleId = "20260726T191000Z-unclosed-rule";
		await writeFile(join(store, `${ruleId}.md`), '---\nstate: "active"\n\n# body\n----\n', "utf8");
		// Diff headers and markdown rules are ordinary body content: they must not
		// close the frontmatter fence for the guard any more than for the parser.
		for (const id of [diffId, ruleId]) {
			const all = await listStashes(store, { limit: 50 });
			const entry = all.find((item) => item.meta.id === id);
			assert.ok(entry, `${id} must still be listed`);
			assert.ok(entry?.previewError, `${id} must be reported as unread`);
			assert.equal((await listStashes(store, { state: "open" })).some((item) => item.meta.id === id), false);
			await assert.rejects(rotateStash(store, id), /state cannot be verified/);
			await assert.rejects(transitionStash(store, id, { action: "activate" }), /state cannot be verified/);
		}
		await rm(store, { recursive: true, force: true });
	});

	it("keeps a legacy artifact whose first line starts with dashes open and rotatable", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-legacy-dashes-"));
		await chmod(store, 0o700);
		const id = "20260726T192000Z-legacy-dashes";
		await writeFile(join(store, `${id}.md`), "---- section\nbody\n", "utf8");
		const [entry] = await listStashes(store, { state: "open" });
		assert.equal(entry.meta.id, id);
		assert.equal(entry.previewError, undefined);
		await rotateStash(store, id);
		assert.equal((await readStash(store, id)).ok, false, "a legacy artifact must remain rotatable");
		await rm(store, { recursive: true, force: true });
	});

	it("reads a header whose closing fence is indented, like parseFrontmatter", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-indented-close-"));
		await chmod(store, 0o700);
		const id = "20260726T193000Z-indented-close";
		await writeFile(join(store, `${id}.md`), '---\nstate: "active"\n  ---\nbody\n', "utf8");
		const all = await listStashes(store, { limit: 50 });
		const entry = all.find((item) => item.meta.id === id);
		assert.ok(entry);
		assert.equal(entry.previewError, undefined);
		assert.equal(entry.meta.state, "active", "the real state must survive an indented close");
		assert.equal((await listStashes(store, { state: "active" })).some((item) => item.meta.id === id), true);
		await rm(store, { recursive: true, force: true });
	});

	it("keeps unreadable artifacts visible unfiltered and excludes them from tag-filtered listings", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-tag-unread-"));
		await chmod(store, 0o700);
		const id = "20260726T194000Z-tag-unread";
		await writeFile(join(store, `${id}.md`), '---\nstate: "active"\n\n# body\n', "utf8");
		assert.ok((await listStashes(store, { limit: 50 })).some((item) => item.meta.id === id));
		assert.equal((await listStashes(store, { tag: "continuity" })).some((item) => item.meta.id === id), false);
		await rm(store, { recursive: true, force: true });
	});

	it("treats a leading-whitespace header opener that never closes as unread, like parseFrontmatter", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-leading-open-"));
		await chmod(store, 0o700);
		const id = "20260726T173000Z-leading-open";
		await writeFile(join(store, `${id}.md`), '  ---\nstate: "active"\n\n# body\n', "utf8");
		// The local parser opens on the trimmed line, so this header is open but
		// never closes: the state is UNKNOWN, never open.
		const all = await listStashes(store, { limit: 50 });
		const entry = all.find((item) => item.meta.id === id);
		assert.ok(entry);
		assert.ok(entry?.previewError);
		assert.equal((await listStashes(store, { state: "open" })).some((item) => item.meta.id === id), false);
		await rm(store, { recursive: true, force: true });
	});

	it("surfaces an explicit unrecognized state as invalid in listings", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-invalid-list-"));
		await chmod(store, 0o700);
		const id = "20260726T180000Z-invalid-list";
		await writeFile(join(store, `${id}.md`), '---\nstate: "mystery"\n---\nbody\n', "utf8");
		const all = await listStashes(store, { limit: 50 });
		const entry = all.find((item) => item.meta.id === id);
		assert.ok(entry);
		assert.equal(entry.meta.invalidState, "mystery");
		assert.equal(entry.meta.state, "open", "the defaulted fallback must stay distinguishable");
		assert.equal(entry.previewError, undefined);
		assert.equal((await listStashes(store, { state: "open" })).some((item) => item.meta.id === id), false);
		await assert.rejects(rotateStash(store, id), /invalid lifecycle state/);
		await rm(store, { recursive: true, force: true });
	});
});

describe("rotateStash", () => {
	it("moves an open artifact into the dot-hidden archive with identical content", async () => {
		const { record, path } = await writeStash(
			dir,
			{ title: "Rotation target", summary: "rotate me", decisions: ["keep this"] },
			at("2026-07-25T10:00:00Z"),
		);
		const original = await readFile(path, "utf8");
		const rotated = await rotateStash(dir, record.id);
		assert.equal(rotated.id, record.id);
		assert.equal(rotated.state, "open");
		assert.ok(rotated.archivePath.endsWith(join(".trash", `${record.id}.md`)));

		const entries = await listStashes(dir, { limit: 50 });
		assert.equal(entries.some((entry) => entry.meta.id === record.id), false, "rotated artifacts must not be listed");
		const archived = await readFile(rotated.archivePath, "utf8");
		assert.equal(archived, original, "content must be preserved byte-for-byte");
		assert.equal((await stat(join(dir, ".trash"))).mode & 0o777, 0o700);
		assert.equal((await stat(rotated.archivePath)).mode & 0o777, 0o600);
	});

	it("rotates a closed artifact and records its state", async () => {
		const { record } = await writeStash(dir, { title: "Closed rotation", summary: "done" }, at("2026-07-25T10:10:00Z"));
		await transitionStash(dir, record.id, { action: "activate" });
		await transitionStash(dir, record.id, { action: "close", outcome: "landed" });
		const rotated = await rotateStash(dir, record.id);
		assert.equal(rotated.state, "closed");
		assert.equal((await readStash(dir, record.id)).ok, false);
	});

	it("refuses to rotate an active artifact owned by a live session", async () => {
		const { record } = await writeStash(dir, { title: "Active rotation", summary: "in flight" }, at("2026-07-25T10:20:00Z"));
		await transitionStash(dir, record.id, { action: "activate" });
		await assert.rejects(rotateStash(dir, record.id), /is active; complete it before rotation/);
		assert.equal((await readStash(dir, record.id)).ok, true, "the artifact must remain in the store");
	});

	it("reports unknown and ambiguous targets like other lifecycle changes", async () => {
		await assert.rejects(rotateStash(dir, "does-not-exist"), /no stash matches/);
		await writeStash(dir, { title: "Ambiguity Alpha", summary: "a" }, at("2026-07-25T10:30:00Z"));
		await writeStash(dir, { title: "Ambiguity Alpha Two", summary: "b" }, at("2026-07-25T10:31:00Z"));
		await assert.rejects(rotateStash(dir, "20260725T10"), /ambiguous/);
	});

	it("defines a second rotation as a miss and refuses to replace an existing archive", async () => {
		const { record } = await writeStash(dir, { title: "Twice rotation", summary: "once" }, at("2026-07-25T10:40:00Z"));
		await rotateStash(dir, record.id);
		await assert.rejects(rotateStash(dir, record.id), /no stash matches/);

		const other = await writeStash(dir, { title: "Colliding rotation", summary: "original" }, at("2026-07-25T10:41:00Z"));
		await mkdir(join(dir, ".trash"), { recursive: true });
		await writeFile(join(dir, ".trash", `${other.record.id}.md`), "older archive");
		await assert.rejects(rotateStash(dir, other.record.id), /already rotated/);
	});
});
