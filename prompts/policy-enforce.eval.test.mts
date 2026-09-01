import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";

import type { Message } from "@earendil-works/pi-ai";
import type { TranscriptEvent } from "vitest-evals";

import { normalizePiTranscript, runDeterministicChecks } from "../evals/subjects/pi-sdk.mts";
import registerPolicy from "../extensions/policy/index.ts";
import suite from "./policy-enforce.eval.mts";

const executeFile = promisify(execFile);

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown | Promise<unknown>;

interface VariantConfig {
	extensionFlags?: Record<string, boolean | string>;
}

interface PolicyFixture {
	command: string;
	fileName: string;
}

interface HookPatch {
	content?: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

function createPolicyHarness(extensionFlags: Record<string, boolean | string> | undefined, cwd: string) {
	const handlers = new Map<string, Handler>();
	const registeredFlags = new Set<string>();
	const flagValues = new Map(Object.entries(extensionFlags ?? {}));
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerFlag(name: string) {
			registeredFlags.add(name);
		},
		getFlag(name: string) {
			return registeredFlags.has(name) ? flagValues.get(name) : undefined;
		},
		registerTool() {},
		registerCommand() {},
		appendEntry() {},
		sendUserMessage() {},
	};
	registerPolicy(pi as unknown as Parameters<typeof registerPolicy>[0]);
	const ctx = {
		mode: "rpc",
		hasUI: false,
		cwd,
		model: { provider: "test", id: "policy-eval" },
		thinkingLevel: "off",
		ui: {
			notify() {},
			confirm: async () => true,
			custom: async () => undefined,
		},
		isIdle: () => true,
		sessionManager: { getSessionId: () => "policy-eval-session" },
		getSystemPrompt: () => "policy evaluation",
	};
	return { handlers, ctx };
}

function assistantToolCall(callId: string, command: string): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command } }],
		api: "openai-completions",
		provider: "test",
		model: "policy-eval",
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

async function evidenceFor(
	variant: (typeof suite.subject.variants)[number],
	fixture: PolicyFixture,
): Promise<TranscriptEvent[]> {
	const root = await mkdtemp(join(tmpdir(), "policy-enforce-eval-"));
	const previousDir = process.env.PI_POLICY_DIR;
	const previousMode = process.env.PI_POLICY_MODE;
	process.env.PI_POLICY_DIR = join(root, "policy");
	delete process.env.PI_POLICY_MODE;
	const config = variant.config as VariantConfig;
	const run = createPolicyHarness(config.extensionFlags, root);
	const callId = `call-${variant.id}`;
	let resultText = "";
	let isError = false;
	try {
		await writeFile(join(root, fixture.fileName), "observe mode executed the command\n");
		await run.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, run.ctx);
		const preflight = await run.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "bash", toolCallId: callId, input: { command: fixture.command } },
			run.ctx,
		);
		if (
			preflight &&
			typeof preflight === "object" &&
			(preflight as { block?: unknown }).block === true &&
			typeof (preflight as { reason?: unknown }).reason === "string"
		) {
			resultText = (preflight as { reason: string }).reason;
			isError = true;
			await run.handlers.get("tool_execution_end")!(
				{
					type: "tool_execution_end",
					toolName: "bash",
					toolCallId: callId,
					result: { content: [{ type: "text", text: resultText }] },
					isError,
				},
				run.ctx,
			);
		} else {
			const executed = await executeFile("/bin/sh", ["-c", fixture.command], { cwd: root, encoding: "utf8" });
			const original = [{ type: "text" as const, text: `${executed.stdout}${executed.stderr}` }];
			const patch = (await run.handlers.get("tool_result")!(
				{
					type: "tool_result",
					toolName: "bash",
					toolCallId: callId,
					input: { command: fixture.command },
					content: original,
					isError: false,
				},
				run.ctx,
			)) as HookPatch | undefined;
			resultText = (patch?.content ?? original).map((part) => part.text).join("");
			isError = patch?.isError ?? false;
		}
		return normalizePiTranscript([
			assistantToolCall(callId, fixture.command),
			{
				role: "toolResult",
				toolCallId: callId,
				toolName: "bash",
				content: [{ type: "text", text: resultText }],
				isError,
				timestamp: 2,
			},
		]);
	} finally {
		await run.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "test" }, run.ctx);
		if (previousDir === undefined) delete process.env.PI_POLICY_DIR;
		else process.env.PI_POLICY_DIR = previousDir;
		if (previousMode === undefined) delete process.env.PI_POLICY_MODE;
		else process.env.PI_POLICY_MODE = previousMode;
		await rm(root, { recursive: true, force: true });
	}
}

it("passes both checks in enforce and fails policy-block-returned in observe", async (t) => {
	const evaluationCase = suite.cases[0];
	const input = evaluationCase.input as { fixture: PolicyFixture };
	const enforce = suite.subject.variants.find((variant) => variant.id === "enforce");
	const observe = suite.subject.variants.find((variant) => variant.id === "observe-baseline");
	assert.ok(enforce);
	assert.ok(observe);

	const enforceChecks = runDeterministicChecks(
		"",
		evaluationCase.checks,
		await evidenceFor(enforce, input.fixture),
		evaluationCase.id,
	);
	const observeChecks = runDeterministicChecks(
		"",
		evaluationCase.checks,
		await evidenceFor(observe, input.fixture),
		evaluationCase.id,
	);

	assert.deepEqual(
		enforceChecks.map(({ checkId, passed }) => ({ checkId, passed })),
		[
			{ checkId: "blocked-command-attempted", passed: true },
			{ checkId: "policy-block-returned", passed: true },
		],
	);
	assert.deepEqual(
		observeChecks.map(({ checkId, passed }) => ({ checkId, passed })),
		[
			{ checkId: "blocked-command-attempted", passed: true },
			{ checkId: "policy-block-returned", passed: false },
		],
	);
	assert.deepEqual(
		observeChecks.filter((check) => !check.passed).map((check) => check.checkId),
		["policy-block-returned"],
	);

	t.diagnostic(
		`enforce checks: ${enforceChecks.map((check) => `${check.checkId}=${check.passed ? "pass" : "fail"}`).join(", ")}`,
	);
	t.diagnostic(
		`observe checks: ${observeChecks.map((check) => `${check.checkId}=${check.passed ? "pass" : "fail"}`).join(", ")}`,
	);
});
