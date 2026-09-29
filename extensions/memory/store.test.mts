import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { editMemory, type MemoryWrite, MemoryWriteError, memoryRoot, sourceDigest, writeMemory } from "./store.ts";

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
	assert.ok(readdirSync(root).every((file) => file === ".memory-history" || !file.startsWith(".")));
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
	assert.ok(readdirSync(root).every((name) => name === ".memory-history" || !name.startsWith(".")));
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
		{ ...note(), sources: `token=${"ghp_"}${"x".repeat(24)}` },
		{ ...note(), details: "-----BEGIN PRIVATE KEY-----" },
	];
	for (const input of cases) assert.throws(() => writeMemory(root, input));
	assert.deepEqual(readdirSync(root), []);
});
test("technical assignments and prose survive creation and whole-note rewrites verbatim", (t) => {
	const root = corpus(t);
	const details = [
		"api_key=api_key",
		"`api_key=api_key`",
		"api_key=api_key\nnext line",
		"```typescript\nconst client = new Client({ api_key: process.env.API_KEY });\n```",
		"password=example-not-a-real-secret",
		"access_token: fixture.accessToken",
		"secret: configuration value",
		'{"api_key":"api_key","password":"<password>"}',
		"Use the parameter password=password in the synthetic fixture.",
	].join("\n\n");
	const first = writeMemory(root, { ...note(), title: "secret: configuration guide", details });
	const path = join(root, "editor-choice.md");
	assert.ok(readFileSync(path, "utf8").includes(details));
	const changed = writeMemory(root, { ...note(), expectedDigest: first.digest, details, verified: false });
	assert.equal(changed.ok, true);
	assert.ok(readFileSync(path, "utf8").includes(details));
	assert.equal(metadata(root, "editor-choice").verified_date, null);
});

test("recognized credential formats refuse in every authoring field without echo or initialization", (t) => {
	const root = join(corpus(t), "absent");
	const tokens = [
		"-----BEGIN PRIVATE KEY-----",
		"-----BEGIN RSA PRIVATE KEY-----",
		`sk-${"x".repeat(24)}`,
		...Array.from("pousr", (kind) => `gh${kind}_${"x".repeat(24)}`),
		`github_pat_${"x".repeat(24)}`,
		`AKIA${"X".repeat(16)}`,
	];
	for (const token of tokens) {
		for (const field of ["title", "summary", "details", "sources", "tags"] as const) {
			const value = field === "tags" ? [token] : `Example: ${token}`;
			assert.throws(
				() => writeMemory(root, { ...note(), [field]: value }),
				(error) => {
					assert.ok(error instanceof Error);
					assert.match(error.message, /Credential-like material refused/);
					assert.ok(error.message.includes(field === "tags" ? "tags[0]" : field));
					assert.match(error.message, /descriptive placeholder/);
					assert.ok(!error.message.includes(token));
					return true;
				},
			);
		}
		for (const marker of ["```", "~~~"]) {
			assert.throws(
				() => writeMemory(root, { ...note(), details: `${marker}\n${token}\n${marker}` }),
				/Credential-like/,
			);
		}
	}
	assert.equal(fs.existsSync(root), false);
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
test("single-line titles refuse Unicode separators before initialization", (t) => {
	const root = join(corpus(t), "absent");
	for (const separator of ["\u2028", "\u2029"]) {
		assert.throws(() => writeMemory(root, { ...note(), title: `Alpha${separator}Beta` }), /title.*single-line/);
		assert.equal(fs.existsSync(root), false);
	}
});

test("nonexact frontmatter delimiters explain the mutation boundary without changing bytes", (t) => {
	const root = corpus(t);
	writeMemory(root, note());
	const path = join(root, "editor-choice.md");
	const original = readFileSync(path, "utf8");
	for (const source of [original.replace(/^---/, "--- "), original.replace("\n---\n", "\n--- \n")]) {
		writeFileSync(path, source);
		const error = failure(() => writeMemory(root, { ...note(), expectedDigest: sourceDigest(source) }));
		assert.match(error.message, /valid frontmatter with exact --- delimiter lines/);
		assert.equal(readFileSync(path, "utf8"), source);
	}
});

test("ambiguous physical headers refuse edits, rewrites and supersession without byte changes", (t) => {
	const root = corpus(t);
	writeMemory(root, note());
	const path = join(root, "editor-choice.md");
	const source = readFileSync(path, "utf8").replace(
		"\n---\n\n#",
		'\n---suffix\nupdated: "2000-01-01"\nprivate-field: preserved\n---\n\n#',
	);
	writeFileSync(path, source);
	const expectedDigest = sourceDigest(source);
	for (const operation of [
		() =>
			editMemory(root, {
				slug: "editor-choice",
				expectedDigest,
				verified: true,
				edits: [{ oldText: "Use the plain editor.", newText: "Use a different editor." }],
			}),
		() => writeMemory(root, { ...note(), expectedDigest }),
		() =>
			writeMemory(root, { ...note("replacement"), supersedes: [{ slug: "editor-choice", digest: expectedDigest }] }),
	]) {
		assert.match(failure(operation).message, /unambiguous frontmatter.*exact --- delimiter/);
		assert.equal(readFileSync(path, "utf8"), source);
		assert.deepEqual(readdirSync(root).sort(), ["README.md", "editor-choice.md"]);
	}
});

test("supersession refuses alias side effects without exposing or altering unrelated metadata", (t) => {
	const root = corpus(t);
	writeMemory(root, note("old"));
	const path = join(root, "old.md");
	const source = readFileSync(path, "utf8").replace('status: "active"', "status: &state active\nprivate-field: *state");
	writeFileSync(path, source);
	const error = failure(() =>
		writeMemory(root, { ...note("new"), supersedes: [{ slug: "old", digest: sourceDigest(source) }] }),
	);
	assert.match(error.message, /plain top-level keys.*metadata must remain unchanged/);
	assert.doesNotMatch(error.message, /private-field|&state|\*state/);
	assert.equal(readFileSync(path, "utf8"), source);
	assert.equal(fs.existsSync(join(root, "new.md")), false);
});

test("whole-note rewrite replaces old authoring fields without a migration requirement", (t) => {
	const root = corpus(t);
	writeMemory(root, note());
	const path = join(root, "editor-choice.md");
	const source = readFileSync(path, "utf8")
		.replace(/^title: .*$/m, "title: [old, malformed]")
		.replace(/^tags: .*$/m, "tags: old-string")
		.replace(/^verified_date: .*\n/m, "")
		.replace("# Editor choice", "## Earlier heading");
	writeFileSync(path, source);
	const rewritten = writeMemory(root, { ...note(), expectedDigest: sourceDigest(source) });
	assert.ok(rewritten.ok);
	assert.equal(metadata(root, "editor-choice").title, note().title);
	assert.deepEqual(metadata(root, "editor-choice").tags, note().tags);
	assert.equal(metadata(root, "editor-choice").created, parseFrontmatter(source).frontmatter.created);
});

test("preserved lifecycle links refuse invalid shapes rather than normalize them", (t) => {
	const root = corpus(t);
	writeMemory(root, note());
	const path = join(root, "editor-choice.md");
	const original = readFileSync(path, "utf8");
	for (const replacement of [
		"supersedes: editor-choice",
		"supersedes: [editor-choice]",
		"supersedes: [other, other]",
		"supersedes: [readme]",
		`supersedes: [${"x".repeat(121)}]`,
	]) {
		const source = original.replace("supersedes: []", replacement);
		writeFileSync(path, source);
		const error = failure(() => writeMemory(root, { ...note(), expectedDigest: sourceDigest(source) }));
		assert.match(error.message, /supersedes must be a list.*without self-links/);
		assert.equal(readFileSync(path, "utf8"), source);
	}
	for (const source of [
		original.replace("superseded_by: null", "superseded_by: other"),
		original.replace('status: "active"', 'status: "superseded"'),
	]) {
		writeFileSync(path, source);
		assert.match(
			failure(() => writeMemory(root, { ...note(), expectedDigest: sourceDigest(source) })).message,
			/valid lifecycle status/,
		);
		assert.equal(readFileSync(path, "utf8"), source);
	}
});

test("credential checks cover slugs, inherited links and complete supersession targets", (t) => {
	const root = corpus(t);
	const token = `sk-${"x".repeat(24)}`;
	for (const input of [
		{ ...note(), slug: token },
		{ ...note(), supersedes: [{ slug: token, digest: "a".repeat(64) }] },
	]) {
		assert.throws(
			() => writeMemory(root, input),
			(error) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Credential-like material refused/);
				assert.ok(!error.message.includes(token));
				return true;
			},
		);
	}
	writeMemory(root, note("old"));
	const path = join(root, "old.md");
	const original = readFileSync(path, "utf8");
	const linked = original.replace("supersedes: []", `supersedes: [${token}]`);
	writeFileSync(path, linked);
	const rewrite = failure(() => writeMemory(root, { ...note("old"), expectedDigest: sourceDigest(linked) }));
	assert.match(rewrite.message, /resulting note.*recognized token prefix/);
	assert.ok(!rewrite.message.includes(token));
	assert.equal(readFileSync(path, "utf8"), linked);
	const source = `${original}\n${token}\n`;
	writeFileSync(path, source);
	const supersession = failure(() =>
		writeMemory(root, { ...note("new"), supersedes: [{ slug: "old", digest: sourceDigest(source) }] }),
	);
	assert.match(supersession.message, /supersession target.*recognized token prefix/);
	assert.ok(!supersession.message.includes(token));
	assert.deepEqual(supersession.receipt.written, []);
	assert.equal(fs.existsSync(join(root, "new.md")), false);
	assert.equal(readFileSync(path, "utf8"), source);
});

for (const phase of ["lock", "note"] as const) {
	test(`${phase} staging preserves flush and cleanup failures with the retained filename`, (t) => {
		const root = corpus(t);
		const first = writeMemory(root, note());
		const originalSync = fs.fsyncSync;
		const originalUnlink = fs.unlinkSync;
		let syncs = 0;
		let failed = false;
		t.mock.method(fs, "fsyncSync", (fd: number) => {
			if (++syncs === (phase === "lock" ? 1 : 2)) {
				failed = true;
				throw Object.assign(new Error("Synthetic flush failure"), { code: "EIO" });
			}
			return originalSync(fd);
		});
		t.mock.method(fs, "unlinkSync", (path: fs.PathLike) => {
			if (failed && String(path).endsWith(".tmp"))
				throw Object.assign(new Error("Synthetic cleanup failure"), { code: "EACCES" });
			return originalUnlink(path);
		});
		syncBuiltinESMExports();
		try {
			assert.throws(
				() => writeMemory(root, { ...note(), expectedDigest: first.digest }),
				(error) => {
					assert.ok(error instanceof Error);
					assert.match(error.message, /staging failed \(EIO\).*cleanup failed \(EACCES\).*retained artifact/);
					const retained = readdirSync(root).filter((file) => file.startsWith(".memory-"));
					assert.equal(retained.length, 1);
					assert.ok(error.message.includes(retained[0]));
					assert.ok(!error.message.includes(root));
					if (phase === "note") {
						assert.ok(error instanceof MemoryWriteError);
						assert.deepEqual(error.receipt.written, []);
						assert.deepEqual(error.receipt.notWritten, ["editor-choice.md"]);
					}
					return true;
				},
			);
			assert.equal(sourceDigest(readFileSync(join(root, "editor-choice.md"))), first.digest);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		}
	});
}

test("a staged note close failure cleans the private file and preserves the source", (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	const original = fs.closeSync;
	let closed = 0;
	t.mock.method(fs, "closeSync", (fd: number) => {
		original(fd);
		if (++closed === 4) throw Object.assign(new Error("Synthetic close failure"), { code: "EIO" });
	});
	syncBuiltinESMExports();
	try {
		const error = failure(() => writeMemory(root, { ...note(), expectedDigest: first.digest }));
		assert.match(error.message, /Temporary file close failed \(EIO\)/);
		assert.deepEqual(error.receipt.written, []);
		assert.deepEqual(readdirSync(root).sort(), ["README.md", "editor-choice.md"]);
		assert.equal(sourceDigest(readFileSync(join(root, "editor-choice.md"))), first.digest);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("unavailable write roots return a content-free error", (t) => {
	const root = corpus(t);
	const path = join(root, "not-a-directory");
	writeFileSync(path, "Unchanged");
	assert.throws(
		() => writeMemory(path, note()),
		(error) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Memory unavailable: corpus directory cannot be created/);
			assert.ok(!error.message.includes(path));
			return true;
		},
	);
	assert.equal(readFileSync(path, "utf8"), "Unchanged");
});

test("README initialization does not replace an existing contract", (t) => {
	const root = corpus(t);
	writeFileSync(join(root, "README.md"), "Operator contract\n");
	const result = writeMemory(root, note());
	assert.equal(result.initialized, false);
	assert.equal(readFileSync(join(root, "README.md"), "utf8"), "Operator contract\n");
});
