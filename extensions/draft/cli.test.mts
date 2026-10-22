// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HELP, type Io, MAX_INPUT_BYTES, readDescriptor, runCli } from "./scripts/cli.mts";
import { filler } from "./scripts/test-kit.mts";

const SLOP =
	"This pivotal tapestry delves into a vibrant, holistic landscape. It is crucial to harness a robust paradigm and foster seamless synergy. The multifaceted interplay underscores a testament to bespoke, comprehensive and dynamic design across the ever-evolving realm of modern work.";

function invoke(args: string[], stdin: Buffer | string = "", extra: Partial<Io> = {}) {
	let out = "";
	let err = "";
	const io: Io = {
		readStdin: () => (typeof stdin === "string" ? Buffer.from(stdin) : stdin),
		stdout: (text) => {
			out += text;
		},
		stderr: (text) => {
			err += text;
		},
		env: {},
		stdoutIsTty: false,
		stdinIsTty: false,
		...extra,
	};
	const code = runCli(args, io);
	return { code, out, err };
}

test("--help prints usage, exit codes and the contract pointer", () => {
	const { code, out } = invoke(["--help"]);
	assert.equal(code, 0);
	assert.equal(out, HELP);
	assert.match(out, /Exit codes:/);
	assert.match(out, /extensions\/draft\/README\.md/);
});

test("--version prints the meter and contract versions", () => {
	const { code, out } = invoke(["--version"]);
	assert.equal(code, 0);
	assert.match(out, /^meter \d+\.\d+\.\d+ \(contract 1\)\n$/);
});

test("exit code matrix: 0 clean, 1 hard, 2 score, 3 both", () => {
	assert.equal(invoke([], filler(80)).code, 0);
	assert.equal(invoke([], `${filler(80)} A dash \u2014 here.`).code, 1);
	assert.equal(invoke(["--threshold", "5"], `${SLOP}\n\n${SLOP}`).code, 2);
	assert.equal(invoke(["--threshold", "5"], `${SLOP}\n\n${SLOP} A dash \u2014 here.`).code, 3);
});

test("--strict uses the green band edge as the threshold", () => {
	const text = `${SLOP}\n\n${filler(80)}`;
	const lenient = JSON.parse(invoke(["--format", "json"], text).out);
	const strict = JSON.parse(invoke(["--strict", "--format", "json"], text).out);
	assert.equal(lenient.score.threshold, 35);
	assert.equal(strict.score.threshold, 15);
});

test("short text never trips the score gate", () => {
	assert.equal(invoke(["--threshold", "0"], "Pivotal tapestry.").code, 0);
});

test("usage and input errors exit 4 with a stderr message", () => {
	const dir = mkdtempSync(join(tmpdir(), "meter-cli-"));
	const binary = join(dir, "binary.md");
	writeFileSync(binary, Buffer.from([0x50, 0x00, 0x51]));
	const invalid = join(dir, "latin1.md");
	writeFileSync(invalid, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
	const folder = join(dir, "folder");
	mkdirSync(folder);
	const cases: string[][] = [
		["--bogus"],
		["--format", "xml"],
		["--kind", "pdf"],
		["--threshold", "abc"],
		["--threshold", "101"],
		["--spelling", "us"],
		["a.md", "b.md"],
		["--stdin", "a.md"],
		["-v", "-q"],
		[join(dir, "missing.md")],
		[folder],
		[binary],
		[invalid],
		["--rules", join(dir, "missing.json")],
	];
	for (const args of cases) {
		const { code, err, out } = invoke(args, "text");
		assert.equal(code, 4, args.join(" "));
		assert.match(err, /^meter: /);
		assert.equal(out, "");
	}
});

test("a bad rules file fails the schema with exit 4", () => {
	const dir = mkdtempSync(join(tmpdir(), "meter-cli-"));
	const rules = join(dir, "rules.json");
	writeFileSync(rules, JSON.stringify({ version: 1, scoring: {}, rules: [] }));
	const { code, err } = invoke(["--rules", rules], "text");
	assert.equal(code, 4);
	assert.match(err, /rule data/);
});

test("a terminal with nothing piped is an error, not a wait", () => {
	const { code, err } = invoke([], "", { stdinIsTty: true });
	assert.equal(code, 4);
	assert.match(err, /no input/);
});

test("oversize and unreadable standard input exit 4", () => {
	assert.equal(invoke([], Buffer.alloc(MAX_INPUT_BYTES + 1, 0x61)).code, 4);
	const { code } = invoke([], "", {
		readStdin: () => {
			throw new Error("closed");
		},
	});
	assert.equal(code, 4);
});

test("a file target is read and its kind comes from the extension", () => {
	const dir = mkdtempSync(join(tmpdir(), "meter-cli-"));
	const file = join(dir, "sample.ts");
	writeFileSync(file, `const s = "to be honest";\n// Frankly, slow.\n`);
	const { code, out } = invoke([file, "--format", "json"]);
	const report = JSON.parse(out);
	assert.equal(code, 1);
	assert.equal(report.input.kind, "ts");
	assert.equal(report.input.target, file);
	assert.equal(report.hard.length, 1);
});

test("--kind overrides the extension and '-' reads standard input", () => {
	const { out } = invoke(["-", "--kind", "text", "--format", "json"], "A line.");
	assert.equal(JSON.parse(out).input.kind, "text");
});

test("--diff takes a diff from standard input and rejects extra targets", () => {
	const diff = ["--- a/n.md", "+++ b/n.md", "@@ -0,0 +1,1 @@", "+Frankly, no."].join("\n");
	const ok = invoke(["--diff", "--format", "json"], diff);
	assert.equal(ok.code, 1);
	assert.equal(JSON.parse(ok.out).input.kind, "diff");
	assert.equal(invoke(["--diff", "a.diff", "b.diff"], diff).code, 4);
});

test("option switches reach the analyzer", () => {
	assert.equal(JSON.parse(invoke(["--spelling", "off", "--format", "json"], "We normalize it.").out).scored.length, 0);
	assert.equal(JSON.parse(invoke(["--format", "json"], "We normalize it.").out).scored.length, 1);
	const times = JSON.parse(invoke(["--times", "12h", "--format", "json"], "It ran at 14:30.").out);
	assert.equal(times.scored.length, 1);
	const strict = JSON.parse(invoke(["--strict-semicolons", "--format", "json"], "One; two.").out);
	assert.equal(strict.hard.length, 1);
});

test("text format honours -q and prints no colour on a pipe", () => {
	const { out } = invoke(["-q"], filler(80));
	assert.match(out, /^sq [\d.]+ band green hard 0 scored \d+\n$/);
	const coloured = invoke([], filler(80), { stdoutIsTty: true, env: {} });
	assert.match(coloured.out, /\u001B\[32m/);
	const plain = invoke([], filler(80), { stdoutIsTty: true, env: { NO_COLOR: "1" } });
	assert.ok(!plain.out.includes("\u001B["));
});

test("the meter never rewrites its input", () => {
	const source = "Frankly \u2014 no.";
	const { out } = invoke(["--format", "json"], source);
	assert.ok(!out.includes('"fixed"'));
	assert.ok(!HELP.includes("--fix"));
});

test("readDescriptor reads a file descriptor to its end and stops past the limit", () => {
	const dir = mkdtempSync(join(tmpdir(), "meter-cli-"));
	const file = join(dir, "input.txt");
	writeFileSync(file, "x".repeat(200000));
	const fd = openSync(file, "r");
	try {
		assert.equal(readDescriptor(fd, 1000000).length, 200000);
	} finally {
		closeSync(fd);
	}
	const again = openSync(file, "r");
	try {
		const limited = readDescriptor(again, 1000);
		assert.ok(limited.length > 1000 && limited.length < 200000);
	} finally {
		closeSync(again);
	}
});
