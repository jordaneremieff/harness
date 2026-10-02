/**
 * Durable policy contribution tests.
 *
 * Each test drives model-issued calls through a real Pi Durable Harness over
 * MemoryStorage and the pi-ai faux provider, with the contribution built from
 * the real pi-durable module. The tests check one call per policy tool, the
 * declared replay classes through real interruption and reopen, and the native
 * hook mapping for deny, guide, and observation decisions.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as DurableModule from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createPolicyDurableExtension, type PolicyDurableHost } from "./durable.ts";
import { makeRuleAudit, proposalRevision, RuleRegistry } from "./local-rules.ts";
import type { FactsProgram } from "./program.ts";

const context = BACKGROUND_CONTEXT;
const MODEL = { provider: "faux", modelId: "faux-1" } as const;

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

function hostFor(directory: string): PolicyDurableHost {
	return {
		durable: DurableModule,
		services: {} as PolicyDurableHost["services"],
		cwd: directory,
		agentDir: directory,
		storageId: "durable-test-storage",
		signal: new AbortController().signal,
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
				parameters: Type.Object({}),
				execute: async () => {
					counter.executed += 1;
					return { content: [{ type: "text", text: "probe ran" }] };
				},
			}),
		],
	});
}

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

function structuredOf(message: ToolResultMessage | undefined): Record<string, unknown> | undefined {
	const details = message?.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>).structuredContent;
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

interface Fixture {
	harness: DurableModule.Harness;
	root: DurableModule.Conversation;
	faux: ReturnType<typeof fauxProvider>;
	registry: DurableModule.Registry;
	directory: string;
	storeDir: string;
	policy: RuleRegistry;
	close: () => Promise<void>;
}

interface FixtureOptions {
	mode?: string;
	extension?: DurableModule.Extension;
	block?: { name: string; started: () => void };
}

async function openFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const directory = await mkdtemp(join(tmpdir(), "policy-durable-"));
	const storeDir = join(directory, "policy");
	const priorDir = process.env.PI_POLICY_DIR;
	const priorMode = process.env.PI_POLICY_MODE;
	process.env.PI_POLICY_DIR = storeDir;
	if (options.mode === undefined) delete process.env.PI_POLICY_MODE;
	else process.env.PI_POLICY_MODE = options.mode;
	try {
		let contribution = createPolicyDurableExtension(hostFor(directory));
		if (options.block) contribution = blockOnce(contribution, options.block.name, options.block.started);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = DurableModule.createRegistry();
		registry.install(contribution);
		if (options.extension) registry.install(options.extension);
		const harness = await DurableModule.Harness.open(new DurableModule.MemoryStorage(), { models, registry }, context);
		const root = await harness.root(context, { agent: { model: MODEL } });
		return {
			harness,
			root,
			faux,
			registry,
			directory,
			storeDir,
			policy: new RuleRegistry(storeDir),
			close: async () => {
				await harness.close(context);
				await rm(directory, { recursive: true, force: true });
				if (priorDir === undefined) delete process.env.PI_POLICY_DIR;
				else process.env.PI_POLICY_DIR = priorDir;
				if (priorMode === undefined) delete process.env.PI_POLICY_MODE;
				else process.env.PI_POLICY_MODE = priorMode;
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
		assert.equal(structuredOf(rules.at(-1))?.rules !== undefined, true);

		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("policy_propose", proposeArgs), { stopReason: "toolUse" }), fauxAssistantMessage("proposed")],
			"propose a rule",
		);
		const proposals = await toolResults(fixture.root, "policy_propose");
		const proposal = structuredOf(proposals.at(-1));
		assert.equal(proposal?.state, "pending");
		assert.equal(proposal?.ruleId, "durable-tool-test");
		assert.equal(typeof proposal?.proposalId, "string");
		assert.equal(typeof proposal?.proposalRevision, "string");

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
		assert.equal(structuredOf(approvals.at(-1))?.decision, "approved");
		assert.equal(structuredOf(approvals.at(-1))?.ruleId, "durable-tool-test");
		const store = await readFile(join(fixture.storeDir, "rules.jsonl"), "utf8");
		assert.match(store, /"kind":"decision"/);

		await submit(
			fixture,
			[fauxAssistantMessage(fauxToolCall("policy_control", { operation: "mode" }), { stopReason: "toolUse" }), fauxAssistantMessage("reported")],
			"report mode",
		);
		const controls = await toolResults(fixture.root, "policy_control");
		assert.equal(structuredOf(controls.at(-1))?.mode, "observe");
	} finally {
		await fixture.close();
	}
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
		registry.install(blockOnce(createPolicyDurableExtension(hostFor(directory)), "policy_propose", started.resolve));
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("policy_propose", proposeArgs), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const first = await DurableModule.Harness.open(storage, { models, registry }, context);
		const root = await first.root(context, { agent: { model: MODEL } });
		const submission = await root.submit({ type: "input", content: "propose" }, context);
		await started.promise;
		await first.close(context);

		const second = await DurableModule.Harness.open(storage, { models, registry }, context);
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
		const store = await readFile(join(storeDir, "rules.jsonl"), "utf8");
		assert.equal(store.includes('"kind":"proposal"'), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
		if (priorDir === undefined) delete process.env.PI_POLICY_DIR;
		else process.env.PI_POLICY_DIR = priorDir;
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
		registry.install(blockOnce(createPolicyDurableExtension(hostFor(fixtureDirectory)), "policy_rules", started.resolve));
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("policy_rules", { view: "rules" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const first = await DurableModule.Harness.open(storage, { models, registry }, context);
		const root = await first.root(context, { agent: { model: MODEL } });
		const submission = await root.submit({ type: "input", content: "list" }, context);
		await started.promise;
		await first.close(context);

		const second = await DurableModule.Harness.open(storage, { models, registry }, context);
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

test("enforce mode blocks a denied tool call before execution", async () => {
	const counter = { executed: 0 };
	const fixture = await openFixture({ mode: "enforce", extension: probeExtension(counter) });
	try {
		await addRule(fixture.policy, "durable-deny-probe", {
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
		const results = await toolResults(fixture.root, "probe");
		const result = results.at(-1);
		assert.equal(result?.isError, true);
		assert.match(textOf(result), /Tool call blocked/);
		assert.match(textOf(result), /Rule durable-deny-probe\./);
		assert.equal(counter.executed, 0);
	} finally {
		await fixture.close();
	}
});

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
		const resetRevision = structuredOf(resetPreview)?.revision;
		assert.equal(typeof resetRevision, "string");
		await call("policy_control", {
			operation: "reset",
			id: "durable-guide-probe",
			reason: "test reset",
			revision: resetRevision as string,
			authorization: "The operator asked to reset the period.",
		});

		const inspect = await call("policy_control", { operation: "inspect", id: "durable-guide-probe" });
		const targetRevision = structuredOf(inspect)?.revision;
		assert.equal(typeof targetRevision, "string");
		const disable = await call("policy_control", {
			operation: "disable",
			id: "durable-guide-probe",
			reason: "test disable",
			revision: targetRevision as string,
			authorization: "The operator asked to disable the rule.",
		});
		assert.equal(structuredOf(disable)?.applied, true);
		assert.equal(structuredOf(disable)?.state, "disabled");

		const importPreview = await call("policy_control", { operation: "import-preview", selection: "routing.cat-read" });
		assert.equal(typeof structuredOf(importPreview)?.revision, "string");
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
			initial: () => ({
				generation: "bad",
				turn: -1,
				observation: null,
				retainedGuidance: "bad",
				completedCalls: {},
				shellCardDelivered: "no",
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
		assert.match(stateText, /"turn": [01]/);
	} finally {
		await fixture.close();
	}
});
