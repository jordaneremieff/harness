import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuleSnapshot } from "./local-rules.ts";
import type { NamedData } from "./data.ts";
import type { PolicyMode } from "./mode.ts";
import type { FactsProgram } from "./program.ts";
import type { PolicyRecord } from "./record.ts";
import type { RuleRecord } from "./rule.ts";
import { PolicyRuntime } from "./runtime.ts";
import { PACKAGE_CATALOG } from "./catalog.ts";
import { PolicyWriter } from "./store.ts";

const yes = { op: "exists" as const, path: ["input"] };
const success = { op: "eq" as const, path: ["outcome", "kind"], value: "success" };
function rule(id: string, program: FactsProgram): RuleRecord {
	return {
		id,
		source: { kind: "package" },
		matcher: { kind: "declarative", language: "facts/v1", spec: program },
		definition: {
			purpose: `Preserve ${id}.`,
			authority: "exact",
			revision: "123456abcdef",
			state: "active",
			effect:
				program.action.kind === "deny"
					? "block"
					: program.action.kind === "guide"
						? "steer"
						: program.action.kind === "observe"
							? "observe"
							: "correct",
			note: `Rule ${id}.`,
		},
		matcherAvailable: true,
		staleOverride: false,
	};
}
function fixture(
	programs: RuleRecord[],
	mode: PolicyMode = "enforce",
	schema: unknown = Type.Object(
		{ old: Type.Optional(Type.String()), name: Type.Optional(Type.String()) },
		{ additionalProperties: false },
	),
	fail = false,
	directory = "/unused",
	toolName = "sample",
) {
	const snapshot: RuleSnapshot = {
		records: new Map(programs.map((r) => [r.id, r])),
		pending: [],
		data: new Map(),
		health: { status: "ok", path: "rules.jsonl" },
	};
	const records: PolicyRecord[] = [];
	const notifications: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const failures: string[] = [];
	const writer = new PolicyWriter(
		"/unused",
		(reason) => failures.push(reason),
		async (_dir, record) => {
			if (fail) return "disk unavailable";
			records.push(record);
			return null;
		},
	);
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/project",
		model: { provider: "test", id: "model" },
		sessionManager: { getSessionId: () => "session" },
		getSystemPrompt: () => "",
		ui: { notify: (text: string) => notifications.push(text) },
	} as unknown as ExtensionContext;
	const pi = {
		getAllTools: () => [{ name: toolName, parameters: schema }],
		getActiveTools: () => [toolName],
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	let runtime: PolicyRuntime;
	let loadGate: Promise<void> | undefined;
	const load = async () => {
		if (loadGate) await loadGate;
		runtime.sync(snapshot);
		return snapshot;
	};
	runtime = new PolicyRuntime(
		pi,
		load,
		() => mode,
		directory,
		() => true,
		writer,
	);
	runtime.sync(snapshot);
	runtime.attach();
	const inputs = new Map<string, Record<string, unknown>>();
	const call = async (id: string, input: Record<string, unknown>) => {
		inputs.set(id, input);
		await runtime.toolStart({ toolName, toolCallId: id, args: input }, ctx);
		return runtime.toolCall({ type: "tool_call", toolName, toolCallId: id, input }, ctx);
	};
	const finish = async (id: string, isError = false, details: unknown = {}) =>
		runtime.toolEnd(
			{ toolName, toolCallId: id, isError, result: { content: [{ type: "text", text: "body" }], details } },
			ctx,
		);
	const result = async (id: string, isError = false, details: unknown = {}) =>
		runtime.toolResult(
			{
				type: "tool_result",
				toolName,
				toolCallId: id,
				input: inputs.get(id) ?? {},
				isError,
				content: [{ type: "text", text: "body" }],
				details,
			},
			ctx,
		);
	const views = async () =>
		(
			(await runtime.inspect("state", {}, ctx)) as {
				observationPeriods: Array<{
					id: string;
					count: number;
					projected: number;
					generation: number;
					resetReason: string;
				}>;
			}
		).observationPeriods;
	return {
		snapshot,
		pi,
		runtime,
		call,
		finish,
		result,
		views,
		records,
		writer,
		ctx,
		notifications,
		handlers,
		failures,
		setLoadGate: (gate: Promise<void> | undefined) => {
			loadGate = gate;
		},
	};
}
const rename = () =>
	rule("rename", {
		phase: "input",
		when: yes,
		action: { kind: "rename-key", path: [], from: "old", to: "name" },
		onUnavailable: "skip",
	});
const guide = () =>
	rule("guide", {
		phase: "context",
		selector: { tools: ["sample"] },
		when: { op: "gte", path: ["state", "count"], value: 1 },
		action: { kind: "guide", text: "Inspect the completed outcome." },
		onUnavailable: "skip",
		state: { observe: success, once: "period" },
	});

function shellRule(effect: "block" | "steer" = "block"): RuleRecord {
	const row = PACKAGE_CATALOG.find((record) => record.id === "routing.cat-read")!;
	return {
		id: row.id,
		source: { kind: "package" },
		matcher: row.matcher,
		definition: {
			purpose: row.purpose,
			authority: row.authority,
			revision: row.revision,
			state: "active",
			effect,
			note: row.note,
		},
		matcherAvailable: true,
		staleOverride: false,
	};
}
function commandTable(value: string): NamedData {
	return {
		kind: "table",
		name: "commands",
		revision: "aabbccddeeff",
		source: "approved-commands",
		capturedAt: Date.now() - 1000,
		maxAgeMs: 60000,
		rows: [{ key: "printf safe", value }],
	};
}
function correctedBash(blocker: RuleRecord, mode: PolicyMode = "enforce", target = "cat notes.md") {
	const correction = rule("command.correction", {
		phase: "input",
		selector: { tools: ["bash"] },
		when: { op: "exists", path: ["input", "command"] },
		action: { kind: "substitute", path: ["command"], table: "commands" },
		data: ["commands"],
		onUnavailable: "skip",
	});
	const f = fixture(
		[correction, blocker],
		mode,
		Type.Object({ command: Type.String() }, { additionalProperties: false }),
		false,
		"/unused",
		"bash",
	);
	f.snapshot.data.set("commands", commandTable(target));
	return f;
}

describe("effective command checks", () => {
	it("blocks an approved correction that introduces a package-denied command without mutating input", async () => {
		const f = correctedBash(shellRule());
		const input = { command: "printf safe" };
		const preview = (await f.runtime.inspect("preview", { tool: "bash", input }, f.ctx)) as {
			input: {
				denied: boolean;
				changed: boolean;
				candidate: unknown;
				evaluations: Array<{ id: string; deny: boolean }>;
			};
		};
		assert.equal(preview.input.denied, true);
		assert.equal(preview.input.changed, false);
		assert.deepEqual(preview.input.candidate, input);
		assert.ok(preview.input.evaluations.some((entry) => entry.id === "routing.cat-read" && entry.deny));
		const decision = await f.call("corrected", input);
		assert.equal(decision?.block, true);
		assert.deepEqual(input, { command: "printf safe" });
		await f.runtime.toolEnd(
			{
				toolName: "bash",
				toolCallId: "corrected",
				isError: true,
				result: { content: [{ type: "text", text: decision!.reason }] },
			},
			f.ctx,
		);
		await f.writer.close();
		assert.equal(f.records[0].outcome, "denied");
		assert.equal(f.records[0].policy?.inputCorrected, undefined);
		assert.ok(f.records[0].classes.includes("routing.cat-read"));
	});
	it("applies approved local command shapes to the final candidate", async () => {
		const blocker: RuleRecord = {
			...shellRule(),
			id: "local.walk",
			matcher: { kind: "declarative", language: "command-shape/v1", spec: { command: "walk" } },
			source: {
				kind: "local",
				proposalId: "test-proposal",
				approvedAudit: { surface: "command", session: "session", model: null, at: new Date().toISOString() },
			},
		};
		const f = correctedBash(blocker, "enforce", "walk target");
		const input = { command: "printf safe" };
		assert.equal((await f.call("local", input))?.block, true);
		assert.deepEqual(input, { command: "printf safe" });
		await f.writer.close();
	});
	for (const mode of ["observe", "notice", "annotate"] as const)
		it(`${mode} checks actual commands without activating hypothetical candidate matches`, async () => {
			const f = correctedBash(shellRule(), mode);
			const input = { command: "printf safe" };
			assert.equal(await f.call("observed", input), undefined);
			assert.deepEqual(input, { command: "printf safe" });
			await f.result("observed");
			await f.finish("observed");
			await f.writer.close();
			assert.equal(f.records[0].classes.includes("routing.cat-read"), false);
			assert.equal(f.records[0].policy?.inputCorrected, undefined);
		});
	it("refuses a correction when a captured command rule generation changes", async () => {
		const f = correctedBash(shellRule());
		const input = { command: "printf safe" };
		await f.runtime.toolStart({ toolName: "bash", toolCallId: "stale", args: input }, f.ctx);
		f.runtime.reset(["routing.cat-read"], "operator reset");
		const decision = await f.runtime.toolCall(
			{ type: "tool_call", toolName: "bash", toolCallId: "stale", input },
			f.ctx,
		);
		assert.equal(decision?.block, true);
		assert.deepEqual(input, { command: "printf safe" });
		await f.writer.close();
	});
	it("retains an originally matched steer command class when its result is an error", async () => {
		const f = fixture(
			[shellRule("steer")],
			"enforce",
			Type.Object({ command: Type.String() }),
			false,
			"/unused",
			"bash",
		);
		await f.call("failed", { command: "cat notes.md" });
		assert.equal(await f.result("failed", true), undefined);
		await f.finish("failed", true);
		await f.writer.close();
		assert.deepEqual(f.records[0].classes, ["routing.cat-read"]);
		assert.equal(f.records[0].annotated, undefined);
		assert.equal(f.records[0].outcome, "execution-error");
	});
});

describe("normalized execution plans", () => {
	it("keeps every mixed final denial in one plan and leaves arguments unchanged", async () => {
		const f = correctedBash(shellRule());
		const structured = rule("structured.final", {
			phase: "input",
			inputView: "effective",
			when: { op: "eq", path: ["input", "command"], value: "cat notes.md" },
			action: { kind: "deny" },
			onUnavailable: "skip",
		});
		f.snapshot.records.set(structured.id, structured);
		f.runtime.sync(f.snapshot);
		const input = { command: "printf safe" };
		const decision = await f.call("mixed", input);
		assert.equal(decision?.block, true);
		assert.deepEqual(input, { command: "printf safe" });
		await f.runtime.toolEnd(
			{
				toolName: "bash",
				toolCallId: "mixed",
				isError: true,
				result: { content: [{ type: "text", text: decision!.reason }] },
			},
			f.ctx,
		);
		await f.writer.close();
		const evaluations = f.records[0].policy?.evaluations as Array<{ id: string; inputView?: string; deny: boolean }>;
		assert.deepEqual(
			evaluations.filter((row) => row.inputView === "effective" && row.deny).map((row) => row.id),
			["routing.cat-read", "structured.final"],
		);
	});
	it("refuses corrections after any captured final gate changes its observation period", async () => {
		const gate = rule("final", {
			phase: "input",
			inputView: "effective",
			when: { op: "exists", path: ["input", "blocked"] },
			action: { kind: "deny" },
			onUnavailable: "skip",
		});
		const f = fixture([rename(), gate]);
		const input = { old: "x" };
		await f.runtime.toolStart({ toolName: "sample", toolCallId: "stale-final", args: input }, f.ctx);
		f.runtime.reset([gate.id], "Approved reset");
		assert.equal(
			(await f.runtime.toolCall({ type: "tool_call", toolName: "sample", toolCallId: "stale-final", input }, f.ctx))
				?.block,
			true,
		);
		assert.deepEqual(input, { old: "x" });
		await f.writer.close();
	});
	it("refuses a correction on nonwritable arguments before any input write", async () => {
		const f = fixture([rename()]);
		const input = Object.freeze({ old: "x" });
		assert.equal((await f.call("frozen", input))?.block, true);
		assert.deepEqual(input, { old: "x" });
		await f.writer.close();
	});
	for (const mode of ["observe", "notice", "annotate", "enforce"] as const)
		it(`${mode} previews the same corrected-result then guidance sequence as execution`, async () => {
			const error = rule("error", {
				phase: "result",
				when: { op: "eq", path: ["result", "details", "failed"], value: true },
				action: { kind: "assert-error" },
				onUnavailable: "skip",
			});
			const guide = rule("result.guide", {
				phase: "result",
				when: {
					all: [
						{ op: "exists", path: ["input", "name"] },
						{ op: "eq", path: ["result", "isError"], value: true },
					],
				},
				action: { kind: "guide", text: "Inspect the corrected error." },
				onUnavailable: "skip",
			});
			const f = fixture([rename(), error, guide], mode);
			const input = { old: "x" };
			const preview = (await f.runtime.inspect(
				"preview",
				{ tool: "sample", input, result: { isError: false, details: { failed: true } } },
				f.ctx,
			)) as { resultCorrected: boolean; results: Array<{ id: string; truth: boolean }> };
			assert.deepEqual(input, { old: "x" });
			await f.call("previewed", input);
			const result = await f.result("previewed", false, { failed: true });
			assert.equal(preview.resultCorrected, result?.isError === true);
			assert.equal(preview.results.find((row) => row.id === guide.id)?.truth, mode === "enforce");
			assert.equal(result?.content !== undefined, mode === "enforce");
			await f.writer.close();
		});
	it("omits absent result fields and shares text-content schema evidence between preview and execution", async () => {
		const check = rule("result.schema", {
			phase: "result",
			when: { op: "matches-schema", path: ["result"], schemaData: "errors" },
			data: ["errors"],
			action: { kind: "assert-error" },
			onUnavailable: "skip",
		});
		const f = fixture([check]);
		f.snapshot.data.set("errors", {
			kind: "schema",
			name: "errors",
			revision: "abcdef123456",
			source: "approved-result-contract",
			capturedAt: Date.now(),
			schema: {
				type: "object",
				properties: {
					tool: { const: "sample" },
					isError: { const: false },
					details: { type: "object", properties: { failed: { const: true } }, required: ["failed"] },
					content: {
						type: "array",
						items: {
							type: "object",
							properties: { type: { const: "text" }, text: { const: "body" } },
							required: ["type", "text"],
						},
						minItems: 1,
					},
				},
				required: ["tool", "isError", "details", "content"],
				additionalProperties: false,
			},
		});
		const preview = (await f.runtime.inspect(
			"preview",
			{ tool: "sample", input: {}, result: { details: { failed: true }, content: [{ type: "text", text: "body" }] } },
			f.ctx,
		)) as { resultCorrected: boolean; results: Array<{ truth: unknown }> };
		assert.equal(preview.resultCorrected, true);
		assert.equal(preview.results[0].truth, true);
		await f.call("absent-optionals", {});
		assert.equal((await f.result("absent-optionals", false, { failed: true }))?.isError, true);
		await f.writer.close();
	});
	it("uses common applicability before captured matches, guidance, and completed observations", async () => {
		for (const active of [true, false, "unknown"] as const) {
			const record = shellRule("steer");
			record.definition.applicability = { op: "eq", path: ["context", "tools", "read", "active"], value: true };
			const f = fixture([record], "enforce", Type.Object({ command: Type.String() }), false, "/unused", "bash");
			if (active === "unknown")
				f.pi.getAllTools = () => {
					throw new Error("Catalog unavailable");
				};
			else if (active) {
				const tools = f.pi.getAllTools();
				f.pi.getAllTools = () => [...tools, { ...tools[0], name: "read" }];
				f.pi.getActiveTools = () => ["bash", "read"];
			}
			await f.call("applicability", { command: "cat notes.md" });
			assert.equal((await f.result("applicability"))?.content !== undefined, active === true);
			await f.finish("applicability");
			assert.equal((await f.views())[0].count, active === true ? 1 : 0);
			await f.writer.close();
			assert.deepEqual(f.records[0].classes, active === true ? [record.id] : []);
		}
	});
	it("keeps unavailable evaluations separate from true match classes and retains required denial guidance", async () => {
		for (const required of [false, true]) {
			const check = rule("schema.check", {
				phase: "input",
				when: { op: "eq", path: ["schema", "valid"], value: false },
				action: { kind: "deny" },
				onUnavailable: required ? "deny" : "skip",
			});
			const f = fixture([check]);
			f.pi.getAllTools = () => [];
			const decision = await f.call("unavailable", {});
			assert.equal(decision?.block, required ? true : undefined);
			if (required) assert.match(decision!.reason, /Rule schema.check/);
			await f.finish("unavailable", required);
			await f.writer.close();
			assert.deepEqual(f.records[0].classes, []);
			const evaluations = f.records[0].policy?.evaluations as Array<{
				truth: unknown;
				unavailable: boolean;
				deny: boolean;
			}>;
			assert.equal(evaluations[0].truth, "unknown");
			assert.equal(evaluations[0].unavailable, true);
			assert.equal(evaluations[0].deny, required);
		}
	});
	it("invalidates admitted effects when an operator changes the effective action on the same record object", async () => {
		const record = shellRule("steer");
		const f = fixture([record], "enforce", Type.Object({ command: Type.String() }), false, "/unused", "bash");
		await f.call("changed-action", { command: "cat notes.md" });
		const before = (await f.views())[0].generation;
		record.override = {
			effect: "block",
			reason: "Require prevention",
			againstDefinitionRevision: record.definition.revision,
			audit: { surface: "command", session: "session", model: null, at: new Date().toISOString() },
		};
		assert.equal(await f.result("changed-action"), undefined);
		await f.finish("changed-action");
		const view = (await f.views())[0];
		assert.notEqual(view.generation, before);
		assert.equal(view.count, 0);
		assert.equal(view.projected, 0);
		await f.writer.close();
	});
	it("routes approved input guidance to a matched successful result without a new turn", async () => {
		const inputGuide = rule("input.guide", {
			phase: "input",
			when: { op: "eq", path: ["input", "name"], value: "special" },
			action: { kind: "guide", text: "Use the approved target." },
			onUnavailable: "skip",
		});
		const f = fixture([inputGuide]);
		await f.call("matching", { name: "special" });
		assert.match(JSON.stringify(await f.result("matching")), /Use the approved target/);
		await f.call("other", { name: "ordinary" });
		assert.equal(await f.result("other"), undefined);
		await f.call("error", { name: "special" });
		assert.equal(await f.result("error", true), undefined);
		await f.writer.close();
	});
});

describe("recorded call explanations", () => {
	it("reads current-session unmatched calls and only approved metadata fields", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "policy-explain-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const f = fixture(
			[
				rule("not-selected", {
					phase: "input",
					when: { op: "eq", path: ["tool"], value: "other" },
					action: { kind: "deny" },
					onUnavailable: "skip",
				}),
			],
			"observe",
			Type.Object({}),
			false,
			dir,
		);
		await f.call("trace", {});
		await f.result("trace");
		await f.finish("trace");
		await f.writer.close();
		const record = { ...f.records[0], policy: { ...f.records[0].policy, rawInput: "unretained-example-marker" } };
		await writeFile(
			join(dir, "2026-01-01.jsonl"),
			`${[JSON.stringify(record), JSON.stringify({ ...record, session: "another-session" })].join("\n")}\n`,
		);
		const explained = (await f.runtime.inspect("explain", { id: "call:trace" }, f.ctx)) as {
			records: Array<{
				session: string;
				classes: string[];
				policy: {
					evaluations: Array<{ truth: boolean }>;
					recordedCoverage: { evaluations: { total: number; omitted: number } };
				};
			}>;
		};
		assert.equal(explained.records.length, 1);
		assert.equal(explained.records[0].session, "session");
		assert.deepEqual(explained.records[0].classes, []);
		assert.equal(explained.records[0].policy.evaluations[0].truth, false);
		assert.deepEqual(explained.records[0].policy.recordedCoverage.evaluations, { total: 1, omitted: 0 });
		assert.equal(JSON.stringify(explained).includes("unretained-example-marker"), false);
	});
});

describe("input transactions and modes", () => {
	it("commits one schema-valid candidate and retains no private input in telemetry", async () => {
		const f = fixture([rename()]);
		const input = { old: "private-value" };
		assert.equal(await f.call("a", input), undefined);
		assert.deepEqual(input, { name: "private-value" });
		await f.result("a");
		await f.finish("a");
		await f.writer.close();
		assert.equal(f.records.length, 1);
		assert.doesNotMatch(JSON.stringify(f.records), /private-value|body/);
		assert.equal(f.records[0].policy?.inputCorrected, true);
	});
	it("blocks conflicts and invalid candidates without a partial input write", async () => {
		for (const records of [
			[
				rename(),
				rule("other", {
					phase: "input",
					when: yes,
					action: { kind: "rename-key", path: [], from: "old", to: "different" },
					onUnavailable: "skip",
				}),
			],
			[rename()],
		]) {
			const f = fixture(records, "enforce", Type.Object({ old: Type.String() }, { additionalProperties: false }));
			const input = { old: "x" };
			assert.equal((await f.call("a", input))?.block, true);
			assert.deepEqual(input, { old: "x" });
			await f.writer.close();
		}
	});
	it("checks original prohibitions before corrections and effective prohibitions before commit", async () => {
		for (const inputView of ["original", "effective"] as const) {
			const denial = rule("deny", {
				phase: "input",
				inputView,
				when: { op: "exists", path: ["input", inputView === "original" ? "old" : "name"] },
				action: { kind: "deny" },
				onUnavailable: "skip",
			});
			const f = fixture([rename(), denial]);
			const input = { old: "x" };
			assert.equal((await f.call("a", input))?.block, true);
			assert.deepEqual(input, { old: "x" });
			await f.writer.close();
		}
	});
	for (const mode of ["observe", "notice", "annotate"] as const)
		it(`${mode} leaves arguments and error flags unchanged`, async () => {
			const assertion = rule("error", {
				phase: "result",
				when: { op: "eq", path: ["result", "details", "failed"], value: true },
				action: { kind: "assert-error" },
				onUnavailable: "skip",
			});
			const f = fixture([rename(), assertion], mode);
			const input = { old: "x" };
			assert.equal(await f.call("a", input), undefined);
			assert.deepEqual(input, { old: "x" });
			assert.equal(await f.result("a", false, { failed: true }), undefined);
			await f.finish("a", false, { failed: true });
			await f.writer.close();
			assert.equal(f.records[0].error, false);
			assert.equal(f.notifications.length > 0, mode === "notice");
		});
	it("checks observational effective predicates against actual arguments", async () => {
		const denial = rule("effective", {
			phase: "input",
			inputView: "effective",
			when: { op: "exists", path: ["input", "name"] },
			action: { kind: "deny" },
			onUnavailable: "skip",
		});
		const f = fixture([rename(), denial], "observe");
		await f.call("a", { old: "x" });
		await f.result("a");
		await f.finish("a");
		await f.writer.close();
		const evaluations = f.records[0].policy?.evaluations as Array<{ id: string; truth: unknown }>;
		assert.equal(evaluations.find((e) => e.id === "effective")?.truth, false);
	});
	it("unavailable oversized input still honors required checks and preserves optional corrections", async () => {
		const input = { old: "x".repeat(262145) };
		const deny = rule("required", {
			phase: "input",
			when: { op: "eq", path: ["tool"], value: "sample" },
			action: { kind: "deny" },
			onUnavailable: "deny",
		});
		for (const mode of ["observe", "notice", "annotate", "enforce"] as const) {
			const f = fixture([deny], mode);
			assert.equal((await f.call("large", input))?.block, mode === "enforce" ? true : undefined);
			await f.writer.close();
		}
		const optional = fixture([rename()]);
		assert.equal(await optional.call("large", input), undefined);
		assert.equal(input.old.length, 262145);
		assert.equal(Object.hasOwn(input, "name"), false);
		await optional.writer.close();
	});
	it("degraded authority suppresses corrections and denials", async () => {
		const f = fixture([rename()]);
		f.snapshot.health.status = "degraded";
		const input = { old: "x" };
		assert.equal(await f.call("a", input), undefined);
		assert.deepEqual(input, { old: "x" });
		await f.writer.close();
	});
});

describe("asynchronous lifecycle boundaries", () => {
	for (const phase of ["start", "call", "result", "end", "context"] as const)
		it(`does not commit a stale ${phase} callback after a deferred registry read`, async () => {
			const f = fixture([
				rename(),
				guide(),
				rule("assertion", {
					phase: "result",
					when: { op: "eq", path: ["result", "details", "failed"], value: true },
					action: { kind: "assert-error" },
					onUnavailable: "skip",
				}),
			]);
			const input = { old: "x" };
			if (phase === "call")
				await f.runtime.toolStart({ toolName: "sample", toolCallId: "deferred", args: input }, f.ctx);
			if (phase === "result" || phase === "end" || phase === "context") await f.call("deferred", input);
			if (phase === "end" || phase === "context") await f.result("deferred");
			if (phase === "context") await f.finish("deferred");
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			f.setLoadGate(gate);
			const callback =
				phase === "start"
					? f.runtime.toolStart({ toolName: "sample", toolCallId: "deferred", args: input }, f.ctx)
					: phase === "call"
						? f.runtime.toolCall({ type: "tool_call", toolName: "sample", toolCallId: "deferred", input }, f.ctx)
						: phase === "result"
							? f.result("deferred", false, { failed: true })
							: phase === "end"
								? f.finish("deferred")
								: f.runtime.context(f.ctx);
			await f.handlers.get("session_tree")?.({}, f.ctx);
			release();
			assert.equal(await callback, undefined);
			f.setLoadGate(undefined);
			if (phase === "start")
				assert.equal(
					((await f.runtime.inspect("health", {}, f.ctx)) as { observations: { pending: number } }).observations
						.pending,
					0,
				);
			if (phase === "call") assert.deepEqual(input, { old: "x" });
			assert.equal((await f.views()).find((view) => view.id === "guide")?.count, 0);
			assert.equal((await f.views()).find((view) => view.id === "guide")?.projected, 0);
			await f.writer.close();
			assert.equal(f.records.length, phase === "context" ? 1 : 0);
		});
});

describe("final observations and guidance", () => {
	it("retains bounded pinned data identities and freshness without table or schema payloads", async () => {
		const correction = rule("value.correction", {
			phase: "input",
			when: yes,
			action: { kind: "substitute", path: ["name"], table: "values" },
			data: ["values"],
			onUnavailable: "skip",
		});
		const missing = rule("missing.data", {
			phase: "completion",
			when: { op: "exists", path: ["outcome"] },
			action: { kind: "observe", label: "metadata" },
			data: ["absent"],
			onUnavailable: "skip",
		});
		const f = fixture([correction, missing]);
		f.snapshot.data.set("values", {
			kind: "table",
			name: "values",
			revision: "111122223333",
			source: "approved-values",
			capturedAt: Date.now() - 1000,
			maxAgeMs: 60000,
			rows: [{ key: "payload-input", value: "payload-output" }],
		});
		f.snapshot.data.set("shape", {
			kind: "schema",
			name: "shape",
			revision: "444455556666",
			source: "approved-schema",
			capturedAt: Date.now() - 1000,
			schema: { type: "object", properties: { privateSchemaMarker: { const: "schema-payload" } } },
		});
		const input = { name: "payload-input" };
		await f.call("data", input);
		assert.deepEqual(input, { name: "payload-output" });
		f.snapshot.data.set("values", { ...f.snapshot.data.get("values")!, revision: "aaaabbbbcccc" });
		await f.result("data");
		await f.finish("data");
		await f.writer.close();
		const policy = f.records[0].policy as {
			dataSnapshots: Array<{
				name: string;
				revision?: string;
				status: string;
				ageMs?: number;
				maxAgeMs?: number;
				snapshotAt?: number;
			}>;
			coverage: { dataSnapshots: { total: number; omitted: number } };
		};
		assert.equal(policy.dataSnapshots.find((row) => row.name === "values")?.revision, "111122223333");
		assert.equal(policy.dataSnapshots.find((row) => row.name === "shape")?.revision, "444455556666");
		assert.equal(policy.dataSnapshots.find((row) => row.name === "values")?.status, "ready");
		assert.equal(policy.dataSnapshots.find((row) => row.name === "values")?.maxAgeMs, 60000);
		assert.equal(typeof policy.dataSnapshots.find((row) => row.name === "values")?.snapshotAt, "number");
		assert.equal(typeof policy.dataSnapshots.find((row) => row.name === "values")?.ageMs, "number");
		assert.equal(policy.dataSnapshots.find((row) => row.name === "absent")?.status, "missing");
		assert.deepEqual(policy.coverage.dataSnapshots, { total: 3, omitted: 0 });
		assert.ok(Buffer.byteLength(JSON.stringify(policy.dataSnapshots)) <= 32768);
		assert.doesNotMatch(
			JSON.stringify(f.records),
			/payload-input|payload-output|schema-payload|privateSchemaMarker|aaaabbbbcccc/,
		);
	});
	it("reports omitted named-data snapshots within the serialized byte bound", async () => {
		const rules = Array.from({ length: 100 }, (_, index) =>
			rule(`missing.rule${index}`, {
				phase: "completion",
				when: { op: "exists", path: ["outcome"] },
				action: { kind: "observe", label: "metadata" },
				onUnavailable: "skip",
				data: Array.from({ length: 16 }, (_, item) => `binding-${index}-${item}`),
			}),
		);
		const f = fixture(rules);
		await f.call("bounded", {});
		await f.result("bounded");
		await f.finish("bounded");
		await f.writer.close();
		const policy = f.records[0].policy as {
			dataSnapshots: unknown[];
			coverage: { dataSnapshots: { total: number; omitted: number } };
		};
		assert.equal(policy.coverage.dataSnapshots.total, 1600);
		assert.equal(policy.coverage.dataSnapshots.omitted, 1600 - policy.dataSnapshots.length);
		assert.ok(policy.coverage.dataSnapshots.omitted > 0);
		assert.ok(Buffer.byteLength(JSON.stringify(policy.dataSnapshots)) <= 32768);
	});
	it("corrects structural errors before stateless guidance and counts only the final end", async () => {
		const correction = rule("error", {
			phase: "result",
			when: { op: "eq", path: ["result", "details", "failed"], value: true },
			action: { kind: "assert-error" },
			onUnavailable: "skip",
		});
		const annotation = rule("annotation", {
			phase: "result",
			when: { op: "eq", path: ["result", "isError"], value: true },
			action: { kind: "guide", text: "Check the failed result." },
			onUnavailable: "skip",
			state: { observe: { op: "eq", path: ["outcome", "kind"], value: "execution-error" } },
		});
		const f = fixture([correction, annotation]);
		await f.call("a", {});
		const patch = await f.result("a", false, { failed: true });
		assert.equal(patch?.isError, true);
		const last = patch?.content?.at(-1);
		assert.match(last?.type === "text" ? last.text : "", /Check the failed result/);
		assert.equal(f.records.length, 0);
		assert.equal((await f.views()).find((v) => v.id === "annotation")?.count, 0);
		await f.finish("a", true, { failed: true });
		await f.finish("a", true, { failed: true });
		await f.writer.close();
		assert.equal(f.records.length, 1);
		assert.equal(f.records[0].outcome, "execution-error");
		assert.equal((await f.views()).find((v) => v.id === "annotation")?.count, 1);
	});
	it("records denial decisions separately when the host aborts before execution", async () => {
		const f = fixture([rule("deny", { phase: "input", when: yes, action: { kind: "deny" }, onUnavailable: "skip" })]);
		const denial = await f.call("a", {});
		assert.equal(denial?.block, true);
		const controller = new AbortController();
		controller.abort();
		await f.runtime.toolEnd(
			{
				toolName: "sample",
				toolCallId: "a",
				isError: true,
				result: { content: [{ type: "text", text: "Operation aborted" }] },
			},
			{ ...f.ctx, signal: controller.signal },
		);
		await f.writer.close();
		assert.equal(f.records[0].outcome, "unexecuted");
		assert.equal(f.records[0].abortRequested, true);
		assert.equal(f.records[0].errorKind, "aborted");
		assert.equal(f.records[0].blocked, undefined);
		assert.equal(f.records[0].policy?.decision, "deny");
	});
	it("does not infer an execution error cause from an abort request", async () => {
		const f = fixture([guide()]);
		await f.call("error", {});
		await f.result("error", true);
		const controller = new AbortController();
		controller.abort();
		await f.runtime.toolEnd(
			{
				toolName: "sample",
				toolCallId: "error",
				isError: true,
				result: { content: [{ type: "text", text: "Permission denied" }] },
			},
			{ ...f.ctx, signal: controller.signal },
		);
		await f.writer.close();
		assert.equal(f.records[0].outcome, "execution-error");
		assert.equal(f.records[0].abortRequested, true);
		assert.equal(f.records[0].errorKind, "other");
	});

	it("guides only when a configured alternative tool is active", async () => {
		const scoped = guide();
		if (scoped.matcher.kind !== "declarative" || scoped.matcher.language !== "facts/v1") assert.fail();
		scoped.matcher.spec.when = {
			all: [scoped.matcher.spec.when, { op: "eq", path: ["context", "tools", "alternative", "active"], value: true }],
		};
		const f = fixture([scoped]);
		await f.call("a", {});
		await f.result("a");
		await f.finish("a");
		assert.equal(await f.runtime.context(f.ctx), undefined);
		const tools = f.pi.getAllTools();
		f.pi.getAllTools = () => [...tools, { ...tools[0], name: "alternative" }];
		assert.equal(await f.runtime.context(f.ctx), undefined);
		f.pi.getActiveTools = () => ["sample", "alternative"];
		assert.match((await f.runtime.context(f.ctx)) ?? "", /Inspect the completed outcome/);
		await f.writer.close();
	});

	it("keeps unavailable tool catalogs unknown under negation", async () => {
		const scoped = guide();
		if (scoped.matcher.kind !== "declarative" || scoped.matcher.language !== "facts/v1") assert.fail();
		scoped.matcher.spec.when = { not: { op: "exists", path: ["context", "tools", "alternative"] } };
		const f = fixture([scoped]);
		f.pi.getAllTools = () => {
			throw new Error("catalog unavailable");
		};
		assert.equal(await f.runtime.context(f.ctx), undefined);
		assert.equal((await f.views())[0].projected, 0);
		await f.writer.close();
	});

	it("combines completed count, text volume, and distinct turns for context guidance", async () => {
		const scoped = guide();
		if (scoped.matcher.kind !== "declarative" || scoped.matcher.language !== "facts/v1") assert.fail();
		scoped.matcher.spec.when = {
			all: [
				{ op: "gte", path: ["state", "count"], value: 2 },
				{ op: "gte", path: ["state", "total"], value: 8 },
				{ op: "gte", path: ["state", "turns"], value: 2 },
			],
		};
		scoped.matcher.spec.state = { observe: success, totalPath: ["outcome", "preGuidanceBytes"], once: "period" };
		const f = fixture([scoped]);
		await f.handlers.get("turn_start")?.({}, f.ctx);
		await f.call("a", {});
		await f.result("a");
		await f.finish("a");
		assert.equal(await f.runtime.context(f.ctx), undefined);
		await f.handlers.get("turn_start")?.({}, f.ctx);
		await f.call("b", {});
		await f.result("b");
		await f.finish("b");
		assert.match((await f.runtime.context(f.ctx)) ?? "", /Inspect the completed outcome/);
		await f.writer.close();
		assert.equal(f.records[0].outputBytes, 4);
	});

	it("renders unavailable aggregate metrics explicitly in state inspection", async () => {
		const metric = rule("metric", {
			phase: "completion",
			when: { op: "exists", path: ["outcome"] },
			action: { kind: "observe", label: "amount" },
			onUnavailable: "skip",
			state: { observe: success, totalPath: ["result", "details", "amount"] },
		});
		const f = fixture([metric]);
		await f.call("a", {});
		await f.result("a");
		await f.finish("a");
		const text = JSON.stringify(await f.runtime.inspect("state", {}, f.ctx));
		assert.match(text, /"total":"unavailable"/);
		assert.match(text, /"turnTotal":"unavailable"/);
		await f.writer.close();
	});

	it("preserves unknown preflight outcomes rather than claiming an execution failure", async () => {
		const f = fixture([guide()]);
		await f.runtime.toolStart({ toolName: "sample", toolCallId: "a", args: {} }, f.ctx);
		await f.finish("a", true);
		await f.writer.close();
		assert.equal(f.records[0].outcome, "unexecuted");
		assert.equal(f.records[0].observationComplete, false);
		assert.equal((await f.views())[0].count, 0);
	});
	it("counts selected completions in order and projects grouped context without an extra turn", async () => {
		const f = fixture([guide()]);
		await f.call("first", {});
		await f.call("second", {});
		await f.result("second");
		await f.finish("second");
		assert.equal((await f.views())[0].count, 1);
		await f.result("first");
		await f.finish("first");
		assert.match((await f.runtime.context(f.ctx)) ?? "", /Inspect the completed outcome/);
		assert.equal(await f.runtime.context(f.ctx), undefined);
		await f.writer.close();
		assert.deepEqual(
			f.records.map((r) => r.callId),
			["second", "first"],
		);
		assert.equal((await f.views())[0].projected, 1);
	});
	it("ignores completion state and result effects after reset or semantic revision", async () => {
		for (const change of ["reset", "revision", "disable"]) {
			const f = fixture([guide(), rename()]);
			await f.call("a", { old: "x" });
			if (change === "reset") f.runtime.reset(undefined, "operator reset");
			else if (change === "revision") f.snapshot.records.get("guide")!.definition.revision = "abcdef123456";
			else
				f.snapshot.records.get("guide")!.override = {
					state: "disabled",
					reason: "test",
					againstDefinitionRevision: "123456abcdef",
					audit: { surface: "command", session: "session", model: null, at: new Date().toISOString() },
				};
			await f.result("a");
			await f.finish("a");
			assert.equal((await f.views()).find((v) => v.id === "guide")?.count ?? 0, 0);
			await f.writer.close();
		}
	});
	it("preserves observations across compaction and resets on tree navigation", async () => {
		const f = fixture([guide()]);
		await f.call("a", {});
		await f.result("a");
		await f.finish("a");
		assert.equal(f.handlers.has("session_compact"), false);
		assert.equal((await f.views())[0].count, 1);
		await f.handlers.get("session_tree")?.({}, f.ctx);
		assert.equal((await f.views())[0].count, 0);
		assert.equal((await f.views())[0].resetReason, "tree");
		await f.writer.close();
	});
	it("preview does not count outcomes or consume guidance eligibility", async () => {
		const f = fixture([guide(), rename()]);
		await f.call("a", {});
		await f.result("a");
		await f.finish("a");
		const before = await f.views();
		const input = { old: "x" };
		const preview = await f.runtime.inspect("preview", { tool: "sample", input, result: { isError: false } }, f.ctx);
		assert.deepEqual(await f.views(), before);
		assert.deepEqual(input, { old: "x" });
		assert.equal((preview as { stateAdvanced: boolean }).stateAdvanced, false);
		assert.match((await f.runtime.context(f.ctx)) ?? "", /Inspect the completed outcome/);
		await f.writer.close();
	});
	it("terminal identifier rollover does not disable result corrections", async () => {
		const f = fixture([
			rule("error", {
				phase: "result",
				when: { op: "eq", path: ["result", "details", "failed"], value: true },
				action: { kind: "assert-error" },
				onUnavailable: "skip",
			}),
		]);
		for (let index = 0; index < 8194; index++) {
			const id = `c${index}`;
			await f.call(id, {});
			assert.equal((await f.result(id, false, { failed: true }))?.isError, true);
			await f.finish(id, true);
		}
		const health = (await f.runtime.inspect("health", {}, f.ctx)) as {
			observations: { incomplete: number; recentCompletedIds: number };
		};
		assert.equal(health.observations.incomplete, 0);
		assert.equal(health.observations.recentCompletedIds, 8192);
		await f.writer.close();
		assert.equal(f.records.length, 8194);
	});
	it("writer failure does not cancel later approved mechanisms", async () => {
		const f = fixture([rename()], "enforce", undefined, true);
		await f.call("first", { old: "x" });
		await f.result("first");
		await f.finish("first");
		await f.writer.close();
		assert.deepEqual(f.failures, ["disk unavailable"]);
		const input = { old: "y" };
		await f.call("second", input);
		assert.deepEqual(input, { name: "y" });
	});
});
