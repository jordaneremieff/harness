import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

interface PackageDependencies {
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	dev?: boolean;
	peer?: boolean;
}

const manifest: PackageDependencies = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const lock: { packages: Record<string, PackageDependencies> } = JSON.parse(
	readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
);

test("detached transport packages survive managed installs that omit dev and peer dependencies", () => {
	for (const name of ["@earendil-works/chord", "@earendil-works/pi-client", "@earendil-works/pi-server"]) {
		assert.equal(manifest.dependencies?.[name], "*", `${name} must be a direct runtime dependency`);
		assert.equal(manifest.peerDependencies?.[name], undefined, `${name} is not supplied by Pi's loader`);
		assert.equal(lock.packages[""].dependencies?.[name], manifest.dependencies?.[name], `${name} lockfile declaration`);
		assert.equal(lock.packages[""].peerDependencies?.[name], undefined, `${name} lockfile peer declaration`);
		const installed = lock.packages[`node_modules/${name}`];
		assert.ok(installed, `${name} must have a locked package`);
		assert.notEqual(installed.dev, true, `${name} must not be dev-only`);
		assert.notEqual(installed.peer, true, `${name} must not be peer-only`);
	}
});
