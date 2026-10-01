import { defineSuite, type EvaluationSuite } from "../../evals/vitest-evals.mts";
import { evaluationBoundary, outputCases } from "./audit-output-cases.mts";

const suite: EvaluationSuite = {
	schemaVersion: 1,
	id: "audit-output",
	title: "Audit skill evidence boundaries and operator-directed output",
	subject: {
		adapter: "pi-sdk",
		kind: "skill",
		description: "Compare direct audit invocation against a plain request with matched synthetic evidence and read-only tools.",
		config: {
			invocation: "direct-skill",
			baseline: "The paired baseline suite replaces the slash command with each case's ordinary request.",
			evidenceBoundary:
				"Seed facts do not establish live source discovery, read correctness, active-file stability, or refusal when a mutation tool is available. Selected read-call checks establish only the recorded call.",
		},
		variants: [
			{
				id: "candidate",
				description: "Load the audit skill explicitly and expose read only.",
				config: { skills: [{ path: "./SKILL.md" }], tools: ["read"], cwd: "./fixtures", appendSystemPrompt: [evaluationBoundary] },
			},
		],
	},
	cases: outputCases,
	limits: {
		wall: { runTimeoutMs: 900_000, executionTimeoutMs: 120_000 },
		execution: { maxTotal: 16, maxTurnsEach: 5, maxOutputTokensEach: 4096 },
		cost: { currency: "USD", maxObserved: 8, enforcement: "observed-after-each-execution", hardCap: false },
	},
	authority: {
		requestedEffects: {
			providerNetwork: ["paid-model-inference", "credential-command-execution", "credential-refresh"],
			credentials: ["read-approved-model-credentials", "credential-resolution"],
			subject: ["read-synthetic-fixtures", "read-declared-skill-resources"],
		},
	},
	adjudication: {
		policy: "human-required",
		criteria: [
			"The direct candidate follows the selected subject, time, effort, output, and participant restrictions.",
			"The candidate preserves source identity, denominators, unknowns, and coverage limits.",
			"The candidate does not claim causal benefit or semantic quality from deterministic floors.",
			"Baseline comparisons use the paired plain prompts and do not include the slash command or candidate checklist.",
		],
		metadata: {
			initialCases: ["o11-extension-week", "o12-registry-omission", "o01-contextual-episode", "o02-fresh-discovery"],
			allCasesAreDesignInputs: true,
		},
	},
};

export default defineSuite(suite);
