import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { type AppNoticeLevel, ComposerApp } from "./app-update.ts";

const digest = `sha256:${"a".repeat(64)}`;
const commit = "b".repeat(40);
const older = "c".repeat(40);
const newer = "d".repeat(40);
function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "composer-build-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const app = join(dir, "Test.app");
	const resources = join(app, "Contents", "Resources");
	const write = (options = {}) => {
		mkdirSync(resources, { recursive: true });
		writeFileSync(
			join(resources, "build.json"),
			JSON.stringify({
				contract: 1,
				composer: 1,
				sourceDigest: digest,
				source: { commit, modified: false },
				...options,
			}),
		);
	};
	type Outcome = "installed" | "busy" | "failed";
	let settle!: (value: Outcome) => void;
	const install = new Promise<Outcome>((resolve) => {
		settle = resolve;
	});
	let starts = 0;
	const runtime = {
		load: async () => ({
			sourceDigest: () => digest,
			sourceRecord: () => ({ commit, modified: false }),
			INSTALL_BUSY: 75,
		}),
		ancestor: (left: string, right: string) => left === older && right === commit,
		async install(target: string, busyCode: number) {
			assert.equal(target, app);
			assert.equal(busyCode, 75);
			starts++;
			return install;
		},
	};
	const notices: { text: string; level: AppNoticeLevel }[] = [];
	return {
		app,
		write,
		settle,
		runtime,
		updater: new ComposerApp(runtime),
		starts: () => starts,
		notices,
		notify: (text: string, level: AppNoticeLevel) => {
			notices.push({ text, level });
		},
	};
}

test("missing app starts one background install and opens after the manifest is ready", async (t) => {
	const f = fixture(t);
	const checks = await Promise.all([f.updater.check(f.app, f.notify), f.updater.check(f.app, f.notify)]);
	assert.deepEqual(checks, [
		{ state: "started" },
		{ state: "blocked", message: "A Composer app build is already in progress.", level: "info" },
	]);
	assert.equal(f.starts(), 1);
	assert.deepEqual(f.notices, [
		{ text: `The Composer app build started in the background (log: ${f.app}.update.log).`, level: "info" },
	]);
	f.write();
	f.settle("installed");
	await setImmediate();
	assert.deepEqual(f.notices.at(-1), { text: "The Composer app build completed.", level: "info" });
	assert.equal(await f.updater.check(f.app, f.notify), undefined);
});

test("older or incompatible builds update, but current or newer builds open", async (t) => {
	const f = fixture(t);
	f.write();
	assert.equal(await f.updater.check(f.app, f.notify), undefined);
	const differing = `sha256:${"0".repeat(64)}`;
	f.write({ sourceDigest: differing, source: { commit: newer, modified: false } });
	assert.equal(await f.updater.check(f.app, f.notify), undefined);
	f.write({ sourceDigest: differing, source: { commit: older, modified: false } });
	assert.deepEqual(await f.updater.check(f.app, f.notify), { state: "started" });
	f.settle("busy");
	await setImmediate();
	assert.deepEqual(f.notices.at(-1), { text: "A Composer app build is already in progress.", level: "info" });
	assert.equal(existsSync(`${f.app}.update-failure.json`), false);
	f.write({ composer: undefined });
	assert.deepEqual(await new ComposerApp(f.runtime).check(f.app, f.notify), { state: "started" });
	await setImmediate();
	assert.equal(f.starts(), 2);
});

test("failure survives a new loader and explicit update bypasses the failure record", async (t) => {
	const f = fixture(t);
	await f.updater.check(f.app, f.notify);
	f.settle("failed");
	await setImmediate();
	assert.deepEqual(f.notices.at(-1), {
		text: `The Composer app build failed; see ${f.app}.update.log and retry with /composer update.`,
		level: "error",
	});
	const next = new ComposerApp(f.runtime);
	assert.deepEqual(await next.check(f.app, f.notify), {
		state: "blocked",
		message: "The previous Composer app build failed; retry with /composer update.",
		level: "warning",
	});
	assert.equal(f.starts(), 1);
	assert.deepEqual(await next.check(f.app, f.notify, true), { state: "started" });
	await setImmediate();
	assert.equal(f.starts(), 2);
});

test("an already current app stays usable during an explicit update", async (t) => {
	const f = fixture(t);
	f.write();
	assert.deepEqual(await f.updater.check(f.app, f.notify, true), { state: "started" });
	assert.equal(await f.updater.check(f.app, f.notify), undefined);
	f.settle("installed");
	await setImmediate();
	assert.equal(f.starts(), 1);
});
