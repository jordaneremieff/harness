import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, RULES } from "./rules.ts";

const bash = (command: string) => classify("bash", { command });

describe("rule set", () => {
	it("declares unique ids", () => {
		assert.equal(new Set(RULES.map((rule) => rule.id)).size, RULES.length);
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
		assert.deepEqual(bash("tail -100 system.log"), ["routing.tail-slice"]);
		assert.deepEqual(bash("rg -n x src/ | sed -n '1,5p' 2>/dev/null"), []);
	});

	it("flags an inline script that reads a file", () => {
		assert.deepEqual(bash("python3 -c \"print(open('/var/data/a').read())\""), ["routing.inline-script-read"]);
		assert.deepEqual(bash('node -e "console.log(1+1)"'), []);
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
		assert.deepEqual(bash("find src -name '*.ts'"), ["bounds.find-output-uncapped", "form.find-discovery"]);
		assert.deepEqual(bash("ls -R extensions"), ["bounds.ls-recursive-uncapped", "form.ls-recursive"]);
		assert.deepEqual(bash("du -sh node_modules"), ["bounds.du-uncapped", "form.du-traversal"]);
	});

	it("flags whole-environment filtering", () => {
		assert.deepEqual(bash("env | grep -i path"), ["form.env-grep", "routing.grep-pipe"]);
		assert.deepEqual(bash("env FOO=1 | grep x"), ["form.env-grep", "routing.grep-pipe"]);
		assert.deepEqual(bash("env -u FOO | grep PATH"), ["form.env-grep", "routing.grep-pipe"]);
		assert.deepEqual(bash("env --help | grep PATH"), ["routing.grep-pipe"]);
		assert.deepEqual(bash("env -S 'printf PATH' | grep PATH"), ["routing.grep-pipe"]);
		assert.deepEqual(bash("printenv | rg PATH"), ["form.env-grep"]);
	});

	it("classifies commands behind transparent prefixes and shell keywords", () => {
		assert.deepEqual(bash("sudo find / -name core"), ["bounds.find-output-uncapped", "form.find-discovery"]);
		assert.deepEqual(bash("command cat notes.md"), ["routing.cat-read"]);
		assert.deepEqual(bash("if grep -q TODO file; then cat file; fi"), ["form.grep-file", "routing.cat-read"]);
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
			"bounds.false-cap",
			"bounds.find-output-uncapped",
			"form.find-discovery",
		]);
		assert.deepEqual(bash("find . | jq -s . | head -2"), [
			"bounds.false-cap",
			"bounds.find-output-uncapped",
			"form.find-discovery",
		]);
		assert.deepEqual(bash("find . | grep -c ts | head -1"), [
			"bounds.false-cap",
			"bounds.find-output-uncapped",
			"form.find-discovery",
			"routing.grep-pipe",
		]);
	});

	it("does not treat tail or a buffering head as a producer cap", () => {
		assert.deepEqual(bash("find . -type f | tail -5"), [
			"bounds.false-cap",
			"bounds.find-output-uncapped",
			"form.find-discovery",
		]);
		assert.deepEqual(bash("find . | head -n -5"), [
			"bounds.false-cap",
			"bounds.find-output-uncapped",
			"form.find-discovery",
		]);
		assert.deepEqual(bash("find . | head -n +5"), [
			"bounds.false-cap",
			"bounds.find-output-uncapped",
			"form.find-discovery",
		]);
	});

	it("recognizes streaming tail and prefixed full-input commands", () => {
		assert.deepEqual(bash("find . | tail -n +5 | head -20"), ["form.find-discovery"]);
		assert.deepEqual(bash("find . | tail +5 | head -20"), ["form.find-discovery"]);
		assert.deepEqual(bash("find . | gsort | head -5"), [
			"bounds.false-cap",
			"bounds.find-output-uncapped",
			"form.find-discovery",
		]);
		assert.deepEqual(bash("find . | xargs gtail | head -2"), [
			"bounds.false-cap",
			"bounds.find-output-uncapped",
			"form.find-discovery",
		]);
	});

	it("applies output bounds to recursive grep, recursive ls, and du", () => {
		assert.deepEqual(bash("grep -rn pattern ."), ["bounds.grep-recursive-uncapped", "form.grep-file"]);
		assert.deepEqual(bash("grep -rn pattern . | head -10"), ["form.grep-file"]);
		assert.deepEqual(bash("ls -R / | head -5"), ["form.ls-recursive"]);
		assert.deepEqual(bash("du -sh x | sort | head -5"), [
			"bounds.du-uncapped",
			"bounds.false-cap",
			"form.du-traversal",
		]);
	});
});

describe("classification across shell structure", () => {
	it("collects and deduplicates classes from every statement", () => {
		assert.deepEqual(bash("cat a.txt && ls -R ."), [
			"bounds.ls-recursive-uncapped",
			"form.ls-recursive",
			"routing.cat-read",
		]);
		assert.deepEqual(bash("cat a.txt; cat b.txt"), ["routing.cat-read"]);
	});

	it("classifies nested substitutions without contaminating the parent pipeline", () => {
		assert.deepEqual(bash("echo $(( cat n ))"), []);
		assert.deepEqual(bash("echo $(( $(cat n) + 1 ))"), ["routing.cat-read"]);
		const parameterExpansion = ["$", "{var/)/x}"].join("");
		assert.deepEqual(bash(`echo $(echo ${parameterExpansion}); cat notes.md`), ["routing.cat-read"]);
		assert.deepEqual(bash('jq . <<< "$(cat f.json)"\ngrep -rn secret .'), [
			"bounds.grep-recursive-uncapped",
			"form.grep-file",
			"routing.cat-read",
		]);
		assert.deepEqual(bash("find . | grep -vf <(git ls-files | sort) | head -5"), [
			"form.find-discovery",
			"routing.grep-pipe",
		]);
	});
});
