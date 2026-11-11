import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseShellEvidence, parseStatements } from "./shell.ts";

describe("plain for evidence", () => {
	it("retains header substitutions and simple body pipelines without delimiter stages", () => {
		for (const command of [
			'for file in $(fd -t f design | head -n 20); do wc -c "$file"; done',
			'for file in a b\ndo wc -c "$file" | sort\ndone',
			'for file in a\ndo\nwc -c "$file"\ndone',
			'for file in a; do # body follows\nwc -c "$file"; done',
			'for file in; do echo empty; done',
		]) {
			const parsed = parseShellEvidence(command);
			assert.equal(parsed.complete, true, command);
			const names = parsed.statements.flat().map((stage) => stage.command);
			assert.ok(!names.includes("for") && !names.includes("done"));
			if (command.includes("$(")) assert.deepEqual(names, ["wc", "fd", "head"]);
		}
	});
	it("leaves unsupported or incomplete control syntax unavailable", () => {
		for (const command of [
			'for x "in" a; do echo x; done', 'for x in a; "do" echo x; done',
			'for x in a; do echo x; "done"', 'for x in a; do echo x; do\\ne',
			'for x in a; do echo x', 'for x in a; do; done', 'for x in a; do done',
			'for x in a; do echo safe;; done', 'for x in a; do echo safe |; done',
			'for x in a; do | echo safe; done', 'for x in a; do echo safe | | wc; done',
			'for x in a;; do echo safe; done', 'for x in a; do; echo safe; done',
			'for ((i=0;i<3;i++)); do echo x; done',
			'for x in a; do for y in b; do echo x; done; done',
			'for x in a; do if true; then echo x; fi; done',
			'for x in a && do echo x; done', 'for x in a; do echo x & done',
			'for x in a; do (echo x); done', 'for x in a; do echo x; done | wc',
			`for x in a; do ${"echo x;".repeat(257)} done`,
			`for x in ${"x ".repeat(4097)}; do echo x; done`,
		]) assert.equal(parseShellEvidence(command).complete, false, command.slice(0, 120));
	});
});

describe("here-document delimiter evidence", () => {
	const continuations = [
		["before a delimiter with intervening blanks", "cat \\\n  <<EOF\n$(git push)\nEOF"],
		["after an output redirection", "cat > out.txt \\\n<<EOF\n$(git push)\nEOF"],
		["inside a delimiter", "cat <<E\\\nOF\n$(git push)\nEOF"],
		["between the operator and delimiter", "cat <<\\\nEOF\n$(git push)\nEOF"],
		["before a delimiter with a backtick body", "tee out.txt \\\n  <<EOF >/dev/null\n`git push`\nEOF"],
	] as const;
	for (const [position, command] of continuations) {
		it(`retains unavailable expansion evidence for a continuation ${position}`, () => {
			assert.ok(parseShellEvidence(command).reasons.includes("unexpanded-heredoc"));
		});
	}
	it("removes continuations without changing reserved-word eligibility", () => {
		assert.equal(parseShellEvidence("f\\\nor x in a; d\\\no echo safe; d\\\none").complete, true);
	});
	for (const word of ["\\2", "'2'", '"2"']) {
		it(`keeps ${word} as an operand instead of a descriptor before a here-document`, () => {
			const parsed = parseShellEvidence(`cat ${word}<<EOF\n$(git push)\nEOF`);
			assert.ok(parsed.reasons.includes("unexpanded-heredoc"));
			assert.deepEqual(parsed.statements[0][0].args, ["2"]);
			assert.equal(parsed.statements[0][0].fromRedirect, true);
		});
	}
	for (const [word, delimiter] of [
		['E\\"OF', 'E"OF'], ["E\\'OF", "E'OF"], ["E\\\\OF", "E\\OF"],
		["'E\"OF'", 'E"OF'], ['"E\'OF"', "E'OF"], ["'E\\OF'", "E\\OF"],
	]) {
		it(`ends a here-document at the decoded delimiter ${JSON.stringify(word)}`, () => {
			const parsed = parseShellEvidence(`cat <<${word}\nfixture body\n${delimiter}\ngit push\nEOF\n`);
			assert.equal(parsed.complete, true);
			assert.deepEqual(parsed.statements.flat().map((stage) => stage.command), ["cat", "git", "EOF"]);
		});
	}
	it("treats escaped delimiters as quoted without expanding their bodies", () => {
		const parsed = parseShellEvidence("cat <<\\EOF\n$(git push)\nEOF");
		assert.equal(parsed.complete, true);
		assert.deepEqual(parsed.statements.flat().map((stage) => stage.command), ["cat"]);
	});
});

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
		const [combined] = parseStatements("echo ok 2>&1 |& grep failed");
		assert.deepEqual(
			combined.map((stage) => stage.command),
			["echo", "grep"],
		);
	});

	it("does not split a pipe inside quotes", () => {
		const [statement] = parseStatements('rg -n "alpha|beta" src/');
		assert.equal(statement.length, 1);
		assert.deepEqual(statement[0].args, ["-n", "alpha|beta", "src/"]);
	});

	it("keeps substitution stages out of the parent pipeline and reads their bodies separately", () => {
		const statements = parseStatements("echo $(ls | wc -l)");
		assert.deepEqual(
			statements.map((statement) => statement.map((stage) => stage.command)),
			[["echo"], ["ls", "wc"]],
		);
	});

	it("keeps process-substitution pipes out of the parent pipeline", () => {
		const statements = parseStatements("find . | grep -vf <(git ls-files | sort) | head -5");
		assert.deepEqual(
			statements.map((statement) => statement.map((stage) => stage.command)),
			[
				["find", "grep", "head"],
				["git", "sort"],
			],
		);
	});

	it("honors quotes inside command substitution", () => {
		const statements = parseStatements('echo $(grep -c ")" file.ts)');
		assert.deepEqual(statements[1][0].args, ["-c", ")", "file.ts"]);
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

	it("skips leading assignments and command prefixes", () => {
		const [assigned] = parseStatements("FOO=1 BAR=2 rg pattern");
		assert.equal(assigned[0].command, "rg");
		const [prefixed] = parseStatements("env -i FOO=1 node script.mjs");
		assert.equal(prefixed[0].command, "node");
		const [renamed] = parseStatements("env -a worker cat notes.md");
		assert.equal(renamed[0].command, "cat");
		const [elevated] = parseStatements("sudo -u alice find / -name x");
		assert.equal(elevated[0].command, "find");
		const [replaced] = parseStatements("exec -a worker find . -name x");
		assert.equal(replaced[0].command, "find");
		const [lookup] = parseStatements("command -pv cat notes.md");
		assert.equal(lookup[0].command, "command");
		const [, conditional] = parseStatements("if grep -q x f; then cat f; fi");
		assert.equal(conditional[0].command, "cat");
	});

	it("keeps a bare env as its own command", () => {
		const [statement] = parseStatements("env | grep PATH");
		assert.equal(statement[0].command, "env");
		assert.deepEqual(statement[0].args, []);
	});

	it("marks input, output, descriptor, and here-string redirects", () => {
		const [input] = parseStatements("cat < input.txt");
		assert.equal(input[0].fromRedirect, true);
		const [stderr] = parseStatements("cat notes.md 2>/dev/null 3<&0");
		assert.equal(stderr[0].fromRedirect, false);
		assert.equal(stderr[0].toRedirect, false);
		assert.deepEqual(stderr[0].args, ["notes.md"]);
		const [output] = parseStatements("cat a b 2>/dev/null > combined.txt");
		assert.equal(output[0].toRedirect, true);
		assert.deepEqual(output[0].args, ["a", "b"]);
		const [combined] = parseStatements("echo ok &> combined.log");
		assert.equal(combined[0].toRedirect, true);
		const statements = parseStatements('jq . <<< "$(cat f.json)"\ngrep -rn secret .');
		assert.equal(statements[0][0].fromRedirect, true);
		assert.equal(statements[1][0].command, "grep");
	});

	it("keeps parameter and arithmetic expansion opaque", () => {
		const expansion = ["$", "{FILE}"].join("");
		const [statement] = parseStatements(`cat ${expansion}`);
		assert.deepEqual(statement[0].args, [expansion]);
		const arithmetic = parseStatements("echo $(( cat n ))");
		assert.deepEqual(
			arithmetic.map((entry) => entry[0].command),
			["echo"],
		);
		const nested = parseStatements("echo $(( $(cat n) + 1 ))");
		assert.deepEqual(
			nested.map((entry) => entry[0].command),
			["echo", "cat"],
		);
		const parameterExpansion = ["$", "{var/)/x}"].join("");
		const parameter = parseStatements(`echo $(echo ${parameterExpansion})`);
		assert.deepEqual(
			parameter.map((entry) => entry[0].args),
			[[`$(echo ${parameterExpansion})`], [parameterExpansion]],
		);
	});

	it("separates grouping and case-pattern boundaries", () => {
		const grouped = parseStatements("(cat f); { grep x f; }");
		assert.deepEqual(
			grouped.map((statement) => statement[0].command),
			["cat", "grep"],
		);
		const selected = parseStatements('case "$x" in yes) cat f;; esac');
		assert.equal(
			selected.some((statement) => statement[0].command === "cat"),
			true,
		);
	});

	it("ignores comments", () => {
		const statements = parseStatements("ls; # find . -type f\ncat f");
		assert.deepEqual(
			statements.map((statement) => statement[0].command),
			["ls", "cat"],
		);
	});

	it("returns no statement for empty text", () => {
		assert.deepEqual(parseStatements("   "), []);
	});
});
