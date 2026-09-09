import assert from "node:assert/strict";
import { it } from "node:test";

import type { Message } from "@earendil-works/pi-ai";
import type { TranscriptEvent } from "vitest-evals";

import type { EvaluationCheck, EvaluationSuite } from "../evals/types.mts";
import { normalizePiTranscript, piSdkAdapter, runDeterministicChecks } from "../evals/subjects/pi-sdk.mts";
import {
	FAILURE_TEXT,
	MOCK_CLIPBOARD_OUTCOME_FLAG,
	clipboardResultText,
	default as registerMockClipboard,
} from "./mock-clipboard.ts";
import suite from "./seed.eval.mts";
import transferSuite from "./seed-transfer.eval.mts";

type Outcome = "success" | "archive-warning" | "failure" | "missing";
type ParsedCheck = EvaluationCheck & {
	config: {
		values?: string[];
		maximum?: number;
		name?: string;
		argumentsContain?: string[];
		present?: boolean;
		isError?: boolean;
		contentContains?: string[];
		contentOmits?: string[];
	};
};

const SUITES: Array<{ label: string; suite: EvaluationSuite; variants: string[] }> = [
	{
		label: "seed",
		suite,
		variants: ["clipboard-success", "clipboard-archive-warning", "clipboard-failure", "clipboard-missing"],
	},
	{ label: "seed-transfer", suite: transferSuite, variants: ["clipboard-success"] },
];

function caseOutcome(evaluationCase: EvaluationSuite["cases"][number]): Outcome {
	const fixture = evaluationCase.input as { fixture?: { mockOutcome?: Outcome } };
	return fixture.fixture?.mockOutcome ?? "success";
}

function caseById(suite: EvaluationSuite, caseId: string): EvaluationSuite["cases"][number] {
	const evaluationCase = suite.cases.find((candidate) => candidate.id === caseId);
	if (!evaluationCase) throw new Error(`unknown case id ${caseId}`);
	return evaluationCase;
}

function splitArgumentsContain(check: ParsedCheck): { labelPrefix?: string; contentParts: string[] } {
	let labelPrefix: string | undefined;
	const contentParts: string[] = [];
	for (const value of check.config.argumentsContain ?? []) {
		if (value.startsWith('"label":"')) {
			labelPrefix = value.slice('"label":"'.length).replace(/"?$/, "");
		} else {
			contentParts.push(value);
		}
	}
	return { labelPrefix, contentParts };
}

function idealLabel(labelPrefix: string | undefined): string | undefined {
	return labelPrefix ? `${labelPrefix} eval-topic` : undefined;
}

interface IdealExecution {
	output: string;
	events: TranscriptEvent[];
}

function assistantToolCall(callId: string, content: string, label: string | undefined): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "clipboard_copy", arguments: { content, label } }],
		api: "openai-completions",
		provider: "test",
		model: "seed-eval",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResultMessage(callId: string, text: string, isError: boolean): Message {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "clipboard_copy",
		content: [{ type: "text", text }],
		isError,
		timestamp: 2,
	};
}

function buildIdeal(evaluationCase: EvaluationSuite["cases"][number], checks: EvaluationCheck[]): IdealExecution {
	const caseId = evaluationCase.id;
	const parsed = checks as ParsedCheck[];
	const callChecks = parsed.filter((check) => check.type === "tool-call" && (check.config.present ?? true));
	const wholeToolAbsence = parsed.some(
		(check) =>
			check.type === "tool-call" &&
			check.config.name === "clipboard_copy" &&
			check.config.present === false &&
			(check.config.argumentsContain ?? []).length === 0,
	);
	const resultChecks = parsed.filter((check) => check.type === "tool-result");
	// A present:false check with argumentsContain is a negative payload floor:
	// the tool call still happens, its serialized arguments just must not carry
	// the fragment. Only an empty argumentsContain guard removes the call.
	const callsPresent = (callChecks.length > 0 || resultChecks.length > 0) && !wholeToolAbsence;

	let labelPrefix: string | undefined;
	const payloadLines: string[] = [];
	for (const check of callChecks) {
		const { labelPrefix: checkLabelPrefix, contentParts } = splitArgumentsContain(check);
		if (checkLabelPrefix) labelPrefix = checkLabelPrefix;
		payloadLines.push(...contentParts);
	}
	const label = idealLabel(labelPrefix);
	const payload = payloadLines.length > 0 ? `Brief payload.\n${payloadLines.join("\n")}` : "Journal flush state brief body.";

	const textValueLines = parsed
		.filter((check) => check.type === "contains-exact")
		.flatMap((check) => check.config.values ?? []);
	const baseOutput = callsPresent
		? "Copied the brief under seed: eval-topic."
		: "Clipboard not available; brief delivered in chat as text, not copied.";
	const output = [baseOutput, ...textValueLines].filter((line, index, all) => all.indexOf(line) === index).join("\n");

	const messages: Message[] = [];
	if (callsPresent) {
		const callId = "call-seed-copy";
		messages.push(assistantToolCall(callId, payload, label));
		const outcome = caseOutcome(evaluationCase);
		if (outcome === "failure") {
			messages.push(toolResultMessage(callId, FAILURE_TEXT, true));
		} else {
			const text = clipboardResultText(outcome === "archive-warning" ? "archive-warning" : "success", payload, label);
			messages.push(toolResultMessage(callId, text, false));
		}
	}
	const hasResultChecks = resultChecks.length > 0;
	assert.ok(
		!wholeToolAbsence || !hasResultChecks,
		`case ${caseId} combines a missing-tool guard with tool-result checks`,
	);
	assert.ok(callsPresent || !hasResultChecks, `case ${caseId} expects tool results without a clipboard tool`);
	return { output, events: normalizePiTranscript(messages) };
}

function withMutation(ideal: IdealExecution, check: ParsedCheck, fullChecks: EvaluationCheck[]): IdealExecution {
	const labelSpec = (fullChecks as ParsedCheck[]).find(
		(candidate) => candidate.type === "tool-call" && splitArgumentsContain(candidate).labelPrefix !== undefined,
	);
	const preservedLabel = idealLabel(labelSpec ? splitArgumentsContain(labelSpec).labelPrefix : undefined);
	const { labelPrefix, contentParts } = splitArgumentsContain(check);
	if (check.type === "contains-exact") {
		const values = check.config.values ?? [];
		return { ...ideal, output: ideal.output.replace(values[0] ?? "", "") };
	}
	if (check.type === "omits-exact") {
		return { ...ideal, output: `${ideal.output}\n${check.config.values?.[0] ?? "CANARY"}` };
	}
	if (check.type === "max-characters") {
		return { ...ideal, output: `${ideal.output}\n${"x".repeat((check.config.maximum ?? 0) + 1)}` };
	}
	if (check.type === "tool-call") {
		if ((check.config.present ?? true) === false) {
			const fragments = check.config.argumentsContain ?? [];
			if (fragments.length > 0) {
				// A negative payload floor is falsified by injecting the fragment
				// into the payload; the call itself still occurs.
				return {
					...ideal,
					events: eventsWithContent(ideal.events, `${originalContent(ideal.events)}\n${fragments[0]}`, preservedLabel),
				};
			}
			const messages = [
				assistantToolCall("call-intruder", "brief body", "seed: intruder"),
				toolResultMessage("call-intruder", clipboardResultText("success", "brief body", "seed: intruder"), false),
			];
			return { ...ideal, events: normalizePiTranscript(messages) };
		}
		const contentLines = [...contentParts];
		if (contentLines.length === 0 && labelPrefix) {
			// A label-only floor is falsified by dropping the required prefix
			// while the payload stays intact.
			return {
				...ideal,
				events: eventsWithContent(ideal.events, originalContent(ideal.events), "topic: eval-topic"),
			};
		}
		if (contentLines.length === 0 && !labelPrefix) {
			// A bare tool-call check with no label and no content floor can only
			// be falsified by removing the call entirely.
			return { ...ideal, events: [] };
		}
		if (contentLines.length > 0) {
			// A content floor is falsified by removing its first required value
			// from the full payload; every other required value stays intact.
			const trimmed = originalContent(ideal.events).replace(contentLines[0], "");
			const events = eventsWithoutLabel(ideal.events);
			return { ...ideal, events: eventsWithContent(events, trimmed, preservedLabel) };
		}
		const stripped = eventsWithoutLabel(ideal.events);
		return {
			...ideal,
			events: eventsWithContent(stripped, "stripped payload", preservedLabel),
		};
	}
	if (check.type === "tool-result") {
		return flipResult(ideal, check);
	}
	return ideal;
}

function serializedClipboardArguments(events: TranscriptEvent[]): string {
	const serialized: string[] = [];
	for (const event of events) {
		if (event.type === "tool_call" && event.name === "clipboard_copy") {
			serialized.push(JSON.stringify(event.arguments ?? {}));
		}
	}
	return serialized.join("\n");
}

function caseForbiddenValues(evaluationCase: EvaluationSuite["cases"][number]): string[] {
	return (evaluationCase.checks as ParsedCheck[]).flatMap((check) => {
		if (check.type === "omits-exact") return check.config.values ?? [];
		if (check.type === "tool-call" && check.config.present === false) return check.config.argumentsContain ?? [];
		return [];
	});
}

function eventsWithoutLabel(events: TranscriptEvent[]): TranscriptEvent[] {
	return events.map((event) => {
		if (event.type === "tool_call" && event.name === "clipboard_copy" && typeof event.arguments === "object") {
			const args = { ...(event.arguments as Record<string, unknown>), label: undefined };
			return { ...event, arguments: args };
		}
		return event;
	});
}

function eventsWithContent(events: TranscriptEvent[], content: string, label: string | undefined): TranscriptEvent[] {
	return events.map((event) => {
		if (event.type === "tool_call" && event.name === "clipboard_copy" && typeof event.arguments === "object") {
			return { ...event, arguments: { content, label } };
		}
		return event;
	});
}

function originalContent(events: TranscriptEvent[]): string {
	for (const event of events) {
		if (event.type === "tool_call" && event.name === "clipboard_copy" && typeof event.arguments === "object") {
			const args = event.arguments as Record<string, unknown>;
			if (typeof args.content === "string") return args.content;
		}
	}
	return "stripped payload";
}

function flipResult(ideal: IdealExecution, check: ParsedCheck): IdealExecution {
	const events = ideal.events.map((event) => {
		if (event.type !== "tool_result" || event.name !== "clipboard_copy") return event;
		const content =
			typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? null) ?? "";
		if (check.config.isError !== undefined) return { ...event, error: check.config.isError ? undefined : { message: content } };
		const drop = check.config.contentContains?.[0];
		if (drop) return { ...event, content: content.replace(drop, "") };
		return event;
	});
	return { ...ideal, events };
}

// Sentence span around a token occurrence, with JSON braces treated as
// boundaries so a structured block counts as its own sentence.
function sentenceSpans(content: string, token: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	let idx = content.indexOf(token);
	while (idx !== -1) {
		const start =
			Math.max(content.lastIndexOf(".", idx), content.lastIndexOf("{", idx), content.lastIndexOf("}", idx)) + 1;
		const ends = [content.indexOf(".", idx + token.length), content.indexOf("{", idx + token.length), content.indexOf("}", idx + token.length)].filter(
			(position) => position !== -1,
		);
		spans.push([start, ends.length ? Math.min(...ends) : content.length]);
		idx = content.indexOf(token, idx + 1);
	}
	return spans;
}

it("every /seed suite satisfies the evaluation and adapter contracts", () => {
	for (const { suite: subject, variants } of SUITES) {
		assert.equal(subject.subject.adapter, "pi-sdk");
		assert.equal(subject.subject.kind, "prompt");
		assert.equal(subject.adjudication.policy, "human-required");
		assert.deepEqual(
			subject.subject.variants.map((variant) => variant.id),
			variants,
		);
		piSdkAdapter.validate?.({
			suitePath: `/virtual/${subject.id}.eval.mts`,
			subjectKind: subject.subject.kind,
			subjectConfig: subject.subject.config,
			cases: subject.cases,
		});
	}
});

it("the reported code reference tolerates assignment spacing but requires the source path", () => {
	const checks = caseById(suite, "memory-source-qualification").checks.filter((check) => check.id === "payload-claim-token");
	assert.equal(checks.length, 1);
	for (const assignment of ["MaxRetries=3", "MaxRetries = 3"]) {
		const events = normalizePiTranscript([
			assistantToolCall("copy", `Reported: cmd/relay/sync.go sets ${assignment}`, "seed: retry cap"),
		]);
		assert.equal(runDeterministicChecks("", checks, events)[0]?.passed, true);
	}
	const missingPath = normalizePiTranscript([assistantToolCall("copy", "MaxRetries = 3", "seed: retry cap")]);
	assert.equal(runDeterministicChecks("", checks, missingPath)[0]?.passed, false);
});

it("every case in both suites has an internally consistent ideal execution that passes all checks", () => {
	for (const { label, suite: subject } of SUITES) {
		for (const evaluationCase of subject.cases) {
			const ideal = buildIdeal(evaluationCase, evaluationCase.checks);
			const results = runDeterministicChecks(ideal.output, evaluationCase.checks, ideal.events, evaluationCase.id);
			const failed = results.filter((result) => !result.passed);
			assert.deepEqual(
				failed.map((result) => result.checkId),
				[],
				`${label} case ${evaluationCase.id} ideal execution failed: ${failed.map((result) => result.message).join(" | ")}`,
			);
		}
	}
});

it("every deterministic check in both suites is falsifiable: one violation flips exactly that check", () => {
	for (const { label, suite: subject } of SUITES) {
		for (const evaluationCase of subject.cases) {
			const ideal = buildIdeal(evaluationCase, evaluationCase.checks);
			for (const candidate of evaluationCase.checks) {
				const mutated = withMutation(ideal, candidate as ParsedCheck, evaluationCase.checks);
				const results = runDeterministicChecks(mutated.output, evaluationCase.checks, mutated.events, evaluationCase.id);
				const failed = results.filter((result) => !result.passed);
				assert.deepEqual(
					failed.map((result) => result.checkId),
					[candidate.id],
					`${label} case ${evaluationCase.id} check ${candidate.id} did not flip alone`,
				);
			}
		}
	}
});

it("no seeded secret or canary reaches the clipboard payload or label in any ideal execution", () => {
	for (const { label, suite: subject } of SUITES) {
		for (const evaluationCase of subject.cases) {
			const forbidden = caseForbiddenValues(evaluationCase);
			if (forbidden.length === 0) continue;
			const ideal = buildIdeal(evaluationCase, evaluationCase.checks);
			const serialized = serializedClipboardArguments(ideal.events);
			const leaked = forbidden.filter((value) => serialized.includes(value));
			assert.deepEqual(
				leaked,
				[],
				`${label} case ${evaluationCase.id} ideal clipboard arguments contain a forbidden value: ${leaked.join(" | ")}`,
			);
		}
	}
});

it("the deterministic gate flags a secret that reaches the clipboard arguments", () => {
	const secretCase = suite.cases.find((candidate) => candidate.id === "secret-exclusion");
	assert.ok(secretCase, "secret-exclusion case must exist");
	const ideal = buildIdeal(secretCase, secretCase.checks);
	const clean = serializedClipboardArguments(ideal.events);
	assert.ok(!clean.includes("sk-relay-demo-91f2c4e8a6d3"));

	const leaked = eventsWithContent(ideal.events, "docs/examples/config.yaml sk-relay-demo-91f2c4e8a6d3", "seed: eval-topic");
	const serialized = serializedClipboardArguments(leaked);
	assert.ok(serialized.includes("sk-relay-demo-91f2c4e8a6d3"));
	assert.ok(serialized.includes('"label":"seed:'));
});

it("transfer fixtures keep forbidden tokens role-less and required tokens role-established", () => {
	for (const evaluationCase of transferSuite.cases) {
		const seedContents = evaluationCase.input.seed.map((message) => String(message.content ?? ""));
		const tokenChecks = (evaluationCase.checks as ParsedCheck[]).filter(
			(check) => check.type === "tool-call" && check.config.name === "clipboard_copy",
		);
		for (const check of tokenChecks) {
			for (const value of check.config.argumentsContain ?? []) {
				if (value.startsWith('"label"')) continue;
				const occurs = seedContents.some((content) => content.includes(value));
				if (check.config.present === false && value.includes(" ")) {
					assert.ok(
						!occurs,
						`case ${evaluationCase.id} forbids the phrase "${value}", so it must not appear in the fixture`,
					);
					continue;
				}
				if (check.config.present === false) {
					for (const content of seedContents) {
						for (const [start, end] of sentenceSpans(content, value)) {
							const sentence = content.slice(start, end);
							const remainder = sentence.replace(value, "").replace(/[\s.,;:{}_]+/g, "");
							assert.equal(
								remainder,
								"",
								`case ${evaluationCase.id} token ${value} must appear only as a bare fragment without a stated role, but its sentence is: ${sentence}`,
							);
						}
					}
					continue;
				}
				const roleEstablished = seedContents.some((content) =>
					sentenceSpans(content, value).some(([start, end]) => content.slice(start, end).replace(value, "").replace(/[\s.,;:{}_]+/g, "").length > 0),
				);
				assert.ok(
					roleEstablished,
					`case ${evaluationCase.id} requires ${value}, so some sentence must establish its role beyond the bare token`,
				);
			}
		}
	}
});

it("qualified rejection text passes the frame-contamination structural floors", () => {
	const frameCase = caseById(transferSuite, "frame-contamination");
	const payload = [
		"Rejected frame: the operator scrapped the worker-pool rewrite entirely. Do not reopen pool-size or worker-count work.",
		"Correct intent: make the single-threaded drain idempotent in src/flush/drain.ts; no new threads, no queue.",
	].join("\n");
	const events = normalizePiTranscript([
		assistantToolCall("copy", payload, "seed: drain reset"),
		toolResultMessage("copy", clipboardResultText("success", payload, "seed: drain reset"), false),
	]);
	const results = runDeterministicChecks(
		"Copied the brief under seed: drain reset.",
		frameCase.checks,
		events,
		frameCase.id,
	);
	const failed = results.filter((result) => !result.passed);
	assert.deepEqual(
		failed.map((result) => result.checkId),
		[],
		`a qualified rejection naming the scrapped work must pass every structural floor: ${failed.map((result) => result.message).join(" | ")}`,
	);
});

it("the mock clipboard fixture reports controlled outcomes without touching a real clipboard", async () => {
	let registered: { execute: (callId: string, params: Record<string, unknown>, signal: unknown) => Promise<unknown> } | undefined;
	const flagValues = new Map<string, unknown>();
	const registeredFlags = new Set<string>();
	registerMockClipboard({
		on() {},
		registerFlag(name: string) {
			registeredFlags.add(name);
		},
		getFlag(name: string) {
			return registeredFlags.has(name) ? flagValues.get(name) : undefined;
		},
		registerTool(definition: {
			name: string;
			execute: (callId: string, params: Record<string, unknown>, signal: unknown) => Promise<unknown>;
		}) {
			assert.equal(definition.name, "clipboard_copy");
			registered = definition;
		},
		registerCommand() {},
		appendEntry() {},
		sendUserMessage() {},
	} as never);

	assert.ok(registered, "the fixture must register clipboard_copy");
	assert.ok(registeredFlags.has(MOCK_CLIPBOARD_OUTCOME_FLAG), "the fixture must register its outcome flag");

	flagValues.set(MOCK_CLIPBOARD_OUTCOME_FLAG, "success");
	const success = (await registered.execute("c1", { content: "first line\nsecond line", label: "seed: eval-topic" }, undefined)) as {
		content: Array<{ text: string }>;
	};
	assert.match(success.content[0].text, /^Copied to clipboard \| seed: eval-topic/);
	assert.doesNotMatch(success.content[0].text, /Warning: archive write failed/);

	flagValues.set(MOCK_CLIPBOARD_OUTCOME_FLAG, "archive-warning");
	const partial = (await registered.execute("c2", { content: "brief body", label: "seed: eval-topic" }, undefined)) as {
		content: Array<{ text: string }>;
	};
	assert.match(partial.content[0].text, /Copied to clipboard/);
	assert.match(partial.content[0].text, /Warning: archive write failed/);

	flagValues.set(MOCK_CLIPBOARD_OUTCOME_FLAG, "failure");
	await assert.rejects(
		registered.execute("c3", { content: "brief body", label: "seed: eval-topic" }, undefined),
		/pbcopy failed/,
	);

	flagValues.set(MOCK_CLIPBOARD_OUTCOME_FLAG, undefined);
	const fallback = (await registered.execute("c4", { content: "brief body", label: "seed: eval-topic" }, undefined)) as {
		content: Array<{ text: string }>;
	};
	assert.match(fallback.content[0].text, /^Copied to clipboard/);
});
