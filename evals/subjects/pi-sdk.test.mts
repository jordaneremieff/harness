import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import type { Message, Model } from "@earendil-works/pi-ai";
import type { TranscriptEvent } from "vitest-evals";
import { Type } from "typebox";
import type { EvaluationCase } from "../types.mts";
import {
	collectPiExecutionErrors,
	isAssistantFailureStopReason,
	limitModelOutput,
	normalizePiTranscript,
	parseExtensionFlagValues,
	piSdkAdapter,
	runDeterministicChecks,
	resolvePiCwd,
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
	it("keeps an omitted cwd isolated", () => {
		assert.equal(resolvePiCwd({ id: "isolated", description: "", config: {} }, import.meta.filename), undefined);
	});

	it("resolves an explicit cwd relative to the suite and includes it in subject evidence", () => {
		const variant = { id: "workspace", description: "", config: { cwd: "." } };
		const cwd = realpathSync(dirname(import.meta.filename));
		assert.equal(resolvePiCwd(variant, import.meta.filename), cwd);
		const resolution = piSdkAdapter.resolve({
			suitePath: import.meta.filename,
			subjectKind: "adhoc",
			subjectConfig: {},
			variant,
		}) as { cwd: string };
		assert.equal(resolution.cwd, cwd);
	});

	it("rejects malformed, missing, and non-directory cwd inputs before runtime creation", () => {
		for (const cwd of ["", " ", 1, null, [], {}]) {
			assert.throws(
				() => resolvePiCwd({ id: "bad", description: "", config: { cwd } }, import.meta.filename),
				/variant bad.config.cwd must be a non-empty directory path/,
			);
		}
		assert.throws(
			() => resolvePiCwd({ id: "bad", description: "", config: { cwd: import.meta.filename } }, import.meta.filename),
			/must resolve to a directory/,
		);
		assert.throws(
			() => resolvePiCwd({ id: "bad", description: "", config: { cwd: "absent-cwd-fixture" } }, import.meta.filename),
			/ENOENT/,
		);
	});

	it("uses the selected cwd through the real SDK lifecycle and preserves it during cleanup", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-cwd-"));
		const cwd = join(root, "workspace");
		const extension = join(root, "fixture.ts");
		mkdirSync(cwd);
		writeFileSync(join(cwd, "sentinel.txt"), "preserved");
		writeFileSync(
			extension,
			`import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerProvider("cwd-fixture", {
    api: "openai-completions", baseUrl: "https://provider.invalid", apiKey: "synthetic-not-a-credential",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 1024 }],
  });
  pi.on("input", (_event, ctx) => {
    writeFileSync(${JSON.stringify(join(root, "observed-cwd.txt"))}, ctx.cwd);
    return { action: "handled" };
  });
}`,
		);
		try {
			const result = await piSdkAdapter.run({
				suitePath: join(root, "suite.mts"),
				subjectKind: "adhoc",
				subjectConfig: {},
				variant: { id: "explicit", description: "", config: { cwd: "workspace", extensions: [{ path: extension }] } },
				evaluationCase: {
					id: "cwd",
					title: "Cwd",
					input: { seed: [], prompt: "Observe cwd without inference" },
					checks: [],
				},
				participant: { id: "fixture", provider: "cwd-fixture", model: "fixture", thinking: "off" },
				limits: {
					wall: { runTimeoutMs: 30000, executionTimeoutMs: 10000 },
					execution: { maxTotal: 1, maxTurnsEach: 1, maxOutputTokensEach: 1024 },
					cost: { currency: "USD", maxObserved: 0, enforcement: "observed-after-each-execution", hardCap: false },
				},
				authority: { requestedEffects: { providerNetwork: [], credentials: [], subject: [] } },
				grant: {
					providerNetwork: "approved-effects-only",
					credentialSources: { home: false, environment: [] },
					grantedEffects: [],
				},
				runDirectory: join(root, "run"),
				execution: {
					executionId: "cwd",
					caseId: "cwd",
					variantId: "explicit",
					participantId: "fixture",
					repetition: 1,
					blindLabel: "A",
				},
			});
			assert.deepEqual(result.errors, []);
			assert.equal(readFileSync(join(root, "observed-cwd.txt"), "utf8"), realpathSync(cwd));
			assert.equal(readFileSync(join(cwd, "sentinel.txt"), "utf8"), "preserved");
			assert.equal(existsSync(join(root, "run", "sandboxes")), true);
			const value = result.output.value as { resources: { cwd: string; cwdMode: string } };
			assert.equal(value.resources.cwd, realpathSync(cwd));
			assert.equal(value.resources.cwdMode, "explicit");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

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

describe("Pi provider evidence conversion", () => {
	it("records a provider rejection fixture as assistant error evidence", () => {
		const rejected = assistantMessage([{ type: "text", text: "" }], 1);
		rejected.errorMessage = "Provider refused the approved request.";
		rejected.stopReason = "error";
		assert.deepEqual(collectPiExecutionErrors([rejected], summarizeUsage([rejected], participant), 10), [
			{ type: "AssistantError", message: "Provider refused the approved request." },
			{ type: "AssistantStopReason", message: "Assistant stopped with error." },
		]);
	});

	it("records a provider output-token overrun fixture", () => {
		const overrun = assistantMessage([{ type: "text", text: "too long" }], 1);
		overrun.usage = { ...overrun.usage, output: 12, totalTokens: 25 };
		assert.deepEqual(collectPiExecutionErrors([overrun], summarizeUsage([overrun], participant), 10), [
			{ type: "OutputTokenLimitExceeded", message: "Output token usage exceeded 10" },
		]);
	});

	it("keeps a successful in-limit fixture free of adapter errors", () => {
		const successful = assistantMessage([{ type: "text", text: "ok" }], 1);
		assert.deepEqual(collectPiExecutionErrors([successful], summarizeUsage([successful], participant), 4), []);
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
	it("preserves system instructions and ordered prompt and tool changes", () => {
		const tool = {
			name: "inspect_file",
			description: "Inspect a fixture file",
			parameters: Type.Object({ path: Type.String() }),
			constrainedSampling: { type: "json_schema" as const, strict: "require" as const },
		};
		const messages: Message[] = [
			{
				role: "system",
				content: "Base instructions",
				sections: { rules: "Original rules" },
				toolsAdded: [tool],
				timestamp: 1,
			},
			{ role: "user", content: "Question", timestamp: 2 },
			{
				role: "system",
				content: [{ type: "text", text: "Additional instructions" }],
				sections: { rules: null, safety: "Keep scope" },
				toolsRemoved: [{ name: tool.name }],
				timestamp: 3,
			},
			{ role: "system", content: "", toolsAdded: [], timestamp: 4 },
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: tool.name,
				content: [{ type: "text", text: "Tool failed" }],
				isError: true,
				timestamp: 5,
			},
		];
		const events = normalizePiTranscript(messages);
		assert.deepEqual(events, [
			{
				type: "message",
				role: "system",
				content: "Base instructions",
				metadata: {
					timestamp: 1,
					sections: { rules: "Original rules" },
					toolsAdded: JSON.parse(JSON.stringify([tool])),
				},
			},
			{ type: "message", role: "user", content: "Question" },
			{
				type: "message",
				role: "system",
				content: "Additional instructions",
				metadata: {
					timestamp: 3,
					sections: { rules: null, safety: "Keep scope" },
					toolsRemoved: [{ name: tool.name }],
				},
			},
			{ type: "message", role: "system", content: "", metadata: { timestamp: 4, toolsAdded: [] } },
			{
				type: "tool_result",
				toolCallId: "call-1",
				name: tool.name,
				content: "Tool failed",
				error: { message: "Tool failed" },
			},
		]);
		assert.deepEqual(JSON.parse(JSON.stringify(events)), events);
	});

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
		const system: Message = { role: "system", content: "Instructions", timestamp: 0 };
		const delta: Message = { role: "system", content: "", toolsRemoved: [{ name: "read" }], timestamp: 2 };
		for (const messages of [allMessages, [system, allMessages[0], delta, ...allMessages.slice(1)]]) {
			const scored = scorePostSeedPiTranscript(messages, 1, [
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
			if (messages[0].role === "system") assert.equal(scored.newMessages[0], delta);
		}
	});
});
