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
	it("flags a whole-file cat read", () => {
		assert.deepEqual(bash("cat README.md"), ["routing.cat-read"]);
	});

	it("separates a cat read from a cat pipe", () => {
		assert.deepEqual(bash("cat data.json | jq .name"), ["routing.cat-pipe"]);
	});

	it("does not flag a heredoc or stdin cat", () => {
		assert.deepEqual(bash("cat <<'EOF'\nbody\nEOF"), []);
		assert.deepEqual(bash("cat < input.txt"), []);
	});

	it("flags a sed line-range slice of a file", () => {
		assert.deepEqual(bash("sed -n '1,40p' src/index.ts"), ["routing.sed-slice"]);
	});

	it("does not flag sed without a file operand", () => {
		assert.deepEqual(bash("rg -n x src/ | sed -n '1,5p'"), []);
	});

	it("flags an inline script that reads a file", () => {
		assert.deepEqual(bash("python3 -c \"print(open('/tmp/a').read())\""), ["routing.inline-script-read"]);
	});

	it("does not flag an inline script with no read marker", () => {
		assert.deepEqual(bash('node -e "console.log(1+1)"'), []);
	});

	it("flags grep filtering piped output", () => {
		assert.deepEqual(bash("git config -l | grep hook"), ["routing.grep-pipe"]);
	});
});

describe("form rules", () => {
	it("flags grep against files", () => {
		assert.deepEqual(bash("grep -n pattern src/index.ts"), ["form.grep-file"]);
	});

	it("does not flag grep with a pattern only", () => {
		assert.deepEqual(bash("ls | grep -n pattern"), ["routing.grep-pipe"]);
	});

	it("flags find as discovery and as unbounded", () => {
		assert.deepEqual(bash("find src -name '*.ts'"), ["bounds.find-unbounded", "form.find-discovery"]);
	});

	it("flags a recursive ls", () => {
		assert.deepEqual(bash("ls -R extensions"), ["form.ls-recursive"]);
	});

	it("flags env piped to grep", () => {
		assert.deepEqual(bash("env | grep -i path"), ["form.env-grep", "routing.grep-pipe"]);
	});
});

describe("bounds rules", () => {
	it("treats a streaming head as a producer cap", () => {
		assert.deepEqual(bash("find . -type f | head -20"), ["form.find-discovery"]);
	});

	it("treats find -quit as a producer cap", () => {
		assert.deepEqual(bash("find . -name x -quit"), ["form.find-discovery"]);
	});

	it("does not treat a head behind a blocking stage as a cap", () => {
		assert.deepEqual(bash("find . -type f | sort | head -5"), [
			"bounds.false-cap",
			"bounds.find-unbounded",
			"form.find-discovery",
		]);
	});

	it("does not treat tail as a producer cap", () => {
		assert.deepEqual(bash("find . -type f | tail -5"), [
			"bounds.false-cap",
			"bounds.find-unbounded",
			"form.find-discovery",
		]);
	});

	it("flags an uncapped recursive grep", () => {
		assert.deepEqual(bash("grep -rn pattern ."), ["bounds.grep-recursive-uncapped", "form.grep-file"]);
	});

	it("accepts a recursive grep stopped by head", () => {
		assert.deepEqual(bash("grep -rn pattern . | head -10"), ["form.grep-file"]);
	});
});

describe("classification across statements", () => {
	it("collects classes from every statement and stage", () => {
		assert.deepEqual(bash("cat a.txt && ls -R ."), ["form.ls-recursive", "routing.cat-read"]);
	});

	it("deduplicates a repeated match", () => {
		assert.deepEqual(bash("cat a.txt; cat b.txt"), ["routing.cat-read"]);
	});
});
