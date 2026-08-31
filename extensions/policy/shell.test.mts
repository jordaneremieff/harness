import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStatements } from "./shell.ts";

describe("parseStatements", () => {
	it("reads one command and its operands", () => {
		const [statement] = parseStatements("rg -n pattern src/");
		assert.equal(statement.length, 1);
		assert.equal(statement[0].command, "rg");
		assert.deepEqual(statement[0].args, ["-n", "pattern", "src/"]);
		assert.equal(statement[0].fromPipe, false);
		assert.equal(statement[0].toPipe, false);
	});

	it("strips a directory prefix from the command word", () => {
		const [statement] = parseStatements("/usr/bin/grep -r x .");
		assert.equal(statement[0].command, "grep");
	});

	it("marks pipeline position on each stage", () => {
		const [statement] = parseStatements("find . -type f | sort | head -5");
		assert.deepEqual(
			statement.map((stage) => [stage.command, stage.fromPipe, stage.toPipe]),
			[
				["find", false, true],
				["sort", true, true],
				["head", true, false],
			],
		);
	});

	it("does not split a pipe inside quotes", () => {
		const [statement] = parseStatements('rg -n "alpha|beta" src/');
		assert.equal(statement.length, 1);
		assert.deepEqual(statement[0].args, ["-n", "alpha|beta", "src/"]);
	});

	it("does not split a pipe inside command substitution", () => {
		const [statement] = parseStatements('echo $(ls | wc -l)');
		assert.equal(statement.length, 1);
		assert.equal(statement[0].command, "echo");
	});

	it("splits statements on ;, &&, || and newline", () => {
		const statements = parseStatements("ls; pwd && date || true\ncat f");
		assert.deepEqual(
			statements.map((statement) => statement[0].command),
			["ls", "pwd", "date", "true", "cat"],
		);
	});

	it("consumes a heredoc body instead of reading it as commands", () => {
		const statements = parseStatements("cat > out.txt <<'EOF'\ngrep -r secret /\nfind / -name x\nEOF\necho done");
		assert.deepEqual(
			statements.map((statement) => statement[0].command),
			["cat", "echo"],
		);
	});

	it("skips leading assignments and an env prefix", () => {
		const [assigned] = parseStatements("FOO=1 BAR=2 rg pattern");
		assert.equal(assigned[0].command, "rg");
		const [prefixed] = parseStatements("env FOO=1 node script.mjs");
		assert.equal(prefixed[0].command, "node");
	});

	it("keeps a bare env as its own command", () => {
		const [statement] = parseStatements("env | grep PATH");
		assert.equal(statement[0].command, "env");
		assert.deepEqual(statement[0].args, []);
	});

	it("marks a stage that reads from a redirect", () => {
		const [statement] = parseStatements("cat < input.txt");
		assert.equal(statement[0].fromRedirect, true);
	});

	it("returns no statement for empty text", () => {
		assert.deepEqual(parseStatements("   "), []);
	});
});
