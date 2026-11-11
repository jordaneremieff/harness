import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { chmodSync, closeSync, constants, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { editMemory, type MemoryWrite, MemoryWriteError, memoryRoot, reviewMemory, retireMemory, sourceDigest, writeMemory } from "./store.ts";
import { readMemory } from "./retrieval.ts";
import { memorySourceCache } from "./source-cache.ts";

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

const busyMessage = "Memory writer is busy. This writer never removes the lock file. Do not remove it.";
const identityMessage = "Memory lock path changed during the write. Publication stopped. This writer never removes the lock file. Do not remove it.";
function holdWriter(path: string): number {
	return openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW | 0x20, 0o600);
}

test("a held descriptor refuses contention without note publication or lock removal", (t) => {
	const root = corpus(t), first = writeMemory(root, note());
	const lock = join(root, ".memory-write.lock"), before = lstatSync(lock), held = holdWriter(lock);
	try {
		assert.throws(() => writeMemory(root, { ...note(), expectedDigest: first.digest }), { message: busyMessage });
		assert.equal(sourceDigest(readFileSync(join(root, "editor-choice.md"))), first.digest);
		assert.equal(lstatSync(lock).ino, before.ino);
	} finally { closeSync(held); }
	assert.equal(writeMemory(root, { ...note(), expectedDigest: first.digest }).ok, true);
	assert.equal(lstatSync(lock).ino, before.ino);
});

test("acquisition errors retain the underlying code without exposing content", (t) => {
	const root = corpus(t), lock = join(root, ".memory-write.lock");
	writeFileSync(lock, "private metadata", { mode: 0o600 });
	const original = fs.openSync;
	t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
		if (args[0] === join(fs.realpathSync(root), ".memory-write.lock")) throw Object.assign(new Error("private metadata"), { code: "EACCES" });
		return original(...args);
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => writeMemory(root, note()), { message: "Memory lock acquisition failed (EACCES); no notes were written." });
		assert.equal(readFileSync(lock, "utf8"), "private metadata");
		assert.deepEqual(readdirSync(root), [".memory-write.lock"]);
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("final cleanup failure reports published notes without false rollback", (t) => {
	const root = corpus(t);
	const original = fs.closeSync, stat = fs.fstatSync;
	t.mock.method(fs, "closeSync", (fd: number) => {
		const info = stat(fd), lock = lstatSync(join(root, ".memory-write.lock"));
		original(fd);
		if (info.ino === lock.ino && info.dev === lock.dev)
			throw Object.assign(new Error("Controlled refusal"), { code: "EIO" });
	});
	syncBuiltinESMExports();
	try {
		const error = failure(() => writeMemory(root, note()));
		assert.deepEqual(error.receipt.written, ["README.md", "editor-choice.md"]);
		assert.deepEqual(error.receipt.notWritten, []);
		assert.match(error.message, /^Memory write published all live files, but cleanup failed:/);
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
	assert.ok(readdirSync(root).every((file) => file === ".memory-history" || file === ".memory-write.lock" || !file.startsWith(".")));
});

test("a process crash releases the descriptor without changing the persistent inode", async (t) => {
	const root = corpus(t), module = new URL("./store.ts", import.meta.url).href;
	const source = `import {writeMemory} from ${JSON.stringify(module)}; import {writeSync} from 'node:fs'; writeMemory(${JSON.stringify(root)},${JSON.stringify(note())},undefined,{beforePublish(){writeSync(1,'held');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}});`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
	t.after(() => { child.kill("SIGKILL"); });
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.stdout.once("data", (data) => { assert.equal(String(data), "held"); resolve(); });
		child.once("close", () => reject(new Error("Writer exited before acquisition acknowledgement")));
	});
	const path = join(root, ".memory-write.lock"), before = lstatSync(path);
	const residue = readdirSync(root).filter((file) => file.endsWith(".tmp"));
	assert.equal(residue.length, 2);
	child.kill("SIGKILL");
	await exited;
	assert.equal(writeMemory(root, note()).ok, true);
	assert.equal(lstatSync(path).ino, before.ino);
	assert.equal(readFileSync(path, "utf8"), "");
	for (const file of residue) assert.equal(lstatSync(join(root, file)).isFile(), true);
});

test("lock modes require private read/write access without a private corpus mode", (t) => {
	assert.notEqual(process.getuid?.(), 0, "permission refusals require a non-root process");
	for (const mode of [0o600, 0o700, 0o400, 0o200, 0, 0o640, 0o602]) {
		const root = corpus(t), path = join(root, ".memory-write.lock");
		chmodSync(root, 0o755);
		writeFileSync(path, "metadata", { mode: 0o600 });
		chmodSync(path, mode);
		const before = lstatSync(path);
		if (mode === 0o600 || mode === 0o700) assert.equal(writeMemory(root, note()).ok, true);
		else {
			assert.throws(() => writeMemory(root, note()), /Memory lock acquisition failed/);
			assert.equal(lstatSync(path).mode & 0o777, mode);
			assert.equal(fs.existsSync(join(root, "README.md")), false);
			chmodSync(path, 0o600);
			assert.equal(writeMemory(root, note()).ok, true);
		}
		assert.equal(lstatSync(path).ino, before.ino);
		assert.equal(readFileSync(path, "utf8"), "metadata");
	}
});

test("unsafe lock type, size and ownership refuse before publication", (t) => {
	const root = corpus(t), path = join(root, ".memory-write.lock");
	mkdirSync(path);
	assert.throws(() => writeMemory(root, note()), /Memory lock acquisition failed/);
	rmSync(path, { recursive: true });
	writeFileSync(path, "x".repeat(4097), { mode: 0o600 });
	assert.throws(() => writeMemory(root, note()), /Memory lock acquisition failed/);
	writeFileSync(path, "", { mode: 0o600 });
	const original = fs.fstatSync;
	t.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
		const info = original(...args);
		return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: Number(info.uid) + 1 });
	});
	syncBuiltinESMExports();
	try { assert.throws(() => writeMemory(root, note()), /Memory lock acquisition failed/); }
	finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	assert.deepEqual(readdirSync(root), [".memory-write.lock"]);
	assert.equal(writeMemory(root, note()).ok, true);
});

test("unsupported mutations refuse while current notes remain readable", async (t) => {
	const root = corpus(t), first = writeMemory(root, note());
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platform);
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	try {
		assert.throws(() => writeMemory(root, { ...note(), expectedDigest: first.digest }), { message: "Memory mutations require macOS." });
		await assert.doesNotReject(() => readMemory(root, { slug: "editor-choice" }));
	} finally { Object.defineProperty(process, "platform", platform); }
	assert.equal(sourceDigest(readFileSync(join(root, "editor-choice.md"))), first.digest);
});

for (const partial of [false, true]) {
	test(`identity loss ${partial ? "after" : "before"} destination publication preserves the exact prefix and captures`, (t) => {
		const root = corpus(t), alpha = writeMemory(root, note("alpha"));
		const lock = join(root, ".memory-write.lock");
		let successor: ReturnType<typeof lstatSync> | undefined, otherPublications = 0;
		const error = failure(() => writeMemory(root, { ...note("beta"), supersedes: [{ slug: "alpha", digest: alpha.digest as string }] }, undefined, {
			beforePublish(file) {
				if (file !== (partial ? "alpha.md" : "beta.md")) return;
				rmSync(lock);
				const other = writeMemory(root, { ...note(partial ? "gamma" : "beta"), summary: "Successor publication" });
				otherPublications += other.written.length;
				successor = lstatSync(lock);
			},
		}));
		assert.equal(error.receipt.error, identityMessage);
		assert.deepEqual(error.receipt.written, partial ? ["beta.md"] : []);
		assert.deepEqual(error.receipt.notWritten, partial ? ["alpha.md"] : ["beta.md", "alpha.md"]);
		assert.equal(error.receipt.captured.length, 1);
		assert.equal(error.receipt.captured[0].slug, "alpha");
		assert.equal(otherPublications, 1);
		assert.equal(lstatSync(lock).ino, successor?.ino);
		assert.equal(sourceDigest(readFileSync(join(root, "alpha.md"))), alpha.digest);
		if (partial) assert.equal(error.receipt.digest, sourceDigest(readFileSync(join(root, "beta.md"))));
		else assert.ok(readFileSync(join(root, "beta.md"), "utf8").includes("Successor publication"));
	});
}

test("identity loss guards README creation without undoing successor initialisation", (t) => {
	const root = corpus(t), lock = join(root, ".memory-write.lock");
	let other: ReturnType<typeof writeMemory> | undefined;
	const error = failure(() => writeMemory(root, note("alpha"), undefined, {
		beforePublish(file) {
			if (file !== "README.md") return;
			rmSync(lock);
			other = writeMemory(root, note("successor"));
		},
	}));
	assert.equal(error.receipt.error, identityMessage);
	assert.deepEqual(error.receipt.written, []);
	assert.deepEqual(error.receipt.notWritten, ["README.md", "alpha.md"]);
	assert.equal(error.receipt.initialized, false);
	assert.equal(other?.initialized, true);
	assert.deepEqual(other?.written, ["README.md", "successor.md"]);
	assert.equal(fs.existsSync(join(root, "alpha.md")), false);
	assert.equal(fs.existsSync(lock), true);
});

test("identity loss guards the final history link and preserves earlier captures", (t) => {
	const root = corpus(t), alpha = writeMemory(root, note("alpha")), beta = writeMemory(root, note("beta"));
	const lock = join(root, ".memory-write.lock");
	const error = failure(() => writeMemory(root, { ...note("beta"), expectedDigest: beta.digest, supersedes: [{ slug: "alpha", digest: alpha.digest as string }] }, undefined, {
		beforeCapture(file) {
			if (file !== "alpha.md") return;
			rmSync(lock);
			assert.deepEqual(writeMemory(root, note("successor")).written, ["successor.md"]);
		},
	}));
	assert.equal(error.receipt.error, identityMessage);
	assert.deepEqual(error.receipt.written, []);
	assert.deepEqual(error.receipt.notWritten, ["beta.md", "alpha.md"]);
	assert.deepEqual(error.receipt.captured.map((capture) => capture.slug), ["beta"]);
	assert.equal(readdirSync(join(root, ".memory-history", "beta")).length, 1);
	assert.deepEqual(readdirSync(join(root, ".memory-history", "alpha")), []);
	assert.equal(sourceDigest(readFileSync(join(root, "alpha.md"))), alpha.digest);
	assert.equal(sourceDigest(readFileSync(join(root, "beta.md"))), beta.digest);
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
	assert.deepEqual(readdirSync(root).sort(), [".memory-write.lock", "README.md", "editor-choice.md"]);
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
function assertDigestRefusal(error: MemoryWriteError, root: string, subject: string, argument: string, publication = false): void {
	const diagnostic = error.receipt.error;
	assert.ok(diagnostic);
	assert.ok(diagnostic.includes(`for "${subject}"`), diagnostic);
	assert.ok(diagnostic.includes(`read "${subject}" with memory_read and update ${argument} before retry`), diagnostic);
	assert.equal(diagnostic.includes("before publication"), publication);
	assert.ok(!diagnostic.includes(root));
	assert.ok(!/\b[a-f0-9]{64}\b/u.test(diagnostic));
}

test("every supplied supersession digest remains mandatory after the target names the same replacement", (t) => {
	const root = corpus(t);
	writeMemory(root, note("alpha"));
	const alpha = join(root, "alpha.md"), beta = join(root, "beta.md");
	const originalTargetDigest = sourceDigest(readFileSync(alpha));
	writeMemory(root, { ...note("beta"), supersedes: [{ slug: "alpha", digest: originalTargetDigest }] });
	const targetBefore = readFileSync(alpha), destinationBefore = readFileSync(beta);
	const retry: MemoryWrite = { ...note("beta"), summary: "Updated preference.", expectedDigest: sourceDigest(destinationBefore), supersedes: [{ slug: "alpha", digest: originalTargetDigest }] };
	const refused = failure(() => writeMemory(root, retry));
	assertDigestRefusal(refused, root, "alpha", "supersedes[0].digest");
	assert.deepEqual(refused.receipt.written, []);
	assert.deepEqual(refused.receipt.captured, []);
	assert.deepEqual(readFileSync(alpha), targetBefore);
	assert.deepEqual(readFileSync(beta), destinationBefore);
	const corrected = writeMemory(root, { ...retry, supersedes: [{ slug: "alpha", digest: sourceDigest(readFileSync(alpha)) }] });
	assert.equal(corrected.ok, true);
	const targetAfter = readFileSync(alpha);
	const rewritten = writeMemory(root, { ...note("beta"), summary: "Updated preference.", expectedDigest: sourceDigest(readFileSync(beta)) });
	assert.equal(rewritten.ok, true);
	assert.deepEqual(rewritten.written, ["beta.md"]);
	assert.deepEqual(metadata(root, "beta").supersedes, ["alpha"]);
	assert.deepEqual(readFileSync(alpha), targetAfter);
	const staleDestination = failure(() => writeMemory(root, { ...note("beta"), expectedDigest: sourceDigest(destinationBefore) }));
	assertDigestRefusal(staleDestination, root, "beta", "expectedDigest");
	assert.deepEqual(staleDestination.receipt.written, []);
});

test("a stale later supersession target names its actual argument index before any publication", (t) => {
	const root = corpus(t);
	writeMemory(root, note("alpha"));
	writeMemory(root, note("gamma"));
	const alpha = readFileSync(join(root, "alpha.md")), gamma = readFileSync(join(root, "gamma.md"));
	const error = failure(() => writeMemory(root, { ...note("beta"), supersedes: [
		{ slug: "alpha", digest: sourceDigest(alpha) },
		{ slug: "gamma", digest: "0".repeat(64) },
	] }));
	assertDigestRefusal(error, root, "gamma", "supersedes[1].digest");
	assert.deepEqual(error.receipt.written, []);
	assert.deepEqual(error.receipt.captured, []);
	assert.equal(fs.existsSync(join(root, "beta.md")), false);
	assert.deepEqual(readFileSync(join(root, "alpha.md")), alpha);
	assert.deepEqual(readFileSync(join(root, "gamma.md")), gamma);
});

test("publication rechecks retain source argument labels and exact partial receipts", (t) => {
	for (const [subject, argument, written, remaining] of [
		["beta", "expectedDigest", [], ["beta.md", "alpha.md", "gamma.md"]],
		["gamma", "supersedes[1].digest", ["beta.md", "alpha.md"], ["gamma.md"]],
	] as const) {
		const root = corpus(t);
		for (const name of ["alpha", "beta", "gamma"]) writeMemory(root, note(name));
		const input: MemoryWrite = { ...note("beta"), summary: "Updated preference.", expectedDigest: sourceDigest(readFileSync(join(root, "beta.md"))), supersedes: [
			{ slug: "alpha", digest: sourceDigest(readFileSync(join(root, "alpha.md"))) },
			{ slug: "gamma", digest: sourceDigest(readFileSync(join(root, "gamma.md"))) },
		] };
		const error = failure(() => writeMemory(root, input, undefined, {
			beforePublish(file) {
				if (file === `${subject}.md`) writeFileSync(join(root, file), `${readFileSync(join(root, file), "utf8")}\nExternal source update.\n`);
			},
		}));
		assertDigestRefusal(error, root, subject, argument, true);
		assert.deepEqual(error.receipt.written, written);
		assert.deepEqual(error.receipt.notWritten, remaining);
		assert.equal(error.receipt.captured.length, 3);
		assert.equal(error.receipt.digest, written.length ? sourceDigest(readFileSync(join(root, "beta.md"))) : undefined);
		assert.match(readFileSync(join(root, `${subject}.md`), "utf8"), /External source update/);
	}
});

test("history capture refusals identify the source digest argument before live publication", (t) => {
	for (const [subject, argument, captured] of [["beta", "expectedDigest", 0], ["alpha", "supersedes[0].digest", 1]] as const) {
		const root = corpus(t);
		writeMemory(root, note("alpha"));
		writeMemory(root, note("beta"));
		const input: MemoryWrite = {
			...note("beta"),
			expectedDigest: sourceDigest(readFileSync(join(root, "beta.md"))),
			supersedes: [{ slug: "alpha", digest: sourceDigest(readFileSync(join(root, "alpha.md"))) }],
		};
		const error = failure(() => writeMemory(root, input, undefined, {
			beforeCapture(file) {
				if (file === `${subject}.md`) writeFileSync(join(root, file), `${readFileSync(join(root, file), "utf8")}\nExternal source update.\n`);
			},
		}));
		assertDigestRefusal(error, root, subject, argument, true);
		assert.deepEqual(error.receipt.written, []);
		assert.deepEqual(error.receipt.notWritten, ["beta.md", "alpha.md"]);
		assert.equal(error.receipt.captured.length, captured);
	}
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
	assert.match(error.message, /^Memory write partially completed:/);
	assert.deepEqual(error.receipt.written, ["new.md", "old-a.md"]);
	assert.deepEqual(error.receipt.notWritten, ["old-b.md"]);
	assert.equal(metadata(root, "old-a").status, "superseded");
	assert.equal(metadata(root, "old-b").status, "active");
	assert.ok(error.receipt.digest);
	assert.ok(readdirSync(root).every((name) => name === ".memory-history" || name === ".memory-write.lock" || !name.startsWith(".")));
	// Retry repairs the pending reciprocal link using current evidence.
	writeMemory(root, {
		...note("new"),
		expectedDigest: error.receipt.digest,
		supersedes: [{ slug: "old-b", digest: b.digest as string }],
	});
	assert.equal(metadata(root, "old-b").status, "superseded");
});
test("every mutation reports preflight refusals without corpus access", (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	const expectedDigest = first.digest as string;
	const before = new Map(readdirSync(root).map((file) => [file, readFileSync(join(root, file), "utf8")]));
	const token = `sk-${"x".repeat(24)}`;
	const operations = [
		() => writeMemory(root, { ...note(), summary: "" }),
		() => editMemory(root, { slug: "editor-choice", expectedDigest: "bad", verified: true, edits: [{ oldText: "a", newText: "b" }] }),
		() => reviewMemory(root, { slug: "editor-choice", expectedDigest, outcome: "confirmed", reason: "Not applicable", sources: "Synthetic source" }),
		() => retireMemory(root, { slug: "editor-choice", expectedDigest, reason: "", sources: "Synthetic source" }),
		() => writeMemory(root, { ...note(), slug: token }),
		() => editMemory(root, { slug: token, expectedDigest, verified: true, edits: [{ oldText: "a", newText: "b" }] }),
		() => reviewMemory(root, { slug: token, expectedDigest, outcome: "confirmed", sources: "Synthetic source" }),
		() => retireMemory(root, { slug: token, expectedDigest, reason: "Withdraw", sources: "Synthetic source" }),
	];
	for (const operation of operations) {
		const error = failure(operation);
		assert.ok(error.message.startsWith("Memory write stopped; no live files were written: "));
		assert.deepEqual(error.receipt.written, []);
		assert.deepEqual(error.receipt.notWritten, []);
		assert.deepEqual(error.receipt.captured, []);
		assert.deepEqual(error.receipt.historyOmitted, []);
		assert.equal(error.receipt.initialized, false);
		assert.ok(!error.message.includes(token));
		assert.ok(!JSON.stringify(error.receipt).includes(token));
		assert.deepEqual(readdirSync(root).sort(), [...before.keys()].sort());
		for (const [file, source] of before) assert.equal(readFileSync(join(root, file), "utf8"), source);
	}
});

test("body validation refusal reports zero live writes and preserves every source", (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	const before = new Map(readdirSync(root).map((file) => [file, readFileSync(join(root, file), "utf8")]));
	const error = failure(() => editMemory(root, {
		slug: "editor-choice", expectedDigest: first.digest as string, verified: true,
		edits: [{ oldText: "Missing original text", newText: "Changed text" }],
	}));
	assert.match(error.message, /^Memory write stopped; no live files were written:/);
	assert.match(error.message, /oldText does not match the original body/);
	assert.doesNotMatch(error.message, /incomplete|partially/);
	assert.deepEqual(error.receipt.written, []);
	assert.deepEqual(error.receipt.captured, []);
	assert.deepEqual(readdirSync(root).sort(), [...before.keys()].sort());
	for (const [file, source] of before) assert.equal(readFileSync(join(root, file), "utf8"), source);
});

test("failure before destination publication preserves the old inode content", (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	const error = failure(() =>
		writeMemory(root, { ...note(), summary: "A change", expectedDigest: first.digest }, undefined, {
			beforePublish() {
				throw new Error("Disk refusal");
			},
		}),
	);
	assert.match(error.message, /^Memory write stopped; no live files were written:/);
	assert.deepEqual(error.receipt.written, []);
	assert.equal(error.receipt.captured.length, 1);
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
test("quiet lock residue and hard-link aliases retain their bytes and inode", (t) => {
	for (const content of ["", '{"pid":123,"started":"example"}']) {
		const root = corpus(t), lock = join(root, ".memory-write.lock"), alias = join(root, ".memory-candidate.tmp");
		writeFileSync(lock, content, { mode: 0o600 });
		linkSync(lock, alias);
		const before = lstatSync(lock), held = holdWriter(alias);
		try { assert.throws(() => writeMemory(root, note()), { message: busyMessage }); }
		finally { closeSync(held); }
		assert.equal(writeMemory(root, note()).ok, true);
		assert.equal(readFileSync(lock, "utf8"), content);
		assert.equal(readFileSync(alias, "utf8"), content);
		assert.equal(lstatSync(lock).ino, before.ino);
		assert.equal(lstatSync(alias).ino, before.ino);
		assert.equal(lstatSync(lock).nlink, 2);
	}
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
		{ ...note(), details: `-----BEGIN ${"PRIVATE"} KEY-----` },
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
		`-----BEGIN ${"PRIVATE"} KEY-----`,
		`-----BEGIN RSA ${"PRIVATE"} KEY-----`,
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
		assert.deepEqual(readdirSync(root).sort(), [".memory-write.lock", "README.md", "editor-choice.md"]);
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

test("note staging preserves flush and cleanup failures with the retained filename", (t) => {
	const root = corpus(t), first = writeMemory(root, note());
	const originalSync = fs.fsyncSync, originalUnlink = fs.unlinkSync;
	let failed = false;
	t.mock.method(fs, "fsyncSync", (fd: number) => {
		if (!failed) {
			failed = true;
			throw Object.assign(new Error("Synthetic flush failure"), { code: "EIO" });
		}
		return originalSync(fd);
	});
	t.mock.method(fs, "unlinkSync", (path: fs.PathLike) => {
		if (failed && String(path).endsWith(".tmp")) throw Object.assign(new Error("Synthetic cleanup failure"), { code: "EACCES" });
		return originalUnlink(path);
	});
	syncBuiltinESMExports();
	try {
		const error = failure(() => writeMemory(root, { ...note(), expectedDigest: first.digest }));
		assert.match(error.message, /staging failed \(EIO\).*cleanup failed \(EACCES\).*retained artifact/);
		const retained = readdirSync(root).filter((file) => file.startsWith(".memory-") && file.endsWith(".tmp"));
		assert.equal(retained.length, 1);
		assert.ok(error.message.includes(retained[0]));
		assert.ok(!error.message.includes(root));
		assert.deepEqual(error.receipt.written, []);
		assert.deepEqual(error.receipt.notWritten, ["editor-choice.md"]);
		assert.equal(sourceDigest(readFileSync(join(root, "editor-choice.md"))), first.digest);
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("a staged note close failure cleans the private file and preserves the source", (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	const original = fs.closeSync;
	t.mock.method(fs, "closeSync", (fd: number) => {
		const info = fs.fstatSync(fd);
		const temp = readdirSync(root).find((file) => file.startsWith(".memory-") && file.endsWith(".tmp"));
		const staged = temp !== undefined && lstatSync(join(root, temp)).ino === info.ino;
		original(fd);
		if (staged) throw Object.assign(new Error("Synthetic close failure"), { code: "EIO" });
	});
	syncBuiltinESMExports();
	try {
		const error = failure(() => writeMemory(root, { ...note(), expectedDigest: first.digest }));
		assert.match(error.message, /Temporary file close failed \(EIO\)/);
		assert.deepEqual(error.receipt.written, []);
		assert.deepEqual(readdirSync(root).sort(), [".memory-write.lock", "README.md", "editor-choice.md"]);
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

function headerText(root: string, slug: string): string {
	const text = readFileSync(join(root, `${slug}.md`), "utf8");
	return text.slice(0, text.indexOf("\n---\n") + 5);
}

test("a successful owned publication invalidates cached header parsing", async (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	await readMemory(root, { slug: "editor-choice" });
	const warm = memorySourceCache.statistics();
	const header = headerText(root, "editor-choice");
	editMemory(root, {
		slug: "editor-choice",
		expectedDigest: first.digest as string,
		verified: true,
		edits: [
			{
				oldText: "The operator prefers a small local editor.",
				newText: "The operator uses a small local editor.",
			},
		],
	});
	assert.equal(headerText(root, "editor-choice"), header);
	const page = await readMemory(root, { slug: "editor-choice" });
	assert.match(page.content as string, /uses a small local editor/);
	const after = memorySourceCache.statistics();
	assert.equal(after.misses, warm.misses + 1);
	assert.equal(after.yamlParses, warm.yamlParses + 1);
});

test("an earlier success in a partially failed multi-write invalidates its header", async (t) => {
	const root = corpus(t);
	const target = writeMemory(root, note("old-choice"));
	const destination = writeMemory(root, {
		...note("new-choice"),
		supersedes: [{ slug: "old-choice", digest: target.digest as string }],
	});
	await readMemory(root, { slug: "new-choice" });
	const warm = memorySourceCache.statistics();
	const header = headerText(root, "new-choice");
	const targetSource = readFileSync(join(root, "old-choice.md"));
	const error = failure(() =>
		writeMemory(
			root,
			{
				...note("new-choice"),
				summary: "Rewritten summary.",
				expectedDigest: destination.digest,
				supersedes: [{ slug: "old-choice", digest: sourceDigest(targetSource) }],
			},
			undefined,
			{
				beforePublish(file) {
					if (file === "old-choice.md") throw new Error("Stop before the superseded target");
				},
			},
		),
	);
	assert.deepEqual(error.receipt.written, ["new-choice.md"]);
	assert.deepEqual(error.receipt.notWritten, ["old-choice.md"]);
	assert.equal(headerText(root, "new-choice"), header);
	const page = await readMemory(root, { slug: "new-choice" });
	assert.match(page.content as string, /Rewritten summary/);
	const after = memorySourceCache.statistics();
	assert.equal(after.misses, warm.misses + 1);
	assert.equal(after.yamlParses, warm.yamlParses + 1);
});
