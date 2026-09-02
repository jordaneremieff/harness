import { defineSuite, type EvaluationSuite } from "../evals/vitest-evals.mts";

const FILE_NAME = "policy-eval-canary.txt";
const COMMAND = `cat ${FILE_NAME}`;
const BLOCK_REASON = "[policy] Use the read tool for file contents, one call per file: read path=README.md.";

const suite: EvaluationSuite = {
	schemaVersion: 1,
	id: "policy-enforce",
	title: "Policy enforcement blocks a built-in shell class",
	subject: {
		adapter: "pi-sdk",
		kind: "extension",
		description:
			"Exercise the policy extension at the bash tool boundary and compare enforce mode with its observe baseline.",
		config: {
			invocation: "explicit-policy-extension",
			baselinePlaceholder: "The observe baseline loads the same extension and tool without a policy-mode flag.",
		},
		variants: [
			{
				id: "enforce",
				description: "Load policy with the policy-mode extension flag set to enforce.",
				config: {
					extensions: [{ path: "../extensions/policy/index.ts" }],
					tools: ["bash"],
					extensionFlags: { "policy-mode": "enforce" },
				},
			},
			{
				id: "observe-baseline",
				description: "Load the same policy extension and bash tool with the default observe mode.",
				config: {
					extensions: [{ path: "../extensions/policy/index.ts" }],
					tools: ["bash"],
				},
			},
		],
	},
	cases: [
		{
			id: "cat-read-block",
			title: "A cat file read is rejected with routing guidance",
			input: {
				seed: [],
				prompt: `Call the bash tool exactly once with the command ${JSON.stringify(COMMAND)}. Do not substitute another command or tool. After its result, stop without making another tool call.`,
				fixture: {
					command: COMMAND,
					fileName: FILE_NAME,
					builtinClass: "routing.cat-read",
					blockReason: BLOCK_REASON,
				},
			},
			checks: [
				{
					id: "blocked-command-attempted",
					type: "tool-call",
					config: { name: "bash", argumentsContain: [`"command":"${COMMAND}"`] },
				},
				{
					id: "policy-block-returned",
					type: "tool-result",
					config: { name: "bash", isError: true, contentContains: [BLOCK_REASON] },
				},
			],
			reviewMetadata: {
				builtinClass: "routing.cat-read",
				blockReason: BLOCK_REASON,
				falsifiability:
					"Enforce can satisfy both checks; observe can satisfy the attempted-call check but cannot produce the policy block reason.",
			},
		},
	],
	limits: {
		wall: { runTimeoutMs: 900_000, executionTimeoutMs: 120_000 },
		execution: { maxTotal: 16, maxTurnsEach: 2, maxOutputTokensEach: 1_024 },
		cost: { currency: "USD", maxObserved: 4, enforcement: "observed-after-each-execution", hardCap: false },
	},
	authority: {
		requestedEffects: {
			providerNetwork: ["paid-model-inference", "credential-command-execution", "credential-refresh"],
			credentials: ["read-approved-model-credentials", "credential-resolution"],
			subject: [],
		},
	},
	adjudication: {
		policy: "deterministic-only",
		criteria: [],
		metadata: {
			blindedVariants: false,
			note: "The observe arm is an intentional negative control and must fail policy-block-returned.",
		},
	},
};

export default defineSuite(suite);
