import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCodemodeSource } from "@earendil-works/pi-codemode";

const root = fileURLToPath(new URL("..", import.meta.url));

test("maintained codemode recipes parse their options before their source", () => {
	for (const path of ["docs/codemode.md", "skills/delegate/references/codemode.md"]) {
		const content = readFileSync(join(root, path), "utf8");
		const recipes = [...content.matchAll(/```(?:javascript|js)\n([\s\S]*?)\n```/g)];
		assert.ok(recipes.length > 0, path);
		for (const recipe of recipes) {
			const parsed = parseCodemodeSource(recipe[1]);
			assert.ok(parsed.code.trim(), path);
			if (recipe[1].startsWith("// @options:")) {
				assert.ok(parsed.options.timeoutMs && parsed.options.timeoutMs > 0, path);
				assert.throws(() => parseCodemodeSource(`\n${recipe[1]}`), /must be the first line/);
			}
		}
	}
});
