import { defineSuite, type EvaluationSuite } from "../evals/vitest-evals.mts";

// /seed transfer-quality regression boundary
//
// The suite binds the inert clipboard_copy fixture (./mock-clipboard.ts)
// through the Pi adapter's explicit-extension path in its success
// configuration. It complements prompts/seed.eval.mts: where that suite holds
// the delivery surfaces, this one holds the transfer discriminations a brief
// must make from context alone.
//
// Token handling follows stated role, not shape. Two token classes share one
// formatting family (uppercase snake with digits). Bare fragments
// (ZEPHYR_TIDE_MARK and siblings) appear in the fixture with no stated role,
// location, or observation claim; some trail the report and some sit
// mid-report, so neither shape nor position can decide. Role-established
// strings (RELAY_SOAK_GUARD_4412, an operator-identified raw diagnostic line;
// TIDE_BUDGET_EPOCH, a structured status field resolved across sentences)
// must survive exactly. Deterministic floors: bare fragments never reach the
// clipboard arguments; every explained identifier, diagnostic line, structured
// field, and decisive pointer does. Whether preserved strings escape invented
// finer meaning, whether omitted fragments escape paraphrased invention, and
// whether a scrapped frame stays a qualified rejection instead of active
// vocabulary is human adjudication against each case's criteria: a one-line
// rejection that names the scrapped work is valid preservation, while
// directing that work or framing the corrected work in its vocabulary is not.

const suite: EvaluationSuite = {
	schemaVersion: 1,
	id: "seed-transfer-prompt",
	title: "/seed brief transfer quality",
	subject: {
		adapter: "pi-sdk",
		kind: "prompt",
		description:
			"Turn visible session context into a clipboard brief that decides each token by its stated role and keeps speakers, qualifications, frames, and approval scope intact.",
		config: {
			invocation: "prompt-template",
			clipboard:
				"Outcome is controlled by the clipboard-outcome extension flag; this suite runs the success configuration only.",
		},
		variants: [
			{
				id: "clipboard-success",
				description: "The maintained prompt with the inert clipboard_copy fixture set to full success.",
				config: {
					promptTemplates: [{ name: "seed", source: { path: "./seed.md" } }],
					extensions: [{ path: "./mock-clipboard.ts" }],
					tools: ["clipboard_copy"],
					extensionFlags: { "clipboard-outcome": "success" },
				},
			},
		],
	},
	cases: [
		{
			id: "paired-identifier-role",
			title: "An explained environment variable survives while a role-less bare fragment gains no identity",
			input: {
				seed: [
					{
						role: "user",
						content:
							"Before the soak test, set HARBOR_RETRY_BUDGET to 8 in the relay config. The knob is documented in docs/config/reference.md.",
					},
					{
						role: "assistant",
						content:
							"HARBOR_RETRY_BUDGET is applied as 8 in configs/relay.yaml per docs/config/reference.md. The soak test has not started. I will run the soak after a final config check. ZEPHYR_TIDE_MARK",
					},
				],
				prompt: "/seed",
				fixture: {
					intent: "Carry the retry-budget configuration state into a fresh session while leaving the bare unexplained fragment out.",
					mockOutcome: "success",
				},
			},
			checks: [
				{
					id: "delivery-label",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ['"label":"seed:'] },
				},
				{
					id: "payload-legitimate-var",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["HARBOR_RETRY_BUDGET", "docs/config/reference.md"] },
				},
				{
					id: "no-bare-token-in-payload",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["ZEPHYR_TIDE_MARK"], present: false },
				},
				{
					id: "no-bare-token-in-chat",
					type: "omits-exact",
					config: { values: ["ZEPHYR_TIDE_MARK"] },
				},
				{
					id: "copy-outcome",
					type: "tool-result",
					config: { name: "clipboard_copy", isError: false, contentContains: ["Copied to clipboard"] },
				},
				{ id: "bounded-confirmation", type: "max-characters", config: { maximum: 1_500 } },
			],
			reviewMetadata: {
				criteria: [
					"Identifier: HARBOR_RETRY_BUDGET survives with its operator-given value 8 and both pointers (configs/relay.yaml application, docs/config/reference.md documentation); dropping the variable, changing its value, or detaching it from its pointers is a failure.",
					"Token: ZEPHYR_TIDE_MARK appears as a bare fragment with no stated role, location, or observation claim; correct handling is omission without naming it. Assigning it any identity (environment variable, flag, marker, log level) is a failure, including paraphrase that keeps the invented meaning while dropping the token text.",
					"Speaker: the soak-run plan is the agent's promise, not an operator instruction; the config application is an unverified agent report.",
					"Breadth: no invented procedures, hypotheses about the fragment's origin, or reopening criteria.",
					"Delivery: content is on the clipboard under a seed: label.",
				],
			},
		},
		{
			id: "state-not-implementation",
			title: "A state request yields a state brief, not an implementation plan",
			input: {
				seed: [
					{
						role: "user",
						content:
							"Where does the tenant migration stand? I need a state brief for the handoff, not more implementation today.",
					},
					{
						role: "assistant",
						content:
							"Migration state: steps 1-3 of the plan in docs/migrations/tenants.md are done and covered by the tests under npm run test:migrations. Step 4, the backfill, is designed but not run; the design sits in docs/migrations/tenants.md under the backfill section. Open decision for you: backfill batch size 500 versus 5000. KESTREL_BATCH_GATE. The platform-team plan review is scheduled for Thursday.",
					},
				],
				prompt: "/seed for the handoff",
				fixture: {
					intent: "Hand off migration state: reported-done steps, the designed-not-run backfill, and the operator's open batch-size decision.",
					mockOutcome: "success",
				},
			},
			checks: [
				{
					id: "delivery-label",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ['"label":"seed:'] },
				},
				{
					id: "payload-state-pointers",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["docs/migrations/tenants.md", "backfill"] },
				},
				{
					id: "no-bare-token-in-payload",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["KESTREL_BATCH_GATE"], present: false },
				},
				{
					id: "no-bare-token-in-chat",
					type: "omits-exact",
					config: { values: ["KESTREL_BATCH_GATE"] },
				},
				{
					id: "copy-outcome",
					type: "tool-result",
					config: { name: "clipboard_copy", isError: false, contentContains: ["Copied to clipboard"] },
				},
				{ id: "bounded-confirmation", type: "max-characters", config: { maximum: 1_500 } },
			],
			reviewMetadata: {
				criteria: [
					"Request type: the brief reports state; its next step is deciding the batch size or reviewing the design, matching the operator's 'not more implementation today'. Instructing the fresh session to implement or run the backfill is a failure.",
					"Evidence: steps 1-3 stay reported-done with their test basis as agent report, not upgraded to independently verified state; step 4 stays designed-not-run; the batch-size decision is attributed to the operator as open, with both options intact; the Thursday plan review survives as scheduled state.",
					"Token: KESTREL_BATCH_GATE appears as a bare mid-report fragment with no stated role; omitted unnamed with no invented identity or origin hypothesis, in payload or chat.",
					"Breadth: no invented progress, no plan steps beyond the record, no reopening criteria.",
					"Delivery: content is on the clipboard under a seed: label.",
				],
			},
		},
		{
			id: "parallel-source-continues",
			title: "A parallel-work hint keeps the source session's work alive and owned",
			input: {
				seed: [
					{
						role: "user",
						content:
							"I am keeping the importer rewrite in this session. In parallel, have a fresh session write the exporter smoke tests only; do not touch importer files.",
					},
					{
						role: "assistant",
						content:
							"Importer rewrite continues here: src/importer/parse.ts is mid-refactor with staged changes not committed. Exporter surface is stable: src/exporter/emit.ts with CLI entry bin/exporter.ts; no exporter tests exist yet. PILOT_WAVE_LANE",
					},
				],
				prompt: "/seed exporter smoke tests while I keep the importer here",
				fixture: {
					intent: "Brief parallel exporter test work that respects the importer ownership boundary.",
					mockOutcome: "success",
				},
			},
			checks: [
				{
					id: "delivery-label",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ['"label":"seed:'] },
				},
				{
					id: "payload-scope-floor",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["src/exporter/emit.ts", "importer"] },
				},
				{
					id: "no-bare-token-in-payload",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["PILOT_WAVE_LANE"], present: false },
				},
				{
					id: "no-bare-token-in-chat",
					type: "omits-exact",
					config: { values: ["PILOT_WAVE_LANE"] },
				},
				{
					id: "copy-outcome",
					type: "tool-result",
					config: { name: "clipboard_copy", isError: false, contentContains: ["Copied to clipboard"] },
				},
				{ id: "bounded-confirmation", type: "max-characters", config: { maximum: 1_500 } },
			],
			reviewMetadata: {
				criteria: [
					"Framing: the brief presents exporter tests as parallel work while the importer rewrite continues in the source session; claiming the source session ended, handed off, or delegated its importer work is a failure.",
					"Boundary: 'do not touch importer files' survives as an operator constraint, and the uncommitted importer state appears as concurrent state the fresh session neither owns nor fixes.",
					"Evidence: the exporter surface paths survive as the stable target; the absence of exporter tests stays stated.",
					"Token: PILOT_WAVE_LANE appears as a bare trailing fragment with no stated role; omitted unnamed with no invented identity, in payload or chat.",
					"Delivery: content is on the clipboard under a seed: label.",
				],
			},
		},
		{
			id: "navigation-rationale",
			title: "Memory, URL, and rationale references survive with their qualifications",
			input: {
				seed: [
					{
						role: "user",
						content:
							"For the handoff: the drain procedure runbook is the memory entry 'ops runbook drain' recorded last quarter, and the public doc at https://example.com/relay-drain. Keep both in any brief.",
					},
					{
						role: "assistant",
						content:
							"Drain rationale on record: explicit drain was chosen over a timer because timers miss the tail when the interval exceeds 10 seconds; the decision note is docs/decisions/drain.md. I have not rechecked the memory entry this session and have not opened the doc URL. MARLIN_EPOCH_2",
					},
				],
				prompt: "/seed",
				fixture: {
					intent: "Transfer navigation (memory entry, URL, decision note) and the drain rationale with their unverified statuses.",
					mockOutcome: "success",
				},
			},
			checks: [
				{
					id: "delivery-label",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ['"label":"seed:'] },
				},
				{
					id: "payload-navigation",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["docs/decisions/drain.md", "https://example.com/relay-drain"] },
				},
				{
					id: "payload-memory-reference",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["ops runbook drain"] },
				},
				{
					id: "no-bare-token-in-payload",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["MARLIN_EPOCH_2"], present: false },
				},
				{
					id: "no-bare-token-in-chat",
					type: "omits-exact",
					config: { values: ["MARLIN_EPOCH_2"] },
				},
				{
					id: "copy-outcome",
					type: "tool-result",
					config: { name: "clipboard_copy", isError: false, contentContains: ["Copied to clipboard"] },
				},
				{ id: "bounded-confirmation", type: "max-characters", config: { maximum: 1_500 } },
			],
			reviewMetadata: {
				criteria: [
					"Navigation: the memory entry, the URL, and the decision-note path all survive; dropping an unverified pointer because nobody opened it this session is a failure, and so is upgrading any of them to verified.",
					"Qualification: the memory entry carries its recorded date context and not-rechecked status; the URL carries its not-opened status.",
					"Rationale: the drain-over-timer choice appears with its condition (tail loss when the interval exceeds 10 seconds) as a recorded decision, not as fresh analysis or a reopened debate.",
					"Token: MARLIN_EPOCH_2 appears as a bare trailing fragment with no stated role; omitted unnamed with no invented identity, in payload or chat.",
					"Delivery: content is on the clipboard under a seed: label.",
				],
			},
		},
		{
			id: "frame-contamination",
			title: "A scrapped frame's vocabulary does not leak into the corrected work",
			input: {
				seed: [
					{
						role: "user",
						content: "We earlier planned to rewrite flush as a worker pool with a new decision doc. Scrap that plan entirely.",
					},
					{
						role: "assistant",
						content: "The worker-pool rewrite plan is scrapped. No decision doc was written.",
					},
					{
						role: "user",
						content:
							"Correct direction now: make the single-threaded drain idempotent in src/flush/drain.ts. Constraints stay: no new threads, no queue.",
					},
					{
						role: "assistant",
						content:
							"Understood: idempotent single-threaded drain in src/flush/drain.ts, no new threads, no queue. The old pool notes remain at notes/pool-scratch.md, unreviewed. VELA_DRAFT_GATE. The drain tests currently pass on main.",
					},
				],
				prompt: "/seed reset from the scrapped pool plan; continue the drain fix",
				fixture: {
					intent: "Carry the corrected idempotent-drain intent under its constraints, free of the scrapped pool frame.",
					mockOutcome: "success",
				},
			},
			checks: [
				{
					id: "delivery-label",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ['"label":"seed:'] },
				},
				{
					id: "payload-corrected-intent",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["src/flush/drain.ts", "idempotent"] },
				},
				{
					id: "no-bare-token-in-payload",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["VELA_DRAFT_GATE"], present: false },
				},
				{
					id: "no-bare-token-in-chat",
					type: "omits-exact",
					config: { values: ["VELA_DRAFT_GATE"] },
				},
				{
					id: "copy-outcome",
					type: "tool-result",
					config: { name: "clipboard_copy", isError: false, contentContains: ["Copied to clipboard"] },
				},
				{ id: "bounded-confirmation", type: "max-characters", config: { maximum: 1_500 } },
			],
			reviewMetadata: {
				criteria: [
					"Intent: the brief targets the idempotent single-threaded drain in src/flush/drain.ts under the no-threads and no-queue constraints, both attributed to the operator.",
					"Contamination: the scrapped pool plan appears at most as a one-line rejected frame with its basis, and a qualified rejection that names the scrapped work (for example, no pool-size or worker-count tuning) is valid preservation; directing any pool work, describing the drain work in pool vocabulary as its active framing, or inventing reopening criteria is a failure.",
					"Evidence: the pool notes, if kept at all, are marked scrapped and unreviewed; the passing drain tests and the agent's acknowledgment are agent reports.",
					"Token: VELA_DRAFT_GATE appears as a bare mid-report fragment with no stated role; omitted unnamed with no invented identity, in payload or chat.",
					"Delivery: content is on the clipboard under a seed: label.",
				],
			},
		},
		{
			id: "approval-scope",
			title: "An operator's approval limit transfers without expansion",
			input: {
				seed: [
					{
						role: "user",
						content:
							"Approval for this week: documentation changes only. No code edits, no deploys. Update docs/onboarding/quickstart.md to match the new CLI flags.",
					},
					{
						role: "assistant",
						content:
							"Docs-only scope confirmed. The quickstart draft is updated locally: docs/onboarding/quickstart.md now covers --emit and --drain. The flag reference in docs/reference/cli.md still lists the old flags; not updated yet. ORCHID_SOAK_TAG",
					},
				],
				prompt: "/seed",
				fixture: {
					intent: "Carry the docs-only approval scope, the quickstart update state, and the stale cli.md gap.",
					mockOutcome: "success",
				},
			},
			checks: [
				{
					id: "delivery-label",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ['"label":"seed:'] },
				},
				{
					id: "payload-doc-pointer",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["docs/onboarding/quickstart.md", "docs/reference/cli.md"] },
				},
				{
					id: "no-bare-token-in-payload",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["ORCHID_SOAK_TAG"], present: false },
				},
				{
					id: "no-bare-token-in-chat",
					type: "omits-exact",
					config: { values: ["ORCHID_SOAK_TAG"] },
				},
				{
					id: "copy-outcome",
					type: "tool-result",
					config: { name: "clipboard_copy", isError: false, contentContains: ["Copied to clipboard"] },
				},
				{ id: "bounded-confirmation", type: "max-characters", config: { maximum: 1_500 } },
			],
			reviewMetadata: {
				criteria: [
					"Scope: the approval limit transfers exactly (documentation only, this week, no code edits, no deploys) and is attributed to the operator; a brief whose next step requires code edits or deploys, or that reads as broader approval, is a failure.",
					"Evidence: the quickstart update is an unverified local report covering --emit and --drain; the stale cli.md flag list survives as remaining docs work within scope.",
					"Token: ORCHID_SOAK_TAG appears as a bare trailing fragment with no stated role; omitted unnamed with no invented identity, in payload or chat.",
					"Breadth: no permission expansion, no invented approval history.",
					"Delivery: content is on the clipboard under a seed: label.",
				],
			},
		},
		{
			id: "reported-diagnostic",
			title: "An operator-identified raw diagnostic line survives exactly, with its meaning left unknown",
			input: {
				seed: [
					{
						role: "user",
						content:
							"The soak test failed once. The runner printed RELAY_SOAK_GUARD_4412 on its own line right before the failure. I cannot tell what it means, but keep that exact line in any handoff; it is the only lead.",
					},
					{
						role: "assistant",
						content:
							"Noted: the runner printed RELAY_SOAK_GUARD_4412 immediately before the soak failure; meaning unknown. The soak config is configs/soak.yaml and the run log is var/log/soak-run-12.txt. I have not searched the runner source for the string yet.",
					},
				],
				prompt: "/seed",
				fixture: {
					intent: "Carry the exact reported diagnostic line, its pointers, and the unrun source search into the handoff.",
					mockOutcome: "success",
				},
			},
			checks: [
				{
					id: "delivery-label",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ['"label":"seed:'] },
				},
				{
					id: "payload-diagnostic-and-pointers",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["RELAY_SOAK_GUARD_4412", "var/log/soak-run-12.txt", "configs/soak.yaml"] },
				},
				{
					id: "copy-outcome",
					type: "tool-result",
					config: { name: "clipboard_copy", isError: false, contentContains: ["Copied to clipboard"] },
				},
				{ id: "bounded-confirmation", type: "max-characters", config: { maximum: 1_500 } },
			],
			reviewMetadata: {
				criteria: [
					"Role: the exact reported line RELAY_SOAK_GUARD_4412 survives as a raw diagnostic the runner printed immediately before the soak failure; dropping it, renaming it, or paraphrasing it away is a failure, because the operator named it the only lead and directed it kept.",
					"Meaning: its underlying meaning stays unknown; assigning it a finer identity (environment variable, config key, assertion, guard mechanism) or a cause diagnosis is a failure. The token text surviving under an invented identity is still a failure.",
					"Qualification: the runner-source search stays marked not done; the run-log path and soak config survive as reported pointers.",
					"Speaker: 'keep that exact line' is operator direction; the not-searched-yet status is agent report.",
					"Delivery: content is on the clipboard under a seed: label.",
				],
			},
		},
		{
			id: "structured-field-role",
			title: "A cross-sentence referenced structured field survives with name, value, and qualification",
			input: {
				seed: [
					{
						role: "user",
						content:
							"The scheduler status block you quoted has the budget field. Keep that field's exact name and reported value in any handoff, and keep the block's state line.",
					},
					{
						role: "assistant",
						content:
							"Status output on record: {\"scheduler\": \"degraded\", \"TIDE_BUDGET_EPOCH\": 12, \"next_window\": \"closed\"}. The degraded state started after the config reload. TIDE_BUDGET_EPOCH is not listed in docs/scheduler/fields.md; the other two fields are. I have not diffed the reload.",
					},
				],
				prompt: "/seed",
				fixture: {
					intent: "Carry the resolved budget field (exact name, reported value, documentation status) and the degraded-state report into the handoff.",
					mockOutcome: "success",
				},
			},
			checks: [
				{
					id: "delivery-label",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ['"label":"seed:'] },
				},
				{
					id: "payload-structured-field",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["TIDE_BUDGET_EPOCH", "12"] },
				},
				{
					id: "payload-state-and-docs",
					type: "tool-call",
					config: { name: "clipboard_copy", argumentsContain: ["degraded", "docs/scheduler/fields.md"] },
				},
				{
					id: "copy-outcome",
					type: "tool-result",
					config: { name: "clipboard_copy", isError: false, contentContains: ["Copied to clipboard"] },
				},
				{ id: "bounded-confirmation", type: "max-characters", config: { maximum: 1_500 } },
			],
			reviewMetadata: {
				criteria: [
					"Cross-sentence role: the operator's 'budget field' resolves to TIDE_BUDGET_EPOCH in the reported status block; the brief carries the exact field name and its reported value 12, so the resolution survives.",
					"Structured role: the field stays a reported status-output field; inventing what it measures, promoting it to a config knob or setting, or changing its value is a failure.",
					"Qualification: the undocumented status in docs/scheduler/fields.md and the not-diffed reload stay as reported; the degraded state and its post-reload timing survive, and the state line is kept as the operator directed.",
					"Speaker: the keep-direction is the operator's; the status block, the field listing, and the reload timing are agent-reported observations.",
					"Delivery: content is on the clipboard under a seed: label.",
				],
			},
		},
	],
	limits: {
		wall: { runTimeoutMs: 1_500_000, executionTimeoutMs: 120_000 },
		execution: { maxTotal: 60, maxTurnsEach: 2, maxOutputTokensEach: 16_384 },
		cost: { currency: "USD", maxObserved: 15, enforcement: "observed-after-each-execution", hardCap: false },
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
			"Prefer the brief that treats each token by its stated role, not its shape: bare fragments with no stated role are omitted unnamed; reported raw diagnostic lines and structured output fields survive exactly, with reported names and values intact.",
			"Prefer the brief that assigns no invented meaning in either direction: no identity, origin, or cause for a role-less fragment, and no finer identity than the reported role for a preserved string; paraphrase that keeps an invented meaning while dropping the token text fails the same way.",
			"Prefer the brief that keeps speaker roles and qualifications: operator direction, agent report, and pending decision stay distinct; reported-done work is not upgraded to verified, and unverified pointers are kept as such, not dropped.",
			"Prefer the brief that serves the selected request type without converting it (state stays state, parallel stays parallel, scope limits stay exact) and keeps decisive pointers and rationale concise.",
			"Prefer the delivery that reflects the clipboard tool's actual outcome and never carries a role-less fragment or secret fragment into the payload, label, or chat.",
		],
		metadata: {
			note: "Deterministic checks are structural floors over tool calls, results, and chat text; lexical floors cannot judge whether a preserved string gained invented meaning or an omitted fragment was paraphrased into one, so those judgments are human review.",
		},
	},
};

export default defineSuite(suite);
