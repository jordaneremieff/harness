import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Message, Model } from "@earendil-works/pi-ai";
import type { TranscriptEvent } from "vitest-evals";
import type { EvaluationCase } from "../types.mts";
import {
	isAssistantFailureStopReason,
	limitModelOutput,
	normalizePiTranscript,
	parseExtensionFlagValues,
	piSdkAdapter,
	runDeterministicChecks,
	scorePostSeedPiTranscript,
	summarizeUsage,
} from "./pi-sdk.mts";

const participant = { id: "test/model:off", provider: "test", model: "model", thinking: "off" as const };
const usage = {
	input: 10,
	output: 4,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 17,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.01, total: 0.32 },
};

function inferenceModel(maxTokens: number): Model<"openai-completions"> {
	return {
		id: "model",
		name: "Model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://provider.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens,
	};
}

function assistantMessage(
	content: Extract<Message, { role: "assistant" }>["content"],
	timestamp: number,
	responseModel?: string,
): Extract<Message, { role: "assistant" }> {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "model",
		...(responseModel ? { responseModel } : {}),
		usage,
		stopReason: "stop",
		timestamp,
	};
}

const toolEvents: TranscriptEvent[] = [
	{
		type: "tool_call",
		id: "call-read",
		name: "read",
		arguments: { path: "docs/input.md", mode: "exact" },
	},
	{
		type: "tool_result",
		toolCallId: "call-read",
		name: "reported-as-another-tool",
		content: "Blocked by policy; request was not allowed.",
		error: { message: "Blocked by policy" },
	},
	{
		type: "tool_call",
		id: "call-write",
		name: "write",
		arguments: { path: "out.txt", content: "safe" },
	},
	{
		type: "tool_result",
		toolCallId: "call-write",
		name: "write",
		content: "Wrote safe output.",
	},
];

describe("Pi session plan fidelity", () => {
	it("caps a copied inference model at the execution output ceiling", () => {
		const resolved = inferenceModel(4_096);
		const limited = limitModelOutput(resolved, 1_024);
		assert.notEqual(limited, resolved);
		assert.equal(limited.maxTokens, 1_024);
		assert.equal(resolved.maxTokens, 4_096);
		assert.equal(limited.cost, resolved.cost);
	});

	it("preserves a model's lower output ceiling without mutating it", () => {
		const resolved = inferenceModel(512);
		const limited = limitModelOutput(resolved, 1_024);
		assert.equal(limited.maxTokens, 512);
		assert.equal(resolved.maxTokens, 512);
		assert.notEqual(limited, resolved);
	});

	it("treats a length stop as an assistant failure", () => {
		assert.equal(isAssistantFailureStopReason("length"), true);
	});

	it("preserves existing stop failure and success classifications", () => {
		assert.equal(isAssistantFailureStopReason("error"), true);
		assert.equal(isAssistantFailureStopReason("aborted"), true);
		for (const reason of ["pending", "stop", "toolUse", "deferred"] as const) {
			assert.equal(isAssistantFailureStopReason(reason), false);
		}
	});

	it("converts declared extension flags to session-service values", () => {
		const values = parseExtensionFlagValues({ enabled: false, mode: "strict" }, "configured");
		assert.deepEqual(values ? [...values] : values, [
			["enabled", false],
			["mode", "strict"],
		]);
	});

	it("leaves session extension flag values absent when not configured", () => {
		assert.equal(parseExtensionFlagValues(undefined, "default"), undefined);
	});

	it("rejects malformed extension flags with the variant id", () => {
		assert.throws(
			() =>
				piSdkAdapter.resolve({
					suitePath: import.meta.filename,
					subjectKind: "adhoc",
					subjectConfig: {},
					variant: {
						id: "malformed",
						description: "Malformed",
						config: { extensionFlags: { mode: 3 } },
					},
				}),
			/variant malformed\.config\.extensionFlags\.mode must be a boolean or string/,
		);
		assert.throws(() => parseExtensionFlagValues([], "malformed"), /variant malformed.*must be an object/);
		assert.throws(() => parseExtensionFlagValues({ "": true }, "malformed"), /variant malformed.*non-empty/);
	});
});

describe("Pi case preflight validation", () => {
	const validateCases = (cases: EvaluationCase[]): void => {
		piSdkAdapter.validate?.({
			suitePath: import.meta.filename,
			subjectKind: "adhoc",
			subjectConfig: {},
			cases,
		});
	};
	const evaluationCase = (checks: EvaluationCase["checks"]): EvaluationCase => ({
		id: "case-fixture",
		title: "Case fixture",
		input: {
			seed: [
				{ role: "user", content: "seed question" },
				{ role: "assistant", content: "seed answer" },
			],
			prompt: "live prompt",
		},
		checks,
	});

	it("validates supported case and check configurations without a runtime", () => {
		assert.doesNotThrow(() =>
			validateCases([
				evaluationCase([
					{ id: "contains", type: "contains-exact", config: { values: ["required"] } },
					{ id: "omits", type: "omits-exact", config: { values: ["forbidden"] } },
					{ id: "length", type: "max-characters", config: { maximum: 80 } },
					{
						id: "call",
						type: "tool-call",
						config: { name: "read", argumentsContain: ["fixture"], present: true },
					},
					{
						id: "result",
						type: "tool-result",
						config: {
							name: "read",
							isError: false,
							contentContains: ["done"],
							contentOmits: ["failed"],
						},
					},
				]),
			]),
		);
	});

	it("rejects malformed case input with the case id before execution", () => {
		const malformed = evaluationCase([{ id: "contains", type: "contains-exact", config: { values: ["x"] } }]);
		malformed.id = "bad-seed";
		malformed.input = { seed: [{ role: "system", content: "not supported" }], prompt: "live prompt" };
		assert.throws(() => validateCases([malformed]), /case bad-seed has an invalid seed message/);
	});

	it("rejects unsupported and malformed checks with case and check ids", () => {
		assert.throws(
			() => validateCases([evaluationCase([{ id: "unknown-check", type: "unknown", config: {} }])]),
			/case case-fixture check unknown-check uses unsupported Pi check type unknown/,
		);
		assert.throws(
			() =>
				validateCases([
					evaluationCase([
						{ id: "misspelled-field", type: "tool-call", config: { name: "read", argumentContains: ["x"] } },
					]),
				]),
			/case case-fixture check misspelled-field\.config has unsupported field argumentContains/,
		);
		assert.throws(
			() =>
				validateCases([
					evaluationCase([{ id: "wrong-value", type: "tool-result", config: { name: "read", isError: "yes" } }]),
				]),
			/case case-fixture check wrong-value needs a boolean isError value/,
		);
	});
});

describe("Pi evidence normalization", () => {
	it("keeps transcript order and provider usage metadata", () => {
		const messages: Message[] = [
			{ role: "user", content: "question", timestamp: 1 },
			assistantMessage([{ type: "text", text: "answer" }], 2, "reported-model"),
		];
		assert.deepEqual(
			normalizePiTranscript(messages).map((event) => event.type),
			["message", "message"],
		);
		assert.deepEqual(summarizeUsage(messages, participant), {
			provider: "test",
			model: "model",
			inputTokens: 10,
			outputTokens: 4,
			reasoningTokens: 0,
			totalTokens: 17,
			metadata: { cacheReadTokens: 2, cacheWriteTokens: 1, cost: 0.32 },
		});
	});

	it("preserves existing lexical check results and messages", () => {
		const checks = runDeterministicChecks(
			"keep this",
			[
				{ id: "keep-pass", type: "contains-exact", config: { values: ["keep"] } },
				{ id: "keep-fail", type: "contains-exact", config: { values: ["keep", "missing"] } },
				{ id: "omit-pass", type: "omits-exact", config: { values: ["canary"] } },
				{ id: "omit-fail", type: "omits-exact", config: { values: ["this", "canary"] } },
				{ id: "bounded-pass", type: "max-characters", config: { maximum: 10 } },
				{ id: "bounded-fail", type: "max-characters", config: { maximum: 4 } },
			],
			[],
		);
		assert.deepEqual(checks, [
			{
				checkId: "keep-pass",
				type: "contains-exact",
				passed: true,
				message: "All protected spans remain exact.",
			},
			{
				checkId: "keep-fail",
				type: "contains-exact",
				passed: false,
				message: "Missing exact spans: missing",
			},
			{
				checkId: "omit-pass",
				type: "omits-exact",
				passed: true,
				message: "No forbidden text appears.",
			},
			{
				checkId: "omit-fail",
				type: "omits-exact",
				passed: false,
				message: "Forbidden text appears: this",
			},
			{
				checkId: "bounded-pass",
				type: "max-characters",
				passed: true,
				message: "Output has 9 characters; the lexical ceiling is 10.",
			},
			{
				checkId: "bounded-fail",
				type: "max-characters",
				passed: false,
				message: "Output has 9 characters; the lexical ceiling is 4.",
			},
		]);
	});

	it("passes present and absent tool-call checks when their constraints hold", () => {
		const checks = runDeterministicChecks(
			"",
			[
				{
					id: "read-called",
					type: "tool-call",
					config: { name: "read", argumentsContain: ['"path":"docs/input.md"', '"mode":"exact"'] },
				},
				{ id: "bash-not-called", type: "tool-call", config: { name: "bash", present: false } },
			],
			toolEvents,
		);
		assert.deepEqual(checks, [
			{
				checkId: "read-called",
				type: "tool-call",
				passed: true,
				message: 'A matching tool call to "read" appears.',
			},
			{
				checkId: "bash-not-called",
				type: "tool-call",
				passed: true,
				message: 'No matching tool call to "bash" appears.',
			},
		]);
	});

	it("fails present and absent tool-call checks when their constraints do not hold", () => {
		const checks = runDeterministicChecks(
			"",
			[
				{
					id: "wrong-read-arguments",
					type: "tool-call",
					config: { name: "read", argumentsContain: ['"path":"missing.md"'] },
				},
				{ id: "read-forbidden", type: "tool-call", config: { name: "read", present: false } },
			],
			toolEvents,
		);
		assert.deepEqual(
			checks.map((check) => ({ passed: check.passed, message: check.message })),
			[
				{ passed: false, message: 'No matching tool call to "read" appears.' },
				{ passed: false, message: 'A forbidden matching tool call to "read" appears.' },
			],
		);
	});

	it("passes tool-result checks for paired error and content constraints", () => {
		const checks = runDeterministicChecks(
			"",
			[
				{
					id: "blocked-read",
					type: "tool-result",
					config: {
						name: "read",
						isError: true,
						contentContains: ["Blocked by policy", "not allowed"],
						contentOmits: ["approved"],
					},
				},
				{
					id: "successful-write",
					type: "tool-result",
					config: { name: "write", isError: false, contentContains: ["safe output"] },
				},
			],
			toolEvents,
		);
		assert.equal(
			checks.every((check) => check.passed),
			true,
		);
		assert.deepEqual(
			checks.map((check) => check.message),
			['A matching tool result for "read" appears.', 'A matching tool result for "write" appears.'],
		);
	});

	it("fails tool-result checks for mismatched error and content constraints", () => {
		const checks = runDeterministicChecks(
			"",
			[
				{ id: "wrong-error-state", type: "tool-result", config: { name: "read", isError: false } },
				{
					id: "missing-content",
					type: "tool-result",
					config: { name: "read", contentContains: ["approved"] },
				},
				{
					id: "forbidden-content",
					type: "tool-result",
					config: { name: "read", contentOmits: ["Blocked"] },
				},
			],
			toolEvents,
		);
		assert.equal(
			checks.every((check) => !check.passed),
			true,
		);
		assert.equal(
			checks.every((check) => check.message.includes('No tool result for "read"')),
			true,
		);
	});

	it("uses toolCallId pairing instead of a conflicting result name", () => {
		const [paired, conflicting] = runDeterministicChecks(
			"",
			[
				{ id: "paired-name", type: "tool-result", config: { name: "read" } },
				{ id: "reported-name", type: "tool-result", config: { name: "reported-as-another-tool" } },
			],
			toolEvents,
		);
		assert.equal(paired?.passed, true);
		assert.equal(conflicting?.passed, false);
	});

	it("rejects malformed transcript check configuration with the check id", () => {
		assert.throws(
			() =>
				runDeterministicChecks(
					"",
					[{ id: "bad-call-values", type: "tool-call", config: { name: "read", argumentsContain: [1] } }],
					toolEvents,
				),
			/check bad-call-values needs string argumentsContain values/,
		);
		assert.throws(
			() =>
				runDeterministicChecks(
					"",
					[{ id: "bad-result-error", type: "tool-result", config: { name: "read", isError: "yes" } }],
					toolEvents,
				),
			/check bad-result-error needs a boolean isError value/,
		);
		assert.throws(
			() =>
				runDeterministicChecks(
					"",
					[{ id: "bad-result-values", type: "tool-result", config: { name: "read", contentOmits: "x" } }],
					toolEvents,
				),
			/check bad-result-values needs string contentOmits values/,
		);
	});

	it("does not let a seeded tool call satisfy a live tool-call check", () => {
		const allMessages: Message[] = [
			assistantMessage(
				[
					{
						type: "toolCall",
						id: "seeded-call",
						name: "read",
						arguments: { path: "seeded-fixture.txt" },
					},
				],
				1,
			),
			{ role: "user", content: "live prompt", timestamp: 2 },
			assistantMessage([{ type: "text", text: "done" }], 3),
		];
		const scored = scorePostSeedPiTranscript(allMessages, 1, [
			{ id: "live-read", type: "tool-call", config: { name: "read" } },
		]);
		assert.equal(scored.output, "done");
		assert.deepEqual(scored.checks, [
			{
				checkId: "live-read",
				type: "tool-call",
				passed: false,
				message: 'No matching tool call to "read" appears.',
			},
		]);
	});
});
