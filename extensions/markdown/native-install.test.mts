import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { installBundle } from "./native/build.mts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "markdown-install-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const put = (path: string, version: string) => { mkdirSync(path); writeFileSync(join(path, "version"), version); };
	const version = (path: string) => readFileSync(join(path, "version"), "utf8");
	return { root, destination: join(root, "Reader.app"), bundle: join(root, "staged.app"), abandoned: join(root, ".old-012345abcdef"), put, version };
}

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
