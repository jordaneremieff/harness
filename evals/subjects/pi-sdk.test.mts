import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Message } from "@earendil-works/pi-ai";
import { normalizePiTranscript, runDeterministicChecks, summarizeUsage } from "./pi-sdk.mts";

const participant = { id: "test/model:off", provider: "test", model: "model", thinking: "off" as const };
const usage = {
	input: 10,
	output: 4,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 17,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.01, total: 0.32 },
};

describe("Pi evidence normalization", () => {
	it("keeps transcript order and provider usage metadata", () => {
		const messages: Message[] = [
			{ role: "user", content: "question", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				api: "openai-completions",
				provider: "test",
				model: "model",
				responseModel: "reported-model",
				usage,
				stopReason: "stop",
				timestamp: 2,
			},
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

	it("reports lexical floors without assigning semantic quality", () => {
		const checks = runDeterministicChecks("keep this", [
			{ id: "keep", type: "contains-exact", config: { values: ["keep"] } },
			{ id: "omit", type: "omits-exact", config: { values: ["canary"] } },
		]);
		assert.equal(
			checks.every((check) => check.passed),
			true,
		);
		assert.deepEqual(
			checks.map((check) => check.checkId),
			["keep", "omit"],
		);
	});
});
