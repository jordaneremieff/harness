import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hookContent, installHook, pushRanges, scanRange, scanText } from "./publication-scan.mts";

const script = fileURLToPath(new URL("./publication-scan.mts", import.meta.url));
// Imported installer calls must use the same isolated Git configuration as fixture commits.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

// Envelope openings are assembled from fragments so this file retains none verbatim.
const opening = (name: string, attributes = ""): string => ["<", "agent", "-", name, attributes].join("");

function repository(initialText = "plain\n"): { root: string; git: (...args: string[]) => string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "publication-scan-")));
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
		execFileSync("git", ["commit", "merge"].includes(args[0]) ? ["-c", "core.hooksPath=/dev/null", ...args] : args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q", "-b", "main");
	writeFileSync(join(root, "ok.txt"), initialText);
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

test("every recognised envelope name matches bare and attributed opening tags", () => {
	for (const name of ["request-context", "request-route", "efforts", "preferences"]) {
		assert.equal(scanText(`${opening(name)}>`)?.rule, "session-transcript");
		assert.equal(scanText(`${opening(name, ' host="fixture" origin=\'test\'')}>`)?.rule, "session-transcript");
		assert.equal(scanText(`${opening(name, '\thost="fixture"')}>`)?.rule, "session-transcript");
	}
	assert.equal(scanText(`${opening("request-route")}>`)?.line, 1);
	assert.equal(scanText(`\t${opening("request-context", " kind='header'")}>`)?.rule, "session-transcript");
});

test("envelope openings match indentation, tabs, CRLF and quoted attributes", () => {
	const route = opening("request-route");
	assert.equal(scanText(`  ${route}>`)?.rule, "session-transcript");
	assert.equal(scanText(`\t\t${route}>`)?.rule, "session-transcript");
	assert.equal(scanText(`${route} scope="worktree">`)?.rule, "session-transcript");
	assert.equal(scanText(`${route} scope='worktree'>`)?.rule, "session-transcript");
	assert.equal(scanText(`${route} scope="worktree" depth=2 sealed>`)?.rule, "session-transcript");
	assert.equal(scanText(`\t${route} scope='worktree'\r\n`)?.rule, "session-transcript");
	assert.equal(scanText(["intro", `${route} scope="worktree">`].join("\r\n"))?.line, 2);
});

test("a header that continues over several lines is a signature at its first line", () => {
	const route = opening("request-route");
	assert.equal(scanText([`${route} scope="worktree"`, ' depth="2"', ">"].join("\n"))?.line, 1);
	assert.equal(scanText([`${route} `, 'scope="worktree"', ">"].join("\n"))?.line, 1);
	assert.equal(scanText(["intro", `\t${route} scope="worktree"`, ' depth="1">'].join("\r\n"))?.line, 2);
});

test("longer names and ordinary tags are not envelope signatures", () => {
	for (const name of ["request-context-archive", "request-routes", "efforts-by-day", "preferences_extra"]) {
		assert.equal(scanText(`${opening(name)}>`), undefined);
	}
	assert.equal(scanText(`${opening("efforts")}s>`), undefined);
	assert.equal(scanText("agent-efforts>\n"), undefined);
	assert.equal(scanText("\t<div>\n"), undefined);
	assert.equal(scanText('  <span class="note">\n'), undefined);
	assert.equal(scanText("\t<section id='main'>\n"), undefined);
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
	assert.match(findings[1], /"leak\.txt":1: credential/);
	assert.ok(findings.every((finding) => !finding.includes("sk-ant") && !finding.includes("/home/person")));
	assert.deepEqual(scanRange(root, [`${base}..${base}`]), []);
	const refused = spawnSync(process.execPath, [script, `${base}..HEAD`], { cwd: root, encoding: "utf8" });
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /Publication refused/);
});

test("a range scan finds envelope signatures without echoing attributes", (t) => {
	const { root, git } = repository();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const base = git("rev-parse", "HEAD");
	const blobOpening = opening("request-route", ' scope="fixture-blob-marker"');
	writeFileSync(join(root, "envelope.txt"), `${blobOpening}>\nbody\n`);
	git("add", ".");
	const messageOpening = opening("preferences", " origin='fixture-message-marker'");
	git("commit", "-q", "-m", ["Retained session", `${messageOpening}>`].join("\n"));
	const findings = scanRange(root, [`${base}..HEAD`]);
	assert.equal(findings.length, 2);
	assert.match(findings[0], /commit message line 2: session-transcript/);
	assert.match(findings[1], /"envelope\.txt":1: session-transcript/);
	for (const finding of findings) {
		assert.equal(finding.includes("fixture-blob-marker"), false);
		assert.equal(finding.includes("fixture-message-marker"), false);
		assert.equal(finding.includes("agent-"), false);
	}
});

test("root commits scan both clean and flagged content", (t) => {
	const clean = repository();
	const flagged = repository(["/", "home/fixture/private\n"].join(""));
	t.after(() => { rmSync(clean.root, { recursive: true, force: true }); rmSync(flagged.root, { recursive: true, force: true }); });
	assert.deepEqual(scanRange(clean.root, ["HEAD"]), []);
	const findings = scanRange(flagged.root, ["HEAD"]);
	assert.equal(findings.length, 1);
	assert.match(findings[0], /"ok\.txt":1: personal-path/);
});

test("merge resolutions scan each result path once across parents", (t) => {
	const { root, git } = repository();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const base = git("rev-parse", "HEAD");
	git("checkout", "-qb", "other");
	writeFileSync(join(root, "ok.txt"), "other\n");
	git("commit", "-qam", "Other change");
	git("checkout", "-q", "main");
	writeFileSync(join(root, "ok.txt"), "main\n");
	git("commit", "-qam", "Main change");
	assert.throws(() => git("merge", "other"));
	writeFileSync(join(root, "ok.txt"), "clean resolution\n");
	git("add", "ok.txt");
	git("commit", "-qm", "Resolve conflict");
	assert.deepEqual(scanRange(root, [`${base}..HEAD`]), []);
	writeFileSync(join(root, "ok.txt"), ["/", "home/fixture/private\n"].join(""));
	git("commit", "--amend", "-qam", "Resolve conflict");
	const findings = scanRange(root, [`${base}..HEAD`]);
	assert.equal(findings.length, 1);
	assert.match(findings[0], /"ok\.txt":1: personal-path/);
});

test("rename destinations and unusual paths use exact blob identities", (t) => {
	const { root, git } = repository(["/", "home/fixture/private\n"].join(""));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = ':odd\n\t"name.txt';
	git("mv", "--", "ok.txt", path);
	git("-c", "diff.renames=true", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Rename file");
	const findings = scanRange(root, ["HEAD^..HEAD"]);
	assert.equal(findings.length, 1);
	assert.ok(findings[0].includes(`:${JSON.stringify(path)}:1: personal-path`));
	assert.equal(findings[0].includes("\n"), false);
});

test("type changes scan new blobs and skip gitlink objects", (t) => {
	const { root, git } = repository();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const commit = git("rev-parse", "HEAD");
	git("update-index", "--add", "--cacheinfo", `160000,${commit},link`);
	git("commit", "-qm", "Add gitlink");
	assert.deepEqual(scanRange(root, ["HEAD^..HEAD"]), []);
	writeFileSync(join(root, "payload.txt"), ["/", "home/fixture/private\n"].join(""));
	const blob = git("hash-object", "-w", "payload.txt");
	git("update-index", "--cacheinfo", `100644,${blob},link`);
	git("commit", "-qm", "Replace gitlink with text");
	assert.equal(scanRange(root, ["HEAD^..HEAD"]).length, 1);
	git("update-index", "--cacheinfo", `160000,${commit},link`);
	git("commit", "-qm", "Replace text with gitlink");
	assert.deepEqual(scanRange(root, ["HEAD^..HEAD"]), []);
});

test("the installer uses relative and absolute effective hook directories", (t) => {
	const { root, git } = repository();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const nested = join(root, "nested");
	mkdirSync(nested);
	for (const hooks of ["custom hooks", join(root, "absolute hooks")]) {
		git("config", "core.hooksPath", hooks);
		const expected = git("rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push");
		assert.equal(installHook(nested), expected);
		assert.equal(readFileSync(expected, "utf8"), hookContent());
		assert.equal(existsSync(join(root, ".git", "hooks", "pre-push")), false);
		writeFileSync(expected, "#!/bin/sh\necho shared-owner\n");
		assert.throws(() => installHook(root), /unmanaged hook/);
		assert.equal(readFileSync(expected, "utf8"), "#!/bin/sh\necho shared-owner\n");
	}
});

test("the installer resolves linked-worktree hook context without replacing shared hooks", (t) => {
	const { root, git } = repository();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const worktree = join(root, "linked");
	git("worktree", "add", "-qb", "linked", worktree);
	const shared = git("-C", worktree, "rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push");
	assert.equal(installHook(worktree), shared);
	writeFileSync(shared, "#!/bin/sh\necho shared-owner\n");
	assert.throws(() => installHook(worktree), /unmanaged hook/);
	git("config", "core.hooksPath", "local hooks");
	const local = git("-C", worktree, "rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push");
	assert.equal(installHook(worktree), local);
	assert.equal(local, join(worktree, "local hooks", "pre-push"));
	assert.equal(readFileSync(shared, "utf8"), "#!/bin/sh\necho shared-owner\n");
	git("config", "extensions.worktreeConfig", "true");
	git("-C", worktree, "config", "--worktree", "core.hooksPath", "worktree hooks");
	assert.equal(installHook(worktree), join(worktree, "worktree hooks", "pre-push"));
	assert.equal(installHook(root), join(root, "local hooks", "pre-push"));
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
	assert.equal(path, join(root, ".git", "hooks", "pre-push"));
	assert.equal(readFileSync(path, "utf8"), hookContent());
	assert.equal(installHook(root), path);
	writeFileSync(path, "#!/bin/sh\necho mine\n");
	assert.throws(() => installHook(root), /unmanaged hook/);
});
