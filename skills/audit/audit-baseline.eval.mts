import { defineSuite, type EvaluationSuite } from "../../evals/vitest-evals.mts";
import { evaluationBoundary, outputCases } from "./audit-output-cases.mts";

type SeedInput = { seed: Array<{ role: "user" | "assistant"; content: string }>; prompt: string };
const seedInput = (input: unknown): SeedInput => input as SeedInput;
const baselinePrompt = (prompt: string): string => {
	const hint = prompt.replace(/^\/skill:audit\s*/, "").trim();
	return hint === "" ? "Audit." : hint;
};

const suite: EvaluationSuite = {
	schemaVersion: 1,
	id: "audit-baseline",
	title: "Audit plain-request baseline without the candidate skill",
	subject: {
		adapter: "pi-sdk",
		kind: "skill",
		description: "Run the ordinary request with the same synthetic facts and read-only tool, without the candidate skill or slash invocation.",
		config: {
			invocation: "plain-request-baseline",
			baseline: "This arm never includes the candidate skill or its direct command token.",
			evidenceBoundary: evaluationBoundary,
		},
		variants: [
			{
				id: "plain-request",
				description: "Expose the same read tool without loading the audit skill.",
				config: { tools: ["read"], cwd: "./fixtures", appendSystemPrompt: [evaluationBoundary] },
			},
		],
	},
	cases: outputCases.map((item) => ({
		id: item.id,
		title: item.title,
		input: { seed: seedInput(item.input).seed, prompt: baselinePrompt(seedInput(item.input).prompt) },
		checks: [{ id: "bounded-output", type: "max-characters", config: { maximum: 8000 } }],
		reviewMetadata: item.reviewMetadata,
	})),
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
			"The baseline preserves the operator's ordinary request without the candidate command or its method.",
			"The comparison records scope, evidence, units, unknowns, and causal restraint separately from the output bound.",
		],
		metadata: {
			comparisonArm: "The baseline prompt is the operator's ordinary request, not a request for the candidate's method or report form.",
		},
	},
};

export default defineSuite(suite);
