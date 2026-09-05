import { defineSuite, type EvaluationSuite } from "../evals/vitest-evals.mts";

const suite = {
	schemaVersion: 1,
	id: "drift-prompt",
	title: "/drift opening-intent reconstruction",
	subject: {
		adapter: "pi-sdk",
		kind: "prompt",
		description: "Reconstruct opening intent without replacing it with later activity or invented context.",
		config: { invocation: "prompt-template" },
		variants: [
			{
				id: "maintained",
				description: "The maintained repository prompt.",
				config: {
					promptTemplates: [{ name: "drift", source: { path: "./drift.md" } }],
					tools: [],
				},
			},
		],
	},
	cases: [
		{
			id: "later-implementation",
			title: "Later implementation does not replace an opening question",
			input: {
				seed: [
					{ role: "user", content: "Why does the parser reject duplicate keys? Explain the reason; do not edit it." },
					{ role: "assistant", content: "I will rewrite the parser and add a migration. CANARY_LATER_PLAN" },
				],
				prompt: "/drift",
				fixture: {
					semanticLedger: [
						"The opening intent is a question about why the parser rejects duplicate keys, not an implementation request.",
						"The operator requested an explanation and prohibited edits.",
					],
				},
			},
			checks: [{ id: "no-plan-canary", type: "omits-exact", config: { values: ["CANARY_LATER_PLAN"] } }],
		},
		{
			id: "operator-clarification",
			title: "An operator clarification supplies the meaning of the opening request",
			input: {
				seed: [
					{ role: "user", content: "Compare the two cache designs." },
					{ role: "assistant", content: "I will rank them by speed and deploy the faster one." },
					{
						role: "user",
						content: "By compare I meant eviction correctness under concurrent writes, not speed. Do not deploy.",
					},
				],
				prompt: "/drift",
				fixture: {
					semanticLedger: [
						"The operator wants a comparison of eviction correctness under concurrent writes.",
						"The clarification explains the opening comparison; speed and deployment are not the intended work.",
					],
				},
			},
			checks: [{ id: "bounded-reconstruction", type: "max-characters", config: { maximum: 2_000 } }],
		},
		{
			id: "changed-goal",
			title: "An explicit new goal does not erase the original question",
			input: {
				seed: [
					{ role: "user", content: "Explain why the deployment failed; do not change files." },
					{ role: "assistant", content: "The configuration has a duplicate key." },
					{ role: "user", content: "New goal: fix the duplicate key now." },
				],
				prompt: "/drift",
				fixture: {
					semanticLedger: [
						"The original intent is to explain the deployment failure without changing files.",
						"The later authorized repair is a changed goal, not evidence that repair was the opening intent.",
					],
				},
			},
			checks: [{ id: "bounded-reconstruction", type: "max-characters", config: { maximum: 2_000 } }],
		},
		{
			id: "missing-opening",
			title: "Visible later work does not establish an absent opening intent",
			input: {
				seed: [
					{ role: "user", content: "The opening request is absent from this context. Here is only the later status." },
					{ role: "assistant", content: "The retry tests passed. I am now choosing a queue library." },
				],
				prompt: "/drift",
				fixture: {
					semanticLedger: [
						"The first sentence states that the original intent is not visible.",
						"The second identifies the later test and queue status as insufficient evidence of the opening request.",
					],
				},
			},
			checks: [{ id: "bounded-reconstruction", type: "max-characters", config: { maximum: 2_000 } }],
		},
	],
	limits: {
		wall: { runTimeoutMs: 900_000, executionTimeoutMs: 120_000 },
		execution: { maxTotal: 48, maxTurnsEach: 1, maxOutputTokensEach: 1_024 },
		cost: { currency: "USD", maxObserved: 6, enforcement: "observed-after-each-execution", hardCap: false },
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
			"Return exactly two sentences and preserve the kind of the opening intent without answering or advancing it.",
			"Use an explicit operator clarification without treating a changed goal or assistant activity as opening intent.",
			"State an absent opening context instead of inventing intent from later work.",
		],
		metadata: { note: "Discovery and lexical checks do not establish reconstruction quality or a no-tool choice." },
	},
} satisfies EvaluationSuite;

export default defineSuite(suite);
