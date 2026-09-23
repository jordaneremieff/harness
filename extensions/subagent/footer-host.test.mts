import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("publishes nested activity across distinct real-loader working directories", async () => {
	const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./footer-host-child.mts", import.meta.url))], {
		timeout: 45_000, maxBuffer: 1_000_000,
	});
	assert.match(stdout, /footer host: PASS/, `${stdout}\n${stderr}`);
});
