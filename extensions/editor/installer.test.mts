import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
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
	const palette = join(root, "assets/themes/catppuccin.css");
	mkdirSync(dirname(palette), { recursive: true });
	writeFileSync(palette, "palette");
	return { nativePane, sources, palette, agentDir: join(root, "agent") };
}

function writeBundle({ app, digest }: EditorBuild, mode = 0o755) {
	const executable = join(app, executableInApp);
	const record = join(app, recordInApp);
	mkdirSync(dirname(executable), { recursive: true });
	mkdirSync(dirname(record), { recursive: true });
	writeFileSync(executable, "built app", { mode });
	writeFileSync(record, JSON.stringify({ sourceDigest: digest }));
}

function otherSources(n: number): string {
	return n.toString(16).padStart(64, "0");
}

/** A build of other sources, last changed `minutesAgo` minutes ago. */
function otherSlot(agentDir: string, n: number, minutesAgo: number): string {
	const slot = join(agentDir, "editor-apps", otherSources(n));
	mkdirSync(join(slot, "Editor.app"), { recursive: true });
	const time = new Date(Date.now() - minutesAgo * 60_000);
	utimesSync(slot, time, time);
	return slot;
}

test("Editor caches the app for matching sources and keeps the previous executable on an update", async (t) => {
	const { sources, nativePane, palette, agentDir } = fixture(t);
	let builds = 0;
	const installer = editorAppInstaller(sources, async (build) => {
		builds++;
		assert.equal(build.paneAppearance, join(agentDir, "pane-appearance.json"));
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
	writeFileSync(palette, "changed palette");
	assert.notEqual(await installer(agentDir), next);
	assert.equal(builds, 3);
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

test("a new build removes the builds of other sources that nothing uses", async (t) => {
	const { sources, agentDir } = fixture(t);
	const oldest = otherSlot(agentDir, 1, 50);
	const running = otherSlot(agentDir, 2, 40);
	const building = otherSlot(agentDir, 3, 30);
	mkdirSync(`${building}.lock`);
	const older = otherSlot(agentDir, 4, 20);
	const newer = otherSlot(agentDir, 5, 10);
	const newest = otherSlot(agentDir, 6, 5);
	const unrelated = join(agentDir, "editor-apps", "notes");
	mkdirSync(unrelated);
	const installer = editorAppInstaller(
		sources,
		async (build) => writeBundle(build),
		() => ["/usr/bin/login -pf person", `${join(running, "Editor.app")}/Contents/MacOS/Editor --pane`],
	);
	const executable = await installer(agentDir);
	assert.equal(existsSync(executable), true);
	for (const kept of [running, building, `${building}.lock`, newer, newest, unrelated])
		assert.equal(existsSync(kept), true, kept);
	for (const removed of [oldest, older]) assert.equal(existsSync(removed), false, removed);
});

test("without a process list a build removes no other build", async (t) => {
	const { sources, agentDir } = fixture(t);
	const slots = [1, 2, 3, 4].map((n) => otherSlot(agentDir, n, n * 10));
	const installer = editorAppInstaller(
		sources,
		async (build) => writeBundle(build),
		() => {
			throw new Error("ps failed");
		},
	);
	assert.equal(existsSync(await installer(agentDir)), true);
	for (const slot of slots) assert.equal(existsSync(slot), true, slot);
});

test("an app that already matches its sources removes no other build", async (t) => {
	const { sources, agentDir } = fixture(t);
	let builds = 0;
	const installer = editorAppInstaller(
		sources,
		async (build) => {
			builds++;
			writeBundle(build);
		},
		() => [],
	);
	await installer(agentDir);
	const slots = [1, 2, 3, 4].map((n) => otherSlot(agentDir, n, n * 10));
	await installer(agentDir);
	assert.equal(builds, 1);
	for (const slot of slots) assert.equal(existsSync(slot), true, slot);
});
