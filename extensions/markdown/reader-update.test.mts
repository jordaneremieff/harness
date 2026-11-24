import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { watch } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { EDITOR_WRITER_SOURCES, INSTALL_BUSY, runningReaders } from "./native/build.mts";
import {
	type Ancestry,
	checkReader,
	failedDigest,
	type InstalledBuild,
	readerState,
	readInstalled,
	reportUpdate,
	runUpdate,
	type UpdateOptions,
	type UpdateOutcome,
	type UpdateReporter,
	type UpdateRun,
	updateFiles,
	updateNow,
} from "./reader-update.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
/** A linear history: A, then B. C is unknown to the repository. */
const linear: Ancestry = (ancestor, descendant) => {
	if (ancestor === C || descendant === C) return undefined;
	return ancestor === descendant || (ancestor === A && descendant === B);
};

test("the installed app is replaced on its own unless it is current or built from a later commit", () => {
	const loaded = { digest: "sha256:new", source: { commit: B, modified: false } };
	const state = (installed: InstalledBuild | "missing" | "unreadable") => readerState(installed, loaded, linear);
	assert.deepEqual(state("missing"), { state: "update", reason: "missing" });
	assert.deepEqual(state("unreadable"), { state: "update", reason: "unreadable" });
	assert.deepEqual(state({ digest: "sha256:new", source: { commit: A, modified: false } }), { state: "current" });
	assert.deepEqual(state({ digest: "sha256:old" }), { state: "update", reason: "unrecorded" });
	assert.deepEqual(state({ digest: "sha256:old", source: { commit: A, modified: false } }), {
		state: "update",
		reason: "older",
	});
	assert.deepEqual(state({ digest: "sha256:old", source: { commit: A, modified: true } }), {
		state: "update",
		reason: "modified",
	});
	assert.deepEqual(state({ digest: "sha256:other", source: { commit: C, modified: false } }), {
		state: "update",
		reason: "unordered",
	});
	assert.deepEqual(readerState({ digest: "sha256:other" }, { digest: "sha256:new" }, linear), {
		state: "update",
		reason: "untracked",
	});
	assert.deepEqual(
		readerState(
			{ digest: "sha256:other", source: { commit: A, modified: false } },
			{ digest: "sha256:new", source: { commit: B, modified: true } },
			linear,
		),
		{ state: "update", reason: "modified" },
	);
});

test("only a clean build from a later commit stays installed", () => {
	const loaded = { digest: "sha256:old", source: { commit: A, modified: false } };
	assert.deepEqual(readerState({ digest: "sha256:new", source: { commit: B, modified: false } }, loaded, linear), {
		state: "keep",
		reason: "newer",
	});
	assert.deepEqual(readerState({ digest: "sha256:new", source: { commit: B, modified: true } }, loaded, linear), {
		state: "update",
		reason: "modified",
	});
	assert.deepEqual(readerState({ digest: "sha256:local", source: { commit: A, modified: true } }, loaded, linear), {
		state: "update",
		reason: "modified",
	});
});

function appFixture(t: TestContext, build?: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "markdown-reader-update-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const app = join(root, "markdown-reader", "Markdown Reader.app");
	if (build !== undefined) {
		mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
		writeFileSync(
			join(app, "Contents", "Resources", "build.json"),
			typeof build === "string" ? build : JSON.stringify(build),
		);
	}
	return app;
}

test("build.json supplies the digest and a well-formed source record only", (t) => {
	assert.equal(readInstalled(appFixture(t)), "missing");
	assert.equal(readInstalled(appFixture(t, "{not json")), "unreadable");
	assert.equal(readInstalled(appFixture(t, "[]")), "unreadable");
	assert.deepEqual(readInstalled(appFixture(t, { sourceDigest: "sha256:x" })), { digest: "sha256:x" });
	assert.deepEqual(readInstalled(appFixture(t, { sourceDigest: "sha256:x", source: { commit: A, modified: "no" } })), {
		digest: "sha256:x",
	});
	assert.deepEqual(readInstalled(appFixture(t, { sourceDigest: "sha256:x", source: { commit: A, modified: false } })), {
		digest: "sha256:x",
		source: { commit: A, modified: false },
	});
});

class FakeChild extends EventEmitter {
	pid = 4242;
	unref = () => {};
}

function runFixture(t: TestContext, running = 0) {
	const app = appFixture(t);
	const child = new FakeChild();
	const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
	const options: UpdateOptions = {
		app,
		store: "/store",
		digest: "sha256:loaded",
		busy: INSTALL_BUSY,
		running: () => running,
		nativeDir: "/package/native",
		execPath: "/usr/local/bin/node",
		start: ((command: string, args: string[], spawnOptions: Record<string, unknown>) => {
			calls.push({ command, args, options: spawnOptions });
			return child;
		}) as unknown as UpdateOptions["start"],
	};
	return { app, child, calls, options };
}

test("an update starts a detached worker with its output in the log beside the app", (t) => {
	const f = runFixture(t);
	mkdirSync(join(f.app, ".."), { recursive: true });
	writeFileSync(join(f.app, "..", "update.log"), "earlier run");
	const run = runUpdate(f.options);
	assert.equal(f.calls.length, 1);
	const [call] = f.calls;
	assert.equal(call.command, "/usr/local/bin/node");
	assert.match(call.args[0], /\/markdown\/reader-update\.ts$/u);
	assert.deepEqual(call.args.slice(1), ["--update-worker", "/package/native", f.options.digest, String(INSTALL_BUSY)]);
	assert.equal(call.options.cwd, "/package/native");
	assert.equal(call.options.detached, true);
	assert.equal((call.options.stdio as unknown[]).at(-1), "ipc");
	const env = call.options.env as Record<string, string>;
	assert.equal(env.PI_MARKDOWN_APP, f.app);
	assert.equal(env.PI_MARKDOWN_DIR, "/store");
	assert.equal(run.pid, 4242);
	assert.equal(run.log, updateFiles(f.app).log);
	assert.equal(readFileSync(run.log, "utf8"), "", "each run starts a fresh log");
});

test("Pi reports and records an update worker that did not start", async (t) => {
	const f = runFixture(t);
	const run = runUpdate(f.options);
	f.child.emit("error", new Error("spawn ENOENT"));
	assert.deepEqual(await run.done, {
		status: "failed",
		detail: "the update process did not start: spawn ENOENT",
		log: updateFiles(f.app).log,
	});
	assert.equal(failedDigest(f.app), f.options.digest);
});

function childFixture(t: TestContext, source: string) {
	const app = appFixture(t);
	const nativeDir = dirname(app);
	mkdirSync(nativeDir, { recursive: true });
	writeFileSync(join(nativeDir, "build.mts"), source);
	const module = new URL("./reader-update.ts", import.meta.url).href;
	const store = join(nativeDir, "fixture-store");
	const script = `import { runUpdate } from ${JSON.stringify(module)}; const run = runUpdate({ ...${JSON.stringify({ app, store, nativeDir, digest: "sha256:fixture", busy: INSTALL_BUSY })}, running: () => 2 });`;
	const invoke = (code: string) =>
		execFileSync(process.execPath, ["--input-type=module", "-e", script + code], {
			encoding: "utf8",
			timeout: 4000,
			stdio: ["ignore", "pipe", "pipe"],
		});
	const outcome = (): UpdateOutcome =>
		JSON.parse(
			invoke(
				"const deadline = setTimeout(() => { throw new Error('No result'); }, 3000); console.log(JSON.stringify(await run.done)); clearTimeout(deadline);",
			),
		);
	return { app, nativeDir, invoke, outcome };
}

test("a detached reader update records failure after its Pi process exits", { timeout: 10000 }, async (t) => {
	const f = childFixture(
		t,
		`
		import { existsSync, watch } from "node:fs";
		await new Promise((resolve) => {
			const watcher = watch(".", () => { if (existsSync("release")) { watcher.close(); resolve(); } });
			if (existsSync("release")) { watcher.close(); resolve(); }
		});
		process.exitCode = 42;
	`,
	);
	const child = f.invoke("console.log(run.pid);");
	assert.doesNotThrow(() => process.kill(Number(child.trim()), 0), "the build remains alive without Pi");
	const { failure } = updateFiles(f.app);
	const recorded = (async () => {
		for await (const { filename } of watch(f.nativeDir, { signal: AbortSignal.timeout(2500) })) {
			if (filename === "update-failure.json" && failedDigest(f.app) === "sha256:fixture") {
				return JSON.parse(readFileSync(failure, "utf8"));
			}
		}
	})();
	writeFileSync(join(f.nativeDir, "release"), "");
	assert.match((await recorded).detail, /exited with status 42/u);
});

test("a failed update is recorded against its digest until an update succeeds", (t) => {
	const f = childFixture(t, "process.exitCode = 42;");
	assert.deepEqual(f.outcome(), {
		status: "failed",
		detail: "the build exited with status 42",
		log: updateFiles(f.app).log,
	});
	assert.equal(failedDigest(f.app), "sha256:fixture");
	writeFileSync(join(f.nativeDir, "build.mts"), `process.exitCode = ${INSTALL_BUSY};`);
	assert.deepEqual(f.outcome(), { status: "busy" });
	assert.equal(failedDigest(f.app), "sha256:fixture", "a busy install changes no record");
	writeFileSync(join(f.nativeDir, "build.mts"), "process.exitCode = 0;");
	assert.deepEqual(f.outcome(), { status: "installed", running: 2 });
	assert.equal(failedDigest(f.app), undefined);
});

test("a build failure and a failure-record error both reach Pi without crashing it", async (t) => {
	const f = childFixture(t, "process.exitCode = 42;");
	const files = updateFiles(f.app);
	mkdirSync(files.failure);
	const result = f.outcome();
	assert.equal(result.status, "failed");
	assert.match(result.detail, /exited with status 42/u);
	assert.match(result.recordIssue ?? "", /could not record.+EISDIR/u);
	assert.match(readFileSync(files.log, "utf8"), /could not record.+EISDIR/u);
	const report = reporterFixture();
	reportUpdate(settled(result), report.reporter, false);
	await flush();
	assert.match(report.notices[1][0], /exited with status 42.+could not record.+EISDIR/u);
	assert.equal(report.notices[1][1], true);
});

function reporterFixture(active = true) {
	const notices: [string, boolean | "warning" | undefined][] = [];
	const statuses: (string | undefined)[] = [];
	const reporter: UpdateReporter = {
		notify: (text, error) => notices.push([text, error]),
		status: (text) => statuses.push(text),
		active: () => active,
	};
	return { notices, statuses, reporter };
}
const settled = (outcome: UpdateOutcome): UpdateRun => ({
	pid: 7,
	log: "/apps/update.log",
	done: Promise.resolve(outcome),
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the report names the log, then the outcome and the readers that still run the previous build", async () => {
	const r = reporterFixture();
	reportUpdate(settled({ status: "installed", running: 2 }), r.reporter, false);
	await flush();
	assert.deepEqual(r.statuses, ["Markdown reader update", undefined]);
	assert.deepEqual(r.notices, [
		["Markdown reader app update started in the background; log: /apps/update.log.", undefined],
		[
			"Markdown reader app is up to date; open a new pane to use it. 2 open readers still run the previous build until it closes.",
			"warning",
		],
	]);
	const one = reporterFixture();
	reportUpdate(settled({ status: "installed", running: 1 }), one.reporter, false);
	await flush();
	assert.match(one.notices[1][0], /1 open reader still runs the previous build until it closes\.$/u);
	const none = reporterFixture();
	reportUpdate(settled({ status: "installed", running: 0 }), none.reporter, false);
	await flush();
	assert.equal(none.notices[1][0], "Markdown reader app is up to date; open a new pane to use it.");
});

test("failures are errors, a busy outcome reaches only an explicit request, and an ended session hears nothing", async () => {
	const failed = reporterFixture();
	reportUpdate(
		settled({ status: "failed", detail: "the build exited with status 1", log: "/apps/update.log" }),
		failed.reporter,
		false,
	);
	await flush();
	assert.deepEqual(failed.notices[1], [
		"Markdown reader app update failed: the build exited with status 1; the previous app stays installed. See /apps/update.log and run /markdown update to try again.",
		true,
	]);
	const automatic = reporterFixture();
	reportUpdate(settled({ status: "busy" }), automatic.reporter, false);
	await flush();
	assert.equal(automatic.notices.length, 1);
	const explicit = reporterFixture();
	reportUpdate(settled({ status: "busy" }), explicit.reporter, true);
	await flush();
	assert.match(explicit.notices[1][0], /already running/u);
	const ended = reporterFixture(false);
	reportUpdate(settled({ status: "installed", running: 0 }), ended.reporter, false);
	await flush();
	assert.deepEqual(ended.statuses, ["Markdown reader update"]);
	assert.equal(ended.notices.length, 1);
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync(
		"git",
		["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8" },
	).trim();

/** A Git checkout with the build inputs of the native package, at a second commit. */
function checkoutFixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "markdown-reader-checkout-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const slice = join(root, "extensions", "markdown");
	const native = join(slice, "native");
	const pane = join(root, "native-pane");
	mkdirSync(join(pane, "Sources"), { recursive: true });
	writeFileSync(join(pane, "Package.swift"), "// pane package");
	writeFileSync(join(pane, "Sources", "Pane.swift"), "// pane source");
	for (const dir of ["Sources", "Licenses", "web"]) mkdirSync(join(native, dir), { recursive: true });
	for (const [path, content] of [
		["Package.swift", "// package"],
		["Package.resolved", "{}"],
		["build.mts", "// build"],
		["Sources/main.swift", "// one"],
	])
		writeFileSync(join(native, path), content);
	writeFileSync(join(slice, "pane-command.ts"), "// contract");
	for (const name of EDITOR_WRITER_SOURCES) writeFileSync(join(slice, name), "// writer");
	writeFileSync(join(root, "package-lock.json"), "{}");
	git(root, "init", "-q");
	git(root, "add", ".");
	git(root, "commit", "-q", "-m", "first");
	const first = git(root, "rev-parse", "HEAD");
	writeFileSync(join(native, "Sources", "main.swift"), "// two");
	git(root, "commit", "-q", "-am", "second");
	const second = git(root, "rev-parse", "HEAD");
	return { root, native, first, second };
}

function startup(t: TestContext, native: string, build?: unknown) {
	const app = appFixture(t, build);
	const r = reporterFixture();
	const runs: UpdateOptions[] = [];
	const run = (options: UpdateOptions): UpdateRun => {
		runs.push(options);
		return { pid: 9, log: updateFiles(options.app).log, done: new Promise(() => {}) };
	};
	return {
		app,
		...r,
		runs,
		check: () => checkReader({ app, store: "/store", reporter: r.reporter, nativeDir: native, run }),
	};
}

test("at startup a build from an earlier commit is replaced and a newer one is kept", async (t) => {
	const f = checkoutFixture(t);
	const older = startup(t, f.native, { sourceDigest: "sha256:first", source: { commit: f.first, modified: false } });
	assert.deepEqual(await older.check(), { state: "update", reason: "older" });
	assert.equal(older.runs.length, 1);
	assert.equal(older.runs[0].nativeDir, f.native);
	assert.equal(older.runs[0].busy, INSTALL_BUSY);
	assert.equal(older.runs[0].running, runningReaders);
	assert.match(older.notices[0][0], /^Markdown reader app update started in the background; log: /u);
	const local = startup(t, f.native, { sourceDigest: "sha256:later", source: { commit: f.second, modified: true } });
	assert.deepEqual(await local.check(), { state: "update", reason: "modified" });
	assert.equal(local.runs.length, 1);
	git(f.root, "checkout", "-q", f.first);
	const ahead = startup(t, f.native, { sourceDigest: "sha256:second", source: { commit: f.second, modified: false } });
	assert.deepEqual(await ahead.check(), { state: "keep", reason: "newer" });
	assert.equal(ahead.runs.length + ahead.notices.length, 0);
});

test("at startup uncommitted reader changes and an unknown commit start an update without a manual step", async (t) => {
	const f = checkoutFixture(t);
	const unknown = startup(t, f.native, { sourceDigest: "sha256:other", source: { commit: C, modified: false } });
	assert.deepEqual(await unknown.check(), { state: "update", reason: "unordered" });
	assert.equal(unknown.runs.length, 1);
	assert.equal(unknown.notices.length, 1);
	assert.doesNotMatch(unknown.notices[0][0], /\/markdown update/u);
	writeFileSync(join(f.native, "web", "page.css"), "/* new */");
	const modified = startup(t, f.native, { sourceDigest: "sha256:first", source: { commit: f.first, modified: false } });
	assert.deepEqual(await modified.check(), { state: "update", reason: "modified" });
	assert.equal(modified.runs.length, 1);
	assert.doesNotMatch(modified.notices[0][0], /\/markdown update/u);
});

test("at startup a running install and a failure for the same inputs start nothing", async (t) => {
	const f = checkoutFixture(t);
	const locked = startup(t, f.native);
	mkdirSync(join(locked.app, ".."), { recursive: true });
	writeFileSync(
		join(locked.app, "..", "install.lock"),
		JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
	);
	assert.deepEqual(await locked.check(), { state: "busy" });
	assert.equal(locked.runs.length + locked.notices.length, 0);
	const repeated = startup(t, f.native);
	const first = await repeated.check();
	assert.deepEqual(first, { state: "update", reason: "missing" });
	mkdirSync(join(repeated.app, ".."), { recursive: true });
	writeFileSync(updateFiles(repeated.app).failure, JSON.stringify({ digest: repeated.runs[0].digest }));
	assert.deepEqual(await repeated.check(), { state: "failed" });
	assert.equal(repeated.runs.length, 1);
	assert.match(
		repeated.notices.at(-1)?.[0] ?? "",
		/^Markdown reader app update failed earlier for these sources and was not retried;/u,
	);
	assert.equal(repeated.notices.at(-1)?.[1], true);
});

test("/markdown update installs whatever is installed, unless an install is running", async (t) => {
	const f = checkoutFixture(t);
	const current = startup(t, f.native);
	await updateNow({
		app: current.app,
		store: "/store",
		reporter: current.reporter,
		nativeDir: f.native,
		run: (options) => {
			current.runs.push(options);
			return settled({ status: "installed", running: 0 });
		},
	});
	if (process.platform !== "darwin") {
		assert.equal(current.runs.length, 0);
		return;
	}
	assert.equal(current.runs.length, 1);
	assert.equal(current.runs[0].digest.startsWith("sha256:"), true);
	mkdirSync(join(current.app, ".."), { recursive: true });
	writeFileSync(
		join(current.app, "..", "install.lock"),
		JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
	);
	await updateNow({
		app: current.app,
		store: "/store",
		reporter: current.reporter,
		nativeDir: f.native,
		run: (options) => {
			current.runs.push(options);
			return settled({ status: "installed", running: 0 });
		},
	});
	assert.equal(current.runs.length, 1);
	assert.match(
		current.notices.at(-1)?.[0] ?? "",
		new RegExp(`^Markdown reader app update is already running \\(process ${process.pid}\\)`, "u"),
	);
});
