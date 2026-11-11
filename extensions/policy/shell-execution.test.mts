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

const bashVersion = spawnSync("/bin/bash", ["--version"], { encoding: "utf8", timeout: 2000, maxBuffer: 4096 });
const version = bashVersion.stdout?.split("\n")[0] ?? bashVersion.error?.message ?? "unavailable";
const versionReach = !bashVersion.error && bashVersion.status === 0 && /^GNU bash, version 3\.2\.57\(/.test(version);

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
