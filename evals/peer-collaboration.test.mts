import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import type { Message } from "@earendil-works/pi-ai";
import type { TranscriptEvent } from "vitest-evals";

import { normalizePiTranscript, piSdkAdapter, runDeterministicChecks } from "./subjects/pi-sdk.mts";
import suite, { preparePeerEvaluationEnvironment } from "./peer-collaboration.eval.mts";
import { PeerHub } from "../extensions/subagent/peers.ts";

function rootPeer() {
	const hub = new PeerHub();
	hub.register({ sessionId: "eval-root", parentSessionId: null, label: "Root session", send() {} });
	return hub;
}

function toolEvidence(name: string, args: Record<string, string>, invoke: () => unknown): TranscriptEvent[] {
	const id = `call-${name}`;
	let text: string;
	let isError = false;
	try {
		text = JSON.stringify(invoke());
	} catch (error) {
		assert.ok(error instanceof Error);
		text = error.message;
		isError = true;
	}
	const messages: Message[] = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: args }],
			api: "openai-completions",
			provider: "test",
			model: "peer-eval",
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
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text }],
			isError,
			timestamp: 2,
		},
	];
	return normalizePiTranscript(messages);
}

function failedChecks(caseId: string, events: TranscriptEvent[], output = "") {
	const evaluationCase = suite.cases.find((entry) => entry.id === caseId);
	assert.ok(evaluationCase);
	return runDeterministicChecks(output, evaluationCase.checks, events, caseId)
		.filter((check) => !check.passed)
		.map((check) => check.checkId);
}

it("isolates the extension store before execution and refuses missing or reused child setup", () => {
	const runDirectory = mkdtempSync(join(tmpdir(), "peer-eval-isolation-"));
	try {
		const environment: NodeJS.ProcessEnv = {
			HARNESS_EVAL_PLAN_PATH: join(runDirectory, "plan.json"),
			HARNESS_EVAL_RUN_DIRECTORY: runDirectory,
			PI_CODING_AGENT_DIR: "must-not-use-existing-agent-directory",
		};
		preparePeerEvaluationEnvironment(environment);
		const expected = join(realpathSync(runDirectory), "peer-agent");
		assert.equal(environment.PI_CODING_AGENT_DIR, expected);
		assert.equal(statSync(expected).mode & 0o777, 0o700);
		assert.throws(() => preparePeerEvaluationEnvironment(environment), /EEXIST/);
		assert.throws(() => preparePeerEvaluationEnvironment({ HARNESS_EVAL_PLAN_PATH: "plan.json" }), /requires both/);
		assert.throws(
			() => preparePeerEvaluationEnvironment({ HARNESS_EVAL_RUN_DIRECTORY: runDirectory }),
			/requires both/,
		);
		const validationEnvironment = { PI_CODING_AGENT_DIR: "unchanged-without-execution" };
		preparePeerEvaluationEnvironment(validationEnvironment);
		assert.equal(validationEnvironment.PI_CODING_AGENT_DIR, "unchanged-without-execution");
	} finally {
		rmSync(runDirectory, { recursive: true, force: true });
	}
});

it("resolves only explicit peer resources and preserves bounded human adjudication", () => {
	const suitePath = fileURLToPath(new URL("./peer-collaboration.eval.mts", import.meta.url));
	piSdkAdapter.validate!({
		suitePath,
		subjectKind: suite.subject.kind,
		subjectConfig: suite.subject.config,
		cases: suite.cases,
	});
	assert.equal(suite.subject.variants.length, 1);
	const variant = suite.subject.variants[0];
	assert.deepEqual(variant.config, {
		extensions: [{ path: "../extensions/subagent/index.ts" }],
		tools: ["subagent_peers", "subagent_message"],
	});
	const resolution = piSdkAdapter.resolve({
		suitePath,
		subjectKind: suite.subject.kind,
		subjectConfig: suite.subject.config,
		variant,
	}) as { resources: Array<{ type: string; path?: string }> };
	assert.deepEqual(
		resolution.resources.map((resource) => resource.type),
		["extension", "tools"],
	);
	assert.equal(resolution.resources[0].path, resolve(suitePath, "../../extensions/subagent/index.ts"));
	assert.equal(suite.adjudication.policy, "human-required");
	assert.equal(suite.limits.execution.maxTotal, suite.cases.length);
	assert.equal(suite.limits.cost.hardCap, false);
	assert.ok(suite.cases.every((entry) => entry.checks.every((check) => check.type.startsWith("tool-"))));
});

it("scores real unavailable-target evidence and rejects successful-send and missing-directory controls", () => {
	const hub = rootPeer();
	const evaluationCase = suite.cases.find((entry) => entry.id === "unavailable-target")!;
	const { fixture } = evaluationCase.input as { fixture: { target: string; message: string } };
	const attempt = () =>
		toolEvidence("subagent_message", { to: fixture.target, message: fixture.message }, () =>
			hub.send("eval-root", fixture.target, fixture.message),
		);
	const directory = () => toolEvidence("subagent_peers", {}, () => hub.list("eval-root"));
	assert.deepEqual(failedChecks(evaluationCase.id, [...attempt(), ...directory()]), []);
	assert.deepEqual(failedChecks(evaluationCase.id, attempt()), ["directory-check", "directory-result"]);

	const dispose = hub.register({
		sessionId: "eval-recipient",
		workerId: fixture.target,
		parentSessionId: "eval-root",
		label: "Reviewer",
		send() {},
	});
	const success = attempt();
	dispose();
	assert.deepEqual(failedChecks(evaluationCase.id, [...success, ...directory()]), ["unavailable-result"]);
});

it("scores an absent receipt and rejects unrelated errors and unauthorized extra messages", () => {
	const hub = rootPeer();
	const evaluationCase = suite.cases.find((entry) => entry.id === "unretained-receipt")!;
	const { fixture } = evaluationCase.input as { fixture: { receiptId: string } };
	const lookup = toolEvidence("subagent_message", { id: fixture.receiptId }, () =>
		hub.status("eval-root", fixture.receiptId),
	);
	assert.deepEqual(failedChecks(evaluationCase.id, lookup), []);
	const unrelatedError = toolEvidence("subagent_message", { id: fixture.receiptId }, () => {
		throw new Error("Unrelated transport failure");
	});
	assert.deepEqual(failedChecks(evaluationCase.id, unrelatedError), ["absent-receipt-result"]);
	const extraSend = toolEvidence("subagent_message", { to: "parent", message: "Publish now" }, () =>
		hub.send("eval-root", "parent", "Publish now"),
	);
	assert.deepEqual(failedChecks(evaluationCase.id, [...lookup, ...extraSend]), ["no-new-message"]);
});

it("does not confuse prose or a false semantic claim with transcript evidence", () => {
	for (const evaluationCase of suite.cases) {
		assert.ok(failedChecks(evaluationCase.id, [], JSON.stringify(evaluationCase)).length > 0);
	}
	const hub = rootPeer();
	const evaluationCase = suite.cases.find((entry) => entry.id === "unretained-receipt")!;
	const { fixture } = evaluationCase.input as { fixture: { receiptId: string } };
	const events = toolEvidence("subagent_message", { id: fixture.receiptId }, () =>
		hub.status("eval-root", fixture.receiptId),
	);
	// Tool evidence does not adjudicate whether the final answer tells the truth.
	assert.deepEqual(failedChecks(evaluationCase.id, events, "The peer processed it and authorized publication."), []);
	assert.equal(suite.adjudication.policy, "human-required");
});
