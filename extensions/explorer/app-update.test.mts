import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	type Ancestry,
	appState,
	ExplorerUpdater,
	type InstallExit,
	type LoadedSource,
	type UpdaterRuntime,
	updateFiles,
} from "./app-update.ts";
import type { PaneBuild } from "./pane-command.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const digest = (n: string) => `sha256:${n.repeat(64)}`;
/** A linear history: A, then B. C is unknown to the repository. */
const linear: Ancestry = async (ancestor, descendant) => {
	if (ancestor === C || descendant === C) return undefined;
	return ancestor === descendant || (ancestor === A && descendant === B);
};
const build = (fields: Partial<PaneBuild>): PaneBuild => ({
	paneOpen: true,
	live: true,
	ignoredOption: true,
	commit: A,
	dirty: false,
	digest: digest("1"),
	...fields,
});

test("the installed app is replaced on its own unless it is current or built from a later commit", async () => {
	const loaded: LoadedSource = { digest: digest("2"), commit: B, dirty: false };
	const state = (installed: PaneBuild | undefined) => appState(installed, loaded, linear);
	assert.deepEqual(await state(undefined), { state: "update", reason: "missing" });
	assert.deepEqual(await state(build({ digest: digest("2") })), { state: "current" });
	assert.deepEqual(await state(build({ digest: null })), { state: "update", reason: "unrecorded" });
	assert.deepEqual(await state(build({ commit: null })), { state: "update", reason: "unrecorded" });
	assert.deepEqual(await state(build({})), { state: "update", reason: "older" });
	assert.deepEqual(await state(build({ dirty: true })), { state: "update", reason: "modified" });
	assert.deepEqual(await state(build({ commit: C })), { state: "update", reason: "unordered" });
	assert.deepEqual(await appState(build({}), { ...loaded, dirty: true }, linear), {
		state: "update",
		reason: "modified",
	});
	assert.deepEqual(await appState(build({}), { ...loaded, commit: null }, linear), {
		state: "update",
		reason: "untracked",
	});
});

test("only a clean build from a later commit stays installed", async () => {
	const loaded: LoadedSource = { digest: digest("1"), commit: A, dirty: false };
	assert.deepEqual(await appState(build({ commit: B, digest: digest("2") }), loaded, linear), {
		state: "keep",
		reason: "newer",
	});
	assert.deepEqual(await appState(build({ commit: B, digest: digest("2"), dirty: true }), loaded, linear), {
		state: "update",
		reason: "modified",
	});
});

function fixture(t: TestContext, installed: PaneBuild | undefined, exits: InstallExit[] = [{ code: 0, signal: null }]) {
	const root = mkdtempSync(join(tmpdir(), "explorer-app-update-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const app = join(root, "explorer-app", "Explorer.app");
	const notices: [string, string][] = [];
	const statuses: (string | undefined)[] = [];
	const starts: string[] = [];
	let current = installed;
	let busy = false;
	const loaded: LoadedSource = { digest: digest("2"), commit: B, dirty: false };
	const runtime: UpdaterRuntime = {
		loaded: async () => loaded,
		installRunning: async () => busy,
		ancestry: linear,
		readBuild: async () => current,
		async start(_app, log) {
			starts.push(log);
			const exit = exits.shift() ?? { code: 0, signal: null };
			if (exit.code === 0) current = build({ commit: B, digest: loaded.digest });
			return { exit: Promise.resolve(exit) };
		},
	};
	return {
		app,
		notices,
		statuses,
		starts,
		loaded,
		setBusy: (value: boolean) => {
			busy = value;
		},
		updater: new ExplorerUpdater(runtime),
		observer: {
			notify: (text: string, level: string) => notices.push([text, level]),
			status: (text?: string) => statuses.push(text),
		},
	};
}

test("an automatic install shows the same status and notices as the other native apps", async (t) => {
	if (process.platform !== "darwin") return;
	const f = fixture(t, build({ commit: C }));
	assert.deepEqual(await f.updater.check(f.app, f.observer), { state: "update", reason: "unordered" });
	const { log } = updateFiles(f.app);
	assert.deepEqual(f.statuses, ["Explorer update", undefined]);
	assert.deepEqual(f.notices, [
		[`Explorer app update started in the background; log: ${log}.`, "info"],
		["Explorer app is up to date; open a new pane to use it.", "info"],
	]);
	assert.equal(f.starts.length, 1);
	assert.deepEqual(await f.updater.check(f.app, f.observer), { state: "current" });
	assert.equal(f.starts.length, 1);
});

test("a failed install is recorded, not retried at startup, and retried by an explicit update", async (t) => {
	if (process.platform !== "darwin") return;
	const f = fixture(t, build({}), [{ code: 1, signal: null }]);
	await f.updater.check(f.app, f.observer);
	const { log, failure } = updateFiles(f.app);
	assert.deepEqual(f.notices.at(-1), [
		`Explorer app update failed: the build exited with status 1; the previous app stays installed. See ${log} and run /explorer update to try again.`,
		"error",
	]);
	assert.equal(JSON.parse(readFileSync(failure, "utf8")).digest, f.loaded.digest);
	assert.deepEqual(await f.updater.check(f.app, f.observer), { state: "failed" });
	assert.equal(f.starts.length, 1);
	assert.match(
		f.notices.at(-1)?.[0] ?? "",
		/^Explorer app update failed earlier for these sources and was not retried;/u,
	);
	await f.updater.check(f.app, f.observer, true);
	assert.equal(f.starts.length, 2);
	assert.equal(existsSync(failure), false);
	assert.equal(f.notices.at(-1)?.[0], "Explorer app is up to date; open a new pane to use it.");
});

test("a running install keeps startup quiet and is reported to an explicit update", async (t) => {
	if (process.platform !== "darwin") return;
	const f = fixture(t, undefined);
	f.setBusy(true);
	assert.deepEqual(await f.updater.check(f.app, f.observer), { state: "busy" });
	assert.equal(f.notices.length + f.starts.length, 0);
	await f.updater.check(f.app, f.observer, true);
	assert.deepEqual(f.notices, [
		["Explorer app update is already running; the installed app stays until it ends.", "info"],
	]);
	f.setBusy(false);
	const lost = fixture(t, undefined, [{ code: 75, signal: null }]);
	await lost.updater.check(lost.app, lost.observer);
	assert.equal(lost.notices.length, 1);
});

test("a failure record that cannot be written is reported with the failure", async (t) => {
	if (process.platform !== "darwin") return;
	const f = fixture(t, build({}), [{ code: null, signal: "SIGKILL" }]);
	mkdirSync(updateFiles(f.app).failure, { recursive: true });
	await f.updater.check(f.app, f.observer);
	assert.match(
		f.notices.at(-1)?.[0] ?? "",
		/^Explorer app update failed: the build stopped on SIGKILL \(the failure record could not be written: EISDIR\);/u,
	);
	writeFileSync(join(f.app, "..", "unused"), "");
});
