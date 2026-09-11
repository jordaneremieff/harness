import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { piSdkAdapter, runDeterministicChecks } from "../../evals/subjects/pi-sdk.mts";
import suite from "./reader-comprehension.eval.mts";

const suitePath = fileURLToPath(new URL("./reader-comprehension.eval.mts", import.meta.url));
const variant = suite.subject.variants[0];
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const resolve = (candidate = variant) =>
	piSdkAdapter.resolve({
		suitePath,
		subjectKind: suite.subject.kind,
		subjectConfig: suite.subject.config,
		variant: candidate,
	});
const getCase = (id: string) => {
	const item = suite.cases.find((candidate) => candidate.id === id);
	assert.ok(item, id);
	return item;
};
const check = (id: string, output: string, events: Parameters<typeof runDeterministicChecks>[2] = []) => {
	const item = getCase(id);
	return runDeterministicChecks(output, item.checks, events, item.id);
};

// The application retains fixture review data separately from seed messages and prompts.
test("the text suite validates without a runtime and reserves semantic judgment for a human", () => {
	piSdkAdapter.validate!({
		suitePath,
		subjectKind: suite.subject.kind,
		subjectConfig: suite.subject.config,
		cases: suite.cases,
	});
	assert.ok(resolve());
	assert.equal(suite.subject.kind, "ad-hoc");
	assert.equal(suite.adjudication.policy, "human-required");
	assert.deepEqual(variant.config.tools, []);
	assert.deepEqual(Object.keys(variant.config).sort(), ["contextFiles", "tools"]);
	assert.equal(suite.cases.length, new Set(suite.cases.map(({ id }) => id)).size);
	const suppliedContext = JSON.stringify(variant.config.contextFiles);
	for (const item of suite.cases) {
		assert.ok(item.input.fixture.gold);
		assert.ok(item.input.fixture.semanticLedger.length > 0);
		const subjectText = JSON.stringify({ context: suppliedContext, seed: item.input.seed, prompt: item.input.prompt });
		assert.ok(!subjectText.includes(item.input.fixture.gold), item.id);
		assert.ok(!item.input.prompt.startsWith("/pillars"), item.id);
		assert.deepEqual(
			item.checks.filter(({ type }) => type === "tool-call").map(({ config }) => config),
			["write", "edit", "bash"].map((name) => ({ name, present: false })),
		);
		const lexical = item.checks.filter(({ type }) => type !== "tool-call" && type !== "max-characters");
		const lengthChecks = item.checks.filter(({ type }) => type === "max-characters");
		assert.deepEqual(
			lengthChecks,
			["requested-raw-output", "requested-machine-output"].includes(item.id)
				? [
						{
							id: "exact-output-length",
							type: "max-characters",
							config: { maximum: item.input.fixture.protectedExactSpans[0].length },
						},
					]
				: [],
		);
		assert.deepEqual(
			lexical,
			item.input.fixture.protectedExactSpans.length
				? [
						{
							id: "protected-spans",
							type: "contains-exact",
							config: { values: item.input.fixture.protectedExactSpans },
						},
					]
				: [],
		);
	}
});

test("the source envelope contains complete current bodies and resolution binds each body", async () => {
	const expectedPaths = [
		"pillars/README.md",
		"pillars/GOVERNANCE.md",
		"pillars/principle-unearned-prose.md",
		"pillars/heuristic-tell-laundering.md",
	];
	assert.deepEqual(suite.subject.config.doctrineSources, expectedPaths);
	assert.deepEqual(
		variant.config.contextFiles.slice(1).map(({ path }) => path),
		expectedPaths,
	);
	const resolution = resolve() as {
		resources: Array<{ type: string; name?: string; source: string; digest: string }>;
	};
	const contexts = resolution.resources.filter(({ type }) => type === "context");
	assert.equal(contexts.length, variant.config.contextFiles.length);
	for (const path of expectedPaths) {
		const body = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
		const supplied = variant.config.contextFiles.find((context) => context.path === path);
		assert.equal(supplied?.content, body, path);
		assert.deepEqual(
			contexts.find((resource) => resource.name === path),
			{
				type: "context",
				name: path,
				source: "inline",
				digest: hash(body),
			},
		);
		const changed = structuredClone(variant);
		const target = changed.config.contextFiles.find((context) => context.path === path)!;
		target.content += "\nA changed body requires a different source digest.\n";
		assert.notDeepEqual(resolve(changed), resolution, path);
	}
	assert.ok(
		variant.config.contextFiles
			.find(({ path }) => path === "pillars/principle-unearned-prose.md")
			?.content.includes("### Reader comprehension"),
	);
});

test("each prose task has a distinct case and only requested literal artifacts receive lexical floors", () => {
	assert.deepEqual(
		suite.cases.map(({ id }) => id),
		[
			"self-contained-explanation",
			"necessary-technical-term",
			"expand-compressed-repair",
			"preserve-supported-repair",
			"repair-recalibrated-claim",
			"requested-neutral-analysis",
			"exact-quote-with-explanation",
			"requested-raw-output",
			"requested-machine-output",
			"insufficient-evidence",
		],
	);
	assert.deepEqual(
		suite.cases.filter(({ input }) => input.fixture.protectedExactSpans.length > 0).map(({ id }) => id),
		["exact-quote-with-explanation", "requested-raw-output", "requested-machine-output"],
	);
	for (const id of ["expand-compressed-repair", "preserve-supported-repair", "repair-recalibrated-claim"]) {
		assert.ok(getCase(id).input.seed.some(({ role }) => role === "assistant"));
	}
	assert.deepEqual(getCase("insufficient-evidence").input.seed, []);
});

test("exact-span floors reject malformed, missing, and paraphrased artifacts", () => {
	const fixtures = [
		{
			id: "exact-quote-with-explanation",
			exact: "lease=expired; writer=unknown",
			invalid: ["The lease expired and the writer is unknown.", "lease=expired; writer=stopped"],
		},
		{
			id: "requested-raw-output",
			exact: "probe=cedar-7\nresult=not_observed\nreason=window_closed",
			invalid: [
				"probe=cedar-7\nresult=not_observed",
				"probe=cedar-7\nreason=window_closed\nresult=not_observed",
				"probe=cedar-7\nresult=failed\nreason=window_closed",
			],
		},
		{
			id: "requested-machine-output",
			exact: '{"job":"sample-42","observed":false,"reason":null}',
			invalid: [
				'{"job":"sample-42","observed":false,"reason":null',
				'{"job":"sample-42","observed":false,"reason":"unknown"}',
				'{"job":"sample-42", "observed":false, "reason":null}',
			],
		},
	];
	for (const { id, exact, invalid } of fixtures) {
		assert.ok(
			check(id, exact).every(({ passed }) => passed),
			id,
		);
		for (const output of ["", ...invalid]) {
			assert.equal(check(id, output).find(({ checkId }) => checkId === "protected-spans")?.passed, false, id);
		}
	}
});

test("complete literal floors reject all extra characters as well as mutations", () => {
	for (const id of ["requested-raw-output", "requested-machine-output"]) {
		const exact = getCase(id).input.fixture.protectedExactSpans[0];
		assert.ok(
			check(id, exact).every(({ passed }) => passed),
			id,
		);
		for (const output of [
			` ${exact}`,
			`${exact} `,
			`\n${exact}`,
			`${exact}\n`,
			`Here is the output:\n${exact}`,
			`${exact}\nThe artifact is unchanged.`,
			`\`\`\`\n${exact}\n\`\`\``,
			`${exact}${exact}`,
			`${exact}\n${exact}`,
		]) {
			const results = check(id, output);
			assert.equal(results.find(({ checkId }) => checkId === "protected-spans")?.passed, true, id);
			assert.equal(results.find(({ checkId }) => checkId === "exact-output-length")?.passed, false, id);
		}
		for (const output of ["", exact.slice(1), `!${exact.slice(1)}`]) {
			const results = check(id, output);
			assert.equal(results.find(({ checkId }) => checkId === "protected-spans")?.passed, false, id);
			assert.equal(results.find(({ checkId }) => checkId === "exact-output-length")?.passed, true, id);
		}
	}
});

test("alternative legitimate explanations pass without fixed synonyms, headings, or length scores", () => {
	const alternatives: Array<{ id: string; outputs: string[] }> = [
		{
			id: "exact-quote-with-explanation",
			outputs: [
				'"lease=expired; writer=unknown" means that time-limited write permission expired. The line does not identify the writer or establish a stopped process or changed data.',
				'A lease gives permission to write for a limited time. The diagnostic "lease=expired; writer=unknown" reports that the time expired and the writer is unidentified. It says nothing about whether a process stopped or data changed.',
			],
		},
		{
			id: "expand-compressed-repair",
			outputs: [
				"The replacement search index finished its build. Searches still use the old index. Run the comparison check before you switch searches to the replacement.",
				"Searches do not use the replacement index yet, although its build is complete. You must compare it with the old index before you make it active; the build does not switch indexes automatically.",
			],
		},
		{
			id: "requested-neutral-analysis",
			outputs: [
				"Mode A sends each reading immediately with one request per reading. Mode B waits for the next five-minute batch and uses fewer requests. The team's priority between delay and request volume is unknown.",
				"| Mode | Delivery | Requests |\n| A | Immediate | One per reading |\n| B | Next five-minute batch | Fewer at the same reading rate |\nThe team has not stated which tradeoff it prefers.",
			],
		},
		{
			id: "insufficient-evidence",
			outputs: [
				"The report and validation output are absent, so I cannot identify the cause or justify a setting change. Please supply the validation error and relevant configuration.",
				"Please share the report's validation failure and the configuration it refers to. Without those facts, a cause or setting recommendation would be a guess.",
			],
		},
	];
	for (const { id, outputs } of alternatives) {
		for (const output of outputs)
			assert.ok(
				check(id, output).every(({ passed }) => passed),
				id,
			);
	}
});

test("mutation transcript floors reject attempted calls without grading the answer", () => {
	for (const item of suite.cases) {
		const output = item.input.fixture.protectedExactSpans.join("\n");
		for (const name of ["write", "edit", "bash"]) {
			const events = [{ type: "tool_call" as const, id: "attempt", name, arguments: {} }];
			assert.equal(check(item.id, output, events).find(({ checkId }) => checkId === `no-${name}`)?.passed, false);
		}
	}
});

test("narrow floors deliberately leave prose meaning to human review", () => {
	// A semantic failure is not converted into an invented lexical quality score.
	assert.ok(check("preserve-supported-repair", "Everything is safe. Ship it.").every(({ passed }) => passed));
	assert.ok(check("insufficient-evidence", "").every(({ passed }) => passed));
	assert.ok(
		check("exact-quote-with-explanation", "lease=expired; writer=unknown proves the writer stopped.").every(
			({ passed }) => passed,
		),
	);
	assert.equal(suite.adjudication.policy, "human-required");
});
