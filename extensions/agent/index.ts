/** Agent controls for independent Pi Durable hosts and the ordinary primary UI. */
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, getPackageDir, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { createAgentCommand, type AgentCommandAction } from "./command.ts";
import { configurationDialog } from "./configuration-dialog.ts";
import { THINKING_LEVELS, parseConfigurationArguments } from "./configuration.ts";
import { createAgentContribution, type AgentControlDispatch } from "./durable-agents.ts";
import { createResetTimerActions, registerResetTimerTools } from "./durable-reset-timers.ts";
import { AGENT_CONTROL_GUIDANCE, type AgentControlToolName } from "./control-guidance.ts";
import { ListOutputSchema, StatusOutputSchema, InspectOutputSchema, structuredObservation } from "./observation-schema.ts";
import { createAgentToolCards, renderAgentPeerMessage } from "./tool-cards.ts";
import { AgentManager, MANAGER_PROTOCOL, type AgentCaller } from "./manager.ts";
import { createRestartCommand, type RestartHosts } from "./restart.ts";
import { MAX_CONTINUITY_SUMMARY, SelfCompaction } from "./self-compaction.ts";
import { bindPrimaryObserver, createPrimaryObserver } from "./peer-primary.ts";
import { createPeerObservationSource } from "./peer-observation.ts";
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
const abort = Type.Object({ sessionId: id, trust: maybeTrust, background: Type.Optional(Type.Boolean()), timerId: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false });
const message = Type.Object({ sessionId: id, message: Type.String({ minLength: 1 }), replyTo: Type.Optional(id) }, { additionalProperties: false });
const send = Type.Object({ sessionId: id, message: Type.String({ minLength: 1 }), replyTo: Type.Optional(id), deliverAt: Type.Optional(Type.String({ minLength: 1, description: "Absolute ISO 8601 date-time; schedule the input instead of sending it now." })), mode: Type.Optional(StringEnum(["followUp", "steer"])) }, { additionalProperties: false });
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
	const primaryObserver = createPrimaryObserver();
	bindPrimaryObserver(pi, primaryObserver);
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
	register("agent_spawn", "Start an independent Durable agent. A prompt starts work; no prompt creates an idle agent. The host survives this Pi process.", spawn, (input, ctx) => getManager().spawn({ ...input, origin: "model" }, caller(ctx, pi)));
	register("agent_list", "Discover Durable agent identities and names without a writer. Repeat the query and cursor to continue bounded results.", Type.Object({ query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), cwd: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), cursor: Type.Optional(Type.String({ maxLength: 2048 })) }, { additionalProperties: false }), (input) => getManager().list(input));
	register("agent_status", "Read Durable conversations and live host state. A selected session lists its bounded pending scheduled inputs with timer ID and deadline. Unavailable evidence remains explicit.", Type.Object({ sessionId: Type.Optional(id) }, { additionalProperties: false }), (input) => getManager().status(input.sessionId as string | undefined));
	register("agent_inspect", "Read retained Durable entries, results, and task state. Pass returned next objects as cursor. Result reads use submissionId or operationId; exact reads use entryId. Images and signatures are omitted.", inspect, (input, ctx) => control("inspect", input, ctx));
	register("agent_send", "Admit a task, report, or correction. Idle agents start; busy agents receive durable steering. A receipt does not prove action. With deliverAt, schedule the input at an absolute time.", send, (input, ctx, callId) => {
		if (input.deliverAt === undefined) return control("submit", { ...input, whenBusy: "steer", origin: "model" }, ctx);
		if (input.replyTo !== undefined) throw new Error("replyTo cannot be combined with deliverAt");
		return control("timer-schedule", { sessionId: input.sessionId, message: input.message, deliverAt: input.deliverAt, mode: input.mode ?? "followUp", origin: "model", scheduleId: `timer:send:${ctx.sessionManager.getSessionId()}:${callId}`, requestId: `timer-delivery:send:${ctx.sessionManager.getSessionId()}:${callId}` }, ctx);
	});
	register("agent_steer", "Steer live or retained work through its Durable owner. Admitted steering survives process loss. Carried operator decisions retain their original scope; agent claims remain claims.", message, (input, ctx) => control("submit", { ...input, whenBusy: "steer", origin: "model" }, ctx));
	register("agent_abort", "Abort this agent's native task tree without deleting retained evidence. With timerId, cancel only that scheduled input. Other storage conversations remain separate.", abort, (input, ctx) => input.timerId === undefined ? control("abort", input, ctx) : control("timer-cancel", { sessionId: input.sessionId, timerId: input.timerId }, ctx));
	register("agent_attach", "Connect to a Durable storage host without new input. Retained unfinished work resumes automatically.", Type.Object({ sessionId: id, model: Type.Optional(Type.String()), trust: maybeTrust }, { additionalProperties: false }), (input, ctx) => control("attach", input, ctx));
	register("agent_fork", "Create an idle native conversation branch in the same storage. The source remains unchanged.", Type.Object({ sessionId: id, entryId: Type.Optional(id), trust: maybeTrust }, { additionalProperties: false }), (input, ctx) => control("fork", input, ctx));
	register("agent_rewind", "Fork before a mistaken entry and redo the work under your correction. The source stays unchanged. Files remain current.", Type.Object({ sessionId: id, entryId: id, correction: Type.String({ minLength: 1 }), trust: maybeTrust }, { additionalProperties: false }), (input, ctx) => control("rewind", { ...input, origin: "model" }, ctx));
	register("agent_configure", "Change an idle Durable agent's name, exact model, or reasoning level. No task starts. Active work refuses configuration.", configure, (input, ctx) => control("configure", input, ctx));
	register("agent_command", "Invoke a native contribution command, reload registrations, or fork to a tree entry through its Durable owner.", Type.Object({ sessionId: id, name: Type.String({ minLength: 1 }), args: Type.Optional(Type.String()) }, { additionalProperties: false }), (input, ctx) => control("command", input, ctx));
	register("agent_place", "Use the agent bound to a directory, or create it. Longest bound directory wins. An optional prompt starts work.", Type.Object({ area: Type.Optional(Type.String()), topic: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()), trust: maybeTrust }, { additionalProperties: false }), (input, ctx) => getManager().place({ ...input, origin: "model" }, caller(ctx, pi)));
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
	const outcome = (text: string, sessionId?: string): { text: string; sessionId?: string } => (sessionId === undefined ? { text } : { text, sessionId });
	const shortIdentity = (identity: string): string => {
		const tail = identity.includes(":") ? identity.slice(identity.lastIndexOf(":") + 1) : identity;
		return (tail === "" ? identity : tail).slice(0, 8);
	};
	const excerpt = (value: string, limit = 48): string => {
		const collapsed = value.replace(/\s+/g, " ").trim();
		return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
	};
	const failureDetail = (value: unknown): string => {
		const error = (value as { error?: unknown } | null)?.error;
		return typeof error === "string" && error !== "" ? `: ${excerpt(error, 80)}` : "";
	};
	/** Display label of one stored agent: name, else first-task excerpt, else short identity. */
	const agentLabel = async (sessionId: string): Promise<string> => {
		try {
			const response = await getManager().status(sessionId) as { conversation?: { name?: unknown; firstMessage?: unknown; identity?: unknown } };
			const conversation = response?.conversation;
			const name = typeof conversation?.name === "string" ? excerpt(conversation.name) : "";
			if (name !== "") return name;
			const first = typeof conversation?.firstMessage === "string" ? excerpt(conversation.firstMessage) : "";
			if (first !== "") return first;
			return shortIdentity(typeof conversation?.identity === "string" ? conversation.identity : sessionId);
		} catch {
			return shortIdentity(sessionId);
		}
	};
	const actions: AgentCommandAction[] = [
		{ name: "new", description: "Start a new Durable agent", args: [{ name: "task", rest: true, optional: true }], help: "Describe the task in your own words. The agent uses your current directory and model. Its host survives this primary process; advanced overrides use agent_spawn.", run: async (args, ctx) => {
			const prompt = args.join(" ") || undefined;
			const created = await getManager().spawn({ prompt, origin: "operator" }, caller(ctx, pi)) as { sessionId: string; cwd?: string; status?: { name?: string } };
			const label = created.status?.name ?? (prompt === undefined ? shortIdentity(created.sessionId) : excerpt(prompt));
			const place = basename(created.cwd ?? ctx.cwd);
			return outcome(prompt === undefined ? `Created idle agent “${label}” in ${place}` : `Started agent “${label}” in ${place}`, created.sessionId);
		} },
		{ name: "list", description: "List Durable agents", args: [], help: "Read saved agents without a writer. Use agent_list to continue bounded pages.", run: async () => asText(await getManager().list()) },
		{ name: "status", description: "Show agent state", args: [{ name: "session", optional: true, complete: "session" }], help: `Without a session, show bounded native conversation state. ${sessionHelp}`, run: async (args) => asText(await getManager().status(args[0])) },
		...["send", "steer"].map((name): AgentCommandAction => ({ name, description: `Send ${name === "steer" ? "a correction" : "a task or report"}`, ...(name === "steer" ? { confirm: "This admits a new direction for the selected agent. Admission does not prove action." } : {}), help: `${sessionHelp} After the session, write your message. Busy agents receive steering at the next native boundary.`, args: [{ name: "session", complete: "session" }, { name: "message", rest: true }], run: async ([sessionId, ...words], ctx) => {
			await control("submit", { sessionId, message: words.join(" "), whenBusy: "steer", origin: "operator" }, ctx);
			const label = await agentLabel(sessionId);
			return outcome(name === "steer" ? `Queued a correction for “${label}”` : `Sent a task to “${label}”`, sessionId);
		} })),
		{ name: "abort", description: "Stop current work; keep the agent", confirm: "This stops the selected agent's current operation without deleting its evidence.", help: sessionHelp, args: [{ name: "session", complete: "session-control" }], run: async ([sessionId], ctx) => {
			await control("abort", { sessionId }, ctx);
			const label = await agentLabel(sessionId);
			return outcome(`Requested stop for “${label}”`, sessionId);
		} },
		{ name: "attach", description: "Connect to an agent; optionally change its idle model", help: `${sessionHelp} An explicit provider/model changes only an idle agent. No new input starts. Retained unfinished work resumes.`, args: [{ name: "session", complete: "session" }, { name: "model", optional: true }], run: async ([sessionId, model], ctx) => {
			const attached = await control("attach", { sessionId, ...(model === undefined ? {} : { model }) }, ctx);
			const label = await agentLabel(sessionId);
			if ((attached as { outcome?: unknown } | null)?.outcome === "failed") return outcome(`Configuration failed for “${label}”${failureDetail(attached)}`, sessionId);
			return outcome(model === undefined ? `Connected to “${label}”` : `Connected to “${label}” with ${model}`, sessionId);
		} },
		{ name: "fork", description: "Create an idle native branch", help: "Use an optional entry ID from agent_inspect. The source remains unchanged.", args: [{ name: "session", complete: "session" }, { name: "entry", optional: true }], run: async ([sessionId, entryId], ctx) => {
			const forked = await control("fork", { sessionId, ...(entryId === undefined ? {} : { entryId }) }, ctx) as { identity?: string; status?: { name?: string } };
			const identity = forked.identity ?? sessionId;
			const label = forked.status?.name ?? await agentLabel(identity);
			return outcome(`Created branch “${label}”`, identity);
		} },
		{ name: "compact", description: "Compact an agent through its owner", confirm: "This aborts active work and compacts the selected agent without resuming it.", args: [{ name: "session", complete: "session-control" }, { name: "instructions", rest: true, optional: true }], run: async ([sessionId, ...words], ctx) => {
			const result = await control("compact", { sessionId, ...(words.length ? { instructions: words.join(" ") } : {}) }, ctx) as { status?: string };
			const label = await agentLabel(sessionId);
			const status = typeof result?.status === "string" ? result.status : "requested";
			return outcome(status === "completed" ? `Compacted “${label}”` : `Compaction ${status} for “${label}”`, sessionId);
		} },
		{ name: "inspect", description: "Read retained conversation evidence", args: [{ name: "session", complete: "session" }], run: async ([sessionId], ctx) => asText(await control("inspect", { sessionId }, ctx)) },
		{ name: "rewind", description: "Redo work from a mistaken entry", confirm: "This creates a fork and starts corrected work against current files.", help: "Use an entry ID from agent_inspect. The source remains unchanged.", args: [{ name: "session", complete: "session" }, { name: "entry" }, { name: "correction", rest: true }], run: async ([sessionId, entryId, ...words], ctx) => {
			const result = await control("rewind", { sessionId, entryId, correction: words.join(" "), origin: "operator" }, ctx) as { identity?: string };
			const label = await agentLabel(sessionId);
			return outcome(`Rewound “${label}” before entry ${entryId}`, result.identity ?? sessionId);
		} },
		{ name: "configure", description: "Change an idle agent's configuration", args: [{ name: "session", complete: "session" }, { name: "configuration", rest: true }], run: async (args, ctx) => {
			const parsed = parseConfigurationArguments(args);
			const result = await control("configure", { sessionId: parsed.sessionId, ...parsed.patch }, ctx) as { outcome?: string };
			const label = await agentLabel(parsed.sessionId);
			return result?.outcome === "failed" ? outcome(`Configuration failed for “${label}”${failureDetail(result)}`, parsed.sessionId) : outcome(`Updated configuration for “${label}”`, parsed.sessionId);
		}, dialog: async (target, ctx) => {
			if (!target) return "Select an agent before configuration.";
			const patch = await configurationDialog(target, ctx);
			if (!patch) return undefined;
			const result = await control("configure", { sessionId: target.id, ...patch }, ctx) as { outcome?: string };
			const label = await agentLabel(target.id);
			return result?.outcome === "failed" ? outcome(`Configuration failed for “${label}”${failureDetail(result)}`, target.id) : outcome(`Updated configuration for “${label}”`, target.id);
		} },
		{ name: "command", description: "Run a native contribution command", confirm: "This invokes a command with the selected owner's authority.", args: [{ name: "session", complete: "session" }, { name: "name" }, { name: "args", rest: true, optional: true }], run: async ([sessionId, name, ...args], ctx) => {
			const result = await control("command", { sessionId, name, args: args.join(" ") }, ctx) as { reloaded?: boolean; text?: string };
			const label = await agentLabel(sessionId);
			const commandText = typeof result?.text === "string" ? excerpt(result.text, 80) : "";
			return outcome(result?.reloaded === true ? `Reloaded host registrations for “${label}”` : `Ran command ${name} on “${label}”${commandText ? `: ${commandText}` : ""}`, sessionId);
		} },
		{ name: "place", description: "Use a directory's agent", help: "The default is your current directory. A missing binding creates an agent. Use agent_place for directory paths with spaces.", args: [{ name: "area", optional: true }, { name: "task", optional: true, rest: true }], run: async ([area, ...words], ctx) => {
			const prompt = words.join(" ") || undefined;
			const resolved = area ? resolve(ctx.cwd, area) : ctx.cwd;
			const result = await getManager().place({ area: resolved, prompt, origin: "operator" }, caller(ctx, pi)) as { sessionId: string; status?: { name?: string } };
			const label = result.status?.name ?? (prompt === undefined ? shortIdentity(result.sessionId) : excerpt(prompt));
			return outcome(prompt === undefined ? `Using “${label}” in ${basename(resolved)}` : `Sent a task to “${label}” in ${basename(resolved)}`, result.sessionId);
		} },
		{ name: "places", description: "List directory bindings", args: [], run: async () => asText(getManager().places.read()) },
		{ name: "unbind", description: "Remove a directory binding without deleting its agent", confirm: "This removes the directory binding, not its agent.", help: "Use an exact directory from /agent places.", args: [{ name: "area" }], run: async ([area], ctx) => {
			const resolved = resolve(ctx.cwd, area);
			const removed = getManager().places.unbind(resolved);
			return outcome(removed ? `Removed the directory binding for ${resolved}` : `No directory binding for ${resolved}`);
		} },
		...createResetTimerActions((ctx) => ({ control: (method, input) => control(method, input, ctx), label: agentLabel })),
	];
	registerResetTimerTools(pi, (ctx) => ({ control: (method, input) => control(method, input, ctx), label: agentLabel }));
	const command = createAgentCommand(actions, createPeerObservationSource({ list: () => getManager().dashboardPage(), snapshot: (id, params) => getManager().snapshot(id, params), observeLive: (id, scope, listener) => getManager().observeLive(id, scope, listener) }), { primary: primaryObserver });
	pi.registerCommand("agent", command);
	pi.registerShortcut("ctrl+alt+g", { description: "Open the agent peer window", handler: (ctx) => command.openDashboard(ctx) });
	pi.registerCommand("restart", createRestartCommand({ hosts: agentRestartHosts, managedChild: () => false }));
	pi.registerMessageRenderer("agent.peer", renderAgentPeerMessage);
	pi.on("session_start", async (_event, ctx) => {
		selfCompaction.clear();
		const sessionId = ctx.sessionManager.getSessionId();
		primaries.get(sessionId)?.abort();
		const abort = new AbortController(); primaries.set(sessionId, abort);
		await getManager().registerPrimary(sessionId, { signal: abort.signal, cwd: ctx.cwd, name: ctx.sessionManager.getSessionName(), model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined, thinkingLevel: pi.getThinkingLevel(),
			send: (text, details) => {
				const wake = !(details !== null && typeof details === "object" && (details as { wake?: unknown }).wake === false);
				pi.sendMessage({ customType: "agent.peer", content: text, details, display: true }, wake ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false });
			},
			status: (text) => ctx.ui.setStatus("agent", text),
			promptTrust: (cwd) => ctx.hasUI ? promptProjectTrust(cwd, { select: (question, options) => ctx.ui.select(question, [...options]) }) : Promise.resolve(undefined),
		});
	});
	pi.on("model_select", (event, ctx) => { getManager().updatePrimary(ctx.sessionManager.getSessionId(), { model: { provider: event.model.provider, modelId: event.model.id } }); });
	pi.on("thinking_level_select", (event, ctx) => { getManager().updatePrimary(ctx.sessionManager.getSessionId(), { thinkingLevel: event.level }); });
	pi.on("session_info_changed", (event, ctx) => { getManager().updatePrimary(ctx.sessionManager.getSessionId(), { name: event.name }); });
	pi.on("agent_settled", () => { selfCompaction.clear(); });
	pi.on("session_shutdown", (_event, ctx) => { selfCompaction.clear(); const id = ctx.sessionManager.getSessionId(); primaries.get(id)?.abort(); primaries.delete(id); });
}
