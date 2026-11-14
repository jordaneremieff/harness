/** Agent controls for independent Pi Durable hosts and the ordinary primary UI. */
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	getPackageDir,
	type AgentToolResult,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { bool, int, map, num, obj, opt, str, unknown, type Schema, type Static } from "@earendil-works/pi-schema";
import { offerSessionName } from "../../session-name/lifecycle.ts";
import { storageStatusPageInput, validateStatusSelectors } from "./storage-status.ts";
import { createAgentObservationSource } from "./agent-observation.ts";
import {
	PresetParameter,
	parseExecutionSelection,
	parsePreferenceSnapshot,
	presetChoices,
	presetInventory,
	presetParameter,
	readAgentPreferences,
	renderAgentPreferences,
	type PreferenceSnapshot,
} from "./agent-preferences.ts";
import { ordinaryReportedUsage } from "./agent-usage.ts";
import { appendProviderBlockReceipt, ProviderBlockNotes, renderProviderBlockSection } from "./provider-block-notes.ts";
import { checkInMinutes } from "./check-in-options.ts";
import { CollaborationParams, validateCollaborationAction } from "./collaboration-contract.ts";
import { createAgentCommand, type AgentCommandAction } from "./command.ts";
import { THINKING_LEVELS, isThinkingLevel, parseConfigurationArguments } from "./configuration.ts";
import {
	AGENT_CONTROL_EXPOSURE,
	AGENT_CONTROL_GUIDANCE,
	agentControlGuidance,
	FOLLOW_UP_DELIVERY_BOUNDARY,
	MODEL_SELECTION_GUIDANCE,
	REPORT_DELIVERY_BOUNDARY,
	type AgentControlExposure,
	type AgentControlToolName,
} from "./control-guidance.ts";
import { dashboardPreferences } from "./dashboard-preferences.ts";
import { readableControlText, projectReportReceipt } from "./control-result.ts";
import { projectSelectedStatus, validateStatusDetail } from "./status-overview.ts";
import { fitStorageStatusPage } from "./storage-page-fit.ts";
import { associateThreadNotices, projectThreadNotices, type ThreadNoticeSource, type ThreadRangeSnapshot } from "./thread-notice-projection.ts";
import type { AgentContributionHost } from "./durable-agents.ts";
import {
	createResetTimerActions,
	readAgentTimerRows,
	registerResetTimerTools,
	scheduleAgentInput,
} from "./durable-reset-timers.ts";
import { formatEffortAwareness } from "./effort-awareness.ts";
import { EFFORT_PURPOSE_ENTRY, purposeExcerpt, retainedPurpose } from "./effort-purpose.ts";
import { IntentParams, validateIntentInput } from "./effort-schema.ts";
import { validateFleetSelection } from "./fleet-status.ts";
import type { IndependentCommandLaunch } from "./independent-launch.ts";
import { AgentManager, MANAGER_PROTOCOL, type AgentCaller } from "./manager.ts";
import {
	InspectToolOutputSchema,
	StatusToolOutputSchema,
	StatusToolInputSchema,
	structuredObservation,
} from "./observation-schema.ts";
import type { PrimaryIntentClaim } from "./primary-channel.ts";
import { ORDINARY_CONTINUITY_ENTRY } from "./continuity-facts.ts";
import { OrdinaryContinuity, deliveredResults } from "./ordinary-continuity.ts";
import { formatPrimaryObservation } from "./primary-observation.ts";
import { PrimaryRetention } from "./primary-retention.ts";
import { ProfiledListOutputSchema } from "./profile-discovery.ts";
import { HandleSchema, ProfileOutputSchema, ProfileParams } from "./profile-schema.ts";
import { createRestartCommand, type RestartHosts } from "./restart.ts";
import { DispatchOutputSchema } from "./result-schema.ts";
import { MAX_CONTINUITY_SUMMARY, SelfCompaction } from "./self-compaction.ts";
import { retainedSentWork, SENT_WORK_ENTRY } from "./session-work.ts";
import { publishSettings } from "./settings.ts";
import { createAgentToolCards, ordinaryWorkCard, renderAgentPeerMessage, type AgentToolCard } from "./tool-cards.ts";
import { registerOrdinaryWork } from "./ordinary-work.ts";
import { collectToolDisplay, publishToolDisplay } from "./tool-display.ts";
import { promptProjectTrust } from "./trust-support.ts";

const defaultOriginalEntrypoint = fileURLToPath(new URL("./index.ts", import.meta.url));

let nativeAgentPromise: Promise<typeof import("./durable-agents.ts")> | undefined;
function loadAgentNative(): Promise<typeof import("./durable-agents.ts")> {
	nativeAgentPromise ??= import("./durable-agents.ts");
	return nativeAgentPromise;
}

let profileDialogPromise: Promise<typeof import("./profile-dialog.ts")> | undefined;
function loadProfileDialog(): Promise<typeof import("./profile-dialog.ts")> {
	profileDialogPromise ??= import("./profile-dialog.ts");
	return profileDialogPromise;
}

const ownerKey = Symbol.for("pi.extension.agent.owners");
const processState = globalThis as typeof globalThis & {
	[ownerKey]?: { managers: Map<string, AgentManager> };
};
processState[ownerKey] ??= { managers: new Map() };
const owners = processState[ownerKey];
export function agentRestartHosts(): RestartHosts {
	for (const manager of owners.managers.values())
		if (manager.managerProtocol !== MANAGER_PROTOCOL)
			return {
				identity: "",
				refusal: `The retained agent manager uses ${manager.managerProtocol}; this code requires ${MANAGER_PROTOCOL}. Quit Pi and resume the saved session.`,
			};
	return {
		identity: JSON.stringify([...owners.managers].map(([root, manager]) => [root, manager.connectedStorageIds()])),
	};
}
/** Provider tool declarations retain an explicit string type. */
const StringEnum = <const T extends readonly string[]>(values: T, options: { readonly description?: string } = {}): Schema<T[number]> => ({ type: "string", enum: [...values], ...options });
const id = str({ minLength: 1, maxLength: 256 });
const maybeTrust = opt(bool());
const abort = obj(
	{
		sessionId: id,
		trust: maybeTrust,
		background: opt(bool()),
		release: opt(bool()),
		timerId: opt(int({ minimum: 1 })),
	},
	{},
);
const message = obj(
	{ sessionId: id, message: str({ minLength: 1 }), replyTo: opt(id) },
	{},
);
const checkIn = opt(num({ minimum: 0, maximum: 35791, description: "Owner check-in interval in minutes while unanswered. Default: configured agent.checkInMinutes, which is 0 (no check-ins) unless set; results arrive without them." }));
const send = obj(
	{
		sessionId: id,
		message: str({ minLength: 1 }),
		replyTo: opt(id),
		deliverAt: opt(
			str({
				minLength: 1,
				description: "Absolute ISO 8601 date-time; schedule the input instead of sending it now.",
			}),
		),
		mode: opt(StringEnum(["followUp", "steer", "report"])),
		checkInMinutes: checkIn,
	},
	{},
);
const spawn = obj(
	{
		handle: opt(HandleSchema),
		preset: PresetParameter,
		role: opt(str({ maxLength: 2000, description: "Durable role text saved on the new agent's profile, with or without a handle. Reuse does not change the role." })),
		cwd: opt(str()),
		name: opt(str({ maxLength: 256 })),
		prompt: opt(str()),
		model: opt(str({ description: MODEL_SELECTION_GUIDANCE })),
		thinkingLevel: opt(StringEnum(THINKING_LEVELS)),
		trust: maybeTrust,
		checkInMinutes: checkIn,
	},
	{},
);
const nativeEntryId = int({ minimum: 1 });
const inspect = obj(
	{
		sessionId: id,
		view: opt(StringEnum(["history", "activity", "branch", "search", "exact", "result"])),
		cursor: opt(
			map(unknown(), {
				description: "Opaque native cursor. Pass the returned next object unchanged.",
			}),
		),
		limit: opt(int({ minimum: 1, maximum: 200 })),
		entryId: opt(nativeEntryId),
		fromId: opt(nativeEntryId),
		offset: opt(int({ minimum: 0 })),
		query: opt(str({ minLength: 1, maxLength: 256 })),
		source: opt(StringEnum(["user", "assistant", "toolResult", "summary", "custom"])),
		submissionId: opt(nativeEntryId),
		operationId: opt(id),
		receiptCursor: opt(str({ minLength: 1, maxLength: 2048, description: "Recipient reference continuation from a result page. Separate from answer offset and history cursor." })),
		finalReport: opt(bool({ description: "Result view only: page the retained final report of the selected input's declared work instead of its answer; offset continues it." })),
	},
	{},
);
const compact = obj(
	{
		sessionId: id,
		instructions: opt(str()),
		summary: opt(str({ minLength: 1, maxLength: MAX_CONTINUITY_SUMMARY })),
	},
	{},
);
const configure = obj(
	{
		sessionId: id,
		preset: PresetParameter,
		name: opt(str({ maxLength: 256 })),
		model: opt(str({ maxLength: 512, description: MODEL_SELECTION_GUIDANCE })),
		thinkingLevel: opt(StringEnum(THINKING_LEVELS)),
		trust: maybeTrust,
	},
	{},
);
/** Compact storage text preserves the projection's measured JSON byte bound. */
function resultIndent(value: unknown): 2 | undefined {
	const row = value as { view?: string; format?: string; conversations?: unknown } | null;
	return row?.view === "fleet" || (row?.format === "compact" && Array.isArray(row.conversations)) ? undefined : 2;
}
const result = (value: unknown, schema?: Schema): AgentToolResult<unknown> => ({
	...((value as { outcome?: string } | null)?.outcome === "failed" ? { isError: true } : {}),
	content: [{ type: "text", text: (value as { view?: string } | null)?.view === "result" ? readableControlText(value) : typeof value === "string" ? value : JSON.stringify(value, null, resultIndent(value)) }],
	details: value,
	structuredContent: schema ? structuredObservation(schema, value) : JSON.parse(JSON.stringify(value ?? null)),
});
function releaseCommandMessage(value: unknown, label: string): string {
	const state = value as { retiring: boolean; blockers: string[]; writesPlaced: number };
	const message = state.retiring ? `Released “${label}”; its host is retiring.` : `Stopped “${label}”; the host stays up: ${state.blockers.join("; ")}.`;
	const writes = state.writesPlaced > 0 ? ` Placed ${state.writesPlaced} leftover ${state.writesPlaced === 1 ? "write" : "writes"}.` : "";
	return `${message}${writes}`;
}

const observationSchemas: Partial<Record<AgentControlToolName, Schema>> = {
	agent_spawn: DispatchOutputSchema,
	agent_send: DispatchOutputSchema,
	agent_steer: DispatchOutputSchema,
	agent_list: ProfiledListOutputSchema,
	agent_profile: ProfileOutputSchema,
	agent_status: StatusToolOutputSchema,
	agent_inspect: InspectToolOutputSchema,
};
const caller = (ctx: ExtensionContext, pi: ExtensionAPI): AgentCaller => ({
	id: ctx.sessionManager.getSessionId(),
	cwd: ctx.cwd,
	name: ctx.sessionManager.getSessionName(),
	...(ctx.model ? { model: { provider: ctx.model.provider, modelId: ctx.model.id } } : {}),
	thinkingLevel: pi.getThinkingLevel(),
	preferenceCatalog: { getModel: (provider, modelId) => ctx.modelRegistry.find(provider, modelId), getModels: () => ctx.modelRegistry.getAll() },
	validateModel: (model, level) => {
		const selected = ctx.modelRegistry.find(model.provider, model.modelId);
		if (!selected) throw new Error(`Model is not in the configured catalog: ${model.provider}/${model.modelId}`);
		if (!isThinkingLevel(level)) throw new Error("Unknown reasoning level");
		return clampThinkingLevel(selected, level);
	},
});
const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

function admitExecutionInput(pi: ExtensionAPI, ctx: ExtensionContext, name: string, callId: string, input: Record<string, unknown>): { admitted: Record<string, unknown>; admissionCaller: AgentCaller } {
	const admissionCaller = caller(ctx, pi);
	const key = `${name}:${callId}`;
	const digest = createHash("sha256").update(JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
	const entries = ctx.sessionManager.getBranch();
	const retained = (kind: string) => entries.findLast((entry) => entry.type === "custom" && entry.customType === kind && (entry.data as { key?: unknown } | undefined)?.key === key);
	const entry = retained("agent.preference-admission");
	const data = entry?.type === "custom" ? entry.data as { digest: string; snapshot: unknown } : undefined;
	if (data && data.digest !== digest) throw new Error("Agent control call ID belongs to different inputs");
	const snapshot = data ? parsePreferenceSnapshot(data.snapshot) : readAgentPreferences(undefined, admissionCaller.preferenceCatalog);
	if (!data) pi.appendEntry("agent.preference-admission", { key, digest, snapshot });
	const selected = retained("agent.execution-selection");
	const admitted = { ...input, preferenceSnapshot: snapshot, ...(selected?.type === "custom" ? { selection: parseExecutionSelection((selected.data as { selection: unknown }).selection) } : {}) };
	admissionCaller.retainExecutionSelection = (selection) => { pi.appendEntry("agent.execution-selection", { key, selection: parseExecutionSelection(selection) }); };
	return { admitted, admissionCaller };
}

function ordinaryThreadSources(ctx: ExtensionContext): ThreadNoticeSource<ContextEvent["messages"][number]>[] {
	let epoch = "initial";
	const sources: ThreadNoticeSource<ContextEvent["messages"][number]>[] = [];
	for (const entry of ctx.sessionManager.buildContextEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") epoch = `entry:${entry.id}`;
		if (entry.type !== "custom_message" || entry.customType !== "agent.peer") continue;
		const details = entry.details as { sourceId?: unknown; deliveryRecipient?: unknown; communicationPassive?: unknown } | undefined;
		if (typeof details?.sourceId !== "string" || details.deliveryRecipient !== ctx.sessionManager.getSessionId() ||
			(details.communicationPassive as { value?: { kind?: unknown } } | undefined)?.value?.kind !== "notice") continue;
		sources.push({ sourceId: `${entry.id}:${details.sourceId}`, recipient: details.deliveryRecipient, epoch, passive: details.communicationPassive,
			message: { role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: new Date(entry.timestamp).getTime() },
		});
	}
	return sources;
}

export function registerOrdinaryAgentExtension(pi: ExtensionAPI, originalEntrypoint = defaultOriginalEntrypoint): void {
	const settingsAgentDir = process.env.PI_AGENT_DIR ?? getAgentDir();
	const disposeFactorySettings = publishSettings(pi.events, { agentDir: settingsAgentDir });
	const toolDisplay = collectToolDisplay(pi.events);
	const configureSettings = (host: AgentContributionHost) => {
		disposeFactorySettings();
		const disposeNativeSettings = publishSettings(pi.events, { agentDir: host.agentDir });
		host.onClose(disposeNativeSettings);
	};
	pi.events.emit("durable:contribution", {
		name: "agent",
		source: originalEntrypoint,
		async create(host: AgentContributionHost) {
			const native = await loadAgentNative();
			return native.createAgentContribution({
				source: originalEntrypoint,
				configureSettings,
				dispatch: (method, params, context) =>
					native.resolveAgentControlDispatch()(method, params, context),
			}).create(host);
		},
	});
	const selfCompaction = new SelfCompaction((handler) => pi.on("turn_end", handler));
	const providerBlocks = new ProviderBlockNotes();
	let observedManager: AgentManager | undefined;
	// One record per tool owns its registration, its renderer fallback and its display publication. An ordinary
	// session registers its own `agent_work`, so that tool's record is the state note card.
	const cards: Readonly<Record<string, AgentToolCard>> = { ...createAgentToolCards(() => observedManager?.observedToolCardRows() ?? []), agent_work: ordinaryWorkCard() };
	pi.registerToolRenderer((name, next) => next() ?? cards[name]);
	publishToolDisplay(pi.events, Object.entries(cards).map(([name, presentation]) => ({ name, ...presentation })));
	const primaries = new Map<string, AbortController>();
	const primaryRetentions = new Map<string, PrimaryRetention>();
	let threadNoticeLifecycle = 0;
	let threadNoticeSnapshots: ThreadRangeSnapshot[] = [];
	const resetThreadNotices = () => { threadNoticeLifecycle++; threadNoticeSnapshots = []; };
	const getManager = (): AgentManager => {
		const agentDir = process.env.PI_AGENT_DIR ?? getAgentDir();
		const configured = resolve(process.env.PI_AGENT_SESSIONS_DIR ?? join(agentDir, "agent-sessions"));
		mkdirSync(configured, { recursive: true, mode: 0o700 });
		const root = realpathSync(configured);
		const existing = owners.managers.get(root);
		if (existing) {
			if (existing.managerProtocol !== MANAGER_PROTOCOL)
				throw new Error(`The retained agent manager uses ${existing.managerProtocol}; this code requires ${MANAGER_PROTOCOL}. Restart Pi before agent controls.`);
			observedManager = existing;
			return existing;
		}
		const manager = new AgentManager({ root, agentDir, packageDir: getPackageDir() });
		owners.managers.set(root, manager);
		observedManager = manager;
		return manager;
	};
	pi.events.on("durable:launch-provider", (query) => {
		if (query === null || typeof query !== "object" || typeof (query as { provide?: unknown }).provide !== "function") throw new Error("Independent launch discovery requires provide()");
		(query as { provide: (launch: IndependentCommandLaunch) => void }).provide((input) => getManager().launchIndependent(input));
	});
	let registrationPreferences = readAgentPreferences();
	let currentPreferences = registrationPreferences;
	const continuity = new OrdinaryContinuity({
		append: (fact) => pi.appendEntry(ORDINARY_CONTINUITY_ENTRY, fact),
		budget: (provider, modelId) => currentPreferences.document?.preferences?.contextBudgetTokens?.[`${provider}/${modelId}`],
		diagnose: (sessionId, text) => getManager().continuityNoteFailure(sessionId, text),
	});
	const refreshRegistrations = new Map<string, (snapshot: PreferenceSnapshot) => void>();
	const refreshPreferences = (ctx?: ExtensionContext): PreferenceSnapshot => {
		const snapshot = readAgentPreferences(undefined, ctx ? caller(ctx, pi).preferenceCatalog : undefined);
		currentPreferences = snapshot;
		if (presetInventory(snapshot) !== presetInventory(registrationPreferences)) {
			registrationPreferences = snapshot;
			for (const refresh of refreshRegistrations.values()) refresh(snapshot);
		}
		return snapshot;
	};
	const control = (method: string, input: Record<string, unknown>, ctx: ExtensionContext) =>
		getManager().control(method, input, caller(ctx, pi));
	const register = (
		name: AgentControlToolName,
		description: string,
		parameters: Schema<Record<string, unknown>>,
		execute: (input: Record<string, unknown>, ctx: ExtensionContext, callId: string, admissionCaller?: AgentCaller) => Promise<unknown>,
	): void => {
		const guidance = agentControlGuidance(name, "ordinary");
		const exposure: AgentControlExposure = AGENT_CONTROL_EXPOSURE[name];
		const schema = observationSchemas[name];
		const presetAware = ["agent_spawn", "agent_place", "agent_configure"].includes(name);
		const registerDefinition = (snapshot: PreferenceSnapshot): void => pi.registerTool({
			name,
			label: name.replace("agent_", "Agent "),
			description,
			promptSnippet: guidance.snippet,
			promptGuidelines: [...(guidance.guidelines ?? [])],
			parameters: presetAware ? { ...parameters, properties: { ...(parameters.properties as Record<string, Schema>), preset: presetParameter(snapshot).schema } } : parameters,
			outputSchema: schema ?? unknown(),
			...(exposure === "direct" ? {} : { exposure }),
			async execute(callId, input: Static<typeof parameters>, _signal, _update, ctx) {
				let admitted = input;
				let admissionCaller: AgentCaller | undefined;
				if (presetAware) {
					refreshPreferences(ctx);
					({ admitted, admissionCaller } = admitExecutionInput(pi, ctx, name, callId, admitted));
				}
				const value = await execute(admitted, ctx, callId, admissionCaller);
				const projected = name === "agent_send" && admitted.mode === "report" ? projectReportReceipt(value) : value;
				const output = result(projected, schema);
				appendProviderBlockReceipt(name, output.content, value, providerBlocks, Date.now());
				if (name === "agent_compact" && typeof (value as { text?: unknown })?.text === "string")
					return { ...output, content: [{ type: "text", text: (value as { text: string }).text }] };
				return output;
			},
			renderCall: cards[name].renderCall,
			renderResult: cards[name].renderResult,
		});
		if (presetAware) refreshRegistrations.set(name, registerDefinition);
		registerDefinition(registrationPreferences);
	};
	pi.registerTool({
		name: "agent_intent",
		label: "Agent intent",
		promptSnippet: AGENT_CONTROL_GUIDANCE.agent_intent.snippet,
		promptGuidelines: [...(AGENT_CONTROL_GUIDANCE.agent_intent.guidelines ?? [])],
		description: "Publish or clear this ordinary primary session's purpose, integration intent, scope, carried operator direction, and contact thread. Intent is a session claim, not verified authority or a lock. Returns the published endpoint and bounded related efforts. No model wake. Independent work needs no claim. Publish where an actual dependency with another effort needs coordination, after bounded discovery; update or clear intent when integration completes. Use agent_send for direct effort contact and agent_collaborate for a retained agreement.",
		parameters: IntentParams,
		outputSchema: unknown(),
		async execute(_callId, input: Static<typeof IntentParams>, _signal, _update, ctx) {
			validateIntentInput(input);
			const { action, ...fields } = input;
			return result(await getManager().publishIntent(ctx.sessionManager.getSessionId(), action === "clear" ? undefined : fields as Omit<PrimaryIntentClaim, "updatedAt">));
		},
		renderCall: cards.agent_intent.renderCall,
		renderResult: cards.agent_intent.renderResult,
	});
	register(
		"agent_collaborate",
		"Discover and use shared purpose threads with full agent peers. Create preserves purpose, authority/source, restrictions, acceptance and integrator in an existing participant storage (sessionId). Create and join accept participation (at most 256 characters); omission preserves an existing declaration and an empty string clears it. Join does not accept message. Use post.message for discussion. Forward reads accept after and optional knownFrameRevision; before is exclusive with after. Follow the returned next call unchanged. Passive facts do not wake a recipient or release its wait; explicit notify stays active. Read the frame and paged exchange without starting a host.",
		CollaborationParams,
		(input, ctx, callId) => {
			if (input.action !== "read") validateCollaborationAction(input);
			return getManager().collaborate({ ...input, origin: "model", requestId: `collaboration:${ctx.sessionManager.getSessionId()}:${callId}` }, caller(ctx, pi));
		},
	);
	registerOrdinaryWork(pi, cards.agent_work);
	register("agent_profile", "Read or revision-check an agent's durable role and sourced expertise. Saved expertise is evidence, not fresh authority. Profile edits start no model turn.", ProfileParams, (input, ctx, callId) => {
		if (typeof input.sessionId !== "string") throw new Error("A primary profile control requires an agent sessionId");
		return control(input.action === "read" ? "profile-read" : "profile-update", { ...input, requestId: `profile:${ctx.sessionManager.getSessionId()}:${callId}` }, ctx);
	});
	register(
		"agent_spawn",
		"Start an independent Durable agent. A prompt starts work; no prompt creates an idle agent. Results arrive without check-ins. Task check-ins run only when checkInMinutes or the configured agent.checkInMinutes sets a nonzero interval; the default is 0. Assess a check-in: report progress, let work continue, steer a wrap-up, or abort a hung tool. Steering does not interrupt a running tool. checkInMinutes 0 disables.",
		spawn,
		(input, ctx, callId, admissionCaller) => getManager().spawn({ ...input, origin: "model", requestId: `spawn:${ctx.sessionManager.getSessionId()}:${callId}` }, admissionCaller ?? caller(ctx, pi)),
	);
	register(
		"agent_list",
		"Discover Durable agent identities and names without a writer. A query observes first the storages whose catalog record carries it. While coverage.complete is false, a page without rows is not absence: call agent_list again with the fields of coverage.next.",
		obj(
			{
				query: opt(str({ minLength: 1, maxLength: 256 })),
				cwd: opt(str()),
				limit: opt(int({ minimum: 1, maximum: 20 })),
				cursor: opt(str({ maxLength: 2048 })),
			},
			{},
		),
		(input) => getManager().list(input),
	);
	register(
		"agent_status",
		"Orient over agents and related primary efforts. Effort intent is a session claim, not authority. Summary and coverage name omitted rows; agent_list discovers full agent identities. Selected status is compact by default. Use detail:true with an explicit sessionId for full state and bounded pending timers. An ordinary primary exposes bounded latest-retained ancestry with detail:true, not live idle or selected-branch state. For one storage, use view: storage-page with its exact storageId and call the tool named by coverage.next.tool with its remaining fields unchanged; this backend JSON cursor is separate from agent_list discovery.",
		StatusToolInputSchema,
		async (input, ctx) => {
			validateStatusDetail(input);
			const { detail: _detail, ...selectors } = input;
			validateStatusSelectors(selectors);
			if (input.view === "storage-page") {
				const page = storageStatusPageInput(selectors);
				const { projected } = await fitStorageStatusPage(page.limit, (limit) => getManager().status({ ...page, limit }));
				return projected;
			}
			const sessionId = input.sessionId as string | undefined;
			const view = input.view as "fleet" | undefined;
			const selection = validateFleetSelection(input);
			const selfId = !sessionId ? ctx?.sessionManager?.getSessionId() : undefined;
			const reportedUsage = view === "fleet" && ctx?.sessionManager?.getEntries ? ordinaryReportedUsage(ctx.sessionManager.getEntries()) : undefined;
			const value = await getManager().status(sessionId, view, selfId ? { id: selfId, cwd: ctx.cwd, reportedUsage } : undefined, selection);
			return sessionId !== undefined && input.detail !== true ? projectSelectedStatus(value) : value;
		},
	);
	register(
		"agent_inspect",
		"Read compact history or activity. Ordinary primary targets support activity/history over bounded latest-retained ancestry, not the live selected branch; pass a clipped entry's textCursor as cursor to page its complete allowed text. Durable targets include role/kind, readable text, named tool calls with argument summaries, and tool result excerpts. Truncation is marked. Use exact with entryId and offset 0 for retained redacted JSON; nextOffset continues it. Pass nextCursor as cursor. Branch remains raw. Result uses submissionId or operationId. When the request declared work, the answer is a state note: work.finalReport.read pages its final report with finalReport true. Images, signatures, and redacted thinking stay omitted.",
		inspect,
		(input, ctx) => {
			if (input.receiptCursor !== undefined && input.view !== "result") throw new Error("receiptCursor requires result view");
			if (input.finalReport !== undefined && input.view !== "result") throw new Error("finalReport requires result view");
			return control("inspect", input, ctx);
		},
	);
	register(
		"agent_send",
		`Admit a task, report, or correction to an agent or a live effort primary from agent_status. A primary accepts immediate messages, not Durable controls or schedules. Coordinate with one concise proposal containing its conditions and one answer, not repeated acknowledgments. Put agreements that others must see in a thread when a participant storage exists. Idle agents start; a busy agent reads each input at its next tool boundary. mode names the class of the input, not a placement time. ${FOLLOW_UP_DELIVERY_BOUNDARY} ${REPORT_DELIVERY_BOUNDARY} Model-origin messages to ordinary primaries use steer. Task check-ins run only when checkInMinutes or agent.checkInMinutes sets a nonzero interval. Assess progress and decide whether to let work continue, steer a wrap-up, or abort a hung tool. checkInMinutes 0 disables. A receipt does not prove action. With deliverAt, schedule the input at an absolute time.`,
		send,
		(input, ctx, callId) => {
			if (input.mode === "report") {
				if (input.deliverAt !== undefined || input.replyTo !== undefined || input.checkInMinutes !== undefined) throw new Error("Report mode takes a recipient and message, not scheduling, replyTo, or check-ins");
				return control("report", { ...input, requestId: `report:${ctx.sessionManager.getSessionId()}:${callId}`, origin: "model" }, ctx);
			}
			if (input.deliverAt === undefined)
				return control("submit", { ...input, checkInMinutes: checkInMinutes(input.checkInMinutes), whenBusy: input.mode ?? "followUp", origin: "model" }, ctx);
			if (input.replyTo !== undefined) throw new Error("replyTo cannot be combined with deliverAt");
			return control(
				"timer-schedule",
				{
					sessionId: input.sessionId,
					message: input.message,
					deliverAt: input.deliverAt,
					mode: input.mode ?? "followUp",
					checkInMinutes: checkInMinutes(input.checkInMinutes),
					origin: "model",
					scheduleId: `timer:send:${ctx.sessionManager.getSessionId()}:${callId}`,
					requestId: `timer-delivery:send:${ctx.sessionManager.getSessionId()}:${callId}`,
				},
				ctx,
			);
		},
	);
	register(
		"agent_steer",
		"Steer live or retained work through its Durable owner. Admitted steering survives process loss. Carried operator decisions retain their original scope; agent claims remain claims.",
		message,
		(input, ctx) => control("submit", { ...input, whenBusy: "steer", origin: "model" }, ctx),
	);
	register(
		"agent_abort",
		"Abort the selected conversation without deleting retained evidence. With timerId, cancel only that input. With release, request host retirement; other work and timers remain.",
		abort,
		(input, ctx) => {
			if (input.release === true && input.background === true) throw new Error("release cannot be combined with background; abort with background first, then release");
			if (input.timerId !== undefined && input.release === true) throw new Error("release cannot be combined with timerId");
			if (input.timerId !== undefined) return control("timer-cancel", { sessionId: input.sessionId, timerId: input.timerId }, ctx);
			const { release, ...params } = input;
			return control(release === true ? "release" : "abort", params, ctx);
		},
	);
	register(
		"agent_attach",
		"Connect to a Durable storage host without new input. Retained unfinished work resumes automatically.",
		obj(
			{ sessionId: id, model: opt(str()), trust: maybeTrust },
			{},
		),
		(input, ctx) => control("attach", input, ctx),
	);
	register(
		"agent_fork",
		"Create an idle native conversation branch in the same storage. The source remains unchanged.",
		obj({ sessionId: id, entryId: opt(id), trust: maybeTrust }, {}),
		(input, ctx) => control("fork", input, ctx),
	);
	register(
		"agent_rewind",
		"Fork before a mistaken entry and redo the work under your correction. The source stays unchanged. Files remain current.",
		obj(
			{ sessionId: id, entryId: id, correction: str({ minLength: 1 }), trust: maybeTrust },
			{},
		),
		(input, ctx) => control("rewind", { ...input, origin: "model" }, ctx),
	);
	register(
		"agent_configure",
		"Change an idle Durable agent's name, exact model, or reasoning level. No task starts. Active work refuses configuration.",
		configure,
		(input, ctx, callId) => control("configure", { ...input, requestId: `configure:${ctx.sessionManager.getSessionId()}:${callId}` }, ctx),
	);
	register(
		"agent_command",
		"Invoke a native contribution command, reload registrations, or fork to a tree entry through its Durable owner.",
		obj(
			{ sessionId: id, name: str({ minLength: 1 }), args: opt(str()) },
			{},
		),
		(input, ctx) => control("command", { ...input, origin: "model" }, ctx),
	);
	register(
		"agent_place",
		"Use the agent bound to a directory, or create it. Longest bound directory wins. An optional prompt starts work. Results arrive without check-ins. Task check-ins run only when checkInMinutes or the configured agent.checkInMinutes sets a nonzero interval; the default is 0.",
		obj(
			{
				area: opt(str()),
				preset: PresetParameter,
				model: opt(str({ description: MODEL_SELECTION_GUIDANCE })),
				thinkingLevel: opt(StringEnum(THINKING_LEVELS)),
				topic: opt(str()),
				prompt: opt(str()),
				checkInMinutes: checkIn,
				trust: maybeTrust,
			},
			{},
		),
		(input, ctx, callId, admissionCaller) => getManager().place({ ...input, origin: "model", requestId: `place:${ctx.sessionManager.getSessionId()}:${callId}` }, admissionCaller ?? caller(ctx, pi)),
	);
	register(
		"agent_compact",
		"Compact without stopping active work. For primary self-compaction, supply a complete continuity summary; it applies after this tool batch.",
		compact,
		async (input, ctx, callId) => {
			if (input.sessionId === ctx.sessionManager.getSessionId()) {
				if (input.instructions !== undefined)
					throw new Error("Primary self-compaction accepts summary, not instructions");
				const usage = ctx.getContextUsage();
				const compaction = {
					identity: String(input.sessionId), self: true, name: ctx.sessionManager.getSessionName(),
					provider: ctx.model?.provider, modelId: ctx.model?.id, thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
					...(usage === undefined ? {} : { before: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } }),
					summaryChars: typeof input.summary === "string" ? input.summary.length : undefined,
				};
				selfCompaction.request(String(input.sessionId), callId, input.summary as string | undefined);
				return { text: "Continuity summary queued for this completed tool batch.", status: "queued", compaction };
			}
			if (input.summary !== undefined) throw new Error("Another agent's compaction accepts instructions, not summary");
			return control("compact", input, ctx);
		},
	);

	const sessionHelp = "Type part of a session name or directory, then press Tab to insert its ID.";
	const outcome = (text: string, sessionId?: string): { text: string; sessionId?: string } =>
		sessionId === undefined ? { text } : { text, sessionId };
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
			const response = (await getManager().status(sessionId)) as {
				conversation?: { name?: unknown; firstMessage?: unknown; identity?: unknown };
			};
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
		{
			name: "new",
			description: "Start a new Durable agent",
			args: [{ name: "task", rest: true, optional: true }],
			help: "Describe the task in your own words. The agent uses your current directory and machine default preset. Its host survives this primary process; advanced overrides use agent_spawn.",
			run: async (args, ctx, onCreated) => {
				const prompt = args.join(" ") || undefined;
				const created = (await getManager().spawn({ prompt, origin: "operator" }, caller(ctx, pi), onCreated)) as {
					sessionId: string;
					cwd?: string;
					status?: { name?: string };
				};
				const label =
					created.status?.name ?? (prompt === undefined ? shortIdentity(created.sessionId) : excerpt(prompt));
				const place = basename(created.cwd ?? ctx.cwd);
				return outcome(
					prompt === undefined ? `Created idle agent “${label}” in ${place}` : `Started agent “${label}” in ${place}`,
					created.sessionId,
				);
			},
		},
		{
			name: "list",
			description: "List Durable agents",
			args: [],
			help: "Read saved agents without a writer. Use agent_list to continue bounded pages.",
			run: async () => asText(await getManager().list()),
		},
		{
			name: "status",
			description: "Show agent state",
			args: [{ name: "session", optional: true, complete: "session" }],
			help: `Without a session, show bounded native conversation state. ${sessionHelp}`,
			run: async (args) => asText(await getManager().status(args[0])),
		},
		...["send", "steer"].map(
			(name): AgentCommandAction => ({
				name,
				description: `Send ${name === "steer" ? "a correction" : "a task or report"}`,
				...(name === "steer"
					? { confirm: "This admits a new direction for the selected agent. Admission does not prove action." }
					: {}),
				help: `${sessionHelp} After the session, write your message. ${name === "steer" ? "A busy agent reads the correction at its next tool boundary and applies it to its current work." : "A busy agent reads the message at its next tool boundary, as new work for the same run."}`,
				args: [
					{ name: "session", complete: "session" },
					{ name: "message", rest: true },
				],
				run: async ([sessionId, ...words], ctx) => {
					const receipt = await control(
						"submit",
						{
							sessionId,
							message: words.join(" "),
							whenBusy: name === "steer" ? "steer" : "followUp",
							origin: "operator",
						},
						ctx,
					);
					const label = await agentLabel(sessionId);
					// The receipt states whether the input is in the agent's context; an unplaced input waits for the next tool boundary.
					const placement = (receipt as { placement?: unknown } | null)?.placement;
					const placed = placement === "placed" ? " (placed)" : placement === "unplaced" ? " (unplaced: the agent reads it at its next tool boundary)" : "";
					return outcome(
						`${name === "steer" ? `Sent a correction to “${label}”` : `Sent a task to “${label}”`}${placed}`,
						sessionId,
					);
				},
			}),
		),
		{
			name: "abort",
			description: "Stop current work; keep the agent",
			confirm: "This stops the selected agent's current operation without deleting its evidence.",
			help: `${sessionHelp} Add release to request host retirement.`,
			args: [{ name: "session", complete: "session-control" }, { name: "release", optional: true }],
			run: async ([sessionId, release], ctx) => {
				if (release !== undefined && release !== "release") throw new Error("Use release or omit the second argument");
				const stopped = await control(release === "release" ? "release" : "abort", { sessionId }, ctx);
				const label = await agentLabel(sessionId);
				if (release !== "release") return outcome(`Requested stop for “${label}”`, sessionId);
				return outcome(releaseCommandMessage(stopped, label), sessionId);
			},
		},
		{
			name: "attach",
			description: "Connect to an agent; optionally change its idle model",
			help: `${sessionHelp} An explicit provider/model changes only an idle agent. No new input starts. Retained unfinished work resumes.`,
			args: [
				{ name: "session", complete: "session" },
				{ name: "model", optional: true },
			],
			run: async ([sessionId, model], ctx) => {
				const attached = await control("attach", { sessionId, ...(model === undefined ? {} : { model }) }, ctx);
				const label = await agentLabel(sessionId);
				if ((attached as { outcome?: unknown } | null)?.outcome === "failed")
					return outcome(`Configuration failed for “${label}”${failureDetail(attached)}`, sessionId);
				return outcome(
					model === undefined ? `Connected to “${label}”` : `Connected to “${label}” with ${model}`,
					sessionId,
				);
			},
		},
		{
			name: "fork",
			description: "Create an idle native branch",
			help: "Use an optional entry ID from agent_inspect. The source remains unchanged.",
			args: [
				{ name: "session", complete: "session" },
				{ name: "entry", optional: true },
			],
			run: async ([sessionId, entryId], ctx) => {
				const forked = (await control("fork", { sessionId, ...(entryId === undefined ? {} : { entryId }) }, ctx)) as {
					identity?: string;
					status?: { name?: string };
				};
				const identity = forked.identity ?? sessionId;
				const label = forked.status?.name ?? (await agentLabel(identity));
				return outcome(`Created branch “${label}”`, identity);
			},
		},
		{
			name: "compact",
			description: "Compact an agent through its owner",
			confirm: "This compacts at the next native boundary. Active work and queued input stay.",
			args: [
				{ name: "session", complete: "session-control" },
				{ name: "instructions", rest: true, optional: true },
			],
			run: async ([sessionId, ...words], ctx) => {
				const result = (await control(
					"compact",
					{ sessionId, ...(words.length ? { instructions: words.join(" ") } : {}) },
					ctx,
				)) as { status?: string };
				const label = await agentLabel(sessionId);
				const status = typeof result?.status === "string" ? result.status : "requested";
				return outcome(
					status === "completed" ? `Compacted “${label}”` : `Compaction ${status} for “${label}”`,
					sessionId,
				);
			},
		},
		{
			name: "inspect",
			description: "Read retained conversation evidence",
			args: [{ name: "session", complete: "session" }],
			run: async ([sessionId], ctx) => asText(await control("inspect", { sessionId }, ctx)),
		},
		{
			name: "rewind",
			description: "Redo work from a mistaken entry",
			confirm: "This creates a fork and starts corrected work against current files.",
			help: "Use an entry ID from agent_inspect. The source remains unchanged.",
			args: [{ name: "session", complete: "session" }, { name: "entry" }, { name: "correction", rest: true }],
			run: async ([sessionId, entryId, ...words], ctx) => {
				const result = (await control(
					"rewind",
					{ sessionId, entryId, correction: words.join(" "), origin: "operator" },
					ctx,
				)) as { identity?: string };
				const label = await agentLabel(sessionId);
				return outcome(`Rewound “${label}” before entry ${entryId}`, result.identity ?? sessionId);
			},
		},
		{
			name: "configure",
			description: "Change an idle agent's configuration",
			args: [
				{ name: "session", complete: "session" },
				{ name: "configuration", rest: true },
			],
			run: async (args, ctx) => {
				const parsed = parseConfigurationArguments(args);
				const result = (await control("configure", { sessionId: parsed.sessionId, ...parsed.patch }, ctx)) as {
					outcome?: string;
				};
				const label = await agentLabel(parsed.sessionId);
				return result?.outcome === "failed"
					? outcome(`Configuration failed for “${label}”${failureDetail(result)}`, parsed.sessionId)
					: outcome(`Updated configuration for “${label}”`, parsed.sessionId);
			},
		},
		{
			name: "profile",
			description: "Read identity and expertise; edit role or expertise with a revision check",
			args: [{ name: "session", complete: "session" }],
			run: async (args, ctx) => {
				const { profileCommand } = await loadProfileDialog();
				return profileCommand((method, input, context) => control(method, input, context)).run(args, ctx);
			},
		},
		{
			name: "command",
			description: "Run a native contribution command",
			confirm: "This invokes a command with the selected owner's authority.",
			args: [{ name: "session", complete: "session" }, { name: "name" }, { name: "args", rest: true, optional: true }],
			run: async ([sessionId, name, ...args], ctx) => {
				const result = (await control("command", { sessionId, name, args: args.join(" "), origin: "operator" }, ctx)) as {
					reloaded?: boolean;
					text?: string;
				};
				const label = await agentLabel(sessionId);
				const commandText = typeof result?.text === "string" ? result.text : "";
				return outcome(
					result?.reloaded === true
						? `Reloaded host registrations for “${label}”`
						: `Ran command ${name} on “${label}”${commandText ? `: ${commandText}` : ""}`,
					sessionId,
				);
			},
		},
		{
			name: "place",
			description: "Use a directory's agent",
			help: "The default is your current directory. A missing binding creates an agent. Use agent_place for directory paths with spaces.",
			args: [
				{ name: "area", optional: true },
				{ name: "task", optional: true, rest: true },
			],
			run: async ([area, ...words], ctx) => {
				const prompt = words.join(" ") || undefined;
				const resolved = area ? resolve(ctx.cwd, area) : ctx.cwd;
				const result = (await getManager().place({ area: resolved, prompt, origin: "operator" }, caller(ctx, pi))) as {
					sessionId: string;
					status?: { name?: string };
				};
				const label = result.status?.name ?? (prompt === undefined ? shortIdentity(result.sessionId) : excerpt(prompt));
				return outcome(
					prompt === undefined
						? `Using “${label}” in ${basename(resolved)}`
						: `Sent a task to “${label}” in ${basename(resolved)}`,
					result.sessionId,
				);
			},
		},
		{
			name: "places",
			description: "List directory bindings",
			args: [],
			run: async () => asText(getManager().places.read()),
		},
		{
			name: "unbind",
			description: "Remove a directory binding without deleting its agent",
			confirm: "This removes the directory binding, not its agent.",
			help: "Use an exact directory from /agent places.",
			args: [{ name: "area" }],
			run: async ([area], ctx) => {
				const resolved = resolve(ctx.cwd, area);
				const removed = getManager().places.unbind(resolved);
				return outcome(
					removed ? `Removed the directory binding for ${resolved}` : `No directory binding for ${resolved}`,
				);
			},
		},
		...createResetTimerActions((ctx) => ({
			control: (method, input) => control(method, input, ctx),
			label: agentLabel,
		})),
	];
	registerResetTimerTools(pi, (ctx) => ({
		control: (method, input) => control(method, input, ctx),
		label: agentLabel,
	}), cards.agent_reset);
	const command = createAgentCommand(
		actions,
		createAgentObservationSource({
			list: (input) => getManager().dashboardPage(input),
			subscribeRoster: (listener) => getManager().subscribeRoster(listener),
			snapshot: (id, params) => getManager().snapshot(id, params),
			observeLive: (id, scope, listener, signal) => getManager().observeLive(id, scope, listener, signal),
		}),
		{
			timers: (id, ctx) =>
				readAgentTimerRows({ control: (method, input) => control(method, input, ctx), label: agentLabel }, id),
			schedule: async (input, ctx) =>
				scheduleAgentInput({ control: (method, params) => control(method, params, ctx), label: agentLabel }, input),
			control: (method, input, ctx, signal) => getManager().control(method, input, caller(ctx, pi), signal ? { signal } : undefined),
			newAgent: async ({ prompt, preset, cwd }, ctx, onCreated) => {
				const created = (await getManager().spawn({ prompt, preset, cwd, origin: "operator" }, caller(ctx, pi), onCreated)) as { sessionId: string; cwd?: string; status?: { name?: string } };
				const label = created.status?.name ?? (prompt === undefined ? shortIdentity(created.sessionId) : excerpt(prompt));
				const place = basename(created.cwd ?? ctx.cwd);
				return outcome(prompt === undefined ? `Created idle agent “${label}” in ${place}` : `Started agent “${label}” in ${place}`, created.sessionId);
			},
			newDefaults: (ctx) => {
				const { defaultPreset, choices } = presetChoices(refreshPreferences(ctx));
				return { cwd: ctx.cwd, presets: choices, ...(defaultPreset === undefined ? {} : { preset: defaultPreset }), ownership: "The answer to the purpose comes back to this session, like agent_spawn." };
			},
		},
		(input, ctx) => getManager().collaborate({ ...input, origin: "operator" }, caller(ctx, pi)),
		(ctx, page) => getManager().sessionFigures(ctx.sessionManager.getSessionId(), page),
		{
			efforts: (ctx) => getManager().awareness(ctx.sessionManager.getSessionId(), ctx.cwd),
			observeEffort: async (id) => formatPrimaryObservation(await getManager().observePrimary(id, { view: "activity" })),
			messageEffort: async (id, text, ctx) => {
				await control("submit", { sessionId: id, message: text, origin: "operator" }, ctx);
				return { text: "Message delivered to the effort's primary. Delivery does not prove action." };
			},
		},
		dashboardPreferences(process.env.PI_AGENT_DIR ?? getAgentDir()),
		() => pi.getSettings().hideThinkingBlock ?? false,
		toolDisplay,
		(ctx) => getManager().dashboardTaskTargets(ctx.sessionManager.getSessionId()),
		(id) => getManager().status(id),
	);
	pi.registerCommand("agent", command);
	pi.registerShortcut("ctrl+alt+g", {
		description: "Open the agent dashboard",
		handler: (ctx) => command.openDashboard(ctx),
	});
	pi.registerCommand("restart", createRestartCommand({ hosts: agentRestartHosts, managedChild: () => false }));
	pi.registerMessageRenderer("agent.peer", renderAgentPeerMessage);
	pi.on("session_start", async (_event, ctx) => {
		resetThreadNotices();
		selfCompaction.clear();
		refreshPreferences(ctx);
		const sessionId = ctx.sessionManager.getSessionId();
		primaries.get(sessionId)?.abort();
		const abort = new AbortController();
		primaries.set(sessionId, abort);
		const purpose = retainedPurpose(ctx.sessionManager, _event.reason);
		const retention = new PrimaryRetention(ctx.sessionManager, () => ctx.isIdle(), (text, details) => {
			refreshPreferences(ctx);
			const wake = !(details !== null && typeof details === "object" && (details as { wake?: unknown }).wake === false);
			pi.sendMessage({ customType: "agent.peer", content: text, details, display: true }, wake ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false });
		});
		primaryRetentions.set(sessionId, retention);
		const retained = ctx.sessionManager.getEntries();
		continuity.start(sessionId, retained);
		await getManager().registerPrimary(sessionId, {
			sentWork: retainedSentWork(retained),
			retainSentWork: (sessionId) => pi.appendEntry(SENT_WORK_ENTRY, { sessionId }),
			retainContinuity: (fact) => continuity.record(sessionId, fact),
			signal: abort.signal,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			name: ctx.sessionManager.getSessionName(),
			observedInput: purpose.text,
			observedInputComplete: purpose.complete,
			observedInputCanCapture: purpose.canCapture,
			model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
			thinkingLevel: pi.getThinkingLevel(),
			send: (text, details, sourceId, requireRetained) => {
				// Only a result that the session file retains settles the requests that its tuples name.
				const results = requireRetained ? deliveredResults(details) : [];
				providerBlocks.observe(details);
				retention.deliver(sourceId, text, details, requireRetained);
				continuity.delivered(sessionId, results);
			},
			status: (text) => ctx.ui.setStatus("agent", text),
			promptTrust: (cwd) =>
				ctx.hasUI
					? promptProjectTrust(cwd, { select: (question, options) => ctx.ui.select(question, [...options]) })
					: Promise.resolve(undefined),
		});
	});
	pi.on("model_select", (event, ctx) => {
		getManager().updatePrimary(ctx.sessionManager.getSessionId(), {
			model: { provider: event.model.provider, modelId: event.model.id },
		});
	});
	pi.on("thinking_level_select", (event, ctx) => {
		getManager().updatePrimary(ctx.sessionManager.getSessionId(), { thinkingLevel: event.level });
	});
	pi.on("session_info_changed", (event, ctx) => {
		getManager().updatePrimary(ctx.sessionManager.getSessionId(), { name: event.name });
	});
	pi.on("context", (event, ctx) => {
		const sources = ordinaryThreadSources(ctx);
		if (sources.length === 0 && threadNoticeSnapshots.length === 0) return;
		const associations = associateThreadNotices(event.messages, sources);
		const projection = projectThreadNotices({ scope: `${ctx.sessionManager.getSessionId()}:${threadNoticeLifecycle}`, messages: event.messages, associations, snapshots: threadNoticeSnapshots,
			marker: (original, text) => original.role === "custom" ? { ...original, content: text } : original,
		});
		threadNoticeSnapshots = projection.snapshots;
		return { messages: projection.messages };
	});
	pi.on("session_tree", resetThreadNotices);
	pi.on("before_agent_start", async (event, ctx) => {
		event.systemPromptOptions.sections["agent-preferences"] = renderAgentPreferences(refreshPreferences(ctx));
		event.systemPromptOptions.sections["agent-efforts"] = formatEffortAwareness(await getManager().awareness(ctx.sessionManager.getSessionId(), ctx.cwd), "prompt");
		const blocks = renderProviderBlockSection(providerBlocks, Date.now());
		if (blocks !== undefined) event.systemPromptOptions.sections["agent-provider-blocks"] = blocks;
	});
	pi.on("input", (event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		getManager().touchPrimary(id);
		if (event.source === "interactive" && getManager().recordPrimaryInput(id, event.text, event.source)) {
			pi.appendEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: purposeExcerpt(event.text) });
		}
		if (event.source === "interactive") {
			offerSessionName(pi, ctx, { source: "interactive", text: event.text });
		}
	});
	pi.on("context", (event, ctx) => continuity.context(event, ctx));
	pi.on("turn_end", (event, ctx) => continuity.turnEnd(event, ctx, selfCompaction.requested));
	pi.on("tool_execution_end", (_event, ctx) => {
		getManager().touchPrimary(ctx.sessionManager.getSessionId());
	});
	pi.on("agent_settled", (_event, ctx) => {
		selfCompaction.clear();
		getManager().touchPrimary(ctx.sessionManager.getSessionId());
	});
	pi.on("agent_settled", (_event, ctx) => { primaryRetentions.get(ctx.sessionManager.getSessionId())?.settled(); });
	pi.on("session_shutdown", async (_event, ctx) => {
		resetThreadNotices();
		disposeFactorySettings();
		selfCompaction.clear();
		const id = ctx.sessionManager.getSessionId();
		primaryRetentions.get(id)?.clear();
		primaryRetentions.delete(id);
		continuity.end(id);
		const abort = primaries.get(id);
		if (!abort) return;
		abort.abort();
		primaries.delete(id);
		await observedManager?.closePrimary(id, abort.signal);
	});
}

export default registerOrdinaryAgentExtension;
