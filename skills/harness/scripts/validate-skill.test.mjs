import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./validate-skill.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "validate-skill-test-"));
let sequence = 0;

after(() => rmSync(root, { recursive: true, force: true }));

function createSkill({ frontmatter, body, files = {} }) {
	const directory = join(root, `fixture-${++sequence}`);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body ?? `# ${basename(directory)}\n`}`);
	for (const [relativePath, content] of Object.entries(files)) {
		const path = join(directory, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return directory;
}

function runJson(directory, extra = []) {
	const result = spawnSync(process.execPath, [script, directory, "--format", "json", ...extra], {
		encoding: "utf8",
	});
	assert.equal(result.signal, null, result.stderr);
	return { ...result, report: JSON.parse(result.stdout) };
}

function validFrontmatter(directory, extra = "") {
	return `name: ${basename(directory)}\ndescription: Use when validating an Agent Skill fixture. Do not use for non-fixtures.${extra ? `\n${extra}` : ""}`;
}

test("accepts portable optional fields and fragment/reference links", () => {
	const directory = createSkill({
		frontmatter: "placeholder",
		files: { "references/guide.md": "# Part\n" },
	});
	// biome-ignore lint/style/useTemplate: test fixture with literal backtick sequences
const body = "# " + basename(directory) + "\n\nSee [the guide](references/guide.md#part) and [the same guide][guide].\n\n[guide]: references/guide.md#part\n\n````markdown\n[example only](references/not-real.md)\n````\n";
	writeFileSync(join(directory, "SKILL.md"), `---\nname: ${basename(directory)}\ndescription: >\n  Use when validating a portable\n  Agent Skill fixture. Do not use for non-fixtures.\nlicense: MIT\ncompatibility: Requires Node.js 18+\nmetadata:\n  author: example\n  version: "1.0"\nallowed-tools: Read Bash\n---\n\n${body}`);
	const { status, report } = runJson(directory);
	assert.equal(status, 0);
	assert.deepEqual(report.counts.omitted, { fail: 0, warn: 0 });
	assert.equal(report.counts.fail, 0);
	assert.equal(report.counts.warn, 0);
});

test("rejects invalid optional frontmatter value types", async (t) => {
	const cases = [
		["license: false", "license.type"],
		["compatibility: \"\"", "compatibility.length"],
		["metadata:\n  count: 3", "metadata.value"],
		["allowed-tools: false", "allowed-tools.type"],
		["disable-model-invocation: nope", "frontmatter.type"],
	];
	for (const [field, code] of cases) {
		await t.test(code, () => {
			const directory = createSkill({ frontmatter: "placeholder" });
			writeFileSync(join(directory, "SKILL.md"), `---\n${validFrontmatter(directory, field)}\n---\n\n# ${basename(directory)}\n`);
			const { status, report } = runJson(directory);
			assert.equal(status, 1);
			assert.ok(report.fail.some((finding) => finding.code === code), JSON.stringify(report));
		});
	}
});

test("rejects required-field, naming, and conservative YAML violations", async (t) => {
	const cases = [
		[() => "name: wrong-name\ndescription: Use when validating.", "name.directory", "directory mismatch"],
		[(name) => `name: ${name}`, "frontmatter.required", "missing description"],
		[(name) => `name: ${name}\ndescription: false`, "frontmatter.type", "non-string description"],
		[(name) => `name: ${name}\ndescription: Use when validating.\nallowed-tools: [Read, Bash]`, "frontmatter.parse", "flow collection"],
		[(name) => `\tname: ${name}\n\tdescription: Use when validating.`, "frontmatter.parse", "tab indentation"],
		[(name) => `__proto__:\n  name: ${name}\n  description: Use when validating.`, "frontmatter.parse", "unsafe mapping key"],
	];
	for (const [makeFrontmatter, code, label] of cases) {
		await t.test(label, () => {
			const directory = createSkill({ frontmatter: "placeholder" });
			writeFileSync(join(directory, "SKILL.md"), `---\n${makeFrontmatter(basename(directory))}\n---\n\n# ${basename(directory)}\n`);
			const { status, report } = runJson(directory);
			assert.equal(status, 1);
			assert.ok(report.fail.some((finding) => finding.code === code), JSON.stringify(report));
		});
	}
});

test("checks missing, escaping, absolute, fragment, and undefined reference links", () => {
	const directory = createSkill({ frontmatter: "placeholder", files: { "references/guide.md": "# Present\n" } });
	writeFileSync(join(directory, "SKILL.md"), `---\n${validFrontmatter(directory)}\n---\n\n# ${basename(directory)}\n\n[missing](references/nope.md)\n[escape](../outside.md)\n[absolute](/tmp/outside.md)\n[bad fragment](references/guide.md#absent)\n[bad local fragment](#absent)\n[undefined][unknown]\n`);
	const { status, report } = runJson(directory);
	assert.equal(status, 1);
	for (const code of ["link.missing", "link.escape", "link.absolute", "link.fragment-missing", "link.reference-missing"]) {
		assert.ok(report.fail.some((finding) => finding.code === code), code);
	}
});

test("rejects links that escape through an in-skill symlink", () => {
	const outside = join(root, "outside.md");
	writeFileSync(outside, "# Outside\n");
	const directory = createSkill({ frontmatter: "placeholder" });
	mkdirSync(join(directory, "references"), { recursive: true });
	symlinkSync(outside, join(directory, "references", "linked.md"));
	writeFileSync(join(directory, "SKILL.md"), `---\n${validFrontmatter(directory)}\n---\n\n# ${basename(directory)}\n\n[outside](references/linked.md)\n`);
	const { status, report } = runJson(directory);
	assert.equal(status, 1);
	assert.ok(report.fail.some((finding) => finding.code === "link.escape"));
});

test("detects standalone credentials without relying on nearby keywords", () => {
	const directory = createSkill({ frontmatter: "placeholder" });
	const token = `ghp_${"a".repeat(30)}`;
	const privateKeyHeader = "-----BEGIN " + "PRIVATE KEY-----";
	writeFileSync(join(directory, "SKILL.md"), `---\n${validFrontmatter(directory)}\n---\n\n# ${basename(directory)}\n\n${token}\n${privateKeyHeader}\n`);
	const { status, report } = runJson(directory);
	assert.equal(status, 1);
	assert.ok(report.fail.some((finding) => finding.code === "file.secret"));
});

test("reports placeholder and operator-local path warnings", () => {
	const directory = createSkill({ frontmatter: "placeholder" });
	const marker = "TO" + "DO:";
	const localPath = "/" + "Users/example/private";
	writeFileSync(join(directory, "SKILL.md"), `---\n${validFrontmatter(directory)}\n---\n\n# ${basename(directory)}\n\n${marker} replace this\n${localPath}\n`);
	const { status, report } = runJson(directory);
	assert.equal(status, 0);
	assert.ok(report.warn.some((finding) => finding.code === "file.placeholder"));
	assert.ok(report.warn.some((finding) => finding.code === "file.absolute-path"));
});

test("bounds reads of oversized skill resources", () => {
	const directory = createSkill({ frontmatter: "placeholder" });
	writeFileSync(join(directory, "SKILL.md"), `---\n${validFrontmatter(directory)}\n---\n\n# ${basename(directory)}\n\n${"x".repeat(600 * 1024)}`);
	mkdirSync(join(directory, "scripts"), { recursive: true });
	mkdirSync(join(directory, "references"), { recursive: true });
	writeFileSync(join(directory, "scripts", "large.mjs"), "x".repeat(600 * 1024));
	writeFileSync(join(directory, "references", "large.md"), "x".repeat(600 * 1024));
	const { status, report } = runJson(directory);
	assert.equal(status, 0);
	assert.equal(report.warn.filter((finding) => finding.code === "file.large").length, 3);
	assert.ok(!report.warn.some((finding) => finding.code === "script.help"));
});

test("bounds reported findings while preserving total counts and failure status", () => {
	const directory = createSkill({ frontmatter: "placeholder" });
	const links = Array.from({ length: 85 }, (_, index) => `[missing ${index}](references/missing-${index}.md)`).join("\n");
	writeFileSync(join(directory, "SKILL.md"), `---\n${validFrontmatter(directory)}\n---\n\n# ${basename(directory)}\n\n${links}\n`);
	const result = runJson(directory);
	assert.equal(result.status, 1);
	assert.equal(result.report.counts.fail, 85);
	assert.equal(result.report.counts.shown.fail, 40);
	assert.equal(result.report.counts.omitted.fail, 45);
	assert.ok(Buffer.byteLength(result.stdout) < 50 * 1024);
});

test("warns when the body H1 is missing or does not match the frontmatter name", async (t) => {
	await t.test("missing H1", () => {
		const directory = createSkill({ frontmatter: "placeholder" });
		writeFileSync(join(directory, "SKILL.md"), `---\n${validFrontmatter(directory)}\n---\n\nIntro paragraph only, no heading.\n`);
		const { status, report } = runJson(directory);
		assert.equal(status, 0);
		assert.ok(report.warn.some((finding) => finding.code === "body.h1" && /no H1/.test(finding.message)));
	});
	await t.test("mismatched H1", () => {
		const directory = createSkill({ frontmatter: "placeholder" });
		writeFileSync(join(directory, "SKILL.md"), `---\n${validFrontmatter(directory)}\n---\n\n# Different Name\n`);
		const { status, report } = runJson(directory);
		assert.equal(status, 0);
		assert.ok(report.warn.some((finding) => finding.code === "body.h1" && /does not match/.test(finding.message)));
	});
});

test("warns on operator-private home path forms while keeping credentials as failures", () => {
	const directory = createSkill({ frontmatter: "placeholder" });
	const homePath = "~" + "/private/notes";
	writeFileSync(join(directory, "SKILL.md"), `---\n${validFrontmatter(directory)}\n---\n\n# ${basename(directory)}\n\nCorpus root: \`${homePath}\`.\n`);
	const { status, report } = runJson(directory);
	assert.equal(status, 0);
	assert.ok(report.warn.some((finding) => finding.code === "path.operator-home"));
});

test("warns when a script has no colocated test file", () => {
	const directory = createSkill({ frontmatter: "placeholder" });
	writeFileSync(join(directory, "SKILL.md"), `---\n${validFrontmatter(directory)}\n---\n\n# ${basename(directory)}\n`);
	mkdirSync(join(directory, "scripts"), { recursive: true });
	writeFileSync(join(directory, "scripts", "helper.mjs"), "export const helper = 1;\n");
	const { status, report } = runJson(directory);
	assert.equal(status, 0);
	assert.ok(report.warn.some((finding) => finding.code === "script.test-missing" && /helper\.mjs/.test(finding.message)));

	const tested = createSkill({ frontmatter: "placeholder" });
	writeFileSync(join(tested, "SKILL.md"), `---\n${validFrontmatter(tested)}\n---\n\n# ${basename(tested)}\n`);
	mkdirSync(join(tested, "scripts"), { recursive: true });
	writeFileSync(join(tested, "scripts", "helper.mjs"), "export const helper = 1;\n");
	writeFileSync(join(tested, "scripts", "helper.test.mjs"), "import test from \"node:test\";\n");
	const testedReport = runJson(tested);
	assert.equal(testedReport.status, 0);
	assert.ok(!testedReport.report.warn.some((finding) => finding.code === "script.test-missing"));
});

test("warns when the description lacks a do-not-use or boundary clause", () => {
	const directory = createSkill({ frontmatter: "placeholder" });
	writeFileSync(join(directory, "SKILL.md"), `---\nname: ${basename(directory)}\ndescription: Use when validating an Agent Skill fixture.\n---\n\n# ${basename(directory)}\n`);
	const { status, report } = runJson(directory);
	assert.equal(status, 0);
	assert.ok(report.warn.some((finding) => finding.code === "description.boundary"));
});

test("documents help and rejects invalid invocations", () => {
	const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /Usage:/);
	assert.match(help.stdout, /--format text\|json/);
	assert.match(help.stdout, /body H1/);
	assert.match(help.stdout, /tilde-home path forms/);
	assert.match(help.stdout, /colocated test file/);
	assert.match(help.stdout, /do-not-use or boundary clause/);

	const invalid = spawnSync(process.execPath, [script, "--format", "xml"], { encoding: "utf8" });
	assert.equal(invalid.status, 2);
	assert.match(invalid.stderr, /--format must be text or json/);
});
