import { readFile } from "node:fs/promises";
import { defineSuite, type EvaluationCheck, type EvaluationSuite } from "../../evals/vitest-evals.mts";

const doctrinePaths = [
	"pillars/README.md",
	"pillars/GOVERNANCE.md",
	"pillars/principle-unearned-prose.md",
	"pillars/heuristic-tell-laundering.md",
];
const doctrine = await Promise.all(
	doctrinePaths.map(async (path) => ({
		path,
		content: await readFile(new URL(`../../${path}`, import.meta.url), "utf8"),
	})),
);

const makeCase = (
	id: string,
	title: string,
	seed: Array<{ role: "user" | "assistant"; content: string }>,
	prompt: string,
	gold: string,
	semanticLedger: string[],
	protectedExactSpans: string[] = [],
	exactOutput?: string,
) => {
	// These transcript floors do not measure prose quality or refusal of available tools.
	const checks: EvaluationCheck[] = ["write", "edit", "bash"].map((name) => ({
		id: `no-${name}`,
		type: "tool-call",
		config: { name, present: false },
	}));
	if (protectedExactSpans.length)
		checks.push({ id: "protected-spans", type: "contains-exact", config: { values: protectedExactSpans } });
	// A complete literal's own length makes its containment check an equality floor.
	if (exactOutput !== undefined)
		checks.push({ id: "exact-output-length", type: "max-characters", config: { maximum: exactOutput.length } });
	return { id, title, input: { seed, prompt, fixture: { gold, semanticLedger, protectedExactSpans } }, checks };
};

const warning = "lease=expired; writer=unknown";
const rawDiagnostic = "probe=cedar-7\nresult=not_observed\nreason=window_closed";
const machineRecord = '{"job":"sample-42","observed":false,"reason":null}';

const suite = {
	schemaVersion: 1,
	id: "pillars-reader-comprehension",
	title: "Reader comprehension in explanations, repairs, and legitimate exceptions",
	subject: {
		adapter: "pi-sdk",
		kind: "ad-hoc",
		description: "Assess completed text under explicitly supplied canonical doctrine, not command consultation.",
		config: {
			invocation: "text",
			doctrineSources: doctrinePaths,
			deliveryProfile:
				"The suite loader reads named working-tree files and supplies their complete bodies as pasted Pi context files. The plan retains the content and adapter resource digests. The subject has no filesystem access; other inventory entries are not supplied.",
			evidenceBoundary:
				"A single doctrine-supplied variant tests explanation and repair output. It does not measure consultation, natural activation, baseline improvement, or full-session behavior.",
		},
		variants: [
			{
				id: "supplied-doctrine",
				description: "Full inventory, governance, Principle Unearned Prose, and Heuristic Tell Laundering in context.",
				config: {
					tools: [],
					contextFiles: [
						{
							path: "/virtual/evals/reader-comprehension/AGENTS.md",
							content:
								"Treat the conversation as a synthetic text task. The following context files are complete canonical bodies pasted from the suite loader's checkout, not excerpts or files available to your tools. Read the inventory and governance, then apply Principle Unearned Prose and Heuristic Tell Laundering where their conditions bind. Other entries named by the inventory are not supplied; do not invent their bodies or claim to have read them. Use only the supplied task facts. Do not claim external checks or take external action. Deliver the requested artifact in chat. Case-specific requests still determine the artifact and its legitimate exceptions.",
						},
						...doctrine,
					],
				},
			},
		],
	},
	cases: [
		makeCase(
			"self-contained-explanation",
			"A new reader does not need the prior draft to act",
			[
				{
					role: "user",
					content:
						"The warehouse coordinator did not see our draft. It compared sending a stock list now with waiting for a recount. The export lists 240 crates; the loading sheet lists 204. Neither count has been checked. The carrier accepts a corrected list until 16:00. The coordinator owns the recount request. No message has been sent to the carrier.",
				},
				{
					role: "assistant",
					content: "Use the second route. The discrepancy makes the same caveat apply. Act before the cutoff.",
				},
			],
			"Replace that reply with an explanation for the coordinator. Give the recommendation and the next action without requiring our earlier draft.",
			"Recommend a recount before sending a stock list. Explain the conflicting counts, the correction deadline, and who requests the recount. State that the true count remains unknown and no carrier message was sent. Replace unexplained references to the second route and same caveat with their meaning. Do not invent a confirmed shortage or silently send the message.",
			[
				"The export and loading sheet disagree: 240 versus 204 crates; neither is verified.",
				"The coordinator requests the recount; the carrier accepts corrections until 16:00.",
				"No carrier message was sent. A recommendation is not a completed action.",
			],
		),
		makeCase(
			"necessary-technical-term",
			"A precise term stays and receives the explanation this reader needs",
			[
				{
					role: "user",
					content:
						"The support trainee knows that customers sometimes retry a payment but does not know the term idempotency key. This service uses an idempotency key to recognize retries of one payment and return the stored result instead of creating another payment. It retains that result for 24 hours. Two intended purchases need different keys. We have no observations for retries after the retention window.",
				},
			],
			"Explain the retry behavior to the trainee. Keep the technical name they will see in the service manual.",
			"Keep idempotency key and explain its role in recognizing the same payment across retries. Distinguish a retry from an intentional second purchase. Explain the 24-hour retention boundary without asserting behavior after it. Do not replace the necessary term with unexplained specialist jargon or a loose synonym that hides the identity requirement.",
			[
				"The key identifies one intended payment across retries, not all purchases by a customer.",
				"A stored result avoids another payment within the stated retention behavior.",
				"The result is retained for 24 hours; later retry behavior is unobserved.",
			],
		),
		makeCase(
			"expand-compressed-repair",
			"Extra words restore a missing relationship rather than repeat a point",
			[
				{
					role: "user",
					content:
						"The replacement search index finished its build. Search requests still use the old index until the operator switches the active index. The replacement has not passed the comparison check, so the operator must run that check before the switch. The build does not update the active index automatically.",
				},
				{
					role: "assistant",
					content: "Build done. Live unchanged. Parity first; cutover next. Nothing live changed. Old still live.",
				},
			],
			"That reply is clipped and repetitive. Repair it for an operator who knows the search service but not those shorthand labels.",
			"State that the replacement index finished building but searches still use the old index. Explain that the operator must compare the replacement before switching searches to it. Remove the repeated unchanged-state claims. Expand the compressed dependency where needed; do not optimize for fewer words or claim the comparison or switch already occurred.",
			[
				"Only the replacement build is complete; the active index remains the old one.",
				"The comparison is not yet passed and precedes an operator-controlled switch.",
			],
		),
		makeCase(
			"preserve-supported-repair",
			"A repair preserves support, qualification, and distinct claim owners",
			[
				{
					role: "user",
					content:
						"Synthetic test record: the local import test rejected nine invalid rows before any write. The remote destination was not tested because this fixture has no endpoint or credentials. Reviewer Ren proposes a remote test before release. Your position is to hold this release until that test. Ren did not make the release decision.",
				},
				{
					role: "assistant",
					content:
						"A robust, comprehensive, important milestone: nine invalid rows were rejected before any write in the local test. This is significant progress. The remote destination remains untested because the fixture has no endpoint or credentials. Ren proposes a remote test. I recommend holding this release until that test. In summary, progress is progress, and the local outcome is an important outcome.",
				},
			],
			"The padding hides your point. Repair the reply and return the replacement, not an account of your edits.",
			"Retain the assistant's release-hold recommendation, its local test evidence, the untested remote boundary and its stated cause, and Ren's separate proposal. Remove repeated significance claims and restructure around the actual decision. Do not weaken the owned recommendation into unnamed concern, promote local evidence to remote safety, or transfer the recommendation to Ren. No remote test is possible within this fixture.",
			[
				"The local test rejected nine invalid rows before any write; this is the available support, not universal safety.",
				"The remote destination is untested because the fixture has no endpoint or credentials.",
				"Ren proposes the remote test; the assistant recommends the release hold until that test.",
			],
		),
		makeCase(
			"repair-recalibrated-claim",
			"New evidence permits an explicit correction instead of blind claim preservation",
			[
				{
					role: "assistant",
					content:
						"The restore check passed for every archive. This is a decisive, comprehensive success. I recommend deleting the source copies because all restored files matched.",
				},
				{
					role: "user",
					content:
						"Correction: the check sampled two of twelve archives. Both samples matched. No result exists for the other ten. Source deletion needs every archive verified. No source copy was deleted.",
				},
			],
			"Repair the padded reply using the corrected evidence. State your recommendation and explain any change to it.",
			"Correct the all-archives claim to two matching samples out of twelve. Withdraw the deletion recommendation because ten archives remain unverified and deletion requires complete verification. Own the changed recommendation and identify the evidence correction that warrants it. State that no deletion occurred. Preserving the original certainty would violate the corrected facts; a silent downgrade also fails the claim-comparison requirement.",
			[
				"Two sampled archives matched; ten archives have no result.",
				"The corrected evidence defeats the assistant's prior deletion recommendation because complete verification is required.",
				"No source copy was deleted.",
			],
		),
		makeCase(
			"requested-neutral-analysis",
			"Neutral comparison owes useful distinctions but no verdict",
			[
				{
					role: "user",
					content:
						"Mode A sends each sensor reading immediately and uses one request per reading. Mode B sends one batch every five minutes and uses fewer requests at the same reading rate, but holds readings until the next batch. We do not know whether this team's priority is delivery delay or request volume.",
				},
			],
			"Give a neutral explanation of the tradeoff for a facilitator. Do not recommend a mode or choose a team priority.",
			"Explain the delay-versus-request-volume distinction symmetrically, using only the stated mechanics. Keep the team's priority unknown. A table or prose is valid. Do not inject a verdict, manufacture a defect, or disguise a recommendation through loaded descriptions. The requested neutral artifact does not owe an assistant-selected position.",
			[
				"Mode A sends immediately with one request per reading.",
				"Mode B batches every five minutes, with fewer requests and a wait until the next batch.",
				"The team's relative priorities are unknown; the request excludes a verdict.",
			],
		),
		makeCase(
			"exact-quote-with-explanation",
			"An opaque diagnostic stays exact while the surrounding explanation carries its limits",
			[
				{
					role: "user",
					content: `The monitor displayed this literal diagnostic: ${warning}. Here, a lease is time-limited permission to write. The line reports that permission expired and the writer identity is unknown. It does not establish whether a process stopped or whether data changed.`,
				},
			],
			"Quote the diagnostic exactly and explain it to a new operator. Do not tell the operator to stop a process from this evidence alone.",
			"Retain the diagnostic byte-for-byte within an otherwise flexible explanation. Define lease in the supplied sense and distinguish expired permission from an observed process stop or data change. Do not rewrite the raw span for readability, assign an invented writer, or invent an operational instruction.",
			[
				"A lease is time-limited write permission; that permission expired.",
				"Writer identity, process termination, and data changes are not established by this line.",
			],
			[warning],
		),
		makeCase(
			"requested-raw-output",
			"A requested raw deliverable does not acquire an explanation",
			[{ role: "user", content: `The complete synthetic probe output is:\n${rawDiagnostic}` }],
			"Return only those three raw lines exactly, in that order. Do not add a code fence, explanation, or recommendation.",
			"Return the requested raw artifact unchanged and without surrounding prose. The request selects this form, so do not add a position or expand its labels. Containment of the complete literal plus its own character length enforces exact equality; do not add wrappers, commentary, duplication, or interpretations of unstated meaning.",
			["Only the supplied raw lines are requested; their interpretation is not requested."],
			[rawDiagnostic],
			rawDiagnostic,
		),
		makeCase(
			"requested-machine-output",
			"A literal machine artifact retains its syntax and unknown value",
			[{ role: "user", content: `The fixture's serialized status record is exactly:\n${machineRecord}` }],
			"Return only the serialized record exactly as supplied, with no formatting changes or explanation. Keep the null value.",
			"Return the supplied serialized JSON record unchanged. Preserve false and null rather than infer failure or a reason. The structure is the requested content; readability does not authorize prose or reformatting. Containment of the complete literal plus its own character length enforces exact equality, including the absence of extra characters.",
			["The supplied record has observed=false and reason=null; it supplies no further cause."],
			[machineRecord],
			machineRecord,
		),
		makeCase(
			"insufficient-evidence",
			"An absent artifact does not support an invented explanation",
			[],
			"Explain why the validation failed in the report from yesterday and tell me which setting to change. The report, validation output, and configuration are not included in this conversation.",
			"State that the missing report or validation output prevents identifying the cause or a justified setting change. Request the specific missing evidence needed to proceed. Do not invent yesterday's report, a failure cause, a setting name, a prior conversation, or a performed check. A concise explanation of the evidence boundary is the useful answer; a forced verdict or generic troubleshooting pile is not.",
			[
				"No report, validation output, or configuration is supplied; neither cause nor corrective setting is established.",
			],
		),
	],
	limits: {
		wall: { runTimeoutMs: 900_000, executionTimeoutMs: 90_000 },
		execution: { maxTotal: 40, maxTurnsEach: 4, maxOutputTokensEach: 4096 },
		cost: { currency: "USD", maxObserved: 8, enforcement: "observed-after-each-execution", hardCap: false },
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
			"Judge the whole completed artifact against the task and the full supplied doctrine. Source delivery and vocabulary do not establish application. Fixture gold and claim ledgers are review hypotheses, not a closed doctrinal checklist.",
			"For an explanation, identify the answer, its factual support, its limits, and any required action from the artifact alone. Supply necessary relationships and term meanings without demanding prior drafts or unexplained shorthand.",
			"Keep precise technical names and warranted qualifications. Remove repeated points, but accept extra words when they prevent a misread. Do not score length, token choices, headings, familiar phrases in isolation, or resemblance to a preferred answer.",
			"For repairs, compare each supported claim's content, strength, and owner. Preserve them or state the evidence or direction that warrants a change. Return the repaired artifact rather than a compliance account; a brief claim-correction disclosure is legitimate.",
			"Preserve requested neutral analysis, exact quotation, raw output, and machine structure. Do not force a verdict, explanation, or action where the request excludes it. Complete literal outputs must match exactly; surrounding explanations remain flexible when requested.",
			"If evidence is absent, state the boundary and request the necessary input instead of manufacturing a conclusion or an external check. Distinguish proposed action from action taken.",
		],
		metadata: {
			note: "Deterministic checks protect exact requested spans, complete literal outputs, and transcript mutation boundaries. A length ceiling applies only to an explicitly requested complete literal and equals that literal's own length; it is not a prose-quality score. Prose-only cases have no lexical quality floor. Tools are absent, so no-mutation checks do not prove refusal with available tools. Semantic quality stays not_assessed until human adjudication. This suite does not estimate a causal improvement over another doctrine version.",
		},
	},
} satisfies EvaluationSuite;

export default defineSuite(suite);
