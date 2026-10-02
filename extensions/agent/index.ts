/** Agent controls for independent Pi Durable hosts and the ordinary primary UI. */
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, getPackageDir, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { createAgentCommand, type AgentCommandAction } from "./command.ts";
import { configurationDialog } from "./configuration-dialog.ts";
import { THINKING_LEVELS, parseConfigurationArguments } from "./configuration.ts";
import { createAgentContribution, type AgentControlDispatch } from "./durable-agents.ts";
import { AGENT_CONTROL_GUIDANCE, type AgentControlToolName } from "./control-guidance.ts";
import { ListOutputSchema, StatusOutputSchema, InspectOutputSchema, structuredObservation } from "./observation-schema.ts";
import { createAgentToolCards, renderAgentPeerMessage } from "./tool-cards.ts";
import { AgentManager, MANAGER_PROTOCOL, type AgentCaller } from "./manager.ts";
import { createRestartCommand, type RestartHosts } from "./restart.ts";
import { MAX_CONTINUITY_SUMMARY, SelfCompaction } from "./self-compaction.ts";
import { promptProjectTrust } from "./trust-support.ts";

export { AgentManager } from "./manager.ts";
const ownerKey = Symbol.for("pi.extension.agent.owners");
const controlsKey = Symbol.for("pi.agent.durable.controls");
const processState = globalThis as typeof globalThis & {
	[ownerKey]?: { managers: Map<string, AgentManager> };
	[controlsKey]?: AgentControlDispatch;
};
processState[ownerKey] ??= { managers: new Map() };
const owners = processState[ownerKey];
export function agentRestartHosts(): RestartHosts {
	for (const manager of owners.managers.values()) if (manager.managerProtocol !== MANAGER_PROTOCOL) return { identity: "", refusal: "A retained agent manager uses another protocol. Quit Pi and resume the saved session." };
	return { identity: JSON.stringify([...owners.managers].map(([root, manager]) => [root, manager.connectedStorageIds()])) };
}
const id = Type.String({ minLength: 1, maxLength: 256 });
const maybeTrust = Type.Optional(Type.Boolean());
const byId = Type.Object({ sessionId: id, trust: maybeTrust }, { additionalProperties: false });
const message = Type.Object({ sessionId: id, message: Type.String({ minLength: 1 }), replyTo: Type.Optional(id) }, { additionalProperties: false });
const spawn = Type.Object({ cwd: Type.Optional(Type.String()), name: Type.Optional(Type.String({ maxLength: 256 })), prompt: Type.Optional(Type.String()), model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS)), trust: maybeTrust }, { additionalProperties: false });
const nativeEntryId = Type.Integer({ minimum: 1 });
const inspect = Type.Object({
	sessionId: id,
	view: Type.Optional(StringEnum(["history", "activity", "branch", "search", "exact", "result"])),
	cursor: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Opaque native cursor. Pass the returned next object unchanged." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
	entryId: Type.Optional(nativeEntryId),
	fromId: Type.Optional(nativeEntryId),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	source: Type.Optional(StringEnum(["user", "assistant", "toolResult", "summary", "custom"])),
	submissionId: Type.Optional(nativeEntryId),
	operationId: Type.Optional(id),
}, { additionalProperties: false });
const compact = Type.Object({ sessionId: id, instructions: Type.Optional(Type.String()), summary: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CONTINUITY_SUMMARY })) }, { additionalProperties: false });
const configure = Type.Object({ sessionId: id, name: Type.Optional(Type.String({ maxLength: 256 })), model: Type.Optional(Type.String({ maxLength: 512 })), thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS)), trust: maybeTrust }, { additionalProperties: false });
const result = (value: unknown, schema?: TSchema): AgentToolResult<unknown> => ({ ...((value as { outcome?: string } | null)?.outcome === "failed" ? { isError: true } : {}), content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: value, structuredContent: schema ? structuredObservation(schema, value) : JSON.parse(JSON.stringify(value ?? null)) });
const observationSchemas: Partial<Record<AgentControlToolName, TSchema>> = { agent_list: ListOutputSchema, agent_status: StatusOutputSchema, agent_inspect: InspectOutputSchema };
const caller = (ctx: ExtensionContext, pi: ExtensionAPI): AgentCaller => ({ id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, ...(ctx.model ? { model: { provider: ctx.model.provider, modelId: ctx.model.id } } : {}), thinkingLevel: pi.getThinkingLevel(), validateModel: (model) => { if (!ctx.modelRegistry.find(model.provider, model.modelId)) throw new Error(`Model is not in the configured catalog: ${model.provider}/${model.modelId}`); } });
const asText = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);

export default function registerAgentExtension(pi: ExtensionAPI): void {
	pi.events.emit("durable:contribution", createAgentContribution({ source: fileURLToPath(import.meta.url), dispatch: (method, params) => {
		const dispatch = processState[controlsKey];
		if (!dispatch) throw new Error("Native Durable host controls are unavailable in this process");
		return dispatch(method, params);
	} }));
	const selfCompaction = new SelfCompaction((handler) => pi.on("turn_end", handler));
	const cards = createAgentToolCards();
	const primaries = new Map<string, AbortController>();
	const getManager = (): AgentManager => {
		const agentDir = process.env.PI_AGENT_DIR ?? getAgentDir();
		const configured = resolve(process.env.PI_AGENT_SESSIONS_DIR ?? join(agentDir, "agent-sessions"));
		mkdirSync(configured, { recursive: true, mode: 0o700 });
		const root = realpathSync(configured);
		const existing = owners.managers.get(root);
		if (existing) {
			if (existing.managerProtocol !== MANAGER_PROTOCOL) throw new Error("The agent manager protocol changed. Restart Pi before agent controls.");
			return existing;
		}
		const manager = new AgentManager({ root, agentDir, packageDir: getPackageDir() });
		owners.managers.set(root, manager);
		return manager;
	};
	const control = (method: string, input: Record<string, unknown>, ctx: ExtensionContext) => getManager().control(method, input, caller(ctx, pi));
	const register = (name: AgentControlToolName, description: string, parameters: TSchema, execute: (input: Record<string, unknown>, ctx: ExtensionContext, callId: string) => Promise<unknown>, modelOnly = false): void => {
		const guidance = AGENT_CONTROL_GUIDANCE[name];
		const schema = observationSchemas[name];
		pi.registerTool({ name, label: name.replace("agent_", "Agent "), description, promptSnippet: guidance.snippet, promptGuidelines: [...guidance.guidelines ?? []], parameters, outputSchema: schema ?? Type.Unknown(), ...(modelOnly ? { exposure: "model-only" as const } : {}),
			async execute(callId, input, _signal, _update, ctx) { return result(await execute(input as Record<string, unknown>, ctx, callId), schema); },
			renderCall: cards[name].renderCall,
			renderResult: cards[name].renderResult,
		});
	};
	register("agent_spawn", "Start an independent Durable agent. A prompt starts work; no prompt creates an idle agent. The host survives this Pi process.", spawn, (input, ctx) => getManager().spawn(input, caller(ctx, pi)));
	register("agent_list", "Discover Durable agent identities and names without a writer. Repeat the query and cursor to continue bounded results.", Type.Object({ query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), cwd: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), cursor: Type.Optional(Type.String({ maxLength: 2048 })) }, { additionalProperties: false }), (input) => getManager().list(input));
	register("agent_status", "Read Durable conversations and live host state. Unavailable evidence remains explicit.", Type.Object({ sessionId: Type.Optional(id) }, { additionalProperties: false }), (input) => getManager().status(input.sessionId as string | undefined));
	register("agent_inspect", "Read retained Durable entries, results, and task state. Pass returned next objects as cursor. Result reads use submissionId or operationId; exact reads use entryId. Images and signatures are omitted.", inspect, (input, ctx) => control("inspect", input, ctx));
	register("agent_send", "Admit a task, report, or correction. Idle agents start; busy agents receive durable steering. A receipt does not prove action.", message, (input, ctx) => control("submit", { ...input, whenBusy: "steer" }, ctx));
	register("agent_steer", "Steer live or retained work through its Durable owner. Admitted steering survives process loss. Carried operator decisions retain their original scope; agent claims remain claims.", message, (input, ctx) => control("submit", { ...input, whenBusy: "steer" }, ctx));
	register("agent_abort", "Abort this agent's native task tree without deleting retained evidence. Other storage conversations remain separate.", byId, (input, ctx) => control("abort", input, ctx));
	register("agent_attach", "Connect to a Durable storage host without new input. Retained unfinished work resumes automatically.", Type.Object({ sessionId: id, model: Type.Optional(Type.String()), trust: maybeTrust }, { additionalProperties: false }), (input, ctx) => control("attach", input, ctx));
	register("agent_fork", "Create an idle native conversation branch in the same storage. The source remains unchanged.", Type.Object({ sessionId: id, entryId: Type.Optional(id), trust: maybeTrust }, { additionalProperties: false }), (input, ctx) => control("fork", input, ctx));
	register("agent_rewind", "Fork before a mistaken entry and redo the work under your correction. The source stays unchanged. Files remain current.", Type.Object({ sessionId: id, entryId: id, correction: Type.String({ minLength: 1 }), trust: maybeTrust }, { additionalProperties: false }), (input, ctx) => control("rewind", input, ctx));
	register("agent_configure", "Change an idle Durable agent's name, exact model, or reasoning level. No task starts. Active work refuses configuration.", configure, (input, ctx) => control("configure", input, ctx));
	register("agent_command", "Invoke a native contribution command, reload registrations, or fork to a tree entry through its Durable owner.", Type.Object({ sessionId: id, name: Type.String({ minLength: 1 }), args: Type.Optional(Type.String()) }, { additionalProperties: false }), (input, ctx) => control("command", input, ctx));
	register("agent_place", "Use the agent bound to a directory, or create it. Longest bound directory wins. An optional prompt starts work.", Type.Object({ area: Type.Optional(Type.String()), topic: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()), trust: maybeTrust }, { additionalProperties: false }), (input, ctx) => getManager().place(input, caller(ctx, pi)));
	register("agent_compact", "Compact another Durable agent after abort. For primary self-compaction, supply a complete continuity summary; it applies after this tool batch.", compact, async (input, ctx, callId) => {
		if (input.sessionId === ctx.sessionManager.getSessionId()) {
			if (input.instructions !== undefined) throw new Error("Primary self-compaction accepts summary, not instructions");
			selfCompaction.request(String(input.sessionId), callId, input.summary as string | undefined);
			return "Continuity summary queued for this completed tool batch.";
		}
		if (input.summary !== undefined) throw new Error("Another agent's compaction accepts instructions, not summary");
		return control("compact", input, ctx);
	}, true);

	const sessionHelp = "Type part of a session name or directory, then press Tab to insert its ID.";
	const actions: AgentCommandAction[] = [
		{ name: "new", description: "Start a new Durable agent", args: [{ name: "task", rest: true, optional: true }], help: "Describe the task in your own words. The agent uses your current directory and model. Its host survives this primary process; advanced overrides use agent_spawn.", run: async (args, ctx) => asText(await getManager().spawn({ prompt: args.join(" ") || undefined }, caller(ctx, pi))) },
		{ name: "list", description: "List Durable agents", args: [], help: "Read saved agents without a writer. Use agent_list to continue bounded pages.", run: async () => asText(await getManager().list()) },
		{ name: "status", description: "Show agent state", args: [{ name: "session", optional: true, complete: "session" }], help: `Without a session, show bounded native conversation state. ${sessionHelp}`, run: async (args) => asText(await getManager().status(args[0])) },
		...["send", "steer"].map((name): AgentCommandAction => ({ name, description: `Send ${name === "steer" ? "a correction" : "a task or report"}`, ...(name === "steer" ? { confirm: "This admits a new direction for the selected agent. Admission does not prove action." } : {}), help: `${sessionHelp} After the session, write your message. Busy agents receive steering at the next native boundary.`, args: [{ name: "session", complete: "session" }, { name: "message", rest: true }], run: async ([sessionId, ...words], ctx) => asText(await control("submit", { sessionId, message: words.join(" "), whenBusy: "steer" }, ctx)) })),
		{ name: "abort", description: "Stop current work; keep the agent", confirm: "This stops the selected agent's current operation without deleting its evidence.", help: sessionHelp, args: [{ name: "session", complete: "session-control" }], run: async ([sessionId], ctx) => asText(await control("abort", { sessionId }, ctx)) },
		{ name: "attach", description: "Connect to an agent; optionally change its idle model", help: `${sessionHelp} An explicit provider/model changes only an idle agent. No new input starts. Retained unfinished work resumes.`, args: [{ name: "session", complete: "session" }, { name: "model", optional: true }], run: async ([sessionId, model], ctx) => asText(await control("attach", { sessionId, ...(model === undefined ? {} : { model }) }, ctx)) },
		{ name: "fork", description: "Create an idle native branch", help: "Use an optional entry ID from agent_inspect. The source remains unchanged.", args: [{ name: "session", complete: "session" }, { name: "entry", optional: true }], run: async ([sessionId, entryId], ctx) => asText(await control("fork", { sessionId, ...(entryId === undefined ? {} : { entryId }) }, ctx)) },
		{ name: "compact", description: "Compact an agent through its owner", confirm: "This aborts active work and compacts the selected agent without resuming it.", args: [{ name: "session", complete: "session-control" }, { name: "instructions", rest: true, optional: true }], run: async ([sessionId, ...words], ctx) => asText(await control("compact", { sessionId, ...(words.length ? { instructions: words.join(" ") } : {}) }, ctx)) },
		{ name: "inspect", description: "Read retained conversation evidence", args: [{ name: "session", complete: "session" }], run: async ([sessionId], ctx) => asText(await control("inspect", { sessionId }, ctx)) },
		{ name: "rewind", description: "Redo work from a mistaken entry", confirm: "This creates a fork and starts corrected work against current files.", help: "Use an entry ID from agent_inspect. The source remains unchanged.", args: [{ name: "session", complete: "session" }, { name: "entry" }, { name: "correction", rest: true }], run: async ([sessionId, entryId, ...words], ctx) => asText(await control("rewind", { sessionId, entryId, correction: words.join(" ") }, ctx)) },
		{ name: "configure", description: "Change an idle agent's configuration", args: [{ name: "session", complete: "session" }, { name: "configuration", rest: true }], run: async (args, ctx) => { const parsed = parseConfigurationArguments(args); return asText(await control("configure", { sessionId: parsed.sessionId, ...parsed.patch }, ctx)); }, dialog: async (target, ctx) => { if (!target) return "Select an agent before configuration."; const patch = await configurationDialog(target, ctx); return patch ? asText(await control("configure", { sessionId: target.id, ...patch }, ctx)) : undefined; } },
		{ name: "command", description: "Run a native contribution command", confirm: "This invokes a command with the selected owner's authority.", args: [{ name: "session", complete: "session" }, { name: "name" }, { name: "args", rest: true, optional: true }], run: async ([sessionId, name, ...args], ctx) => asText(await control("command", { sessionId, name, args: args.join(" ") }, ctx)) },
		{ name: "place", description: "Use a directory's agent", help: "The default is your current directory. A missing binding creates an agent. Use agent_place for directory paths with spaces.", args: [{ name: "area", optional: true }, { name: "task", optional: true, rest: true }], run: async ([area, ...words], ctx) => asText(await getManager().place({ area: area ? resolve(ctx.cwd, area) : ctx.cwd, prompt: words.join(" ") || undefined }, caller(ctx, pi))) },
		{ name: "places", description: "List directory bindings", args: [], run: async () => asText(getManager().places.read()) },
		{ name: "unbind", description: "Remove a directory binding without deleting its agent", confirm: "This removes the directory binding, not its agent.", help: "Use an exact directory from /agent places.", args: [{ name: "area" }], run: async ([area], ctx) => asText(getManager().places.unbind(resolve(ctx.cwd, area)) ?? { removed: false }) },
	];
	const command = createAgentCommand(actions, { list: () => getManager().dashboardPage(), snapshot: (sessionId) => getManager().snapshot(sessionId) });
	pi.registerCommand("agent", command);
	pi.registerShortcut("ctrl+alt+g", { description: "Open the agent dashboard", handler: (ctx) => command.openDashboard(ctx) });
	pi.registerCommand("restart", createRestartCommand({ hosts: agentRestartHosts, managedChild: () => false }));
	pi.registerMessageRenderer("agent.peer", renderAgentPeerMessage);
	pi.on("session_start", async (_event, ctx) => {
		selfCompaction.clear();
		const sessionId = ctx.sessionManager.getSessionId();
		primaries.get(sessionId)?.abort();
		const abort = new AbortController(); primaries.set(sessionId, abort);
		await getManager().registerPrimary(sessionId, { signal: abort.signal, cwd: ctx.cwd, name: ctx.sessionManager.getSessionName(), model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined, thinkingLevel: pi.getThinkingLevel(),
			send: (text, details) => pi.sendMessage({ customType: "agent.peer", content: text, details, display: true }, { triggerTurn: true, deliverAs: "steer" }),
			status: (text) => ctx.ui.setStatus("agent", text),
			promptTrust: (cwd) => ctx.hasUI ? promptProjectTrust(cwd, { select: (question, options) => ctx.ui.select(question, [...options]) }) : Promise.resolve(undefined),
		});
	});
	pi.on("agent_settled", () => { selfCompaction.clear(); });
	pi.on("session_shutdown", (_event, ctx) => { selfCompaction.clear(); const id = ctx.sessionManager.getSessionId(); primaries.get(id)?.abort(); primaries.delete(id); });
}
