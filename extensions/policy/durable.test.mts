/**
 * Durable policy contribution tests.
 *
 * Each test drives model-issued calls through a real Pi Durable Harness over
 * MemoryStorage and the pi-ai faux provider, with the contribution built from
 * the real pi-durable module. The tests check one call per policy tool, the
 * declared replay classes through real interruption and reopen, and the native
 * hook mapping for deny, guide, and observation decisions.
 */
import { compile, int, num, obj, opt, str } from "@earendil-works/pi-schema";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as DurableModule from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

import { createPolicyDurableExtension, durableResultDisposition, policyPanelCommand, type PolicyDurableHost } from "./durable.ts";
import type { PolicyRecord } from "./record.ts";
import type { AppendTelemetry } from "./telemetry-files.ts";
import { makeRuleAudit, proposalRevision, RuleRegistry, targetIdentity } from "./local-rules.ts";
import { deserializeSnapshot, readPanelAnswer } from "./panel-protocol.ts";
import type { OperatorView, PanelHost } from "../../operator-ui/index.ts";
import { operatorPanel } from "./operator-panel.ts";
import type { FactsProgram } from "./program.ts";
import { localDate, TelemetryLockBusyError } from "./telemetry-files.ts";
import { PolicyProposeParams, PolicyRulesParams, validateProposal } from "./tools.ts";
import { PolicyControlParams } from "./control.ts";
import { DraftCasesSchema } from "./authoring.ts";
import { readTelemetry } from "./telemetry.ts";

const context = BACKGROUND_CONTEXT;
const plainTheme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text } as unknown as PanelHost["theme"];
const MODEL = { provider: "faux", modelId: "faux-1" } as const;

test("host diagnostics distinguish rejected calls from uncertain execution and tool errors", () => {
	for (const [code, outcome, executed] of [
		["tool_unavailable", "unexecuted", false],
		["invalid_arguments", "invalid", false],
		["blocked", "denied", false],
		["interrupted", "incomplete", "unknown"],
		["restart_limit", "incomplete", "unknown"],
		["aborted", "aborted", "unknown"],
		["abandoned", "unexecuted", false],
	] as const) {
		assert.deepEqual(durableResultDisposition({
			isError: true,
			diagnostics: [{ code: "truncated", severity: "warn", message: "Partial output." }, { code, severity: "error", message: code }],
		}), { outcome, executed, diagnostic: code });
	}
	assert.deepEqual(durableResultDisposition({}), { outcome: "success", executed: true });
	assert.deepEqual(durableResultDisposition({ isError: true, diagnostics: [{ code: "tool_error", severity: "error", message: "Execution failed." }] }),
		{ outcome: "execution-error", executed: true });
});

async function telemetryLines(dir: string, day: string): Promise<string[]> {
	const segments = join(dir, "telemetry");
	const names = (await readdir(segments)).filter((name) => name.startsWith(`${day}.`)).sort();
	const lines: string[] = [];
	for (const name of names) lines.push(...(await readFile(join(segments, name), "utf8")).split("\n").filter(Boolean));
	return lines;
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${label}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/**
 * MemoryStorage seals itself on `close`. Recovery tests keep the same in-memory
 * backend across harness generations, so this proxy forwards every storage
 * method and treats `close` as a no-op.
 */
function reopenableStorage(): DurableModule.Storage {
	const inner = new DurableModule.MemoryStorage();
	return new Proxy(inner as unknown as DurableModule.Storage, {
		get(target, property, receiver) {
			if (property === "close") return async () => {};
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** Surface hook failures; the Harness default reporter is silent. */
function reportHarnessError(error: unknown): void {
	console.error("[policy-durable-test] harness report:", error);
}

type HostCleanup = () => void | Promise<void>;

function hostFor(
	directory: string,
	harness: DurableModule.Harness,
	cleanups: HostCleanup[] = [],
): PolicyDurableHost {
	return {
		durable: DurableModule,
		services: {} as PolicyDurableHost["services"],
		cwd: directory,
		agentDir: directory,
		storageId: "durable-test-storage",
		harness,
		signal: new AbortController().signal,
		onClose: (dispose) => { cleanups.push(dispose); },
		inventory: {
			contributions: [
				{
					name: "policy",
					source: fileURLToPath(new URL("./index.ts", import.meta.url)),
					commands: [],
				},
			],
			ordinaryOnly: [],
		},
	};
}

/** Reject when the call's signal is aborted; used to interrupt a tool deterministically. */
function aborted(signal: AbortSignal | undefined): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (!signal) return;
		const fail = () => reject(new Error("interrupted by test"));
		if (signal.aborted) {
			fail();
			return;
		}
		signal.addEventListener("abort", fail, { once: true });
	});
}

/** Wrap one tool so its first execution blocks until the harness aborts the call. */
function blockOnce(extension: DurableModule.Extension, name: string, started: () => void): DurableModule.Extension {
	let first = true;
	return {
		...extension,
		tools: extension.tools?.map((tool) =>
			tool.name !== name
				? tool
				: {
						...tool,
						execute: async (args, api, callContext) => {
							if (first) {
								first = false;
								started();
								await aborted(callContext.abortSignal);
							}
							return tool.execute(args, api, callContext);
						},
					},
		),
	};
}

function probeExtension(counter: { executed: number }): DurableModule.Extension {
	return DurableModule.defineExtension({
		name: "policy-test-probe",
		tools: [
			DurableModule.defineTool({
				name: "probe",
				description: "A probe tool for durable policy tests",
				parameters: obj({}, { open: true }),
				execute: async () => {
					counter.executed += 1;
					return { output: [{ type: "text", text: "probe ran" }] };
				},
			}),
		],
	});
}

test("defers the management tools without changing enforcement sections or replay classes", async (t) => {
	const fixture = await openFixture();
	t.after(fixture.close);
	const extension = fixture.registry.snapshot().installed().find((candidate) => candidate.name === "policy");
	assert.ok(extension, "the policy contribution is installed");
	const tools = extension.tools ?? [];
	assert.deepEqual(tools.map((tool) => tool.name).sort(), ["policy_approve", "policy_control", "policy_propose", "policy_rules"]);
	assert.ok(tools.every((tool) => tool.deferred === true), "every management tool is discovered on demand");
	assert.deepEqual(tools.map((tool) => tool.replay).sort(), ["safe", "unsafe", "unsafe", "unsafe"]);
	assert.deepEqual((extension.sections ?? []).map((section) => section.key), ["policy", "policy_shell"]);
});

async function toolResults(
	root: DurableModule.Conversation,
	toolName: string,
	callContext: Context = context,
): Promise<ToolResultMessage[]> {
	const page = await root.entries({}, 200, undefined, callContext);
	return page.items
		.flatMap((entry) => (entry.kind === "pi.tool-result" && entry.model ? entry.model : []))
		.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName)
		.reverse();
}

function textOf(message: ToolResultMessage | undefined): string {
	return (message?.content ?? [])
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");
}

function detailsOf(message: ToolResultMessage | undefined): Record<string, unknown> | undefined {
	const details = message?.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	assert.equal("structuredContent" in details, false);
	return details as Record<string, unknown>;
}

interface Fixture {
	harness: DurableModule.Harness;
	root: DurableModule.Conversation;
	faux: ReturnType<typeof fauxProvider>;
	registry: DurableModule.Registry;
	directory: string;
	storeDir: string;
	policy: RuleRegistry;
	/** Run the host close callbacks once, which drains telemetry. */
	closeHost: () => Promise<void>;
	close: () => Promise<void>;
}

interface FixtureOptions {
	storage?: DurableModule.Storage;
	configuration?: { dir: string; mode: string };
	mode?: string;
	extension?: DurableModule.Extension;
	block?: { name: string; started: () => void };
	/** Prepare the rule store before the host creates the contribution. */
	prepare?: (storeDir: string) => Promise<void>;
	/** Replace the telemetry persistence boundary. */
	append?: AppendTelemetry;
	/** Harness settings, such as compaction thresholds. */
	settings?: NonNullable<Parameters<typeof DurableModule.Harness.open>[1]["settings"]>;
}

/** The policy management tools start undeclared; a fixture that calls them loads them explicitly. */
function policyTools(registry: DurableModule.Registry): readonly DurableModule.ToolRegistration[] {
	return registry.snapshot().installed().filter((entry) => entry.name === "policy").flatMap((entry) => entry.tools ?? []);
}

async function openFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const directory = await mkdtemp(join(tmpdir(), "policy-durable-"));
	const storeDir = join(directory, options.configuration?.dir ?? "policy");
	if (options.configuration) {
		await writeFile(join(directory, "harness.json"), JSON.stringify({ version: 1, policy: options.configuration }));
	}
	const priorDir = process.env.PI_POLICY_DIR;
	const priorMode = process.env.PI_POLICY_MODE;
	const priorHarnessFile = process.env.PI_HARNESS_FILE;
	process.env.PI_HARNESS_FILE = join(directory, "harness.json");
	if (options.configuration) delete process.env.PI_POLICY_DIR;
	else process.env.PI_POLICY_DIR = storeDir;
	if (options.mode === undefined) delete process.env.PI_POLICY_MODE;
	else process.env.PI_POLICY_MODE = options.mode;
	try {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = DurableModule.createRegistry();
		const reports: unknown[] = [];
		const cleanups: HostCleanup[] = [];
		const harness = await DurableModule.Harness.open(
			options.storage ?? new DurableModule.MemoryStorage(),
			{
				models,
				registry,
				...(options.settings ? { settings: options.settings } : {}),
				onReport: (error: unknown) => {
					reports.push(error);
					reportHarnessError(error);
				},
			},
			context,
		);
		await options.prepare?.(storeDir);
		const factoryOptions = options.append ? { append: options.append } : {};
		let contribution = await createPolicyDurableExtension(hostFor(directory, harness, cleanups), factoryOptions);
		if (options.block) contribution = blockOnce(contribution, options.block.name, options.block.started);
		registry.install(contribution);
		if (options.extension) registry.install(options.extension);
		const root = await harness.root(context, { agent: { model: MODEL, modelTools: { add: policyTools(registry) } } });
		return {
			harness,
			root,
			faux,
			registry,
			directory,
			storeDir,
			policy: new RuleRegistry(storeDir),
			closeHost: async () => {
				for (const dispose of cleanups.splice(0)) await dispose();
			},
			close: async () => {
				for (const dispose of cleanups.splice(0)) await dispose();
				await harness.close(context);
				assert.equal(
					reports.length,
					0,
					`harness reports: ${reports.map((error) => String(error)).join("; ")}`,
				);
				await rm(directory, { recursive: true, force: true });
				if (priorDir === undefined) delete process.env.PI_POLICY_DIR;
				else process.env.PI_POLICY_DIR = priorDir;
				if (priorMode === undefined) delete process.env.PI_POLICY_MODE;
				else process.env.PI_POLICY_MODE = priorMode;
				if (priorHarnessFile === undefined) delete process.env.PI_HARNESS_FILE;
				else process.env.PI_HARNESS_FILE = priorHarnessFile;
			},
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

async function submit(fixture: Fixture, responses: unknown[], prompt: string): Promise<void> {
	fixture.faux.appendResponses(responses as Parameters<ReturnType<typeof fauxProvider>["appendResponses"]>[0]);
	const submission = await fixture.root.submit({ type: "input", content: prompt }, context);
	await submission.wait(context);
}

async function addRule(
	policy: RuleRegistry,
	id: string,
	program: FactsProgram,
	authority: "exact" | "steer-or-block" = "exact",
): Promise<void> {
	const auditContext = { sessionManager: { getSessionId: () => "durable-rule-test" }, model: null };
	const proposal = await policy.proposeAdd(
		{
			id,
			purpose: `Preserve ${id}.`,
			authority,
			matcher: { kind: "declarative", language: "facts/v1", spec: program },
			note: `Rule ${id}.`,
		},
		"Test rule.",
		makeRuleAudit(auditContext, "agent-tool"),
	);
	await policy.decide(proposal.id, "approved", undefined, makeRuleAudit(auditContext, "command"), proposalRevision(proposal));
}

const proposeArgs = {
	operation: "add",
	id: "durable-tool-test",
	purpose: "Verify the durable policy tools.",
	authority: "exact",
	reason: "Test coverage.",
	note: "A durable test rule.",
	match: { command: "echo" },
};

test("native tools use host-relative document settings and environment precedence", async () => {
	for (const override of [undefined, "notice", "invalid-mode"]) {
		const fixture = await openFixture({ configuration: { dir: "configured-store", mode: "enforce" }, mode: override });
		try {
			await submit(fixture, [
				fauxAssistantMessage(fauxToolCall("policy_control", { operation: "mode" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("inspected"),
			], "inspect mode");
			const results = await toolResults(fixture.root, "policy_control");
			assert.equal(detailsOf(results.at(-1))?.mode, override === undefined ? "enforce" : override === "notice" ? "notice" : "observe");
			assert.equal((await fixture.policy.snapshot()).health.status, "ok");
			await assert.rejects(readFile(join(fixture.directory, "policy", "rules.jsonl")), /ENOENT/);
		} finally { await fixture.close(); }
	}
});

for (const state of ["healthy", "degraded", "incomplete"] as const) {
	test(`native exact lookup carries ${state} authority in model-visible text`, async () => {
		const fixture = await openFixture();
		try {
			await fixture.policy.snapshot();
			if (state !== "healthy") await writeFile(join(fixture.storeDir, "rules.jsonl"), state === "degraded" ? "invalid\n" : "{", { mode: 0o600 });
			await submit(fixture, [
				fauxAssistantMessage(fauxToolCall("policy_rules", { id: "missing.rule" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("inspected"),
			], "inspect exact rule");
			const result = (await toolResults(fixture.root, "policy_rules")).at(-1);
			assert.ok(result);
			const text = textOf(result);
			if (state === "healthy") assert.equal(text, "No rule or pending proposal named missing.rule.");
			else {
				assert.doesNotMatch(text, /No rule or pending proposal/);
				assert.match(text, state === "degraded" ? /registry health: degraded=true/ : /append in flight/);
			}
		} finally { await fixture.close(); }
	});
}

test("every policy tool answers a model-issued call", async () => {
	const fixture = await openFixture();
	try {
		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("policy_rules", { view: "rules" }), { stopReason: "toolUse" }), fauxAssistantMessage("inspected")],
			"list rules",
		);
		const rules = await toolResults(fixture.root, "policy_rules");
		assert.match(textOf(rules.at(-1)), /RULES/);
		assert.equal(detailsOf(rules.at(-1))?.rules !== undefined, true);
		const rulesDetails = rules.at(-1)?.details as Record<string, unknown> | undefined;
		assert.equal(typeof rulesDetails?.rules, "number");
		assert.equal(rulesDetails?.structuredContent, undefined);

		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("policy_propose", proposeArgs), { stopReason: "toolUse" }), fauxAssistantMessage("proposed")],
			"propose a rule",
		);
		const proposals = await toolResults(fixture.root, "policy_propose");
		const proposal = detailsOf(proposals.at(-1));
		assert.equal(proposal?.state, "pending");
		assert.equal(proposal?.ruleId, "durable-tool-test");
		assert.equal(typeof proposal?.proposalId, "string");
		assert.equal(typeof proposal?.proposalRevision, "string");
		const proposalDetails = proposals.at(-1)?.details as Record<string, unknown> | undefined;
		assert.equal(typeof proposalDetails?.proposalId, "string");
		assert.equal(proposalDetails?.structuredContent, undefined);

		await submit(
			fixture,
			[
				fauxAssistantMessage(
					fauxToolCall("policy_approve", {
						proposalId: proposal?.proposalId as string,
						proposalRevision: proposal?.proposalRevision as string,
						effect: "exact",
						authorization: "The operator approved this exact proposal.",
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("approved"),
			],
			"approve it",
		);
		const approvals = await toolResults(fixture.root, "policy_approve");
		assert.equal(detailsOf(approvals.at(-1))?.decision, "approved");
		assert.equal(detailsOf(approvals.at(-1))?.ruleId, "durable-tool-test");
		const store = await readFile(join(fixture.storeDir, "rules.jsonl"), "utf8");
		assert.match(store, /"kind":"decision"/);

		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("policy_control", { operation: "mode" }), { stopReason: "toolUse" }), fauxAssistantMessage("reported")],
			"report mode",
		);
		const controls = await toolResults(fixture.root, "policy_control");
		assert.equal(detailsOf(controls.at(-1))?.mode, "observe");
	} finally {
		await fixture.close();
	}
});

test("native codemode receives structured policy results and rejects tool errors", async () => {
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
	const fixture = await openFixture({ extension: createCodemodeExtension({ sandbox, models: false }) });
	try {
		await submit(fixture, [
			fauxAssistantMessage(fauxToolCall("codemode", { code: `
const rules = await tools.policy_rules({ view: "rules" });
const proposal = await tools.policy_propose(${JSON.stringify(proposeArgs)});
const approved = await tools.policy_approve({ proposalId: proposal.proposalId, proposalRevision: proposal.proposalRevision, effect: "exact", authorization: "The fixture operator approved this exact proposal." });
const control = await tools.policy_control({ operation: "mode" });
text({ rules: rules.rules, pending: proposal.state, approved: approved.decision, mode: control.mode });
try { await tools.policy_approve({ proposalId: proposal.proposalId, proposalRevision: proposal.proposalRevision, effect: "exact", authorization: "The fixture operator approved this exact proposal." }); }
catch (error) { text(String(error)); }
` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		], "inspect and change the isolated fixture rule");
		const result = (await toolResults(fixture.root, "codemode")).at(-1);
		assert.equal(result?.isError, false);
		assert.match(textOf(result), /"rules":\s*\d+/);
		assert.match(textOf(result), /"pending":\s*"pending"/);
		assert.match(textOf(result), /"approved":\s*"approved"/);
		assert.match(textOf(result), /"mode":\s*"observe"/);
		assert.match(textOf(result), /No pending proposal with that ID/);
		assert.equal((await toolResults(fixture.root, "policy_rules")).length, 0);
	} finally {
		await fixture.close();
		await sandbox.close();
	}
});

test("nested tools-only and deferred calls receive schema-validated policy corrections", async () => {
	const seen: string[] = [];
	const tools = ["tools_only", "deferred_probe"].map((name) => DurableModule.defineTool({
		name,
		description: "Return a corrected fixture value",
		parameters: obj({ old: opt(str()), value: opt(str()) }, { open: false }),
		...(name === "tools_only" ? { callers: ["tools"] as const } : { deferred: true as const }),
		execute: async (args) => {
			assert.ok(typeof args.value === "string");
			assert.equal(args.old, undefined);
			seen.push(args.value);
			return { output: [{ type: "text" as const, text: args.value }] };
		},
	}));
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
	const fixture = await openFixture({ mode: "enforce", extension: DurableModule.defineExtension({ name: "nested-probes", tools }) });
	fixture.registry.install(createCodemodeExtension({ sandbox, models: false }));
	try {
		await addRule(fixture.policy, "nested-correction", {
			phase: "input",
			selector: { tools: ["tools_only", "deferred_probe"] },
			when: { op: "exists", path: ["input", "old"] },
			action: { kind: "rename-key", path: [], from: "old", to: "value" },
			onUnavailable: "deny",
		});
		const agent = await fixture.root.agent(context);
		assert.equal(agent.tools.some((tool) => tools.some((probe) => probe.name === tool.name)), false);
		await submit(fixture, [
			fauxAssistantMessage(fauxToolCall("codemode", { code: 'text(await tools.tools_only({ old: "first" })); text(await tools.deferred_probe({ old: "second" }));' }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		], "run the nested fixture probes");
		const result = (await toolResults(fixture.root, "codemode")).at(-1);
		assert.equal(result?.isError, false, textOf(result));
		assert.deepEqual(seen, ["first", "second"]);
		assert.match(textOf(result), /first/);
		assert.match(textOf(result), /second/);
	} finally {
		await fixture.close();
		await sandbox.close();
	}
});

test("the shell contract card reaches a model when bash is callable only", async () => {
	const fixture = await openFixture({ mode: "annotate", extension: DurableModule.defineExtension({
		name: "nested-shell",
		tools: [DurableModule.defineTool({
			name: "bash", description: "A nonexecuting shell fixture", callers: ["tools"],
			parameters: obj({ command: str() }, { open: true }),
			execute: async () => ({ output: [{ type: "text", text: "fixture only" }] }),
		})],
	}) });
	try {
		const agent = await fixture.root.agent(context);
		assert.equal(agent.tools.some((tool) => tool.name === "bash"), false);
		assert.equal(agent.callable.some((tool) => tool.name === "bash"), true);
		const requests: Array<readonly import("@earendil-works/pi-ai").Message[]> = [];
		await submit(fixture, [(modelContext: { messages: readonly import("@earendil-works/pi-ai").Message[] }) => {
			requests.push(modelContext.messages);
			return fauxAssistantMessage(fauxToolCall("policy_rules", {}), { stopReason: "toolUse" });
		}, (modelContext: { messages: readonly import("@earendil-works/pi-ai").Message[] }) => {
			requests.push(modelContext.messages);
			return fauxAssistantMessage("done");
		}], "inspect shell guidance");
		const cards = requests.map((messages) => messages.filter((message) => message.role === "system" &&
			JSON.stringify(message).includes("Shell contract snapshot")));
		assert.equal(cards[0].length, 1);
		assert.deepEqual(cards[1], cards[0], "the system card retains identical bytes across generation requests");
	} finally { await fixture.close(); }
});

test("native result.content rules preserve structured values and mark nested errors", async () => {
	const fixture = await openFixture({ mode: "enforce", extension: DurableModule.defineExtension({
		name: "structured-probe",
		tools: [DurableModule.defineTool({
			name: "structured_probe",
			description: "Return separate output and structured data",
			parameters: obj({}, { open: true }),
			structuredOutputSchema: obj({ value: num() }, { open: true }),
			execute: async () => ({ output: [{ type: "text", text: "review this result" }], structuredOutput: { value: 7 }, details: { label: "fixture" } }),
		}), DurableModule.defineTool({
			name: "nested_probe",
			description: "Read a nested result at the public API",
			parameters: obj({}, { open: true }),
			execute: async (_args, api, callContext) => {
				const result = await api.executeTool("structured_probe", {}, callContext);
				assert.equal(result.isError, true);
				assert.deepEqual(result.structuredOutput, { value: 7 });
				assert.deepEqual(result.details, { label: "fixture" });
				return { output: [{ type: "text", text: "nested error and data preserved" }] };
			},
		})],
	}) });
	try {
		for (const [id, action] of [
			["result-error", { kind: "assert-error" }],
			["result-guide", { kind: "guide", text: "Inspect the reviewed result." }],
		] as const) {
			await addRule(fixture.policy, id, {
				phase: "result", selector: { tools: ["structured_probe"] },
				when: { op: "eq", path: ["result", "content", "0", "text"], value: "review this result" },
				action, onUnavailable: "skip",
			});
		}
		await submit(fixture, [
			fauxAssistantMessage(fauxToolCall("structured_probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("nested_probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		], "review direct and nested fixture output");
		const direct = (await toolResults(fixture.root, "structured_probe")).at(-1);
		assert.equal(direct?.isError, true);
		assert.match(textOf(direct), /review this result/);
		assert.match(textOf(direct), /Inspect the reviewed result/);
		assert.match(textOf((await toolResults(fixture.root, "nested_probe")).at(-1)), /nested error and data preserved/);
	} finally { await fixture.close(); }
});

test("native telemetry preserves the full call interval from the input memo", async (t) => {
	const start = Date.now();
	let now = start;
	t.mock.method(Date, "now", () => now);
	const fixture = await openFixture({ extension: DurableModule.defineExtension({
		name: "clock-probe",
		tools: [DurableModule.defineTool({
			name: "clock_probe", description: "Advance a controlled clock", parameters: obj({}, { open: true }),
			execute: async () => {
				now += 500;
				return { output: [{ type: "text", text: "clock advanced" }] };
			},
		})],
		hooks: [DurableModule.hook(DurableModule.ToolTask, {
			beforeTool: (call) => {
				if (call.name === "clock_probe") now += 250;
				return undefined;
			},
		})],
	}) });
	try {
		await submit(fixture, [
			fauxAssistantMessage(fauxToolCall("clock_probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		], "measure the isolated fixture interval");
		await fixture.closeHost();
		const records = (await telemetryLines(fixture.storeDir, localDate(new Date(start))))
			.map((line) => JSON.parse(line));
		const record = records.find((entry) => entry.tool === "clock_probe");
		assert.equal(record?.durationMs, 750);
		assert.equal(record?.at, new Date(start).toISOString());
	} finally { await fixture.close(); }
});

test("policy parameter schemas preserve optional CLI fields and bounded record keywords", () => {
	const proposal = compile(JSON.parse(JSON.stringify(PolicyProposeParams)));
	const input = {
		operation: "add", id: "local.push", purpose: "Protect updates.", authority: "exact",
		reason: "Preserve explicit approval.", note: "Inspect the push.", onUnavailable: "deny",
		match: { command: "git", cli: { profile: "git", subcommand: ["push"] } },
	};
	assert.equal(proposal.check(input), true);
	assert.doesNotThrow(() => validateProposal(input));
	assert.equal(proposal.check({ ...input, extra: true }), false);
	assert.equal(proposal.check({ ...input, match: { ...input.match, flags: [1] } }), false);
	const indexed = (at: unknown) => ({ ...input, match: { ...input.match, operands: { at } } });
	assert.equal(proposal.check(indexed({ "0": ["origin"] })), true);
	assert.equal(proposal.check(indexed({ "0": [1] })), false);
	// The key pattern constrains matched values; unmatched keys remain open at transport admission.
	assert.equal(proposal.check(indexed({ other: 1 })), true);
	assert.throws(() => validateProposal(indexed({ "0": [1] })));

	const entries = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, index]));
	const rules = compile(JSON.parse(JSON.stringify(PolicyRulesParams)));
	assert.equal(rules.check({ draft: entries(16), input: entries(128) }), true);
	assert.equal(rules.check({ draft: entries(17) }), false);
	assert.equal(rules.check({ input: entries(129) }), false);
	assert.equal(rules.check({ input: [] }), false);
	const control = compile(JSON.parse(JSON.stringify(PolicyControlParams)));
	const artifact = (data: unknown) => ({ operation: "data-preview", artifact: { data, expectedRevision: null } });
	assert.equal(control.check(artifact(entries(12))), true);
	assert.equal(control.check(artifact(entries(13))), false);
	assert.equal(control.check({ operation: "mode", extra: true }), false);
	const cases = compile(JSON.parse(JSON.stringify(DraftCasesSchema)));
	const checkCase = (input: unknown) => [{ name: "bounded", steps: [{ kind: "call", at: 0, turn: 0, tool: "probe", input }] }];
	assert.equal(cases.check(checkCase(entries(128))), true);
	assert.equal(cases.check(checkCase(entries(129))), false);
});

test("every tool declares its replay class explicitly", async () => {
	const fixture = await openFixture();
	try {
		const registered = new Map(
			fixture.registry
				.snapshot()
				.tools()
				.map((entry) => [entry.tool.name, entry.tool.replay]),
		);
		assert.equal(registered.get("policy_rules"), "safe");
		assert.equal(registered.get("policy_propose"), "unsafe");
		assert.equal(registered.get("policy_approve"), "unsafe");
		assert.equal(registered.get("policy_control"), "unsafe");
		const schemas = new Map(
			fixture.registry
				.snapshot()
				.tools()
				.map((entry) => [
					entry.tool.name,
					entry.tool.structuredOutputSchema as { properties?: Record<string, unknown> } | undefined,
				]),
		);
		const rulesSchema = schemas.get("policy_rules")?.properties;
		assert.ok(rulesSchema);
		assert.equal(rulesSchema.structuredContent, undefined);
		assert.ok(rulesSchema.rules);
		for (const entry of fixture.registry.snapshot().tools()) {
			const schema = entry.tool.structuredOutputSchema;
			assert.ok(schema);
			const check = compile(schema);
			if (entry.tool.name === "policy_rules") {
				assert.equal(check.check({ rules: 0, pending: 0, ruleStoreDegraded: false, ruleStorePath: "rules.jsonl", extra: true }), true);
				assert.equal(check.check({ rules: 0 }), false);
			}
			if (entry.tool.name === "policy_control") {
				assert.deepEqual(schema, { type: "object", patternProperties: { "^.*$": {} } });
				assert.equal(check.check({ arbitrary: { nested: true } }), true);
				assert.equal(check.check([]), false);
			}
		}
	} finally {
		await fixture.close();
	}
});

test("an interrupted unsafe tool yields the interrupted result instead of rerunning", async () => {
	const directory = await mkdtemp(join(tmpdir(), "policy-durable-replay-"));
	const storeDir = join(directory, "policy");
	const priorDir = process.env.PI_POLICY_DIR;
	process.env.PI_POLICY_DIR = storeDir;
	try {
		const started = deferred();
		const storage = reopenableStorage();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = DurableModule.createRegistry();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("policy_propose", proposeArgs), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const firstCleanups: HostCleanup[] = [];
		const first = await DurableModule.Harness.open(storage, { models, registry, onReport: reportHarnessError }, context);
		registry.install(
			blockOnce(
				await createPolicyDurableExtension(hostFor(directory, first, firstCleanups)),
				"policy_propose",
				started.resolve,
			),
		);
		const root = await first.root(context, { agent: { model: MODEL, modelTools: { add: policyTools(registry) } } });
		const submission = await root.submit({ type: "input", content: "propose" }, context);
		await started.promise;
		await first.close(context);
		for (const dispose of firstCleanups.splice(0)) await dispose();

		const secondCleanups: HostCleanup[] = [];
		const second = await DurableModule.Harness.open(storage, { models, registry, onReport: reportHarnessError }, context);
		registry.install(await createPolicyDurableExtension(hostFor(directory, second, secondCleanups)));
		second.resume();
		const reacquired = await second.submission(submission.id, context);
		assert.ok(reacquired);
		await reacquired.wait(context);
		const reopened = await second.root(context);
		const results = await toolResults(reopened, "policy_propose");
		const result = results.at(-1);
		assert.equal(result?.isError, true);
		assert.match(textOf(result), /interrupted/);
		assert.match(textOf(result), /may have partially run/);
		await second.close(context);
		for (const dispose of secondCleanups.splice(0)) await dispose();
		const store = await readFile(join(storeDir, "rules.jsonl"), "utf8");
		assert.equal(store.includes('"kind":"proposal"'), false);
		const records = (await telemetryLines(storeDir, localDate(new Date())))
			.map((line) => JSON.parse(line)).filter((record) => record.tool === "policy_propose");
		assert.equal(records.length, 1);
		assert.equal(records[0].outcome, "incomplete");
		assert.equal(records[0].observationComplete, false);
		assert.equal(records[0].policy.hostDiagnostic, "interrupted");
	} finally {
		await rm(directory, { recursive: true, force: true });
		if (priorDir === undefined) delete process.env.PI_POLICY_DIR;
		else process.env.PI_POLICY_DIR = priorDir;
	}
});

test("an aborted call records an uncertain execution without a completed execution outcome", async () => {
	const started = deferred();
	const fixture = await openFixture({ block: { name: "policy_rules", started: started.resolve } });
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("policy_rules", {}), { stopReason: "toolUse" }),
		]);
		const submission = await fixture.root.submit({ type: "input", content: "Inspect policy." }, context);
		await started.promise;
		await fixture.root.abort(context);
		await submission.wait(context);
		const result = (await toolResults(fixture.root, "policy_rules")).at(-1);
		assert.equal(result?.isError, true);
		await fixture.closeHost();
		const records = (await telemetryLines(fixture.storeDir, localDate(new Date())))
			.map((line) => JSON.parse(line)).filter((record) => record.tool === "policy_rules");
		assert.equal(records.length, 1);
		assert.equal(records[0].outcome, "aborted");
		assert.equal(records[0].abortRequested, true);
		assert.equal(records[0].observationComplete, false);
		assert.equal(records[0].policy.hostDiagnostic, "aborted");
	} finally {
		await fixture.close();
	}
});

test("an interrupted safe tool reruns and answers after reopen", async () => {
	const fixtureDirectory = await mkdtemp(join(tmpdir(), "policy-durable-safe-"));
	const storeDir = join(fixtureDirectory, "policy");
	const priorDir = process.env.PI_POLICY_DIR;
	process.env.PI_POLICY_DIR = storeDir;
	try {
		const started = deferred();
		const storage = reopenableStorage();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = DurableModule.createRegistry();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("policy_rules", { view: "rules" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const first = await DurableModule.Harness.open(storage, { models, registry, onReport: reportHarnessError }, context);
		registry.install(blockOnce(await createPolicyDurableExtension(hostFor(fixtureDirectory, first)), "policy_rules", started.resolve));
		const root = await first.root(context, { agent: { model: MODEL, modelTools: { add: policyTools(registry) } } });
		const submission = await root.submit({ type: "input", content: "list" }, context);
		await started.promise;
		await first.close(context);

		const second = await DurableModule.Harness.open(storage, { models, registry, onReport: reportHarnessError }, context);
		registry.install(await createPolicyDurableExtension(hostFor(fixtureDirectory, second)));
		second.resume();
		const reacquired = await second.submission(submission.id, context);
		assert.ok(reacquired);
		await reacquired.wait(context);
		const reopened = await second.root(context);
		const results = await toolResults(reopened, "policy_rules");
		const result = results.at(-1);
		assert.equal(result?.isError, false);
		assert.match(textOf(result), /RULES/);
		await second.close(context);
	} finally {
		await rm(fixtureDirectory, { recursive: true, force: true });
		if (priorDir === undefined) delete process.env.PI_POLICY_DIR;
		else process.env.PI_POLICY_DIR = priorDir;
	}
});

test("native read redirects preserve rule guidance and append concrete calls", async () => {
	let executed = 0;
	const extension = DurableModule.defineExtension({
		name: "reader-probes",
		tools: ["bash", "read"].map((name) => DurableModule.defineTool({
			name,
			description: "A synthetic reader probe.",
			parameters: obj({ command: opt(str()) }, { open: true }),
			execute: async () => { executed++; return { output: [{ type: "text", text: "unexpected execution" }] }; },
		})),
	});
	const fixture = await openFixture({ mode: "enforce", extension });
	try {
		const plan = await fixture.policy.planImport("--all");
		await fixture.policy.importCatalog("--all", plan.revision, makeRuleAudit({ sessionManager: { getSessionId: () => "reader-test" }, model: null }, "command"));
		const before = await readFile(join(fixture.storeDir, "rules.jsonl"), "utf8");
		const cases = [
			["cat notes.md", "read path=notes.md"],
			["sed -n '6,11p' notes.md", "read path=notes.md offset=6 limit=6"],
			["head -n 4 notes.md", "read path=notes.md limit=4"],
			["tail -n +8 notes.md", "read path=notes.md offset=8"],
			[`python3 -c "print(open('notes.md').read())"`, "read path=notes.md"],
		];
		for (const [command, suggestion] of cases) {
			await submit(fixture, [
				fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
				fauxAssistantMessage("stopped"),
			], "inspect the note");
			const result = (await toolResults(fixture.root, "bash")).at(-1);
			assert.equal(result?.isError, true);
			assert.ok(textOf(result).includes(`\nFor this command: ${suggestion}`), textOf(result));
			assert.match(textOf(result), /Use the read tool/);
		}
		assert.equal(executed, 0);
		assert.equal(await readFile(join(fixture.storeDir, "rules.jsonl"), "utf8"), before);
	} finally {
		await fixture.close();
	}
});

test("enforce mode completes a denied call and projects result guidance once", async () => {
	const counter = { executed: 0 };
	const fixture = await openFixture({ mode: "enforce", extension: probeExtension(counter) });
	try {
		await addRule(fixture.policy, "durable-deny-probe", {
			phase: "input",
			when: { op: "eq", path: ["tool"], value: "probe" },
			action: { kind: "deny" },
			onUnavailable: "deny",
		});
		await addRule(fixture.policy, "durable-denial-guide", {
			phase: "result",
			when: { op: "eq", path: ["result", "isError"], value: true },
			action: { kind: "guide", text: "Inspect the refusal before another call." },
			onUnavailable: "skip",
		});
		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("stopped")],
			"run the probe",
		);
		const results = await toolResults(fixture.root, "probe");
		const result = results.at(-1);
		assert.equal(result?.isError, true);
		assert.match(textOf(result), /Tool call blocked/);
		assert.match(textOf(result), /Rule durable-deny-probe\./);
		assert.equal(textOf(result).split("Inspect the refusal before another call.").length - 1, 1);
		assert.equal(counter.executed, 0);
		await fixture.closeHost();
		const records = (await telemetryLines(fixture.storeDir, localDate(new Date())))
			.map((line) => JSON.parse(line));
		assert.equal(records.filter((entry) => entry.tool === "probe").length, 1);
		const record = records.find((entry) => entry.tool === "probe");
		assert.equal(record.outcome, "denied");
		assert.equal(record.policy.decision, "deny");
		assert.ok(record.classes.includes("durable-deny-probe"));
		assert.ok(record.policy.evaluations.some((entry: { id: string; phase: string; deny: boolean; truth: unknown; applicable: unknown }) =>
			entry.id === "durable-deny-probe" && entry.phase === "input" && entry.deny && entry.truth === true && entry.applicable === true));
		const day = localDate(new Date());
		const summary = await readTelemetry(fixture.storeDir, day, day);
		assert.equal(summary.rules.find((entry) => entry.id === "durable-deny-probe")?.deniedCalls, 1);
	} finally {
		await fixture.close();
	}
});

test("a new host enforces intact rules while another writer holds the store lock", async () => {
	const counter = { executed: 0 };
	const fixture = await openFixture({
		mode: "enforce",
		extension: probeExtension(counter),
		prepare: async (storeDir) => {
			await addRule(new RuleRegistry(storeDir), "held-lock-deny-probe", {
				phase: "input",
				when: { op: "eq", path: ["tool"], value: "probe" },
				action: { kind: "deny" },
				onUnavailable: "deny",
			});
			await writeFile(join(storeDir, ".rules-lock"), "held", { mode: 0o600 });
		},
	});
	try {
		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("stopped")],
			"run the probe",
		);
		const result = (await toolResults(fixture.root, "probe")).at(-1);
		assert.equal(result?.isError, true);
		assert.match(textOf(result), /Rule held-lock-deny-probe\./);
		assert.equal(counter.executed, 0);
		assert.equal(await readFile(join(fixture.storeDir, ".rules-lock"), "utf8"), "held");
	} finally {
		await fixture.close();
	}
});

for (const scenario of ["tool_unavailable", "invalid_arguments", "blocked"] as const) {
	test(`host ${scenario} retains result policy and records nonexecution once`, async () => {
		let executed = 0;
		const extension = DurableModule.defineExtension({
			name: "host-result-probe",
			tools: [DurableModule.defineTool({
				name: "host_probe",
				description: "A strictly typed local probe.",
				parameters: obj({ count: int() }, { open: false }),
				execute: async () => { executed++; return { output: [] }; },
			})],
			hooks: scenario === "blocked" ? [DurableModule.hook(DurableModule.ToolTask, {
				beforeTool: (call) => call.name === "host_probe" ? { block: "The host refused this call." } : undefined,
			})] : [],
		});
		const fixture = await openFixture({ mode: "annotate", extension });
		try {
			await addRule(fixture.policy, "host-result-guide", {
				phase: "result",
				when: { op: "eq", path: ["result", "isError"], value: true },
				action: { kind: "guide", text: "Inspect the rejected call." },
				onUnavailable: "skip",
			});
			await addRule(fixture.policy, "host-result-observe", {
				phase: "completion",
				when: { op: "eq", path: ["outcome", "executed"], value: false },
				action: { kind: "observe", label: "not-executed" },
				onUnavailable: "skip",
			});
			const name = scenario === "tool_unavailable" ? "absent_probe" : "host_probe";
			const args = scenario === "invalid_arguments" ? { count: {} } : { count: 1 };
			await submit(fixture, [
				fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
				fauxAssistantMessage("The call ended."),
			], "Attempt the local probe.");
			const result = (await toolResults(fixture.root, name)).at(-1);
			assert.equal(result?.isError, true);
			assert.match(textOf(result), /Inspect the rejected call/);
			assert.equal(executed, 0);
			await fixture.closeHost();
			const records = (await telemetryLines(fixture.storeDir, localDate(new Date())))
				.map((line) => JSON.parse(line)).filter((record) => record.tool === name);
			assert.equal(records.length, 1);
			assert.equal(records[0].outcome, scenario === "invalid_arguments" ? "invalid" : scenario === "blocked" ? "denied" : "unexecuted");
			assert.equal(records[0].policy.hostDiagnostic, scenario);
			assert.ok(records[0].policy.metadata.some((entry: { label: string }) => entry.label === "not-executed"));
		} finally {
			await fixture.close();
		}
	});
}

test("annotate mode appends guide text and records the observation period", async () => {
	const counter = { executed: 0 };
	const fixture = await openFixture({ mode: "annotate", extension: probeExtension(counter) });
	try {
		await addRule(fixture.policy, "durable-guide-probe", {
			phase: "result",
			selector: { tools: ["probe"] },
			when: { op: "eq", path: ["result", "isError"], value: false },
			action: { kind: "guide", text: "Prefer the documented probe path." },
			onUnavailable: "skip",
		});
		await addRule(fixture.policy, "durable-observe-probe", {
			phase: "completion",
			when: { op: "eq", path: ["outcome", "kind"], value: "success" },
			action: { kind: "observe", label: "calls" },
			onUnavailable: "skip",
		});
		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("guided")],
			"run the probe",
		);
		const results = await toolResults(fixture.root, "probe");
		assert.equal(counter.executed, 1);
		assert.match(textOf(results.at(-1)), /\[policy\] Prefer the documented probe path\./);

		await submit(
			fixture,
			[
				fauxAssistantMessage(fauxToolCall("policy_rules", { view: "state" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("state"),
			],
			"show observation state",
		);
		const stateResults = await toolResults(fixture.root, "policy_rules");
		const stateText = textOf(stateResults.at(-1));
		assert.match(stateText, /durable-observe-probe/);
		assert.match(stateText, /"count": 1/);
	} finally {
		await fixture.close();
	}
});

test("context-phase guidance is selected once per period and keeps its place", async () => {
	const fixture = await openFixture({ mode: "annotate" });
	try {
		await addRule(fixture.policy, "durable-context-guide", {
			phase: "context",
			when: { op: "exists", path: ["context"] },
			action: { kind: "guide", text: "Context-phase guidance." },
			onUnavailable: "skip",
			state: { observe: { op: "exists", path: ["context"] }, once: "period" },
		});
		const seen: string[] = [];
		fixture.faux.setResponses([
			(context) => {
				seen.push(JSON.stringify(context));
				return fauxAssistantMessage("first");
			},
		]);
		const first = await fixture.root.submit({ type: "input", content: "first" }, context);
		await first.wait(context);
		assert.match(seen[0] ?? "", /Context-phase guidance\./);

		fixture.faux.appendResponses([
			(context) => {
				seen.push(JSON.stringify(context));
				return fauxAssistantMessage("second");
			},
		]);
		const second = await fixture.root.submit({ type: "input", content: "second" }, context);
		await second.wait(context);
		assert.ok(seen[1]);
		assert.ok(seen[1].includes("Context-phase guidance."));
	} finally {
		await fixture.close();
	}
});

test("native guidance keeps its bytes and position across later requests", async () => {
	const storage = new DurableModule.MemoryStorage();
	const fixture = await openFixture({ mode: "annotate", storage });
	try {
		await addRule(fixture.policy, "durable-early-guide", {
			phase: "context",
			when: { op: "exists", path: ["context"] },
			action: { kind: "guide", text: "Early guidance." },
			onUnavailable: "skip",
			state: { observe: { op: "exists", path: ["context"] }, once: "period" },
		});
		const seen: Array<Array<{ role: string }>> = [];
		for (let request = 1; request <= 5; request++) {
			fixture.faux.appendResponses([
				(callContext) => {
					seen.push(callContext.messages as Array<{ role: string }>);
					return fauxAssistantMessage(`answer ${request}`);
				},
			]);
			const submission = await fixture.root.submit({ type: "input", content: `prompt ${request}` }, context);
			await submission.wait(context);
		}
		const marker = (message: { role: string }) => JSON.stringify(message).includes("Early guidance.");
		const position = seen[0].findIndex(marker);
		assert.ok(position > 0);
		for (const request of seen) {
			assert.equal(request.filter(marker).length, 1);
			assert.equal(request.findIndex(marker), position);
		}
		for (let index = 1; index < seen.length; index++)
			for (let block = 0; block < seen[index - 1].length; block++)
				if (seen[index - 1][block].role !== "system")
					assert.equal(JSON.stringify(seen[index][block]), JSON.stringify(seen[index - 1][block]));
		const record = await storage.findDocument(
			{ kind: "policy.guidance", scope: { kind: "conversation", conversationId: fixture.root.id } },
			"current",
			context,
		);
		assert.ok(record);
		assert.equal(record.history, "latest");
		assert.equal(record.fork, "current");
	} finally {
		await fixture.close();
	}
});

/** Repeating context guidance, so every request leaves a record on the newest conversation message. */
async function addRepeatingGuide(fixture: Fixture): Promise<void> {
	await addRule(fixture.policy, "durable-repeat-guide", {
		phase: "context",
		when: { op: "exists", path: ["context"] },
		action: { kind: "guide", text: "Repeat guidance." },
		onUnavailable: "skip",
	});
}

type SeenMessage = { role: string; text: string };

/** Submit prompts and record each provider request as role and text pairs. */
function requestRecorder(fixture: Fixture) {
	const seen: SeenMessage[][] = [];
	const ask = async (prompt: string) => {
		fixture.faux.appendResponses([
			(callContext) => {
				seen.push(
					(callContext.messages as Array<{ role: string; content: unknown }>).map((message) => ({
						role: message.role,
						text:
							typeof message.content === "string"
								? message.content
								: (message.content as Array<{ text?: string }>).map((block) => block.text ?? "").join(""),
					})),
				);
				return fauxAssistantMessage(`answer ${prompt}`);
			},
		]);
		const submission = await fixture.root.submit({ type: "input", content: prompt }, context);
		await submission.wait(context);
	};
	return { seen, ask };
}

const isGuidance = (message: SeenMessage | undefined) => message?.text === "[policy] Repeat guidance.";

async function guidanceHealth(fixture: Fixture): Promise<{ status: string; epoch: string | null; records: number }> {
	await submit(
		fixture,
		[fauxAssistantMessage(fauxToolCall("policy_rules", { view: "health" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
		"inspect health",
	);
	const health = JSON.parse(textOf((await toolResults(fixture.root, "policy_rules")).at(-1))) as {
		guidance: { status: string; epoch: string | null; records: number };
	};
	return health.guidance;
}

test("native guidance whose source survives real compaction keeps its place and removed sources retire", async () => {
	const fixture = await openFixture({ mode: "annotate", settings: { compaction: { keepRecentTokens: 10 } } });
	try {
		await addRepeatingGuide(fixture);
		const { seen, ask } = requestRecorder(fixture);
		for (const prompt of ["p1", "p2", "p3", "p4"]) await ask(prompt);
		fixture.faux.appendResponses([fauxAssistantMessage("Summary.")]);
		const compaction = await fixture.root.compact("Summarize.", context);
		await fixture.harness.waitForTask(compaction, context);
		const view = await fixture.root.context(context);
		assert.equal(view.head?.kind, "pi.compaction");
		await ask("p5");
		const request = seen.at(-1) ?? [];
		const texts = request.map((message) => message.text);
		assert.equal(texts.includes("p1"), false);
		assert.equal(texts.includes("p2"), false);
		for (const prompt of ["p3", "p4", "p5"]) {
			const at = texts.indexOf(prompt);
			assert.ok(at > 0, prompt);
			assert.equal(isGuidance(request[at + 1]), true, `guidance follows ${prompt}`);
		}
		assert.equal(request.filter(isGuidance).length, 3);
		assert.equal(isGuidance(request[2]), false);
		const health = await guidanceHealth(fixture);
		assert.equal(health.status, "ok");
	} finally {
		await fixture.close();
	}
});

test("native context edits without a new head retire replaced sources and keep the others", async () => {
	const fixture = await openFixture({ mode: "annotate" });
	try {
		await addRepeatingGuide(fixture);
		const { seen, ask } = requestRecorder(fixture);
		for (const prompt of ["p1", "p2", "p3"]) await ask(prompt);
		const before = await guidanceHealth(fixture);
		const view = await fixture.root.context(context);
		assert.equal(view.head, undefined);
		const userEntry = (text: string) => {
			const entry = view.entries.find((candidate) => JSON.stringify(candidate.model ?? []).includes(`"${text}"`));
			assert.ok(entry, text);
			return entry.id;
		};
		await fixture.root.submit(
			{
				type: "write",
				entry: {
					kind: "edit-note",
					edits: [
						{
							target: userEntry("p1"),
							action: "replace",
							messages: [{ role: "user", content: [{ type: "text", text: "edited p1" }], timestamp: 1 }],
						},
						{ target: userEntry("p2"), action: "omit" },
					],
				},
			},
			context,
		);
		assert.equal((await fixture.root.context(context)).head, undefined);
		await ask("p4");
		const request = seen.at(-1) ?? [];
		const texts = request.map((message) => message.text);
		assert.equal(texts.includes("p2"), false);
		assert.equal(isGuidance(request[texts.indexOf("edited p1") + 1]), false);
		for (const prompt of ["p3", "p4"]) assert.equal(isGuidance(request[texts.indexOf(prompt) + 1]), true, prompt);
		const after = await guidanceHealth(fixture);
		assert.equal(after.status, "ok");
		assert.notEqual(after.epoch, before.epoch);
	} finally {
		await fixture.close();
	}
});

test("native message appends keep the context epoch", async () => {
	const fixture = await openFixture({ mode: "annotate" });
	try {
		await addRepeatingGuide(fixture);
		const { ask } = requestRecorder(fixture);
		await ask("p1");
		const first = await guidanceHealth(fixture);
		assert.ok(first.epoch);
		await ask("p2");
		await ask("p3");
		const later = await guidanceHealth(fixture);
		assert.equal(later.epoch, first.epoch);
		assert.equal(later.status, "ok");
	} finally {
		await fixture.close();
	}
});

test("durable inspection and control surfaces answer model-issued calls", async () => {
	const counter = { executed: 0 };
	const fixture = await openFixture({ extension: probeExtension(counter) });
	try {
		await addRule(fixture.policy, "durable-guide-probe", {
			phase: "result",
			selector: { tools: ["probe"] },
			when: { op: "eq", path: ["result", "isError"], value: false },
			action: { kind: "guide", text: "Guided." },
			onUnavailable: "skip",
		});
		const call = async (name: string, args: ToolCall["arguments"]): Promise<ToolResultMessage | undefined> => {
			await submit(
				fixture,
				[fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
				`call ${name}`,
			);
			return (await toolResults(fixture.root, name)).at(-1);
		};

		const check = await call("policy_rules", {
			view: "check",
			draft: {
				operation: "add",
				id: "durable-check-draft",
				purpose: "Check a draft.",
				authority: "exact",
				reason: "Test coverage.",
				note: "A checked draft.",
				match: { command: "echo" },
			},
		});
		assert.match(textOf(check), /"admitted":true/);

		const preview = await call("policy_rules", {
			view: "preview",
			tool: "probe",
			input: {},
			result: { isError: false },
		});
		const previewJson = JSON.parse(textOf(preview)) as { preview?: boolean; stateAdvanced?: boolean; decision?: unknown };
		assert.equal(previewJson.preview, true);
		assert.equal(previewJson.stateAdvanced, false);
		assert.equal(typeof previewJson.decision, "object");

		const capabilities = await call("policy_rules", { view: "capabilities" });
		assert.match(textOf(capabilities), /"phases"/);

		const explain = await call("policy_rules", { view: "explain", id: "durable-guide-probe" });
		assert.match(textOf(explain), /durable-guide-probe/);

		const resetPreview = await call("policy_control", { operation: "reset-preview", id: "durable-guide-probe" });
		const resetRevision = detailsOf(resetPreview)?.revision;
		assert.equal(typeof resetRevision, "string");
		await call("policy_control", {
			operation: "reset",
			id: "durable-guide-probe",
			reason: "test reset",
			revision: resetRevision as string,
			authorization: "The operator asked to reset the period.",
		});

		const inspect = await call("policy_control", { operation: "inspect", id: "durable-guide-probe" });
		const targetRevision = detailsOf(inspect)?.revision;
		assert.equal(typeof targetRevision, "string");
		const disable = await call("policy_control", {
			operation: "disable",
			id: "durable-guide-probe",
			reason: "test disable",
			revision: targetRevision as string,
			authorization: "The operator asked to disable the rule.",
		});
		assert.equal(detailsOf(disable)?.applied, true);
		assert.equal(detailsOf(disable)?.state, "disabled");

		const importPreview = await call("policy_control", { operation: "import-preview", selection: "routing.cat-read" });
		assert.equal(typeof detailsOf(importPreview)?.revision, "string");
	} finally {
		await fixture.close();
	}
});

test("a reset revision survives process loss", async () => {
	const directory = await mkdtemp(join(tmpdir(), "policy-durable-reset-"));
	const storeDir = join(directory, "policy");
	const priorDir = process.env.PI_POLICY_DIR;
	process.env.PI_POLICY_DIR = storeDir;
	try {
		const storage = reopenableStorage();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = DurableModule.createRegistry();
		const first = await DurableModule.Harness.open(
			storage,
			{ models, registry, onReport: reportHarnessError },
			context,
		);
		registry.install(await createPolicyDurableExtension(hostFor(directory, first)));
		const firstRoot = await first.root(context, { agent: { model: MODEL, modelTools: { add: policyTools(registry) } } });
		faux.appendResponses([
			fauxAssistantMessage(fauxToolCall("policy_control", { operation: "reset-preview", id: "--all" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok"),
		]);
		const firstSubmission = await firstRoot.submit({ type: "input", content: "preview reset" }, context);
		await firstSubmission.wait(context);
		const firstRevision = detailsOf((await toolResults(firstRoot, "policy_control")).at(-1))?.revision;
		assert.equal(typeof firstRevision, "string");
		await first.close(context);

		const second = await DurableModule.Harness.open(storage, { models, registry, onReport: reportHarnessError }, context);
		registry.install(await createPolicyDurableExtension(hostFor(directory, second)));
		const secondRoot = await second.root(context);
		faux.appendResponses([
			fauxAssistantMessage(fauxToolCall("policy_control", { operation: "reset-preview", id: "--all" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok"),
		]);
		const secondSubmission = await secondRoot.submit({ type: "input", content: "preview reset again" }, context);
		await secondSubmission.wait(context);
		const secondRevision = detailsOf((await toolResults(secondRoot, "policy_control")).at(-1))?.revision;
		assert.equal(secondRevision, firstRevision);
		await second.close(context);
	} finally {
		await rm(directory, { recursive: true, force: true });
		if (priorDir === undefined) delete process.env.PI_POLICY_DIR;
		else process.env.PI_POLICY_DIR = priorDir;
	}
});

test("ordinary policy state updates retain deltas without automatic checkpoints", async () => {
	const storage = new DurableModule.MemoryStorage();
	const fixture = await openFixture({ storage });
	try {
		const readState = async () => {
			const record = await storage.findDocument(
				{ kind: "policy.state", scope: { kind: "conversation", conversationId: fixture.root.id } },
				"current",
				context,
			);
			assert.ok(record);
			const stored = await storage.document(record.id, "current", context);
			assert.ok(stored);
			return stored;
		};
		await submit(fixture, [fauxAssistantMessage("first")], "first request");
		const first = await readState();
		await submit(fixture, [fauxAssistantMessage("second")], "second request");
		const second = await readState();
		assert.equal(second.record.id, first.record.id);
		assert.equal(second.record.history, "latest");
		assert.equal(second.record.fork, "current");
		assert.equal(second.version, 1);
		assert.equal(second.value.turn, 2);
		assert.ok(second.deltasSinceBase > first.deltasSinceBase);
	} finally {
		await fixture.close();
	}
});

test("a malformed state document is contained without failing the read", async () => {
	const fixture = await openFixture();
	try {
		const MalformedState = DurableModule.defineDoc<DurableModule.JsonObject>({
			kind: "policy.state",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
			checkpointWhen: () => false,
			initial: () => ({
				generation: "bad",
				turn: -1,
				observation: null,
				retainedGuidance: "bad",
				completedCalls: {},
				shellCard: 42,
			}),
		});
		await fixture.harness.commit((tx) => tx.doc(MalformedState, fixture.root.id), context);
		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("policy_rules", { view: "state" }), { stopReason: "toolUse" }), fauxAssistantMessage("state")],
			"show state",
		);
		const results = await toolResults(fixture.root, "policy_rules");
		const stateText = textOf(results.at(-1));
		assert.match(stateText, /observationPeriods/);
		assert.match(stateText, /"turn": 1/);
		assert.match(stateText, /"incomplete": 0/);
		assert.match(stateText, /"staleCompletions": 0/);
	} finally {
		await fixture.close();
	}
});

test("the policy command serves the attached panel: reads, an effect-labelled approval, lifecycle controls, and a text summary", async () => {
	const fixture = await openFixture();
	try {
		const host = hostFor(fixture.directory, fixture.harness);
		await createPolicyDurableExtension(host);
		const call = (data?: unknown, origin: "operator" | "model" = "operator") => policyPanelCommand.run({ args: "", ...(data === undefined ? {} : { data: data as never }), origin, conversation: fixture.root, context, host, invocationId: "panel" });
		const answer = async <T,>(data: unknown) => (await call(data) as { text: string; data: unknown }).data as T;
		assert.match(String(await call()), /Policy mode \w+ · \d+ rules · 0 pending proposals/);
		const auditContext = { sessionManager: { getSessionId: () => "panel-test" }, model: null };
		const proposal = await fixture.policy.proposeAdd(
			{ id: "panel-rule", purpose: "Guide panel tests.", authority: "steer-or-block", matcher: { kind: "declarative", language: "facts/v1", spec: { phase: "input", when: { op: "eq", path: ["tool"], value: "bash" }, action: { kind: "guide", text: "Mind the panel." }, onUnavailable: "skip" } as FactsProgram }, note: "Panel rule." },
			"Panel test.",
			makeRuleAudit(auditContext, "agent-tool"),
		);
		const loaded = readPanelAnswer({ op: "load" }, await answer({ op: "load" }));
		assert.ok(loaded.op === "load" && loaded.snapshot.pending.some((entry) => entry.id === proposal.id) && typeof loaded.scope.cwd === "string");
		await assert.rejects(call({ op: "approve", proposalId: proposal.id, effect: "steer", revision: "000000000000" }), /revision|changed/i, "a stale revision refuses");
		const approved = readPanelAnswer({ op: "approve", proposalId: proposal.id }, await answer({ op: "approve", proposalId: proposal.id, effect: "steer", revision: proposalRevision(proposal) }));
		assert.ok(approved.op === "approve" && /Approved proposal/.test(approved.outcome));
		const snapshot = deserializeSnapshot(approved.snapshot);
		const record = snapshot.records.get("panel-rule");
		assert.ok(record && record.source.kind === "local" && record.source.approvedAudit.surface === "panel", "the panel audit surface is recorded");
		const disabled = readPanelAnswer({ op: "lifecycle", verb: "disable", id: "panel-rule", reason: "panel test" }, await answer({ op: "lifecycle", verb: "disable", id: "panel-rule", reason: "panel test", expectedIdentity: targetIdentity(record) }));
		assert.ok(disabled.op === "lifecycle" && /Disabled panel-rule/.test(disabled.outcome));
		await assert.rejects(call({ op: "lifecycle", verb: "enable", id: "panel-rule", reason: "stale", expectedIdentity: targetIdentity(record) }), /identity|changed/i, "a stale target identity refuses");
		const state = readPanelAnswer({ op: "inspect", view: "state" }, await answer({ op: "inspect", view: "state" }));
		assert.ok(state.op === "inspect" && /observationPeriods/.test(state.text));
		const revision = readPanelAnswer({ op: "reset-revision", id: "--all" }, await answer({ op: "reset-revision", id: "--all" }));
		assert.ok(revision.op === "reset-revision" && /^[a-f0-9]{12}$/.test(revision.revision));
		const reset = readPanelAnswer({ op: "reset", id: "--all", reason: "panel", revision: revision.revision }, await answer({ op: "reset", id: "--all", reason: "panel", revision: revision.revision }));
		assert.ok(reset.op === "reset" && /new policy observation period/.test(reset.outcome));
		await assert.rejects(call({ op: "steal" }), /not supported/);
	} finally {
		await fixture.close();
	}
});

test("the attached view's Data actions set, set-file and remove through the owner route with reviews and stale refusals", async () => {
	const fixture = await openFixture();
	try {
		const host = hostFor(fixture.directory, fixture.harness);
		await createPolicyDurableExtension(host);
		let beforeApply: (() => Promise<void>) | undefined;
		const request = async (data: unknown) => {
			const args = String((data as { args?: string }).args);
			if ((data as { op?: string }).op === "data" && / exact$|approveRevision/.test(args) && beforeApply) {
				const run = beforeApply;
				beforeApply = undefined;
				await run();
			}
			return (await policyPanelCommand.run({ args: "", data: data as never, origin: "operator", conversation: fixture.root, context, host, invocationId: "panel-data" })) as { text: string; data?: never };
		};
		const layers: Array<{ view: OperatorView; controller: AbortController }> = [];
		const notices: string[] = [];
		const panelHost = (controller: AbortController): PanelHost => ({
			theme: plainTheme,
			target: { id: String(fixture.root.id), label: "root" },
			signal: controller.signal,
			requestRender: () => {},
			notify: (text) => notices.push(text),
			push: (open) => {
				const child = new AbortController();
				layers.push({ view: open(panelHost(child)), controller: child });
			},
			back: () => {
				const index = layers.findIndex((layer) => layer.controller === controller);
				for (const layer of layers.splice(Math.max(1, index))) layer.controller.abort();
			},
			close: () => {},
			request,
		});
		layers.push({ view: operatorPanel().open(panelHost(new AbortController())), controller: new AbortController() });
		const top = () => layers.at(-1)?.view;
		const rendered = () => (top()?.render(110, 24) ?? []).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
		const shows = (pattern: RegExp) => () => rendered().some((line) => pattern.test(line)) || notices.some((notice) => pattern.test(notice));
		/** The frame shows a view's title in its breadcrumb; here the title is read from the view. */
		const titled = (title: string) => () => top()?.title === title;
		/** Owner reads touch the store, so waits poll the rendered view against a deadline instead of counting turns. */
		const until = async (ready: () => boolean | Promise<boolean>, what: string) => {
			for (let step = 0; step < 500; step++) {
				if (await ready()) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.fail(`${what} within 5 s:\n${rendered().join("\n")}\n${notices.join("\n")}`);
		};
		const act = (label: string) => {
			const action = top()?.actions?.().find((candidate) => candidate.label === label);
			assert.ok(action, `no ${label}: ${top()?.actions?.().map((candidate) => candidate.label).join(", ")}`);
			action.run();
		};
		const typeText = (text: string) => {
			for (const key of text) top()?.handleInput(key);
		};
		const approveReview = async (label: string) => {
			for (let page = 0; page < 200 && !shows(/All \d+ lines read/)(); page++) top()?.handleInput("\u001b[6~");
			act(label);
		};
		await until(shows(/\d+ rules/), "the registry loads");
		top()?.focusNext?.(true);
		for (let step = 0; step < 3; step++) top()?.handleInput("\u001b[C");
		top()?.handleInput("\r");
		await until(shows(/No named policy data/), "the Data scope lists the bindings");
		act("Set data…");
		typeText(JSON.stringify({ data: { name: "panel-table", kind: "table", rows: [{ key: "alias", value: "canonical" }] } }));
		act("Review change");
		await until(titled("Approve policy data"), "the complete review shows before any change");
		assert.equal((await fixture.policy.snapshot()).data.size, 0, "nothing changed before approval");
		await approveReview("Set policy data");
		await until(async () => Boolean((await fixture.policy.snapshot()).data.get("panel-table")), "the approved change applies");
		const bound = (await fixture.policy.snapshot()).data.get("panel-table");
		assert.ok(bound, "approval applied the reviewed artifact");
		assert.equal(bound.source, "operator");
		assert.equal(layers.length, 1, "the review and the form leave after the change applies");

		act("Set data…");
		typeText(JSON.stringify({ data: { name: "panel-table", kind: "table", rows: [{ key: "alias", value: "changed" }] } }));
		beforeApply = async () => {
			const current = (await fixture.policy.snapshot()).data.get("panel-table");
			assert.ok(current);
			const raced = { ...current, rows: [{ key: "alias", value: "raced" }] };
			const { namedDataRevision } = await import("./local-rules.ts");
			raced.revision = namedDataRevision(raced as never);
			await fixture.policy.setData(raced as never, current.revision, makeRuleAudit({ sessionManager: { getSessionId: () => "other" }, model: null }, "command"));
		};
		act("Review change");
		await until(titled("Approve policy data"), "the second review shows");
		await approveReview("Set policy data");
		await until(shows(/revision changed|refused/i), "a binding changed after the review refuses");
		assert.equal((await fixture.policy.snapshot()).data.get("panel-table")?.rows[0]?.value, "raced", "the stale approval changed nothing");
		// Cancel on the review leaves the form too, back to the data list.
		act("Cancel");
		assert.equal(layers.length, 1);

		const file = join(fixture.directory, "panel-data.json");
		await writeFile(file, JSON.stringify({ data: { name: "panel-file", kind: "table", source: "file", capturedAt: 1, rows: [{ key: "k", value: "v" }] }, expectedRevision: null }));
		act("Set from file…");
		typeText(JSON.stringify({ path: "panel-data.json" }));
		act("Review change");
		await until(titled("Approve policy data"), "the file review shows");
		await approveReview("Set policy data");
		await until(async () => Boolean((await fixture.policy.snapshot()).data.get("panel-file")), "set-file resolves the path against the bound conversation's cwd and applies");

		await until(shows(/panel-file/), "the list shows the file binding");
		for (let step = 0; step < 5 && !rendered().some((line) => line.startsWith("›panel-file") || line.includes("› panel-file")); step++) top()?.handleInput("\u001b[B");
		const selected = (top() as unknown as { selected?: { name?: string } }).selected;
		assert.equal(selected?.name, "panel-file", rendered().join("\n"));
		act("Remove…");
		await until(titled("Remove policy data"), "the removal review shows");
		await approveReview("Remove policy data");
		await until(async () => (await fixture.policy.snapshot()).data.get("panel-file") === undefined, "remove applies the reviewed binding revision");
		await until(shows(/panel-table/), "the list shows the remaining binding");
		const events = (await readFile(join(fixture.directory, "policy", "rules.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind?: string; audit?: { surface?: string } });
		const surfaces = events.filter((event) => event.kind === "data").map((event) => event.audit?.surface);
		assert.deepEqual(surfaces, ["panel", "command", "panel", "panel"], "the view's set, set-file and remove carry the panel audit; the raced write keeps its own");
	} finally {
		await fixture.close();
	}
});

test("a running host applies a committed rule change to the next call", async () => {
	const counter = { executed: 0 };
	const fixture = await openFixture({ mode: "enforce", extension: probeExtension(counter) });
	try {
		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("first")],
			"run the probe",
		);
		assert.equal((await toolResults(fixture.root, "probe")).at(-1)?.isError, false);
		await addRule(fixture.policy, "durable.deny-probe", {
			phase: "input",
			selector: { tools: ["probe"] },
			when: { op: "exists", path: ["input"] },
			action: { kind: "deny" },
			onUnavailable: "skip",
		});
		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("second")],
			"run the probe again",
		);
		const denied = (await toolResults(fixture.root, "probe")).at(-1);
		assert.equal(denied?.isError, true);
		assert.match(textOf(denied), /Rule durable\.deny-probe/);
		assert.equal(counter.executed, 1);
	} finally {
		await fixture.close();
	}
});

test("native tool execution does not wait for telemetry persistence", async () => {
	const counter = { executed: 0 };
	const started = deferred();
	const release = deferred();
	const batches: PolicyRecord[][] = [];
	const append: AppendTelemetry = async (_dir, records) => {
		batches.push(records.map((item) => JSON.parse(item.json) as PolicyRecord));
		started.resolve();
		await release.promise;
	};
	const fixture = await openFixture({ mode: "observe", extension: probeExtension(counter), append });
	try {
		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
			"run the probe",
		);
		await started.promise;
		assert.equal(counter.executed, 1);
		assert.equal((await toolResults(fixture.root, "probe")).length, 1);
		assert.equal(batches.length, 1, "the accepted batch is still held open");
		assert.equal(batches[0].some((record) => record.tool === "probe"), true);
		release.resolve();
		await fixture.closeHost();
		assert.equal(batches.length, 1);
	} finally {
		release.resolve();
		await fixture.close();
	}
});

test("host shutdown drains the final accepted telemetry batch", async () => {
	const counter = { executed: 0 };
	const gate = deferred();
	const batches: PolicyRecord[][] = [];
	const append: AppendTelemetry = async (_dir, records) => {
		batches.push(records.map((item) => JSON.parse(item.json) as PolicyRecord));
		await gate.promise;
	};
	const fixture = await openFixture({ mode: "observe", extension: probeExtension(counter), append });
	let drained = false;
	try {
		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
			"run the probe",
		);
		const closing = fixture.closeHost().then(() => {
			drained = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(drained, false, "close waits for the held batch");
		gate.resolve();
		await closing;
		assert.equal(drained, true);
		assert.equal(batches.length, 1);
	} finally {
		gate.resolve();
		await fixture.close();
	}
});

test("native telemetry health follows pressure and recovery from the writer snapshot", async () => {
	const gate = deferred();
	const pressure = deferred();
	const recovered = deferred();
	let attempts = 0;
	const fixture = await openFixture({
		mode: "observe",
		extension: probeExtension({ executed: 0 }),
		append: async () => {
			if (++attempts === 1) throw new TelemetryLockBusyError("held");
			await gate.promise;
		},
	});
	const warnings: string[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => {
		const text = args.map(String).join(" ");
		warnings.push(text);
		if (text.includes("telemetry pressure")) pressure.resolve();
		if (text.includes("telemetry ok")) recovered.resolve();
	};
	try {
		await submit(fixture,
			[fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")], "run probe");
		await pressure.promise;
		const inspect = async () => {
			await submit(fixture,
				[fauxAssistantMessage(fauxToolCall("policy_rules", { view: "health" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")], "inspect health");
			return JSON.parse(textOf((await toolResults(fixture.root, "policy_rules")).at(-1))).telemetry;
		};
		assert.deepEqual(await inspect(), { state: "pressure", lostRecords: 0, lostBytes: 0 });
		gate.resolve();
		await recovered.promise;
		assert.deepEqual(await inspect(), { state: "ok", lostRecords: 0, lostBytes: 0 });
		assert.equal(warnings.filter((line) => line.includes("telemetry pressure")).length, 1);
		assert.equal(warnings.filter((line) => line.includes("telemetry ok")).length, 1);
	} finally {
		gate.resolve();
		console.warn = warn;
		await fixture.close();
	}
});

test("native telemetry failure reports once in health without changing an approved denial", async () => {
	const counter = { executed: 0 };
	let attempts = 0;
	const fixture = await openFixture({
		mode: "enforce",
		extension: probeExtension(counter),
		append: async () => {
			attempts++;
			throw new Error("disk unavailable");
		},
	});
	const warnings: string[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((value) => String(value)).join(" "));
	};
	try {
		await addRule(fixture.policy, "telemetry-failure-deny", {
			phase: "input",
			when: { op: "eq", path: ["tool"], value: "probe" },
			action: { kind: "deny" },
			onUnavailable: "deny",
		});
		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("stopped")],
			"run the probe",
		);
		const denied = (await toolResults(fixture.root, "probe")).at(-1);
		assert.equal(denied?.isError, true);
		assert.match(textOf(denied), /telemetry-failure-deny/);
		assert.equal(counter.executed, 0);
		await waitFor(() => warnings.some((line) => line.includes("telemetry persistence stopped")), "telemetry failure");
		const reports = warnings.filter((line) => line.includes("telemetry persistence stopped"));
		assert.equal(reports.length, 1);
		assert.match(reports[0], /disk unavailable/);
		assert.ok(attempts >= 1);

		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("stopped again")],
			"run the probe again",
		);
		const deniedAgain = (await toolResults(fixture.root, "probe")).at(-1);
		assert.equal(deniedAgain?.isError, true);
		assert.equal(counter.executed, 0);
		assert.equal(warnings.filter((line) => line.includes("telemetry persistence stopped")).length, 1);

		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("policy_rules", { view: "health" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
			"inspect health",
		);
		const health = JSON.parse(textOf((await toolResults(fixture.root, "policy_rules")).at(-1))) as {
			telemetry: { state: string; lostRecords: number; lostBytes: number; reason?: string };
			authority: { status: string };
		};
		assert.equal(health.telemetry.state, "failed");
		assert.ok(health.telemetry.lostRecords > 0);
		assert.ok(health.telemetry.lostBytes > 0);
		assert.match(health.telemetry.reason ?? "", /disk unavailable/);
		assert.equal(health.authority.status, "ok");
	} finally {
		console.warn = warn;
		await fixture.close();
	}
});
