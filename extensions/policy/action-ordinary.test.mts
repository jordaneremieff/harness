/** Actual SDK sessions with a synthetic provider and local, observable write tools. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai";
import { Type } from "typebox";
import policy from "./index.ts";
import { RuleRegistry, proposalRevision } from "./local-rules.ts";
import type { FactsProgram } from "./program.ts";

const SEND = "mcp__messaging__send_message";
const TOPIC = "mcp__messaging__set_topic";
const args = { room: "release-notices", text: "The maintenance window starts at 18:00 UTC." };
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
async function fixture(
	options: {
		before?: sdk.ExtensionFactory;
		after?: sdk.ExtensionFactory;
		mode?: string;
		hostMode?: "json" | "rpc";
		extra?: FactsProgram[];
		schema?: import("typebox").TSchema;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "policy-action-ordinary-"));
	const dir = join(root, "policy");
	const registry = new RuleRegistry(dir, { catalog: [] });
	const audit = { at: new Date().toISOString(), session: "synthetic", model: null };
	for (const [index, program] of [gate, gate, ...(options.extra ?? [])].entries()) {
		const proposal = await registry.proposeAdd(
			{
				id: `machine.rule-${index}`,
				purpose: "Protect selected writes.",
				authority: "exact",
				note: "Inspect the exact write before approval.",
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
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const faux = ai.fauxProvider({
		provider: `policy-action-${++sequence}`,
		models: [{ id: "controlled", contextWindow: 100000 }],
		tokensPerSecond: 0,
	});
	const modelRuntime = await sdk.ModelRuntime.create({
		credentials: new ai.InMemoryCredentialStore(),
		modelsStore: new ai.InMemoryModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const writes: Array<{ tool: string; arguments: unknown; frozen: boolean }> = [];
	const synthetic: sdk.ExtensionFactory = (pi) => {
		for (const name of [SEND, TOPIC])
			pi.registerTool({
				name,
				label: name,
				description: "A harmless local messaging write.",
				parameters:
					options.schema ?? Type.Object({ room: Type.String(), text: Type.String() }, { additionalProperties: false }),
				execute: async (_id, input) => {
					writes.push({ tool: name, arguments: structuredClone(input), frozen: Object.isFrozen(input) });
					return { content: [{ type: "text", text: "saved locally" }], details: { count: writes.length } };
				},
			});
	};
	const oldDir = process.env.PI_POLICY_DIR;
	const oldMode = process.env.PI_POLICY_MODE;
	process.env.PI_POLICY_DIR = dir;
	process.env.PI_POLICY_MODE = options.mode ?? "enforce";
	const loader = new sdk.DefaultResourceLoader({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			...(options.before ? [options.before] : []),
			policy,
			synthetic,
			sdk.createCodemodeExtension({ mode: "on" }),
			...(options.after ? [options.after] : []),
		],
	});
	let session: sdk.AgentSession | undefined;
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await sdk.createAgentSession({
			cwd: root,
			agentDir: join(root, "agent"),
			resourceLoader: loader,
			settingsManager,
			sessionManager: sdk.SessionManager.inMemory(root),
			modelRuntime,
			model: faux.getModel(),
			tools: ["codemode", SEND, TOPIC, "policy_rules", "policy_control"],
		}));
		await session.bindExtensions({ mode: options.hostMode ?? "json" });
		const active = session;
		const run = async (calls: ai.ToolCall[], request: string) => {
			faux.setResponses([ai.fauxAssistantMessage(calls), ai.fauxAssistantMessage("Finished.")]);
			await active.prompt(request);
			return active.messages.filter((message) => message.role === "toolResult").at(-1) as ai.ToolResultMessage;
		};
		const invoke = (name: string, input: Record<string, unknown>, request = "Use the selected policy control.") =>
			run([ai.fauxToolCall(name, input, { id: `call-${++sequence}` })], request);
		const control = async (input: Record<string, unknown>, request?: string): Promise<Record<string, unknown>> => {
			const result = await invoke("policy_control", input, request);
			assert.equal(result.isError, false, JSON.stringify(result.content));
			return JSON.parse(ai.contentText(result.content));
		};
		const pending = async (): Promise<Pending[]> =>
			((await control({ operation: "actions" })).actions as Pending[]).map(({ actionId, revision }) => ({
				actionId,
				revision,
			}));
		const approve = async (): Promise<Pending> => {
			const entries = await pending();
			assert.equal(entries.length, 1);
			const entry = entries[0];
			const inspected = await control({ operation: "action-inspect", actionId: entry.actionId });
			assert.equal((inspected.rules as unknown[]).length, 2);
			assert.deepEqual(inspected.arguments, args);
			await control(
				{
					operation: "action-approve",
					...entry,
					authorization: "The operator approved the inspected room and exact message in this conversation.",
				},
				"Yes, send that exact message to release-notices once.",
			);
			return entry;
		};
		return {
			session: active,
			registry,
			writes,
			invoke,
			control,
			pending,
			approve,
			run,
			close: async () => {
				await active.dispose();
				await rm(root, { recursive: true, force: true });
				if (oldDir === undefined) delete process.env.PI_POLICY_DIR;
				else process.env.PI_POLICY_DIR = oldDir;
				if (oldMode === undefined) delete process.env.PI_POLICY_MODE;
				else process.env.PI_POLICY_MODE = oldMode;
			},
		};
	} catch (error) {
		await session?.dispose();
		await rm(root, { recursive: true, force: true });
		if (oldDir === undefined) delete process.env.PI_POLICY_DIR;
		else process.env.PI_POLICY_DIR = oldDir;
		if (oldMode === undefined) delete process.env.PI_POLICY_MODE;
		else process.env.PI_POLICY_MODE = oldMode;
		throw error;
	}
}
const plainRequest =
	"Send ‘The maintenance window starts at 18:00 UTC.’ to release-notices through the messaging tool.";

test("ordinary SDK gates direct and nested MCP-style writes once, with complete contextual control", {
	timeout: 30000,
}, async () => {
	const f = await fixture();
	try {
		let result = await f.invoke(SEND, args, plainRequest);
		assert.equal(result.isError, true);
		assert.equal(f.writes.length, 0);
		const entry = await f.approve();
		assert.match(
			JSON.stringify((await f.invoke("policy_rules", { view: "capabilities" })).content),
			/require-approval/,
		);
		await f.invoke("policy_rules", { view: "preview", tool: SEND, input: args });
		await f.invoke("policy_rules", {
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
					steps: [{ kind: "call", at: 0, turn: 1, tool: SEND, input: args, expect: { denied: true } }],
				},
			],
		});
		assert.equal((await f.control({ operation: "action-inspect", actionId: entry.actionId })).state, "approved");
		await f.invoke(SEND, { ...args, room: "other" });
		assert.equal(f.writes.length, 0);
		await f.invoke(SEND, { ...args, text: "Changed" });
		assert.equal(f.writes.length, 0);
		await f.invoke(SEND, args);
		assert.equal(f.writes.length, 1);
		assert.deepEqual(f.writes[0].arguments, args);
		assert.equal(f.writes[0].frozen, true);
		result = await f.invoke(SEND, args);
		assert.equal(result.isError, true);
		assert.equal(f.writes.length, 1);
		assert.equal(
			(await f.pending()).some((pending) => pending.actionId === entry.actionId),
			false,
		);
		const topic = { room: "release-notices", text: "Maintenance at 18:00 UTC" };
		const code = `text(await tools.${TOPIC}(${JSON.stringify(topic)}));`;
		await f.invoke("codemode", { code }, "Change the topic of release-notices to ‘Maintenance at 18:00 UTC’.");
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
		await f.control(
			{ operation: "action-approve", ...selected, authorization: "The operator approved this exact topic and room." },
			"Yes, set that topic once.",
		);
		await f.invoke("codemode", { code });
		assert.equal(f.writes.length, 2);
		assert.deepEqual(f.writes[1].arguments, topic);
		await f.invoke("codemode", { code });
		assert.equal(f.writes.length, 2);
	} finally {
		await f.close();
	}
});

for (const boundary of ["reload", "tree"] as const)
	test(`ordinary ${boundary} boundary discards an armed grant`, { timeout: 30000 }, async () => {
		const f = await fixture();
		try {
			await f.invoke(SEND, args);
			const armed = await f.approve();
			if (boundary === "reload") await f.session.reload();
			else await f.session.extensionRunner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
			assert.deepEqual(await f.pending(), []);
			assert.equal(
				(
					await f.invoke("policy_control", {
						operation: "action-approve",
						...armed,
						authorization: "The earlier exact approval.",
					})
				).isError,
				true,
			);
			await f.invoke(SEND, args);
			assert.equal(f.writes.length, 0);
		} finally {
			await f.close();
		}
	});

test("ordinary RPC-mode chat approval requires no UI confirmation", { timeout: 30000 }, async () => {
	const f = await fixture({ hostMode: "rpc" });
	try {
		await f.invoke(SEND, args, plainRequest);
		await f.approve();
		await f.invoke(SEND, args);
		assert.equal(f.writes.length, 1);
	} finally {
		await f.close();
	}
});

test("ordinary parallel retries execute one local write", { timeout: 30000 }, async () => {
	const f = await fixture();
	try {
		await f.invoke(SEND, args);
		await f.approve();
		await f.run(
			[
				ai.fauxToolCall(SEND, args, { id: `parallel-${++sequence}` }),
				ai.fauxToolCall(SEND, args, { id: `parallel-${++sequence}` }),
			],
			"Retry the approved message.",
		);
		assert.equal(f.writes.length, 1);
	} finally {
		await f.close();
	}
});

for (const kind of ["early-replacement", "early-mutation", "later-mutation", "later-replacement"] as const)
	test(`ordinary exact execution boundary: ${kind}`, { timeout: 30000 }, async () => {
		let enabled = false;
		const mutation: sdk.ExtensionFactory = (pi) => {
			pi.on("tool_call", (event) => {
				if (!enabled || event.toolName !== SEND) return;
				if (kind.endsWith("replacement"))
					(event as unknown as { input: Record<string, unknown> }).input = { room: "other", text: "Changed" };
				else (event.input as Record<string, unknown>).text = "Changed";
			});
		};
		const early = kind.startsWith("early");
		const f = await fixture(early ? { before: mutation } : { after: mutation });
		try {
			await f.invoke(SEND, args);
			await f.approve();
			enabled = true;
			const result = await f.invoke(SEND, args);
			if (kind === "later-replacement") {
				assert.equal(result.isError, false);
				assert.equal(f.writes.length, 1);
				assert.deepEqual(f.writes[0].arguments, args);
			} else {
				assert.equal(result.isError, true);
				assert.equal(f.writes.length, 0);
			}
		} finally {
			await f.close();
		}
	});

test("ordinary policy correction refuses an unproved exact-execution identity", { timeout: 30000 }, async () => {
	const correction: FactsProgram = {
		phase: "input",
		selector: { tools: [SEND] },
		when: { op: "exists", path: ["input", "old"] },
		action: { kind: "rename-key", path: [], from: "old", to: "text" },
		onUnavailable: "deny",
	};
	const f = await fixture({
		extra: [correction],
		schema: Type.Object(
			{ room: Type.String(), old: Type.Optional(Type.String()), text: Type.Optional(Type.String()) },
			{ additionalProperties: false },
		),
	});
	try {
		const result = await f.invoke(SEND, { room: "release-notices", old: "Message" });
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /start, hook and final input must agree/);
		assert.equal(f.writes.length, 0);
		assert.deepEqual(await f.pending(), []);
	} finally {
		await f.close();
	}
});

for (const mode of ["observe", "notice", "annotate"])
	test(`ordinary ${mode} reports mode without creating permissions`, { timeout: 30000 }, async () => {
		const f = await fixture({ mode });
		try {
			await f.invoke(SEND, args);
			assert.equal(f.writes.length, 1);
			assert.deepEqual(await f.pending(), []);
		} finally {
			await f.close();
		}
	});
