import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "./classify.ts";
import { RULES } from "./shell-rules.ts";

const bash = (command: string) => classify("bash", { command });

describe("rule set", () => {
	it("declares unique ids", () => {
		assert.equal(new Set(RULES.map((rule) => rule.id)).size, RULES.length);
	});

	it("carries one line of guidance for every rule", () => {
		for (const rule of RULES) {
			assert.ok(rule.note.length > 0, rule.id);
			assert.equal(rule.note.includes("\n"), false, rule.id);
		}
	});

	it("records nothing for a tool without a declared input capture", () => {
		assert.deepEqual(classify("read", { path: "/etc/passwd" }), []);
	});

	it("records nothing for a command that matches no rule", () => {
		assert.deepEqual(bash("npm test"), []);
		assert.deepEqual(bash("rg -n pattern src/"), []);
		assert.deepEqual(bash("git ls-files extensions/"), []);
	});
});

describe("routing rules", () => {
	it("flags a one-file cat read and a cat pipe", () => {
		assert.deepEqual(bash("cat README.md"), ["routing.cat-read"]);
		assert.deepEqual(bash("cat notes.md 2>/dev/null"), ["routing.cat-read"]);
		assert.deepEqual(bash("cat file 2>&1"), ["routing.cat-read"]);
		assert.deepEqual(bash("cat data.json | jq .name"), ["routing.cat-pipe"]);
	});

	it("does not flag a heredoc, stdin cat, or redirected join", () => {
		assert.deepEqual(bash("cat <<'EOF'\nbody\nEOF"), []);
		assert.deepEqual(bash("cat < input.txt"), []);
		assert.deepEqual(bash("cat a b > combined.txt"), []);
	});

	it("flags file slices but not pipeline slices", () => {
		assert.deepEqual(bash("sed -n '1,40p' src/index.ts"), ["routing.sed-slice"]);
		assert.deepEqual(bash("head -50 src/index.ts"), ["routing.head-slice"]);
		assert.deepEqual(bash("ghead -50 src/index.ts"), ["routing.head-slice"]);
		assert.deepEqual(bash("head -50 src/index.ts 2>/dev/null"), ["routing.head-slice"]);
		assert.deepEqual(bash("sed -n '1,40p' src/index.ts 2>/dev/null"), ["routing.sed-slice"]);
		assert.deepEqual(bash("tail -n +100 system.log"), ["routing.tail-slice"]);
		assert.deepEqual(bash("tail +100 system.log"), ["routing.tail-slice"]);
		assert.deepEqual(bash("rg -n x src/ | sed -n '1,5p' 2>/dev/null"), []);
	});

	it("permits the slices the read tool cannot give", () => {
		assert.deepEqual(bash("tail -100 system.log"), []);
		assert.deepEqual(bash("tail -n 20 system.log"), []);
		assert.deepEqual(bash("tail -c 12000 system.log"), []);
		assert.deepEqual(bash("tail system.log"), []);
		assert.deepEqual(bash("head -c 12000 src/index.ts"), []);
		assert.deepEqual(bash("head -n -5 src/index.ts"), []);
	});

	it("flags an inline script that reads a file", () => {
		assert.deepEqual(bash("python3 -c \"print(open('/var/data/a').read())\""), ["routing.inline-script-read"]);
		assert.deepEqual(bash('node -e "console.log(1+1)"'), []);
		assert.deepEqual(bash('node -e \'console.log(require("fs").readFileSync("a.txt", "utf8"))\''), [
			"routing.inline-script-read",
		]);
	});

	it("permits an inline script that processes data instead of reading a file", () => {
		assert.deepEqual(bash("python3 -c \"import json; print(len(json.load(open('a.json'))))\""), []);
		assert.deepEqual(bash("python3 -c 'for line in open(\"a.csv\"): print(line)'"), []);
		assert.deepEqual(bash(`python3 -c 'with open("a.csv") as f:\n    print(f.read())'`), []);
		assert.deepEqual(bash(`python3 -c '${`print(open("a").read())\n`.repeat(3)}'`), []);
		assert.deepEqual(bash(`python3 -c "print(open('${"a".repeat(200)}').read())"`), []);
	});

	it("flags grep filtering piped output but not a quiet predicate", () => {
		assert.deepEqual(bash("git config -l | grep hook"), ["routing.grep-pipe"]);
		assert.deepEqual(bash("git status --porcelain | grep -q ."), []);
	});
});

describe("form rules", () => {
	it("flags grep against files in positional and option forms", () => {
		assert.deepEqual(bash("grep -n pattern src/index.ts"), ["form.grep-file"]);
		assert.deepEqual(bash("grep -e pattern src/index.ts"), ["form.grep-file"]);
		assert.deepEqual(bash("grep -f patterns.txt src/index.ts"), ["form.grep-file"]);
	});

	it("does not flag grep with a pattern only", () => {
		assert.deepEqual(bash("ls | grep -n pattern"), ["routing.grep-pipe"]);
	});

	it("flags the named discovery and traversal forms", () => {
		assert.deepEqual(bash("find src -name '*.ts'"), ["form.find-discovery", "bounds.find-output-uncapped"]);
		assert.deepEqual(bash("ls -R extensions"), ["form.ls-recursive", "bounds.ls-recursive-uncapped"]);
		assert.deepEqual(bash("du -sh node_modules"), ["form.du-traversal", "bounds.du-uncapped"]);
	});

	it("flags whole-environment filtering", () => {
		assert.deepEqual(bash("env | grep -i path"), ["routing.grep-pipe", "form.env-grep"]);
		assert.deepEqual(bash("env FOO=1 | grep x"), ["routing.grep-pipe", "form.env-grep"]);
		assert.deepEqual(bash("env -u FOO | grep PATH"), ["routing.grep-pipe", "form.env-grep"]);
		assert.deepEqual(bash("env --help | grep PATH"), ["routing.grep-pipe"]);
		assert.deepEqual(bash("env -S 'printf PATH' | grep PATH"), ["routing.grep-pipe"]);
		assert.deepEqual(bash("printenv | rg PATH"), ["form.env-grep"]);
	});

	it("leaves a bounded pattern over printenv output clean", () => {
		assert.deepEqual(bash("printenv | rg '^PATH$'"), ["form.env-grep"]);
		assert.deepEqual(bash("printenv | rg -v KEY"), []);
		assert.deepEqual(bash("printenv | rg '^PI_' | rg -v 'KEY|TOKEN|SECRET' | head -20"), []);
		assert.deepEqual(bash("env | rg '^PI_'"), ["form.env-grep"]);
	});

	it("classifies commands behind transparent prefixes and shell keywords", () => {
		assert.deepEqual(bash("sudo find / -name core"), ["form.find-discovery", "bounds.find-output-uncapped"]);
		assert.deepEqual(bash("command cat notes.md"), ["routing.cat-read"]);
		assert.deepEqual(bash("if grep -q TODO file; then cat file; fi"), ["routing.cat-read", "form.grep-file"]);
	});
});

describe("bounds rules", () => {
	it("treats a streaming head and find -quit as producer caps", () => {
		assert.deepEqual(bash("find . -type f | head -20"), ["form.find-discovery"]);
		assert.deepEqual(bash("find . -type f | ghead -20"), ["form.find-discovery"]);
		assert.deepEqual(bash("find . -name x -quit"), ["form.find-discovery"]);
	});

	it("does not treat a head behind a full-input stage as a cap", () => {
		assert.deepEqual(bash("find . -type f | sort | head -5"), [
			"form.find-discovery",
			"bounds.find-output-uncapped",
			"bounds.false-cap",
		]);
		assert.deepEqual(bash("find . | jq -s . | head -2"), [
			"form.find-discovery",
			"bounds.find-output-uncapped",
			"bounds.false-cap",
		]);
		assert.deepEqual(bash("find . | grep -c ts | head -1"), [
			"routing.grep-pipe",
			"form.find-discovery",
			"bounds.find-output-uncapped",
			"bounds.false-cap",
		]);
	});

	it("does not treat tail or a buffering head as a producer cap", () => {
		assert.deepEqual(bash("find . -type f | tail -5"), [
			"form.find-discovery",
			"bounds.find-output-uncapped",
			"bounds.false-cap",
		]);
		assert.deepEqual(bash("find . | head -n -5"), [
			"form.find-discovery",
			"bounds.find-output-uncapped",
			"bounds.false-cap",
		]);
		assert.deepEqual(bash("find . | head -n +5"), [
			"form.find-discovery",
			"bounds.find-output-uncapped",
			"bounds.false-cap",
		]);
	});

	it("recognizes streaming tail and prefixed full-input commands", () => {
		assert.deepEqual(bash("find . | tail -n +5 | head -20"), ["form.find-discovery"]);
		assert.deepEqual(bash("find . | tail +5 | head -20"), ["form.find-discovery"]);
		assert.deepEqual(bash("find . | gsort | head -5"), [
			"form.find-discovery",
			"bounds.find-output-uncapped",
			"bounds.false-cap",
		]);
		assert.deepEqual(bash("find . | xargs gtail | head -2"), [
			"form.find-discovery",
			"bounds.find-output-uncapped",
			"bounds.false-cap",
		]);
	});

	it("applies output bounds to recursive grep, recursive ls, and du", () => {
		assert.deepEqual(bash("grep -rn pattern ."), ["form.grep-file", "bounds.grep-recursive-uncapped"]);
		assert.deepEqual(bash("grep -rn pattern . | head -10"), ["form.grep-file"]);
		assert.deepEqual(bash("ls -R / | head -5"), ["form.ls-recursive"]);
		assert.deepEqual(bash("du -sh x | sort | head -5"), [
			"form.du-traversal",
			"bounds.du-uncapped",
			"bounds.false-cap",
		]);
	});

	it("treats an fd result cap as a producer bound and a depth flag as none", () => {
		assert.deepEqual(bash("fd --max-results 50 -e ts src/"), []);
		assert.deepEqual(bash("fd --max-results=50 -e ts src/"), []);
		assert.deepEqual(bash("fd -1 config ."), []);
		assert.deepEqual(bash("fd --max-results 50 . | sort | head -5"), []);
		assert.deepEqual(bash("fd --max-depth 2 -e ts src/"), ["bounds.fd-uncapped"]);
		assert.deepEqual(bash("fd -m 50 -e ts src/"), ["bounds.fd-uncapped"]);
		assert.deepEqual(bash("rg --files -m 50 src/"), ["bounds.rg-files-uncapped"]);
	});

	it("treats an awk that exits as a producer cap and one without exit as none", () => {
		assert.deepEqual(bash("git grep -n pattern | awk 'NR<=300 {print} NR==301 {exit}'"), []);
		assert.deepEqual(bash("find . -type f | awk 'NR<=300 {print} NR==301 {exit}'"), ["form.find-discovery"]);
		assert.deepEqual(bash("find . -type f | awk 'NR<=300 {print}'"), [
			"form.find-discovery",
			"bounds.find-output-uncapped",
		]);
		assert.deepEqual(bash("find . -type f | sort | awk 'NR<=5 {print} NR==6 {exit}'"), [
			"form.find-discovery",
			"bounds.find-output-uncapped",
			"bounds.false-cap",
		]);
	});

	it("leaves a usage or version request unclassified", () => {
		assert.deepEqual(bash("fd --help"), []);
		assert.deepEqual(bash("fd --version"), []);
		assert.deepEqual(bash("fd -V"), []);
		assert.deepEqual(bash("find --help"), []);
		assert.deepEqual(bash("du --help"), []);
		assert.deepEqual(bash("rg --files --help"), []);
		assert.deepEqual(bash("fd --help | rg max-results"), []);
	});

	it("applies output bounds to discovery traversals", () => {
		assert.deepEqual(bash("rg --files -g '*.ts' | wc -l"), ["bounds.rg-files-uncapped"]);
		assert.deepEqual(bash("fd -e ts | wc -l"), ["bounds.fd-uncapped"]);
		assert.deepEqual(bash("rg --files -g '*.ts' | cut -d/ -f2 | sort | uniq -c | sort -rn | head -20"), [
			"bounds.rg-files-uncapped",
			"bounds.false-cap",
		]);
		assert.deepEqual(bash("fd -e ts | sort | head -10"), ["bounds.fd-uncapped", "bounds.false-cap"]);
		assert.deepEqual(bash("rg --files | head -20"), []);
		assert.deepEqual(bash("fd -e ts | head -10"), []);
	});

	it("flags only an unscoped uncapped recursive search", () => {
		assert.deepEqual(bash("rg -n pattern ."), ["bounds.rg-search-uncapped"]);
		assert.deepEqual(bash("rg -n pattern"), ["bounds.rg-search-uncapped"]);
		assert.deepEqual(bash("git grep -n pattern"), ["bounds.git-grep-uncapped"]);
		assert.deepEqual(bash("rg -n pattern src/"), []);
		assert.deepEqual(bash("git grep -n pattern src/"), []);
		assert.deepEqual(bash("git grep -n pattern -- src/"), []);
		assert.deepEqual(bash("rg -m 20 -n pattern ."), []);
		assert.deepEqual(bash("rg --max-count 20 -n pattern ."), []);
		assert.deepEqual(bash("git grep -m 20 -n pattern"), []);
		assert.deepEqual(bash("rg -n pattern . | head -20"), []);
	});
});

describe("classification across shell structure", () => {
	it("collects and deduplicates classes from every statement", () => {
		assert.deepEqual(bash("cat a.txt && ls -R ."), [
			"routing.cat-read",
			"form.ls-recursive",
			"bounds.ls-recursive-uncapped",
		]);
		assert.deepEqual(bash("cat a.txt; cat b.txt"), ["routing.cat-read"]);
	});

	it("classifies nested substitutions without contaminating the parent pipeline", () => {
		assert.deepEqual(bash("echo $(( cat n ))"), []);
		assert.deepEqual(bash("echo $(( $(cat n) + 1 ))"), ["routing.cat-read"]);
		const parameterExpansion = ["$", "{var/)/x}"].join("");
		assert.deepEqual(bash(`echo $(echo ${parameterExpansion}); cat notes.md`), ["routing.cat-read"]);
		assert.deepEqual(bash('jq . <<< "$(cat f.json)"\ngrep -rn secret .'), [
			"routing.cat-read",
			"form.grep-file",
			"bounds.grep-recursive-uncapped",
		]);
		assert.deepEqual(bash("find . | grep -vf <(git ls-files | sort) | head -5"), [
			"routing.grep-pipe",
			"form.find-discovery",
		]);
	});
});
