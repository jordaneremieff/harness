import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { ORDINARY_CONTINUITY_ENTRY } from "./continuity-facts.ts";
import { AgentManager } from "./manager.ts";

/**
 * One ordinary session with one created agent whose row the catalog view supplies, and a scripted control path.
 * A provider-blocked agent carries the view's intervention hint.
 */
async function cellFixture(t: TestContext, providerBlocked = false) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-cell-")));
	const saved = new Map(
		["PI_AGENT_SESSIONS_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_HARNESS_FILE"].map((key) => [
			key,
			process.env[key],
		]),
	);
	process.env.PI_AGENT_SESSIONS_DIR = root;
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_AGENT_DIR = root;
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	writeFileSync(join(root, "harness.json"), "{}");
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[
		Symbol.for("pi.extension.agent.owners")
	];
	t.after(async () => {
		await owners.managers.get(root)?.close();
		owners.managers.delete(root);
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	const manager = new AgentManager({
		root,
		agentDir: root,
		packageDir: root,
		createPrimary: async (options) => ({
			id: options.id,
			socketPath: "unused",
			info: () => ({
				id: options.id,
				cwd: root,
				hostname: "fixture",
				pid: process.pid,
				socketPath: "unused",
				startedAt: new Date().toISOString(),
			}),
			update() {},
			publishIntent() {},
			touch() {},
			setObservedPurpose() {},
			setWorkRefs() {},
			close: async () => {},
		}),
		observe: async () => {
			throw new Error("the footer cell must not observe native storage");
		},
		connect: async () => {
			throw new Error("the footer cell must not connect");
		},
	});
	owners.managers.set(root, manager);
	const session = SessionManager.create(root, join(root, "sessions"));
	session.appendMessage({ role: "user", content: "Schedule a check", timestamp: 1 });
	const target = manager.catalog.create({
		cwd: root,
		agentDir: root,
		packageDir: root,
		ownerId: session.getSessionId(),
		model: { provider: "test", modelId: "model" },
		thinkingLevel: "off",
	}).storageId;
	manager.catalog.updateView(target, {
		updatedAt: new Date().toISOString(),
		coverage: { complete: true, omitted: 0 },
		rows: [
			{
				id: target,
				storageId: target,
				cwd: root,
				owner: "unknown",
				state: "idle",
				modifiedAt: 1,
				cost: 0,
				partial: false,
			},
		],
		...(providerBlocked
			? {
					attention: {
						rows: [{ identity: target, kind: "provider-blocked" as const, blockId: "usage-limit" }],
						coverage: { complete: true, omitted: 0 },
					},
				}
			: {}),
	});
	const controls: string[] = [];
	manager.control = async (method: string) => {
		controls.push(method);
		if (method === "timer-schedule")
			return { timerId: 7, identity: target, disposition: "scheduled", status: "pending" };
		if (method === "timer-cancel") return { timerId: 7, outcome: "marked", status: "cancelled", identity: target };
		throw new Error(`unexpected control ${method}`);
	};
	const events = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const tools = new Map<string, ToolDefinition>();
	await register({
		events: { emit() {}, on: () => () => {} },
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			events.set(name, [...(events.get(name) ?? []), handler]);
			return () => {};
		},
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		getThinkingLevel: () => "off",
		appendEntry: (kind: string, data: unknown) => session.appendCustomEntry(kind, data),
	} as unknown as ExtensionAPI);
	const statuses: Array<string | undefined> = [];
	const ui = {
		setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		theme: { fg: (color: string, text: string) => `<${color}>${text}` },
	};
	const ctx = {
		cwd: root,
		sessionManager: session,
		ui,
		modelRegistry: { getAll: () => [], find: () => undefined },
	} as unknown as ExtensionContext;
	for (const handler of events.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	const call = (name: string, id: string, input: Record<string, unknown>) =>
		tools.get(name)?.execute(id, input, new AbortController().signal, undefined, ctx as ExtensionToolContext);
	/** Other turn_end handlers expect a full boundary event; only the cell refresh matters here. */
	const terminalTurnEnd = async () => {
		for (const handler of events.get("turn_end") ?? [])
			await Promise.resolve()
				.then(() => handler({ entries: [] }, { ...ctx, mode: "tui" } as ExtensionContext))
				.catch(() => undefined);
	};
	const facts = () =>
		session
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === ORDINARY_CONTINUITY_ENTRY
					? [entry.data as Record<string, unknown>]
					: [],
			);
	return { session, target, controls, statuses, call, terminalTurnEnd, facts };
}

test("the footer cell marks a scheduled send as open work until its timer is cancelled", async (t) => {
	const { session, target, controls, statuses, call, terminalTurnEnd, facts } = await cellFixture(t);
	assert.equal(statuses.at(-1), "\u25cb agents: 0/1", "no work out shows the hollow dot");

	await call("agent_send", "wake", { sessionId: target, message: "Check the run", deliverAt: "2030-01-01T00:00:00Z" });
	assert.equal(statuses.at(-1), "\u25cf agents: 0/1", "a scheduled send is open work although no agent works");
	assert.deepEqual(facts(), [
		{
			phase: "requested",
			sessionId: target,
			requestId: `timer-delivery:send:${session.getSessionId()}:wake`,
			replyTo: session.getSessionId(),
			timerId: 7,
		},
	]);

	await terminalTurnEnd();
	assert.equal(
		statuses.at(-1),
		"<warning>\u25cf agents: 0/1",
		"the interactive terminal draws open work in yellow, the theme's warning colour",
	);

	await call("agent_abort", "cancel", { sessionId: target, timerId: 7 });
	assert.deepEqual(controls, ["timer-schedule", "timer-cancel"]);
	assert.equal(facts().at(-1)?.phase, "refused", "a cancelled timer closes the send that it carried");
	assert.equal(statuses.at(-1), "\u25cb agents: 0/1");
	await terminalTurnEnd();
	assert.equal(statuses.at(-1), "<muted>\u25cb agents: 0/1", "the hollow dot is grey");
});

test("the footer cell turns red while open work waits on an agent that needs intervention", async (t) => {
	const { target, statuses, call, terminalTurnEnd } = await cellFixture(t, true);
	await terminalTurnEnd();
	assert.equal(statuses.at(-1), "<muted>\u25cb agents: 0/1", "a stuck agent that nothing waits on leaves the dot grey");

	await call("agent_send", "wake", { sessionId: target, message: "Check the run", deliverAt: "2030-01-01T00:00:00Z" });
	await terminalTurnEnd();
	assert.equal(statuses.at(-1), "<error>\u25cf agents: 0/1", "open work that waits on the stuck agent is red");

	await call("agent_abort", "cancel", { sessionId: target, timerId: 7 });
	await terminalTurnEnd();
	assert.equal(statuses.at(-1), "<muted>\u25cb agents: 0/1");
});
