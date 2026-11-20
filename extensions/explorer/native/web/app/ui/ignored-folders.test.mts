import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(readFileSync(new URL("./ignored-folders.ts", import.meta.url), "utf8"));
const window = { explorer: {} } as Window;
runInNewContext(source, { window });

function completion() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("ignored children stay lazy, use one in-flight request and refresh only affected folders", async () => {
	type Reply = ExplorerRequests["files.folder"][1];
	const requests: string[] = [];
	let done = completion();
	const list = window.explorer.ignoredFolders(
		async (path) => {
			requests.push(path);
			const entries: Reply["entries"] =
				path === "cache"
					? [
							{ name: "nested", kind: "folder" },
							{ name: "z.log", kind: "file" },
						]
					: [{ name: "leaf.log", kind: "file" }];
			return { entries, truncated: false };
		},
		() => done.resolve(),
	);
	list.replace(["cache/", "private.log"]);
	assert.equal(list.contains("cache"), true);
	assert.equal(list.contains("cache", false), false);
	assert.equal(list.contains("cache/nested/leaf.log", false), true);
	assert.equal(list.contains("cache-old/leaf.log"), false);
	assert.deepEqual(requests, []);
	assert.equal(list.get("cache").pending, true);
	assert.equal(list.get("cache").pending, true);
	await done.promise;
	assert.deepEqual(requests, ["cache"]);
	assert.deepEqual(Array.from(list.loaded()), ["cache/nested/", "cache/z.log"]);
	done = completion();
	list.get("cache/nested");
	await done.promise;
	assert.deepEqual(Array.from(list.invalidate(["cache/nested/leaf.log"])), ["cache/nested"]);
	assert.equal(list.get("cache").pending, false);
	done = completion();
	assert.equal(list.get("cache/nested").pending, true);
	await done.promise;
	assert.deepEqual(requests, ["cache", "cache/nested", "cache/nested"]);
	list.replace([]);
	assert.equal(list.loaded().length, 0);
});
