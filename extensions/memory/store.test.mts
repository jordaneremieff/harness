import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type MemoryWrite, MemoryWriteError, memoryRoot, sourceDigest, writeMemory } from "./store.ts";

function corpus(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "memory-store-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
function note(slug = "editor-choice"): MemoryWrite {
	return {
		slug,
		title: "Editor choice",
		tags: ["editor", "preference"],
		summary: "Use the plain editor.",
		details: "The operator prefers a small local editor.",
		sources: "- Operator statement.",
		verified: true,
	};
}
function metadata(root: string, slug: string) {
	return parseFrontmatter<Record<string, unknown>>(readFileSync(join(root, `${slug}.md`), "utf8")).frontmatter;
}
function failure(fn: () => unknown): MemoryWriteError {
	try {
		fn();
		assert.fail("Expected failure");
	} catch (error) {
		assert.ok(error instanceof MemoryWriteError);
		return error;
	}
}

test("lock candidate cleanup failure releases ownership and explains recovery", (t) => {
	const root = corpus(t);
	const original = fs.unlinkSync;
	let fail = true;
	t.mock.method(fs, "unlinkSync", (path: fs.PathLike) => {
		if (fail && String(path).endsWith(".tmp")) {
			fail = false;
			throw Object.assign(new Error("Controlled cleanup failure"), { code: "EACCES" });
		}
		return original(path);
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => writeMemory(root, note()), /no notes were written.*manual removal/);
		assert.deepEqual(readdirSync(root), []);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("contention cleanup failure preserves the existing writer lock", (t) => {
	const root = corpus(t);
	const lock = join(root, ".memory-write.lock");
	writeFileSync(lock, "other writer");
	const original = fs.unlinkSync;
	t.mock.method(fs, "unlinkSync", (path: fs.PathLike) => {
		if (String(path).endsWith(".tmp")) throw Object.assign(new Error("Controlled refusal"), { code: "EACCES" });
		return original(path);
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => writeMemory(root, note()), /lock exists.*manual removal.*Retained artifacts/);
		assert.equal(readFileSync(lock, "utf8"), "other writer");
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("final cleanup failure reports published notes without false rollback", (t) => {
	const root = corpus(t);
	const original = fs.unlinkSync;
	t.mock.method(fs, "unlinkSync", (path: fs.PathLike) => {
		if (String(path).endsWith(".memory-write.lock"))
			throw Object.assign(new Error("Controlled refusal"), { code: "EACCES" });
		return original(path);
	});
	syncBuiltinESMExports();
	try {
		const error = failure(() => writeMemory(root, note()));
		assert.deepEqual(error.receipt.written, ["README.md", "editor-choice.md"]);
		assert.deepEqual(error.receipt.notWritten, []);
		assert.match(error.message, /lock cleanup failed/);
		assert.ok(error.receipt.digest);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("BOM source digests use raw bytes and supersession preserves the BOM", (t) => {
	const root = corpus(t);
	writeMemory(root, note("old"));
	const path = join(root, "old.md");
	const source = `\uFEFF${readFileSync(path, "utf8")}`;
	writeFileSync(path, source);
	writeMemory(root, { ...note("new"), supersedes: [{ slug: "old", digest: sourceDigest(source) }] });
	assert.ok(readFileSync(path, "utf8").startsWith("\uFEFF"));
	assert.equal(metadata(root, "old").status, "superseded");
});

test("transitive supersession refuses a cycle across partial publications", (t) => {
	const root = corpus(t);
	const a = writeMemory(root, note("a"));
	const partial = (slug: string, old: string, oldDigest: string) =>
		failure(() =>
			writeMemory(root, { ...note(slug), supersedes: [{ slug: old, digest: oldDigest }] }, undefined, {
				beforePublish(file) {
					if (file === `${old}.md`) throw new Error("Stop before old note");
				},
			}),
		);
	const b = partial("b", "a", a.digest as string);
	const c = partial("c", "b", b.receipt.digest as string);
	assert.match(
		failure(() =>
			writeMemory(root, {
				...note("a"),
				expectedDigest: a.digest,
				supersedes: [{ slug: "c", digest: c.receipt.digest as string }],
			}),
		).message,
		/cycle/,
	);
});

test("separate processes cannot both commit from one source digest", async (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	const module = new URL("./store.ts", import.meta.url).href;
	const run = (summary: string) =>
		new Promise<string>((resolve, reject) => {
			const source = `import {writeMemory} from ${JSON.stringify(module)}; try {writeMemory(${JSON.stringify(root)},${JSON.stringify({ ...note(), summary, expectedDigest: first.digest })});process.stdout.write('written');} catch {process.stdout.write('refused');}`;
			const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10000,
			});
			let output = "";
			let error = "";
			child.stdout.on("data", (chunk) => {
				output += chunk;
				if (output.length > 1000) child.kill();
			});
			child.stderr.on("data", (chunk) => {
				error += chunk;
				if (error.length > 1000) child.kill();
			});
			child.once("error", reject);
			child.once("close", (code) => (code === 0 ? resolve(output) : reject(new Error(error.slice(0, 1000)))));
		});
	const results = await Promise.all([run("First writer"), run("Second writer")]);
	assert.deepEqual(results.sort(), ["refused", "written"]);
	assert.ok(readdirSync(root).every((file) => !file.startsWith(".")));
});

test("configuration refuses missing, empty and relative roots", () => {
	for (const root of ["", "relative", "/bad\nroot"]) assert.throws(() => memoryRoot(root), /Memory unavailable/);
	assert.equal(memoryRoot("/notes"), "/notes");
});
test("create initializes a missing root and complete dated contract", (t) => {
	const root = join(corpus(t), "notes");
	const result = writeMemory(root, note());
	assert.equal(result.ok, true);
	assert.equal(result.initialized, true);
	assert.deepEqual(result.written, ["README.md", "editor-choice.md"]);
	const meta = metadata(root, "editor-choice");
	const today = new Date().toISOString().slice(0, 10);
	assert.deepEqual(meta, {
		title: "Editor choice",
		tags: ["editor", "preference"],
		status: "active",
		created: today,
		updated: today,
		verified: true,
		verified_date: today,
		supersedes: [],
		superseded_by: null,
	});
	assert.equal(result.digest, sourceDigest(readFileSync(join(root, "editor-choice.md"))));
	assert.deepEqual(readdirSync(root).sort(), ["README.md", "editor-choice.md"]);
});
test("update preserves created and sets verification false with a null date", (t) => {
	const root = corpus(t);
	writeMemory(root, note());
	const path = join(root, "editor-choice.md");
	const source = readFileSync(path, "utf8").replace(/^created: .*$/m, 'created: "2020-01-02"');
	writeFileSync(path, source);
	writeMemory(root, {
		...note(),
		summary: "Use a different editor.",
		verified: false,
		expectedDigest: sourceDigest(source),
	});
	assert.equal(metadata(root, "editor-choice").created, "2020-01-02");
	assert.equal(metadata(root, "editor-choice").verified_date, null);
});
test("duplicate create and missing update refuse without altering notes", (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	assert.match(failure(() => writeMemory(root, note())).message, /Duplicate slug/);
	assert.match(
		failure(() => writeMemory(root, { ...note("absent"), expectedDigest: first.digest })).message,
		/does not exist/,
	);
	assert.equal(sourceDigest(readFileSync(join(root, "editor-choice.md"))), first.digest);
});
test("stale digest refuses a second session update", (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	writeMemory(root, { ...note(), summary: "New preference", expectedDigest: first.digest });
	assert.match(failure(() => writeMemory(root, { ...note(), expectedDigest: first.digest })).message, /digest changed/);
});
test("supersession preserves all old body bytes including preamble, fences and tail", (t) => {
	const root = corpus(t);
	writeMemory(root, note("old-choice"));
	const path = join(root, "old-choice.md");
	const source =
		readFileSync(path, "utf8").replace("# Editor choice", "Introductory prose\n\n# Editor choice") +
		"\n```markdown\n## Not a section\n```\nTAIL 😀\n";
	writeFileSync(path, source);
	const body = source.slice(source.indexOf("\n---", 4) + 4);
	const result = writeMemory(root, {
		...note("new-choice"),
		supersedes: [{ slug: "old-choice", digest: sourceDigest(source) }],
	});
	assert.deepEqual(result.written, ["new-choice.md", "old-choice.md"]);
	assert.equal(metadata(root, "old-choice").status, "superseded");
	assert.equal(metadata(root, "old-choice").superseded_by, "new-choice");
	assert.deepEqual(metadata(root, "new-choice").supersedes, ["old-choice"]);
	const changed = readFileSync(path, "utf8");
	assert.equal(changed.slice(changed.indexOf("\n---", 4) + 4), body);
	const update = writeMemory(root, { ...note("new-choice"), expectedDigest: result.digest });
	assert.ok(update.ok);
	assert.deepEqual(metadata(root, "new-choice").supersedes, ["old-choice"]);
});
test("supersession validates all targets before any publication", (t) => {
	const root = corpus(t);
	const old = writeMemory(root, note("old"));
	const error = failure(() =>
		writeMemory(root, {
			...note("new"),
			supersedes: [
				{ slug: "old", digest: old.digest as string },
				{ slug: "missing", digest: "a".repeat(64) },
			],
		}),
	);
	assert.deepEqual(error.receipt.written, []);
	assert.equal(readdirSync(root).includes("new.md"), false);
	assert.equal(metadata(root, "old").status, "active");
});
test("superseded destination and conflicting replacement refuse", (t) => {
	const root = corpus(t);
	const old = writeMemory(root, note("old"));
	writeMemory(root, { ...note("new"), supersedes: [{ slug: "old", digest: old.digest as string }] });
	const oldDigest = sourceDigest(readFileSync(join(root, "old.md")));
	assert.match(
		failure(() => writeMemory(root, { ...note("old"), expectedDigest: oldDigest })).message,
		/superseded note/,
	);
	assert.match(
		failure(() => writeMemory(root, { ...note("other"), supersedes: [{ slug: "old", digest: oldDigest }] })).message,
		/another replacement/,
	);
});
test("a publication failure reports exactly committed and remaining files", (t) => {
	const root = corpus(t);
	const a = writeMemory(root, note("old-a"));
	const b = writeMemory(root, note("old-b"));
	const input = {
		...note("new"),
		supersedes: [
			{ slug: "old-a", digest: a.digest as string },
			{ slug: "old-b", digest: b.digest as string },
		],
	};
	const error = failure(() =>
		writeMemory(root, input, undefined, {
			beforePublish(file) {
				if (file === "old-b.md") throw new Error("Controlled failure");
			},
		}),
	);
	assert.deepEqual(error.receipt.written, ["new.md", "old-a.md"]);
	assert.deepEqual(error.receipt.notWritten, ["old-b.md"]);
	assert.equal(metadata(root, "old-a").status, "superseded");
	assert.equal(metadata(root, "old-b").status, "active");
	assert.ok(error.receipt.digest);
	assert.ok(readdirSync(root).every((name) => !name.startsWith(".")));
	// Retry repairs the pending reciprocal link using current evidence.
	writeMemory(root, {
		...note("new"),
		expectedDigest: error.receipt.digest,
		supersedes: [{ slug: "old-b", digest: b.digest as string }],
	});
	assert.equal(metadata(root, "old-b").status, "superseded");
});
test("failure before destination publication preserves the old inode content", (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	failure(() =>
		writeMemory(root, { ...note(), summary: "A change", expectedDigest: first.digest }, undefined, {
			beforePublish() {
				throw new Error("Disk refusal");
			},
		}),
	);
	assert.equal(sourceDigest(readFileSync(join(root, "editor-choice.md"))), first.digest);
});
test("external changes before publication refuse rather than overwrite", (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	failure(() =>
		writeMemory(root, { ...note(), expectedDigest: first.digest }, undefined, {
			beforePublish(file) {
				writeFileSync(join(root, file), "External edit");
			},
		}),
	);
	assert.equal(readFileSync(join(root, "editor-choice.md"), "utf8"), "External edit");
});
test("an existing lock refuses and remains recoverable without overwriting it", (t) => {
	const root = corpus(t);
	const lock = join(root, ".memory-write.lock");
	writeFileSync(lock, '{"pid":123,"started":"example"}');
	assert.throws(() => writeMemory(root, note()), /Inspect its owner/);
	assert.equal(readFileSync(lock, "utf8"), '{"pid":123,"started":"example"}');
	assert.deepEqual(readdirSync(root), [".memory-write.lock"]);
});
test("empty lock has explicit manual recovery and never blocks reads by policy", (t) => {
	const root = corpus(t);
	writeFileSync(join(root, ".memory-write.lock"), "");
	assert.throws(() => writeMemory(root, note()), /manual removal/);
});
test("pre-abort creates no corpus, mid-publication abort reports partial state", (t) => {
	const root = join(corpus(t), "notes");
	const signal = AbortSignal.abort();
	assert.throws(() => writeMemory(root, note(), signal));
	const controller = new AbortController();
	const error = failure(() =>
		writeMemory(root, note(), controller.signal, {
			beforePublish(file) {
				if (file === "README.md") controller.abort();
			},
		}),
	);
	assert.deepEqual(error.receipt.written, ["README.md"]);
	assert.deepEqual(error.receipt.notWritten, ["editor-choice.md"]);
});
test("input validation rejects malformed, duplicate, self and credential-like material without writes", (t) => {
	const root = corpus(t);
	const cases: MemoryWrite[] = [
		{ ...note(), slug: "../bad" },
		{ ...note(), slug: "readme" },
		{ ...note(), title: "two\nlines" },
		{ ...note(), summary: "" },
		{ ...note(), tags: ["x", "x"] },
		{ ...note(), expectedDigest: "bad" },
		{ ...note(), supersedes: [{ slug: "editor-choice", digest: "a".repeat(64) }] },
		{ ...note(), sources: "password=example-not-a-real-secret" },
		{ ...note(), details: "-----BEGIN PRIVATE KEY-----" },
	];
	for (const input of cases) assert.throws(() => writeMemory(root, input));
	assert.deepEqual(readdirSync(root), []);
});
test("non-scalar lifecycle status refuses supersession without implicit repair", (t) => {
	const root = corpus(t);
	writeMemory(root, note("old"));
	const path = join(root, "old.md");
	const source = readFileSync(path, "utf8")
		.replace('status: "active"', "status: [superseded]")
		.replace("superseded_by: null", 'superseded_by: "new"');
	writeFileSync(path, source);
	assert.match(
		failure(() => writeMemory(root, { ...note("new"), supersedes: [{ slug: "old", digest: sourceDigest(source) }] }))
			.message,
		/valid lifecycle/,
	);
	assert.equal(readFileSync(path, "utf8"), source);
});

test("unsupported frontmatter remains untouched on update", (t) => {
	const root = corpus(t);
	const path = join(root, "odd.md");
	writeFileSync(path, "# Odd\nMissing fields");
	const before = readFileSync(path, "utf8");
	failure(() => writeMemory(root, { ...note("odd"), expectedDigest: sourceDigest(before) }));
	assert.equal(readFileSync(path, "utf8"), before);
});
test("duplicate YAML lifecycle keys refuse before mutation", (t) => {
	const root = corpus(t);
	writeMemory(root, note());
	const path = join(root, "editor-choice.md");
	const source = readFileSync(path, "utf8").replace('status: "active"', "status: active\nstatus: superseded");
	writeFileSync(path, source);
	assert.match(
		failure(() => writeMemory(root, { ...note(), expectedDigest: sourceDigest(source) })).message,
		/unambiguous/,
	);
});
test("oversized notes and invalid UTF-8 refuse mutation", (t) => {
	const root = corpus(t);
	const path = join(root, "editor-choice.md");
	writeFileSync(path, Buffer.alloc(65537));
	failure(() => writeMemory(root, { ...note(), expectedDigest: sourceDigest(readFileSync(path)) }));
	writeFileSync(path, Buffer.from([0xff]));
	failure(() => writeMemory(root, { ...note(), expectedDigest: sourceDigest(readFileSync(path)) }));
});
test("directories and multiply linked note inodes refuse mutation", (t) => {
	const root = corpus(t);
	mkdirSync(join(root, "directory.md"));
	failure(() => writeMemory(root, { ...note("directory"), expectedDigest: "a".repeat(64) }));
	const first = writeMemory(root, note());
	linkSync(join(root, "editor-choice.md"), join(root, "linked.md"));
	failure(() => writeMemory(root, { ...note(), expectedDigest: first.digest }));
});
test("README initialization does not replace an existing contract", (t) => {
	const root = corpus(t);
	writeFileSync(join(root, "README.md"), "Operator contract\n");
	const result = writeMemory(root, note());
	assert.equal(result.initialized, false);
	assert.equal(readFileSync(join(root, "README.md"), "utf8"), "Operator contract\n");
});
