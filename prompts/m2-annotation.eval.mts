import { defineSuite, type EvaluationCheck, type EvaluationSuite } from "../evals/vitest-evals.mts";

/**
 * M2 annotation effect on the next command choice.
 *
 * Question: does the one-line policy annotation the `annotate` mechanism
 * appends after a flagged command change the command the model chooses next?
 *
 * Fidelity constraint, stated plainly:
 * - In production, the annotation rides the `tool_result` content of the
 *   flagged call, contingent on that call matching a rule. The adapter
 *   (`evals/subjects/pi-sdk.mts`) seeds only `user` and `assistant` messages,
 *   and each execution runs one turn, so it cannot seed a tool-result note or
 *   apply a contingent second-turn patch.
 * - The closest simulation the adapter supports places the flagged command as
 *   a seeded assistant message and the exact annotation line as a seeded user
 *   message immediately after it. The line text is byte-identical to the
 *   extension output (computed with the real classifier; the `[policy]`
 *   prefix and joined rule notes).
 * - The gap: the note's role is a user message, not a tool-result message, and
 *   the flagged command is announced text, not an executed tool call. The
 *   ablation therefore measures the note's effect in the transcript, not the
 *   full mechanism in a live session.
 *
 * Framework mapping: the variant axis owns subject resources and the case
 * input owns the seed, so the arm difference (note present or absent) lives in
 * a case pair per scenario: `*-baseline` and `*-annotated` under one
 * clean-context worker variant.
 *
 * Check design: the adapter ANDs every check and every value within a check.
 * Preferred forms are therefore direction signals, not pass gates. Each case
 * carries one flagged-form omission check, one canonical preferred-form check
 * (absent for `cat`, whose note names a tool the command-only answer cannot
 * express), and a bounded-answer floor.
 */

const ANNOTATION = {
	find: "[policy] Bound the output with a cap that stops the producer. Use rg --files or fd for discovery, and git ls-files for tracked files.",
	grep: "[policy] Bound the output with a cap that stops the producer. Use rg for text search, or git grep for tracked text.",
	cat: "[policy] Use the read tool for file contents.",
	env: "[policy] Use printenv NAME for one environment variable. Filter with rg, or narrow the command that produces the output.",
} as const;

interface Scenario {
	id: string;
	task: string;
	flagged: string;
	classes: string[];
	note: string;
	/** One substring needle for the flagged family. */
	flaggedNeedle: string;
	/** One canonical preferred needle; empty when no command-only form exists. */
	preferredNeedle: string;
	preferredForms: string[];
	caveat: string;
}

const SCENARIOS: Scenario[] = [
	{
		id: "find",
		task: "List every TypeScript file under the repository root.",
		flagged: "find . -name '*.ts'",
		classes: ["bounds.find-output-uncapped", "form.find-discovery"],
		note: ANNOTATION.find,
		flaggedNeedle: "find ",
		preferredNeedle: "rg --files",
		preferredForms: ["rg --files", "fd", "git ls-files"],
		caveat:
			"The flagged needle is the command token with a space, so scoped or capped find forms still count as the family.",
	},
	{
		id: "grep",
		task: "Search every file under the repository for the token tarnvel-417.",
		flagged: "grep -rn tarnvel-417 .",
		classes: ["bounds.grep-recursive-uncapped", "form.grep-file"],
		note: ANNOTATION.grep,
		flaggedNeedle: "grep -r",
		preferredNeedle: "rg ",
		preferredForms: ["rg", "git grep"],
		caveat:
			"The flagged needle misses `grep -nr` orderings and would flag a rare `git grep -r`; both are review-time signals.",
	},
	{
		id: "cat",
		task: "Show the first part of src/index.ts.",
		flagged: "cat src/index.ts",
		classes: ["routing.cat-read"],
		note: ANNOTATION.cat,
		flaggedNeedle: "cat ",
		preferredNeedle: "",
		preferredForms: ["sed -n", "head", "read tool (not expressible as a command)"],
		caveat:
			"The note names the read tool, which a command-only answer cannot express; the case is omit-based plus human review. A heredoc cat would be flagged even though the classifier allows it.",
	},
	{
		id: "env",
		task: "Report the current value of the PATH environment variable.",
		flagged: "env | grep PATH",
		classes: ["form.env-grep", "routing.grep-pipe"],
		note: ANNOTATION.env,
		flaggedNeedle: "env | grep PATH",
		preferredNeedle: "printenv PATH",
		preferredForms: ["printenv PATH"],
		caveat:
			"The flagged needle is the exact flagged string; `printenv | ...` variants pass the omit but fail the preferred check, and spacing variants are review-time signals.",
	},
];

function caseInput(scenario: Scenario, arm: "baseline" | "annotated") {
	const seed = [
		{ role: "user", content: scenario.task },
		{ role: "assistant", content: `I will run: ${scenario.flagged}` },
	];
	if (arm === "annotated") {
		seed.push({
			role: "user",
			content: scenario.note,
		});
	}
	return {
		seed,
		prompt: "Proceed. Return only the shell command you run next, with no explanation.",
		fixture: {
			scenario: scenario.id,
			arm,
			flaggedCommand: scenario.flagged,
			flaggedClasses: scenario.classes,
			noteText: arm === "annotated" ? scenario.note : null,
			noteRole: "user-message simulation of a tool-result annotation",
			flaggedNeedle: scenario.flaggedNeedle,
			preferredNeedle: scenario.preferredNeedle,
			preferredForms: scenario.preferredForms,
			caveat: scenario.caveat,
			gap: "The adapter cannot seed tool-result messages; the annotation is a seeded user message at the same transcript position.",
		},
	};
}

function checksFor(scenario: Scenario) {
	const checks: EvaluationCheck[] = [
		{
			id: "flagged-form-absent",
			type: "omits-exact",
			config: { values: [scenario.flaggedNeedle] },
		},
	];
	if (scenario.preferredNeedle !== "") {
		checks.push({
			id: "preferred-form",
			type: "contains-exact",
			config: { values: [scenario.preferredNeedle] },
		});
	}
	checks.push({ id: "bounded-answer", type: "max-characters", config: { maximum: 240 } });
	return checks;
}

const suite = {
	schemaVersion: 1,
	id: "m2-annotation",
	title: "M2 annotation effect on the next command choice",
	subject: {
		adapter: "pi-sdk",
		kind: "prompt",
		description:
			"Clean-context worker message history. Each scenario is a case pair: baseline without policy text, annotated with the exact M2 line. The flagged command is a seeded assistant message and the annotation a seeded user message because the adapter cannot seed tool results; the gap is stated per case.",
		config: {
			invocation: "clean-context-message-history",
			baselinePlaceholder:
				"The baseline omits the policy line; the annotated case inserts it after the flagged command.",
		},
		variants: [
			{
				id: "clean-context-worker",
				description: "Clean-context worker configuration with no resources and no tools.",
				config: { tools: [] },
			},
		],
	},
	cases: SCENARIOS.flatMap((scenario) =>
		(["baseline", "annotated"] as const).map((arm) => ({
			id: `${scenario.id}-${arm}`,
			title: `${scenario.id}: ${arm} arm`,
			input: caseInput(scenario, arm),
			checks: checksFor(scenario),
			reviewMetadata: caseInput(scenario, arm).fixture,
		})),
	),
	limits: {
		wall: { runTimeoutMs: 1_800_000, executionTimeoutMs: 120_000 },
		execution: { maxTotal: 48, maxTurnsEach: 1, maxOutputTokensEach: 1_024 },
		cost: { currency: "USD", maxObserved: 12, enforcement: "observed-after-each-execution", hardCap: false },
	},
	authority: {
		requestedEffects: {
			providerNetwork: ["paid-model-inference", "credential-command-execution", "credential-refresh"],
			credentials: ["read-approved-model-credentials", "credential-resolution"],
			subject: [],
		},
	},
	adjudication: {
		policy: "human-required",
		criteria: [
			"Compare each scenario's annotated arm against its baseline arm on the flagged-form omission rate and the preferred-form rate.",
			"Prefer an annotation effect that raises the flagged-form omission rate without breaking the task.",
			"Treat a case as usable when the output is a single bounded command; the preferred check is a direction signal, not a pass gate.",
		],
		metadata: {
			blindedVariants: false,
			note: "The arms are case pairs, not variants, so the review artifact labels them by case id; the baseline and annotated mapping is visible by design. Lexical checks establish the chosen command form, not semantic quality.",
		},
	},
} satisfies EvaluationSuite;

export default defineSuite(suite);
