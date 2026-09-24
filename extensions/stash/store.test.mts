import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { parseFrontmatter } from "./format.ts";
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
		assert.deepEqual(writes.map((result) => result.record.id).sort(), [
			"20260724T103000Z-collision",
			"20260724T103000Z-collision-2",
		]);
		assert.deepEqual(
			(await Promise.all(writes.map((result) => readFile(result.path, "utf8"))))
				.map((body) => (body.includes("first body") ? "first" : "second"))
				.sort(),
			["first", "second"],
		);
	});

	it("hardens an existing store and its artifacts when discovered", async () => {
		const store = join(dir, "permission-store");
		await mkdir(store, { mode: 0o755 });
		await chmod(store, 0o755);
		const path = join(store, "20260724T103500Z-permissions.md");
		await writeFile(path, '---\nstate: "open"\n---\nbody\n', { mode: 0o644 });
		await chmod(path, 0o644);

		assert.equal((await listStashes(store)).length, 1);
		assert.equal((await stat(store)).mode & 0o777, 0o700);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	});

	it("lists newest-first and respects limit", async () => {
		await writeStash(dir, { title: "Second", summary: "s2" }, at("2026-07-24T11:00:00Z"));
		await writeStash(dir, { title: "Third", summary: "s3" }, at("2026-07-24T12:00:00Z"));
		const all = await listStashes(dir, { limit: 10 });
		assert.deepEqual(
			all.slice(0, 2).map((e) => e.meta.title),
			["Third", "Second"],
		);
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
		await writeFile(
			join(dir, "20260724T140000Z-corrupt.md"),
			'---\nid: "different-id"\ntitle: [broken\n---\nbody\n',
			"utf8",
		);
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
		const artifact = `---\ntitle: "Multibyte"\nstate: "open"\n---\n${"é".repeat(17_000)}`;
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

describe("artifact replaced by a FIFO after discovery", () => {
	for (const operation of ["harden", "list", "read", "rotate", "transition"]) {
		it(`refuses a writerless FIFO without blocking during ${operation}`, { skip: process.platform === "win32" }, () => {
			const child = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`
					import assert from "node:assert/strict";
					import { execFileSync } from "node:child_process";
					import fs from "node:fs/promises";
					import { syncBuiltinESMExports } from "node:module";
					import { join } from "node:path";
					import { mock } from "node:test";
					const [moduleUrl, store, operation] = process.argv.slice(1);
					const { listStashes, readStash, rotateStash, transitionStash, writeStash } = await import(moduleUrl);
					await fs.mkdir(store);
					let id = "fifo-target";
					let path = join(store, id + ".md");
					if (operation === "harden") {
						await fs.writeFile(path, '---\\nstate: "open"\\n---\\nbody\\n');
					} else {
						const written = await writeStash(store, { title: "FIFO target", summary: "original" });
						id = written.record.id;
						path = written.path;
					}
					const originalOpen = fs.open;
					let replaced = false;
					mock.method(fs, "open", async (...args) => {
						if (args[0] === path && !replaced) {
							await fs.unlink(path);
							execFileSync("mkfifo", [path], { timeout: 1000, maxBuffer: 8192 });
							replaced = true;
							console.log("fifo-installed");
						}
						return originalOpen(...args);
					});
					syncBuiltinESMExports();
					if (operation === "list") {
						const [entry] = await listStashes(store);
						assert.equal(entry.meta.state, "unknown");
						assert.match(entry.previewError, /not a regular file/);
					} else if (operation === "read") {
						const result = await readStash(store, id);
						assert.equal(result.ok, false);
						assert.match(result.error, /not a regular file/);
					} else {
						const action = operation === "harden" ? listStashes(store)
							: operation === "rotate" ? rotateStash(store, id)
							: transitionStash(store, id, { action: "activate" });
						await assert.rejects(action, /not a regular file/);
					}
					assert.equal(replaced, true);
					assert.equal((await fs.lstat(path)).isFIFO(), true);
					console.log("fifo-refused");
					`,
					new URL("./store.ts", import.meta.url).href,
					join(dir, `fifo-${operation}`),
					operation,
				],
				{ encoding: "utf8", timeout: 3000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 },
			);
			assert.match(child.stdout, /fifo-installed/);
			assert.equal(child.error?.message, undefined, child.stderr);
			assert.equal(child.status, 0, child.stderr);
			assert.match(child.stdout, /fifo-refused/);
		});
	}
});

describe("stash lifecycle transitions", () => {
	it("closes open artifacts without activation and preserves their body and unknown metadata", async () => {
		const store = join(dir, "open-completion-store");
		const { record, path } = await writeStash(store, { title: "Open completion", summary: "Retain this body." });
		const original = (await readFile(path, "utf8")).replace('state: "open"', 'custom: {"keep":true}\nstate: "open"');
		await writeFile(path, original);
		const closed = await transitionStash(
			store,
			record.id,
			{ action: "close", outcome: "  Completed after direct retrieval.  " },
			at("2026-07-26T12:00:00Z"),
		);
		assert.equal(closed.changed, true);
		assert.equal(closed.meta.state, "closed");
		assert.equal(closed.meta.closedAt, "20260726T120000Z");
		assert.equal(closed.meta.outcome, "Completed after direct retrieval.");
		assert.equal(closed.meta.activatedAt, undefined);
		assert.match(closed.content, /^custom: \{"keep":true\}$/m);
		assert.equal(parseFrontmatter(closed.content).body, parseFrontmatter(original).body);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		await assert.rejects(
			transitionStash(store, record.id, { action: "close", outcome: "Replace the outcome." }),
			/already closed; use stash_read.*first use \/stash reopen/,
		);
		assert.equal(await readFile(path, "utf8"), closed.content);
	});

	for (const state of ["open", "active"] as const) {
		it(`rejects invalid outcomes without changing an ${state} artifact`, async () => {
			const store = join(dir, `invalid-outcome-${state}`);
			const { record, path } = await writeStash(store, { title: "Outcome required", summary: "Retain this." });
			if (state === "active") await transitionStash(store, record.id, { action: "activate" });
			const before = await readFile(path, "utf8");
			await assert.rejects(
				transitionStash(store, record.id, { action: "close", outcome: " \n\t " }),
				/outcome must not be empty; supply a concrete terminal outcome/,
			);
			await assert.rejects(
				transitionStash(store, record.id, { action: "close", outcome: "x".repeat(20_001) }),
				/exceeds 20000 characters; shorten the outcome and retry/,
			);
			assert.equal(await readFile(path, "utf8"), before);
		});
	}

	it("moves open to active to closed, requires an outcome, and deliberately reopens", async () => {
		const lifecycleDir = join(dir, "lifecycle-store");
		const { record, path } = await writeStash(
			lifecycleDir,
			{ title: "Lifecycle", summary: "stateful handover" },
			at("2026-07-26T10:00:00Z"),
		);
		assert.equal(record.state, "open");
		await writeFile(
			path,
			(await readFile(path, "utf8")).replace('state: "open"', 'custom: {"keep":true}\nstate: "open"'),
			"utf8",
		);

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

	it("releases an active stash back to pristine open and refuses other states", async () => {
		const lifecycleDir = join(dir, "release-store");
		const { record, path } = await writeStash(
			lifecycleDir,
			{ title: "Release", summary: "dead-session handover" },
			at("2026-08-13T09:00:00Z"),
		);
		await writeFile(
			path,
			(await readFile(path, "utf8")).replace('state: "open"', 'custom: {"keep":true}\nstate: "open"'),
			"utf8",
		);

		await assert.rejects(transitionStash(lifecycleDir, record.id, { action: "release" }), /released only from active/i);

		await transitionStash(lifecycleDir, record.id, { action: "activate" }, at("2026-08-13T10:00:00Z"));
		const released = await transitionStash(lifecycleDir, record.id, { action: "release" }, at("2026-08-13T11:00:00Z"));
		assert.equal(released.meta.state, "open");
		assert.equal(released.meta.activatedAt, undefined);
		assert.equal(released.meta.closedAt, undefined);
		assert.equal(released.meta.outcome, undefined);
		assert.doesNotMatch(released.content, /^activatedAt:/m);
		assert.match(released.content, /^custom: \{"keep":true\}$/m);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await listStashes(lifecycleDir, { state: "open" }))[0].meta.id, record.id);
		assert.equal((await listStashes(lifecycleDir, { state: "active" })).length, 0);

		await assert.rejects(transitionStash(lifecycleDir, record.id, { action: "release" }), /released only from active/i);
		await transitionStash(lifecycleDir, record.id, { action: "activate" }, at("2026-08-13T12:00:00Z"));
		await transitionStash(lifecycleDir, record.id, { action: "close", outcome: "Done." }, at("2026-08-13T13:00:00Z"));
		await assert.rejects(transitionStash(lifecycleDir, record.id, { action: "release" }), /released only from active/i);
	});

	it("rejects missing lifecycle state without synthesizing an open artifact", async () => {
		const store = join(dir, "missing-state-store");
		await mkdir(store);
		const id = "20260726T130000Z-missing-state";
		const path = join(store, `${id}.md`);
		const content = '---\ntitle: "Missing state"\n---\nbody\n';
		await writeFile(path, content, "utf8");
		const [entry] = await listStashes(store);
		assert.equal(entry.meta.state, "unknown");
		assert.equal(entry.meta.invalidState, "missing");
		assert.deepEqual(await listStashes(store, { state: "open" }), []);
		await assert.rejects(transitionStash(store, id, { action: "activate" }), /invalid lifecycle state/);
		await assert.rejects(
			transitionStash(store, id, { action: "close", outcome: "Done." }),
			/invalid lifecycle state.*repair its JSON-encoded state/,
		);
		await assert.rejects(rotateStash(store, id), /invalid lifecycle state/);
		assert.equal(await readFile(path, "utf8"), content);
	});

	it("rejects corrupt explicit lifecycle state instead of silently rewriting it", async () => {
		const lifecycleDir = join(dir, "invalid-lifecycle-store");
		await mkdir(lifecycleDir);
		const id = "20260726T140000Z-invalid-state";
		await writeFile(join(lifecycleDir, `${id}.md`), '---\nstate: "mystery"\n---\nbody\n', "utf8");
		await assert.rejects(transitionStash(lifecycleDir, id, { action: "activate" }), /invalid lifecycle state/i);
		await assert.rejects(
			transitionStash(lifecycleDir, id, { action: "close", outcome: "Done." }),
			/invalid lifecycle state.*repair its JSON-encoded state/,
		);
	});

	it("redacts credential-shaped completion outcomes before they are stored", async () => {
		const lifecycleDir = join(dir, "outcome-redact-store");
		await mkdir(lifecycleDir);
		const secret = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz123456";
		const { record } = await writeStash(
			lifecycleDir,
			{ title: "Outcome redaction", summary: "s" },
			at("2026-07-26T14:30:00Z"),
		);
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
		assert.equal(
			open.some((entry) => entry.meta.id === id),
			false,
		);
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
		assert.equal(entry?.meta.state, "unknown");
		// No state filter may satisfy it.
		assert.equal(
			(await listStashes(store, { state: "open" })).some((item) => item.meta.id === id),
			false,
		);
		assert.equal(
			(await listStashes(store, { state: "active" })).some((item) => item.meta.id === id),
			false,
		);
		// Rotation and every lifecycle transition refuse it, leaving the bytes intact.
		const before = await readFile(path, "utf8");
		await assert.rejects(rotateStash(store, id), /state cannot be verified/);
		await assert.rejects(transitionStash(store, id, { action: "activate" }), /state cannot be verified/);
		assert.ok((await stat(path)).isFile(), "the artifact must stay in place");
		assert.equal(await readFile(path, "utf8"), before, "a refused transition must not rewrite the artifact");
		await rm(store, { recursive: true, force: true });
	});

	it("keeps headerless files visible as unknown and refuses lifecycle changes", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-missing-header-"));
		const id = "20260726T160000Z-missing-header";
		const path = join(store, `${id}.md`);
		await writeFile(path, "# Handover without metadata\n", "utf8");
		const [entry] = await listStashes(store);
		assert.equal(entry.meta.state, "unknown");
		assert.equal(entry.meta.invalidState, "missing");
		assert.deepEqual(await listStashes(store, { state: "open" }), []);
		await assert.rejects(transitionStash(store, id, { action: "activate" }), /invalid lifecycle state/);
		await assert.rejects(rotateStash(store, id), /invalid lifecycle state/);
		assert.equal(await readFile(path, "utf8"), "# Handover without metadata\n");
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
		assert.equal(
			(await listStashes(store, { state: "open" })).some((item) => item.meta.id === id),
			false,
		);
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
		await writeFile(
			join(store, `${diffId}.md`),
			'---\nstate: "active"\ntitle: "Live effort"\n\n# body\n--- a/src/foo.ts\n+++ b/src/foo.ts\n',
			"utf8",
		);
		const ruleId = "20260726T191000Z-unclosed-rule";
		await writeFile(join(store, `${ruleId}.md`), '---\nstate: "active"\n\n# body\n----\n', "utf8");
		// Diff headers and markdown rules are ordinary body content: they must not
		// close the frontmatter fence for the guard any more than for the parser.
		for (const id of [diffId, ruleId]) {
			const all = await listStashes(store, { limit: 50 });
			const entry = all.find((item) => item.meta.id === id);
			assert.ok(entry, `${id} must still be listed`);
			assert.ok(entry?.previewError, `${id} must be reported as unread`);
			assert.equal(
				(await listStashes(store, { state: "open" })).some((item) => item.meta.id === id),
				false,
			);
			await assert.rejects(rotateStash(store, id), /state cannot be verified/);
			await assert.rejects(transitionStash(store, id, { action: "activate" }), /state cannot be verified/);
		}
		await rm(store, { recursive: true, force: true });
	});

	it("refuses a raw lifecycle value that is not encoded as JSON", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-nonjson-state-"));
		const id = "20260726T192000Z-nonjson-state";
		await writeFile(join(store, `${id}.md`), "---\nstate: open\n---\nbody\n", "utf8");
		const [entry] = await listStashes(store);
		assert.equal(entry.meta.state, "unknown");
		assert.equal(entry.meta.invalidState, "missing");
		await assert.rejects(rotateStash(store, id), /invalid lifecycle state/);
		await assert.rejects(transitionStash(store, id, { action: "activate" }), /invalid lifecycle state/);
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
		assert.equal(
			(await listStashes(store, { state: "active" })).some((item) => item.meta.id === id),
			true,
		);
		await rm(store, { recursive: true, force: true });
	});

	it("keeps unreadable artifacts visible unfiltered and excludes them from tag-filtered listings", async () => {
		const store = await mkdtemp(join(tmpdir(), "stash-tag-unread-"));
		await chmod(store, 0o700);
		const id = "20260726T194000Z-tag-unread";
		await writeFile(join(store, `${id}.md`), '---\nstate: "active"\n\n# body\n', "utf8");
		assert.ok((await listStashes(store, { limit: 50 })).some((item) => item.meta.id === id));
		assert.equal(
			(await listStashes(store, { tag: "continuity" })).some((item) => item.meta.id === id),
			false,
		);
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
		assert.equal(
			(await listStashes(store, { state: "open" })).some((item) => item.meta.id === id),
			false,
		);
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
		assert.equal(entry.meta.state, "unknown");
		assert.equal(entry.previewError, undefined);
		assert.equal(
			(await listStashes(store, { state: "open" })).some((item) => item.meta.id === id),
			false,
		);
		await assert.rejects(rotateStash(store, id), /invalid lifecycle state/);
		await rm(store, { recursive: true, force: true });
	});
});

describe("rotateStash", () => {
	it("rejects a symbolic-link archive without changing its target permissions", async () => {
		const store = join(dir, "archive-link-store");
		const outside = join(dir, "archive-link-target");
		const { record, path } = await writeStash(store, { title: "Archive link", summary: "retained" });
		await mkdir(outside, { mode: 0o755 });
		await chmod(outside, 0o755);
		await symlink(outside, join(store, ".trash"));
		await assert.rejects(rotateStash(store, record.id), /archive is not a regular directory/);
		assert.equal((await stat(outside)).mode & 0o777, 0o755);
		assert.ok((await stat(path)).isFile());
	});

	it("rejects a replacement between the header read and the identity check", async (t) => {
		const store = join(dir, "header-identity-store");
		const { record, path } = await writeStash(store, { title: "Header identity", summary: "original" });
		const replacement = join(store, ".replacement");
		const replacementText = '---\nstate: "active"\n---\nreplacement\n';
		await writeFile(replacement, replacementText);
		const originalOpen = fs.open;
		let replaced = false;
		const mocked = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
			const handle = await originalOpen(...args);
			if (args[0] === path && !replaced) {
				const originalClose = handle.close.bind(handle);
				handle.close = async () => {
					await originalClose();
					if (!replaced) {
						replaced = true;
						await rename(replacement, path);
					}
				};
			}
			return handle;
		});
		syncBuiltinESMExports();
		t.after(() => {
			mocked.mock.restore();
			syncBuiltinESMExports();
		});
		await assert.rejects(rotateStash(store, record.id), /target changed before rotation/);
		assert.equal(await readFile(path, "utf8"), replacementText);
	});

	it("rejects a replacement at the source-link boundary without publishing an unverified archive", async (t) => {
		const store = join(dir, "source-link-store");
		const { record, path } = await writeStash(store, { title: "Source link", summary: "original" });
		const archiveDir = join(store, ".trash");
		const replacement = join(store, ".replacement");
		const replacementText = '---\nstate: "open"\n---\nreplacement\n';
		await writeFile(replacement, replacementText, { mode: 0o600 });
		const realLink = fs.link;
		let replaced = false;
		const mocked = mock.method(fs, "link", async (source: string, destination: string) => {
			if (source === path && !replaced) {
				await rename(replacement, path);
				replaced = true;
			}
			return realLink(source, destination);
		});
		syncBuiltinESMExports();
		t.after(() => {
			mocked.mock.restore();
			syncBuiltinESMExports();
		});
		await assert.rejects(rotateStash(store, record.id), /stash target changed/);
		assert.equal(replaced, true);
		assert.equal(await readFile(path, "utf8"), replacementText);
		assert.deepEqual(await readdir(archiveDir), [], "an unverified inode must not occupy the archive name");
		mocked.mock.restore();
		syncBuiltinESMExports();
		const retried = await rotateStash(store, record.id);
		assert.equal(await readFile(retried.archivePath, "utf8"), replacementText);
	});

	it("does not remove a temporary name it failed to create", async (t) => {
		const store = join(dir, "temporary-collision-store");
		const { record, path } = await writeStash(store, { title: "Temporary collision", summary: "original" });
		const original = await readFile(path, "utf8");
		const archivePath = join(store, ".trash", `${record.id}.md`);
		const realLink = fs.link;
		let temporary = "";
		const mocked = mock.method(fs, "link", async (source: string, destination: string) => {
			if (source === path && destination !== archivePath) {
				temporary = destination;
				await writeFile(temporary, "concurrent temporary", { flag: "wx", mode: 0o600 });
			}
			return realLink(source, destination);
		});
		syncBuiltinESMExports();
		t.after(() => {
			mocked.mock.restore();
			syncBuiltinESMExports();
		});
		await assert.rejects(rotateStash(store, record.id), { code: "EEXIST" });
		assert.equal(await readFile(path, "utf8"), original);
		assert.equal(await readFile(temporary, "utf8"), "concurrent temporary");
		await assert.rejects(stat(archivePath), { code: "ENOENT" });
	});

	it("retains the verified archive and a source replaced at final publication", async (t) => {
		const store = join(dir, "final-publication-store");
		const { record, path } = await writeStash(store, { title: "Final publication", summary: "original" });
		const original = await readFile(path, "utf8");
		const archivePath = join(store, ".trash", `${record.id}.md`);
		const replacement = join(store, ".replacement");
		const replacementText = '---\nstate: "active"\n---\nconcurrent pickup\n';
		await writeFile(replacement, replacementText, { mode: 0o600 });
		const realLink = fs.link;
		let replaced = false;
		const mocked = mock.method(fs, "link", async (source: string, destination: string) => {
			if (destination === archivePath) {
				await rename(replacement, path);
				replaced = true;
			}
			return realLink(source, destination);
		});
		syncBuiltinESMExports();
		t.after(() => {
			mocked.mock.restore();
			syncBuiltinESMExports();
		});
		await assert.rejects(rotateStash(store, record.id), /archive retained.*source removal failed/);
		assert.equal(replaced, true);
		assert.equal(await readFile(path, "utf8"), replacementText);
		assert.equal(await readFile(archivePath, "utf8"), original);
		assert.deepEqual(await readdir(join(store, ".trash")), [`${record.id}.md`]);
	});

	it("never deletes an archive replaced after publication", async (t) => {
		const store = join(dir, "archive-replacement-store");
		const { record, path } = await writeStash(store, { title: "Archive replacement", summary: "original" });
		const original = await readFile(path, "utf8");
		const archivePath = join(store, ".trash", `${record.id}.md`);
		const replacement = join(store, ".replacement");
		await writeFile(replacement, "concurrent archive", { mode: 0o600 });
		const realLink = fs.link;
		const mocked = mock.method(fs, "link", async (source: string, destination: string) => {
			await realLink(source, destination);
			if (destination === archivePath) await rename(replacement, archivePath);
		});
		syncBuiltinESMExports();
		t.after(() => {
			mocked.mock.restore();
			syncBuiltinESMExports();
		});
		await assert.rejects(rotateStash(store, record.id), /stash target changed/);
		assert.equal(await readFile(path, "utf8"), original);
		assert.equal(await readFile(archivePath, "utf8"), "concurrent archive");
		assert.deepEqual(await readdir(join(store, ".trash")), [`${record.id}.md`]);
	});

	it("never overwrites a concurrent archive and preserves both files after source-removal failure", async (t) => {
		const store = join(dir, "archive-publication-store");
		const { record, path } = await writeStash(store, { title: "Publication", summary: "retained" });
		const original = await readFile(path, "utf8");
		const archivePath = join(store, ".trash", `${record.id}.md`);
		const realLink = fs.link;
		const linkMock = mock.method(fs, "link", async (source: string, destination: string) => {
			if (destination === archivePath) await writeFile(destination, "concurrent archive", { flag: "wx" });
			return realLink(source, destination);
		});
		syncBuiltinESMExports();
		t.after(() => {
			linkMock.mock.restore();
			syncBuiltinESMExports();
		});
		await assert.rejects(rotateStash(store, record.id), /already rotated/);
		assert.equal(await readFile(archivePath, "utf8"), "concurrent archive");
		assert.equal(await readFile(path, "utf8"), original);
		linkMock.mock.restore();
		syncBuiltinESMExports();
		await rm(archivePath);
		const realUnlink = fs.unlink;
		const unlinkMock = mock.method(fs, "unlink", async (target: string) => {
			if (target === path) throw new Error("source removal denied");
			return realUnlink(target);
		});
		syncBuiltinESMExports();
		t.after(() => {
			unlinkMock.mock.restore();
			syncBuiltinESMExports();
		});
		await assert.rejects(rotateStash(store, record.id), /archive retained.*source removal failed/);
		assert.equal(await readFile(archivePath, "utf8"), original);
		assert.equal(await readFile(path, "utf8"), original);
	});

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
		assert.equal(
			entries.some((entry) => entry.meta.id === record.id),
			false,
			"rotated artifacts must not be listed",
		);
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
		const { record } = await writeStash(
			dir,
			{ title: "Active rotation", summary: "in flight" },
			at("2026-07-25T10:20:00Z"),
		);
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

		const other = await writeStash(
			dir,
			{ title: "Colliding rotation", summary: "original" },
			at("2026-07-25T10:41:00Z"),
		);
		await mkdir(join(dir, ".trash"), { recursive: true });
		await writeFile(join(dir, ".trash", `${other.record.id}.md`), "older archive");
		await assert.rejects(rotateStash(dir, other.record.id), /already rotated/);
	});
});
