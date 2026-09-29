import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { editMemory, type MemoryEdit, MemoryWriteError, sourceDigest, writeMemory } from "./store.ts";

function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "memory-edit-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeMemory(root, {
		slug: "editor-choice",
		title: "Editor choice",
		tags: ["editor"],
		summary: "Use editor A.",
		details: "Keep the local files.",
		sources: "Operator statement.",
		verified: true,
	});
	const path = join(root, "editor-choice.md");
	const source = readFileSync(path, "utf8");
	const input: MemoryEdit = {
		slug: "editor-choice",
		expectedDigest: sourceDigest(source),
		verified: false,
		edits: [{ oldText: "Use editor A.", newText: "Use editor B." }],
	};
	return { root, path, source, input };
}
function failure(fn: () => unknown): MemoryWriteError {
	try {
		fn();
		assert.fail("Expected refusal");
	} catch (error) {
		assert.ok(error instanceof MemoryWriteError);
		return error;
	}
}
function body(source: string): string {
	const header = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(source);
	assert.ok(header);
	return source.slice(header[0].length);
}

test("single edit returns the shared receipt and refreshes whole-note verification", (t) => {
	const f = fixture(t);
	const result = editMemory(f.root, f.input);
	const changed = readFileSync(f.path, "utf8");
	assert.deepEqual(result, {
		ok: true,
		slug: f.input.slug,
		file: "editor-choice.md",
		digest: sourceDigest(changed),
		written: ["editor-choice.md"],
		notWritten: [],
		initialized: false,
	});
	assert.equal(body(changed), body(f.source).replace("Use editor A.", "Use editor B."));
	const meta = parseFrontmatter<Record<string, unknown>>(changed).frontmatter;
	assert.equal(meta.verified, false);
	assert.equal(meta.verified_date, null);
	assert.equal(meta.updated, new Date().toISOString().slice(0, 10));
	assert.ok(result.digest);
	const verified = editMemory(f.root, {
		...f.input,
		expectedDigest: result.digest,
		verified: true,
		edits: [{ oldText: "Use editor B.", newText: "Use editor C." }],
	});
	assert.ok(verified.ok);
	assert.equal(
		parseFrontmatter<Record<string, unknown>>(readFileSync(f.path, "utf8")).frontmatter.verified_date,
		meta.updated,
	);
});

test("multiple disjoint edits match the original body, not replacement output", (t) => {
	const f = fixture(t);
	editMemory(f.root, {
		...f.input,
		edits: [
			{ oldText: "Keep the local files.", newText: "Use editor A." },
			{ oldText: "Use editor A.", newText: "Use editor B." },
			{ oldText: "Operator statement.", newText: "" },
		],
	});
	assert.equal(
		body(readFileSync(f.path, "utf8")),
		body(f.source)
			.replace("Use editor A.", "Use editor B.")
			.replace("Keep the local files.", "Use editor A.")
			.replace("Operator statement.", ""),
	);
});

test("header bytes, introductory prose, extra sections, BOM and mixed line endings survive", (t) => {
	const f = fixture(t);
	const source = `\uFEFF${f.source}`
		.replace('tags: ["editor"]', '# Subject cues\ntags:\n  - editor\ncustom: {owner: "operator"}')
		.replace(/^updated: .*$/m, 'updated: "2020-01-02" # old date')
		.replace(/^verified_date: .*$/m, 'verified_date: "2020-01-02"')
		.replace("# Editor choice", "Introductory prose\n\n# Editor choice")
		.replaceAll("\n", "\r\n")
		.concat("\n## Exceptions\nKeep these qualifications. 😀\n```md\n## Example\n```\nTAIL\n");
	writeFileSync(f.path, source);
	const today = new Date().toISOString().slice(0, 10);
	editMemory(f.root, { ...f.input, expectedDigest: sourceDigest(source) });
	const expected = source
		.replace(/^updated:[^\r\n]*/m, `updated: "${today}"`)
		.replace(/^verified:[^\r\n]*/m, "verified: false")
		.replace(/^verified_date:[^\r\n]*/m, "verified_date: null")
		.replace("Use editor A.", "Use editor B.");
	assert.deepEqual(readFileSync(f.path), Buffer.from(expected));
});

test("missing, ambiguous, overlapping, nested and no-op replacements refuse atomically", (t) => {
	const f = fixture(t);
	const cases = [
		{ edits: [{ oldText: "absent", newText: "new" }], error: /does not match/ },
		{ edits: [{ oldText: " ", newText: "new" }], error: /ambiguous/ },
		{
			edits: [
				{ oldText: "Use editor", newText: "One" },
				{ oldText: "editor A.", newText: "Two" },
			],
			error: /overlap/,
		},
		{
			edits: [
				{ oldText: "Use editor A.", newText: "One" },
				{ oldText: "editor A.", newText: "Two" },
			],
			error: /overlap/,
		},
		{ edits: [{ oldText: "Use editor A.", newText: "Use editor A." }], error: /no body change/ },
		{
			edits: [
				{ oldText: "Use editor A.", newText: "New" },
				{ oldText: "New", newText: "Again" },
			],
			error: /does not match/,
		},
		{ edits: [{ oldText: 'status: "active"', newText: "status: superseded" }], error: /does not match/ },
	];
	for (const { edits, error } of cases) {
		const refused = failure(() => editMemory(f.root, { ...f.input, edits }));
		assert.match(refused.message, error);
		assert.deepEqual(refused.receipt.written, []);
		assert.equal(readFileSync(f.path, "utf8"), f.source);
	}
	assert.deepEqual(readdirSync(f.root).sort(), ["README.md", "editor-choice.md"]);
});

test("adjacent replacements work, while overlapping occurrences remain ambiguous", (t) => {
	const f = fixture(t);
	editMemory(f.root, {
		...f.input,
		edits: [
			{ oldText: "Use ", newText: "Choose " },
			{ oldText: "editor A.", newText: "editor C." },
		],
	});
	assert.match(readFileSync(f.path, "utf8"), /Choose editor C\./);
	const source = `${f.source}\naaa\n`;
	writeFileSync(f.path, source);
	assert.match(
		failure(() =>
			editMemory(f.root, {
				...f.input,
				expectedDigest: sourceDigest(source),
				edits: [{ oldText: "aa", newText: "b" }],
			}),
		).message,
		/ambiguous/,
	);
});

test("matches are literal without fuzzy text or line-ending normalization", (t) => {
	const f = fixture(t);
	const source = f.source.replace("Use editor A.", "Use ‘editor’ A.").replaceAll("\n", "\r\n");
	writeFileSync(f.path, source);
	for (const oldText of ["Use 'editor' A.", "## Summary\n\nUse ‘editor’ A."]) {
		assert.match(
			failure(() =>
				editMemory(f.root, {
					...f.input,
					expectedDigest: sourceDigest(source),
					edits: [{ oldText, newText: "Changed" }],
				}),
			).message,
			/does not match/,
		);
	}
	assert.equal(readFileSync(f.path, "utf8"), source);
});

test("title edits and edits that hide or precede the title refuse", (t) => {
	const f = fixture(t);
	for (const edits of [
		[{ oldText: "# Editor choice", newText: "# Another title" }],
		[{ oldText: "\n# Editor choice", newText: "# Editor choice" }],
	])
		assert.match(failure(() => editMemory(f.root, { ...f.input, edits })).message, /title heading/);
	const source = f.source.replace("# Editor choice", "Intro\n\n# Editor choice");
	writeFileSync(f.path, source);
	assert.match(
		failure(() =>
			editMemory(f.root, {
				...f.input,
				expectedDigest: sourceDigest(source),
				edits: [{ oldText: "Intro", newText: "# Another title" }],
			}),
		).message,
		/title/,
	);
	const mismatch = f.source.replace("# Editor choice", "# Different");
	writeFileSync(f.path, mismatch);
	assert.match(
		failure(() => editMemory(f.root, { ...f.input, expectedDigest: sourceDigest(mismatch) })).message,
		/matches frontmatter/,
	);
});

test("fenced title decoys cannot authorize title edits or prevent ordinary body edits", (t) => {
	const f = fixture(t);
	for (const [open, close] of [
		["```md", "```"],
		["~~~~md", "~~~~"],
		["  ````md", "   ````"],
	]) {
		for (const decoy of ["Editor choice", "Install"]) {
			const source = f.source.replace("# Editor choice", `${open}\n# ${decoy}\n${close}\n\n# Editor choice`);
			writeFileSync(f.path, source);
			const input = { ...f.input, expectedDigest: sourceDigest(source) };
			assert.match(
				failure(() =>
					editMemory(f.root, {
						...input,
						edits: [{ oldText: "# Editor choice\n\n## Summary", newText: "# Altered\n\n## Summary" }],
					}),
				).message,
				/title heading/,
			);
			assert.equal(readFileSync(f.path, "utf8"), source);
			editMemory(f.root, input);
			assert.equal(body(readFileSync(f.path, "utf8")), body(source).replace("Use editor A.", "Use editor B."));
		}
	}
});

test("title identity survives preamble edits but refuses earlier duplicates and fence changes that hide it", (t) => {
	const f = fixture(t);
	const source = f.source.replace("# Editor choice", "Intro\n\n# Editor choice");
	const input = { ...f.input, expectedDigest: sourceDigest(source) };
	for (const newText of ["# Editor choice", "```", "~~~"]) {
		writeFileSync(f.path, source);
		assert.match(
			failure(() => editMemory(f.root, { ...input, edits: [{ oldText: "Intro", newText }] })).message,
			/title heading/,
		);
		assert.equal(readFileSync(f.path, "utf8"), source);
	}
	writeFileSync(f.path, source);
	editMemory(f.root, { ...input, edits: [{ oldText: "Intro", newText: "Longer introductory prose" }] });
	assert.match(readFileSync(f.path, "utf8"), /Longer introductory prose\n\n# Editor choice/);
	const unclosed = f.source.replace("# Editor choice", "````\n```\n# Editor choice");
	writeFileSync(f.path, unclosed);
	assert.match(
		failure(() => editMemory(f.root, { ...f.input, expectedDigest: sourceDigest(unclosed) })).message,
		/title heading/,
	);
});

test("stale and missing targets refuse, including an external change before publication", (t) => {
	const f = fixture(t);
	assert.match(
		failure(() => editMemory(f.root, { ...f.input, expectedDigest: "a".repeat(64) })).message,
		/digest changed/,
	);
	assert.match(failure(() => editMemory(f.root, { ...f.input, slug: "absent" })).message, /does not exist/);
	const refused = failure(() =>
		editMemory(f.root, f.input, undefined, {
			beforePublish() {
				writeFileSync(f.path, "External edit");
			},
		}),
	);
	assert.match(refused.message, /changed before publication/);
	assert.deepEqual(refused.receipt.notWritten, ["editor-choice.md"]);
	assert.equal(readFileSync(f.path, "utf8"), "External edit");
});

test("superseded notes and invalid lifecycle metadata refuse", (t) => {
	const f = fixture(t);
	for (const source of [
		f.source.replace('status: "active"', 'status: "superseded"').replace("superseded_by: null", 'superseded_by: "new"'),
		f.source.replace('status: "active"', 'status: ["active"]'),
		f.source.replace('status: "active"', "status: active\nstatus: superseded"),
		f.source.replace(/^created: .*$/m, "created: yesterday"),
	]) {
		writeFileSync(f.path, source);
		failure(() => editMemory(f.root, { ...f.input, expectedDigest: sourceDigest(source) }));
		assert.equal(readFileSync(f.path, "utf8"), source);
	}
});

test("generated fields require safe independent keys without changes to other metadata", (t) => {
	const f = fixture(t);
	for (const source of [
		f.source.replace(/^updated: /m, '"updated": '),
		f.source.replace(/^verified: .*\n/m, ""),
		f.source.replace(/^verified: .*$/m, "verified: &flag true\nother: *flag"),
		f.source.replace(/^verified_date: .*$/m, "verified_date: |\n  2020-01-01"),
	]) {
		writeFileSync(f.path, source);
		assert.match(
			failure(() => editMemory(f.root, { ...f.input, expectedDigest: sourceDigest(source) })).message,
			/plain top-level keys/,
		);
		assert.equal(readFileSync(f.path, "utf8"), source);
	}
});

test("replacement credentials refuse without echo and assembled credentials also refuse", (t) => {
	const f = fixture(t);
	const synthetic = "password=synthetic-not-a-credential";
	assert.throws(
		() => editMemory(f.root, { ...f.input, edits: [{ oldText: "Use editor A.", newText: synthetic }] }),
		(error) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Credential-like/);
			assert.ok(!error.message.includes(synthetic));
			return true;
		},
	);
	const source = `${f.source}\npassword: short\n`;
	writeFileSync(f.path, source);
	assert.match(
		failure(() =>
			editMemory(f.root, {
				...f.input,
				expectedDigest: sourceDigest(source),
				edits: [{ oldText: "short", newText: "synthetic-long-value" }],
			}),
		).message,
		/Credential-like/,
	);
	assert.equal(readFileSync(f.path, "utf8"), source);
});

test("runtime validation bounds edits, requires verification and digest, and refuses controls and lone surrogates", (t) => {
	const f = fixture(t);
	const invalid = [
		{ expectedDigest: undefined },
		{ verified: undefined },
		{ edits: [] },
		{ edits: Array.from({ length: 33 }, () => f.input.edits[0]) },
		{ edits: [{ oldText: "", newText: "new" }] },
		{ edits: [{ oldText: "x".repeat(24001), newText: "new" }] },
		{ edits: [{ oldText: "Use editor A.", newText: "x".repeat(24001) }] },
		...["\u0000", "\u000b", "\u001f", "\u007f", "\ud800", "\udc00"].flatMap((value) => [
			{ edits: [{ oldText: value, newText: "new" }] },
			{ edits: [{ oldText: "Use editor A.", newText: value }] },
		]),
	];
	for (const fields of invalid) assert.throws(() => editMemory(f.root, { ...f.input, ...fields } as MemoryEdit));
	assert.equal(readFileSync(f.path, "utf8"), f.source);
	assert.deepEqual(readdirSync(f.root).sort(), ["README.md", "editor-choice.md"]);
});

test("Unicode byte size and retained control characters bound the complete result", (t) => {
	const f = fixture(t);
	assert.match(
		failure(() =>
			editMemory(f.root, { ...f.input, edits: [{ oldText: "Use editor A.", newText: "界".repeat(23000) }] }),
		).message,
		/64 KiB/,
	);
	const source = `${f.source}\u0001`;
	writeFileSync(f.path, source);
	assert.match(
		failure(() => editMemory(f.root, { ...f.input, expectedDigest: sourceDigest(source) })).message,
		/control characters/,
	);
});

test("cancellation before work and after staging leaves the note unchanged and releases the lock", (t) => {
	const f = fixture(t);
	assert.throws(() => editMemory(f.root, f.input, AbortSignal.abort()), /cancelled/);
	const controller = new AbortController();
	const original = fs.writeFileSync;
	let writes = 0;
	t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
		original(...args);
		if (++writes === 2) controller.abort();
	});
	syncBuiltinESMExports();
	try {
		const refused = failure(() => editMemory(f.root, f.input, controller.signal));
		assert.match(refused.message, /cancelled/);
		assert.deepEqual(refused.receipt.written, []);
		assert.deepEqual(refused.receipt.notWritten, ["editor-choice.md"]);
		assert.equal(readFileSync(f.path, "utf8"), f.source);
		assert.deepEqual(readdirSync(f.root).sort(), ["README.md", "editor-choice.md"]);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("writer contention refuses without altering the note or the owner's lock", (t) => {
	const f = fixture(t);
	const lock = join(f.root, ".memory-write.lock");
	writeFileSync(lock, "active writer");
	assert.throws(() => editMemory(f.root, f.input), /lock exists.*never remove a live lock/);
	assert.equal(readFileSync(lock, "utf8"), "active writer");
	assert.equal(readFileSync(f.path, "utf8"), f.source);
});

test("an exact 64 KiB result succeeds and a missing corpus stays absent", (t) => {
	const f = fixture(t);
	const source = f.source + "x".repeat(65536 - Buffer.byteLength(f.source));
	writeFileSync(f.path, source);
	editMemory(f.root, { ...f.input, verified: true, expectedDigest: sourceDigest(source) });
	assert.equal(readFileSync(f.path).length, 65536);
	const missing = join(f.root, "missing");
	assert.throws(
		() => editMemory(missing, f.input),
		(error) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /^Memory unavailable: corpus directory cannot be resolved \(ENOENT\)$/);
			assert.ok(!error.message.includes(missing));
			return true;
		},
	);
	assert.equal(fs.existsSync(missing), false);
});

test("write and edit accept format characters and C1 controls under the same text rule", (t) => {
	const f = fixture(t);
	const receipt = writeMemory(f.root, {
		slug: "emoji",
		title: "Emoji note",
		tags: ["t"],
		summary: "Family 👨‍👩‍👧 emoji",
		details: "Soft\u00adhyphen detail\u0085",
		sources: "Probe",
		verified: true,
	});
	assert.ok(receipt.digest);
	const source = readFileSync(join(f.root, "emoji.md"), "utf8");
	const edited = editMemory(f.root, {
		slug: "emoji",
		expectedDigest: receipt.digest,
		verified: true,
		edits: [{ oldText: "Probe", newText: "Probe, updated" }],
	});
	assert.equal(readFileSync(join(f.root, "emoji.md"), "utf8"), source.replace("Probe", "Probe, updated"));
	assert.ok(edited.digest);
	editMemory(f.root, {
		slug: "emoji",
		expectedDigest: edited.digest,
		verified: true,
		edits: [{ oldText: "Soft\u00adhyphen detail\u0085", newText: "Join 👨‍👩‍👧\u00ad\u0085" }],
	});
	assert.match(readFileSync(join(f.root, "emoji.md"), "utf8"), /Join 👨‍👩‍👧\u00ad\u0085/u);
	for (const value of ["\u0000", "\u000b", "\u001f", "\u007f", "\ud800"]) {
		assert.throws(() =>
			writeMemory(f.root, {
				slug: "invalid",
				title: "Invalid",
				tags: [],
				summary: value,
				details: "Detail",
				sources: "Source",
				verified: false,
			}),
		);
	}
});

test("edits do not create or replace the corpus contract", (t) => {
	const f = fixture(t);
	rmSync(join(f.root, "README.md"));
	assert.equal(editMemory(f.root, f.input).initialized, false);
	assert.deepEqual(readdirSync(f.root), ["editor-choice.md"]);
});
