import assert from "node:assert/strict";
import { test } from "node:test";
import { noteResource, ordinaryNoteResources } from "./notes-host.ts";
import type { HostSnapshot } from "./records.ts";
const source = (path: string, baseDir = "/agent/skills") => ({ path, baseDir, source: "local", scope: "user" as const, origin: "top-level" as const });
test("resource locations use exact entrypoint and skill paths rather than discovery base directories", () => {
	assert.equal(noteResource("skill", "example", source("/agent/skills/example/SKILL.md"))?.path, "/agent/skills/example");
	assert.equal(noteResource("extension", "tool", source("/loaded/extensions/example/index.ts", "/loaded"))?.path, "/loaded/extensions/example");
	assert.equal(noteResource("extension", "tool", source("/loaded/extensions/example/index.ts", "/loaded"))?.entryPath, "/loaded/extensions/example/index.ts");
	assert.equal(noteResource("extension", "tool", source("/loaded/extensions/example", "/loaded"))?.path, "/loaded/extensions/example");
	assert.equal(noteResource("extension", "tool", source("/agent/extensions/example.ts"))?.name, "example");
	assert.equal(noteResource("prompt", "example", source("/agent/prompts/example.md"))?.path, "/agent/prompts/example.md");
	assert.equal(noteResource("extension", "tool", source("<builtin>")), undefined);
});
test("ordinary resource projection preserves unavailable surfaces", () => {
	const snapshot: HostSnapshot = { tools: [], commands: [], activeTools: [], observation: null, at: 1,
		availability: { tools: false, commands: true, activeTools: false } };
	assert.equal(ordinaryNoteResources(snapshot), null);
	snapshot.availability.tools = true;
	snapshot.tools.push({ name: "tool", sourceInfo: source("/loaded/example/index.ts") });
	snapshot.commands.push({ name: "example", source: "skill", sourceInfo: source("/agent/skills/example/SKILL.md") });
	const resources = ordinaryNoteResources(snapshot);
	assert.equal(resources?.length, 2);
	assert.equal(resources?.[0].tool, "tool");
	assert.equal(resources?.[0].entryPath, "/loaded/example/index.ts");
	assert.equal(resources?.[1].path, "/agent/skills/example");
	assert.equal(resources?.[1].tool, undefined);
});
