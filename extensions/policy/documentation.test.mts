import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { validateFactsProgram } from "./program.ts";
import { PolicyProposeParams, validateInspectionParams } from "./tools.ts";

const proposal = Compile(PolicyProposeParams);

test("documented JSON requests satisfy the current policy contracts", async () => {
	const path = new URL("./README.md", import.meta.url);
	assert.ok((await stat(path)).size <= 128 * 1024, "documentation exceeds the example scan bound");
	const markdown = await readFile(path, "utf8");
	const exercised = new Set<string>();
	for (const block of markdown.matchAll(/^[\t ]*```json[\t ]*\r?\n([\s\S]*?)^[\t ]*```[\t ]*$/gm)) {
		const value = JSON.parse(block[1]);
		if (value.operation) {
			assert.equal(proposal.Check(value), true, JSON.stringify(value));
			if (value.program) assert.equal(validateFactsProgram(value.program), undefined);
			exercised.add("proposal");
		} else if (value.phase) {
			assert.equal(validateFactsProgram(value), undefined);
			exercised.add("program");
		} else if (value.view) {
			validateInspectionParams(value);
			exercised.add("inspection");
		}
	}
	assert.deepEqual(exercised, new Set(["inspection", "proposal", "program"]));
});
