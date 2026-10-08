import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceScript = join(dirname(fileURLToPath(import.meta.url)), "check-slices.mts");
function installGate(scripts: string): void {
	copyFileSync(sourceScript, join(scripts, "check-slices.mts"));
}

test("ignores a tracked document deleted from the working tree", () => {
	const root = mkdtempSync(join(tmpdir(), "check-slices-deletion-"));
	try {
		const scripts = join(root, "scripts");
		const extension = join(root, "extensions", "example");
		mkdirSync(scripts, { recursive: true });
		mkdirSync(extension, { recursive: true });
		installGate(scripts);
		writeFileSync(join(extension, "index.ts"), "export default function () {}\n");
		writeFileSync(join(extension, "README.md"), "# Example\n");
		writeFileSync(join(extension, "index.test.mts"), "// fixture\n");
		const removed = join(extension, "DESIGN.md");
		writeFileSync(removed, "# Retired design\n");
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "-q"], { cwd: root });
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "add", "."], { cwd: root });
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
		installGate(scripts);
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
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "-q"], { cwd: root });
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "add", "."], { cwd: root });

		const result = spawnSync(process.execPath, [join(scripts, "check-slices.mts")], { cwd: root, encoding: "utf8" });
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /escapes the extension slice/);
		assert.match(result.stderr, /\.\/\.\.\/b\/index\.ts/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("permits only the documented evaluation consumers and producer paths", () => {
	const root = mkdtempSync(join(tmpdir(), "check-slices-evals-"));
	try {
		const scripts = join(root, "scripts");
		const slice = join(root, "extensions", "example");
		mkdirSync(scripts, { recursive: true });
		mkdirSync(join(slice, "fixtures"), { recursive: true });
		mkdirSync(join(root, "evals", "subjects"), { recursive: true });
		installGate(scripts);
		writeFileSync(join(slice, "index.ts"), "export default function () {}\n");
		writeFileSync(join(slice, "README.md"), "# Example\n");
		writeFileSync(join(slice, "index.test.mts"), "// fixture\n");
		writeFileSync(join(root, "evals", "vitest-evals.mts"), "export {};\n");
		writeFileSync(join(root, "evals", "subjects", "pi-sdk.mts"), "export {};\n");
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "-q"], { cwd: root });
		const cases = [
			["suite.eval.mts", "../../evals/vitest-evals.mts", true],
			["suite.test.mts", "../../evals/subjects/pi-sdk.mts", true],
			["runtime.ts", "../../evals/vitest-evals.mts", false],
			["suite.eval.mts", "../../evals/subjects/pi-sdk.mts", false],
			["suite.test.mts", "../../evals/core.mts", false],
			["suite.eval.mts", "../../extensions/other/index.ts", false],
			["fixtures/nested.eval.mts", "../../../evals/vitest-evals.mts", false],
		] as const;
		for (const [file, specifier, permitted] of cases) {
			const path = join(slice, file);
			writeFileSync(path, `import "${specifier}";\n`);
			const result = spawnSync(process.execPath, [join(scripts, "check-slices.mts")], { cwd: root, encoding: "utf8" });
			assert.equal(result.status, permitted ? 0 : 1, `${file}: ${result.stdout}${result.stderr}`);
			if (!permitted) assert.match(result.stderr, /escapes the extension slice/);
			rmSync(path);
		}
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
	installGate(scripts);
	writeFileSync(join(extension, "index.ts"), "export default function () {}\n");
	writeFileSync(join(extension, "README.md"), "# Example\n");
	writeFileSync(join(extension, "index.test.mts"), "// fixture\n");
	writeFileSync(join(root, "feature", "thing.test.mts"), "// fixture\n");
	writeFileSync(
		join(root, "package.json"),
		`${JSON.stringify({ name: "fixture", type: "module", scripts: { test: `node --test ${globs.map((g) => `"${g}"`).join(" ")}` } }, null, 2)}\n`,
	);
	execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "-q"], { cwd: root });
	execFileSync("git", ["-c", "core.hooksPath=/dev/null", "add", "."], { cwd: root });
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

import {
	auditPillars,
	auditSettings,
	checkSettingsReadme,
	type Declaration,
	environmentReads,
	settingsReadme,
	validateSettingsDeclaration,
} from "./check-slices.mts";

function pillarFixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "check-slices-pillars-"));
	mkdirSync(join(root, "pillars"), { recursive: true });
	mkdirSync(join(root, "extensions", "example"), { recursive: true });
	writeFileSync(join(root, "extensions", "example", "index.ts"), "export default function () {}\n");
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
		assert.equal(rows.length, 2);
		assert.match(rows[0], /\[Framed Menu\]/);
		assert.match(rows[rows.length - 1], /\[Aardvark First\]/);
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

test("missing required frontmatter values stop inventory projection", () => {
	const root = pillarFixtureRoot();
	try {
		const file = join(root, "pillars", "heuristic-framed-menu.md");
		const valid = readFileSync(file, "utf8");
		for (const key of ["title", "index"]) {
			writeFileSync(file, valid.replace(new RegExp(`^${key}:.*\\n`, "m"), ""));
			const result = auditPillars(root);
			assert.ok(
				result.violations.includes(`pillars/heuristic-framed-menu.md: frontmatter missing required key "${key}"`),
			);
			assert.equal(result.readmeProjection, "");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an invalid UTF-8 entry reports its path and stops inventory projection", () => {
	const root = pillarFixtureRoot();
	try {
		writeFileSync(join(root, "pillars", "heuristic-framed-menu.md"), Buffer.from([0xff]));
		const result = auditPillars(root);
		assert.ok(result.violations.includes("pillars/heuristic-framed-menu.md: invalid UTF-8"));
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

test("settings imports have no package escape", () => {
	const root = testGlobFixtureRoot(["extensions/*/*.test.mts", "feature/*.test.mts"]);
	try {
		const runtime = join(root, "extensions/example/runtime.ts");
		for (const [specifier, allowed] of [
			["../../settings/index.ts", false],
			["./../../settings/index.ts", false],
			["../../settings/private.ts", false],
			["../../settings/index.test.mts", false],
			["../../scripts/check-slices.mts", false],
			["../other/settings.ts", false],
		] as const) {
			writeFileSync(runtime, `import "${specifier}";\n`);
			const result = spawnSync(process.execPath, [join(root, "scripts/check-slices.mts")], {
				cwd: root,
				encoding: "utf8",
			});
			assert.equal(result.status, allowed ? 0 : 1, result.stderr);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("configuration access detection covers direct and injected lexical spellings", () => {
	assert.deepEqual(
		environmentReads(`
		process.env.PI_EXAMPLE_ONE;
		process.env["PI_EXAMPLE_TWO"];
		env.PI_EXAMPLE_THREE;
		env['PI_EXAMPLE_FOUR'];
		(options.env ?? process.env).PI_EXAMPLE_FIVE;
		process.env.PI_AGENT_DIR; env.PI_AGENT_SESSIONS_DIR; env.PI_HARNESS_FILE;
		env.PI_MANAGED_INSTALL_ROOT; env.PI_SESSION_ID;
		process.env.PI_EXAMPLE_TEST_ROOT;
	`),
		["PI_EXAMPLE_ONE", "PI_EXAMPLE_TWO", "PI_EXAMPLE_THREE", "PI_EXAMPLE_FOUR", "PI_EXAMPLE_FIVE"],
	);
});

function declarationFixture() {
	const root = testGlobFixtureRoot(["extensions/*/*.test.mts", "feature/*.test.mts"]);
	const directory = join(root, "extensions/example");
	const runtime = join(directory, "index.ts");
	const declarationPath = join(directory, "settings.ts");
	const declaration: Declaration = {
		slice: "example",
		fields: { name: { type: "string", env: "PI_EXAMPLE_NAME", description: "Name.", default: "safe" } },
	};
	writeFileSync(
		declarationPath,
		`export const settings = ${JSON.stringify(declaration)};
export function readSettings() { return process.env.PI_EXAMPLE_NAME; }
export function publishSettings() { return () => {}; }
`,
	);
	writeFileSync(
		runtime,
		'import { readSettings } from "./settings.ts"; export default function () { return readSettings({ agentDir: "/fixture/agent", env: {} }); }\n',
	);
	writeFileSync(join(directory, "README.md"), settingsReadme(declaration));
	return { root, directory, runtime, declarationPath };
}

test("declared slices permit local function bodies and require an exact README table", async () => {
	const f = declarationFixture();
	try {
		assert.deepEqual(await auditSettings(f.root, [f.runtime, f.declarationPath]), []);
		writeFileSync(join(f.directory, "README.md"), "# Drifted README\n");
		writeFileSync(f.runtime, "export default function () {}\n");
		const failures = await auditSettings(f.root, [f.runtime, f.declarationPath]);
		assert.ok(failures.some((failure) => failure.includes("configuration table differs")));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("declared lexical environment reads pass and undeclared reads fail", async () => {
	const f = declarationFixture();
	try {
		writeFileSync(f.runtime, `${readFileSync(f.runtime, "utf8")}\nconst raw = env["PI_EXAMPLE_EXTRA"];\n`);
		const failures = await auditSettings(f.root, [f.runtime, f.declarationPath]);
		assert.ok(failures.some((failure) => failure.includes("PI_EXAMPLE_EXTRA is not declared by settings.ts")));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("runtime configuration requires a declaration even with owning README documentation", async () => {
	const root = testGlobFixtureRoot(["extensions/*/*.test.mts", "feature/*.test.mts"]);
	try {
		const runtime = join(root, "extensions/example/runtime.ts");
		writeFileSync(runtime, "const value = env.PI_EXAMPLE_NAME;\n");
		assert.equal((await auditSettings(root, [runtime])).length, 1);
		writeFileSync(join(root, "extensions/example/README.md"), "# Example\n\nUse `PI_EXAMPLE_NAME`.\n");
		const failures = await auditSettings(root, [runtime]);
		assert.equal(failures.length, 1);
		assert.match(failures[0], /PI_EXAMPLE_NAME requires an owning settings.ts declaration/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("configuration exclusions apply only to tests and explicitly named fixtures", async () => {
	const root = testGlobFixtureRoot(["extensions/*/*.test.mts", "feature/*.test.mts"]);
	try {
		const directory = join(root, "extensions/example");
		mkdirSync(join(directory, "fixtures"));
		const files = [
			"foo.test.mts",
			"foo.eval.mts",
			"eval-fixture.ts",
			"fixtures/foo.ts",
			"runtime-fixture-support.ts",
			"runtime.ts",
		].map((name) => join(directory, name));
		for (const file of files) writeFileSync(file, "const value = env.PI_EXAMPLE_NAME;\n");
		const failures = await auditSettings(root, files);
		assert.equal(failures.length, 2);
		assert.ok(failures.some((failure) => failure.includes("runtime-fixture-support.ts")));
		assert.ok(failures.some((failure) => failure.includes("runtime.ts")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("malformed named declaration exports fail the configuration gate", async () => {
	const f = declarationFixture();
	try {
		writeFileSync(f.declarationPath, "export const other = {};\n");
		assert.ok(
			(await auditSettings(f.root, [f.runtime, f.declarationPath])).some((failure) =>
				failure.includes("cannot load valid plain settings declaration and local functions"),
			),
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("settings modules cannot import extension entrypoints", async () => {
	const f = declarationFixture();
	try {
		writeFileSync(f.runtime, 'throw new Error("entrypoint executed");\n');
		writeFileSync(f.declarationPath, 'import "./index.ts"; export const settings = {};\n');
		const failures = await auditSettings(f.root, [f.runtime, f.declarationPath]);
		assert.ok(
			failures.some((failure) => failure.includes("cannot load valid plain settings declaration and local functions")),
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("configuration-free and context-only slices need no empty declaration", async () => {
	const root = testGlobFixtureRoot(["extensions/*/*.test.mts", "feature/*.test.mts"]);
	try {
		const runtime = join(root, "extensions/example/runtime.ts");
		for (const source of [
			"export const ready = true;",
			"const context = [env.PI_AGENT_DIR, process.env.PI_SESSION_ID, env.PI_EXAMPLE_TEST_ROOT];",
		]) {
			writeFileSync(runtime, source);
			assert.deepEqual(await auditSettings(root, [runtime]), []);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a local reader requires an owning declaration without raw environment reads", async () => {
	const f = declarationFixture();
	try {
		rmSync(f.declarationPath);
		assert.match(
			(await auditSettings(f.root, [f.runtime]))[0],
			/readSettings consumer requires an owning settings.ts declaration/,
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("CLI rejects missing declarations while importing helpers does not audit or exit", () => {
	const root = testGlobFixtureRoot(["extensions/*/*.test.mts", "feature/*.test.mts"]);
	try {
		writeFileSync(
			join(root, "extensions/example/index.ts"),
			"export default function () { return env.PI_EXAMPLE_NAME; }",
		);
		writeFileSync(join(root, "extensions/example/README.md"), "Use PI_EXAMPLE_NAME.");
		const gate = join(root, "scripts/check-slices.mts");
		const cli = spawnSync(process.execPath, [gate], { cwd: root, encoding: "utf8" });
		assert.equal(cli.status, 1, cli.stderr);
		assert.match(cli.stderr, /requires an owning settings.ts declaration/);
		const imported = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const helpers = await import(${JSON.stringify(gate)}); console.log(typeof helpers.auditSettings);`,
			],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(imported.status, 0, imported.stderr);
		assert.equal(imported.stdout, "function\n");
		assert.equal(imported.stderr, "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function plainDeclaration(field: Record<string, unknown> = {}): unknown {
	return {
		slice: "example",
		fields: {
			checkInMinutes: {
				type: "integer",
				env: "PI_EXAMPLE_CHECK_IN_MINUTES",
				description: "Interval.",
				default: 5,
				...field,
			},
		},
	};
}

test("plain declarations require explicit canonical environment names and valid metadata", () => {
	assert.doesNotThrow(() => validateSettingsDeclaration(plainDeclaration(), "example"));
	for (const field of [
		{ env: undefined },
		{ env: "PI_OTHER_CHECK_IN_MINUTES" },
		{ env: "PI_EXAMPLE_CHECKIN_MINUTES" },
		{ env: "example" },
		{ type: "unknown" },
		{ description: "" },
		{ description: "bad\u0000" },
		{ min: Infinity },
		{ min: 10, max: 2 },
		{ minLength: 1 },
		{ type: "string", minLength: -1 },
		{ type: "string", minLength: 3, maxLength: 1 },
		{ type: "enum" },
		{ type: "enum", choices: [] },
		{ type: "enum", choices: ["x", "x"] },
		{ type: "enum", choices: [1] },
		{ choices: ["x"] },
		{ absolute: true },
		{ secret: "true" },
		{ secret: true },
		{ type: "string", secret: true },
		{ defaultText: "derived" },
		{ options: {} },
		{ accept: () => true },
		{ default: () => 1 },
	])
		assert.throws(() => validateSettingsDeclaration(plainDeclaration(field), "example"), JSON.stringify(field));
	for (const value of [
		null,
		[],
		{ slice: "wrong", fields: {} },
		{ slice: "example", fields: [] },
		{ slice: "example", fields: { BadKey: {} } },
		{ slice: "example", fields: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key${index}`, {}])) },
	])
		assert.throws(() => validateSettingsDeclaration(value, "example"));
});

test("declarations reject executable, cyclic, and nonplain data without invoking accessors", () => {
	let invoked = false;
	const getter = {
		get fields() {
			invoked = true;
			return {};
		},
		slice: "example",
	};
	assert.throws(() => validateSettingsDeclaration(getter, "example"));
	assert.equal(invoked, false);
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	for (const value of [cycle, new Date(), { [Symbol("key")]: 1 }, { slice: "example", fields: new Map() }])
		assert.throws(() => validateSettingsDeclaration(value, "example"));
});

test("README projection preserves literal rows, escaping, defaults, and constraint order", () => {
	const declaration: Declaration = {
		slice: "example",
		fields: {
			dir: {
				type: "path",
				env: "PI_EXAMPLE_DIR",
				description: "A | B <C>.",
				defaultText: "<agentDir>/data",
				minLength: 1,
				maxLength: 64,
				absolute: true,
			},
			mode: { type: "enum", env: "PI_EXAMPLE_MODE", description: "Mode.", choices: ["a", "b"], default: "a" },
			secret: { type: "string", env: "PI_EXAMPLE_SECRET", description: "Secret.", secret: true },
			optional: { type: "number", env: "PI_EXAMPLE_OPTIONAL", description: "Optional.", min: 0, max: 2 },
		},
	};
	const table = [
		"<!-- harness:settings:start -->",
		"| Key | Environment | Type | Default | Constraints | Description |",
		"|---|---|---|---|---|---|",
		"| dir | `PI_EXAMPLE_DIR` | path | &lt;agentDir&gt;/data | minLength 1; maxLength 64; absolute input | A \\| B &lt;C&gt;. |",
		'| mode | `PI_EXAMPLE_MODE` | enum | "a" | a, b | Mode. |',
		"| secret | `PI_EXAMPLE_SECRET` | string | env-only | none | Secret. |",
		"| optional | `PI_EXAMPLE_OPTIONAL` | number | unset | min 0; max 2 | Optional. |",
		"<!-- harness:settings:end -->",
	].join("\n");
	assert.equal(settingsReadme(declaration), table);
	assert.equal(checkSettingsReadme(declaration, `# Example\n\n${table}\nFooter`), true);
	for (const invalid of [
		table + table,
		table.replace("Optional.", "Changed."),
		table.replace("start", "missing"),
		table.replace("end", "missing"),
	])
		assert.equal(checkSettingsReadme(declaration, invalid), false);
});

test("settings modules must export their local reader and publisher", async () => {
	for (const missing of ["readSettings", "publishSettings"]) {
		const f = declarationFixture();
		try {
			writeFileSync(
				f.declarationPath,
				readFileSync(f.declarationPath, "utf8").replace(`export function ${missing}`, `function ${missing}`),
			);
			assert.ok(
				(await auditSettings(f.root, [f.runtime, f.declarationPath])).some((failure) =>
					failure.includes("local functions"),
				),
			);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}
});
