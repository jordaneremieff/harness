import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSettingsBuild, SettingsUpdater } from "./app-update.ts";
import { sourceDigest } from "./native/build.mts";

async function appFixture() {
	const root = await mkdtemp(join(tmpdir(), "settings-app-test-"));
	const app = join(root, "Settings.app");
	const macos = join(app, "Contents/MacOS");
	const resources = join(app, "Contents/Resources");
	await mkdir(macos, { recursive: true });
	await mkdir(resources);
	const executable = join(macos, "Settings");
	await writeFile(executable, "Fixture", { mode: 0o700 });
	return { root, app, executable, manifest: join(resources, "build.json") };
}

test("accepts only the current manifest format and an executable", async (t) => {
	const { root, app, manifest, executable } = await appFixture();
	t.after(() => rm(root, { recursive: true, force: true }));
	const valid = { contract: 1, settings: 1, source: "/checkout", sourceDigest: `sha256:${"a".repeat(64)}` };
	assert.equal(await readSettingsBuild(app), undefined);
	for (const invalid of [{ contract: 2 }, { settings: 0 }, { source: "relative" }, { sourceDigest: "latest" }]) {
		await writeFile(manifest, JSON.stringify({ ...valid, ...invalid }));
		assert.equal(await readSettingsBuild(app), undefined);
	}
	await writeFile(manifest, JSON.stringify(valid));
	assert.deepEqual(await readSettingsBuild(app), valid);
	await chmod(executable, 0o600);
	assert.equal(await readSettingsBuild(app), undefined);
});

test("a matching installed build does not start an automatic update", {
	skip: process.platform !== "darwin",
}, async (t) => {
	const { root, app, manifest } = await appFixture();
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(
		manifest,
		JSON.stringify({ contract: 1, settings: 1, source: "/checkout", sourceDigest: sourceDigest() }),
	);
	const notices: string[] = [];
	await new SettingsUpdater().check(app, {
		notify: (text) => notices.push(text),
		status: (text) => {
			if (text) notices.push(text);
		},
	});
	assert.deepEqual(notices, []);
});
