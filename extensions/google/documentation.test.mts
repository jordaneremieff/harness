import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { googleTools } from "./index.ts";

function names(cell: string): string[] {
	return [...cell.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
}

/** The read and write tool names of the README Tools table. */
function toolTable(markdown: string): { read: string[]; write: string[] } {
	const section = markdown.slice(markdown.indexOf("\n## Tools\n"), markdown.indexOf("\n## Results\n"));
	const read: string[] = [];
	const write: string[] = [];
	for (const line of section.split("\n")) {
		const cells = line.split("|");
		if (cells.length !== 5 || !/`/.test(line)) continue;
		read.push(...names(cells[2]));
		write.push(...names(cells[3]));
	}
	return { read, write };
}

/** The first JSON block of the Approval rules section: the proposal that gates every write tool. */
function recommendedRule(markdown: string): { program: { selector: { tools: string[] } } } {
	const section = markdown.slice(markdown.indexOf("\n## Approval rules\n"), markdown.indexOf("\n## Setup\n"));
	const block = /```json\n([\s\S]*?)\n```/.exec(section);
	assert.ok(block, "the Approval rules section has no JSON proposal");
	return JSON.parse(block[1]) as { program: { selector: { tools: string[] } } };
}

test("the README lists every registered tool once, and the recommended rule names every write tool", async () => {
	const markdown = await readFile(new URL("./README.md", import.meta.url), "utf8");
	const table = toolTable(markdown);
	assert.ok(table.write.length > 0);
	assert.deepEqual(
		[...table.read, ...table.write].sort(),
		googleTools.map((tool) => tool.name).sort(),
		"the Tools table and the registered tools differ",
	);
	assert.deepEqual(
		recommendedRule(markdown).program.selector.tools.slice().sort(),
		table.write.slice().sort(),
		"the recommended approval rule and the Write tools column differ",
	);
});
