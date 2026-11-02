import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hookContent, installHook, pushRanges, scanRange, scanText } from "./publication-scan.mts";

const script = fileURLToPath(new URL("./publication-scan.mts", import.meta.url));

function repository(): { root: string; git: (...args: string[]) => string } {
	const root = mkdtempSync(join(tmpdir(), "publication-scan-"));
	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
	};
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q", "-b", "main");
	writeFileSync(join(root, "ok.txt"), "plain\n");
	git("add", ".");
	git("commit", "-q", "-m", "Initial");
	return { root, git };
}

test("signature rules flag secrets and personal paths without reporting the matched text", () => {
	assert.equal(scanText(`const token = 'ghp_${"a".repeat(36)}';`)?.rule, "credential");
	assert.equal(scanText(["see /", "Users/someone/notes.md"].join(""))?.rule, "personal-path");
	assert.equal(scanText(["-----BEGIN OPENSSH ", "PRIVATE KEY-----"].join(""))?.rule, "private-key");
	assert.equal(scanText(["<agent-", "efforts>"].join(""))?.rule, "session-transcript");
	assert.equal(scanText("ordinary source\nwith /usr/local/bin\n"), undefined);
});

test("a range scan covers commit messages and changed blobs, and a clean range passes", (t) => {
	const { root, git } = repository();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const base = git("rev-parse", "HEAD");
	writeFileSync(join(root, "leak.txt"), `key=${["sk-", "ant-"].join("")}${"b".repeat(40)}\n`);
	git("add", ".");
	git("commit", "-q", "-m", "Add config");
	writeFileSync(join(root, "ok.txt"), "more\n");
	git("commit", "-q", "-am", ["Notes at /", "home/person/private"].join(""));
	const findings = scanRange(root, [`${base}..HEAD`]);
	assert.equal(findings.length, 2);
	assert.match(findings[0], /commit message line 1: personal-path/);
	assert.match(findings[1], /leak\.txt:1: credential/);
	assert.ok(findings.every((finding) => !finding.includes("sk-ant") && !finding.includes("/home/person")));
	assert.deepEqual(scanRange(root, [`${base}..${base}`]), []);
	const refused = spawnSync(process.execPath, [script, `${base}..HEAD`], { cwd: root, encoding: "utf8" });
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /Publication refused/);
});

test("pre-push input maps to ranges and the hook installs only over its own marker", (t) => {
	assert.deepEqual(
		pushRanges("refs/heads/main abc refs/heads/main def\nrefs/heads/x 111 refs/heads/x 0000000000\n"),
		[["def..abc"], ["111", "--not", "--remotes"]],
	);
	assert.deepEqual(pushRanges("(delete) 0000000000 refs/heads/gone def\n"), []);
	const { root } = repository();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = installHook(root);
	assert.equal(readFileSync(path, "utf8"), hookContent());
	assert.equal(installHook(root), path);
	writeFileSync(path, "#!/bin/sh\necho mine\n");
	assert.throws(() => installHook(root), /unmanaged hook/);
});
