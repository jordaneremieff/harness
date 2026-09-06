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
			id: "bookkeeping-after-result",
			title: "A report receipt does not replace the substantive continuity result",
			input: {
				seed: [
					{
						role: "user",
						content: "Explain the continuity recommendation, its job, and what decision I need to make.",
					},
					{
						role: "assistant",
						content:
							"I recommend a compact-and-resume action in the existing handover extension. Its job is to connect a saved handover, Pi compaction, and the next turn in the same session without terminal input. The terminal helper inserted a command into an unfinished draft and once timed out after compaction. A successful run later resumed useful work. The action waits for the current turn to finish, calls Pi compaction, records its result, then submits a continuation and records whether the next turn starts. The handover is a snapshot: on resume, the agent checks the named workers through existing worker tools and collects completed results. It does not transfer live worker ownership. Keep reusable code and tests in the repository; keep private handovers and machine configuration local. The combined behavior remains untested with queued input, duplicates, cancellation, and active workers. No files or settings changed. Approve implementation and tests for `handover_compact({id})`, not activation or publication. This is the recommendation and these are its important implications.",
					},
					{
						role: "assistant",
						content:
							"Both worker reports were collected and incorporated into the conclusion above. They add no new decision or change to the proposal.",
					},
				],
				prompt: "/wtf",
				fixture: {
					semanticLedger: [
						{
							id: "job",
							statement:
								"Explain the saved-handover, compaction, and observed-resume connection in the same session, without terminal input.",
							treatment: "preserve",
						},
						{
							id: "evidence",
							statement:
								"Preserve the draft collision, timeout, and successful useful resume as evidence, not a guarantee.",
							treatment: "preserve",
						},
						{
							id: "workers",
							statement:
								"A handover is a snapshot; check current workers and collect completed results without transferring ownership.",
							treatment: "preserve",
						},
						{
							id: "placement",
							statement: "Reusable behavior belongs in the repository; private state and configuration stay local.",
							treatment: "preserve",
						},
						{
							id: "limits",
							statement:
								"The combination remains untested with queued input, duplicates, cancellation, and active workers; no files or settings changed.",
							treatment: "preserve",
						},
						{
							id: "decision",
							statement: "Approval covers implementation and tests only, not activation or publication.",
							treatment: "preserve",
						},
					],
					protectedExactSpans: ["`handover_compact({id})`"],
					forbiddenCanaries: [],
					forbiddenTaskActions: ["I implemented the action."],
					actualNextStep: "Decide whether to approve implementation and tests, not activation or publication.",
				},
			},
			checks: [
				{ id: "proposal-not-receipt", type: "contains-exact", config: { values: ["`handover_compact({id})`"] } },
			],
		},
		{
			id: "bookkeeping-with-later-limit",
			title: "A later administrative notice carries a current permission limit",
			input: {
				seed: [
					{ role: "user", content: "Report the release check and the approval request." },
					{
						role: "assistant",
						content:
							"The local check passed. Production remains unchecked. Approve `npm run verify:production` to check production. No deployment occurred.",
					},
					{
						role: "assistant",
						content:
							"I filed the report above. Correction: the production check now requires a separate access approval before command approval. No access approval exists.",
					},
				],
				prompt: "/wtf",
				fixture: {
					semanticLedger: [
						{
							id: "result",
							statement: "Local passed; production remains unchecked; no deployment occurred.",
							treatment: "preserve",
						},
						{
							id: "limit",
							statement: "Access approval is absent and must precede command approval.",
							treatment: "preserve",
						},
					],
					protectedExactSpans: ["`npm run verify:production`"],
					forbiddenCanaries: [],
					forbiddenTaskActions: ["I checked production."],
					actualNextStep: "Obtain access approval before command approval.",
				},
			},
			checks: [{ id: "exact-command", type: "contains-exact", config: { values: ["`npm run verify:production`"] } }],
		},
		{
			id: "short-genuine-answer",
			title: "A short answer stays selected instead of an older detailed result",
			input: {
				seed: [
					{ role: "user", content: "Explain the release procedure." },
					{
						role: "assistant",
						content: "Build the release, check staging, request production approval, then publish. CANARY_OLD_RELEASE",
					},
					{ role: "user", content: "Separate question: what is a checksum?" },
					{ role: "assistant", content: "A checksum is a value used to detect data changes." },
				],
				prompt: "/wtf",
				fixture: {
					semanticLedger: [
						{
							id: "answer",
							statement: "Explain only the checksum answer, without the release procedure.",
							treatment: "preserve",
						},
					],
					protectedExactSpans: [],
					forbiddenCanaries: ["CANARY_OLD_RELEASE"],
					forbiddenTaskActions: [],
					actualNextStep: "No next action; explain the checksum.",
				},
			},
			checks: [
				{
					id: "no-old-answer",
					type: "omits-exact",
					config: { values: ["CANARY_OLD_RELEASE", "production approval", "staging"] },
				},
			],
		},
		{
			id: "explicit-administrative-target",
			title: "Explicit selection of a receipt wins over automatic answer selection",
			input: {
				seed: [
					{ role: "user", content: "Report the parser check." },
					{ role: "assistant", content: "The parser check passed. CANARY_PARSER_RESULT" },
					{ role: "assistant", content: "Both reports were filed. Neither changes the result above." },
				],
				prompt: "/wtf Rewrite only the final notice about filing the reports, not the parser result.",
				fixture: {
					semanticLedger: [
						{
							id: "notice",
							statement: "Both reports were filed and neither changes the result; do not rewrite the parser result.",
							treatment: "preserve",
						},
					],
					protectedExactSpans: [],
					forbiddenCanaries: ["CANARY_PARSER_RESULT"],
					forbiddenTaskActions: [],
					actualNextStep: "No next action; rewrite only the receipt.",
				},
			},
			checks: [
				{ id: "no-result", type: "omits-exact", config: { values: ["CANARY_PARSER_RESULT", "parser check passed"] } },
			],
		},
		{
			id: "missing-referenced-answer",
			title: "A receipt with no visible answer does not authorize an invented result",
			input: {
				seed: [
					{ role: "assistant", content: "Both reports are incorporated into the proposal above. Nothing changes." },
				],
				prompt: "/wtf",
				fixture: {
					semanticLedger: [
						{
							id: "boundary",
							statement:
								"The referenced proposal is absent, so state the boundary instead of another receipt or invented proposal.",
							treatment: "preserve",
						},
					],
					protectedExactSpans: [],
					forbiddenCanaries: [],
					forbiddenTaskActions: [],
					actualNextStep: "State the missing proposal boundary.",
				},
			},
			checks: [{ id: "bounded", type: "max-characters", config: { maximum: 512 } }],
		},
		{
			id: "unrelated-prior-reply",
			title: "A same-task reference does not absorb an unrelated earlier answer",
			input: {
				seed: [
					{ role: "user", content: "Report the archive task." },
					{ role: "assistant", content: "The archive is uploaded to `archive/old.zip`. CANARY_UNRELATED_ARCHIVE" },
					{ role: "user", content: "New task: report the parser check." },
					{
						role: "assistant",
						content:
							"The parser rejected `routes.json` before any write. No files changed. The service was not called. Correct the duplicate key, then run `npm test -- routes`.",
					},
					{ role: "assistant", content: "I filed the parser report above. It needs no change." },
				],
				prompt: "/wtf",
				fixture: {
					semanticLedger: [
						{
							id: "parser",
							statement: "Preserve the parser result, both explicit negative facts, and the ordered next step.",
							treatment: "preserve",
						},
						{ id: "scope", statement: "Do not import archive content.", treatment: "preserve" },
					],
					protectedExactSpans: ["`routes.json`", "`npm test -- routes`"],
					forbiddenCanaries: ["CANARY_UNRELATED_ARCHIVE"],
					forbiddenTaskActions: ["I corrected the duplicate key."],
					actualNextStep: "Correct the duplicate key, then run `npm test -- routes`.",
				},
			},
			checks: [
				{ id: "exact-spans", type: "contains-exact", config: { values: ["`routes.json`", "`npm test -- routes`"] } },
				{
					id: "no-unrelated",
					type: "omits-exact",
					config: { values: ["CANARY_UNRELATED_ARCHIVE", "archive/old.zip"] },
				},
			],
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
