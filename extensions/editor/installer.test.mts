import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { editorAppInstaller } from "./installer.ts";
import { type EditorBuild, editorSourceDigest, executableInApp, recordInApp } from "./native/build.mts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "editor-install-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const nativePane = join(root, "native-pane");
	const sources = join(root, "extensions/editor/native");
	for (const pkg of [nativePane, sources]) {
		mkdirSync(join(pkg, "Sources"), { recursive: true });
		writeFileSync(join(pkg, "Package.swift"), "manifest");
		writeFileSync(join(pkg, "Sources", "Source.swift"), "source");
	}
	writeFileSync(join(sources, "build.mts"), "bundle builder");
	return { nativePane, sources, agentDir: join(root, "agent") };
}

function writeBundle({ app, digest }: EditorBuild, mode = 0o755) {
	const executable = join(app, executableInApp);
	const record = join(app, recordInApp);
	mkdirSync(dirname(executable), { recursive: true });
	mkdirSync(dirname(record), { recursive: true });
	writeFileSync(executable, "built app", { mode });
	writeFileSync(record, JSON.stringify({ sourceDigest: digest }));
}

test("Editor caches the app for matching sources and keeps the previous executable on an update", async (t) => {
	const { sources, nativePane, agentDir } = fixture(t);
	let builds = 0;
	const installer = editorAppInstaller(sources, async (build) => {
		builds++;
		writeBundle(build);
	});
	const [first, same] = await Promise.all([installer(agentDir), installer(agentDir)]);
	assert.equal(first, same);
	assert.equal(builds, 1);
	writeFileSync(join(nativePane, "Sources/Source.swift"), "changed shared source");
	const next = await installer(agentDir);
	assert.notEqual(next, first);
	assert.equal(await installer(agentDir), next);
	assert.equal(builds, 2);
	assert.equal(readFileSync(first, "utf8"), "built app");
});

test("a failed or non-executable build leaves a log and never publishes an app", async (t) => {
	const { sources, agentDir } = fixture(t);
	const slot = join(agentDir, "editor-apps", editorSourceDigest(sources));
	const log = join(slot, "build.log");
	const installer = editorAppInstaller(sources, async (build) => {
		writeBundle(build);
		throw new Error("compile failed");
	});
	await assert.rejects(installer(agentDir), (error: Error) => error.message.includes(log));
	assert.deepEqual(readdirSync(slot), ["build.log"]);
	assert.match(readFileSync(log, "utf8"), /compile failed/);

	const retry = editorAppInstaller(sources, async (build) => writeBundle(build, 0o644));
	await assert.rejects(retry(agentDir), /did not build/);
	assert.deepEqual(readdirSync(slot), ["build.log"]);
	assert.match(readFileSync(log, "utf8"), /did not produce an executable/);

	const fixed = editorAppInstaller(sources, async (build) => writeBundle(build));
	const executable = await fixed(agentDir);
	assert.equal(existsSync(executable), true);
	chmodSync(executable, 0o644);
	await assert.rejects(fixed(agentDir), /damaged bundle/);
});
