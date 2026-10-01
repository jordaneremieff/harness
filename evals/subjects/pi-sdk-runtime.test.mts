import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SubjectAdapter } from "../types.mts";
import { piSdkAdapter } from "./pi-sdk.mts";

function recordedUsage(scale: number): Usage {
	return {
		input: scale,
		output: 4 * scale,
		reasoning: 2 * scale,
		cacheRead: 2 * scale,
		cacheWrite: scale,
		totalTokens: 8 * scale,
		cost: { input: scale / 8, output: scale / 4, cacheRead: scale / 16, cacheWrite: scale / 16, total: scale / 2 },
	};
}

function recordedAssistant(scale: number): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "usage-fixture",
		model: "fixture",
		content: [{ type: "text", text: "Completed response" }],
		stopReason: "stop",
		usage: recordedUsage(scale),
		timestamp: Date.now(),
	};
}

function runArguments(root: string, extension: string, prompt: string): Parameters<SubjectAdapter["run"]>[0] {
	return {
		suitePath: join(root, "suite.mts"),
		subjectKind: "adhoc",
		subjectConfig: {},
		variant: { id: "fixture", description: "", config: { extensions: [{ path: extension }] } },
		evaluationCase: {
			id: "native",
			title: "Native execution",
			input: { seed: [{ role: "assistant", content: "Seed response" }], prompt },
			checks: [{ id: "seed-excluded", type: "omits-exact", config: { values: ["Seed response"] } }],
		},
		participant: { id: "fixture", provider: "usage-fixture", model: "fixture", thinking: "off" },
		limits: {
			wall: { runTimeoutMs: 10000, executionTimeoutMs: 5000 },
			execution: { maxTotal: 1, maxTurnsEach: 2, maxOutputTokensEach: 1024 },
			cost: { currency: "USD", maxObserved: 100, enforcement: "observed-after-each-execution", hardCap: false },
		},
		authority: { requestedEffects: { providerNetwork: [], credentials: [], subject: [] } },
		grant: {
			providerNetwork: "approved-effects-only",
			credentialSources: { home: false, environment: [] },
			grantedEffects: [],
		},
		runDirectory: join(root, "run"),
		execution: {
			executionId: "native",
			caseId: "native",
			variantId: "fixture",
			participantId: "fixture",
			repetition: 1,
			blindLabel: "A",
		},
	};
}

const fixtureKey = Symbol.for("evals.pi-sdk.usage-fixture");
interface NativeFixture {
	beforeResponse(): void;
	response: AssistantMessage;
	requests: number;
	maxTokens: number | undefined;
	settled: boolean;
	shutdown: boolean;
}
const fixtures = globalThis as typeof globalThis & { [fixtureKey]?: NativeFixture };

const extensionSource = `import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  const fixture = globalThis[Symbol.for("evals.pi-sdk.usage-fixture")];
  pi.registerProvider("usage-fixture", {
    api: "openai-completions", baseUrl: "https://provider.invalid", apiKey: "synthetic-not-a-credential",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 2048 }],
    streamSimple(model) {
      fixture.requests++;
      fixture.maxTokens = model.maxTokens;
      fixture.beforeResponse();
      const stream = new AssistantMessageEventStream();
      const partial = { ...fixture.response, content: [], stopReason: "pending" };
      stream.push({ type: "start", partial });
      const block = { type: "text", text: "" };
      partial.content.push(block);
      stream.push({ type: "text_start", contentIndex: 0, partial });
      block.text = fixture.response.content[0].text;
      stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial });
      stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial });
      stream.push({ type: "done", reason: "stop", message: fixture.response });
      stream.end();
      return stream;
    },
  });
  pi.registerCommand("noop", { description: "Complete without model work", handler() {} });
  pi.on("agent_settled", () => { fixture.settled = true; });
  pi.on("session_shutdown", () => { fixture.shutdown = true; });
}`;

it("counts every native usage family once, excludes seed costs, and enforces aggregate output limits", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "eval-native-usage-"));
	const extension = join(root, "fixture.ts");
	writeFileSync(extension, extensionSource);
	let manager: SessionManager | undefined;
	const appendMessage = SessionManager.prototype.appendMessage;
	t.mock.method(
		SessionManager.prototype,
		"appendMessage",
		function (this: SessionManager, message: Parameters<SessionManager["appendMessage"]>[0]) {
			manager = this;
			if (
				message.role === "assistant" &&
				message.content.some((part) => part.type === "text" && part.text === "Seed response")
			) {
				return appendMessage.call(this, { ...message, usage: recordedUsage(1024) });
			}
			return appendMessage.call(this, message);
		},
	);
	const fixture: NativeFixture = {
		beforeResponse() {
			assert.ok(manager);
			const toolCallId = "nested-usage";
			const assistant = recordedAssistant(1);
			assistant.content = [{ type: "toolCall", id: toolCallId, name: "nested", arguments: {} }];
			assistant.stopReason = "toolUse";
			const firstKeptEntryId = manager.appendMessage(assistant);
			manager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "nested",
				content: [],
				isError: false,
				timestamp: Date.now(),
				usage: recordedUsage(2),
			});
			manager.appendCompaction("Retained context", firstKeptEntryId, 24, undefined, true, recordedUsage(4));
			manager.branchWithSummary(manager.getLeafId(), "Branch context", undefined, true, recordedUsage(8));
			manager.appendUsage("unrecognized-operation", "other-provider", "other-model", recordedUsage(16));
			manager.appendCustomEntry("unrelated", { usage: recordedUsage(1024) });
			manager.appendCustomMessageEntry("unrelated", "Context only", false, { usage: recordedUsage(1024) });
		},
		response: recordedAssistant(32),
		requests: 0,
		maxTokens: undefined,
		settled: false,
		shutdown: false,
	};
	fixtures[fixtureKey] = fixture;
	try {
		const args = runArguments(root, extension, "Produce the response");
		args.limits.execution.maxOutputTokensEach = 200;
		const result = await piSdkAdapter.run(args);
		assert.equal(fixture.requests, 1);
		assert.equal(fixture.maxTokens, 200);
		assert.equal(fixture.settled, true);
		assert.equal(fixture.shutdown, true);
		assert.deepEqual(result.usage, {
			provider: "usage-fixture",
			model: "fixture",
			inputTokens: 63,
			outputTokens: 252,
			reasoningTokens: 126,
			totalTokens: 504,
			toolCalls: 1,
			metadata: { cacheReadTokens: 126, cacheWriteTokens: 63, cost: 31.5 },
		});
		assert.deepEqual(result.errors, [{ type: "OutputTokenLimitExceeded", message: "Output token usage exceeded 200" }]);
		assert.equal((result.output.value as { text: string }).text, "Completed response");
		assert.equal(result.output.checks?.[0].passed, true);
		assert.ok(result.events.some((event) => event.type === "message" && event.content === "Seed response"));
	} finally {
		delete fixtures[fixtureKey];
		rmSync(root, { recursive: true, force: true });
	}
});

it("completes a native slash command without requiring model work or a settled event", async () => {
	const root = mkdtempSync(join(tmpdir(), "eval-native-command-"));
	const extension = join(root, "fixture.ts");
	writeFileSync(extension, extensionSource);
	const fixture: NativeFixture = {
		beforeResponse() {
			assert.fail("The command must not call the provider");
		},
		response: recordedAssistant(1),
		requests: 0,
		maxTokens: undefined,
		settled: false,
		shutdown: false,
	};
	fixtures[fixtureKey] = fixture;
	try {
		const result = await piSdkAdapter.run(runArguments(root, extension, "/noop"));
		assert.equal(fixture.requests, 0);
		assert.equal(fixture.settled, false);
		assert.equal(fixture.shutdown, true);
		assert.equal((result.output.value as { text: string }).text, "");
		assert.equal(result.usage.totalTokens, 0);
		assert.deepEqual(result.errors, []);
	} finally {
		delete fixtures[fixtureKey];
		rmSync(root, { recursive: true, force: true });
	}
});
