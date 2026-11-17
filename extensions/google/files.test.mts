import assert from "node:assert/strict";
import { type FileHandle, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { replacePrivateFile, stageBytes } from "./files.ts";

for (const kind of ["staging", "replacement"] as const) {
	test(`a failed ${kind} write closes its descriptor and removes partial bytes`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "google-files-"));
		const probe = await open(join(root, "probe"), "wx");
		const prototype = Object.getPrototypeOf(probe) as FileHandle;
		await probe.close();
		await rm(join(root, "probe"));
		let failedHandle: FileHandle | undefined;
		t.mock.method(prototype, "writeFile", async function (this: FileHandle) {
			failedHandle = this;
			await this.write("partial");
			throw Object.assign(new Error("synthetic write failure"), { code: "EIO" });
		});
		try {
			await assert.rejects(
				kind === "staging"
					? stageBytes(root, Buffer.from("message"), ".eml")
					: replacePrivateFile(join(root, "ledger.json"), Buffer.from("record")),
				{ code: "EIO" },
			);
			assert.ok(failedHandle);
			assert.equal(failedHandle.fd, -1, "the failed writer must close its descriptor");
			assert.deepEqual(await readdir(root), [], "the failed writer must not retain partial bytes");
		} finally {
			t.mock.restoreAll();
			await failedHandle?.close();
			await rm(root, { recursive: true, force: true });
		}
	});
}
