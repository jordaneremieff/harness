import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import type { TranscriptEvent } from "vitest-evals";
import { piSdkAdapter, runDeterministicChecks } from "../../evals/subjects/pi-sdk.mts";
import { DEFAULT_LIMITS, PACKAGE_CATALOG, RESULT_ERROR_SCHEMA } from "./catalog.ts";
import { proposalRevision, RuleRegistry } from "./local-rules.ts";
import { packageRowRevision } from "./rule.ts";
import type { PolicyMode } from "./mode.ts";
import { PRODUCT_TOOLS, type ProductFixtureOptions, registerProductFixture } from "./product-fixture.ts";
import suite, { type ProductCaseFixture, type ProductStep } from "./product.eval.mts";

type Event = Record<string, unknown>;
type Handler = (event: Event, context: ExtensionContext) => Promise<unknown> | unknown;
type Command = { handler(args: string, ctx: ExtensionCommandContext): Promise<void> };
type Result = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
type Tool = {
	name: string;
	parameters: Parameters<typeof Compile>[0];
	execute(
		id: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<Result>;
};
type Period = {
	id: string;
	count: number;
	windowCount: number;
	windowTotal: number;
	projected: number;
	resetReason: string;
};
const suitePath = fileURLToPath(new URL("./product.eval.mts", import.meta.url));
const request = (scenario = "mutated-schema"): ProductStep => ({
	name: "policy_product_request",
	args: { scenario, count: 1 },
});
const failure = (attempt = 1): ProductStep => ({ name: "policy_product_recover", args: { path: "primary", attempt } });
const success: ProductStep = { name: "policy_product_recover", args: { path: "alternate", attempt: 1 } };
const volume = (bytes: number): ProductStep => ({ name: "policy_product_volume", args: { bytes } });

/** Public hook order, not an SDK inference run or a model response simulation. */
function harness(mode: PolicyMode, options: ProductFixtureOptions = {}) {
	const hooks = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	const notices: string[] = [];
	let active: string[] = [];
	let catalog: "ready" | "missing-schema" | "unavailable" = "ready";
	const ctx = {
		cwd: "/virtual/evals/policy-product",
		mode: "rpc",
		hasUI: true,
		model: { provider: "test", id: "fixture" },
		thinkingLevel: "off",
		sessionManager: { getSessionId: () => "synthetic-product-session" },
		getSystemPrompt: () => "",
		ui: { notify: (text: string) => notices.push(text) },
	} as unknown as ExtensionContext;
	registerProductFixture(
		{
			on(name: string, handler: Handler) {
				hooks.set(name, [...(hooks.get(name) ?? []), handler]);
			},
			registerTool(tool: Tool) {
				tools.set(tool.name, tool);
			},
			registerFlag() {},
			registerCommand(name: string, command: Command) {
				commands.set(name, command);
			},
			getFlag: () => mode,
			getAllTools: () => {
				if (catalog === "unavailable") throw new Error("Synthetic catalog unavailable");
				return [...tools.values()].map(({ name, parameters }) => ({
					name,
					...(catalog === "missing-schema" ? {} : { parameters }),
				}));
			},
			getActiveTools: () => active,
			setActiveTools(names: string[]) {
				active = [...names];
			},
		} as unknown as ExtensionAPI,
		options,
	);
	const emit = async (name: string, event: Event = {}): Promise<Event> => {
		let current = { ...event };
		for (const handler of hooks.get(name) ?? []) {
			const patch = await handler(current, ctx);
			if (patch && typeof patch === "object") current = { ...current, ...patch };
			if (name === "tool_call" && current.block) break;
		}
		return current;
	};
	const events: TranscriptEvent[] = [];
	const guidance: string[] = [];
	const inputs: Record<string, unknown>[] = [];
	let lastEnd: Event | undefined;
	const project = async () => {
		const projected = await emit("context", { messages: [] });
		const messages = projected.messages as Array<{ content: Array<{ text: string }> }>;
		const text = messages.map((message) => message.content.map((part) => part.text).join("\n"));
		guidance.push(...text);
		return text;
	};
	const inspect = async (args: Record<string, unknown>) => {
		const output = await tools
			.get("policy_rules")!
			.execute("inspection", args, new AbortController().signal, undefined, ctx);
		return { ...output, text: output.content.map((part) => part.text).join("\n") };
	};
	return {
		events,
		guidance,
		inputs,
		notices,
		tools,
		inspect,
		project,
		active: () => active,
		catalog(value: typeof catalog) {
			catalog = value;
		},
		start: () => emit("session_start", { reason: "startup" }),
		close: () => emit("session_shutdown", { reason: "quit" }),
		tree: () => emit("session_tree"),
		async reset(id: string) {
			await commands.get("policy")!.handler(`reset ${id} Synthetic reset`, ctx as ExtensionCommandContext);
		},
		async command(args: string) {
			const start = notices.length;
			await commands.get("policy")!.handler(args, ctx as ExtensionCommandContext);
			return notices.slice(start).join("\n");
		},
		async period(id: string): Promise<Period> {
			const state = JSON.parse((await inspect({ view: "state" })).text) as { observationPeriods: Period[] };
			return state.observationPeriods.find((period) => period.id === id)!;
		},
		async duplicateEnd() {
			assert.ok(lastEnd);
			await emit("tool_execution_end", lastEnd);
		},
		async call(step: ProductStep) {
			await emit("turn_start");
			await project();
			assert.ok(active.includes(step.name), `active tool: ${step.name}`);
			const tool = tools.get(step.name)!;
			const args = structuredClone(step.args);
			const id = `call-${events.length}`;
			events.push({ type: "tool_call", id, name: step.name, arguments: structuredClone(args) });
			await emit("tool_execution_start", { toolName: step.name, toolCallId: id, args });
			assert.equal(Compile(tool.parameters).Check(args), true, "host input validation precedes tool_call hooks");
			const decision = await emit("tool_call", { toolName: step.name, toolCallId: id, input: args });
			inputs.push(structuredClone(args));
			let output: Result;
			let isError = false;
			if (decision.block) {
				isError = true;
				output = { content: [{ type: "text", text: String(decision.reason) }], details: {} };
			} else {
				try {
					output = await tool.execute(id, args, new AbortController().signal, undefined, ctx);
				} catch (error) {
					isError = true;
					output = { content: [{ type: "text", text: (error as Error).message }], details: {} };
				}
				const patched = await emit("tool_result", {
					toolName: step.name,
					toolCallId: id,
					input: args,
					...output,
					isError,
				});
				output = { content: patched.content as Result["content"], details: patched.details as Result["details"] };
				isError = patched.isError === true;
			}
			lastEnd = { toolName: step.name, toolCallId: id, result: output, isError };
			await emit("tool_execution_end", lastEnd);
			const text = output.content.map((part) => part.text).join("\n");
			events.push({
				type: "tool_result",
				toolCallId: id,
				name: step.name,
				content: text,
				...(isError ? { error: { message: text } } : {}),
			});
			return { ...output, text, isError, denied: decision.block === true };
		},
	};
}

test("product resources resolve, retain human review, and differ only by mode", () => {
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
	assert.match(JSON.stringify(suite.adjudication.metadata), /not_assessed/);
	assert.match(JSON.stringify(suite.adjudication.metadata), /Inference remains unperformed/);
	assert.equal("participants" in suite, false);
});

for (const mode of ["enforce", "observe"] as const)
	for (const entry of suite.cases)
		test(`${mode}: product ${entry.id} checks reach package hook results`, async () => {
			const run = harness(mode);
			const fixture = (entry.input as unknown as { fixture: ProductCaseFixture }).fixture;
			try {
				await run.start();
				assert.deepEqual(run.active(), PRODUCT_TOOLS);
				assert.equal(run.active().includes("policy_propose"), false);
				for (const step of fixture.script) await run.call(step);
				await run.project();
				const checks = runDeterministicChecks("", entry.checks, run.events, entry.id);
				assert.deepEqual(
					checks.filter((check) => !check.passed).map((check) => check.checkId),
					mode === "observe" ? fixture.expectedObserveMisses : [],
				);
				assert.equal(run.guidance.length, fixture.group === "adaptive" && mode === "enforce" ? 1 : 0);
				if (fixture.group === "adaptive" && mode === "enforce")
					assert.match(run.guidance[0], entry.id === "recovery-guidance" ? /failed repeatedly/ : /substantial text/);
				if (entry.id === "schema-denial") {
					assert.equal(run.inputs[0].count, "not-an-integer");
					const output = run.events[1] as { content: string };
					assert.match(output.content, mode === "enforce" ? /final arguments violate/i : /BACKEND INVALID COUNT/);
					assert.equal((run.events[3] as { content: string }).content, `EXECUTIONS=${mode === "enforce" ? 0 : 1}`);
				}
				if (entry.id === "mode-control") {
					const capabilities = JSON.parse((run.events[1] as { content: string }).content);
					assert.equal(capabilities.mode, mode);
					assert.equal(capabilities.effectiveMode, mode);
				}
			} finally {
				await run.close();
			}
		});

test("product fixtures retain package provenance and contain no local policy events", async () => {
	const before = process.env.PI_POLICY_DIR;
	const run = harness("enforce");
	let dir = "";
	try {
		assert.equal(process.env.PI_POLICY_DIR, before);
		await run.start();
		const health = JSON.parse((await run.inspect({ view: "health" })).text);
		dir = dirname(health.authority.path);
		const snapshot = await new RuleRegistry(dir).snapshot();
		assert.deepEqual([...snapshot.records.keys()].sort(), PACKAGE_CATALOG.map((row) => row.id).sort());
		for (const row of PACKAGE_CATALOG) {
			const record = snapshot.records.get(row.id)!;
			assert.equal(record.source.kind, "package");
			assert.equal(record.definition.revision, row.revision);
			assert.equal(record.definition.purpose, row.purpose);
			assert.equal(record.definition.authority, row.authority);
			assert.deepEqual(record.matcher, row.matcher);
			assert.equal(record.override, undefined);
		}
		assert.deepEqual(snapshot.pending, []);
		assert.deepEqual([...snapshot.data.keys()], [RESULT_ERROR_SCHEMA]);
		const contract = snapshot.data.get(RESULT_ERROR_SCHEMA)!;
		assert.equal(contract.kind, "schema");
		const events = (await readFile(health.authority.path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.ok(events.every((event) => event.kind === "catalog" || event.kind === "data"));
		assert.equal(events.filter((event) => event.kind === "data").length, 1);
		await access(dir);
	} finally {
		await run.close();
	}
	assert.ok(dir);
	await assert.rejects(access(dir), { code: "ENOENT" });
	await run.close();
	assert.equal(process.env.PI_POLICY_DIR, before);
});

test("stored rule choices survive reload and starter changes until an exact import", async () => {
	const run = harness("enforce");
	const id = "recovery.repeated-errors";
	const operator = { surface: "command" as const, at: new Date().toISOString(), session: "catalog-owner", model: null };
	try {
		await run.start();
		const health = JSON.parse((await run.inspect({ view: "health" })).text);
		const dir = dirname(health.authority.path);
		const registry = new RuleRegistry(dir);
		const initial = await registry.snapshot();
		const record = initial.records.get(id)!;
		assert.equal(record.matcher.kind, "declarative");
		assert.ok(record.matcher.kind === "declarative" && record.matcher.language === "facts/v1");
		const matcher = structuredClone(record.matcher);
		matcher.spec.action = { kind: "guide", text: "Use the operator's chosen recovery advice." };
		const proposal = await registry.proposeReplace(
			{
				id,
				purpose: record.definition.purpose,
				authority: "exact",
				matcher,
				note: "Operator-selected recovery advice.",
			},
			record.definition.revision,
			"Customize the seeded rule",
			{ ...operator, surface: "agent-tool" },
		);
		await registry.decide(proposal.id, "approved", undefined, operator, proposalRevision(proposal));
		await registry.disable("arguments.schema", "Preserve an explicit disabled choice", operator);
		await registry.retire("resources.output-volume", "Remove the seeded volume rule", operator);
		await run.start();
		const changed = { ...PACKAGE_CATALOG.find((row) => row.id === id)!, note: "Different bundled advice." };
		const { revision: _priorRevision, ...changedDefinition } = changed;
		changed.revision = packageRowRevision(changedDefinition);
		const reloaded = await new RuleRegistry(dir, { catalog: [changed] }).snapshot();
		assert.equal(reloaded.health.status, "ok");
		assert.deepEqual(reloaded.records.get(id)!.matcher, matcher);
		assert.equal(reloaded.records.get("arguments.schema")!.override?.state, "disabled");
		assert.equal(reloaded.records.get("arguments.schema")!.definition.state, "active");
		assert.equal(reloaded.records.get("resources.output-volume")!.definition.state, "retired");
		assert.equal(reloaded.records.get("results.declared-error")!.definition.state, "active");
		assert.deepEqual([...reloaded.data], [...initial.data]);
		const noBundle = await new RuleRegistry(dir, { catalog: [] }).snapshot();
		assert.deepEqual([...noBundle.records], [...reloaded.records]);
		const plan = await registry.planImport(id);
		await run.command(`import ${id} exact ${plan.revision}`);
		const imported = await new RuleRegistry(dir).snapshot();
		assert.equal(imported.health.status, "ok");
		assert.equal(imported.records.get(id)!.source.kind, "import");
		assert.deepEqual(imported.records.get(id)!.matcher, PACKAGE_CATALOG.find((row) => row.id === id)!.matcher);
		assert.equal(imported.records.get("arguments.schema")!.override?.state, "disabled");
		assert.equal(imported.records.get("resources.output-volume")!.definition.state, "retired");
		assert.deepEqual([...imported.data], [...initial.data]);
	} finally {
		await run.close();
	}
});

test("an intentionally empty runtime catalog stays empty and has no hidden defaults", async () => {
	const run = harness("enforce");
	try {
		await run.start();
		const health = JSON.parse((await run.inspect({ view: "health" })).text);
		await writeFile(health.authority.path, "");
		await run.start();
		const stored = await new RuleRegistry(dirname(health.authority.path)).snapshot();
		assert.equal(stored.health.status, "ok");
		assert.equal(stored.records.size, 0);
		const response = await run.call(request());
		assert.equal(response.isError, true);
		assert.match(response.text, /BACKEND INVALID COUNT/);
		assert.equal((await run.call({ name: "policy_product_count", args: {} })).text, "EXECUTIONS=1");
		assert.equal((await readFile(health.authority.path, "utf8")).length, 0);
	} finally {
		await run.close();
	}
});

test("product checks reject answer-only claims without tool evidence", () => {
	for (const entry of suite.cases) {
		const fixture = (entry.input as unknown as { fixture: ProductCaseFixture }).fixture;
		assert.ok(
			runDeterministicChecks(fixture.gold, entry.checks, [], entry.id).some((check) => !check.passed),
			entry.id,
		);
	}
});

for (const mode of ["enforce", "observe"] as const) {
	test(`${mode}: recovery counts terminal execution errors once and resets after success`, async () => {
		const run = harness(mode);
		try {
			await run.start();
			for (let index = 1; index < DEFAULT_LIMITS.errorCount; index++) {
				await run.call(failure(index));
				await run.duplicateEnd();
				assert.deepEqual(await run.project(), []);
				assert.equal((await run.period("recovery.repeated-errors")).windowCount, index);
			}
			await run.call(failure(DEFAULT_LIMITS.errorCount));
			await run.duplicateEnd();
			assert.equal((await run.project()).length, mode === "enforce" ? 1 : 0);
			assert.equal((await run.period("recovery.repeated-errors")).windowCount, DEFAULT_LIMITS.errorCount);
			await run.call(failure());
			assert.deepEqual(await run.project(), []);
			await run.call(success);
			assert.equal((await run.period("recovery.repeated-errors")).windowCount, 0);
			for (let index = 1; index <= DEFAULT_LIMITS.errorCount; index++) await run.call(failure(index));
			assert.equal((await run.project()).length, mode === "enforce" ? 1 : 0);
			assert.equal(run.guidance.length, mode === "enforce" ? 2 : 0);
		} finally {
			await run.close();
		}
	});

	test(`${mode}: volume fires at the exact package byte limit, once per period`, async () => {
		const run = harness(mode);
		try {
			await run.start();
			await run.call(volume(Math.floor(DEFAULT_LIMITS.outputBytes / 2)));
			await run.call(volume(Math.ceil(DEFAULT_LIMITS.outputBytes / 2) - 1));
			await run.duplicateEnd();
			assert.equal((await run.period("resources.output-volume")).windowTotal, DEFAULT_LIMITS.outputBytes - 1);
			assert.deepEqual(await run.project(), []);
			await run.call(volume(1));
			assert.equal((await run.project()).length, mode === "enforce" ? 1 : 0);
			assert.equal((await run.period("resources.output-volume")).windowTotal, DEFAULT_LIMITS.outputBytes);
			assert.deepEqual(await run.project(), []);
			await run.reset("resources.output-volume");
			assert.equal((await run.period("resources.output-volume")).windowTotal, 0);
			await run.call(volume(Math.floor(DEFAULT_LIMITS.outputBytes / 2)));
			await run.call(volume(Math.ceil(DEFAULT_LIMITS.outputBytes / 2)));
			assert.equal((await run.project()).length, mode === "enforce" ? 1 : 0);
			assert.equal(run.guidance.length, mode === "enforce" ? 2 : 0);
		} finally {
			await run.close();
		}
	});

	for (const resultContract of ["missing", "stale"] as const)
		test(`${mode}: ${resultContract} result contract stays unavailable rather than asserting errors`, async () => {
			const run = harness(mode, { resultContract });
			try {
				await run.start();
				const outcome = await run.call({ name: "policy_product_result", args: { scenario: "declared-error" } });
				assert.equal(outcome.isError, false);
				const preview = JSON.parse(
					(
						await run.inspect({
							view: "preview",
							tool: "policy_product_result",
							input: { scenario: "declared-error" },
							result: { isError: false, details: { status: "refused", code: "DEMO_REFUSAL" } },
						})
					).text,
				);
				const evaluated = preview.results.find((row: { id: string }) => row.id === "results.declared-error");
				assert.equal(evaluated.truth, "unknown");
				assert.equal(evaluated.unavailable, true);
				assert.equal(preview.resultCorrected, false);
			} finally {
				await run.close();
			}
		});
}

test("policy denials do not count as executed errors or result volume", async () => {
	const run = harness("enforce");
	try {
		await run.start();
		for (let index = 0; index <= DEFAULT_LIMITS.errorCount; index++)
			assert.equal((await run.call(request())).denied, true);
		assert.equal((await run.period("recovery.repeated-errors")).count, 0);
		assert.equal((await run.period("resources.output-volume")).windowTotal, 0);
		assert.deepEqual(await run.project(), []);
	} finally {
		await run.close();
	}
});

for (const catalog of ["missing-schema", "unavailable"] as const)
	test(`${catalog}: arguments.schema skips unknown evidence and preserves backend failure`, async () => {
		const run = harness("enforce");
		try {
			await run.start();
			run.catalog(catalog);
			const outcome = await run.call(request());
			assert.equal(outcome.denied, false);
			assert.equal(outcome.isError, true);
			assert.equal(outcome.text, "BACKEND INVALID COUNT");
			const preview = JSON.parse(
				(
					await run.inspect({
						view: "preview",
						tool: "policy_product_request",
						input: { scenario: "mutated-schema", count: "not-an-integer" },
					})
				).text,
			);
			const evaluated = preview.input.evaluations.find((row: { id: string }) => row.id === "arguments.schema");
			assert.equal(evaluated.truth, "unknown");
			assert.equal(evaluated.unavailable, true);
		} finally {
			await run.close();
		}
	});

test("package periods expire exactly at the declared age and tree navigation resets observations", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const run = harness("enforce");
	try {
		await run.start();
		for (let index = 1; index <= DEFAULT_LIMITS.errorCount; index++) await run.call(failure(index));
		await run.project();
		now += DEFAULT_LIMITS.periodMs - 1;
		assert.equal((await run.period("recovery.repeated-errors")).windowCount, DEFAULT_LIMITS.errorCount);
		now++;
		assert.equal((await run.period("recovery.repeated-errors")).windowCount, 0);
		for (let index = 1; index <= DEFAULT_LIMITS.errorCount; index++) await run.call(failure(index));
		assert.equal((await run.project()).length, 1);
		await run.tree();
		assert.equal((await run.period("recovery.repeated-errors")).windowCount, 0);
		assert.deepEqual(await run.project(), []);
	} finally {
		await run.close();
	}
});

test("volume window drops old samples at the package event bound", async () => {
	const run = harness("enforce");
	try {
		await run.start();
		await run.call(volume(Math.floor(DEFAULT_LIMITS.outputBytes / 2)));
		for (let index = 0; index < DEFAULT_LIMITS.outputEvents; index++) await run.call(volume(0));
		const state = await run.period("resources.output-volume");
		assert.equal(state.windowCount, DEFAULT_LIMITS.outputEvents);
		assert.equal(state.windowTotal, 0);
		await run.call(volume(Math.ceil(DEFAULT_LIMITS.outputBytes / 2)));
		assert.deepEqual(await run.project(), []);
	} finally {
		await run.close();
	}
});

for (const mode of ["notice", "annotate"] as const)
	test(`${mode}: intermediate modes preserve input and error state while guidance follows mode`, async () => {
		const run = harness(mode);
		try {
			await run.start();
			const input = await run.call(request());
			assert.equal(input.denied, false);
			assert.equal(input.text, "BACKEND INVALID COUNT");
			const declared = await run.call({ name: "policy_product_result", args: { scenario: "declared-error" } });
			assert.equal(declared.isError, false);
			for (let index = 1; index <= DEFAULT_LIMITS.errorCount; index++) await run.call(failure(index));
			assert.equal((await run.project()).length, mode === "annotate" ? 1 : 0);
		} finally {
			await run.close();
		}
	});
