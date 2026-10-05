import assert from "node:assert/strict";
import { it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { managedRelease, installPeerResolver } from "./terminal.ts";

function release(root: string, version: string): void {
	const packageDir = join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: { ".": { import: "./index.mjs", require: "./require-only.cjs" }, "./public": { import: "./index.mjs" } } }));
	writeFileSync(join(packageDir, "index.mjs"), `export const selected = ${JSON.stringify(version)};`);
}

it("managed bootstrap rereads current-version and rejects path traversal", () => {
	const root = mkdtempSync(join(tmpdir(), "agent-terminal-install-"));
	try {
		release(root, "first"); release(root, "second");
		writeFileSync(join(root, "current-version"), "first\n");
		assert.equal(managedRelease({ PI_MANAGED_INSTALL_ROOT: root }).anchor, pathToFileURL(join(realpathSync(root), "releases", "first", "entry.mjs")).href);
		writeFileSync(join(root, "current-version"), "second");
		assert.equal(managedRelease({ PI_MANAGED_INSTALL_ROOT: root }).anchor, pathToFileURL(join(realpathSync(root), "releases", "second", "entry.mjs")).href);
		writeFileSync(join(root, "current-version"), "../escape");
		assert.throws(() => managedRelease({ PI_MANAGED_INSTALL_ROOT: root }), /invalid/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("managed bootstrap finds the executable launcher without creating a symlink", () => {
	const home = mkdtempSync(join(tmpdir(), "agent-terminal-launcher-"));
	try {
		const root = join(home, "install"); const bin = join(home, "bin");
		release(root, "current"); mkdirSync(bin); writeFileSync(join(root, "current-version"), "current");
		writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "pi"), 0o700);
		assert.equal(managedRelease({ PATH: [join(home, "absent"), bin].join(delimiter) }).root, realpathSync(root));
		assert.throws(() => managedRelease({ PATH: join(home, "absent") }), /launcher not found/);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

it("public peer resolution keeps ESM import conditions and checkout Durable resolution", async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-terminal-peers-"));
	let hook: { deregister(): void } | undefined;
	try {
		release(root, "esm-only"); writeFileSync(join(root, "current-version"), "esm-only");
		const durable = import.meta.resolve("@earendil-works/pi-durable");
		hook = installPeerResolver(managedRelease({ PI_MANAGED_INSTALL_ROOT: root }).anchor);
		const peer = await import("@earendil-works/pi-coding-agent") as unknown as { selected: string };
		assert.equal(peer.selected, "esm-only");
		assert.equal(import.meta.resolve("@earendil-works/pi-coding-agent/public"), pathToFileURL(join(realpathSync(root), "releases", "esm-only", "node_modules", "@earendil-works", "pi-coding-agent", "index.mjs")).href);
		assert.equal(import.meta.resolve("@earendil-works/pi-durable"), durable);
	} finally { hook?.deregister(); rmSync(root, { recursive: true, force: true }); }
});
