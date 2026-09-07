import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	findLiteral,
	isRealFilePath,
	readFrontmatter,
	readFrontmatterDisableFlag,
	resolveScanTarget,
	SCAN_MAX_BYTES,
	scanFile,
	type ScanIO,
} from "./scan.ts";
import type { ResourceRecord } from "./records.ts";

const info = (path: string) => ({ path, source: "package", scope: "user" as const, origin: "package" as const });

const record = (over: Partial<ResourceRecord> = {}): ResourceRecord => ({
	kind: "skill",
	name: "one",
	sourceInfo: info("/abs/one/SKILL.md"),
	evidence: "registration",
	at: 1,
	...over,
});

let dir = "";

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "registry-scan-"));
});

after(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("target resolution", () => {
	it("resolves exactly one file-backed candidate", () => {
		assert.equal(resolveScanTarget([record()]).kind, "resolved");
		assert.equal(resolveScanTarget([]).kind, "missing");
		assert.equal(resolveScanTarget([record(), record({ sourceInfo: info("/abs/two/SKILL.md") })]).kind, "ambiguous");
	});

	it("treats a tool or command as not file-backed", () => {
		assert.equal(resolveScanTarget([record({ kind: "tool" }), record({ kind: "command" })]).kind, "missing");
	});

	it("rejects a synthetic or relative source rather than opening it as a path", () => {
		assert.equal(resolveScanTarget([record({ sourceInfo: info("<builtin:read>") })]).kind, "unavailable");
		assert.equal(resolveScanTarget([record({ sourceInfo: info("relative/SKILL.md") })]).kind, "unavailable");
		assert.equal(isRealFilePath("<sdk>"), false);
		assert.equal(isRealFilePath(""), false);
		assert.equal(isRealFilePath("/abs/ok.md"), true);
	});
});

describe("literal matching", () => {
	it("is case-insensitive and carries one line of context", () => {
		const matches = findLiteral("alpha\nBETA line\ngamma", "beta");
		assert.equal(matches.length, 1);
		assert.equal(matches[0].line, 2);
		assert.equal(matches[0].before, "alpha");
		assert.equal(matches[0].after, "gamma");
	});

	it("treats the query as literal text, not a pattern", () => {
		assert.equal(findLiteral("a.c\nabc", "a.c").length, 1);
	});
});

describe("frontmatter evidence", () => {
	it("uses the loader's own reading of disable-model-invocation", () => {
		assert.equal(readFrontmatterDisableFlag("---\nname: a\ndisable-model-invocation: true\n---\nbody"), true);
		assert.equal(readFrontmatterDisableFlag("---\nname: a\n---\nbody"), false);
		assert.equal(readFrontmatterDisableFlag('---\nname: a\ndisable-model-invocation: "true"\n---\nbody'), false);
	});

	it("handles a BOM and CRLF the same way the loader does", () => {
		assert.equal(readFrontmatterDisableFlag("\uFEFF---\r\ndisable-model-invocation: true\r\n---\r\nbody"), true);
	});

	it("stays unknown for a missing, unterminated, or invalid block", () => {
		assert.equal(readFrontmatterDisableFlag("no frontmatter here"), undefined);
		assert.equal(readFrontmatterDisableFlag("---\nname: a\nstill going"), undefined);
		assert.equal(readFrontmatterDisableFlag("---\n a: [unclosed\n---\nbody"), undefined);
	});
});

describe("frontmatter parser boundaries", () => {
	it("distinguishes absent, incomplete, and comment-only blocks", () => {
		assert.equal(readFrontmatter("body").state, "absent");
		assert.equal(readFrontmatter("---\n# comment").state, "incomplete");
		assert.deepEqual(readFrontmatter("---\n# comment\n---"), { state: "valid", disableModelInvocation: false });
	});
	it("rejects scalar or sequence metadata explicitly", () => {
		assert.equal(readFrontmatter("---\nplain\n---").state, "non_object");
		assert.equal(readFrontmatter("---\n- plain\n---").state, "non_object");
	});
	it("uses strict YAML boolean semantics including comments and quoted strings", () => {
		assert.equal(readFrontmatterDisableFlag("---\ndisable-model-invocation: true # note\n---"), true);
		assert.equal(readFrontmatterDisableFlag("---\ndisable-model-invocation: 'true'\n---"), false);
	});
	it("normalizes a BOM and CR-only input", () => {
		assert.equal(readFrontmatterDisableFlag("\uFEFF---\rdisable-model-invocation: true\r---"), true);
	});
	it("closes at the first column-zero delimiter prefix but not an indented delimiter", () => {
		assert.equal(readFrontmatterDisableFlag("---\ndisable-model-invocation: true\n---suffix\ninvalid: ["), true);
		assert.equal(readFrontmatter("---\nname: x\n  ---").state, "incomplete");
	});
	it("reports invalid YAML as unavailable rather than absence or an exception", async () => {
		const path = join(dir, "invalid.md");
		await writeFile(path, "---\nname: [\n---\nbody");
		const result = await scanFile(path, "absent");
		assert.equal(result.outcome, "unavailable");
		assert.equal(result.frontmatter?.state, "invalid");
	});
	it("reports a complete block from a bounded prefix without guessing an incomplete block", async () => {
		const path = join(dir, "bounded-frontmatter.md");
		await writeFile(path, `---\ndisable-model-invocation: true\n---\n${"x".repeat(SCAN_MAX_BYTES)}`);
		const valid = await scanFile(path, "needle");
		assert.equal(valid.outcome, "partial");
		assert.equal(valid.disableModelInvocation, true);
		await writeFile(path, `---\nlong: ${"x".repeat(SCAN_MAX_BYTES)}\n---`);
		const incomplete = await scanFile(path, "needle");
		assert.equal(incomplete.outcome, "partial");
		assert.equal(incomplete.frontmatter?.state, "incomplete");
		assert.equal(incomplete.disableModelInvocation, undefined);
	});
});

describe("active scan cancellation", () => {
	it("closes an in-flight handle once and reports cancellation instead of I/O failure", async () => {
		const path = join(dir, "active-cancel.md");
		await writeFile(path, "needle");
		const facts = await stat(path);
		const controller = new AbortController();
		let rejectRead: (error: Error) => void = () => {};
		let entered: () => void = () => {};
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		let closes = 0;
		const io: ScanIO = { stat: async () => facts, open: async () => ({
			stat: async () => facts,
			read: async () => new Promise((_, reject) => { rejectRead = reject; entered(); }),
			close: async () => { closes += 1; rejectRead(new Error("closed during read")); },
		}) };
		const result = scanFile(path, "needle", controller.signal, io);
		await ready;
		controller.abort();
		assert.equal((await result).outcome, "cancelled");
		assert.equal(closes, 1);
	});
	it("closes a handle returned after cancellation during open", async () => {
		const path = join(dir, "open-cancel.md");
		await writeFile(path, "needle");
		const facts = await stat(path);
		const controller = new AbortController();
		let closes = 0;
		const result = await scanFile(path, "x", controller.signal, { stat: async () => facts, open: async () => {
			controller.abort();
			return { stat: async () => facts, read: async () => { throw new Error("must not read"); }, close: async () => { closes += 1; } };
		} });
		assert.equal(result.outcome, "cancelled");
		assert.equal(closes, 1);
	});
});

describe("bounded file scan", () => {
	it("reads a whole small file and reports a complete scan", async () => {
		const path = join(dir, "small.md");
		await writeFile(path, "---\nname: small\n---\nthe Memory instruction lives here\n");
		const result = await scanFile(path, "memory");
		assert.equal(result.outcome, "ok");
		assert.equal(result.truncated, false);
		assert.equal(result.matches.length, 1);
		assert.equal(result.disableModelInvocation, false);
		assert.ok(result.stamp);
	});

	it("stops at the byte bound and reports partial instead of absence", async () => {
		const path = join(dir, "big.md");
		await writeFile(path, `${"filler\n".repeat(60_000)}needle at the end\n`);
		const result = await scanFile(path, "needle");
		assert.equal(result.outcome, "partial");
		assert.equal(result.truncated, true);
		assert.equal(result.bytesRead, SCAN_MAX_BYTES);
		assert.equal(result.matches.length, 0);
		assert.equal(result.disableModelInvocation, undefined);
	});

	it("reports a read failure as io_error rather than an empty match set", async () => {
		const result = await scanFile(join(dir, "absent.md"), "anything");
		assert.equal(result.outcome, "io_error");
		assert.ok(result.error);
	});

	it("refuses a non-absolute or synthetic path without opening anything", async () => {
		const result = await scanFile("<builtin:read>", "x");
		assert.equal(result.outcome, "io_error");
		assert.match(result.error ?? "", /absolute file path/);
	});

	it("refuses a directory and any other non-regular source", async () => {
		const result = await scanFile(dir, "x");
		assert.equal(result.outcome, "io_error");
		assert.match(result.error ?? "", /not a regular file/);
	});

	it("returns cancelled without reading when the signal is already aborted", async () => {
		const path = join(dir, "cancel.md");
		await writeFile(path, "needle\n");
		const result = await scanFile(path, "needle", AbortSignal.abort());
		assert.equal(result.outcome, "cancelled");
		assert.equal(result.matches.length, 0);
	});
});

describe("non-regular sources", { skip: process.platform === "win32" ? "POSIX FIFO test" : false }, () => {
	// A reader-less FIFO is the case that can park an open() past cancellation,
	// so the guard is checked against a real one rather than a stubbed stat.
	it("never opens a FIFO", { timeout: 4000 }, async () => {
		const path = join(dir, "pipe");
		await new Promise<void>((resolve, reject) => {
			execFile("mkfifo", [path], (error) => (error ? reject(error) : resolve()));
		});
		const result = await scanFile(path, "x", AbortSignal.timeout(3000));
		assert.equal(result.outcome, "io_error");
		assert.match(result.error ?? "", /not a regular file/);
	});
});
