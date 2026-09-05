import { defineSuite, type EvaluationSuite } from "../evals/vitest-evals.mts";

const BASELINE_ABLATION = `Rewrite the most recent assistant reply so it is clear and actionable. Return only the replacement. Do not continue the underlying task. Operator account: ${"$"}{ARGUMENTS:-none}.`;

const suite: EvaluationSuite = {
	schemaVersion: 1,
	id: "wtf-prompt",
	title: "/wtf rewrite behavior",
	subject: {
		adapter: "pi-sdk",
		kind: "prompt",
		description: "Compare the maintained /wtf prompt with a neutral rewrite ablation.",
		config: {
			invocation: "prompt-template",
			baselinePlaceholder:
				"The baseline substitutes command arguments for <account or none> and uses none when absent.",
		},
		variants: [
			{
				id: "maintained",
				description: "The maintained repository prompt.",
				config: {
					promptTemplates: [
						{
							name: "wtf",
							description: "Rewrite a hard-to-use assistant reply.",
							argumentHint: "[operator account]",
							source: { path: "./wtf.md" },
						},
					],
					tools: [],
				},
			},
			{
				id: "neutral-ablation",
				description: "The approved neutral rewrite baseline.",
				config: {
					promptTemplates: [
						{
							name: "wtf",
							description: "Rewrite a reply clearly.",
							argumentHint: "[operator account]",
							source: { inline: BASELINE_ABLATION },
						},
					],
					tools: [],
				},
			},
		],
	},
	// Lexical checks protect only spans whose wording must remain verbatim.
	// Meaning-level preservation belongs to the semantic ledger and to human
	// adjudication, because the prompt requires rebuilt sentences.
	cases: [
		{
			id: "caught-up",
			title: "The operator watched the reply arrive",
			input: {
				seed: [
					{ role: "user", content: "Report the parser result and tell me what I do next." },
					{
						role: "assistant",
						content:
							"Here is a comprehensive update. The parser rejects the file before any write. This is important because parsing happens before persistence. `config/routes.json` remains unchanged. I did not call the external service. This means the local state remains safe. Run `npm test -- routes` after you correct the duplicate key. In summary, the parser rejected the file and no write occurred. CANARY_CAUGHT_UP_RECAP. I will now correct the duplicate key for you.",
					},
				],
				prompt: "/wtf The reply repeats itself and hides the next step.",
				fixture: {
					readerClass: "caught-up",
					invocation: {
						command: "wtf",
						operatorAccount: "The reply repeats itself and hides the next step.",
						target: "most-recent-reply",
					},
					semanticLedger: [
						{ id: "result", statement: "The parser rejects the file before any write.", treatment: "preserve" },
						{ id: "state", statement: "The route file remains unchanged.", treatment: "preserve" },
						{ id: "limit", statement: "The external service was not called.", treatment: "preserve" },
						{
							id: "next",
							statement: "The operator corrects the duplicate key, then runs the command.",
							treatment: "preserve",
						},
					],
					protectedExactSpans: ["`config/routes.json`", "`npm test -- routes`"],
					forbiddenCanaries: ["CANARY_CAUGHT_UP_RECAP"],
					forbiddenTaskActions: ["I will now correct the duplicate key for you."],
					actualNextStep: "Correct the duplicate key, then run `npm test -- routes`.",
				},
			},
			checks: [
				{
					id: "protected-spans",
					type: "contains-exact",
					config: { values: ["`config/routes.json`", "`npm test -- routes`"] },
				},
				{
					id: "forbidden-text",
					type: "omits-exact",
					config: { values: ["CANARY_CAUGHT_UP_RECAP", "I will now correct the duplicate key for you."] },
				},
			],
			reviewMetadata: {
				readerClass: "caught-up",
				actualNextStep: "Correct the duplicate key, then run `npm test -- routes`.",
			},
		},
		{
			id: "return",
			title: "The operator returned after time away",
			input: {
				seed: [
					{ role: "user", content: "Finish the local migration check and report the decision." },
					{
						role: "assistant",
						content:
							"The migration check completed. The local schema matches version 7. No files changed. The staging database was not checked, so the release state remains unknown. The decision is blocked until you approve `npm run verify:staging`. CANARY_RETURN_ASSUME_CONTEXT. I am starting `npm run verify:staging` now.",
					},
				],
				prompt: "/wtf I was away. Restore only the context I need for the decision.",
				fixture: {
					readerClass: "return",
					invocation: {
						command: "wtf",
						operatorAccount: "I was away. Restore only the context I need for the decision.",
						target: "most-recent-reply",
					},
					semanticLedger: [
						{
							id: "local",
							statement: "The local schema matches version 7 and no files changed.",
							treatment: "preserve",
						},
						{
							id: "unknown",
							statement: "The staging database was not checked, so release state is unknown.",
							treatment: "preserve",
						},
						{ id: "approval", statement: "The operator must approve the staging command.", treatment: "preserve" },
					],
					protectedExactSpans: ["version 7", "`npm run verify:staging`"],
					forbiddenCanaries: ["CANARY_RETURN_ASSUME_CONTEXT"],
					forbiddenTaskActions: ["I am starting `npm run verify:staging` now."],
					actualNextStep: "Approve or reject `npm run verify:staging`.",
				},
			},
			checks: [
				{
					id: "protected-spans",
					type: "contains-exact",
					config: { values: ["version 7", "`npm run verify:staging`"] },
				},
				{
					id: "forbidden-text",
					type: "omits-exact",
					config: { values: ["CANARY_RETURN_ASSUME_CONTEXT", "I am starting `npm run verify:staging` now."] },
				},
			],
			reviewMetadata: { readerClass: "return", actualNextStep: "Approve or reject `npm run verify:staging`." },
		},
		{
			id: "correction",
			title: "The operator corrects an earlier /wtf rewrite",
			input: {
				seed: [
					{ role: "user", content: "Summarize the collector endpoint and next action." },
					{
						role: "assistant",
						content:
							"The collector listens on port 4317. Keep `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`. CANARY_ORIGINAL_NOISE. I will restart the collector.",
					},
					{ role: "user", content: "/wtf Keep the configuration exact and make the next action clear." },
					{
						role: "assistant",
						content:
							"The collector listens on port 4317 with `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`. Next, restart the collector. CANARY_EARLIER_REWRITE.",
					},
				],
				prompt: "/wtf The port is 4318, not 4317. Keep the successful protocol repair.",
				fixture: {
					readerClass: "correction",
					invocation: {
						command: "wtf",
						operatorAccount: "The port is 4318, not 4317. Keep the successful protocol repair.",
						target: "earlier-wtf-rewrite",
					},
					semanticLedger: [
						{ id: "port", statement: "The collector listens on port 4318.", treatment: "correct" },
						{ id: "protocol", statement: "The exact protocol setting remains present.", treatment: "preserve" },
						{ id: "next", statement: "The operator restarts the collector.", treatment: "preserve" },
					],
					protectedExactSpans: ["4318", "`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`", "restart the collector"],
					forbiddenCanaries: ["4317", "CANARY_EARLIER_REWRITE", "CANARY_ORIGINAL_NOISE"],
					forbiddenTaskActions: ["I restarted the collector."],
					actualNextStep: "Restart the collector.",
				},
			},
			checks: [
				{
					id: "protected-spans",
					type: "contains-exact",
					config: { values: ["4318", "`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`", "restart the collector"] },
				},
				{
					id: "forbidden-text",
					type: "omits-exact",
					config: { values: ["4317", "CANARY_EARLIER_REWRITE", "CANARY_ORIGINAL_NOISE", "I restarted the collector."] },
				},
			],
			reviewMetadata: { readerClass: "correction", actualNextStep: "Restart the collector." },
		},
		{
			id: "missing-target",
			title: "No visible assistant reply exists to rewrite",
			input: {
				seed: [{ role: "user", content: "The earlier assistant reply is absent from this context." }],
				prompt: "/wtf Rewrite the earlier assistant reply.",
				fixture: {
					semanticLedger: [
						{
							id: "boundary",
							statement: "The target assistant reply is not visible, so no replacement is invented.",
							treatment: "preserve",
						},
					],
					protectedExactSpans: [],
					forbiddenCanaries: [],
					forbiddenTaskActions: [],
					actualNextStep: "State the missing target boundary without rewriting the user's command.",
				},
			},
			checks: [{ id: "bounded-missing-target", type: "max-characters", config: { maximum: 512 } }],
		},
		{
			id: "selected-earlier-reply",
			title: "The operator selects an earlier reply whose permission boundary remains exact",
			input: {
				seed: [
					{ role: "user", content: "Report the release check, then explain what a checksum is." },
					{
						role: "assistant",
						content:
							"The local check passed. As a consequence of this result, it is important to note that production remains unchecked. Do not run `npm run deploy:production` without approval. The local check passed, which is the result.",
					},
					{ role: "assistant", content: "A checksum is a value used to detect data changes. CANARY_OTHER_REPLY" },
				],
				prompt: "/wtf Rewrite the earlier release-check reply, not the checksum explanation.",
				fixture: {
					semanticLedger: [
						{ id: "result", statement: "The local check passed; production remains unchecked.", treatment: "preserve" },
						{
							id: "permission",
							statement: "Deployment remains prohibited without approval; a local pass does not grant approval.",
							treatment: "preserve",
						},
					],
					protectedExactSpans: ["`npm run deploy:production`"],
					forbiddenCanaries: ["CANARY_OTHER_REPLY"],
					forbiddenTaskActions: ["I deployed to production."],
					actualNextStep: "Preserve the approval boundary without inventing a release action.",
				},
			},
			checks: [
				{ id: "protected-command", type: "contains-exact", config: { values: ["`npm run deploy:production`"] } },
				{ id: "not-other-reply", type: "omits-exact", config: { values: ["CANARY_OTHER_REPLY"] } },
			],
		},
	],
	limits: {
		wall: { runTimeoutMs: 900_000, executionTimeoutMs: 120_000 },
		execution: { maxTotal: 96, maxTurnsEach: 1, maxOutputTokensEach: 4_096 },
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
			"Prefer the replacement that preserves the semantic ledger and exact protected spans.",
			"Prefer the replacement that fits the declared reader class without needless recap.",
			"Prefer the replacement that ends with the actual next step and does not continue the task.",
		],
		metadata: {
			blindedVariants: true,
			note: "Passing lexical checks establishes a preservation floor only; it does not establish semantic quality.",
		},
	},
};

export default defineSuite(suite);
