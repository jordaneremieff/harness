import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuleSnapshot } from "./local-rules.ts";
import type { PolicyMode } from "./mode.ts";
import { validateFactsProgram, type FactsProgram, type InputPlan, type ProgramEvaluation } from "./program.ts";
import type { PolicyRecord } from "./record.ts";
import type { RuleRecord } from "./rule.ts";
import { PolicyRuntime } from "./runtime.ts";
import { PolicyWriter } from "./store.ts";

function rule(id: string, program: FactsProgram): RuleRecord {
	assert.equal(validateFactsProgram(program), undefined, id);
	return {
		id,
		domain: "facts",
		source: { kind: "package" },
		matcher: { kind: "declarative", language: "facts/v1", spec: program },
		definition: {
			revision: "123456abcdef",
			state: "active",
			effect: program.action.kind === "guide" ? "steer" : "correct",
			note: `Rule ${id}.`,
		},
		matcherAvailable: true,
		staleOverride: false,
	};
}

function rules(): RuleRecord[] {
	return [
		rule("rename", {
			phase: "input",
			when: { op: "exists", path: ["input", "old"] },
			action: { kind: "rename-key", path: [], from: "old", to: "name" },
			onUnavailable: "skip",
		}),
		rule("guide.error", {
			phase: "result",
			when: { op: "eq", path: ["result", "isError"], value: true },
			action: { kind: "guide", text: "Inspect the error result." },
			onUnavailable: "skip",
		}),
		rule("guide.input", {
			phase: "result",
			when: { op: "eq", path: ["input", "name"], value: "x" },
			action: { kind: "guide", text: "Inspect the corrected input." },
			onUnavailable: "skip",
		}),
		rule("guide.original", {
			phase: "result",
			when: {
				all: [
					{ op: "eq", path: ["original", "old"], value: "x" },
					{ not: { op: "exists", path: ["original", "name"] } },
				],
			},
			action: { kind: "guide", text: "Inspect the original input." },
			onUnavailable: "skip",
			state: {
				observe: { op: "eq", path: ["outcome", "kind"], value: "execution-error" },
				totalPath: ["outcome", "outputBytes"],
				once: "period",
			},
		}),
		rule("result.error", {
			phase: "result",
			when: { op: "eq", path: ["result", "details", "failed"], value: true },
			action: { kind: "assert-error" },
			onUnavailable: "skip",
		}),
	];
}

interface Preview {
	preview: boolean;
	stateAdvanced: boolean;
	input: InputPlan;
	results: ProgramEvaluation[];
}

function fixture(mode: PolicyMode = "enforce", records = rules()) {
	const snapshot: RuleSnapshot = {
		records: new Map(records.map((record) => [record.id, record])),
		pending: [],
		data: new Map(),
		health: { status: "ok", path: "rules.jsonl" },
	};
	const telemetry: PolicyRecord[] = [];
	const writer = new PolicyWriter(
		"/unused",
		(reason) => assert.fail(reason),
		async (_dir, record) => {
			telemetry.push(record);
			return null;
		},
	);
	const ctx = {
		mode: "print",
		cwd: "/project",
		model: { provider: "test", id: "model" },
		sessionManager: { getSessionId: () => "session" },
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
	const pi = {
		getAllTools: () => [
			{
				name: "sample",
				parameters: {
					type: "object",
					properties: { old: { type: "string" }, name: { type: "string" } },
					additionalProperties: false,
				},
				execute: () => assert.fail("Preview must not execute a tool"),
			},
		],
		getActiveTools: () => ["sample"],
	} as unknown as ExtensionAPI;
	const runtime = new PolicyRuntime(
		pi,
		async () => snapshot,
		() => mode,
		"/unused",
		() => true,
		writer,
	);
	runtime.sync(snapshot);
	const preview = (input: Record<string, unknown>, result: { isError: boolean; details: unknown }) =>
		runtime.inspect("preview", { tool: "sample", input, result }, ctx) as Promise<Preview>;
	const live = async (input: Record<string, unknown>, result: { isError: boolean; details: unknown }) => {
		const identity = { toolName: "sample", toolCallId: "live" };
		await runtime.toolStart({ ...identity, args: input }, ctx);
		assert.equal(await runtime.toolCall({ type: "tool_call", ...identity, input }, ctx), undefined);
		const content = [{ type: "text" as const, text: "body" }];
		const patch = await runtime.toolResult({ type: "tool_result", ...identity, input, content, ...result }, ctx);
		const effective = { ...result, content, ...patch };
		await runtime.toolEnd({ ...identity, result: effective, isError: effective.isError }, ctx);
		return patch;
	};
	return { runtime, ctx, writer, telemetry, preview, live };
}

function evaluations(rows: Array<{ id: string; truth: unknown; action: unknown }>) {
	return rows
		.filter((row) => row.id !== "rename")
		.map(({ id, truth }) => ({ id, truth }))
		.sort((left, right) => left.id.localeCompare(right.id));
}

async function inspectState(f: ReturnType<typeof fixture>) {
	return {
		state: await f.runtime.inspect("state", {}, f.ctx),
		health: await f.runtime.inspect("health", {}, f.ctx),
	};
}

describe("preview correction order", () => {
	for (const mode of ["observe", "notice", "annotate", "enforce"] as const) {
		it(`${mode} preserves original input and matches runtime result conditions`, async (t) => {
			const f = fixture(mode);
			t.after(() => f.writer.close());
			const input = { old: "x" };
			const result = { isError: false, details: { failed: true } };
			const preview = await f.preview(input, result);
			assert.deepEqual(input, { old: "x" });
			assert.deepEqual(result, { isError: false, details: { failed: true } });
			assert.equal(preview.input.valid, true);
			assert.equal(preview.input.denied, false);
			if (mode === "enforce") assert.deepEqual(preview.input.candidate, { name: "x" });
			assert.equal(preview.results.find((row) => row.id === "result.error")?.truth, true);
			assert.equal(preview.results.find((row) => row.id === "guide.error")?.truth, mode === "enforce");
			assert.equal(
				preview.results.find((row) => row.id === "guide.input")?.truth,
				mode === "enforce" ? true : "unknown",
			);
			assert.equal(preview.results.find((row) => row.id === "guide.original")?.truth, true);
			const patch = await f.live(input, result);
			assert.deepEqual(input, mode === "enforce" ? { name: "x" } : { old: "x" });
			assert.equal(patch?.isError, mode === "enforce" ? true : undefined);
			const text = patch?.content?.map((part) => (part.type === "text" ? part.text : "")).join(" ") ?? "";
			assert.equal(text.includes("Inspect the error result."), mode === "enforce");
			assert.equal(text.includes("Inspect the corrected input."), mode === "enforce");
			assert.equal(text.includes("Inspect the original input."), mode === "enforce" || mode === "annotate");
			await f.writer.close();
			assert.equal(f.telemetry.length, 1);
			assert.deepEqual(
				evaluations(preview.results),
				evaluations(f.telemetry[0].policy!.evaluations as ProgramEvaluation[]),
			);
		});
	}

	it("does not assert an error when the error condition is false", async (t) => {
		const f = fixture();
		t.after(() => f.writer.close());
		const result = { isError: false, details: { failed: false } };
		const preview = await f.preview({ old: "x" }, result);
		assert.equal(preview.results.find((row) => row.id === "result.error")?.truth, false);
		assert.equal(preview.results.find((row) => row.id === "guide.error")?.truth, false);
		assert.equal((await f.live({ old: "x" }, result))?.isError, undefined);
	});

	it("preserves an existing error without another error assertion", async (t) => {
		const f = fixture();
		t.after(() => f.writer.close());
		const result = { isError: true, details: { failed: false } };
		const preview = await f.preview({ old: "x" }, result);
		assert.equal(preview.results.find((row) => row.id === "result.error")?.truth, false);
		assert.equal(preview.results.find((row) => row.id === "guide.error")?.truth, true);
		const patch = await f.live({ old: "x" }, result);
		assert.equal(patch?.isError, undefined);
		assert.match(JSON.stringify(patch), /Inspect the error result\./);
	});

	it("uses corrected input and preserved original input for error assertions", async (t) => {
		const records = rules();
		records[records.length - 1] = rule("result.error", {
			phase: "result",
			when: {
				all: [
					{ op: "eq", path: ["input", "name"], value: "x" },
					{ op: "eq", path: ["original", "old"], value: "x" },
				],
			},
			action: { kind: "assert-error" },
			onUnavailable: "skip",
		});
		const f = fixture("enforce", records);
		t.after(() => f.writer.close());
		const result = { isError: false, details: {} };
		const preview = await f.preview({ old: "x" }, result);
		assert.equal(preview.results.find((row) => row.id === "result.error")?.truth, true);
		assert.equal(preview.results.find((row) => row.id === "guide.error")?.truth, true);
		assert.equal((await f.live({ old: "x" }, result))?.isError, true);
	});

	it("preserves empty and populated counters, projection allowance, and telemetry", async (t) => {
		const f = fixture();
		t.after(() => f.writer.close());
		const input = { old: "x" };
		const result = { isError: false, details: { failed: true } };
		const empty = await inspectState(f);
		for (let index = 0; index < 2; index++) {
			const preview = await f.preview(input, result);
			assert.equal(preview.preview, true);
			assert.equal(preview.stateAdvanced, false);
			assert.deepEqual(await inspectState(f), empty);
		}
		const patch = await f.live({ ...input }, result);
		assert.match(JSON.stringify(patch), /Inspect the original input\./);
		const populated = await inspectState(f);
		const periods = (
			populated.state as {
				observationPeriods: Array<{ id: string; count: number; total: number; projected: number; eligible: boolean }>;
			}
		).observationPeriods;
		const original = periods.find((period) => period.id === "guide.original")!;
		assert.equal(original.count, 1);
		assert.ok(original.total > 0);
		assert.equal(original.projected, 1);
		assert.equal(original.eligible, false);
		await f.preview(input, result);
		assert.deepEqual(await inspectState(f), populated);
		assert.deepEqual(input, { old: "x" });
		assert.deepEqual(result, { isError: false, details: { failed: true } });
		await f.writer.close();
		assert.equal(f.telemetry.length, 1);
		assert.equal(f.telemetry[0].callId, "live");
	});
});
