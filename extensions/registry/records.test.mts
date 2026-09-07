import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRecords, compareRecords, type HostSnapshot, skillIdentity } from "./records.ts";

const info = (over: Record<string, unknown> = {}) => ({
	path: "/p",
	source: "package",
	scope: "user" as const,
	origin: "package" as const,
	...over,
});

function snapshot(over: Partial<HostSnapshot> = {}): HostSnapshot {
	return {
		tools: [{ name: "read", description: "Read files", sourceInfo: info({ path: "<builtin:read>", source: "builtin" }) }],
		activeTools: ["read"],
		commands: [
			{ name: "stash", description: "Stash", source: "extension", sourceInfo: info({ path: "/ext/stash/index.ts" }) },
			{
				name: "skill:pillars",
				description: "Consult the pillars",
				source: "skill",
				sourceInfo: info({ path: "/skills/pillars/SKILL.md", baseDir: "/skills/pillars" }),
			},
			{ name: "review", description: "Review", source: "prompt", sourceInfo: info({ path: "/prompts/review.md" }) },
		],
		observation: null,
		availability: { tools: true, activeTools: true, commands: true },
		at: 1000,
		...over,
	};
}

const observedSkill = (over: Record<string, unknown> = {}) => ({
	name: "pillars",
	filePath: "/skills/pillars/SKILL.md",
	baseDir: "/skills/pillars",
	disableModelInvocation: true,
	sourceInfo: info({ path: "/skills/pillars/SKILL.md", baseDir: "/skills/pillars" }),
	...over,
});

describe("record projection", () => {
	it("maps every Pi command source to its kind and preserves the skill invocation alias", () => {
		const records = buildRecords(snapshot());
		const skill = records.find((r) => r.kind === "skill");
		assert.ok(skill);
		assert.equal(skill.name, "pillars");
		assert.equal(skill.invocation, "/skill:pillars");
		assert.equal(records.find((r) => r.kind === "command")?.name, "stash");
		assert.equal(records.find((r) => r.kind === "prompt")?.name, "review");
	});

	it("preserves every sourceInfo field unchanged", () => {
		const records = buildRecords(snapshot());
		const skill = records.find((r) => r.kind === "skill");
		assert.deepEqual(skill?.sourceInfo, {
			path: "/skills/pillars/SKILL.md",
			source: "package",
			scope: "user",
			origin: "package",
			baseDir: "/skills/pillars",
		});
	});

	it("separates configured presence from active status", () => {
		const records = buildRecords(snapshot({ activeTools: [] }));
		const tool = records.find((r) => r.kind === "tool");
		assert.equal(tool?.configured, true);
		assert.equal(tool?.active, false);
	});

	it("leaves active unset when the active-tool surface did not answer", () => {
		const records = buildRecords(
			snapshot({ activeTools: [], availability: { tools: true, activeTools: false, commands: true } }),
		);
		const tool = records.find((r) => r.kind === "tool");
		assert.equal(tool?.configured, true);
		assert.equal(tool?.active, undefined);
	});

	it("emits no records for an unavailable surface instead of empty ones", () => {
		const records = buildRecords(snapshot({ availability: { tools: false, activeTools: false, commands: true } }));
		assert.equal(records.filter((r) => r.kind === "tool").length, 0);
		assert.equal(records.filter((r) => r.kind === "skill").length, 1);
	});

	it("orders records deterministically by kind, name, then source fields", () => {
		const records = buildRecords(snapshot());
		assert.deepEqual(
			records.map((r) => `${r.kind}:${r.name}`),
			["tool:read", "command:stash", "skill:pillars", "prompt:review"],
		);
		const shuffled = [...records].reverse().sort(compareRecords);
		assert.deepEqual(shuffled.map((r) => r.name), records.map((r) => r.name));
	});
});

describe("observation join", () => {
	it("applies hidden-skill evidence only for the same name and source identity", () => {
		const records = buildRecords(
			snapshot({
				observation: {
					observedAt: 500,
					cwd: "/w",
					skills: [observedSkill()],
					selectedTools: [],
					contextFilePaths: [],
					customPromptPresent: false,
					appendSystemPromptPresent: false,
					recordCount: 1,
					bytes: 10,
					overflowRecords: false,
					overflowBytes: false,
				},
			}),
		);
		const skill = records.find((r) => r.kind === "skill");
		assert.deepEqual(skill?.modelInvocable, { value: false, evidence: "observation", at: 500 });
		assert.equal(skill?.observationIdentityMismatch, undefined);
	});

	it("marks a same-name skill from a different source unknown rather than carrying stale evidence", () => {
		const records = buildRecords(
			snapshot({
				observation: {
					observedAt: 500,
					cwd: "/w",
					skills: [observedSkill({ sourceInfo: info({ path: "/other/pillars/SKILL.md" }) })],
					selectedTools: [],
					contextFilePaths: [],
					customPromptPresent: false,
					appendSystemPromptPresent: false,
					recordCount: 1,
					bytes: 10,
					overflowRecords: false,
					overflowBytes: false,
				},
			}),
		);
		const skill = records.find((r) => r.kind === "skill");
		assert.equal(skill?.modelInvocable, undefined);
		assert.equal(skill?.observationIdentityMismatch, true);
	});

	it("keys identity on name, source, and path together", () => {
		const base = info();
		for (const change of [{ path: "/y" }, { source: "user" }, { scope: "project" }, { origin: "top-level" }, { baseDir: "/b" }]) {
			assert.notEqual(skillIdentity("a", base), skillIdentity("a", info(change)));
		}
		assert.notEqual(skillIdentity("a", base), skillIdentity("b", base));
	});
});
