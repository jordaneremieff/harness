import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

test("every tracked immediate prompt TypeScript source is a compiler root and program source", () => {
	const configuration = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
	assert.equal(configuration.error, undefined);
	const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, root);
	assert.deepEqual(parsed.errors, []);
	const expected = execFileSync("git", ["ls-files", "-z", "--", "prompts"], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
	}).split("\0").filter((path) => /^prompts\/[^/]+\.(?:ts|mts)$/.test(path)).map((path) => resolve(root, path));
	assert.ok(expected.length > 0, "tracked prompt TypeScript sources exist");
	const roots = new Set(parsed.fileNames.map((path) => resolve(path)));
	const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
	for (const path of expected) {
		assert.ok(roots.has(path), `${relative(root, path)} is a compiler root`);
		assert.ok(program.getSourceFile(path), `${relative(root, path)} is in the compiler program`);
	}
});
