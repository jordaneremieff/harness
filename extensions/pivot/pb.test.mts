import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pbCopy } from "./pb.ts";

let root: string;
let clipboardFile: string;
let oldPath: string | undefined;
let oldFile: string | undefined;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "pivot-pb-test-"));
	clipboardFile = join(root, "clipboard.txt");
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(
		join(bin, "pbcopy"),
		'#!/bin/sh\nif [ "$FAKE_PBCOPY_SLOW" = "1" ]; then sleep 20; fi\ncat > "$FAKE_CLIPBOARD_FILE"\n',
	);
	await chmod(join(bin, "pbcopy"), 0o755);
	oldPath = process.env.PATH;
	oldFile = process.env.FAKE_CLIPBOARD_FILE;
	process.env.PATH = `${bin}:${oldPath ?? ""}`;
	process.env.FAKE_CLIPBOARD_FILE = clipboardFile;
});

after(async () => {
	if (oldPath === undefined) delete process.env.PATH;
	else process.env.PATH = oldPath;
	if (oldFile === undefined) delete process.env.FAKE_CLIPBOARD_FILE;
	else process.env.FAKE_CLIPBOARD_FILE = oldFile;
	await rm(root, { recursive: true, force: true });
});

describe("pbCopy", () => {
	it("writes content through pbcopy stdin", async () => {
		await pbCopy("hello fork");
		assert.equal(await readFile(clipboardFile, "utf8"), "hello fork");
	});

	it("aborts promptly instead of waiting out the timeout", async () => {
		process.env.FAKE_PBCOPY_SLOW = "1";
		try {
			const controller = new AbortController();
			const started = Date.now();
			const pending = pbCopy("slow", { signal: controller.signal, timeoutMs: 30_000 });
			setTimeout(() => controller.abort(), 50);
			await assert.rejects(pending);
			assert.ok(Date.now() - started < 5_000, "the abort must reach the child promptly");
		} finally {
			delete process.env.FAKE_PBCOPY_SLOW;
		}
	});

	it("kills the child on timeout and rejects", async () => {
		process.env.FAKE_PBCOPY_SLOW = "1";
		try {
			const started = Date.now();
			await assert.rejects(pbCopy("slow", { timeoutMs: 200 }));
			assert.ok(Date.now() - started < 5_000, "the timeout must kill the child, not hang");
		} finally {
			delete process.env.FAKE_PBCOPY_SLOW;
		}
	});

	it("reports a clear macOS-only error when pbcopy is absent", async () => {
		const emptyBin = join(root, "empty-bin");
		await mkdir(emptyBin);
		const oldPathValue = process.env.PATH;
		process.env.PATH = emptyBin;
		try {
			await assert.rejects(pbCopy("x"), /requires macOS/);
		} finally {
			process.env.PATH = oldPathValue;
		}
	});
});
