import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { buildCache, EDITOR_WRITER_HELPER, EDITOR_WRITER_SOURCES, editorWriterMetadata, installBundle, lockHolder, lockInstall, prepareBuildCache, removeAbandoned, sourceDigest, sourceRecord, stableNode, stageEditorWriter, stageWeb } from "./native/build.mts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "markdown-install-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const put = (path: string, version: string) => { mkdirSync(path); writeFileSync(join(path, "version"), version); };
	const version = (path: string) => readFileSync(join(path, "version"), "utf8");
	return { root, destination: join(root, "Reader.app"), bundle: join(root, "staged.app"), abandoned: join(root, ".old-012345abcdef"), put, version };
}

test("the native test command runs Swift suites without parallel scheduling", (t) => {
	const f = fixture(t);
	const argumentsPath = join(f.root, "swift-arguments");
	writeFileSync(join(f.root, "xcode-select"), '#!/bin/sh\nprintf "%s\\n" "$DEVELOPER_DIR"\n', { mode: 0o755 });
	writeFileSync(join(f.root, "swift"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$SWIFT_ARGUMENTS"\n', { mode: 0o755 });
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("./native/build.mts", import.meta.url)), "test"], {
		env: { ...process.env, PATH: `${f.root}:${process.env.PATH ?? ""}`, DEVELOPER_DIR: f.root, SWIFT_ARGUMENTS: argumentsPath },
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(readFileSync(argumentsPath, "utf8").trim().split("\n"), ["test", "--no-parallel"]);
});

test("an install replaces the app and removes the previous bundle", (t) => {
	const f = fixture(t);
	f.put(f.destination, "previous"); f.put(f.bundle, "new");
	installBundle(f.bundle, f.destination);
	assert.equal(f.version(f.destination), "new");
	assert.deepEqual(readdirSync(f.root), ["Reader.app"]);
});

test("an install first restores the bundle that an interrupted install moved aside", (t) => {
	const f = fixture(t);
	f.put(f.abandoned, "previous"); f.put(f.bundle, "new");
	const renames: [string, string][] = [];
	installBundle(f.bundle, f.destination, (from, to) => { renames.push([from, to]); renameSync(from, to); });
	assert.deepEqual(renames[0], [f.abandoned, f.destination]);
	assert.equal(f.version(f.destination), "new");
	assert.deepEqual(readdirSync(f.root), ["Reader.app"]);
});

test("a failed final rename leaves the previous app at its destination", (t) => {
	for (const previous of ["destination", "abandoned"] as const) {
		const f = fixture(t);
		f.put(f[previous], "previous");
		assert.throws(() => installBundle(f.bundle, f.destination), { code: "ENOENT" });
		assert.equal(f.version(f.destination), "previous");
		assert.deepEqual(readdirSync(f.root), ["Reader.app"]);
	}
});

test("a failed restoration keeps the previous bundle and reports both errors", (t) => {
	const f = fixture(t);
	f.put(f.destination, "previous"); f.put(f.bundle, "new");
	const installError = new Error("final rename refused");
	const restoreError = new Error("restore rename refused");
	let backup = "";
	assert.throws(() => installBundle(f.bundle, f.destination, (from, to) => {
		if (from === f.destination) { backup = to; renameSync(from, to); }
		else if (from === f.bundle) throw installError;
		else throw restoreError;
	}), (error: unknown) => {
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(error.errors, [installError, restoreError]);
		assert.match(error.message, /final rename refused.*restore rename refused/u);
		assert.ok(error.message.includes(backup));
		return true;
	});
	assert.equal(f.version(backup), "previous");
	assert.equal(existsSync(f.destination), false);
});

test("an existing app never gives way to a bundle that an earlier install moved aside", (t) => {
	const f = fixture(t);
	f.put(f.destination, "current"); f.put(f.abandoned, "abandoned"); f.put(f.bundle, "new");
	installBundle(f.bundle, f.destination);
	assert.equal(f.version(f.destination), "new");
	assert.equal(f.version(f.abandoned), "abandoned");
});

function editorFixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "markdown-editor-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const app = join(root, "Reader.app");
	const resources = join(app, "Contents", "Resources");
	const store = join(root, "store");
	mkdirSync(resources, { recursive: true });
	mkdirSync(store);
	return { root, app, resources, store, helper: join(resources, EDITOR_WRITER_HELPER) };
}

function manifest(path: string): { name: string; version: string; license: string; main: string } {
	return JSON.parse(readFileSync(path, "utf8"));
}

test("staging ships the writer as stripped modules with the resolved lockfile closure", (t) => {
	const f = editorFixture(t);
	stageEditorWriter(f.resources);
	const helper = readFileSync(f.helper, "utf8");
	assert.ok(helper.includes(`from "./editor-write.mjs"`), "the helper imports the shipped write module");
	assert.ok(!helper.includes(".ts"), "no local .ts import survives staging");
	const nodeModules = join(f.resources, "editor-writer", "node_modules");
	assert.deepEqual(readdirSync(nodeModules), ["graceful-fs", "proper-lockfile", "signal-exit"]);
	assert.deepEqual(readdirSync(join(nodeModules, "proper-lockfile", "node_modules")), ["retry"], "proper-lockfile resolves its own retry version");
	const lockfile = manifest(join(nodeModules, "proper-lockfile", "package.json"));
	assert.equal(lockfile.version, "4.1.2");
	assert.equal(lockfile.license, "MIT");
	assert.equal(manifest(join(nodeModules, "proper-lockfile", "node_modules", "retry", "package.json")).version, "0.12.0");
	assert.equal(manifest(join(nodeModules, "graceful-fs", "package.json")).license, "ISC");
	assert.equal(manifest(join(nodeModules, "signal-exit", "package.json")).license, "ISC");
	for (const licence of ["proper-lockfile/LICENSE", "proper-lockfile/node_modules/retry/License", "graceful-fs/LICENSE", "signal-exit/LICENSE.txt"]) {
		assert.ok(existsSync(join(nodeModules, ...licence.split("/"))), `licence shipped: ${licence}`);
	}
});

test("the staged helper runs the identity operation without the checkout", (t) => {
	const f = editorFixture(t);
	stageEditorWriter(f.resources);
	const result = spawnSync(process.execPath, [realpathSync(f.helper)], {
		cwd: f.root,
		input: `${JSON.stringify({ version: 1, operation: "identity", storeRoot: f.store })}\n`,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	const receipt = JSON.parse(result.stdout);
	assert.deepEqual(
		{ ok: receipt.ok, status: receipt.status, version: receipt.version },
		{ ok: true, status: "identity", version: 1 },
	);
	assert.match(receipt.storeId, /^[0-9a-f]{32}$/u);
	assert.equal(JSON.parse(readFileSync(join(f.store, "store.json"), "utf8")).storeId, receipt.storeId);
});

test("the shipped writer saves and reconciles with a parser protocol fixture outside the checkout", (t) => {
	const f = editorFixture(t);
	stageEditorWriter(f.resources);
	const bin = join(f.app, "Contents", "MacOS");
	mkdirSync(bin);
	writeFileSync(join(f.resources, "build.json"), JSON.stringify({ contract: 1 }));
	writeFileSync(join(bin, "markdown-core"), `#!/bin/sh\nprintf '%s\\n' '{"version":1,"images":[],"links":[],"truncated":false}'\n`, { mode: 0o755 });
	const invoke = (request: unknown) => {
		const result = spawnSync(process.execPath, [realpathSync(f.helper)], {
			cwd: f.root, input: JSON.stringify(request), encoding: "utf8",
			env: { PATH: "/usr/bin:/bin" }, timeout: 5000, maxBuffer: 1024 * 1024,
		});
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	};
	const identity = invoke({ version: 1, operation: "identity", storeRoot: f.store });
	const request = {
		version: 1, operation: "save", storeRoot: f.store, storeId: identity.storeId,
		invocationId: "standalone-save", generation: 7, title: "Private draft", source: "# Exact draft\r\n",
	};
	const saved = invoke(request);
	assert.equal(saved.status, "saved", JSON.stringify(saved));
	assert.equal(saved.generation, 7);
	assert.equal(saved.revision, 1);
	const reconciled = invoke({ ...request, operation: "reconcile" });
	assert.equal(reconciled.status, "saved");
	assert.equal(reconciled.document, saved.document);
	assert.equal(reconciled.digest, saved.digest);
	assert.equal(reconciled.revision, 1);
	const replayed = invoke(request);
	assert.equal(replayed.replayed, true);
	assert.equal(replayed.revision, 1);
});

test("the writer helper has one fixed identity record naming the bundled helper and the installer's Node", () => {
	assert.deepEqual(editorWriterMetadata("/opt/homebrew/bin/node"), { version: 1, node: "/opt/homebrew/bin/node", helper: "editor-writer/editor-helper.mjs" });
	const metadata = editorWriterMetadata();
	assert.ok(isAbsolute(metadata.node), "the recorded Node executable is absolute");
});

function digestFixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "markdown-digest-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sourceDir = join(root, "extensions", "markdown");
	const native = join(sourceDir, "native");
	const pane = join(root, "native-pane");
	mkdirSync(join(pane, "Sources"), { recursive: true });
	writeFileSync(join(pane, "Package.swift"), "// pane package");
	writeFileSync(join(pane, "Sources", "Pane.swift"), "// pane source");
	mkdirSync(join(native, "Sources"), { recursive: true });
	mkdirSync(join(native, "Licenses"));
	mkdirSync(join(native, "web"));
	writeFileSync(join(native, "Package.swift"), "// package");
	writeFileSync(join(native, "Package.resolved"), "{}");
	writeFileSync(join(native, "build.mts"), "// build");
	writeFileSync(join(root, "package-lock.json"), "{}");
	writeFileSync(join(sourceDir, "pane-command.ts"), "// contract");
	for (const name of EDITOR_WRITER_SOURCES) writeFileSync(join(sourceDir, name), "// original");
	return { root, native, write: (name: string, content: string) => writeFileSync(join(sourceDir, name), content) };
}

test("writer sources and build.mts are part of the build identity", (t) => {
	const f = digestFixture(t);
	const before = sourceDigest(f.native);
	f.write("editor-write.ts", "// changed writer source");
	assert.notEqual(sourceDigest(f.native), before, "a writer source change changes the build identity");
	f.write("editor-write.ts", "// original");
	f.write("reference-capture.ts", "// changed writer source");
	assert.notEqual(sourceDigest(f.native), before, "a capture source change changes the build identity");
	f.write("reference-capture.ts", "// original");
	writeFileSync(join(f.native, "build.mts"), "// changed build");
	assert.notEqual(sourceDigest(f.native), before, "a build.mts change changes the build identity");
	writeFileSync(join(f.native, "build.mts"), "// build");
	f.write("pane-command.ts", "// changed contract");
	assert.notEqual(sourceDigest(f.native), before, "the pane contract changes the build identity");
	f.write("pane-command.ts", "// contract");
	writeFileSync(join(f.root, "package-lock.json"), "{\"lockfileVersion\":3}");
	assert.notEqual(sourceDigest(f.native), before, "the runtime dependency lock changes the build identity");
	const beforePane = sourceDigest(f.native);
	writeFileSync(join(f.native, "../../../native-pane/Sources/Pane.swift"), "// new pane source");
	assert.notEqual(sourceDigest(f.native), beforePane, "a shared pane source changes the build identity");
});

test("staging copies the real writer sources of this checkout", (t) => {
	const f = editorFixture(t);
	const sourceDir = dirname(fileURLToPath(import.meta.url));
	stageEditorWriter(f.resources, sourceDir);
	const shipped = readFileSync(join(f.resources, "editor-writer", "store.mjs"), "utf8");
	assert.ok(shipped.includes("proper-lockfile"), "the shipped store module keeps its lockfile dependency");
	assert.ok(shipped.includes("MarkdownStore"), "the shipped store module is the checkout's source");
	for (const name of EDITOR_WRITER_SOURCES) {
		assert.ok(existsSync(join(f.resources, "editor-writer", name.replace(/\.ts$/, ".mjs"))), `shipped: ${name}`);
	}
});

function webFixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "markdown-web-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "web");
	const resources = join(root, "Reader.app", "Contents", "Resources");
	mkdirSync(source, { recursive: true });
	mkdirSync(resources, { recursive: true });
	return { root, source, resources, web: join(resources, "web") };
}

test("staging ships the web page with stripped scripts and without test inputs", (t) => {
	const f = webFixture(t);
	writeFileSync(join(f.source, "index.html"), "<!doctype html><title>Reader</title>");
	mkdirSync(join(f.source, "styles"));
	writeFileSync(join(f.source, "styles", "site.css"), "body { color: black; }");
	mkdirSync(join(f.source, "assets"));
	writeFileSync(join(f.source, "assets", "logo.svg"), "<svg></svg>");
	mkdirSync(join(f.source, "scripts"));
	writeFileSync(join(f.source, "scripts", "app.ts"), "const message: string = \"hello\";\nconsole.log(message);\n");
	writeFileSync(join(f.source, "scripts", "app.test.ts"), "// test");
	writeFileSync(join(f.source, "scripts", "app.test.mts"), "// node test");
	writeFileSync(join(f.source, "scripts", "module.mts"), "// module");
	writeFileSync(join(f.source, "scripts", "types.d.ts"), "export type Value = string;");
	writeFileSync(join(f.source, ".hidden"), "secret");
	mkdirSync(join(f.source, "test"));
	writeFileSync(join(f.source, "test", "helper.js"), "// test helper");
	mkdirSync(join(f.source, "__tests__"));
	writeFileSync(join(f.source, "__tests__", "page.js"), "// test page");
	mkdirSync(join(f.source, "nested"));
	writeFileSync(join(f.source, "nested", "notes.spec.js"), "// spec");

	stageWeb(f.resources, f.source);

	assert.equal(readFileSync(join(f.web, "index.html"), "utf8"), "<!doctype html><title>Reader</title>");
	assert.equal(readFileSync(join(f.web, "styles", "site.css"), "utf8"), "body { color: black; }");
	assert.equal(readFileSync(join(f.web, "assets", "logo.svg"), "utf8"), "<svg></svg>");
	const script = readFileSync(join(f.web, "scripts", "app.js"), "utf8");
	assert.ok(script.includes("const message"), "the script is stripped and shipped as .js");
	assert.ok(!script.includes(": string"), "the script keeps no type annotation");
	assert.deepEqual(readdirSync(join(f.web, "scripts")), ["app.js"]);
	for (const path of ["scripts/app.ts", "scripts/app.test.ts", "scripts/app.test.mts", "scripts/module.mts", "scripts/types.d.ts", ".hidden", "test", "__tests__", "nested/notes.spec.js"]) {
		assert.equal(existsSync(join(f.web, ...path.split("/"))), false, `not staged: ${path}`);
	}
});

test("staging fails clearly when the web page has no index", (t) => {
	const f = webFixture(t);
	mkdirSync(join(f.source, "styles"));
	writeFileSync(join(f.source, "styles", "site.css"), "body { color: black; }");
	assert.throws(() => stageWeb(f.resources, f.source), /web source has no entry page: .*index\.html is missing/u);
	assert.equal(existsSync(join(f.web, "index.html")), false);
});

test("the embedded web page is part of the build identity", (t) => {
	const f = digestFixture(t);
	writeFileSync(join(f.native, "web", "index.html"), "<!doctype html>");
	const before = sourceDigest(f.native);
	writeFileSync(join(f.native, "web", "index.html"), "<!doctype html><p>changed</p>");
	const changedPage = sourceDigest(f.native);
	assert.notEqual(changedPage, before, "a web page change changes the build identity");
	mkdirSync(join(f.native, "web", "assets"));
	writeFileSync(join(f.native, "web", "assets", "app.js"), "console.log(1);");
	assert.notEqual(sourceDigest(f.native), changedPage, "a web asset change changes the build identity");
});

test("an install builds in the cache beside the app, so no source checkout keeps build output", () => {
	assert.equal(buildCache("/agent/markdown-reader/Markdown Reader.app"), "/agent/markdown-reader/build-cache");
});

test("the build cache serves one checkout and starts again empty for another", (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "markdown-cache-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cache = join(root, "build-cache");
	const first = join(root, "first", "native");
	const second = join(root, "second", "native");
	mkdirSync(first, { recursive: true });
	mkdirSync(second, { recursive: true });
	assert.equal(prepareBuildCache(cache, first), true, "a new cache belongs to its first checkout");
	writeFileSync(join(cache, "object.o"), "first build");
	assert.equal(prepareBuildCache(cache, first), false);
	assert.ok(existsSync(join(cache, "object.o")), "the same checkout builds incrementally");
	assert.equal(prepareBuildCache(cache, second), true);
	assert.equal(existsSync(join(cache, "object.o")), false, "another checkout never meets earlier objects");
	assert.equal(readFileSync(join(cache, ".source-root"), "utf8"), second);
	symlinkSync(second, join(root, "link"));
	assert.equal(prepareBuildCache(cache, join(root, "link")), false, "the checkout is identified by its real path");
});

test("the source record names the commit and whether a build input differs from it", () => {
	const commit = "0123456789abcdef0123456789abcdef01234567";
	const calls: string[][] = [];
	const git = (status: string | undefined, head: string | null = commit) => (_cwd: string, args: string[]) => {
		calls.push(args);
		return args[0] === "rev-parse" ? (head ?? undefined) : status;
	};
	assert.deepEqual(sourceRecord("/native", git("")), { commit, modified: false });
	assert.deepEqual(sourceRecord("/native", git(" M web/page.css")), { commit, modified: true });
	assert.equal(sourceRecord("/native", git("", null)), undefined, "outside a Git work tree");
	assert.equal(sourceRecord("/native", git("", "not a commit")), undefined);
	assert.equal(sourceRecord("/native", git(undefined)), undefined);
	const status = calls.find((args) => args[0] === "status");
	assert.ok(status);
	for (const input of [".", "../pane-command.ts", "../../../package-lock.json", "../../rex/terminal-origin.ts", ...EDITOR_WRITER_SOURCES.map((name) => `../${name}`)]) {
		assert.ok(status.includes(input), `${input} is a checked build input`);
	}
});

test("the writer's Node is recorded by the PATH link that resolves to the running Node", (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "markdown-node-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const versioned = join(root, "Cellar", "node", "25.2.1", "bin");
	mkdirSync(versioned, { recursive: true });
	writeFileSync(join(versioned, "node"), "");
	const other = join(root, "other");
	mkdirSync(other);
	writeFileSync(join(other, "node"), "");
	const links = join(root, "bin");
	mkdirSync(links);
	symlinkSync(join(versioned, "node"), join(links, "node"));
	const running = join(versioned, "node");
	assert.equal(stableNode(running, ["relative/bin", other, links].join(delimiter)), join(links, "node"));
	assert.equal(stableNode(running, other), running, "without a PATH link, the running executable");
	assert.equal(stableNode(join(root, "missing", "node"), links), join(root, "missing", "node"));
});

test("an install lock admits one install and passes from an ended or expired holder", (t) => {
	const parent = mkdtempSync(join(tmpdir(), "markdown-lock-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const release = lockInstall(parent, () => true);
	assert.ok(release);
	assert.equal(lockInstall(parent, () => true), undefined, "a live holder keeps the lock");
	assert.equal(lockHolder(parent, () => true)?.pid, process.pid);
	release();
	assert.equal(existsSync(join(parent, "install.lock")), false);
	writeFileSync(join(parent, "install.lock"), JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }));
	assert.equal(lockHolder(parent, () => false), undefined);
	const takeover = lockInstall(parent, () => false);
	assert.ok(takeover, "the lock of an ended process passes");
	takeover();
	writeFileSync(join(parent, "install.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }));
	assert.equal(lockHolder(parent, () => true), undefined, "an expired lock has no holder");
	const expired = lockInstall(parent, () => true);
	assert.ok(expired);
	expired();
	writeFileSync(join(parent, "install.lock"), "not json");
	assert.equal(lockHolder(parent), undefined);
});

test("leftovers of an interrupted install go, but a moved-aside bundle stays while the app is missing", (t) => {
	const f = fixture(t);
	const staging = join(f.root, ".tmp-0123456789ab");
	mkdirSync(join(staging, "Markdown Reader.app"), { recursive: true });
	mkdirSync(f.abandoned);
	mkdirSync(join(f.root, "build-cache"));
	mkdirSync(join(f.root, ".tmp-short"));
	assert.deepEqual(removeAbandoned(f.root, f.destination), [".tmp-0123456789ab"]);
	assert.ok(existsSync(f.abandoned), "installBundle restores this bundle");
	f.put(f.destination, "current");
	assert.deepEqual(removeAbandoned(f.root, f.destination), [".old-012345abcdef"]);
	assert.ok(existsSync(join(f.root, "build-cache")));
	assert.ok(existsSync(join(f.root, ".tmp-short")));
	assert.equal(f.version(f.destination), "current");
});
