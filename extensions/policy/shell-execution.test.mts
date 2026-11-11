import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { evaluateCommandRecords } from "./classify.ts";
import type { RuleRecord } from "./rule.ts";

const record: RuleRecord = {
	id: "synthetic.git", source: { kind: "package" },
	matcher: { kind: "declarative", language: "command-shape/v1", onUnavailable: "deny",
		spec: { command: "git", cli: { profile: "git", subcommand: ["push"] } } },
	definition: { purpose: "Evaluate the declared command.", authority: "exact", revision: "123456abcdef",
		state: "active", effect: "block", note: "Use a permitted command shape." },
	matcherAvailable: true, staleOverride: false,
};
const scope = { cwd: "/project", provider: "test", model: "test/model" };
const cases: { name: string; command: string; executes: boolean; truth: boolean | "unknown" }[] = [];
for (const word of ["'$(git push)'", "EOF", "E\\\nOF", "\\EOF", "'2'"]) {
	cases.push({ name: `literal here-string word ${JSON.stringify(word)} inside a plain loop`,
		command: `for f in a b; do cat <<<${word}\ndone\n`, executes: false, truth: false });
}
for (const [word, delimiter] of [["'E\"OF'", 'E"OF'], ['"E\'OF"', "E'OF"], ["\\EOF", "EOF"]]) {
	cases.push({ name: `literal here-document body with delimiter ${JSON.stringify(word)}`,
		command: `cat <<${word}\n$(git push)\n${delimiter}\n`, executes: false, truth: "unknown" });
}
cases.push({ name: "literal here-document after a line continuation",
	command: "cat \\\n  <<'EOF'\n$(git push)\nEOF", executes: false, truth: false });
for (const word of ['"$(git push)"', "$(git push)"]) {
	for (const loop of [false, true]) {
		const command = `cat <<<${word}`;
		cases.push({ name: `active here-string word ${JSON.stringify(word)} ${loop ? "inside a loop" : "alone"}`,
			command: loop ? `for f in a b; do ${command}; done` : command, executes: true, truth: true });
	}
}
for (const command of ["cat <<EOF\n$(git push)\nEOF", "cat \\\n  <<EOF\n$(git push)\nEOF"]) {
	cases.push({ name: `unquoted here-document ${JSON.stringify(command.split("\n")[0])}`,
		command, executes: true, truth: "unknown" });
}
for (const [word, delimiter] of [
	['E\\"OF', 'E"OF'], ["E\\'OF", "E'OF"], ["E\\\\OF", "E\\OF"],
	["'E\"OF'", 'E"OF'], ['"E\'OF"', "E'OF"], ["'E\\OF'", "E\\OF"],
]) {
	cases.push({ name: `command after the decoded here-document delimiter ${JSON.stringify(word)}`,
		command: `cat <<${word}\nfixture body\n${delimiter}\ngit push\nEOF\n`, executes: true, truth: "unknown" });
}
for (const command of [
	"bash <<\\EOF\n$(git push)\nEOF", "cat <<'EOF' | sh\n$(git push)\nEOF",
	"bash <<<'$(git push)'", "cat <<<'$(git push)' | sh",
]) {
	cases.push({ name: `interpreter input ${JSON.stringify(command)}`, command, executes: true, truth: "unknown" });
}

for (const [word, delimiter] of [["'EOF'", "EOF"], ["\\EOF", "EOF"], ["'E\"OF'", 'E"OF']]) {
	for (const operator of ["<<", "<<-"]) {
		for (const [name, near] of [
			["leading blank", ` ${delimiter}`], ["trailing blank", `${delimiter} `],
			["carriage return", `${delimiter}\r`], ["unicode separator", `x\u2028${delimiter}`],
			["leading tab", `\t${delimiter}`],
		]) {
			for (const loop of [false, true]) {
				const top = `cat ${operator}${word}\n${near}\ncat <<'X'\n${delimiter}\ngit push\nX\n`;
				const executes = operator !== "<<-" || name !== "leading tab";
				cases.push({ name: `end line with ${name}, ${operator}${word}, ${loop ? "loop" : "top level"}`,
					command: loop ? `for f in a; do ${top}done\n` : top, executes,
					truth: word === "'EOF'" && !executes ? false : "unknown" });
			}
		}
		for (const loop of [false, true]) {
			cases.push({ name: `literal body with ${operator}${word}, ${loop ? "loop" : "top level"}`,
				command: `${loop ? "for f in a; do " : ""}cat ${operator}${word}\n$(git push)\n${delimiter}\n${loop ? "done\n" : ""}`,
				executes: false, truth: word === "'EOF'" ? false : "unknown" });
		}
	}
}

const deferredCases: { name: string; command: string; executes: boolean; truth: boolean | "unknown"; interpreter?: "csh" | "tcsh" }[] = [
	{ name: "literal trap action", command: "trap 'git push' EXIT", executes: true, truth: true },
	{ name: "loop-variable trap action", command: `for f in 'git push'; do trap "$f" EXIT; done`, executes: true, truth: "unknown" },
	{ name: "loop-variable alias value", command: `shopt -s expand_aliases\nfor f in 'git push'; do alias p="$f"; done\np`, executes: true, truth: "unknown" },
	{ name: "numeric delimiter before another redirect", command: "cat <<\\2>'x'\nfixture\n2\ngit push\nx\n", executes: true, truth: "unknown" },
	{ name: "tcsh command string", command: "tcsh -f -c 'git push'", executes: true, truth: "unknown", interpreter: "tcsh" },
	{ name: "tcsh document input", command: "tcsh -f <<'EOF'\ngit push\nEOF\n", executes: true, truth: "unknown", interpreter: "tcsh" },
	{ name: "csh here-string input", command: "csh -f <<<'git push'", executes: true, truth: "unknown", interpreter: "csh" },
	{ name: "tcsh document pipeline", command: "cat <<'EOF' | tcsh -f\ngit push\nEOF\n", executes: true, truth: "unknown", interpreter: "tcsh" },
	{ name: "process substitution DEBUG action", command: "cat <(trap 'git push' DEBUG\n:\n)", executes: true, truth: true },
	{ name: "process substitution explicit EXIT action", command: "cat <(trap 'git push' EXIT; exit)", executes: true, truth: true },
	{ name: "process substitution implicit EXIT action", command: "cat <(trap 'git push' EXIT)", executes: false, truth: true },
	{ name: "alias invocation tail", command: "shopt -s expand_aliases\nalias p=git\np push", executes: true, truth: "unknown" },
	{ name: "arithmetic expansion shift", command: 'echo $[ 1 <<"2" ]\ngit push\n2\n', executes: true, truth: "unknown" },
	{ name: "arithmetic command shift", command: '(( x = 1 <<"2" ))\ngit push\n2\n', executes: true, truth: "unknown" },
	{ name: "continued arithmetic command", command: '(\\\n( x = 1 <<"2" ))\ngit push\n2\n', executes: true, truth: "unknown" },
	{ name: "continued arithmetic expansion", command: 'echo $(\\\n( 1 <<"2"\n$(git push)\n2\n))\n', executes: true, truth: "unknown" },
	{ name: "ANSI-C escaped quote", command: "echo $'a\\'b'\ngit push\n: '\n", executes: true, truth: "unknown" },
	{ name: "ANSI-C colour operand", command: "printf '%s' $'\\e[31m'", executes: false, truth: false },
	{ name: "arithmetic without shift", command: "echo $[1+2]", executes: false, truth: false },
	{ name: "continued document operator", command: "cat <<\\\n-'EOF'\nx\nEOF\ngit push\n-EOF\n", executes: true, truth: "unknown" },
	{ name: "quoted descriptor unquoted document", command: "cat '2'<<EOF\n$(git push)\nEOF\n", executes: true, truth: "unknown" },
	{ name: "quoted descriptor literal document", command: "cat '2'<<'EOF'\n$(git push)\nEOF\n", executes: false, truth: false },
	{ name: "continued command parameter", command: "t=trap; $\\\nt 'git push' EXIT", executes: true, truth: "unknown" },
	{ name: "continued locale command", command: "$\\\n\"trap\" 'git push' EXIT", executes: true, truth: "unknown" },
	{ name: "continued alias parameter", command: "shopt -s expand_aliases\na=alias; $\\\na p=git\np push", executes: true, truth: "unknown" },
	{ name: "continued locale alias", command: "shopt -s expand_aliases\n$\\\n\"alias\" p=git\np push", executes: true, truth: "unknown" },
	{ name: "literal cleanup action", command: "trap ': cleanup' EXIT", executes: false, truth: false },
	{ name: "installation expansion", command: 'trap "echo $(printf safe)" EXIT', executes: false, truth: "unknown" },
	{ name: "injected installation value", command: `tmp='ordinary; git push'; trap "echo $tmp" EXIT`, executes: true, truth: "unknown" },
];
for (const quote of ["'", '"']) deferredCases.push({ name: `dollar-quoted document ${quote}`,
	command: `cat <<$${quote}EOF${quote}\nfixture\nEOF\ngit push\n$EOF\n`, executes: true, truth: "unknown" });
for (const [delimiter, candidate] of [["E\u0001F", "E\u0001\u0001F"], ["E\u007fF", "E\u0001\u007fF"], ["E\ud800F", "E�F"], ["E\udc00F", "E�F"], ["E�F", "E\ud800F"]])
	deferredCases.push({ name: `delimiter code units ${JSON.stringify([delimiter, candidate])}`,
		command: `cat <<'${delimiter}'\nfixture\n${candidate}\ngit push\n${delimiter}\n`, executes: true, truth: "unknown" });

const bashVersion = spawnSync("/bin/bash", ["--version"], { encoding: "utf8", timeout: 2000, maxBuffer: 4096 });
const version = bashVersion.stdout?.split("\n")[0] ?? bashVersion.error?.message ?? "unavailable";
const versionReach = !bashVersion.error && bashVersion.status === 0 && /^GNU bash, version 3\.2\.57\(/.test(version);

describe("deferred shell execution evidence", { skip: versionReach ? false : `Expectations require Bash 3.2.57; /bin/bash reports ${version}` }, () => {
	let root: string;
	before(() => {
		root = mkdtempSync(join(tmpdir(), "policy-deferred-execution-"));
		mkdirSync(join(root, "bin"));
		mkdirSync(join(root, "scratch"));
		writeFileSync(join(root, "scratch", "2"), "digit-file\n");
		writeFileSync(join(root, "bin", "git"), '#!/bin/bash\nfor arg in "$@"; do\nif [ "$arg" = push ]; then : > "$POLICY_MARKER"; fi\ndone\n', { mode: 0o700 });
		const resolved = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", "command -v git"], {
			env: { PATH: `${join(root, "bin")}:/bin` }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 2000, maxBuffer: 4096,
		});
		assert.ifError(resolved.error);
		assert.equal(resolved.status, 0);
		assert.equal(resolved.stdout.trim(), join(root, "bin", "git"));
	});
	after(() => { if (root) rmSync(root, { recursive: true, force: true }); });
	for (const [index, fixture] of deferredCases.entries()) {
		it(fixture.name, { skip: fixture.interpreter && !existsSync(`/bin/${fixture.interpreter}`) ? `${fixture.interpreter} is unavailable.` : false }, () => {
			assert.equal(/(?:^|[\s;|'"(])\/[A-Za-z]/.test(fixture.command), false, "Fixtures use private PATH resolution.");
			const marker = join(root, `marker-${index}`);
			const child = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", fixture.command], {
				cwd: join(root, "scratch"), env: { PATH: `${join(root, "bin")}:/bin`, POLICY_MARKER: marker },
				stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 2000, maxBuffer: 16_384,
			});
			assert.ifError(child.error);
			assert.equal(child.signal, null, child.stderr);
			assert.equal(existsSync(marker), fixture.executes, child.stderr);
			assert.equal(evaluateCommandRecords("bash", fixture.command, [record], scope).get(record.id), fixture.truth, fixture.command);
		});
	}
});

describe("shell input execution evidence", { skip: versionReach ? false : `Expectations require Bash 3.2.57; /bin/bash reports ${version}` }, () => {
	let root: string;
	before(() => {
		root = mkdtempSync(join(tmpdir(), "policy-shell-execution-"));
		mkdirSync(join(root, "bin"));
		mkdirSync(join(root, "scratch"));
		writeFileSync(join(root, "bin", "policy-marker"), '#!/bin/bash\n: > "$POLICY_MARKER"\n', { mode: 0o700 });
	});
	after(() => { if (root) rmSync(root, { recursive: true, force: true }); });
	for (const [index, fixture] of cases.entries()) {
		it(fixture.name, () => {
			const command = fixture.command.replaceAll("git push", "policy-marker push");
			assert.equal(command.includes("git"), false);
			const marker = join(root, `marker-${index}`);
			assert.equal(existsSync(marker), false);
			const evidence = evaluateCommandRecords("bash", fixture.command, [record], scope).get(record.id);
			const child = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
				cwd: join(root, "scratch"), env: { PATH: `${join(root, "bin")}:/usr/bin:/bin`, POLICY_MARKER: marker },
				stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 2000, maxBuffer: 16_384,
			});
			assert.ifError(child.error);
			assert.equal(child.signal, null, child.stderr);
			const executed = existsSync(marker);
			assert.equal(executed, fixture.executes, child.stderr);
			assert.equal(evidence, fixture.truth, fixture.command);
			if (executed) assert.ok(evidence === true || evidence === "unknown", fixture.command);
			if (evidence === false) assert.equal(executed, false, fixture.command);
		});
	}
});
