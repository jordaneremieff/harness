import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs, { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { editStash, MAX_STASH_BYTES, readStash, transitionStash, writeStash } from "./store.ts";

let root: string;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "stash-edit-store-"));
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

async function fixture(name: string, summary = "First anchor. Second anchor.") {
	const dir = join(root, name);
	const written = await writeStash(dir, { title: "Retained title", summary });
	const read = await readStash(dir, written.record.id);
	assert.ok(read.ok);
	return { dir, ...read };
}
const replacement = [{ oldText: "First anchor.", newText: "Updated anchor." }];
const sha = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

async function assertClean(dir: string) {
	assert.deepEqual(
		(await readdir(dir)).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp")),
		[],
	);
}

describe("exact stash body edits", () => {
	it("returns the raw-byte digest and preserves frontmatter, title, and source bytes", async () => {
		const source = await fixture("byte-preservation");
		const original = source.content
			.replace('state: "open"', 'custom : {"keep": true}\nstate: "open"')
			.replace(/\n/g, "\r\n");
		await writeFile(source.path, original);
		const read = await readStash(source.dir, source.id);
		assert.ok(read.ok);
		assert.equal(read.digest, sha(await readFile(source.path)));
		const edited = await editStash(source.dir, source.id.slice(0, -2), {
			expectedDigest: read.digest,
			edits: [
				{ oldText: "Second anchor.", newText: "First anchor." },
				{ oldText: "First anchor.", newText: "Updated anchor." },
			],
		});
		assert.equal(edited.id, source.id);
		assert.equal(edited.changed, true);
		assert.equal(edited.content, original.replace("First anchor. Second anchor.", "Updated anchor. First anchor."));
		assert.equal(edited.digest, sha(await readFile(source.path)));
		assert.equal(edited.meta.state, "open");
		assert.equal(edited.meta.title, "Retained title");
		assert.equal((await stat(source.path)).mode & 0o777, 0o600);
		await assertClean(source.dir);
	});

	it("supports amendment at a retained anchor and empty replacement deletion", async () => {
		const source = await fixture("append-delete");
		const edited = await editStash(source.dir, source.id, {
			expectedDigest: source.digest,
			edits: [
				{ oldText: "First anchor.", newText: "First anchor. New information." },
				{ oldText: " Second anchor.", newText: "" },
			],
		});
		assert.match(edited.content, /First anchor\. New information\./);
		assert.doesNotMatch(edited.content, /Second anchor/);
	});

	it("retains the inode and digest for an exact no-op", async () => {
		const source = await fixture("no-op");
		const before = await stat(source.path);
		const edited = await editStash(source.dir, source.id, {
			expectedDigest: source.digest,
			edits: [{ oldText: "First anchor.", newText: "First anchor." }],
		});
		assert.equal(edited.changed, false);
		assert.equal(edited.digest, source.digest);
		assert.equal((await stat(source.path)).ino, before.ino);
		await assertClean(source.dir);
	});

	for (const [name, edits, error] of [
		["missing", [{ oldText: "Missing anchor", newText: "change" }], /does not match/],
		["duplicate", [{ oldText: "anchor.", newText: "change" }], /more than once/],
		[
			"overlap",
			[
				{ oldText: "First anchor.", newText: "change" },
				{ oldText: "First", newText: "change" },
			],
			/overlap/,
		],
		["header", [{ oldText: 'state: "open"', newText: 'state: "closed"' }], /does not match/],
		["title", [{ oldText: "# Retained title", newText: "# Renamed title" }], /preserve the body title/],
		["removed-title", [{ oldText: "# Retained title", newText: "" }], /preserve the body title/],
		[
			"hidden-title",
			[{ oldText: "# Retained title", newText: "preamble\n# Retained title" }],
			/preserve the body title/,
		],
	] as const) {
		it(`refuses ${name} edits without publication`, async () => {
			const source = await fixture(name);
			await assert.rejects(
				editStash(source.dir, source.id, { expectedDigest: source.digest, edits: [...edits] }),
				error,
			);
			assert.equal(await readFile(source.path, "utf8"), source.content);
			await assertClean(source.dir);
		});
	}

	it("detects overlapping occurrences of the same anchor", async () => {
		const source = await fixture("overlapping-occurrences", "aaa");
		await assert.rejects(
			editStash(source.dir, source.id, {
				expectedDigest: source.digest,
				edits: [{ oldText: "aa", newText: "b" }],
			}),
			/more than once/,
		);
	});

	it("redacts new credential-shaped content", async () => {
		const source = await fixture("redaction");
		const edited = await editStash(source.dir, source.id, {
			expectedDigest: source.digest,
			edits: [{ oldText: "First anchor.", newText: "token: sk-ant-oat01-abcdefghijklmnopqrstuvwxyz123456" }],
		});
		assert.match(edited.content, /\[REDACTED\]/);
		assert.doesNotMatch(edited.content, /sk-ant-oat01-/);
		assert.equal(edited.redactions.count, 1);
		assert.deepEqual(edited.redactions.classes, { "provider token": 1 });
		assert.match(edited.redactions.contexts[0], /edits\[0\]: token: \[REDACTED\]/);
		assert.ok(!JSON.stringify(edited.redactions).includes("sk-ant-oat01-"));
	});

	it("refuses oversized UTF-8 output without an artifact rewrite", async () => {
		const source = await fixture("oversized-output");
		await assert.rejects(
			editStash(source.dir, source.id, {
				expectedDigest: source.digest,
				edits: [{ oldText: "First anchor.", newText: "界".repeat(100_000) }],
			}),
			new RegExp(`maximum is ${MAX_STASH_BYTES}`),
		);
		assert.equal(await readFile(source.path, "utf8"), source.content);
		await assertClean(source.dir);
	});

	it("refuses malformed digest, empty edits, and ill-formed Unicode", async () => {
		const source = await fixture("input-validation");
		await assert.rejects(editStash(source.dir, source.id, { expectedDigest: "bad", edits: replacement }), /SHA-256/);
		await assert.rejects(editStash(source.dir, source.id, { expectedDigest: source.digest, edits: [] }), /1 to 32/);
		await assert.rejects(
			editStash(source.dir, source.id, {
				expectedDigest: source.digest,
				edits: [{ oldText: "", newText: "x" }],
			}),
			/nonempty oldText/,
		);
		await assert.rejects(
			editStash(source.dir, source.id, {
				expectedDigest: source.digest,
				edits: [{ oldText: "First anchor.", newText: "\ud800" }],
			}),
			/unpaired Unicode/,
		);
		assert.equal(await readFile(source.path, "utf8"), source.content);
	});
});

describe("revision and lifecycle edit gates", () => {
	it("refuses a stale whole-artifact digest after body and lifecycle updates", async () => {
		const source = await fixture("stale-body");
		const edited = await editStash(source.dir, source.id, { expectedDigest: source.digest, edits: replacement });
		await assert.rejects(
			editStash(source.dir, source.id, { expectedDigest: source.digest, edits: replacement }),
			/revision conflict/,
		);
		await transitionStash(source.dir, source.id, { action: "activate" });
		await assert.rejects(
			editStash(source.dir, source.id, {
				expectedDigest: edited.digest,
				edits: [{ oldText: "Updated anchor.", newText: "next" }],
				allowActive: true,
			}),
			/revision conflict/,
		);
	});

	it("requires active acknowledgement and preserves activation metadata", async () => {
		const source = await fixture("active-gate");
		const active = await transitionStash(source.dir, source.id, { action: "activate" });
		await assert.rejects(
			editStash(source.dir, source.id, { expectedDigest: sha(active.content), edits: replacement }),
			/allowActive: true/,
		);
		const edited = await editStash(source.dir, source.id, {
			expectedDigest: sha(active.content),
			edits: replacement,
			allowActive: true,
		});
		assert.equal(edited.meta.state, "active");
		assert.equal(edited.meta.activatedAt, active.meta.activatedAt);
		assert.equal(edited.content.split("---")[1], active.content.split("---")[1]);
	});

	it("refuses closed edits, retains the outcome, and requires a read after reopen", async () => {
		const source = await fixture("closed-gate");
		const closed = await transitionStash(source.dir, source.id, { action: "close", outcome: "Done." });
		await assert.rejects(
			editStash(source.dir, source.id, {
				expectedDigest: sha(closed.content),
				edits: replacement,
				allowActive: true,
			}),
			/deliberately reopen/,
		);
		assert.equal(await readFile(source.path, "utf8"), closed.content);
		const reopened = await transitionStash(source.dir, source.id, { action: "reopen" });
		await assert.rejects(
			editStash(source.dir, source.id, { expectedDigest: sha(closed.content), edits: replacement }),
			/revision conflict/,
		);
		const edited = await editStash(source.dir, source.id, {
			expectedDigest: sha(reopened.content),
			edits: replacement,
		});
		assert.equal(edited.meta.state, "open");
	});

	it("refuses unknown lifecycle state and unclosed headers", async () => {
		const source = await fixture("unknown-state");
		for (const content of [source.content.replace('state: "open"', 'state: "unknown"'), '---\nstate: "open"\nbody\n']) {
			await writeFile(source.path, content);
			await assert.rejects(
				editStash(source.dir, source.id, { expectedDigest: sha(content), edits: replacement }),
				/invalid lifecycle state/,
			);
			assert.equal(await readFile(source.path, "utf8"), content);
		}
	});
});

describe("publication, cancellation, and read consistency", () => {
	it("rejects invalid UTF-8 without silently replacing bytes", async () => {
		const source = await fixture("invalid-utf8");
		const bytes = Buffer.concat([Buffer.from(source.content), Buffer.from([0xff])]);
		await writeFile(source.path, bytes);
		await assert.rejects(
			editStash(source.dir, source.id, { expectedDigest: sha(bytes), edits: replacement }),
			/invalid UTF-8/,
		);
		const read = await readStash(source.dir, source.id);
		assert.equal(read.ok, false);
		if (!read.ok) assert.match(read.error, /invalid UTF-8/);
		assert.deepEqual(await readFile(source.path), bytes);
		await assertClean(source.dir);
	});

	it("preserves a UTF-8 byte order mark and raw-byte digest", async () => {
		const source = await fixture("bom");
		const content = `\ufeff${source.content}`;
		await writeFile(source.path, content);
		const read = await readStash(source.dir, source.id);
		assert.ok(read.ok);
		assert.equal(read.content, content);
		assert.equal(read.digest, sha(content));
		const edited = await editStash(source.dir, source.id, { expectedDigest: read.digest, edits: replacement });
		assert.ok(edited.content.startsWith("\ufeff"));
	});

	it("refuses same-size in-place changes during a source read", async (t) => {
		const source = await fixture("changed-during-read");
		const realOpen = fs.open;
		let changed = false;
		const mocked = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
			const handle = await realOpen(...args);
			if (args[0] === source.path && !changed) {
				const realRead = handle.read.bind(handle);
				handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
					const result = await realRead(...readArgs);
					if (!changed) {
						changed = true;
						await writeFile(source.path, source.content.replace("First", "Other"));
					}
					return result;
				}) as typeof handle.read;
			}
			return handle;
		});
		syncBuiltinESMExports();
		t.after(() => {
			mocked.mock.restore();
			syncBuiltinESMExports();
		});
		await assert.rejects(
			editStash(source.dir, source.id, { expectedDigest: source.digest, edits: replacement }),
			/changed while it was being read/,
		);
		assert.equal(changed, true);
		assert.equal(await readFile(source.path, "utf8"), source.content.replace("First", "Other"));
		await assertClean(source.dir);
	});

	for (const mode of ["abort", "rename-failure", "external-edit"] as const) {
		it(`keeps the source intact through ${mode} before publication`, async (t) => {
			const source = await fixture(mode);
			const controller = new AbortController();
			const realWrite = fs.writeFile;
			const realRename = fs.rename;
			const writeMock = mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
				await realWrite(...args);
				if (String(args[0]).endsWith(".tmp")) {
					if (mode === "abort") controller.abort();
					if (mode === "external-edit") await realWrite(source.path, source.content.replace("First", "Other"));
				}
			});
			const renameMock = mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
				if (mode === "rename-failure" && args[1] === source.path) throw new Error("publication denied");
				return realRename(...args);
			});
			syncBuiltinESMExports();
			t.after(() => {
				writeMock.mock.restore();
				renameMock.mock.restore();
				syncBuiltinESMExports();
			});
			await assert.rejects(
				editStash(source.dir, source.id, { expectedDigest: source.digest, edits: replacement }, controller.signal),
				mode === "abort"
					? /cancelled/
					: mode === "rename-failure"
						? /publication denied/
						: /changed before revision publication/,
			);
			assert.equal(
				await readFile(source.path, "utf8"),
				mode === "external-edit" ? source.content.replace("First", "Other") : source.content,
			);
			await assertClean(source.dir);
		});
	}

	it("reports completed publication and retains a lock after cleanup failure", async (t) => {
		const source = await fixture("lock-cleanup-failure");
		const realUnlink = fs.unlink;
		const lockPath = join(source.dir, `.${source.id}.lock`);
		const mocked = mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
			if (args[0] === lockPath) throw new Error("lock removal denied");
			return realUnlink(...args);
		});
		syncBuiltinESMExports();
		t.after(() => {
			mocked.mock.restore();
			syncBuiltinESMExports();
		});
		await assert.rejects(
			editStash(source.dir, source.id, { expectedDigest: source.digest, edits: replacement }),
			/mutation completed, but lock cleanup failed/,
		);
		assert.equal(await readFile(source.path, "utf8"), source.content.replace("First anchor.", "Updated anchor."));
		assert.ok((await stat(lockPath)).isFile());
		mocked.mock.restore();
		syncBuiltinESMExports();
		await realUnlink(lockPath);
	});

	it("retains a replacement lock instead of removing a foreign inode", async (t) => {
		const source = await fixture("replacement-lock");
		const realRename = fs.rename;
		const lockPath = join(source.dir, `.${source.id}.lock`);
		const foreign = join(source.dir, ".foreign-lock");
		await writeFile(foreign, "foreign lock");
		const mocked = mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
			await realRename(...args);
			if (args[1] === source.path) await realRename(foreign, lockPath);
		});
		syncBuiltinESMExports();
		t.after(() => {
			mocked.mock.restore();
			syncBuiltinESMExports();
		});
		await assert.rejects(
			editStash(source.dir, source.id, { expectedDigest: source.digest, edits: replacement }),
			/mutation completed.*lock was replaced/,
		);
		assert.equal(await readFile(lockPath, "utf8"), "foreign lock");
		assert.match(await readFile(source.path, "utf8"), /Updated anchor/);
	});

	it("does not remove a temporary name it did not create", async (t) => {
		const source = await fixture("revision-temporary-collision");
		const realWrite = fs.writeFile;
		let temporary = "";
		const mocked = mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
			if (String(args[0]).endsWith(".tmp")) {
				temporary = String(args[0]);
				await realWrite(temporary, "foreign temporary", { flag: "wx", mode: 0o600 });
			}
			return realWrite(...args);
		});
		syncBuiltinESMExports();
		t.after(() => {
			mocked.mock.restore();
			syncBuiltinESMExports();
		});
		await assert.rejects(editStash(source.dir, source.id, { expectedDigest: source.digest, edits: replacement }), {
			code: "EEXIST",
		});
		assert.equal(await readFile(temporary, "utf8"), "foreign temporary");
		assert.equal(await readFile(source.path, "utf8"), source.content);
		assert.equal(
			(await readdir(source.dir)).some((name) => name.endsWith(".lock")),
			false,
		);
	});

	it("refuses an already-aborted call before creating a lock", async () => {
		const source = await fixture("already-aborted");
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			editStash(source.dir, source.id, { expectedDigest: source.digest, edits: replacement }, controller.signal),
			/cancelled/,
		);
		await assertClean(source.dir);
	});
});

const holderSource = `
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
const [url, dir, id, digest, action, stage = "lock"] = process.argv.slice(1);
const { editStash, rotateStash, transitionStash } = await import(url);
const pause = async () => { process.send("locked"); await once(process, "message"); };
const open = fs.open;
fs.open = async (...args) => {
  const handle = await open(...args);
  if (stage === "lock" && String(args[0]).endsWith(".lock") && args[1] === "wx") await pause();
  return handle;
};
const rename = fs.rename;
fs.rename = async (...args) => {
  if (stage === "publication" && args[1] === dir + "/" + id + ".md") await pause();
  return rename(...args);
};
const unlink = fs.unlink;
fs.unlink = async (...args) => {
  if (stage === "publication" && args[0] === dir + "/" + id + ".md") await pause();
  return unlink(...args);
};
syncBuiltinESMExports();
if (action === "edit") await editStash(dir,id,{expectedDigest:digest,edits:[{oldText:"First anchor.",newText:"Updated anchor."}]});
else if (action === "rotate") await rotateStash(dir,id);
else await transitionStash(dir,id,action === "close" ? {action,outcome:"Done."} : {action});
process.disconnect();
`;

const contenderSource = `
import assert from "node:assert/strict";
const [url,dir,id,digest] = process.argv.slice(1);
const { editStash, rotateStash, transitionStash } = await import(url);
for (const call of [
  () => editStash(dir,id,{expectedDigest:digest,edits:[{oldText:"First anchor.",newText:"Other anchor."}]}),
  () => transitionStash(dir,id,{action:"activate"}),
  () => transitionStash(dir,id,{action:"close",outcome:"Other outcome."}),
  () => rotateStash(dir,id),
]) await assert.rejects(call(), /is busy; mutation lock exists/);
console.log("all-contenders-refused");
`;

describe("cross-process artifact exclusion", () => {
	const scenarios = [
		...["edit", "activate", "close", "release", "reopen", "rotate"].map((action) => ({ action, stage: "lock" })),
		{ action: "edit", stage: "publication" },
		{ action: "rotate", stage: "publication" },
	];
	for (const { action, stage } of scenarios) {
		it(`excludes independent mutations while ${action} holds the lock at ${stage}`, {
			timeout: 8000,
		}, async (t) => {
			const source = await fixture(`lock-${action}-${stage}`);
			if (action === "release") await transitionStash(source.dir, source.id, { action: "activate" });
			if (action === "reopen") await transitionStash(source.dir, source.id, { action: "close", outcome: "Done." });
			const original = await readFile(source.path, "utf8");
			const holder = spawn(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					holderSource,
					new URL("./store.ts", import.meta.url).href,
					source.dir,
					source.id,
					sha(original),
					action,
					stage,
				],
				{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
			);
			let stderr = "";
			holder.stderr?.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk).slice(-8192);
			});
			const exited = once(holder, "exit");
			t.after(() => {
				if (holder.exitCode === null) holder.kill("SIGKILL");
			});
			const ready = await Promise.race([
				once(holder, "message"),
				exited.then(() => {
					throw new Error(stderr || "holder exited before lock");
				}),
			]);
			assert.equal(ready[0], "locked");
			const lock = join(source.dir, `.${source.id}.lock`);
			assert.equal((await stat(lock)).mode & 0o777, 0o600);
			const contender = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					contenderSource,
					new URL("./store.ts", import.meta.url).href,
					source.dir,
					source.id,
					sha(original),
				],
				{ encoding: "utf8", timeout: 3000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 },
			);
			assert.equal(contender.status, 0, contender.stderr);
			assert.match(contender.stdout, /all-contenders-refused/);
			assert.equal(await readFile(source.path, "utf8"), original);
			holder.send("release");
			const [code] = await exited;
			assert.equal(code, 0, stderr);
			if (action === "rotate") {
				assert.equal((await readStash(source.dir, source.id)).ok, false);
				assert.equal(await readFile(join(source.dir, ".trash", `${source.id}.md`), "utf8"), original);
			} else {
				await assert.rejects(
					editStash(source.dir, source.id, { expectedDigest: sha(original), edits: replacement, allowActive: true }),
					/revision conflict/,
				);
			}
			await assertClean(source.dir);
		});
	}

	it("retains a crash lock and never reclaims it automatically", { timeout: 8000 }, async (t) => {
		const source = await fixture("crash-lock");
		const holder = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				holderSource,
				new URL("./store.ts", import.meta.url).href,
				source.dir,
				source.id,
				source.digest,
				"edit",
			],
			{ stdio: ["ignore", "ignore", "ignore", "ipc"] },
		);
		const exited = once(holder, "exit");
		t.after(() => {
			if (holder.exitCode === null) holder.kill("SIGKILL");
		});
		assert.equal((await Promise.race([once(holder, "message"), exited]))[0], "locked");
		holder.kill("SIGKILL");
		await exited;
		await assert.rejects(
			editStash(source.dir, source.id, { expectedDigest: source.digest, edits: replacement }),
			/remove this exact lock only after confirming/,
		);
		assert.equal(await readFile(source.path, "utf8"), source.content);
		await fs.unlink(join(source.dir, `.${source.id}.lock`));
		assert.equal(
			(await editStash(source.dir, source.id, { expectedDigest: source.digest, edits: replacement })).changed,
			true,
		);
	});
});
