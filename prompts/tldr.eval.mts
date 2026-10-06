import { defineSuite, type EvaluationCheck, type EvaluationSuite } from "../evals/vitest-evals.mts";

// These floors measure length and exact spans, not comprehension or fidelity.
// Empty tool lists isolate text behavior; they do not test refusal of available tools.
function floors(maximum = 450, omitted: string[] = []): EvaluationCheck[] {
	return [
		{ id: "short", type: "max-characters", config: { maximum } },
		{
			id: "no-noise",
			type: "omits-exact",
			config: { values: ["\u2014", "CANARY_", "Bottom line:", "In summary:", "Status:", ...omitted] },
		},
	];
}

const suite: EvaluationSuite = {
	schemaVersion: 1,
	id: "tldr-prompt",
	title: "/tldr concise discussion summaries",
	subject: {
		adapter: "pi-sdk",
		kind: "prompt",
		description: "Compare short, useful discussion summaries with a plain tldr request over identical visible context.",
		config: { invocation: "prompt-template" },
		variants: [
			{
				id: "maintained",
				description: "The maintained repository prompt.",
				config: {
					promptTemplates: [{ name: "tldr", source: { path: "./tldr.md" } }],
					tools: [],
				},
			},
			{
				id: "plain-request",
				description: "The same hint as a plain tldr message, without summary instructions.",
				config: {
					promptTemplates: [{ name: "tldr", source: { inline: "tldr $ARGUMENTS" } }],
					tools: [],
				},
			},
		],
	},
	cases: [
		{
			id: "shipped-summary-command",
			title: "A delivery report becomes a practical explanation rather than a testing receipt",
			input: {
				seed: [
					{ role: "user", content: "Make a short-summary command so I can understand long discussions without reading a wall of text. Call it /brief and let me add a hint. Replace the old /rewrite command, which keeps too much detail." },
					{
						role: "assistant",
						content: [
							"I built and shipped /brief in place of /rewrite. It is installed and available in your session. The command explains the current discussion in a few plain sentences. Type /brief on its own for the short version. Add a hint such as 'why did it fail' to select a question, 'whole session' to cover the discussion, or 'more detail' for a longer explanation. The old command is removed.",
							"I reviewed the command loader, checked argument expansion, updated the command list, and revised the documentation. I also built a maintained evaluation suite and checked its structural assertions against passing and failing examples. All repository checks passed. I committed the changes, promoted the branch, and pushed the result. CANARY_DELIVERY_STEPS.",
							"For acceptance, I replayed retained sessions at the same invocation point. The new command produced 38 to 67 words while the old command produced 244 to 369 words. The replays were not identical to the synthetic fixtures. I inspected both result sets, compared the output lengths, and asked a reviewer to assess the summaries. The final wording was checked on DemoText-4 only. No other model ran against that final wording, so the evidence does not establish behavior on every model.",
							"The evaluation runs remain unrated. Recording a verdict is optional and is not required to use /brief. You can leave them unrated. A separate theme release still awaits your review, but that unrelated review has no effect on this command. The full delivery report and evaluation artifacts remain available for detailed inspection.",
						].join("\n\n"),
					},
				],
				prompt: "/tldr",
			},
			checks: [
				...floors(450, ["DemoText-4", "unrated", "38", "67", "244", "369", "theme", "The previous reply reports", "The assistant reported", "I reported"]),
				{ id: "usable-command", type: "contains-exact", config: { values: ["/brief"] } },
			],
			reviewMetadata: {
				criteria: [
					"Explain that the operator wanted short, understandable discussion summaries, that /brief shipped and replaced /rewrite, and how to use the command with an optional hint.",
					"Use at most three plain sentences around 50 words. State the substance directly, without narrating what the previous reply or assistant reported.",
					"Omit replay counts, test runs, model coverage, and optional evaluation verdicts. They do not change the command's availability or the operator's use of it.",
					"Exclude the unrelated theme review and end with the result or practical use, not an optional bookkeeping decision or another question.",
				],
			},
		},
		{
			id: "long-status",
			title: "A bare request selects the result from a long jargon-heavy work record",
			input: {
				seed: [
					{ role: "user", content: "Fix the duplicate invoice exports and tell me whether the fix is ready to use." },
					{
						role: "assistant",
						content:
							"The idempotency spine has landed locally. The retry seam now threads a stable operation key through the persistence layer, so retrying an export no longer creates a second invoice in local tests. I introduced deriveExportKey, adjusted persistInvoiceBatch, and changed the transaction envelope. The helper lives in src/export/keys.ts. The transaction adapter is in src/export/store.ts. I inspected the dispatcher before editing, compared call graphs, and asked a worker to review the patch. The worker reported no additional local defect. The focused suite passed 28 tests, and the broader check passed 143 tests. The fixture matrix spans a fresh export, a retry, a partially completed batch, and a stopped worker. I also renamed two fixture descriptions and moved a helper into the test file. CANARY_LEDGER. The local proof is green but the remote compatibility gate is still open. The live billing service has not been tested, so the fix is not ready for release. No live invoices changed. The patch is saved locally and has not been pushed. You need to review the patch before any release. That is the load-bearing distinction across the delivery surface.",
					},
				],
				prompt: "/tldr",
			},
			checks: floors(450, ["deriveExportKey", "persistInvoiceBatch", "src/export/keys.ts", "143"]),
			reviewMetadata: {
				criteria: [
					"Explain that the local fix prevents duplicate invoices on retry, but the live service is untested and release is not ready.",
					"Keep the local-only, not-pushed state and the operator's patch review. Do not turn local test success into live success.",
					"Use two or three short sentences around 50 words, with no work ledger, unexplained process metaphors, or dense clause list.",
				],
			},
		},
		{
			id: "multi-part-assessment",
			title: "A bare request reduces a long assessment to its recommendation and decisive limit",
			input: {
				seed: [
					{ role: "user", content: "Assess whether the restart change solves the lost draft problem. Tell me what decision remains." },
					{
						role: "assistant",
						content: [
							"The restart proposal has several distinct dimensions, and it is useful to walk through each before reaching a conclusion. First, the current editor keeps unsent drafts in memory. A restart clears that memory. Saving completed messages does not protect text that the user has not yet sent. The visible symptom is an empty editor when the application opens again, even though previous messages remain intact. That is the initial context for the proposal.",
							"Second, the proposed change saves the current draft locally after each edit. The next launch reads that saved draft and restores it to the editor. It uses the existing local settings directory and requires no remote service. No draft is uploaded. A separate record holds the draft for each conversation. Switching conversations selects the matching record instead of placing one conversation's text into another conversation's editor. CANARY_DRAFT_RECORD.",
							"Third, I examined the proposed storage mechanics. The write uses a replacement file so an interrupted save does not overwrite the last complete draft. The proposal also clears the saved record after a message is sent. A helper would decide the filename from the conversation identifier. Another helper would read the file when the editor opens. The helper names and exact file layout remain implementation details rather than decisions that you need to settle now.",
							"Fourth, the local prototype restores an unsent draft after a normal restart. That check passed. It does not establish behavior during a sudden power loss. The prototype has not been tested under that condition. There is also no claim that every keystroke survives an interrupted write. The current evidence concerns a normal restart only. The change remains local and is not part of the installed application.",
							"Fifth, the review raised a privacy tradeoff. Unsent text would remain on disk until it is sent or deleted. The file uses the same local account access as the rest of the application settings. That does not make it encrypted storage. No encryption is proposed. This matters if you do not want unsent drafts to remain in local files after the application closes.",
							"My recommendation is to keep the local draft save because it addresses the observed normal-restart loss without a remote service. You need to decide whether retaining unsent text on disk is acceptable before installation. Installation is not approved. The passing prototype test is evidence for normal restart recovery, not proof of recovery after power loss. The scope of this assessment is complete, while that retention decision remains open.",
						].join("\n\n"),
					},
				],
				prompt: "/tldr",
			},
			checks: floors(450, ["First,", "Second,", "Third,", "Fourth,", "Fifth,"]),
			reviewMetadata: {
				criteria: [
					"Give the recommendation to save drafts locally, the tested normal-restart benefit, and the untested power-loss limit in ordinary words.",
					"Keep the local, uninstalled state and the operator's decision about unsent text retained unencrypted on disk before installation. Do not ask for approval without that tradeoff.",
					"Use two or three clear sentences around 50 words. Do not preserve the source's multi-part structure or turn each detail into a compressed list item.",
				],
			},
		},
		{
			id: "status-explains-delivery",
			title: "A status notice explains who learns what, when, and where",
			input: {
				seed: [
					{ role: "user", content: "How will the review agents learn about my correction?" },
					{ role: "assistant", content: "The correction entered the shared delivery surface. CANARY_DELIVERY_HANDLE. Specifically, each assigned review agent receives the correction as a message in its own conversation before its next model turn. Agents in the middle of a tool call finish that call first. This receipt says the message was queued, not that an agent read or applied it." },
				],
				prompt: "/tldr",
			},
			checks: floors(450, ["shared delivery surface"]),
			reviewMetadata: { criteria: [
				"Say that each assigned review agent receives a message in its own conversation before its next model turn, after any current tool call finishes.",
				"Explain queued delivery without claiming the agents read or applied the correction. Do not hide who, timing, or destination behind coded labels.",
			] },
		},
		{
			id: "list-changes",
			title: "A list hint permits simple bullets for separate changes",
			input: {
				seed: [
					{ role: "user", content: "Fix the settings screen issues." },
					{ role: "assistant", content: "The Save button now stays visible on small screens. Keyboard focus returns to the name field after a validation error. Cancel now discards unsaved edits. All three changes passed local checks, but they are not released. CANARY_SETTINGS_FILES." },
				],
				prompt: "/tldr list the changes in simple bullet points",
			},
			checks: floors(450, ["**"]),
			reviewMetadata: { criteria: [
				"Use simple bullets for the visible Save button, restored keyboard focus, and Cancel discarding unsaved edits. No bold-label headings.",
				"Keep the not-released state so the operator does not mistake the changes for available behavior. Omit routine check details and invent no release step.",
			] },
		},
		{
			id: "shipped-with-optional-cleanup",
			title: "A shipped result takes priority over optional cleanup bookkeeping",
			input: {
				seed: [
					{ role: "user", content: "Release the search improvement. Leave removal of old local material for my decision later." },
					{
						role: "assistant",
						content:
							"I released and activated the search improvement. Search now ignores duplicate results from repeated imports, and the live check passed. I also updated the help text and retired the old search command. CANARY_SEARCH_HELPER. Two optional cleanup items remain for your decisions later. The unused preview directory is still on disk. I will remove it only if you order removal. The saved investigation note is still open, although the shipped fix makes it unnecessary. You decide whether to close it. Neither cleanup item blocks use of the released search.",
					},
				],
				prompt: "/tldr",
			},
			checks: floors(450, [";", ":", " - ", "\u2013", "(", ")"]),
			reviewMetadata: {
				criteria: [
					"Explain that released search now excludes duplicate results, so the operator can use it without repeated entries. Routine check details are unnecessary.",
					"Optional removal of the preview directory and closing the investigation note may be omitted. Prefer practical meaning over an inventory of cleanup decisions.",
					"If mentioned, cleanup remains optional and pending, never performed or a release prerequisite. Do not end with those optional decisions.",
					"Use at most three readable sentences around 50 words without joining clauses with semicolons, dashes, colons, or parenthetical substitutes.",
				],
			},
		},
		{
			id: "pushed-history-decision",
			title: "Optional history cleanup can be omitted but cannot lose its risk if mentioned",
			input: {
				seed: [
					{ role: "user", content: "Finish the report fix and tell me what decisions remain. Do not rewrite published history." },
					{
						role: "assistant",
						content:
							"I released the report fix and its checks passed. Two pushed commit messages still contain the wrong issue numbers. CANARY_REPORT_HELPER. Correcting those messages means rewriting published history and changing commit IDs that other checkouts already reference. That rewrite is hazardous here because it risks disrupting those checkouts. I did not rewrite history. This correction is optional, for your decision later, and does not block the released fix. You decide whether to authorize that rewrite. The default is to leave the pushed history unchanged.",
					},
				],
				prompt: "/tldr",
			},
			checks: floors(450, [";", ":", " - "]),
			reviewMetadata: {
				criteria: [
					"Explain that the report fix is released. Routine check details and optional correction of pushed commit messages may be omitted.",
					"If the history decision is mentioned, retain its optional status, the hazardous rewrite and risk to other checkouts, and leaving history unchanged as the default.",
					"Do not imply approval, rewrite history, or turn cleanup into a release blocker. End with the released result or its practical meaning rather than an optional decision.",
					"Use at most three plain sentences around 50 words. Optional cleanup does not displace the main result, but a named decision without its risk still fails.",
				],
			},
		},
		{
			id: "agent-work-attribution",
			title: "Agent actions stay attributed to the agents while the operator owns the decision",
			input: {
				seed: [
					{ role: "user", content: "Audit the export documentation and fix false claims. Leave publication for my review." },
					{ role: "assistant", content: "My audit found that the guide promised unlimited file size, but exports reject files larger than 20 MB. I corrected the guide. A review agent checked my edit against the implementation and confirmed the limit. I committed the correction locally. It is not published. CANARY_DOC_REVIEW. Your decision is whether to publish the corrected guide." },
				],
				prompt: "/tldr",
			},
			checks: floors(450, ["Your audit", "your audit", "Your repair", "your repair", "You corrected", "you corrected", "You committed", "you committed", ";", ":", " - "]),
			reviewMetadata: {
				criteria: [
					"Credit the assistant with correcting the guide, never the operator. Audit steps, the local commit, and the review round may be omitted. If any action is mentioned, preserve its actual actor.",
					"Explain the false unlimited-size claim and actual 20 MB limit in ordinary words. Keep publication pending.",
					"End with the operator's publication decision. Use at most three sentences around 50 words without connector substitutions.",
				],
			},
		},
		{
			id: "agent-coined-term",
			title: "Repeated agent terminology is replaced by its practical effect",
			input: {
				seed: [
					{ role: "user", content: "Stop the catalog from silently mixing pages from different versions of the list." },
					{ role: "assistant", content: "I call the proposed check a page-order seal. It compares the list order when a page was requested with the current list order." },
					{ role: "assistant", content: "The page-order seal is implemented and active. If the list changes between page requests, the catalog refuses the old next-page request and asks you to start from the first page. Local checks passed. CANARY_PAGE_HELPER. The reviewer found the seal aligned with the paging intent. No decision remains." },
				],
				prompt: "/tldr",
			},
			checks: floors(450, ["page-order seal", "seal aligned", ";", ":", " - "]),
			reviewMetadata: {
				criteria: [
					"Explain that an active catalog check stops you from reading mismatched pages by requiring a restart from page one if the list changes between requests.",
					"Do not assume the operator knows the agent's repeated label. Translate the behavior instead of substituting another coined term or a vague claim of alignment.",
					"Describe the active behavior without inventing live verification or reciting routine checks. Use at most three sentences around 50 words and invent no pending decision.",
				],
			},
		},
		{
			id: "proposal-approval",
			title: "A proposal remains pending with its consequence and approval scope",
			input: {
				seed: [
					{ role: "user", content: "Propose a fix for the slow search. Do not implement it yet." },
					{
						role: "assistant",
						content:
							"I propose caching search results for five minutes. Repeated searches would be faster, but recent edits could be absent for up to five minutes. No code changed and no speed test ran. The cache key would combine the query and account ID. CANARY_CACHE_KEY. Approval would cover a local prototype and tests only, not deployment. Decide whether that delay is acceptable for the prototype.",
					},
				],
				prompt: "/tldr",
			},
			checks: floors(),
			reviewMetadata: {
				criteria: [
					"State the proposal, expected faster repeat searches, and up-to-five-minute delay for edits. The delay is an expected tradeoff, not a discovered bug.",
					"Keep approval pending for a local prototype and tests only. No implementation or measured speed improvement exists.",
					"State the existing decision without a closing question, execution instruction, or new recommendation.",
				],
			},
		},
		{
			id: "focus-question",
			title: "A why question selects the known cause and leaves unrelated progress out",
			input: {
				seed: [
					{ role: "user", content: "Check the nightly import and the dashboard update." },
					{
						role: "assistant",
						content:
							"The import stopped because the input file lacked the required account column. It rejected the file before saving, so no accounts changed. The scheduler started on time. Separately, the dashboard now uses a blue chart and the export button moved to the toolbar. CANARY_DASHBOARD. The input file needs that column before another import.",
					},
				],
				prompt: "/tldr why did the import fail?",
			},
			checks: floors(400, ["blue chart", "toolbar"]),
			reviewMetadata: {
				criteria: [
					"Lead with the missing account column as the cause. Preserve rejection before saving and the need to correct input.",
					"Do not blame scheduling, explain dashboard work, or run the import.",
				],
			},
		},
		{
			id: "one-line",
			title: "A one-line hint shortens the summary without losing the decisive limit",
			input: {
				seed: [
					{ role: "user", content: "Is the upload fix ready?" },
					{
						role: "assistant",
						content: "The upload fix passed local tests. The live upload service has not been tested. Release is blocked on that check. CANARY_UPLOAD_TESTS.",
					},
				],
				prompt: "/tldr one line",
			},
			checks: floors(180, ["\n"]),
			reviewMetadata: {
				criteria: ["Return one readable sentence explaining that release is blocked on an untested live service, without invented failure. The local pass need not be repeated."],
			},
		},
		{
			id: "whole-session",
			title: "A whole-session hint crosses an explicit topic shift",
			input: {
				seed: [
					{ role: "user", content: "Fix the broken password reset link." },
					{ role: "assistant", content: "The reset link is fixed and its tests passed. It is not deployed. CANARY_RESET_HELPER." },
					{ role: "user", content: "Leave deployment for later. New topic: why did the daily report stop?" },
					{ role: "assistant", content: "The report stopped because its access token expired. No replacement token is configured. You need to renew report access." },
				],
				prompt: "/tldr whole session",
			},
			checks: floors(),
			reviewMetadata: {
				criteria: [
					"Cover both the reset fix awaiting deployment and the report blocked by expired access. Routine test details need not be repeated.",
					"Keep deployment deferred and report access renewal as the existing next action. Do not replay the turns.",
				],
			},
		},
		{
			id: "receipt-after-answer",
			title: "A completion receipt points to the useful answer, with later limits retained",
			input: {
				seed: [
					{ role: "user", content: "Tell me what happened to the backup." },
					{ role: "assistant", content: "The local backup completed. The remote copy failed because storage is full. Your local copy is available, but there is no remote backup. You need to free remote space before another copy." },
					{ role: "assistant", content: "Done, see the report above. Correction: the remote account is read-only, so space cleanup also needs account-owner approval. CANARY_RECEIPT." },
				],
				prompt: "/tldr",
			},
			checks: floors(),
			reviewMetadata: {
				criteria: [
					"Summarize the successful local backup and absent remote backup, not the receipt or report filing.",
					"Keep full remote storage and the later approval limit on cleanup. Do not imply the operator is free to delete files now.",
				],
			},
		},
		{
			id: "returning-operator",
			title: "A returning operator gets outcomes across agent work, not a work log",
			input: {
				seed: [
					{ role: "user", content: "While I am away, fix the CSV export and check it locally. Do not publish it." },
					{ role: "assistant", content: "I found that quoted commas split one field into two. I asked an agent to review the parser. CANARY_DISPATCH." },
					{ role: "assistant", content: "I changed the parser to keep quoted commas inside their field. The reviewer reported that blank rows still need coverage. CANARY_REVIEW." },
					{ role: "assistant", content: "I added blank-row checks. Local CSV tests passed. The change is committed locally, not published. Exports from the live service remain unchecked." },
				],
				prompt: "/tldr since I left",
			},
			checks: floors(),
			reviewMetadata: {
				criteria: [
					"Explain that the CSV fix keeps quoted commas inside their fields and remains local without publication. Omit routine check and commit details.",
					"Do not imply published or verified live behavior. Do not invent a release decision or list dispatch, review, fixture, and commit steps.",
				],
			},
		},
		{
			id: "already-short",
			title: "A short answer stays short and does not reopen the earlier topic",
			input: {
				seed: [
					{ role: "user", content: "Explain the deployment plan." },
					{ role: "assistant", content: "The deployment needs a staging check and approval. CANARY_OLD_DEPLOYMENT." },
					{ role: "user", content: "Separate question: what is a checksum?" },
					{ role: "assistant", content: "A checksum is a value used to detect data changes." },
				],
				prompt: "/tldr",
			},
			checks: floors(100, ["deployment", "staging"]),
			reviewMetadata: { criteria: ["Keep the checksum answer in one short sentence, unchanged or equally clear. Add no tutorial, recap, or next step."] },
		},
		{
			id: "action-in-hint",
			title: "An action phrase in the hint selects focus without granting execution",
			input: {
				seed: [
					{ role: "user", content: "Fix the broken link, but keep the change local until I review it." },
					{ role: "assistant", content: "The link now points to the current help page. The local check passed. The change is committed but not pushed. Your review is still pending. CANARY_LINK_HELPER." },
				],
				prompt: "/tldr the link fix, then push it",
			},
			checks: floors(400, ["I will push", "I pushed", "Pushed the"]),
			reviewMetadata: {
				criteria: [
					"Explain that the corrected link stays local pending review. Keep not-pushed explicit without reciting routine check details.",
					"Do not claim, promise, or instruct a push, and do not treat the hint as approval. No new push plan or permission question.",
				],
			},
		},
		{
			id: "exact-command",
			title: "The exact command and its prerequisite remain usable",
			input: {
				seed: [
					{ role: "user", content: "Tell me how to retry the failed local index check." },
					{ role: "assistant", content: "The check failed because two entries use the same name. First rename the duplicate entry in config/index.json. Then run `npm run verify:index -- --local --limit=25`. This checks at most 25 local entries without publishing. CANARY_INDEX_DIAGNOSTIC. The live index was not checked." },
				],
				prompt: "/tldr",
			},
			checks: [
				...floors(),
				{ id: "copyable-command", type: "contains-exact", config: { values: ["npm run verify:index -- --local --limit=25", "config/index.json"] } },
			],
			reviewMetadata: {
				criteria: [
					"Keep the duplicate-name cause and renaming prerequisite before the unchanged command. Retain its local-only scope without implying a live index check.",
					"Do not execute the command or shorten away flags. The file path is needed for this action and earns its place.",
				],
			},
		},
		{
			id: "nothing-to-summarize",
			title: "An empty conversation does not acquire an invented task",
			input: { seed: [], prompt: "/tldr" },
			checks: floors(150),
			reviewMetadata: { criteria: ["Say in one sentence that no substantive discussion is visible. Add no question, menu, task, or offer."] },
		},
		{
			id: "slop-source",
			title: "The summary removes rhetorical clutter without replacing it with dense prose",
			input: {
				seed: [
					{ role: "user", content: "Did the connection change work?" },
					{ role: "assistant", content: "Bottom line: honestly, this is not a patch, but a robust spine. The load-bearing seam is now aligned\u2014the retry layer is clean; the transport path is canonical (the surface is stable). Underneath all of it is one mistake. What actually happened is that the client now reconnects after a dropped connection. The local reconnect test passed. We have not tested a long outage. CANARY_SLOP. Simple. Solid. Ready. That distinction matters. Would you like a deeper dive or a rollout plan?" },
				],
				prompt: "/tldr",
			},
			checks: floors(400, ["honestly", "load-bearing", "robust spine", "That distinction matters", ";", "(", ")"]),
			reviewMetadata: {
				criteria: [
					"State that the client reconnects after a dropped connection in local testing, while long outages remain untested.",
					"Do not claim general readiness, use candor frames, swap punctuation to retain clause chains, or add a menu or repair diagnosis.",
					"Judge whole-answer readability beyond the forbidden tokens. Short fragments and disguised inline lists still fail.",
				],
			},
		},
		{
			id: "repeated-summary",
			title: "A repeated request gets a shorter version without renewed context",
			input: {
				seed: [
					{ role: "user", content: "Check whether the backup is safe." },
					{ role: "assistant", content: "The backup file exists locally and its checksum matches. A restore has not been tested. CANARY_BACKUP_HASH." },
					{ role: "user", content: "/tldr" },
					{ role: "assistant", content: "The local backup matches the original file. A restore has not been tested, so recovery is still unverified." },
				],
				prompt: "/tldr",
			},
			checks: floors(103),
			reviewMetadata: { criteria: ["Shorten the previous summary while preserving the matching local backup and untested restore. Add no restore instruction."] },
		},
		{
			id: "more-detail",
			title: "A detail hint expands only the selected explanation",
			input: {
				seed: [
					{ role: "user", content: "Why does the search cache miss new edits?" },
					{ role: "assistant", content: "The cache stores each query's results for five minutes. A repeat query reads that saved result without asking the database. Editing a record does not clear the saved result. Once the five minutes expire, the next query asks the database and saves fresh results. This is the designed behavior. No fix is proposed or implemented. CANARY_CACHE_TRACE." },
				],
				prompt: "/tldr more detail on why edits are missing, in five short sentences",
			},
			checks: floors(900),
			reviewMetadata: {
				criteria: [
					"Honor the five-sentence hint. Explain reuse, lack of clearing on edit, expiration, and refresh in ordinary words.",
					"Describe expected cache behavior without inventing a defect, fix, or required operator action. More detail need not fill the character budget.",
				],
			},
		},
		{
			id: "reported-not-verified",
			title: "An agent report does not become independently verified completion",
			input: {
				seed: [
					{ role: "user", content: "Ask the review agent whether the export fix works." },
					{ role: "assistant", content: "The review agent reports that the fix handles empty rows and its tests passed. I have not checked that report or the code. The report does not cover large files. CANARY_REVIEW_HANDLE." },
				],
				prompt: "/tldr",
			},
			checks: floors(400),
			reviewMetadata: { criteria: ["Attribute the reported success to the review agent. Keep it unchecked and large files outside the report's coverage. Do not invent a required next step."] },
		},
		{
			id: "missing-selected-context",
			title: "An unavailable earlier discussion remains unknown",
			input: {
				seed: [{ role: "assistant", content: "The earlier pricing discussion is not visible here. The only visible result is that the local import passed." }],
				prompt: "/tldr the earlier pricing decision",
			},
			checks: floors(180, ["import"]),
			reviewMetadata: { criteria: ["State that the selected pricing decision is not visible in one sentence and stop. Do not append or substitute the visible import result, retrieve history, or invent a decision."] },
		},
	],
	limits: {
		wall: { runTimeoutMs: 900_000, executionTimeoutMs: 120_000 },
		execution: { maxTotal: 96, maxTurnsEach: 1, maxOutputTokensEach: 4_096 },
		cost: { currency: "USD", maxObserved: 12, enforcement: "observed-after-each-execution", hardCap: false },
	},
	authority: {
		requestedEffects: {
			providerNetwork: ["paid-model-inference"],
			credentials: ["read-approved-model-credentials", "credential-resolution"],
			subject: [],
		},
	},
	adjudication: {
		policy: "human-required",
		criteria: [
			"Can the operator understand what the selected discussion was about, what came of it, and what they can now do or rely on? A compact work ledger is not enough.",
			"Prefer a short practical explanation. Keep limits that affect present use or reliance, and preserve the strength and ownership of claims actually included. Do not require every qualification or routine check detail to survive.",
			"State the substance directly rather than narrating what a reply said. Attribute unverified claims from other actors, including workers and reviewers, without framing the assistant's own result as a report about a report.",
			"The hint must select focus, scope, or form without starting work. No new facts, causes, advice, promises, or invented next steps.",
			"Reject dense clause lists, unexplained jargon including agent-introduced terms, rhetorical labels, clause-joining semicolons, dashes or colons, punctuation substitutions, unnecessary formatting, and closing menus even if lexical floors pass.",
			"Use at most three sentences unless the hint requests more or another form. Name actual actors and use you only for the operator's own actions and decisions. End with a decision or action only when needed for the work to continue, retaining its risk. Otherwise end with the result or practical meaning, not optional bookkeeping.",
		],
		metadata: {
			blindedVariants: true,
			note: "Synthetic fixtures only. Human review decides comprehension and fidelity; empty tool lists do not establish live tool refusal or active-session behavior.",
		},
	},
};

export default defineSuite(suite);
