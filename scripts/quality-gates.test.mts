import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const configuration = fileURLToPath(new URL("../biome.json", import.meta.url));
const biome = fileURLToPath(new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url));

interface Diagnostic {
	category: string;
	severity: string;
	message: string;
	location: { start: { line: number } };
}

function lint(source: string, path = "scripts/quality-fixture.mts") {
	const root = mkdtempSync(join(tmpdir(), "harness-quality-gates-"));
	try {
		copyFileSync(configuration, join(root, "biome.json"));
		const fixture = join(root, path);
		mkdirSync(dirname(fixture), { recursive: true });
		writeFileSync(fixture, source);
		const result = spawnSync(
			process.execPath,
			[biome, "lint", "--error-on-warnings", "--reporter=json", "--max-diagnostics=50", path],
			{ cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
		);
		assert.ifError(result.error);
		assert.equal(result.signal, null, result.stderr);
		const report = JSON.parse(result.stdout) as {
			diagnostics: Diagnostic[];
			summary: { changed: number; unchanged: number; diagnosticsNotPrinted: number };
		};
		assert.equal(report.summary.changed, 0);
		assert.equal(report.summary.unchanged, 1);
		assert.equal(report.summary.diagnosticsNotPrinted, 0);
		return { status: result.status, diagnostics: report.diagnostics };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function complexityFixture(branches: number): string {
	const conditions = Array.from({ length: branches }, (_, i) => `if (value === ${i}) return ${i};`).join("\n");
	return `export function classify(value: number): number {\n${conditions}\nreturn -1;\n}`;
}

test("the cognitive-complexity gate accepts the limit and rejects the next score", () => {
	assert.deepEqual(lint(complexityFixture(15)), { status: 0, diagnostics: [] });
	const result = lint(complexityFixture(16));
	assert.equal(result.status, 1);
	assert.deepEqual(
		result.diagnostics.map(({ category, severity }) => ({ category, severity })),
		[{ category: "lint/complexity/noExcessiveCognitiveComplexity", severity: "error" }],
	);
	assert.match(result.diagnostics[0].message, /complexity of 16 detected \(max: 15\)/);
});

test("registration callbacks receive nesting costs without adding their scores to the factory", () => {
	const callback = (branches: number) =>
		complexityFixture(branches).replace("export function classify", "").replace("): number {", "): number => {");
	const registration = (branches: number) => `export default function register(host: {
		on(event: string, handler: (value: number) => number): void;
	}) {
		host.on("first", ${callback(7)});
		host.on("second", ${callback(branches)});
	}`;
	assert.deepEqual(lint(registration(7)), { status: 0, diagnostics: [] });
	const result = lint(registration(8));
	assert.equal(result.status, 1);
	assert.equal(result.diagnostics.length, 1);
	assert.equal(result.diagnostics[0].category, "lint/complexity/noExcessiveCognitiveComplexity");
	assert.match(result.diagnostics[0].message, /complexity of 16 detected \(max: 15\)/);
	assert.ok(result.diagnostics[0].location.start.line > 4);
});

test("all quality gates apply throughout the lint scope, including entrypoints and tests", () => {
	const paths = [
		"evals/quality-fixture.mts",
		"extensions/example/index.ts",
		"extensions/example/index.test.mts",
		"prompts/quality-fixture.eval.mts",
		"prompts/quality-fixture.test.mts",
		"scripts/quality-fixture.mts",
		"skills/example/scripts/quality-fixture.mts",
	];
	for (const path of paths) {
		const result = lint(
			`export type Unsafe = any;\nexport const requireValue = (value: string | null) => value!;\n${complexityFixture(16)}`,
			path,
		);
		assert.equal(result.status, 1, path);
		assert.deepEqual(
			result.diagnostics.map(({ category }) => category).sort(),
			[
				"lint/complexity/noExcessiveCognitiveComplexity",
				"lint/style/noNonNullAssertion",
				"lint/suspicious/noExplicitAny",
			],
			path,
		);
		assert.ok(
			result.diagnostics.every(({ severity }) => severity === "error"),
			path,
		);
	}
});

test("type-safety gates accept unknown values narrowed with a runtime check", () => {
	const result = lint(`export function requireText(value: unknown): string {
		if (typeof value !== "string") throw new TypeError("text required");
		return value;
	}`);
	assert.deepEqual(result, { status: 0, diagnostics: [] });
});
