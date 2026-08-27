import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceScript = join(dirname(fileURLToPath(import.meta.url)), "check-slices.mts");

test("ignores a tracked document deleted from the working tree", () => {
	const root = mkdtempSync(join(tmpdir(), "check-slices-deletion-"));
	try {
		const scripts = join(root, "scripts");
		const extension = join(root, "extensions", "example");
		mkdirSync(scripts, { recursive: true });
		mkdirSync(extension, { recursive: true });
		copyFileSync(sourceScript, join(scripts, "check-slices.mts"));
		writeFileSync(join(extension, "index.ts"), "export default function () {}\n");
		writeFileSync(join(extension, "README.md"), "# Example\n");
		writeFileSync(join(extension, "index.test.mts"), "// fixture\n");
		const removed = join(extension, "DESIGN.md");
		writeFileSync(removed, "# Retired design\n");
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["add", "."], { cwd: root });
		rmSync(removed);

		const result = spawnSync(process.execPath, [join(scripts, "check-slices.mts")], { cwd: root, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /check-slices: ok/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

import { auditPillars } from "./check-slices.mts";

function pillarFixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "check-slices-pillars-"));
	mkdirSync(join(root, "pillars"), { recursive: true });
	mkdirSync(join(root, "extensions", "example"), { recursive: true });
	mkdirSync(join(root, "skills", "pillars"), { recursive: true });
	writeFileSync(join(root, "extensions", "example", "index.ts"), "export default function () {}\n");
	writeFileSync(
		join(root, "skills", "pillars", "SKILL.md"),
		[
			"---",
			"name: pillars",
			"compatibility: ../../pillars relative to this skill directory.",
			"---",
			"",
			"Inventory: ../../pillars/README.md Rules: ../../pillars/GOVERNANCE.md",
		].join("\n"),
	);
	writeFileSync(join(root, "pillars", "GOVERNANCE.md"), REQUIRED_HEADINGS.map((h) => `## ${h}\n`).join(""));
	writeFileSync(
		join(root, "pillars", "heuristic-framed-menu.md"),
		pillarEntry("heuristic", "Framed Menu", "All offered options share an unstated premise → test the premise."),
	);
	writeFileSync(
		join(root, "pillars", "README.md"),
		inventory([
			["Framed Menu", "heuristic-framed-menu.md", "All offered options share an unstated premise → test the premise."],
		]),
	);
	return root;
}

const REQUIRED_HEADINGS = [
	"Document Types",
	"Application Contract",
	"Consultation Procedure",
	"Supplying doctrine to subagents",
	"Contradiction Handling",
	"Common Composition Paths",
	"Mutation Rules",
	"Provenance Policy",
];

const pillarEntry = (type: string, name: string, index: string): string =>
	`---\ntitle: "${name}"\nindex: "${index}"\n---\n\n# ${type[0].toUpperCase() + type.slice(1)}: ${name}\n\n## Recognition\n`;

const inventory = (rows: Array<[string, string, string]>): string =>
	[
		"# Pillars",
		"",
		"### Heuristics",
		"",
		"| Heuristic | Recognition → move |",
		"|---|---|",
		...rows.map(([title, href, cell]) => `| [${title}](${href}) | ${cell} |`),
		"",
	].join("\n");

test("pillar audit passes a well-formed single-entry corpus", () => {
	const root = pillarFixtureRoot();
	try {
		const result = auditPillars(root);
		assert.deepEqual(result.violations, []);
		assert.equal(result.readmeProjection, "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a drifted README cell reports mismatch and prints an ordered projection", () => {
	const root = pillarFixtureRoot();
	try {
		writeFileSync(
			join(root, "pillars", "README.md"),
			inventory([["Framed Menu", "heuristic-framed-menu.md", "Stale wording that no longer matches."]]),
		);
		const result = auditPillars(root);
		assert.ok(
			result.violations.some((v) => v.includes("does not byte-match")),
			result.violations.join("\n"),
		);
		assert.match(result.readmeProjection, /Framed Menu.*unstated premise/s);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("projection preserves existing README order and appends newcomers deterministically", () => {
	const root = pillarFixtureRoot();
	try {
		writeFileSync(
			join(root, "pillars", "heuristic-aardvark-first.md"),
			pillarEntry("heuristic", "Aardvark First", "Added later but would sort first alphabetically."),
		);
		const result = auditPillars(root);
		const heuristicsBlock = result.readmeProjection.split("### Heuristics\n")[1] ?? "";
		const rows = heuristicsBlock.split("\n").filter((line) => line.startsWith("| ["));
		assert.match(rows[0]!, /\[Framed Menu\]/);
		assert.match(rows[rows.length - 1]!, /\[Aardvark First\]/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("frontmatter grammar failures are precise and withhold the projection", () => {
	const root = pillarFixtureRoot();
	try {
		const file = join(root, "pillars", "heuristic-framed-menu.md");
		const body = readFileSync(file, "utf8");
		writeFileSync(file, body.replace("title:", 'mood: "uncertain"\ntitle:'));
		const result = auditPillars(root);
		assert.ok(
			result.violations.some((v) => v.includes('unknown key "mood"')),
			result.violations.join("\n"),
		);
		assert.equal(result.readmeProjection, "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("duplicate keys are rejected", () => {
	const root = pillarFixtureRoot();
	try {
		const file = join(root, "pillars", "heuristic-framed-menu.md");
		const body = readFileSync(file, "utf8");
		writeFileSync(file, body.replace(/^/, '---\ntitle: "Duplicate"\n---\n'));
		const result = auditPillars(root);
		assert.ok(result.violations.length > 0);
		assert.equal(result.readmeProjection, "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("filename prefix and H1 type disagreements are flagged", () => {
	const root = pillarFixtureRoot();
	try {
		writeFileSync(
			join(root, "pillars", "principle-not-a-principle.md"),
			pillarEntry("pattern", "Not A Principle", "Mismatched identity across declarations."),
		);
		const result = auditPillars(root);
		assert.ok(result.violations.some((v) => v.includes("disagrees with H1 type")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reordering README rows is not a violation", () => {
	const root = pillarFixtureRoot();
	try {
		writeFileSync(
			join(root, "pillars", "heuristic-aaa-second.md"),
			pillarEntry("heuristic", "Aaa Second", "Second entry inserted to prove order freedom."),
		);
		const reordered = [
			"# Pillars",
			"",
			"### Heuristics",
			"",
			"| Heuristic | Recognition → move |",
			"|---|---|",
			"| [Aaa Second](heuristic-aaa-second.md) | Second entry inserted to prove order freedom. |",
			"| [Framed Menu](heuristic-framed-menu.md) | All offered options share an unstated premise → test the premise. |",
			"",
		].join("\n");
		writeFileSync(join(root, "pillars", "README.md"), reordered);
		const result = auditPillars(root);
		assert.deepEqual(
			result.violations.filter((v) => v.includes("README.md")),
			[],
		);
		assert.equal(result.readmeProjection, "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
