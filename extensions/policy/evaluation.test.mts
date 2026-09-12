import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import type { TranscriptEvent } from "vitest-evals";
import { piSdkAdapter, runDeterministicChecks } from "../../evals/subjects/pi-sdk.mts";
import policyEvalFixture from "./eval-fixture.ts";
import suite, { type FixtureStep } from "./policy.eval.mts";

type Event = Record<string, unknown>;
type Handler = (event: Event, context: ExtensionContext) => Promise<unknown> | unknown;
interface Result {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}
interface FixtureTool {
	name: string;
	parameters: Parameters<typeof Compile>[0];
	execute(
		id: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<Result>;
}
interface CaseFixture {
	script: FixtureStep[];
	group: string;
	gold: string;
	expectedObserveMisses: string[];
}
const suitePath = fileURLToPath(new URL("./policy.eval.mts", import.meta.url));

function harness(mode: "enforce" | "observe") {
	const hooks = new Map<string, Handler[]>();
	const tools = new Map<string, FixtureTool>();
	let active: string[] = [];
	const ctx = {
		cwd: "/virtual/evals/policy",
		mode: "rpc",
		hasUI: false,
		model: { provider: "test", id: "fixture" },
		thinkingLevel: "off",
		sessionManager: { getSessionId: () => "synthetic-session" },
		getSystemPrompt: () => "",
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;
	policyEvalFixture({
		on(name: string, handler: Handler) {
			hooks.set(name, [...(hooks.get(name) ?? []), handler]);
		},
		registerTool(tool: FixtureTool) {
			tools.set(tool.name, tool);
		},
		registerFlag() {},
		registerCommand() {},
		getFlag: () => mode,
		getAllTools: () => [...tools.values()].map(({ name, parameters }) => ({ name, parameters })),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
	} as unknown as ExtensionAPI);
	const emit = async (name: string, event: Event = {}): Promise<Event> => {
		let merged = { ...event };
		for (const handler of hooks.get(name) ?? []) {
			const patch = await handler(merged, ctx);
			if (patch && typeof patch === "object") merged = { ...merged, ...patch };
		}
		return merged;
	};
	const events: TranscriptEvent[] = [];
	const guidance: string[] = [];
	const inputs: Record<string, unknown>[] = [];
	const context = async () => {
		const projection = await emit("context", { messages: [] });
		for (const message of projection.messages as Array<{ content: string | Array<{ type: string; text?: string }> }>)
			guidance.push(
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => part.text ?? "").join("\n"),
			);
	};
	return {
		tools,
		events,
		guidance,
		inputs,
		context,
		start: () => emit("session_start", { reason: "startup" }),
		close: () => emit("session_shutdown", { reason: "shutdown" }),
		active: () => active,
		async call(step: FixtureStep) {
			await emit("turn_start");
			await context();
			const tool = tools.get(step.name)!;
			assert.ok(tool, step.name);
			const args = structuredClone(step.args);
			assert.equal(Compile(tool.parameters).Check(args), true, `outer schema: ${step.name}`);
			const id = `call-${events.length}`;
			events.push({ type: "tool_call", id, name: step.name, arguments: structuredClone(args) });
			await emit("tool_execution_start", { toolName: step.name, toolCallId: id, args });
			const decision = await emit("tool_call", { toolName: step.name, toolCallId: id, input: args });
			inputs.push(args);
			let result: Result;
			let isError = false;
			if (decision.block) {
				isError = true;
				result = { content: [{ type: "text", text: String(decision.reason) }], details: {} };
			} else {
				try {
					result = await tool.execute(id, args, new AbortController().signal, undefined, ctx);
				} catch (error) {
					isError = true;
					result = { content: [{ type: "text", text: (error as Error).message }], details: {} };
				}
				const corrected = await emit("tool_result", {
					toolName: step.name,
					toolCallId: id,
					input: args,
					...result,
					isError,
				});
				result = { content: corrected.content as Result["content"], details: corrected.details as Result["details"] };
				isError = corrected.isError === true;
			}
			await emit("tool_execution_end", { toolName: step.name, toolCallId: id, result, isError });
			const text = result.content.map((part) => part.text).join("\n");
			events.push({
				type: "tool_result",
				toolCallId: id,
				name: step.name,
				content: text,
				...(isError ? { error: { message: text } } : {}),
			});
			return { text, isError };
		},
	};
}

test("suite resources resolve without model execution and variants differ only by mode", () => {
	piSdkAdapter.validate!({
		suitePath,
		subjectKind: suite.subject.kind,
		subjectConfig: suite.subject.config,
		cases: suite.cases,
	});
	for (const variant of suite.subject.variants)
		assert.ok(
			piSdkAdapter.resolve({
				suitePath,
				subjectKind: suite.subject.kind,
				subjectConfig: suite.subject.config,
				variant,
			}),
		);
	assert.deepEqual(suite.subject.variants[1].config, {
		...(suite.subject.variants[0].config as object),
		extensionFlags: { "policy-mode": "observe" },
	});
	assert.equal(suite.adjudication.policy, "human-required");
	assert.equal("participants" in suite, false);
	assert.match(JSON.stringify(suite.adjudication.metadata), /not_assessed/);
	assert.deepEqual(
		new Set(suite.cases.map((entry) => (entry.input as unknown as { fixture: CaseFixture }).fixture.group)),
		new Set(["mechanism", "hard-negative", "authority", "nonactivation", "adaptive"]),
	);
});

for (const mode of ["enforce", "observe"] as const)
	for (const entry of suite.cases) {
		test(`${mode}: ${entry.id} checks reflect real fixture hook outcomes`, async () => {
			const run = harness(mode);
			const fixture = (entry.input as unknown as { fixture: CaseFixture }).fixture;
			try {
				await run.start();
				assert.equal(
					run.active().some((name) => ["bash", "read", "write", "edit"].includes(name)),
					false,
				);
				for (const step of fixture.script) await run.call(step);
				await run.context();
				const checked = runDeterministicChecks(
					entry.id === "no-tool-task" ? "31.50" : "",
					entry.checks,
					run.events,
					entry.id,
				);
				assert.deepEqual(
					checked.filter((check) => !check.passed).map((check) => check.checkId),
					mode === "observe" ? fixture.expectedObserveMisses : [],
				);
				if (entry.id === "effective-deny" || entry.id === "collision")
					assert.deepEqual(
						run.inputs[0],
						fixture.script[0].args,
						"refusal or observe must preserve original arguments",
					);
				if (entry.id === "preview") {
					const result = run.events.find((event) => event.type === "tool_result") as { content: string };
					const view = JSON.parse(result.content);
					assert.equal(view.stateAdvanced, false);
					assert.deepEqual(view.input.candidate, { scenario: "rename", room: "room-7" });
					assert.deepEqual(
						view.executionInput,
						mode === "enforce" ? { scenario: "rename", room: "room-7" } : { scenario: "rename", oldRoom: "room-7" },
					);
					assert.equal(view.wouldCorrectInput, mode === "enforce");
					assert.equal(view.mode, mode);
				}
				if (fixture.group === "adaptive") {
					assert.equal(run.guidance.length, mode === "enforce" ? 1 : 0);
					if (mode === "enforce")
						assert.match(run.guidance[0], entry.id === "retry-guidance" ? /scenario recover/ : /scenario summary/);
					await run.context();
					assert.equal(run.guidance.length, mode === "enforce" ? 1 : 0, "guidance is once per period");
				} else assert.equal(run.guidance.length, 0);
			} finally {
				await run.close();
			}
		});
	}

test("positive outcomes cannot pass from a final answer without tool evidence", () => {
	for (const entry of suite.cases.filter((entry) => entry.id !== "no-tool-task")) {
		const fixture = (entry.input as unknown as { fixture: CaseFixture }).fixture;
		const checks = runDeterministicChecks(fixture.gold, entry.checks, [], entry.id);
		assert.ok(
			checks.some((check) => !check.passed),
			entry.id,
		);
	}
	const arithmetic = suite.cases.find((entry) => entry.id === "no-tool-task")!;
	assert.ok(
		runDeterministicChecks(
			"31.50",
			arithmetic.checks,
			[{ type: "tool_call", id: "forbidden", name: "policy_rules", arguments: {} }],
			arithmetic.id,
		).some((check) => !check.passed),
	);
});

test("fixture restores ambient configuration and removes only its own private store", async () => {
	const before = process.env.PI_POLICY_DIR;
	const run = harness("enforce");
	assert.equal(process.env.PI_POLICY_DIR, before);
	let dir = "";
	try {
		await run.start();
		const health = await run.call({ name: "policy_rules", args: { view: "health" } });
		dir = dirname(JSON.parse(health.text).authority.path);
		await access(dir);
	} finally {
		await run.close();
	}
	assert.ok(dir);
	await assert.rejects(access(dir), { code: "ENOENT" });
	assert.equal(process.env.PI_POLICY_DIR, before);
});
