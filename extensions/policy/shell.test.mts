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
	it("counts loop headers and terminators at the aggregate stage limit", () => {
		const loop = "for f in a; do echo x; done\n";
		const below = parseShellEvidence(`${loop.repeat(85)}echo tail`);
		assert.equal(below.complete, true);
		assert.equal(below.statements.length, 86);
		assert.deepEqual(below.statements.at(-1)?.[0].args, ["tail"]);
		for (const count of [86, 128, 130]) {
			for (const tail of ["echo tail", "echo $'a\\'b' ; git push #'\n", "git push\n"]) {
				const limited = parseShellEvidence(`${loop.repeat(count)}${tail}`);
				assert.ok(limited.reasons.includes("stage-limit"));
				assert.equal(limited.statements.length, 85);
				assert.ok(limited.statements.flat().every((stage) => stage.command === "echo" && stage.args[0] === "x"));
			}
		}
	});
	it("counts a standalone do split at the aggregate stage limit", () => {
		const loop = "for f in a\ndo\necho x\ndone\n";
		const below = parseShellEvidence(`${loop.repeat(63)}echo tail`);
		assert.equal(below.complete, true);
		assert.equal(below.statements.length, 64);
		const limited = parseShellEvidence(`${loop.repeat(64)}echo tail`);
		assert.ok(limited.reasons.includes("stage-limit"));
		assert.equal(limited.statements.length, 64);
		assert.ok(limited.statements.flat().every((stage) => stage.args[0] === "x"));
	});
	it("charges a piped loop terminator only once at the aggregate stage limit", () => {
		const loop = "for f in a; do echo x; done | cat\n";
		const below = parseShellEvidence(`${loop.repeat(63)}echo tail`);
		assert.ok(!below.reasons.includes("stage-limit"));
		assert.deepEqual(below.reasons, ["malformed-for-syntax"]);
		assert.equal(below.statements.length, 127);
		assert.deepEqual(below.statements.at(-1)?.[0].args, ["tail"]);
		const limited = parseShellEvidence(`${loop.repeat(64)}echo tail`);
		assert.ok(limited.reasons.includes("stage-limit"));
		assert.equal(limited.statements.length, 128);
		assert.deepEqual(limited.statements.map((statement) => statement.map((stage) => [stage.command, stage.args])),
			Array.from({ length: 64 }, () => [[["echo", ["x"]]], [["", []], ["cat", []]]]).flat());
	});
	it("counts a pipeline body at the aggregate stage limit", () => {
		const loop = "for f in a; do echo x | cat; done\n";
		const below = parseShellEvidence(`${loop.repeat(63)}echo tail`);
		assert.equal(below.complete, true);
		assert.equal(below.statements.length, 64);
		assert.deepEqual(below.statements.at(-1)?.[0].args, ["tail"]);
		const limited = parseShellEvidence(`${loop.repeat(64)}echo tail`);
		assert.ok(limited.reasons.includes("stage-limit"));
		assert.deepEqual(limited.statements.map((statement) => statement.map((stage) => [stage.command, stage.args])),
			Array.from({ length: 64 }, () => [["echo", ["x"]], ["cat", []]]));
	});
	it("shares the aggregate stage limit with loops nested in a substitution", () => {
		const loop = "for f in a; do echo x; done\n";
		const below = parseShellEvidence(`echo $(${loop.repeat(84)}echo tail)`);
		assert.equal(below.complete, true);
		assert.equal(below.statements.length, 86);
		assert.deepEqual(below.statements.at(-1)?.[0].args, ["tail"]);
		const limited = parseShellEvidence(`echo $(${loop.repeat(85)}echo tail)`);
		assert.ok(limited.reasons.includes("stage-limit"));
		assert.equal(limited.statements[0][0].command, "echo");
		assert.deepEqual(limited.statements.slice(1).map((statement) => statement.map((stage) => [stage.command, stage.args])),
			Array.from({ length: 85 }, () => [["echo", ["x"]]]));
	});
	it("counts directly nested loops at the aggregate stage limit without resolving their syntax", () => {
		const loop = "for f in a; do for g in b; do echo x; done; done\n";
		const below = parseShellEvidence(`${loop.repeat(51)}echo tail`);
		assert.ok(!below.reasons.includes("stage-limit"));
		assert.deepEqual(below.reasons, ["unsupported-for-syntax"]);
		assert.equal(below.statements.length, 154);
		assert.deepEqual(below.statements.at(-1)?.[0].args, ["tail"]);
		const limited = parseShellEvidence(`${loop.repeat(52)}echo tail`);
		assert.ok(limited.reasons.includes("stage-limit"));
		assert.deepEqual(limited.statements.map((statement) => statement.map((stage) => [stage.command, stage.args])),
			Array.from({ length: 51 }, () => [[["for", ["g", "in", "b"]]], [["echo", ["x"]]], [["done", []]]]).flat());
	});
	it("stops at the aggregate stage limit within a loop body", () => {
		const command = (count: number) => `for f in a; do ${"echo x; ".repeat(count)}done\necho tail`;
		const below = parseShellEvidence(command(253));
		assert.equal(below.complete, true);
		assert.equal(below.statements.length, 254);
		assert.deepEqual(below.statements.at(-1)?.[0].args, ["tail"]);
		for (const [count, retained] of [[254, 254], [256, 255]]) {
			const limited = parseShellEvidence(command(count));
			assert.ok(limited.reasons.includes("stage-limit"));
			assert.deepEqual(limited.statements.map((statement) => statement.map((stage) => [stage.command, stage.args])),
				Array.from({ length: retained }, () => [["echo", ["x"]]]));
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
			'for x in a > out; do echo x; done', 'for x in a; do echo x; done extra',
			`for x in a; do ${"echo x;".repeat(257)} done`,
			`for x in ${"x ".repeat(4097)}; do echo x; done`,
		]) assert.equal(parseShellEvidence(command).complete, false, command.slice(0, 120));
	});
	it("reads plain-loop bodies with the same statement and reason rules as standalone bodies", () => {
		for (const body of [
			'echo safe\n', 'cat <<<\'literal\'\n', 'cat <<\'EOF\'\n$(git push)\nEOF\n',
			'trap \'git push\' EXIT\n', 'trap \'echo cleanup\' EXIT\n',
			'echo $[ 1 <<"2" ]\ngit push\n2\n', 'echo $(trap \'git push\' EXIT)\n',
			'echo <(trap \'git push\' EXIT)\n', 'shopt -s expand_aliases\nalias p=\'git push\'\np\n',
		]) {
			const alone = parseShellEvidence(body);
			const loop = parseShellEvidence(`for f in a; do ${body}done\n`);
			assert.deepEqual(loop.statements, alone.statements, body);
			assert.deepEqual(loop.reasons, alone.reasons, body);
			assert.equal(loop.complete, alone.complete, body);
		}
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
	it("retains descriptor extraction with unavailable document expansion", () => {
		for (const word of ["2", "\\2", "'2'", '"2"']) {
			const parsed = parseShellEvidence(`cat ${word}<<EOF\n$(git push)\nEOF`);
			assert.deepEqual(parsed.statements[0][0].args, []);
			assert.equal(parsed.statements[0][0].fromRedirect, false);
			assert.ok(parsed.reasons.includes("unexpanded-heredoc"));
		}
	});
	it("leaves numeric delimiters before another redirect unavailable", () => {
		for (const word of ["2", "\\2", "'2'", '"2"']) {
			for (const redirect of [">", "<"]) {
				const body = `cat <<${word}${redirect}'x'\nfixture\n2\ngit push\nx\n`;
				for (const command of [body, `for f in a; do\n${body}done\n`, `echo $(\n${body})`, `cat <(\n${body})`]) {
					const parsed = parseShellEvidence(command);
					assert.ok(parsed.reasons.includes("unexpanded-heredoc"), command);
					assert.ok(!parsed.statements.flat().some((stage) => stage.command === "git"));
				}
			}
		}
		for (const command of ["cat <<'EOF'>'x'\nsafe\nEOF\n", "echo 2>'x'"])
			assert.equal(parseShellEvidence(command).complete, true);
	});
	it("leaves escaped-only delimiters and delimiters with inner quotes unavailable", () => {
		for (const [word, delimiter, reason] of [
			["\\EOF", "EOF", "unexpanded-heredoc"],
			["'E\"OF'", 'E"OF', "malformed-shell"],
			['"E\'OF"', "E'OF", "malformed-shell"],
			["'E\\OF'", "E\\OF", "malformed-shell"],
		]) {
			const parsed = parseShellEvidence(`cat <<${word}\nfixture\n${delimiter}\n`);
			assert.equal(parsed.complete, false);
			assert.ok(parsed.reasons.includes(reason));
		}
	});
	it("requires the first delimiter candidate to equal the exact end line", () => {
		for (const operator of ["<<", "<<-"]) {
			for (const near of [" EOF", "EOF ", "EOF\r", "x\rEOF", "x\u2028EOF", "EOF\u2028", "\tEOF"]) {
				const parsed = parseShellEvidence(`cat ${operator}'EOF'\n${near}\ncat <<'X'\nEOF\ngit push\nX\n`);
				const exact = operator === "<<-" && near === "\tEOF";
				assert.equal(parsed.complete, exact, JSON.stringify({ operator, near }));
				if (!exact) assert.ok(parsed.reasons.includes("malformed-shell"));
			}
		}
	});
	it("leaves absent end lines unavailable", () => {
		assert.ok(parseShellEvidence("cat <<'EOF'\nfixture\n").reasons.includes("malformed-shell"));
	});
	it("retains quote and end-line evidence after an operator continuation", () => {
		const parsed = parseShellEvidence("cat <<\\\n-'EOF'\n\tfixture\n\tEOF\ngit push\n");
		assert.equal(parsed.complete, false);
		assert.ok(parsed.reasons.includes("malformed-shell"));
	});
	it("retains literal bodies with a quote character and one exact end line", () => {
		for (const word of ["'EOF'", '"EOF"', "E'O'F"]) {
			const parsed = parseShellEvidence(`cat <<${word}\n$(git push)\nEOF`);
			assert.equal(parsed.complete, true);
			assert.deepEqual(parsed.statements.flat().map((stage) => stage.command), ["cat"]);
		}
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

describe("supplemental shell evidence", () => {
	it("reads literal trap actions after every original substitution", () => {
		for (const prefix of ["trap", "'trap'", "command trap", "builtin -- trap", "command -p trap", "x=y trap"]) {
			const parsed = parseShellEvidence(`${prefix} -- 'git push' EXIT`);
			assert.deepEqual(parsed.statements.at(-1)?.[0].args, ["push"]);
			assert.equal(parsed.statements.at(-1)?.[0].command, "git");
		}
		const first = `echo "$(trap '${":;".repeat(254)}' EXIT)"`;
		const second = 'echo "$(git push)"';
		for (const command of [`${first}; ${second}`, `${second}; ${first}`]) {
			const parsed = parseShellEvidence(command);
			assert.deepEqual(parsed.statements.slice(0, 4).flat().map((stage) => stage.command), ["echo", "echo", ...command.startsWith(first) ? ["trap", "git"] : ["git", "trap"]]);
			assert.ok(parsed.reasons.includes("stage-limit") || parsed.reasons.includes("parse-limit"));
		}
	});
	it("bounds supplemental depth, bytes and words without discarding original evidence", () => {
		let nested = "trap 'git push' EXIT";
		for (let index = 0; index < 8; index++) nested = `echo $(${nested})`;
		assert.ok(parseShellEvidence(nested).reasons.includes("nested-depth-limit"));
		assert.ok(parseShellEvidence(`trap '${"x".repeat(33_000)}' EXIT`).reasons.includes("command-byte-limit"));
		const parsed = parseShellEvidence(`trap 'echo ${"x ".repeat(4100)}' EXIT; git push`);
		assert.ok(parsed.reasons.includes("word-limit"));
		assert.ok(parsed.statements.flat().some((stage) => stage.command === "git"));
	});
	it("adds cause-specific reasons at each nesting position", () => {
		const cases = [
			["alias p=git\np push", "unresolved-command"],
			['echo $[ 1 <<"2" ]\ngit push\n2\n', "unexpanded-arithmetic"],
			['(\\\n( x=1 <<"2" ))\ngit push\n2\n', "unexpanded-arithmetic"],
			["echo $'a\\'b'\ngit push\n: '\n", "unsupported-shell"],
			["cat <<$'EOF'\nsafe\nEOF\ngit push\n$EOF\n", "unexpanded-heredoc"],
			["cat <<\\\n-'EOF'\nsafe\nEOF\ngit push\n-EOF\n", "unexpanded-heredoc"],
			["cat '2'<<EOF\n$(git push)\nEOF\n", "unexpanded-heredoc"],
			['echo "$\\\n(printf safe)"', "unsupported-shell"],
			[`echo "\${x:-$\\\n(printf safe)}"`, "unsupported-shell"],
			[`echo \${x:-$\\\n(printf safe)}`, "unsupported-shell"],
			[`echo \${x:-$(echo "$\\\nx")}`, "unsupported-shell"],
			['echo $(\\\n( 1 <<"2"\n$(git push)\n2\n))', "unsupported-shell"],
		] as const;
		for (const [body, reason] of cases) {
			for (const command of [body, `for x in a; do\n${body}\ndone`, `echo $(\n${body}\n)`, `cat <(\n${body}\n)`])
				assert.ok(parseShellEvidence(command).reasons.includes(reason), JSON.stringify(command));
		}
	});
	it("checks delimiter and skipped-line code units without changing the document end", () => {
		for (const bad of ["\u0001", "\u007f", "\ud800", "\udc00"]) {
			for (const command of [`cat <<'E${bad}F'\nx\nE${bad}F\n`, `cat <<'EOF'\nE${bad}F\nEOF\n`])
				assert.ok(parseShellEvidence(command).reasons.includes("malformed-shell"));
		}
		for (const body of ["cat <<'EOF'\n$\\\n(git push)\nEOF\n", "echo '$\\\nx'"]) {
			assert.ok(!parseShellEvidence(`echo $(\n${body}\n)`).reasons.includes("unsupported-shell"));
			assert.ok(!parseShellEvidence(`echo \${x:-$(\n${body}\n)}`).reasons.includes("unsupported-shell"));
		}
		for (const text of ["�", "😀"]) assert.equal(parseShellEvidence(`cat <<'E${text}F'\nsafe\nE${text}F\n`).complete, true);
	});
	it("retains literal neighbours and original redirect extraction", () => {
		for (const command of ["alias", "alias -p", "alias -p p='git push'", "alias p", "echo $[1+2]", "(( x=1+2 ))",
			"printf '%s' $'line\\n'", "printf '%s' $'\\e[31m'", "printf '%s' $'a\\\\'", "echo '$\\\nx'", "echo \\$\\\nx",
			"cat <<'EOF'\n$\\\n(git push)\nEOF\n", "cat '2'<<'EOF'\nsafe\nEOF\n"]) assert.equal(parseShellEvidence(command).complete, true, command);
		for (const word of ["'2'", '"2"', "2''"]) {
			const parsed = parseShellEvidence(`cat ${word}<<EOF\n$(git push)\nEOF\n`);
			assert.deepEqual(parsed.statements[0][0].args, []);
			assert.equal(parsed.statements[0][0].fromRedirect, false);
			assert.ok(parsed.reasons.includes("unexpanded-heredoc"));
		}
		for (const opener of ["echo $[1+2]", "(( x=1+2 ))"])
			assert.ok(parseShellEvidence(`${opener}; cat <<'EOF'\nsafe\nEOF\n`).reasons.includes("unexpanded-arithmetic"));
	});
});
