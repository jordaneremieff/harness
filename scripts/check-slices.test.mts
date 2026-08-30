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

test("flags dot-prefixed relative specifiers that escape the slice", () => {
	const root = mkdtempSync(join(tmpdir(), "check-slices-escape-"));
	try {
		const scripts = join(root, "scripts");
		mkdirSync(scripts, { recursive: true });
		copyFileSync(sourceScript, join(scripts, "check-slices.mts"));
		for (const name of ["a", "b"]) {
			const slice = join(root, "extensions", name);
			mkdirSync(slice, { recursive: true });
			writeFileSync(join(slice, "index.ts"), "export default function () {}\n");
			writeFileSync(join(slice, "README.md"), `# ${name}\n`);
			writeFileSync(join(slice, "index.test.mts"), "// fixture\n");
		}
		writeFileSync(
			join(root, "extensions", "a", "index.ts"),
			'import { helper } from "./../b/index.ts";\nexport default function () {}\n',
		);
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["add", "."], { cwd: root });

		const result = spawnSync(process.execPath, [join(scripts, "check-slices.mts")], { cwd: root, encoding: "utf8" });
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /escapes the extension slice/);
		assert.match(result.stderr, /\.\/\.\.\/b\/index\.ts/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function testGlobFixtureRoot(globs: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "check-slices-globs-"));
	const scripts = join(root, "scripts");
	const extension = join(root, "extensions", "example");
	mkdirSync(scripts, { recursive: true });
	mkdirSync(extension, { recursive: true });
	mkdirSync(join(root, "feature"), { recursive: true });
	copyFileSync(sourceScript, join(scripts, "check-slices.mts"));
	writeFileSync(join(extension, "index.ts"), "export default function () {}\n");
	writeFileSync(join(extension, "README.md"), "# Example\n");
	writeFileSync(join(extension, "index.test.mts"), "// fixture\n");
	writeFileSync(join(root, "feature", "thing.test.mts"), "// fixture\n");
	writeFileSync(
		join(root, "package.json"),
		`${JSON.stringify({ name: "fixture", scripts: { test: `node --test ${globs.map((g) => `"${g}"`).join(" ")}` } }, null, 2)}\n`,
	);
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	return root;
}

test("flags a tracked test file that no npm test glob matches", () => {
	const root = testGlobFixtureRoot(["extensions/*/*.test.mts"]);
	try {
		const result = spawnSync(process.execPath, [join(root, "scripts", "check-slices.mts")], {
			cwd: root,
			encoding: "utf8",
		});
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stderr, /feature\/thing\.test\.mts/);
		assert.match(result.stderr, /no npm test glob matches it/);
		// The covered file must not be reported.
		assert.doesNotMatch(result.stderr, /extensions\/example\/index\.test\.mts/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("accepts tracked test files once a glob covers them", () => {
	const root = testGlobFixtureRoot(["extensions/*/*.test.mts", "feature/*.test.mts"]);
	try {
		const result = spawnSync(process.execPath, [join(root, "scripts", "check-slices.mts")], {
			cwd: root,
			encoding: "utf8",
		});
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

function armoryFixtureRoot(content: string): string {
	const root = pillarFixtureRoot();
	mkdirSync(join(root, "skills", "troll", "references"), { recursive: true });
	writeFileSync(join(root, "skills", "troll", "references", "pillar-armory.md"), content);
	return root;
}

test("armory corpus paths resolve against the skill directory", () => {
	const root = armoryFixtureRoot(
		[
			"# Pillar armory",
			"",
			"All corpus paths resolve relative to the skill directory skills/troll/.",
			"",
			"| Failure mode | Governing pillar |",
			"|---|---|",
			"| Offers a menu sharing an unstated premise | ../../pillars/heuristic-framed-menu.md |",
			"",
			"Corpus check: ../../pillars/README.md",
			"",
		].join("\n"),
	);
	try {
		const result = auditPillars(root);
		assert.deepEqual(
			result.violations.filter((v) => v.includes("pillar-armory")),
			[],
			result.violations.join("\n"),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("armory mapping to a missing pillar is flagged", () => {
	const root = armoryFixtureRoot("| Premise menu | ../../pillars/heuristic-absent.md |\n");
	try {
		const result = auditPillars(root);
		assert.ok(
			result.violations.some((v) =>
				v.includes("pillar-armory.md: corpus path ../../pillars/heuristic-absent.md does not resolve"),
			),
			result.violations.join("\n"),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("armory paths that do not resolve from the skill directory are flagged", () => {
	const root = armoryFixtureRoot(
		[
			"| Premise menu | ../../../pillars/heuristic-framed-menu.md |",
			"| Premise menu | ../pillars/heuristic-framed-menu.md |",
			"",
		].join("\n"),
	);
	try {
		const result = auditPillars(root);
		const armoryViolations = result.violations.filter((v) => v.includes("pillar-armory"));
		assert.equal(armoryViolations.length, 2, result.violations.join("\n"));
		assert.ok(
			armoryViolations.some((v) => v.includes("corpus path ../../../pillars/heuristic-framed-menu.md")),
			result.violations.join("\n"),
		);
		assert.ok(
			armoryViolations.some((v) => v.includes("corpus path ../pillars/heuristic-framed-menu.md")),
			result.violations.join("\n"),
		);
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
