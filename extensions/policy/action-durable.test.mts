/** Native task hooks with local side effects and no provider credentials. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { createPolicyDurableExtension, type PolicyDurableHost } from "./durable.ts";
import { RuleRegistry, proposalRevision } from "./local-rules.ts";
import { normalizeDataArtifact } from "./data-import.ts";
import type { FactsProgram } from "./program.ts";

const SEND = "mcp__messaging__send_message";
const TOPIC = "mcp__messaging__set_topic";
const payload = { room: "release-notices", text: "The maintenance window starts at 18:00 UTC." };
const gate: FactsProgram = {
	phase: "input",
	selector: { tools: [SEND, TOPIC] },
	when: { op: "exists", path: ["input"] },
	action: { kind: "require-approval" },
	onUnavailable: "deny",
};
interface Pending {
	actionId: string;
	revision: string;
}
let sequence = 0;
function host(directory: string, harness: Durable.Harness): PolicyDurableHost {
	return {
		durable: Durable,
		services: {} as PolicyDurableHost["services"],
		cwd: directory,
		agentDir: directory,
		storageId: "synthetic-policy",
		harness,
		signal: new AbortController().signal,
		onClose: () => {},
		inventory: { contributions: [], ordinaryOnly: [] },
	};
}
async function addRule(registry: RuleRegistry, id: string, program: FactsProgram) {
	const audit = { at: new Date().toISOString(), session: "synthetic", model: null };
	const proposal = await registry.proposeAdd(
		{
			id,
			purpose: "Protect external writes.",
			authority: "exact",
			note: "Inspect the exact target and payload.",
			matcher: { kind: "declarative", language: "facts/v1", spec: program },
		},
		"Control synthetic writes.",
		{ ...audit, surface: "agent-tool" },
	);
	await registry.decide(
		proposal.id,
		"approved",
		undefined,
		{ ...audit, surface: "command" },
		proposalRevision(proposal),
	);
}
async function fixture(
	options: {
		safe?: boolean;
		later?: boolean;
		deferred?: boolean;
		storage?: Durable.Storage;
		directory?: string;
		schema?: Record<string, unknown>;
		beforeHook?: (harness: Durable.Harness) => Durable.ToolHooks["beforeTool"];
		afterHook?: Durable.ToolHooks["beforeTool"];
		execute?: (
			args: Durable.JsonObject,
			api: Durable.ToolExecutionApi,
			ctx: import("@earendil-works/chord").Context,
		) => Promise<Durable.ToolExecutionResult>;
		prepare?: (input: Durable.JsonObject) => Durable.JsonObject;
	} = {},
) {
	const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "policy-action-native-")));
	await writeFile(join(directory, "harness.json"), JSON.stringify({ version: 1, policy: { mode: "enforce" } }));
	const policy = new RuleRegistry(join(directory, "policy"), { catalog: [] });
	if ((await policy.snapshot()).records.size === 0) {
		await addRule(policy, "machine.write", gate);
		await addRule(policy, "machine.target", gate);
	}
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const reports: unknown[] = [];
	const harness = await Durable.Harness.open(
		options.storage ?? new Durable.MemoryStorage(),
		{ models, registry, onReport: (error) => reports.push(error) },
		context,
	);
	if (options.beforeHook)
		registry.install(
			Durable.defineExtension({
				name: "before-input",
				hooks: [Durable.hook(Durable.ToolTask, { beforeTool: options.beforeHook(harness) })],
			}),
		);
	registry.install(await createPolicyDurableExtension(host(directory, harness)));
	const writes: Array<{ tool: string; arguments: unknown }> = [];
	registry.install(
		Durable.defineExtension({
			name: "synthetic-messaging",
			tools: [SEND, TOPIC].map((name) =>
				Durable.defineTool({
					name,
					description: "A harmless local write.",
					replay: options.safe ? "safe" : "unsafe",
					deferred: options.deferred ?? false,
					parameters:
						options.schema ??
						Type.Object({ room: Type.String(), text: Type.String() }, { additionalProperties: false }),
					...(options.prepare ? { prepareArguments: options.prepare } : {}),
					execute: async (args, api, ctx) => {
						writes.push({ tool: name, arguments: structuredClone(args) });
						return options.execute
							? options.execute(args, api, ctx)
							: { output: [{ type: "text", text: "saved locally" }] };
					},
				}),
			),
		}),
	);
	if (options.afterHook)
		registry.install(
			Durable.defineExtension({
				name: "after-input",
				hooks: [Durable.hook(Durable.ToolTask, { beforeTool: options.afterHook })],
			}),
		);
	if (options.later)
		registry.install(
			Durable.defineExtension({
				name: "later-input",
				hooks: [
					Durable.hook(Durable.ToolTask, {
						beforeTool: (call) =>
							call.name === SEND ? { arguments: { ...call.arguments, room: "other" } } : undefined,
					}),
				],
			}),
		);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const call = async (name: string, args: Record<string, unknown>, prompt = "Use the selected operation.") => {
		faux.appendResponses([
			fauxAssistantMessage(fauxToolCall(name, args, { id: `action-${++sequence}` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Finished."),
		]);
		const input = await root.submit({ type: "input", content: prompt }, context);
		await input.wait(context);
		const entries = await root.entries({}, 200, undefined, context);
		const results = entries.items
			.flatMap((entry) => (entry.kind === "pi.tool-result" && entry.model ? entry.model : []))
			.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === name);
		const result = results[0];
		assert.ok(result);
		return result;
	};
	const control = async (args: Record<string, unknown>, prompt?: string): Promise<Record<string, unknown>> => {
		const result = await call("policy_control", args, prompt);
		assert.equal(result.isError, false, JSON.stringify(result.content));
		return result.details as Record<string, unknown>;
	};
	const pending = async (): Promise<Pending[]> =>
		((await control({ operation: "actions" })).actions as Pending[]).map(({ actionId, revision }) => ({
			actionId,
			revision,
		}));
	const approve = async (): Promise<Pending> => {
		const actions = await pending();
		assert.equal(actions.length, 1);
		const entry = actions[0];
		const inspected = await control({ operation: "action-inspect", actionId: entry.actionId });
		assert.deepEqual(inspected.arguments, payload);
		assert.equal((inspected.rules as unknown[]).length, 2);
		await control(
			{
				operation: "action-approve",
				...entry,
				authorization: "The operator approved this exact room and payload in context.",
			},
			"Yes, send that exact message once.",
		);
		return entry;
	};
	return {
		directory,
		harness,
		root,
		registry,
		policy,
		faux,
		writes,
		call,
		control,
		pending,
		approve,
		close: async (remove = true) => {
			await harness.close(context);
			assert.deepEqual(reports, []);
			if (remove) await rm(directory, { recursive: true, force: true });
		},
	};
}

test("native exact approval permits one unchanged action and leaves future operations gated", {
	timeout: 30000,
}, async () => {
	const f = await fixture();
	try {
		assert.equal((await f.call(SEND, payload, "Send the maintenance notice to release-notices.")).isError, true);
		assert.equal(f.writes.length, 0);
		const armed = await f.approve();
		const capability = await f.call("policy_rules", { view: "capabilities" });
		assert.match(JSON.stringify(capability.content), /require-approval/);
		await f.call("policy_rules", { view: "preview", tool: SEND, input: payload });
		await f.call("policy_rules", {
			view: "check",
			draft: {
				operation: "add",
				id: "trial.draft",
				purpose: "Protect the synthetic write.",
				authority: "exact",
				reason: "Check without permission state.",
				note: "Require exact approval.",
				language: "facts/v1",
				program: gate,
			},
			cases: [
				{
					name: "blocked",
					steps: [{ kind: "call", at: 0, turn: 1, tool: SEND, input: payload, expect: { denied: true } }],
				},
			],
		});
		assert.equal((await f.control({ operation: "action-inspect", actionId: armed.actionId })).state, "approved");
		assert.equal((await f.call(SEND, { ...payload, room: "other" })).isError, true);
		assert.equal(f.writes.length, 0);
		await f.call(SEND, payload);
		assert.equal(f.writes.length, 1);
		assert.deepEqual(f.writes[0].arguments, payload);
		assert.equal((await f.call(SEND, payload)).isError, true);
		assert.equal(f.writes.length, 1);
	} finally {
		await f.close();
	}
});

for (const options of [{ safe: true }, { later: true }])
	test(`native refuses unsafe approval boundaries: ${JSON.stringify(options)}`, { timeout: 30000 }, async () => {
		const f = await fixture(options);
		try {
			await f.call(SEND, payload);
			await f.approve();
			const result = await f.call(SEND, payload);
			assert.equal(result.isError, true);
			assert.equal(f.writes.length, 0);
			assert.match(JSON.stringify(result.content), options.safe ? /replay:safe/ : /Operator approval required/);
		} finally {
			await f.close();
		}
	});

test("native callable-only nested MCP identity receives exact approval", { timeout: 30000 }, async () => {
	const f = await fixture({ deferred: true });
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
	f.registry.install(createCodemodeExtension({ sandbox, models: false }));
	try {
		const code = `text(await tools.${SEND}(${JSON.stringify(payload)}));`;
		await f.call("codemode", { code }, "Send the maintenance notice to release-notices.");
		assert.equal(f.writes.length, 0);
		await f.approve();
		await f.call("codemode", { code });
		assert.equal(f.writes.length, 1);
		assert.deepEqual(f.writes[0].arguments, payload);
		await f.call("codemode", { code });
		assert.equal(f.writes.length, 1);
		const topic = { room: "release-notices", text: "Maintenance at 18:00 UTC" };
		await f.call("codemode", { code: `text(await tools.${TOPIC}(${JSON.stringify(topic)}));` });
		assert.equal(f.writes.length, 1);
		const actions = await f.pending();
		let selected: Pending | undefined;
		for (const action of actions) {
			const detail = await f.control({ operation: "action-inspect", actionId: action.actionId });
			if (detail.tool === TOPIC) {
				selected = action;
				assert.deepEqual(detail.arguments, topic);
			}
		}
		assert.ok(selected);
		await f.control({
			operation: "action-approve",
			...selected,
			authorization: "The operator approved the exact topic and room.",
		});
		await f.call("codemode", { code: `text(await tools.${TOPIC}(${JSON.stringify(topic)}));` });
		assert.equal(f.writes.length, 2);
	} finally {
		await sandbox.close();
		await f.close();
	}
});

test("native restart discards an armed permission rather than restoring it from history", {
	timeout: 30000,
}, async () => {
	const inner = new Durable.MemoryStorage();
	const storage = new Proxy(inner as Durable.Storage, {
		get(target, property, receiver) {
			if (property === "close") return async () => {};
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const first = await fixture({ storage });
	let directory = first.directory;
	try {
		await first.call(SEND, payload);
		const armed = await first.approve();
		await first.close(false);
		const second = await fixture({ storage, directory });
		directory = "";
		try {
			assert.deepEqual(await second.pending(), []);
			const stale = await second.call("policy_control", {
				operation: "action-approve",
				...armed,
				authorization: "The earlier exact approval.",
			});
			assert.equal(stale.isError, true);
			await second.call(SEND, payload);
			assert.equal(second.writes.length, 0);
		} finally {
			await second.close();
		}
	} finally {
		if (directory) await rm(directory, { recursive: true, force: true });
	}
});

test("native host normalization defines the exact inspected payload", { timeout: 30000 }, async () => {
	const schema = {
		type: "object",
		properties: { room: { type: "string" }, text: { type: "string" }, optional: { type: "string" } },
		required: ["room", "text"],
		additionalProperties: false,
	};
	const f = await fixture({ schema });
	try {
		// Policy inserts no defaults; the actual host normalizes optional nulls before the hook.
		await f.call(SEND, { ...payload, optional: null });
		const actions = await f.pending();
		assert.equal(actions.length, 1);
		const inspected = await f.control({ operation: "action-inspect", actionId: actions[0].actionId });
		assert.deepEqual(inspected.arguments, payload);
		await f.control({
			operation: "action-approve",
			...actions[0],
			authorization: "The operator approved the normalized exact payload.",
		});
		await f.call(SEND, payload);
		assert.deepEqual(f.writes[0].arguments, payload);
	} finally {
		await f.close();
	}
});

function latch() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
test("native pinned phase hooks cannot change the executed approved payload", { timeout: 30000 }, async () => {
	let enabled = false;
	let setupCalls = 0;
	let tailCalls = 0;
	let currentWithoutTail = false;
	const f = await fixture({
		beforeHook: (harness) => async (call, api, ctx) => {
			if (!enabled || call.name !== SEND) return;
			const conversation = await harness.conversation(api.conversationId, ctx);
			assert.ok(conversation);
			await conversation.configure({ extensions: { remove: [{ name: "after-input" }] } }, ctx);
			setupCalls++;
			currentWithoutTail = !(await conversation.agent(ctx)).extensions.some(
				(extension) => extension.name === "after-input",
			);
		},
		afterHook: (call) => {
			if (!enabled || call.name !== SEND) return;
			tailCalls++;
			return { arguments: { ...call.arguments, room: "other" } };
		},
	});
	try {
		await f.call(SEND, payload);
		await f.approve();
		enabled = true;
		const result = await f.call(SEND, payload);
		assert.equal(result.isError, true);
		assert.equal(f.writes.length, 0);
		assert.equal(setupCalls, 1, JSON.stringify(result.content));
		assert.equal(currentWithoutTail, true);
		assert.equal(tailCalls, 1);
		assert.equal(
			(await f.root.agent(context)).extensions.some((extension) => extension.name === "after-input"),
			false,
		);
	} finally {
		await f.close();
	}
});

test("native raw accessor input is rejected before policy invokes its getter", { timeout: 30000 }, async () => {
	let enabled = false;
	let reads = 0;
	const f = await fixture({
		beforeHook: () => (call) => {
			if (!enabled || call.name !== SEND) return;
			const args = { ...payload };
			Object.defineProperty(args, "room", {
				enumerable: true,
				get: () => {
					reads++;
					return reads === 1 ? payload.room : "other";
				},
			});
			return { arguments: args };
		},
	});
	try {
		await f.call(SEND, payload);
		await f.approve();
		enabled = true;
		const result = await f.call(SEND, payload);
		assert.equal(result.isError, true);
		assert.equal(f.writes.length, 0);
		assert.equal(reads, 0);
	} finally {
		await f.close();
	}
});

test("native final rule read rejects a change during asynchronous preparation", { timeout: 30000 }, async () => {
	const f = await fixture();
	const reached = latch();
	const release = latch();
	try {
		await f.call(SEND, payload);
		await f.approve();
		f.registry.install(
			Durable.defineExtension({
				name: "preparation-barrier",
				wraps: [
					{
						tool: SEND,
						wrap: (tool) => ({
							...tool,
							execute: (args, api, ctx) =>
								tool.execute(
									args,
									new Proxy(api, {
										get(target, key, receiver) {
											const value = Reflect.get(target, key, receiver);
											if (key !== "memo") return typeof value === "function" ? value.bind(target) : value;
											return async (...values: Parameters<typeof api.memo>) => {
												if (values[0] === "policy.call") {
													reached.resolve();
													await release.promise;
												}
												return Reflect.apply(target.memo, target, values);
											};
										},
									}),
									ctx,
								),
						}),
					},
				],
			}),
		);
		const retry = f.call(SEND, payload);
		await reached.promise;
		await addRule(f.policy, "machine.new-denial", { ...gate, action: { kind: "deny" } });
		release.resolve();
		const result = await retry;
		assert.equal(result.isError, true);
		assert.equal(f.writes.length, 0);
	} finally {
		release.resolve();
		await f.close();
	}
});

test("native policy correction delivers the checked payload without host normalization drift", {
	timeout: 30000,
}, async () => {
	const schema = {
		type: "object",
		properties: { room: { type: "string" }, text: { type: "string" }, optional: {} },
		required: ["room", "text"],
		additionalProperties: false,
	};
	const f = await fixture({ schema });
	try {
		await f.policy.setData(
			normalizeDataArtifact({
				data: {
					name: "mapping",
					kind: "table",
					source: "synthetic",
					capturedAt: Date.now(),
					rows: [{ key: "alias", value: null }],
				},
				expectedRevision: null,
			}).data,
			null,
			{ at: new Date().toISOString(), session: "synthetic", model: null, surface: "command" },
		);
		await addRule(f.policy, "machine.correct", {
			phase: "input",
			selector: { tools: [SEND] },
			data: ["mapping"],
			when: { op: "lookup", path: ["input", "optional"], table: "mapping", value: "unique" },
			action: { kind: "substitute", path: ["optional"], table: "mapping" },
			onUnavailable: "skip",
		});
		await f.call(SEND, { ...payload, optional: "alias" });
		const actions = await f.pending();
		assert.equal(actions.length, 1);
		const inspected = await f.control({ operation: "action-inspect", actionId: actions[0].actionId });
		assert.deepEqual(inspected.arguments, { ...payload, optional: null });
		await f.control({
			operation: "action-approve",
			...actions[0],
			authorization: "The operator approved the exact inspected arguments.",
		});
		const result = await f.call(SEND, { ...payload, optional: "alias" });
		assert.equal(result.isError, false);
		assert.equal(f.writes.length, 1);
		assert.deepEqual(f.writes[0].arguments, { ...payload, optional: null });
	} finally {
		await f.close();
	}
});

test("native parallel retries consume one permission at final execution", { timeout: 30000 }, async () => {
	const f = await fixture();
	try {
		await f.call(SEND, payload);
		await f.approve();
		f.faux.appendResponses([
			fauxAssistantMessage(
				[fauxToolCall(SEND, payload, { id: "parallel-a" }), fauxToolCall(SEND, payload, { id: "parallel-b" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Finished."),
		]);
		const submission = await f.root.submit({ type: "input", content: "Retry the exact approved message." }, context);
		await submission.wait(context);
		assert.equal(f.writes.length, 1);
	} finally {
		await f.close();
	}
});

test("native interruption after consumption does not restore or replay a write grant", { timeout: 30000 }, async () => {
	const inner = new Durable.MemoryStorage();
	const storage = new Proxy(inner as Durable.Storage, {
		get(target, key, receiver) {
			if (key === "close") return async () => {};
			const value = Reflect.get(target, key, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const reached = latch();
	const first = await fixture({
		storage,
		execute: async (_args, _api, ctx) => {
			reached.resolve();
			await new Promise<void>((_resolve, reject) => {
				const fail = () => reject(new Error("controlled interruption"));
				if (ctx.abortSignal?.aborted) fail();
				else ctx.abortSignal?.addEventListener("abort", fail, { once: true });
			});
			return { output: [] };
		},
	});
	const directory = first.directory;
	await first.call(SEND, payload);
	await first.approve();
	first.faux.appendResponses([
		fauxAssistantMessage(fauxToolCall(SEND, payload), { stopReason: "toolUse" }),
		fauxAssistantMessage("Finished."),
	]);
	const submission = await first.root.submit({ type: "input", content: "Send the approved message." }, context);
	await reached.promise;
	assert.equal(first.writes.length, 1);
	await first.close(false);
	await submission.wait(context).catch(() => {});
	const second = await fixture({ storage, directory });
	try {
		assert.deepEqual(await second.pending(), []);
		await second.call(SEND, payload);
		assert.equal(second.writes.length, 0);
	} finally {
		await second.close();
	}
});
