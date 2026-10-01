import { defineSuite, type EvaluationCheck, type EvaluationSuite } from "../../evals/vitest-evals.mts";

const evaluationBoundary =
	"Use only synthetic facts in each case, files under the suite fixtures directory, and explicitly loaded skill resources. The complete allowed synthetic evidence is the case seed plus named fixture files. No session stores, record directories, manifests, or other paths are available. Do not guess paths or inspect actual session stores, unrelated repository data, home credentials, or private records. Treat unlisted records as unavailable. This evaluation establishes behavior over synthetic evidence and selected resource reads, not complete real-store collection or refusal of unavailable tools.";

const triggerCases = [
	{
		id: "positive-retries",
		category: "positive",
		title: "An informal loop concern selects an episode audit",
		seed: "The conversation concerns repeated agent retries. The task has no calendar range or extension name.",
		prompt: "Can you work out why we keep going round in circles?",
		ledger: ["Read the audit skill.", "Select the relevant recorded episode.", "Do not require a time-period argument."],
	},
	{
		id: "positive-tools",
		category: "positive",
		title: "A pronoun resolves to recently compared tools",
		seed: "The operator just compared tool A and tool B. Tool C is not part of the discussion.",
		prompt: "Are we actually using these?",
		ledger: ["Resolve these to tool A and tool B.", "Collect retained use evidence for those tools.", "Do not count every installed extension."],
	},
	{
		id: "positive-comparison",
		category: "positive",
		title: "A change question selects comparable before and after evidence",
		seed: "The operator describes slow agent responses since a harness update. A comparable before and after window is available.",
		prompt: "Take a look at what changed after that update.",
		ledger: ["Audit relevant before and after evidence.", "Use comparable units.", "Do not assume the update caused the slowdown."],
	},
	{
		id: "positive-active-setup",
		category: "positive",
		title: "A bare setup request starts a bounded active audit",
		seed: "This is an active harness session with local read-only evidence available.",
		prompt: "Audit my setup.",
		ledger: ["Infer a bounded active setup or session scope.", "Start without routine date questions.", "State the selected scope."],
	},
	{
		id: "positive-worker-outcome",
		category: "positive",
		title: "An incomplete worker result selects delegation evidence",
		seed: "The operator requested a complete answer from a delegated worker. The worker returned an incomplete answer. No acceptance evidence exists. No other delegation or outcome records are available.",
		prompt: "Check how the agents handled this one.",
		ledger: ["Inspect relevant delegation and outcome evidence.", "Do not treat provider completion as task acceptance."],
	},
	{
		id: "positive-counts",
		category: "positive",
		title: "A numbers-only hint retains its units and gaps",
		seed: "The operator wants local harness use counts for yesterday. The timezone is UTC. Duration and cost are not recorded.",
		prompt: "Collect the evidence for yesterday, just the numbers.",
		ledger: ["Collect bounded local data.", "Honor numbers-only output.", "State the UTC window and preserve missing metrics."],
	},
	{
		id: "positive-cost",
		category: "positive",
		title: "A cost question uses recorded usage without invoice claims",
		seed: "The conversation suspects that model cost increased in the named agent sessions. Recorded usage exists, but invoice totals do not.",
		prompt: "Where is the spend coming from?",
		ledger: ["Use recorded usage and qualified cost evidence.", "Report source gaps.", "Do not infer invoice totals from incomplete token records."],
	},
	{
		id: "positive-quick-episode",
		category: "positive",
		title: "A quick evidence check keeps its process bound",
		seed: "The conversation names a recent local agent episode. The operator explicitly limits the process to a quick check with no workers.",
		prompt: "Give me a quick evidence-based check, no workers.",
		ledger: ["Audit the episode within the explicit process bound.", "Do not delegate.", "Use a narrower supported conclusion when evidence is costly."],
	},
	{
		id: "near-security-code",
		category: "near-miss",
		title: "A code security request routes away from session audit",
		seed: "A software patch is attached. The request contains no session-behavior question.",
		prompt: "Audit this function for SQL injection.",
		ledger: ["Use code or security review, not the audit skill.", "Do not collect local agent telemetry."],
	},
	{
		id: "near-prose-edit",
		category: "near-miss",
		title: "A spelling repair stays a prose task",
		seed: "The operator supplied prose for an audit report.",
		prompt: "Fix the spelling in this audit report.",
		ledger: ["Edit prose only.", "Do not start a session evidence audit."],
	},
	{
		id: "near-app-telemetry",
		category: "near-miss",
		title: "Application instrumentation stays outside local session audit",
		seed: "An application monitoring dashboard is the subject. The operator asks for an HTTP service change.",
		prompt: "Add telemetry to our HTTP service.",
		ledger: ["Treat this as application instrumentation work.", "Do not use the local session audit as the implementation workflow."],
	},
	{
		id: "near-definition",
		category: "near-miss",
		title: "A concept question receives an explanation",
		seed: "The operator asks a general concept question with no local record subject.",
		prompt: "What does telemetry mean?",
		ledger: ["Explain the concept.", "Do not inspect local session stores."],
	},
	{
		id: "near-exact-retrieval",
		category: "near-miss",
		title: "An exact session retrieval stays a retrieval",
		seed: "The operator names one retained session ID and wants its exact previous answer.",
		prompt: "Show me the last answer in session demo-42.",
		ledger: ["Use direct session retrieval.", "Do not expand one retrieval into an audit."],
	},
	{
		id: "near-billing-data",
		category: "near-miss",
		title: "Supplied invoice data stays a data analysis task",
		seed: "A billing CSV from an unrelated service is supplied. The local agent records are not the subject.",
		prompt: "Check these invoice totals.",
		ledger: ["Analyze the supplied billing data.", "Do not inspect local agent records."],
	},
	{
		id: "near-dependencies",
		category: "near-miss",
		title: "A manifest request stays a repository lookup",
		seed: "The operator asks for a repository dependency inventory.",
		prompt: "List the dependencies in package.json.",
		ledger: ["Read the manifest and answer.", "Do not run a harness behavior audit."],
	},
	{
		id: "near-tests",
		category: "near-miss",
		title: "A test request stays in the test workflow",
		seed: "The operator explicitly requests execution, not an audit of past behavior.",
		prompt: "Run the unit tests for this patch.",
		ledger: ["Follow the applicable test workflow.", "Do not replace the task with telemetry collection."],
	},
] as const;

const triggerChecks = (category: string): EvaluationCheck[] => {
	const checks: EvaluationCheck[] = [
		{
			id: "skill-file-read",
			type: "tool-call",
			config: { name: "read", argumentsContain: ["audit/SKILL.md"], present: category === "positive" },
		},
	];
	if (category === "positive") {
		checks.push({
			id: "skill-file-loaded",
			type: "tool-result",
			config: { name: "read", isError: false, contentContains: ["name: audit", "# Audit"] },
		});
	}
	return checks;
};

const suite: EvaluationSuite = {
	schemaVersion: 1,
	id: "audit-trigger",
	title: "Audit skill autonomous activation and near misses",
	subject: {
		adapter: "pi-sdk",
		kind: "skill",
		description: "Measure whether plain-language audit requests load the candidate skill without absorbing adjacent work.",
		config: {
			invocation: "autonomous-trigger",
			boundary: "A candidate read of SKILL.md is trigger evidence. Direct slash invocation is evaluated separately.",
		},
		variants: [
			{
				id: "candidate",
				description: "Load the audit skill from this slice and expose only the read tool.",
				config: {
					skills: [{ path: "./SKILL.md" }],
					tools: ["read"],
					cwd: "./fixtures",
					appendSystemPrompt: [evaluationBoundary],
				},
			},
		],
	},
	cases: triggerCases.map((item) => ({
		id: item.id,
		title: item.title,
		input: {
			seed: [{ role: "user" as const, content: item.seed }],
			prompt: item.prompt,
		},
		checks: triggerChecks(item.category),
		reviewMetadata: {
			category: item.category,
			triggerEvidence: "Only a read tool call that reaches SKILL.md counts as autonomous trigger evidence.",
			semanticLedger: [...item.ledger],
		},
	})),
	limits: {
		wall: { runTimeoutMs: 900_000, executionTimeoutMs: 120_000 },
		execution: { maxTotal: 64, maxTurnsEach: 6, maxOutputTokensEach: 2048 },
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
			"Positive prompts load SKILL.md more often than near misses under repeated clean runs.",
			"The candidate does not turn adjacent code, prose, application, retrieval, billing, dependency, or test tasks into session audits.",
			"Deterministic checks establish only candidate skill-file reach; semantic routing remains human review.",
		],
		metadata: {
			repetitions: 3,
			plannedCeiling: "Sixteen prompts at three repetitions; no best-of-run selection.",
		},
	},
};

export default defineSuite(suite);
