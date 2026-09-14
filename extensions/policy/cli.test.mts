import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandEvidence, evaluateCommandRecords, matchRuleRecords } from "./classify.ts";
import { decodeGitPush, isGitPushFlag } from "./cli.ts";
import { captureEvidence, compileRule } from "./compiler.ts";
import { snapshotData } from "./data.ts";
import { planInput } from "./program.ts";
import type { CommandShapeSpec, RuleRecord } from "./rule.ts";
import { parseShellEvidence, parseStatements } from "./shell.ts";

const scope = { cwd: "/synthetic" };
function record(spec: Partial<CommandShapeSpec> = {}): RuleRecord {
	return {
		id: "git.force",
		source: { kind: "package" },
		matcher: {
			kind: "declarative",
			language: "command-shape/v1",
			onUnavailable: "deny",
			spec: {
				command: "git",
				cli: { profile: "git", subcommand: ["push"] },
				anyFlags: ["--force", "-f"],
				...spec,
			},
		},
		definition: {
			purpose: "Prevent plain force occurrences.",
			authority: "steer-or-block",
			revision: "123456abcdef",
			state: "active",
			effect: "block",
			note: "Remove plain force.",
		},
		matcherAvailable: true,
		staleOverride: false,
	};
}
const truth = (command: string, rule = record()) => evaluateCommandRecords("bash", command, [rule], scope).get(rule.id);
const decode = (command: string) => decodeGitPush(parseStatements(command)[0][0]);

test("Git push grammar distinguishes option occurrences from consumed values and operands", () => {
	for (const command of [
		"git push -f origin main",
		"git push -uf origin main",
		"git push -fu origin main",
		"git push origin main --force",
		"git -C elsewhere -c key=value push --force origin main",
		"git --git-dir=repo --work-tree elsewhere push --force",
		"git push --force --force-with-lease=main",
		"git push --force-with-lease=main --force",
		"git push --force --no-force",
		"git push '-f'",
		'git push "--force"',
	])
		assert.equal(truth(command), true, command);
	for (const command of [
		"git push -ofool origin main",
		"git push -o --force origin main",
		"git push -o -f origin main",
		"git push --push-option=--force origin main",
		"git push -- origin --force",
		"git push --force-with-lease=main",
		"git push --force-with-lease main",
		"git -C push status --force",
		"git -c push status --force",
		"git status --force",
		"echo git push --force",
		"git push --no-force",
		"git --version push --force",
		"git push '$FLAGS'",
		"git push \\$FLAGS",
	])
		assert.equal(truth(command), false, command);
});

test("wrapper options do not hide force occurrences or unresolved split commands", () => {
	for (const command of ["command git push -vf origin main", "command -p git push -fv origin main"]) {
		assert.equal(truth(command), true, command);
		assert.equal(planInput([compileRule(record())], { command }, { tool: "bash", scope }).denied, true);
	}
	for (const command of [
		"env -S 'git push --force' origin main",
		"env --split-string='git push --force' origin main",
		"env -Sgit push --force origin main",
		"env -iS 'git push --force' origin main",
		"env --split-str='git push --force' origin main",
	]) {
		assert.equal(truth(command), "unknown", command);
		assert.equal(planInput([compileRule(record())], { command }, { tool: "bash", scope }).denied, true);
	}
	for (const command of [
		"command -v git push -f",
		"env NAME=value echo done",
		"env -ii echo done",
		"env -u -S echo done",
		"env -uS echo done",
		"env -C -S echo done",
		"env --unset=-S echo done",
		"env -- echo -iS 'git push --force'",
		"env -- -S 'git push --force'",
	])
		assert.equal(truth(command), false, command);
});

test("Git option evidence retains identity, spelling, values, indexes, polarity and order", () => {
	const result = decode(
		"git -C repo push -uf --force --no-force --force-with-lease=main --no-force-with-lease -ofool origin main",
	);
	assert.equal(result.status, "known");
	if (result.status !== "known") return;
	assert.deepEqual(result.globals, [
		{ spelling: "-C", canonical: "-C", value: "repo", argumentIndex: 0, polarity: "set" },
	]);
	assert.deepEqual(
		result.options.map(({ spelling, canonical, value, argumentIndex, polarity }) => [
			spelling,
			canonical,
			value,
			argumentIndex,
			polarity,
		]),
		[
			["-u", "set-upstream", undefined, 3, "set"],
			["-f", "force", undefined, 3, "set"],
			["--force", "force", undefined, 4, "set"],
			["--no-force", "force", undefined, 5, "unset"],
			["--force-with-lease", "force-with-lease", "main", 6, "set"],
			["--no-force-with-lease", "force-with-lease", undefined, 7, "unset"],
			["-o", "push-option", "fool", 8, "set"],
		],
	);
	assert.deepEqual(result.operands, ["origin", "main"]);
	assert.equal(isGitPushFlag("--force"), true);
	assert.equal(isGitPushFlag("--force=value"), false);
});

test("unknown forms, missing values and dynamic shell data never prove option absence", () => {
	for (const command of [
		"git -Crepo push --force",
		"git -ck=v push --force",
		"git -pP push --force",
		"git -- push --force",
		"git push --for",
		"git push '--*'",
		"git push --force=yes",
		"git push --no-force-with-lease=main",
		"git push -o",
		"git -C",
		"git push $FLAGS origin main",
		'git push "$FLAGS"',
		["git push $", "{FLAGS}"].join(""),
		"git push --*",
		"git push $'--force'",
		'git push $"--force"',
		"git push $(printf -- --force)",
		"git pu{sh,ll} --force",
		"git push 'unterminated",
		"git push $(printf x",
		"git push `printf x",
		"git push >",
		"git push |",
		["echo $", "{VALUE:-$(git push --force)}"].join(""),
		['echo "$', '{VALUE:-$(git push --force)}"'].join(""),
		"echo $((value))",
		"$TOOL push --force",
		"bash -c 'git push --force'",
		"env -S 'git push --force'",
		"eval 'git push --force'",
	]) {
		const result = evaluateCommandRecords("bash", command, [record()], scope);
		assert.equal(result.get("git.force"), "unknown", command);
		assert.ok(result.reasons.get("git.force")?.length, command);
		assert.ok(result.reasons.get("git.force")!.every((reason) => /^[a-z0-9.-]{1,80}$/.test(reason)));
	}
});

test("literal mode and CLI mode have distinct operand and flag contracts", () => {
	const literal = record({ cli: undefined });
	assert.equal(truth("git push -uf", literal), false);
	assert.equal(truth("git push -- --force", literal), true);
	assert.equal(truth("git push -o --force", literal), true);
	for (const command of ["env -ii git push --force", "env -iv git push --force", "env -iS git push --force"])
		assert.equal(truth(command, literal), true, command);
	assert.equal(truth("git push --force", record({ flags: ["--force", "-f"] })), false);
	assert.equal(truth("git push --force -f", record({ flags: ["--force", "-f"] })), true);
	assert.equal(
		truth("git push --force --force-with-lease=main", record({ absentFlags: ["--force-with-lease"] })),
		false,
	);
	const operands = record({ operands: { min: 2, max: 2, any: ["main"], at: { "0": ["origin"], "1": ["main"] } } });
	assert.equal(truth("git -C path push -o value origin main --force", operands), true);
	assert.equal(truth("git push --force origin other", operands), false);
});

test("one true stage wins while unresolved candidates prevent false absence", () => {
	assert.equal(truth("echo $VALUE; git push --force"), true);
	assert.equal(truth("git push $FLAGS; git push -f"), true);
	assert.equal(truth("git push $FLAGS; git status"), "unknown");
	assert.equal(truth("echo $VALUE; git status"), false);
	assert.equal(truth("echo $(git push -f)"), true);
	assert.equal(truth("git push $FLAGS", record({ pipe: { to: true } })), false);
	const rule = record();
	assert.deepEqual(matchRuleRecords("bash", "git push $FLAGS", [rule], scope), []);
	assert.deepEqual(matchRuleRecords("bash", "git push -f", [rule], scope), [rule]);
});

test("shell and CLI resource limits preserve unavailable evidence across stages", () => {
	for (const command of [
		`echo ${"x".repeat(65536)}`,
		`git push ${"main ".repeat(4097)}`,
		"echo x;".repeat(257),
		`git push -${"u".repeat(4096)}`,
		Array.from({ length: 200 }, () => `git push -${"u".repeat(20)}`).join(";"),
		`${"echo $(".repeat(10)}echo x${")".repeat(10)}`,
	])
		assert.equal(truth(command), "unknown", command.slice(0, 80));
	assert.equal(truth(`git push ${"main ".repeat(2000)}`), false);
	assert.equal(parseShellEvidence("echo x;".repeat(256)).complete, true);
	assert.equal(parseShellEvidence("echo x;".repeat(257)).complete, false);
});

test("shell words preserve quoted and escaped literals without expansion", () => {
	const parsed = parseShellEvidence("git push '$FLAGS' \"\\$FLAGS\" \\$FLAGS $FLAGS \"$FLAGS\" --* '--*'");
	assert.equal(parsed.complete, true);
	assert.deepEqual(parsed.statements[0][0].argLiterals, [true, true, true, true, false, false, false, true]);
	assert.equal(parseShellEvidence("echo $(printf x").complete, false);
	assert.equal(parseShellEvidence("(echo x").complete, false);
	assert.equal(parseShellEvidence("echo x )").complete, false);
	assert.equal(truth("cat <<EOF\n$(git push --force)\nEOF"), "unknown");
	assert.equal(truth("cat <<'EOF'\n$(git push --force)\nEOF"), false);
});

test("approved unknown denial remains subordinate to scope, applicability and selected effect", () => {
	const rule = record();
	const context = { tool: "bash", scope };
	const input = { command: "git push $FLAGS" };
	const compiled = compileRule(rule);
	const captured = captureEvidence([compiled], "bash", input, scope);
	assert.ok(captured instanceof CommandEvidence);
	assert.equal(captured.get(rule.id), "unknown");
	const plan = planInput([compiled], input, context);
	assert.equal(plan.denied, true);
	assert.ok(plan.evaluations.some((evaluation) => evaluation.unavailableReasons?.includes("dynamic-word")));
	for (const effect of ["steer", "block"] as const) {
		const selected = record();
		selected.definition.effect = effect;
		if (selected.matcher.kind === "declarative" && selected.matcher.language === "command-shape/v1")
			selected.matcher.onUnavailable = "skip";
		assert.equal(planInput([compileRule(selected)], input, context).denied, false);
	}
	const steered = record();
	steered.override = {
		effect: "steer",
		reason: "Approved guidance",
		againstDefinitionRevision: steered.definition.revision,
		audit: { at: "2026-09-14", session: "test", model: null, surface: "command" },
	};
	assert.equal(planInput([compileRule(steered)], input, context).denied, false);
	for (const applicable of [false, undefined]) {
		const scoped = record();
		scoped.definition.applicability = { op: "eq", path: ["input", "active"], value: true };
		assert.equal(
			planInput(
				[compileRule(scoped)],
				{ ...input, ...(applicable === undefined ? {} : { active: applicable }) },
				context,
			).denied,
			false,
		);
	}
	for (const modification of ["scope", "disabled", "retired", "unavailable"] as const) {
		const excluded = record();
		if (modification === "scope") excluded.definition.scope = { models: ["provider/other"] };
		if (modification === "retired") excluded.definition.state = "retired";
		if (modification === "unavailable") excluded.matcherAvailable = false;
		if (modification === "disabled")
			excluded.override = {
				state: "disabled",
				reason: "Disabled",
				againstDefinitionRevision: excluded.definition.revision,
				audit: { at: "2026-09-14", session: "test", model: null, surface: "command" },
			};
		assert.equal(captureEvidence([compileRule(excluded)], "bash", undefined, scope).get(excluded.id), false);
		assert.equal(truth(input.command, excluded), false);
	}
});

test("final CLI checks reparse the complete corrected input and roll back unknown-denying changes", () => {
	for (const candidate of ["git push --force", "git push $FLAGS"]) {
		const correction: RuleRecord = {
			...record(),
			id: "command.repair",
			matcher: {
				kind: "declarative",
				language: "facts/v1",
				spec: {
					phase: "input",
					when: { op: "exists", path: ["input"] },
					action: { kind: "substitute", path: ["command"], table: "commands" },
					data: ["commands"],
					onUnavailable: "deny",
				},
			},
		};
		correction.definition = { ...correction.definition, authority: "exact", effect: "correct" };
		const data = snapshotData(
			[
				{
					kind: "table",
					name: "commands",
					revision: "abcdef123456",
					capturedAt: 1,
					source: "synthetic",
					rows: [{ key: "safe", value: candidate }],
				},
			],
			2,
		);
		const input = { command: "safe" };
		const plan = planInput([compileRule(correction), compileRule(record())], input, {
			tool: "bash",
			scope,
			data,
			schema: {
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
				additionalProperties: false,
			},
		});
		assert.equal(plan.denied, true);
		assert.equal(plan.changed, false);
		assert.deepEqual(plan.candidate, input);
		assert.equal(
			plan.evaluations.find((evaluation) => evaluation.id === "git.force" && evaluation.inputView === "effective")
				?.deny,
			true,
		);
	}
});
