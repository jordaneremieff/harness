import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { compile } from "@earendil-works/pi-schema";
import { validateFactsProgram } from "./program.ts";
import { PolicyProposeParams, validateInspectionParams } from "./tools.ts";

const proposal = compile(PolicyProposeParams);

test("guidance documentation distinguishes stored choices and result semantics", async () => {
	const readme = (await readFile(new URL("./README.md", import.meta.url), "utf8")).replace(/\s+/g, " ");
	const authoring = (await readFile(new URL("./AUTHORING.md", import.meta.url), "utf8")).replace(/\s+/g, " ");
	assert.match(readme, /Slow-traverser defaults retain pre-call denials/);
	assert.match(readme, /Other command-form and fast-tool output defaults supply guidance/);
	assert.match(readme, /Catalogue updates change no existing private rule/);
	assert.match(readme, /--max-results conflicts with --list-details, --exec and --exec-batch/);
	assert.match(readme, /not an equivalent global sorted prefix/);
	assert.match(readme, /Policy adds no default Bash deadline/);
	assert.match(readme, /Preserve required complete reads/);
	assert.match(readme, /Rules outside the bundled catalogue keep their approved effects and notes as stored/);
	assert.match(readme, /Catalogue defaults do not change these stored choices/);
	assert.match(authoring, /substitute actions replace existing mapped values; they do not add missing arguments/);
});

test("documented JSON requests satisfy the current policy contracts", async () => {
	const path = new URL("./README.md", import.meta.url);
	assert.ok((await stat(path)).size <= 128 * 1024, "documentation exceeds the example scan bound");
	const markdown = await readFile(path, "utf8");
	const exercised = new Set<string>();
	for (const block of markdown.matchAll(/^[\t ]*```json[\t ]*\r?\n([\s\S]*?)^[\t ]*```[\t ]*$/gm)) {
		const value = JSON.parse(block[1]);
		if (value.operation) {
			assert.equal(proposal.check(value), true, JSON.stringify(value));
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
