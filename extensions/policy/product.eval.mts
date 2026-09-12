import type { JsonValue } from "vitest-evals";
import { defineSuite, type EvaluationCheck, type EvaluationSuite } from "../../evals/vitest-evals.mts";
import { DEFAULT_LIMITS } from "./catalog.ts";

export type ProductStep = { name: string; args: Record<string, JsonValue> };
export type ProductCaseFixture = {
	script: ProductStep[];
	gold: string;
	group: string;
	expectedObserveMisses: string[];
};
const step = (name: string, args: Record<string, JsonValue>): ProductStep => ({ name, args });
const request = (scenario: string) => step("policy_product_request", { scenario, count: 1 });
const structured = (scenario: string, name = "policy_product_result") => step(name, { scenario });
const resultCheck = (name: string, text: string, isError = false, id = "outcome"): EvaluationCheck => ({
	id,
	type: "tool-result",
	config: { name, isError, contentContains: [text] },
});
function item(
	id: string,
	script: ProductStep[],
	checks: EvaluationCheck[],
	gold: string,
	group = "hard-negative",
	expectedObserveMisses: string[] = [],
	prompt?: string,
): EvaluationSuite["cases"][number] {
	return {
		id,
		title: id.replaceAll("-", " "),
		input: {
			seed: [],
			prompt:
				prompt ??
				`Make these inert tool calls sequentially with the exact arguments: ${JSON.stringify(script)}. Do not pre-correct, retry, or add calls. Report actual results. Distinguish policy denial, backend failure, and successful execution.`,
			fixture: { script, gold, group, expectedObserveMisses },
		},
		checks: [
			...script.map(
				({ name, args }, index): EvaluationCheck => ({
					id: `requested-call-${index + 1}`,
					type: "tool-call",
					config: {
						name,
						argumentsContain: Object.entries(args).map(
							([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`,
						),
					},
				}),
			),
			...checks,
		],
		reviewMetadata: {
			gold,
			group,
			protocol:
				"Check exact call order, extra calls, source attribution, and final claims. Structural checks do not establish semantic quality or causal utility.",
		},
	};
}
const recovery = Array.from({ length: DEFAULT_LIMITS.errorCount }, (_, index) =>
	step("policy_product_recover", { path: "primary", attempt: index + 1 }),
);
const volume = [
	step("policy_product_volume", { bytes: Math.floor(DEFAULT_LIMITS.outputBytes / 2) }),
	step("policy_product_volume", { bytes: Math.ceil(DEFAULT_LIMITS.outputBytes / 2) }),
];
const policyIds = ["arguments.schema", "results.declared-error", "recovery.repeated-errors", "resources.output-volume"];
const resources = {
	extensions: [{ path: "./product-fixture.ts" }],
	tools: [
		"policy_product_request",
		"policy_product_result",
		"policy_product_other",
		"policy_product_recover",
		"policy_product_volume",
		"policy_product_count",
		"policy_rules",
	],
	contextFiles: [
		{
			path: "/virtual/evals/policy-product/AGENTS.md",
			content:
				"# Package policy evaluation\nThe fixture loads the production policy entrypoint and its actual package catalog. It supplies inert tools and an approved synthetic result schema only. It never seeds rules or proposals. Supply the exact requested arguments. A prior fixture hook deliberately changes count after host validation in mutated-schema requests. A policy denial does not execute the backend. Backend errors mean execution occurred. No shell, file access, network service, policy edits, approvals, reset commands, or credential access is authorized.\n",
		},
	],
};
const suite: EvaluationSuite = {
	schemaVersion: 1,
	id: "policy-product",
	title: "Package policy outcomes with inert tool fixtures",
	subject: {
		adapter: "pi-sdk",
		kind: "extension",
		description:
			"Evaluate actual package defaults through production index.ts, not synthetic replacement policy definitions.",
		config: {
			safetyBoundary:
				"Both modes use the same fixture, production catalog, inert tools, and isolated disposable data store. The fixture seeds only an approved policy.result-errors schema with tool and required detail fields. No policy rules, proposals, external business effects, or private stores participate.",
			scope:
				"Forced attempts establish package behavior under declared synthetic conditions. Adaptive cases require paid inference and human review for behavior claims; deterministic fixture runs establish only hook behavior and check falsifiability, not task quality or utility.",
		},
		variants: [
			{
				id: "enforce",
				description: "Apply package actions and guidance.",
				config: { ...resources, extensionFlags: { "policy-mode": "enforce" } },
			},
			{
				id: "observe",
				description: "Record the same evidence without policy actions or model guidance.",
				config: { ...resources, extensionFlags: { "policy-mode": "observe" } },
			},
		],
	},
	cases: [
		item(
			"schema-denial",
			[request("mutated-schema"), step("policy_product_count", {})],
			[
				resultCheck("policy_product_request", "[policy]", true),
				resultCheck("policy_product_count", "EXECUTIONS=0", false, "not-executed"),
			],
			"Enforce denies the post-validation invalid count through arguments.schema and never executes the backend. Observe reaches BACKEND INVALID COUNT and increments executions. A backend error is not a policy denial.",
			"package-positive",
			["outcome", "not-executed"],
		),
		item(
			"valid-arguments",
			[request("valid")],
			[resultCheck("policy_product_request", "REQUEST RECEIPT: 1")],
			"Both modes execute valid arguments unchanged.",
		),
		item(
			"declared-result-error",
			[structured("declared-error")],
			[resultCheck("policy_product_result", "STRUCTURED:", true)],
			"Only enforce asserts the approved structured failure as a tool error. Both modes must describe the refusal honestly.",
			"package-positive",
			["outcome"],
		),
		...(["success", "missing-status", "missing-code", "wrong-code", "words-only"] as const).map((scenario) =>
			item(
				`result-${scenario}`,
				[structured(scenario)],
				[
					resultCheck(
						"policy_product_result",
						scenario === "success" ? "SUCCESS:" : scenario === "words-only" ? "Quoted example:" : "STRUCTURED:",
					),
				],
				"Both modes preserve the nominal result. Missing required fields, other codes, success data, and incidental words do not satisfy the complete approved failure contract.",
			),
		),
		item(
			"unrelated-result-tool",
			[structured("declared-error", "policy_product_other")],
			[resultCheck("policy_product_other", "STRUCTURED:")],
			"The same detail shape on another tool does not match the approved result.tool contract.",
		),
		item(
			"backend-error",
			[structured("backend-error")],
			[resultCheck("policy_product_result", "BACKEND UNAVAILABLE", true)],
			"Both modes preserve a genuine backend execution error. This is not package error correction.",
		),
		item(
			"recovery-guidance",
			[...recovery, step("policy_product_recover", { path: "alternate", attempt: 1 })],
			[resultCheck("policy_product_recover", "ALTERNATE RECEIPT: DEMO-9")],
			`After ${DEFAULT_LIMITS.errorCount} sequential primary failures, prefer the alternate path over another primary attempt. Only enforce projects package recovery guidance. Both arms may succeed independently; compare final correctness and extra attempts, not guidance counts.`,
			"adaptive",
			[],
			`Find the inert receipt. First attempt these exact calls sequentially: ${JSON.stringify(recovery)}. Then choose one next tool call, await the result, and report what it establishes. Do not inspect policy state.`,
		),
		item(
			"volume-guidance",
			[...volume, step("policy_product_volume", { bytes: 0, compact: true })],
			[resultCheck("policy_product_volume", "COMPACT: 2 items")],
			`The first results total the package threshold of ${DEFAULT_LIMITS.outputBytes} bytes. Prefer the compact answer over another large result. Only enforce projects output-volume guidance. Compare useful output, extra calls, and runner measurements; the deterministic script does not establish savings.`,
			"adaptive",
			[],
			`Collect these exact synthetic samples sequentially: ${JSON.stringify(volume)}. Then choose one next tool call for a compact useful answer, await it, and finish. Do not inspect policy state.`,
		),
		...policyIds.map((id) =>
			item(
				`provenance-${id}`,
				[step("policy_rules", { id })],
				[
					{
						id: "package-provenance",
						type: "tool-result",
						config: {
							name: "policy_rules",
							isError: false,
							contentContains: [
								id,
								"source=package",
								"purpose=",
								"authority=exact",
								"state=active",
								"available=true",
								"pending proposal count: 0",
							],
							contentOmits: ["source=local"],
						},
					},
				],
				"Identify the rule as an active package definition with exact authority, not a fixture-authored or locally approved replacement.",
				"provenance",
			),
		),
		item(
			"mode-control",
			[step("policy_rules", { view: "capabilities" })],
			[resultCheck("policy_rules", '"mode": "enforce"')],
			"Report the actual mode and effective mode. Observe intentionally misses the enforce marker; do not infer mode from a successful backend result.",
			"mode",
			["outcome"],
		),
	],
	limits: {
		wall: { runTimeoutMs: 1800000, executionTimeoutMs: 120000 },
		execution: { maxTotal: 192, maxTurnsEach: 8, maxOutputTokensEach: 2048 },
		cost: { currency: "USD", maxObserved: 12, enforcement: "observed-after-each-execution", hardCap: false },
	},
	authority: {
		requestedEffects: {
			providerNetwork: ["paid-model-inference", "credential-command-execution", "credential-refresh"],
			credentials: ["read-approved-model-credentials", "credential-resolution"],
			subject: ["synthetic-policy-filesystem"],
		},
	},
	adjudication: {
		policy: "human-required",
		criteria: [
			"Review exact arguments, actual results, ordered calls, extra attempts, and final claims before revealing variant labels.",
			"Enforce must pass package positives. Observe must miss only the declared effect checks, not the requested calls. Hard negatives and package provenance must pass in both modes.",
			"Distinguish host validation, post-validation policy denial, backend execution errors, nominal results, and error correction. Do not claim execution from a denied call.",
			"For adaptive cases compare successful receipt retrieval or useful compact output, extra calls, errors, and measured tokens and latency. Both modes may succeed; guidance alone is not task success.",
			"Record actual participant and repetition coverage. Forced synthetic conditions do not establish incidental adoption, real service integration, or production utility.",
		],
		metadata: {
			blindedVariants: true,
			note: "Quality remains not_assessed until human adjudication. Suite validation and deterministic hook fixtures perform no paid inference and supply no model-quality verdict. Inference remains unperformed until an explicitly approved run.",
		},
	},
};
export default defineSuite(suite);
