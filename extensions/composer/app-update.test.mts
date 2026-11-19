import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { ComposerApp } from "./app-update.ts";

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
	const notices: string[] = [];
	return {
		app,
		write,
		settle,
		runtime,
		updater: new ComposerApp(runtime),
		starts: () => starts,
		notices,
		notify: (message: string) => {
			notices.push(message);
		},
	};
}

test("missing app starts one background install and opens after the manifest is ready", async (t) => {
	const f = fixture(t);
	const checks = await Promise.all([f.updater.check(f.app, f.notify), f.updater.check(f.app, f.notify)]);
	assert.deepEqual(checks, Array(2).fill("The composer app is being installed."));
	assert.equal(f.starts(), 1);
	assert.equal(f.notices.length, 1);
	f.write();
	f.settle("installed");
	await setImmediate();
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
	assert.match((await f.updater.check(f.app, f.notify)) ?? "", /being installed/u);
	f.settle("busy");
	await setImmediate();
	assert.match(f.notices.at(-1) ?? "", /Another composer app install/u);
	assert.equal(existsSync(`${f.app}.update-failure.json`), false);
	f.write({ composer: undefined });
	assert.match((await new ComposerApp(f.runtime).check(f.app, f.notify)) ?? "", /being installed/u);
	await setImmediate();
	assert.equal(f.starts(), 2);
});

test("failure survives a new loader and explicit update bypasses the failure record", async (t) => {
	const f = fixture(t);
	await f.updater.check(f.app, f.notify);
	f.settle("failed");
	await setImmediate();
	const next = new ComposerApp(f.runtime);
	assert.match((await next.check(f.app, f.notify)) ?? "", /last composer app build failed/u);
	assert.equal(f.starts(), 1);
	assert.match((await next.check(f.app, f.notify, true)) ?? "", /being installed/u);
	await setImmediate();
	assert.equal(f.starts(), 2);
});

test("an already current app stays usable during an explicit update", async (t) => {
	const f = fixture(t);
	f.write();
	assert.match((await f.updater.check(f.app, f.notify, true)) ?? "", /being installed/u);
	assert.equal(await f.updater.check(f.app, f.notify), undefined);
	f.settle("installed");
	await setImmediate();
	assert.equal(f.starts(), 1);
});
