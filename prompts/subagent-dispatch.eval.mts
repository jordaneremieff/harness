import { defineSuite, type EvaluationSuite } from "../evals/vitest-evals.mts";

const suite: EvaluationSuite = {
	schemaVersion: 1,
	id: "subagent-dispatch",
	title: "subagent dispatch behavior",
	subject: {
		adapter: "pi-sdk",
		kind: "extension",
		description:
			"Compare a session that loads the subagent extension with a session that does not, so dispatch behavior is measured against a control that cannot dispatch.",
		config: {
			invocation: "tool-call",
		},
		variants: [
			{
				id: "maintained",
				description: "Load the subagent extension so the model dispatches background workers through its tool.",
				config: {
					extensions: [{ path: "../extensions/subagent/index.ts" }],
					tools: ["bash"],
				},
			},
			{
				id: "no-extension",
				description: "Load no subagent extension as the negative control that cannot dispatch.",
				config: {
					extensions: [],
					tools: ["bash"],
				},
			},
		],
	},
	// The no-extension variant is the negative control and must fail the dispatch checks.
	// A passing lexical check proves the dispatch shape only, not the quality of the task text.
	cases: [
		{
			id: "single-dispatch",
			title: "One independent check goes to one worker",
			input: {
				seed: [
					{
						role: "user",
						content: "I need a small verification job done while I stay focused on something else.",
					},
					{
						role: "assistant",
						content: "Understood. Tell me what to verify and I will delegate it.",
					},
				],
				prompt:
					"Delegate exactly one bounded task to a subagent with the subagent tool. The worker task must say: run the command date -u +%Y, then submit that year and nothing else. Dispatch the task and then stop. Do not wait for the result. Do not run sleep or any polling command.",
				fixture: {
					toolName: "subagent",
					batchField: "task",
					workerCommand: "date -u +%Y",
					startMarker: "bg-",
					forbiddenTool: "bash",
				},
			},
			checks: [
				{
					id: "dispatch-called",
					type: "tool-call",
					config: { name: "subagent", argumentsContain: ['"task"'] },
				},
				{
					id: "worker-started",
					type: "tool-result",
					config: { name: "subagent", isError: false, contentContains: ["bg-"] },
				},
				{
					id: "no-sleep-poll",
					type: "tool-call",
					config: { name: "bash", present: false },
				},
			],
			reviewMetadata: {
				toolName: "subagent",
				batchField: "task",
				startMarker: "bg-",
				falsifiability:
					"The maintained variant can satisfy all three checks; the no-extension variant cannot call the tool and must fail dispatch-called and worker-started.",
			},
		},
		{
			id: "batch-dispatch",
			title: "Two independent checks go to one batch",
			input: {
				seed: [
					{
						role: "user",
						content: "Two unrelated facts need checking, and each check stands on its own.",
					},
					{
						role: "assistant",
						content: "I will send both checks out together.",
					},
				],
				prompt:
					"Delegate both checks at once in a single subagent call. Put both checks in one batch as separate tasks, one worker per check, each with its own complete task text. Stop after dispatching.",
				fixture: {
					toolName: "subagent",
					batchField: "tasks",
					workerCount: 2,
					startMarker: "bg-",
				},
			},
			checks: [
				{
					id: "batch-form",
					type: "tool-call",
					config: { name: "subagent", argumentsContain: ['"tasks"'] },
				},
				{
					id: "workers-started",
					type: "tool-result",
					config: { name: "subagent", isError: false, contentContains: ["bg-"] },
				},
			],
			reviewMetadata: {
				toolName: "subagent",
				batchField: "tasks",
				workerCount: 2,
				startMarker: "bg-",
				falsifiability:
					"The maintained variant can satisfy both checks; the no-extension variant cannot call the tool and must fail batch-form and workers-started.",
			},
		},
	],
	limits: {
		wall: { runTimeoutMs: 900_000, executionTimeoutMs: 120_000 },
		execution: { maxTotal: 32, maxTurnsEach: 2, maxOutputTokensEach: 2_048 },
		cost: { currency: "USD", maxObserved: 5, enforcement: "observed-after-each-execution", hardCap: false },
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
			"Prefer the response that delegates instead of doing the work itself.",
			"Prefer the response that gives the worker a complete, self-contained task.",
			"Prefer the response that stops after dispatch rather than waiting.",
		],
		metadata: {
			blindedVariants: true,
			note: "The no-extension variant cannot call the tool and must fail the dispatch checks.",
		},
	},
};

export default defineSuite(suite);
