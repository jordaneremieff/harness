/** Agent controls for independent Pi Durable hosts and the ordinary primary UI. */
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	getPackageDir,
	type AgentBeforeSettleEvent,
	type AgentToolResult,
	type ContextEvent,
	type TurnEndEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { bool, int, map, num, obj, opt, str, unknown, type Schema, type Static } from "@earendil-works/pi-schema";
import { storageStatusPageInput, validateStatusSelectors } from "./storage-status.ts";
import { createAgentObservationSource } from "./agent-observation.ts";
import {
	PresetParameter,
	parseExecutionSelection,
	parsePreferenceSnapshot,
	presetChoices,
	presetDeclaration,
	presetParameter,
	readAgentPreferences,
	renderAgentPreferences,
	type PreferenceSnapshot,
} from "./agent-preferences.ts";
import { ordinaryReportedUsage } from "./agent-usage.ts";
import { appendProviderBlockReceipt, ProviderBlockNotes, renderProviderBlockSection } from "./provider-block-notes.ts";
import { checkInMinutes } from "./check-in-options.ts";
import { CollaborationParams } from "./collaboration-contract.ts";
import { createAgentCommand, type AgentCommandAction } from "./command.ts";
import { THINKING_LEVELS, isThinkingLevel, parseConfigurationArguments } from "./configuration.ts";
import {
	ABORT_BACKGROUND_DESCRIPTION,
	ABORT_DESCRIPTION,
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
import {
	associateThreadNotices,
	projectThreadNotices,
	type ThreadNoticeSource,
	type ThreadRangeSnapshot,
} from "./thread-notice-projection.ts";
import type { AgentContributionHost } from "./durable-agents.ts";
import {
	createResetTimerActions,
	readAgentTimerRows,
	registerResetTimerTools,
	scheduleAgentInput,
} from "./durable-reset-timers.ts";
import { actionErrorCause, agentDisplayName, configureOutcome, type ActionOutcome } from "./action-outcome.ts";
import { formatEffortAwareness } from "./effort-awareness.ts";
import { EFFORT_PURPOSE_ENTRY, purposeExcerpt, retainedPurpose } from "./effort-purpose.ts";
import {
	addWorkReference,
	parseWorkReferenceEvent,
	retainedWorkReferences,
	WORK_REFERENCE_EVENT,
	WORK_REFERENCES_ENTRY,
} from "./work-references.ts";
import type { PrimaryWorkReference } from "./primary-channel.ts";
import { IntentParams, validateIntentInput } from "./effort-schema.ts";
import { validateFleetSelection } from "./fleet-status.ts";
import { createIdCommand } from "./id-command.ts";
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
import { OrdinaryContinuity, PLANNING_BUDGET_NOTICE, deliveredResults } from "./ordinary-continuity.ts";
import { formatPrimaryObservation } from "./primary-observation.ts";
import { PrimaryInbox } from "./primary-inbox.ts";
import { noticeText, PEER_QUESTION_ENTRY, PeerQuestions, peerQuestionDetail } from "./peer-questions.ts";
import { PrimaryRetention } from "./primary-retention.ts";
import { ProfiledListOutputSchema } from "./profile-discovery.ts";
import { HandleSchema, ProfileOutputSchema, ProfileParams } from "./profile-schema.ts";
import { createRestartCommand, type RestartHosts } from "./restart.ts";
import { BriefOutputSchema, DispatchOutputSchema } from "./result-schema.ts";
import {
	BRIEF_DESCRIPTION,
	briefCreationDirectory,
	briefCreationInput,
	briefInputProblems,
	withoutRecipientCwd,
	briefParameters,
	briefPreview,
	briefPreviewText,
	briefRefusal,
	briefTargetDirectory,
	checkBriefSources,
	renderBrief,
	type BriefPreview,
} from "./brief.ts";
import { MAX_CONTINUITY_SUMMARY, SELF_COMPACTION_NOTICE, SelfCompaction } from "./self-compaction.ts";
import { retainedSentWork, SENT_WORK_ENTRY } from "./session-work.ts";
import { publishSettings } from "./settings.ts";
import {
	createAgentToolCards,
	ordinaryWorkCard,
	renderAgentApplicationMessage,
	renderAgentCompactionMessage,
	renderAgentPeerMessage,
	renderAgentPlanningBudgetMessage,
	type AgentToolCard,
} from "./tool-cards.ts";
import { ORDINARY_YIELD_TOOL, registerOrdinaryWork } from "./ordinary-work.ts";
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
const StringEnum = <const T extends readonly string[]>(
	values: T,
	options: { readonly description?: string } = {},
): Schema<T[number]> => ({ type: "string", enum: [...values], ...options });
const id = str({ minLength: 1, maxLength: 256 });
const maybeTrust = opt(bool());
import { InterruptSelection, interruptConflict } from "./interrupt-schema.ts";
const abort = obj(
	{
		interrupt: opt(InterruptSelection),
		sessionId: id,
		trust: maybeTrust,
		background: opt(bool({ description: ABORT_BACKGROUND_DESCRIPTION })),
		release: opt(bool()),
		timerId: opt(int({ minimum: 1 })),
	},
	{},
);
const message = obj({ sessionId: id, message: str({ minLength: 1 }), replyTo: opt(id) }, {});
const checkIn = opt(
	num({
		minimum: 0,
		maximum: 35791,
		description:
			"Owner check-in interval in minutes while unanswered. Default: configured agent.checkInMinutes, which is 0 (no check-ins) unless set; results arrive without them.",
	}),
);
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
		expectReply: opt(
			bool({
				description:
					"Ordinary primary target only: ask a question that expects a reply. The recipient sees how to answer; the reply, or one notice when its run ends without one, arrives here as an event.",
			}),
		),
		inReplyTo: opt(
			str({
				minLength: 1,
				maxLength: 512,
				description: "Answer a question that another session asked here: its question ID. sessionId names the asker.",
			}),
		),
	},
	{},
);
const spawnFields = {
	handle: opt(HandleSchema),
	preset: PresetParameter,
	role: opt(
		str({
			maxLength: 2000,
			description:
				"Durable role text saved on the new agent's profile, with or without a handle. Reuse does not change the role.",
		}),
	),
	cwd: opt(str()),
	name: opt(str({ maxLength: 256 })),
	model: opt(str({ description: MODEL_SELECTION_GUIDANCE })),
	thinkingLevel: opt(StringEnum(THINKING_LEVELS)),
	trust: maybeTrust,
};
const spawn = obj({ ...spawnFields, prompt: opt(str()), checkInMinutes: checkIn }, {});
const brief = briefParameters(spawnFields, checkIn);
const creationKeys = Object.keys(spawnFields);
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
		requestId: opt(
			str({ minLength: 1, description: "Native request ID within the selected conversation; result view only." }),
		),
		operationId: opt(id),
		receiptCursor: opt(
			str({
				minLength: 1,
				maxLength: 2048,
				description:
					"Recipient reference continuation from a result page. Separate from answer offset and history cursor.",
			}),
		),
		finalReport: opt(
			bool({
				description:
					"Result view only: page the retained final report of the selected input's declared work instead of its answer; offset continues it.",
			}),
		),
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
	content: [
		{
			type: "text",
			text:
				(value as { view?: string } | null)?.view === "result"
					? readableControlText(value)
					: typeof value === "string"
						? value
						: JSON.stringify(value, null, resultIndent(value)),
		},
	],
	details: value,
	structuredContent: schema ? structuredObservation(schema, value) : JSON.parse(JSON.stringify(value ?? null)),
});
function controlToolResult(
	name: AgentControlToolName,
	input: Record<string, unknown>,
	value: unknown,
	schema: Schema | undefined,
): AgentToolResult<unknown> {
	const projected = name === "agent_send" && input.mode === "report" ? projectReportReceipt(value) : value;
	const output = result(projected, schema);
	const compactText = (value as { text?: unknown } | null)?.text;
	const text =
		name === "agent_brief" && input.preview === true
			? briefPreviewText(value as BriefPreview)
			: name === "agent_compact" && typeof compactText === "string"
				? compactText
				: undefined;
	return text === undefined ? output : { ...output, content: [{ type: "text", text }] };
}
function releaseCommandOutcome(value: unknown, label: string, sessionId: string): ActionOutcome {
	const state = value as {
		retiring?: boolean;
		aborted?: { cold?: boolean };
		blockers?: string[];
		writesPlaced?: number;
	} | null;
	const writes = state?.writesPlaced ?? 0;
	const placed = writes > 0 ? `; placed ${writes} leftover ${writes === 1 ? "write" : "writes"}` : "";
	if (state?.retiring === true)
		return {
			text: `Release of “${label}”: ${state.aborted?.cold === true ? "no live host to retire" : "host retirement requested"}${placed}.`,
			sessionId,
			kind: "info",
		};
	return {
		text: `The host of “${label}” stays open${state?.blockers?.length ? `: ${state.blockers.join("; ")}` : ""}${placed}`,
		sessionId,
		kind: "warning",
	};
}

const observationSchemas: Partial<Record<AgentControlToolName, Schema>> = {
	agent_spawn: DispatchOutputSchema,
	agent_brief: BriefOutputSchema,
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
	preferenceCatalog: {
		getModel: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
		getModels: () => ctx.modelRegistry.getAll(),
	},
	validateModel: (model, level) => {
		const selected = ctx.modelRegistry.find(model.provider, model.modelId);
		if (!selected) throw new Error(`Model is not in the configured catalog: ${model.provider}/${model.modelId}`);
		if (!isThinkingLevel(level)) throw new Error("Unknown reasoning level");
		return clampThinkingLevel(selected, level);
	},
});
const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

function admitExecutionInput(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	name: string,
	callId: string,
	input: Record<string, unknown>,
): { admitted: Record<string, unknown>; admissionCaller: AgentCaller } {
	const admissionCaller = caller(ctx, pi);
	const key = `${name}:${callId}`;
	const digest = createHash("sha256")
		.update(JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))))
		.digest("hex");
	const entries = ctx.sessionManager.getBranch();
	const retained = (kind: string) =>
		entries.findLast(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === kind &&
				(entry.data as { key?: unknown } | undefined)?.key === key,
		);
	const entry = retained("agent.preference-admission");
	const data = entry?.type === "custom" ? (entry.data as { digest: string; snapshot: unknown }) : undefined;
	if (data && data.digest !== digest) throw new Error("Agent control call ID belongs to different inputs");
	const snapshot = data
		? parsePreferenceSnapshot(data.snapshot)
		: readAgentPreferences(undefined, admissionCaller.preferenceCatalog);
	if (!data) pi.appendEntry("agent.preference-admission", { key, digest, snapshot });
	const selected = retained("agent.execution-selection");
	const admitted = {
		...input,
		preferenceSnapshot: snapshot,
		...(selected?.type === "custom"
			? { selection: parseExecutionSelection((selected.data as { selection: unknown }).selection) }
			: {}),
	};
	admissionCaller.retainExecutionSelection = (selection) => {
		pi.appendEntry("agent.execution-selection", { key, selection: parseExecutionSelection(selection) });
	};
	return { admitted, admissionCaller };
}

function ordinaryThreadSources(ctx: ExtensionContext): ThreadNoticeSource<ContextEvent["messages"][number]>[] {
	let epoch = "initial";
	const sources: ThreadNoticeSource<ContextEvent["messages"][number]>[] = [];
	for (const entry of ctx.sessionManager.buildContextEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") epoch = `entry:${entry.id}`;
		if (entry.type !== "custom_message" || entry.customType !== "agent.peer") continue;
		const details = entry.details as
			| { sourceId?: unknown; deliveryRecipient?: unknown; communicationPassive?: unknown }
			| undefined;
		if (
			typeof details?.sourceId !== "string" ||
			details.deliveryRecipient !== ctx.sessionManager.getSessionId() ||
			(details.communicationPassive as { value?: { kind?: unknown } } | undefined)?.value?.kind !== "notice"
		)
			continue;
		sources.push({
			sourceId: `${entry.id}:${details.sourceId}`,
			recipient: details.deliveryRecipient,
			epoch,
			passive: details.communicationPassive,
			message: {
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
				details: entry.details,
				timestamp: new Date(entry.timestamp).getTime(),
			},
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
			return native
				.createAgentContribution({
					source: originalEntrypoint,
					configureSettings,
					dispatch: (method, params, context) => native.resolveAgentControlDispatch()(method, params, context),
				})
				.create(host);
		},
	});
	const selfCompaction = new SelfCompaction((handler) => pi.on("turn_end", handler));
	const providerBlocks = new ProviderBlockNotes();
	let observedManager: AgentManager | undefined;
	// One record per tool owns its registration, its renderer fallback and its display publication. An ordinary
	// session registers `agent_yield`, whose record is the state note card.
	const observedRows = () => observedManager?.observedToolCardRows() ?? [];
	const yieldCard = ordinaryWorkCard(ORDINARY_YIELD_TOOL, observedRows);
	const cards: Readonly<Record<string, AgentToolCard>> = {
		...createAgentToolCards(observedRows),
		[ORDINARY_YIELD_TOOL]: yieldCard,
	};
	pi.registerToolRenderer((name, next) => next() ?? cards[name]);
	publishToolDisplay(
		pi.events,
		Object.entries(cards).map(([name, presentation]) => ({ name, ...presentation })),
	);
	const primaries = new Map<string, AbortController>();
	/** Newest-first work items of each live session, retained by this extension and published on its endpoint. */
	const workReferences = new Map<string, PrimaryWorkReference[]>();
	pi.events.on(WORK_REFERENCE_EVENT, (value) => {
		const event = parseWorkReferenceEvent(value);
		if (!event || !primaries.has(event.sessionId)) return;
		const { list, changed } = addWorkReference(workReferences.get(event.sessionId) ?? [], event.reference);
		workReferences.set(event.sessionId, list);
		if (!changed) return;
		pi.appendEntry(WORK_REFERENCES_ENTRY, { refs: list });
		getManager().setPrimaryWorkRefs(event.sessionId, list);
	});
	const peerQuestions = new Map<string, PeerQuestions>();
	/** Session start supplies the entries it already read, so the session is scanned once. */
	const questionsOf = (
		ctx: ExtensionContext,
		entries?: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>,
	): PeerQuestions => {
		const id = ctx.sessionManager.getSessionId();
		let questions = peerQuestions.get(id);
		if (!questions) {
			questions = new PeerQuestions((fact) => pi.appendEntry(PEER_QUESTION_ENTRY, fact));
			questions.restore(entries ?? ctx.sessionManager.getEntries());
			peerQuestions.set(id, questions);
		}
		return questions;
	};
	/** A question counts as received when this session's model is given it. */
	const presented = (ctx: ExtensionContext, details: unknown, text: string) => {
		const { question } = peerQuestionDetail(details);
		const asker = (details as { senderIdentity?: unknown } | null)?.senderIdentity;
		if (question !== undefined && typeof asker === "string") questionsOf(ctx).received(question, asker, text);
	};
	/** An arrived reply or notice closes the question that it names. */
	const arrived = (ctx: ExtensionContext, details: unknown) => {
		const { reply, notice } = peerQuestionDetail(details);
		if (reply !== undefined) questionsOf(ctx).closed(reply, "answered");
		if (notice !== undefined) questionsOf(ctx).closed(notice, "unanswered");
	};
	/** One notice per received question that this session's settled run left without a reply. */
	const noticeUnanswered = (ctx: ExtensionContext) => {
		const questions = questionsOf(ctx);
		const self = ctx.sessionManager.getSessionId();
		const name = ctx.sessionManager.getSessionName();
		for (const question of questions.open().received) {
			questions.noticed(question.id, question.peer);
			void getManager()
				.control(
					"report",
					{
						sessionId: question.peer,
						message: noticeText(question, self, name),
						requestId: `notice:${question.id}`,
						questionNotice: question.id,
						origin: "model",
					},
					caller(ctx, pi),
				)
				.catch(() => undefined);
		}
	};
	const primaryDeliveries = new Map<
		string,
		{ retention: PrimaryRetention; inbox: PrimaryInbox; flush(wake?: boolean): void }
	>();
	let threadNoticeLifecycle = 0;
	let threadNoticeSnapshots: ThreadRangeSnapshot[] = [];
	const resetThreadNotices = () => {
		threadNoticeLifecycle++;
		threadNoticeSnapshots = [];
	};
	const getManager = (): AgentManager => {
		const agentDir = process.env.PI_AGENT_DIR ?? getAgentDir();
		const configured = resolve(process.env.PI_AGENT_SESSIONS_DIR ?? join(agentDir, "agent-sessions"));
		mkdirSync(configured, { recursive: true, mode: 0o700 });
		const root = realpathSync(configured);
		const existing = owners.managers.get(root);
		if (existing) {
			if (existing.managerProtocol !== MANAGER_PROTOCOL)
				throw new Error(
					`The retained agent manager uses ${existing.managerProtocol}; this code requires ${MANAGER_PROTOCOL}. Restart Pi before agent controls.`,
				);
			observedManager = existing;
			return existing;
		}
		const manager = new AgentManager({ root, agentDir, packageDir: getPackageDir() });
		owners.managers.set(root, manager);
		observedManager = manager;
		return manager;
	};
	pi.events.on("durable:launch-provider", (query) => {
		if (query === null || typeof query !== "object" || typeof (query as { provide?: unknown }).provide !== "function")
			throw new Error("Independent launch discovery requires provide()");
		(query as { provide: (launch: IndependentCommandLaunch) => void }).provide((input) =>
			getManager().launchIndependent(input),
		);
	});
	let agentFigures = "";
	const showAgentCell = (ctx: ExtensionContext) => ctx.ui.setStatus("agent", agentFigures || undefined);
	let registrationPreferences = readAgentPreferences();
	let currentPreferences = registrationPreferences;
	const continuity = new OrdinaryContinuity({
		append: (fact) => pi.appendEntry(ORDINARY_CONTINUITY_ENTRY, fact),
		budget: (provider, modelId) =>
			currentPreferences.document?.preferences?.contextBudgetTokens?.[`${provider}/${modelId}`],
		diagnose: (sessionId, text) => getManager().continuityNoteFailure(sessionId, text),
	});
	const refreshRegistrations = new Map<string, (snapshot: PreferenceSnapshot) => void>();
	const refreshPreferences = (ctx?: ExtensionContext): PreferenceSnapshot => {
		const snapshot = readAgentPreferences(undefined, ctx ? caller(ctx, pi).preferenceCatalog : undefined);
		currentPreferences = snapshot;
		if (presetDeclaration(snapshot) !== presetDeclaration(registrationPreferences)) {
			registrationPreferences = snapshot;
			for (const refresh of refreshRegistrations.values()) refresh(snapshot);
		}
		return snapshot;
	};
	const control = async (
		method: string,
		input: Record<string, unknown>,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	) => {
		const manager = getManager();
		return manager.control(method, input, caller(ctx, pi), signal ? { signal } : undefined);
	};
	const prepareInput = (
		name: AgentControlToolName,
		input: Record<string, unknown>,
		ctx: ExtensionContext,
		callId: string,
	) => {
		refreshPreferences(ctx);
		return admitExecutionInput(pi, ctx, name, callId, input);
	};
	const executeSpawn = (
		input: Record<string, unknown>,
		ctx: ExtensionContext,
		callId: string,
		admissionCaller?: AgentCaller,
	) =>
		getManager().spawn(
			{ ...input, origin: "model", requestId: `spawn:${ctx.sessionManager.getSessionId()}:${callId}` },
			admissionCaller ?? caller(ctx, pi),
		);
	const sendImmediate = (input: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal) =>
		control(
			"submit",
			{
				...input,
				checkInMinutes: checkInMinutes(input.checkInMinutes),
				whenBusy: input.mode ?? "followUp",
				origin: "model",
			},
			ctx,
			signal,
		);
	const sendQuestionOrReply = async (
		input: Record<string, unknown>,
		ctx: ExtensionContext,
		callId: string,
		signal?: AbortSignal,
	): Promise<unknown> => {
		if (input.mode === "report" || input.deliverAt !== undefined)
			throw new Error("expectReply and inReplyTo require an immediate message, not report mode or deliverAt");
		const questions = questionsOf(ctx);
		const message = String(input.message ?? "");
		if (input.inReplyTo !== undefined) {
			const question = questions.replyTarget(input.inReplyTo, input.sessionId);
			const { expectReply: _expectReply, ...reply } = input;
			const receipt = await sendImmediate(reply, ctx, signal);
			questions.replied(question.id, question.peer);
			return receipt;
		}
		questions.assertCanAsk();
		const id = `question:${ctx.sessionManager.getSessionId()}:${callId}`;
		const receipt = await sendImmediate({ ...input, requestId: id, expectReply: true }, ctx, signal);
		questions.asked(id, String(input.sessionId), message);
		return receipt;
	};
	const steer = (input: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal) =>
		control("submit", { ...input, whenBusy: "steer", origin: "model" }, ctx, signal);
	const register = (
		name: AgentControlToolName,
		description: string,
		parameters: Schema<Record<string, unknown>>,
		execute: (
			input: Record<string, unknown>,
			ctx: ExtensionContext,
			callId: string,
			admissionCaller: AgentCaller | undefined,
			signal: AbortSignal | undefined,
		) => Promise<unknown>,
	): void => {
		const guidance = agentControlGuidance(name, "ordinary");
		const exposure: AgentControlExposure = AGENT_CONTROL_EXPOSURE[name];
		const schema = observationSchemas[name];
		const admitsPreset = ["agent_spawn", "agent_place", "agent_configure"].includes(name);
		const presetAware = admitsPreset || name === "agent_brief";
		const registerDefinition = (snapshot: PreferenceSnapshot): void =>
			pi.registerTool({
				name,
				label: name.replace("agent_", "Agent "),
				description,
				promptSnippet: guidance.snippet,
				promptGuidelines: [...(guidance.guidelines ?? [])],
				parameters: presetAware
					? {
							...parameters,
							properties: {
								...(parameters.properties as Record<string, Schema>),
								preset: presetParameter(snapshot).schema,
							},
						}
					: parameters,
				outputSchema: schema ?? unknown(),
				...(exposure === "direct" ? {} : { exposure }),
				async execute(callId, input: Static<typeof parameters>, signal, _update, ctx) {
					const { admitted, admissionCaller } = admitsPreset
						? prepareInput(name, input, ctx, callId)
						: { admitted: input, admissionCaller: undefined };
					// The signal withdraws only this caller's wait; work that a host admitted keeps running.
					const value = await execute(admitted, ctx, callId, admissionCaller, signal);
					const output = controlToolResult(name, input, value, schema);
					appendProviderBlockReceipt(name, output.content, value, providerBlocks, Date.now());
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
		description:
			"Read current related efforts and your own intent without a write, or publish or clear this ordinary primary session's claim. Intent is a session claim, not verified authority or a lock. Publish and clear also return the published endpoint. No model wake. Independent work needs no claim. Publish where an actual dependency with another effort needs coordination, after bounded discovery; update or clear intent when integration completes. Use agent_send for direct effort contact and agent_collaborate for a retained agreement.",
		parameters: IntentParams,
		outputSchema: unknown(),
		async execute(_callId, input: Static<typeof IntentParams>, _signal, _update, ctx) {
			validateIntentInput(input);
			const { action, ...fields } = input;
			const ownerId = ctx.sessionManager.getSessionId();
			if (action === "read") return result({ awareness: await getManager().awareness(ownerId, ctx.cwd) });
			return result(
				await getManager().publishIntent(
					ownerId,
					action === "clear" ? undefined : (fields as Omit<PrimaryIntentClaim, "updatedAt">),
				),
			);
		},
		renderCall: cards.agent_intent.renderCall,
		renderResult: cards.agent_intent.renderResult,
	});
	register(
		"agent_collaborate",
		"Discover and use shared purpose threads with full agent peers. Create preserves purpose, authority/source, restrictions, acceptance and integrator; without sessionId the thread goes to your own storage, which for an ordinary primary is its thread storage and needs no agent. Create and join accept participation (at most 256 UTF-16 units); omission preserves an existing declaration and an empty string clears it. Join does not accept message. Use post.message for discussion. Forward reads accept after and optional knownFrameRevision; before is exclusive with after. Follow the returned next call unchanged. Passive facts do not wake a recipient or release its wait; explicit notify stays active. Read the frame and paged exchange without starting a host.",
		CollaborationParams,
		(input, ctx, callId) =>
			getManager().collaborate(
				{ ...input, origin: "model", requestId: `collaboration:${ctx.sessionManager.getSessionId()}:${callId}` },
				caller(ctx, pi),
			),
	);
	registerOrdinaryWork(pi, yieldCard, {
		waiting: (sessionId) => continuity.open(sessionId),
		questions: (sessionId) => peerQuestions.get(sessionId)?.open().asked ?? [],
	});
	register(
		"agent_profile",
		"Read or revision-check an agent's durable role and sourced expertise. Saved expertise is evidence, not fresh authority. Profile edits start no model turn.",
		ProfileParams,
		(input, ctx, callId, _admissionCaller, signal) => {
			if (typeof input.sessionId !== "string") throw new Error("A primary profile control requires an agent sessionId");
			return control(
				input.action === "read" ? "profile-read" : "profile-update",
				{ ...input, requestId: `profile:${ctx.sessionManager.getSessionId()}:${callId}` },
				ctx,
				signal,
			);
		},
	);
	register(
		"agent_spawn",
		"Start an independent Durable agent. A prompt starts work; no prompt creates an idle agent. Results arrive without check-ins. Task check-ins run only when checkInMinutes or the configured agent.checkInMinutes sets a nonzero interval; the default is 0. Assess a check-in: report progress, let work continue, steer a wrap-up, or abort a hung tool. Steering does not interrupt a running tool. checkInMinutes 0 disables.",
		spawn,
		executeSpawn,
	);
	/** Admit a rendered brief to an existing agent. An omitted mode or interval stays absent: the host transport refuses undefined fields. */
	const briefExisting = (
		input: Record<string, unknown>,
		message: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	) => {
		const target = { sessionId: input.sessionId, message };
		if (input.mode === "steer" && input.checkInMinutes === undefined) return steer(target, ctx, signal);
		const fields = {
			...target,
			...(input.mode === undefined ? {} : { mode: input.mode }),
			...(input.checkInMinutes === undefined ? {} : { checkInMinutes: input.checkInMinutes }),
		};
		return sendImmediate(fields, ctx, signal);
	};
	register("agent_brief", BRIEF_DESCRIPTION, brief, async (input, ctx, callId, _admissionCaller, signal) => {
		input = await withoutRecipientCwd(input, ctx.cwd, async () => {
			const manager = getManager();
			return briefTargetDirectory(await manager.resolveTarget(String(input.sessionId), signal), manager.catalog);
		});
		const inputProblems = briefInputProblems(input, creationKeys);
		if (input.preview !== true && inputProblems.length) throw new Error(briefRefusal(inputProblems, []));
		const sourceProblems = await checkBriefSources(input, async () => {
			const manager = getManager();
			return typeof input.sessionId === "string"
				? briefTargetDirectory(await manager.resolveTarget(input.sessionId, signal), manager.catalog)
				: briefCreationDirectory(input, ctx.cwd, manager.catalog);
		});
		const rendered = renderBrief(input);
		if (input.preview === true) return briefPreview(rendered, [...inputProblems, ...sourceProblems]);
		if (inputProblems.length || sourceProblems.length) throw new Error(briefRefusal(inputProblems, sourceProblems));

		let value: unknown;
		if (input.sessionId === undefined) {
			const dispatch = {
				...briefCreationInput(input, creationKeys),
				prompt: rendered.text,
				...(input.checkInMinutes === undefined ? {} : { checkInMinutes: input.checkInMinutes }),
			};
			const { admitted, admissionCaller } = prepareInput("agent_brief", dispatch, ctx, callId);
			value = await executeSpawn(admitted, ctx, callId, admissionCaller);
		} else value = await briefExisting(input, rendered.text, ctx, signal);
		return { ...(value as Record<string, unknown>), brief: rendered.brief };
	});
	register(
		"agent_list",
		"Discover Durable agent identities and names without a writer. An exact retained handle match comes first, with or without the leading @. A query then observes other storages whose catalog record carries it. While coverage.complete is false, a page without rows is not absence: call agent_list again with the fields of coverage.next.",
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
		"Orient over agents and related primary efforts. Effort intent is a session claim, not authority. The global overview reports sessions with id and catalogue state. Under the byte limit, work, waiting inputs and recent faults outlast inactive rows, even caller-owned ones. At most three unprotected older terminal attention rows are sampled. Summary and coverage describe omissions and point to agent_list discovery. Selected status is compact by default. Use detail:true with an explicit sessionId for full state and bounded pending timers. An ordinary primary exposes bounded latest-retained ancestry with detail:true, not live idle or selected-branch state. For one storage, use view: storage-page with its exact storageId. Its conversations use identity (the overview id) and busy (native run activity, not lifecycle state). Continue with coverage.next.tool and its remaining fields unchanged; this backend JSON cursor is separate from agent_list discovery.",
		StatusToolInputSchema,
		async (input, ctx) => {
			validateStatusDetail(input);
			const { detail: _detail, ...selectors } = input;
			validateStatusSelectors(selectors);
			if (input.view === "storage-page") {
				const page = storageStatusPageInput(selectors);
				const { projected } = await fitStorageStatusPage(page.limit, (limit) =>
					getManager().status({ ...page, limit }),
				);
				return projected;
			}
			const sessionId = input.sessionId as string | undefined;
			const view = input.view as "fleet" | undefined;
			const selection = validateFleetSelection(input);
			const selfId = !sessionId ? ctx?.sessionManager?.getSessionId() : undefined;
			const reportedUsage =
				view === "fleet" && ctx?.sessionManager?.getEntries
					? ordinaryReportedUsage(ctx.sessionManager.getEntries())
					: undefined;
			const value = await getManager().status(
				sessionId,
				view,
				selfId ? { id: selfId, cwd: ctx.cwd, reportedUsage } : undefined,
				selection,
			);
			if (sessionId === undefined || input.detail === true) return value;
			return projectSelectedStatus(value);
		},
	);
	register(
		"agent_inspect",
		"Read compact history or activity. Ordinary primary targets support activity/history over bounded latest-retained ancestry, not the live selected branch; pass a clipped entry's textCursor as cursor to page its complete allowed text. Durable targets include role/kind, readable text, named tool calls with argument summaries, and tool result excerpts. Truncation is marked. Use exact with entryId and offset 0 for retained redacted JSON; nextOffset continues it. Pass nextCursor as cursor. Branch remains raw. Result uses submissionId, a conversation-qualified native requestId, or the separate retained operationId. Missing results return unavailable; supplied selectors must agree. Result answerContinuation pages readable answer text; receiptGroup.next pages recipient references with receiptCursor. When the request declared work, the answer is a state note: work.finalReport.read pages its final report with finalReport true. Images, signatures, and redacted thinking stay omitted.",
		inspect,
		(input, ctx, _callId, _admissionCaller, signal) => {
			if (input.requestId !== undefined && input.view !== "result")
				throw new Error("requestId selects only the result view");
			if (input.receiptCursor !== undefined && input.view !== "result")
				throw new Error("receiptCursor requires result view");
			if (input.finalReport !== undefined && input.view !== "result")
				throw new Error("finalReport requires result view");
			return control("inspect", input, ctx, signal);
		},
	);
	register(
		"agent_send",
		`Admit a task, report, or correction to an agent or a live effort primary from agent_status. A primary accepts immediate messages, not Durable controls or schedules. Coordinate with one concise proposal containing its conditions and one answer, not repeated acknowledgments. Put agreements that others must see in a thread. Idle agents start; a busy agent reads each input at its next tool boundary. mode names the class of the input, not a placement time. ${FOLLOW_UP_DELIVERY_BOUNDARY} ${REPORT_DELIVERY_BOUNDARY} Model-origin messages to ordinary primaries use steer. Task check-ins run only when checkInMinutes or agent.checkInMinutes sets a nonzero interval. Assess progress and decide whether to let work continue, steer a wrap-up, or abort a hung tool. checkInMinutes 0 disables. A receipt does not prove action. With deliverAt, schedule the input at an absolute time.`,
		send,
		(input, ctx, callId, _admissionCaller, signal) => {
			if (input.expectReply === true || input.inReplyTo !== undefined)
				return sendQuestionOrReply(input, ctx, callId, signal);
			const { expectReply: _expectReply, inReplyTo: _inReplyTo, ...fields } = input;
			input = fields;
			if (input.mode === "report") {
				if (input.deliverAt !== undefined || input.replyTo !== undefined || input.checkInMinutes !== undefined)
					throw new Error("Report mode takes a recipient and message, not scheduling, replyTo, or check-ins");
				return control(
					"report",
					{ ...input, requestId: `report:${ctx.sessionManager.getSessionId()}:${callId}`, origin: "model" },
					ctx,
					signal,
				);
			}
			if (input.deliverAt === undefined) return sendImmediate(input, ctx, signal);
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
				signal,
			);
		},
	);
	register(
		"agent_steer",
		"Steer live or retained work through its Durable owner. Admitted steering survives process loss. Carried operator decisions retain their original scope; agent claims remain claims.",
		message,
		(input, ctx, _callId, _admissionCaller, signal) => steer(input, ctx, signal),
	);
	register("agent_abort", ABORT_DESCRIPTION, abort, (input, ctx, _callId, _admissionCaller, signal) => {
		if (input.interrupt) {
			if (interruptConflict(input)) throw new Error("interrupt cannot be combined with release, background or timerId");
			return control("interrupt-continue", { sessionId: input.sessionId, interrupt: input.interrupt }, ctx, signal);
		}
		if (input.release === true && input.background === true)
			throw new Error("release cannot be combined with background; abort with background first, then release");
		if (input.timerId !== undefined && input.release === true)
			throw new Error("release cannot be combined with timerId");
		if (input.timerId !== undefined)
			return control("timer-cancel", { sessionId: input.sessionId, timerId: input.timerId }, ctx, signal);
		const { release, ...params } = input;
		return control(release === true ? "release" : "abort", params, ctx, signal);
	});
	register(
		"agent_attach",
		"Connect to a Durable storage host without new input. Retained unfinished work resumes automatically.",
		obj({ sessionId: id, model: opt(str()), trust: maybeTrust }, {}),
		(input, ctx, _callId, _admissionCaller, signal) => control("attach", input, ctx, signal),
	);
	register(
		"agent_fork",
		"Create an idle native conversation branch in the same storage. The source remains unchanged.",
		obj({ sessionId: id, entryId: opt(id), trust: maybeTrust }, {}),
		(input, ctx, _callId, _admissionCaller, signal) => control("fork", input, ctx, signal),
	);
	register(
		"agent_rewind",
		"Fork before a mistaken entry and redo the work under your correction. The source stays unchanged. Files remain current.",
		obj({ sessionId: id, entryId: id, correction: str({ minLength: 1 }), trust: maybeTrust }, {}),
		(input, ctx, _callId, _admissionCaller, signal) => control("rewind", { ...input, origin: "model" }, ctx, signal),
	);
	register(
		"agent_configure",
		"Change a Durable agent's name, exact model, preset, or reasoning level. Changes require an idle target. No task starts.",
		configure,
		(input, ctx, callId, admissionCaller) =>
			getManager().control(
				"configure",
				{ ...input, requestId: `configure:${ctx.sessionManager.getSessionId()}:${callId}` },
				admissionCaller ?? caller(ctx, pi),
			),
	);
	register(
		"agent_command",
		"Invoke a native contribution command, reload registrations, or fork to a tree entry through its Durable owner.",
		obj({ sessionId: id, name: str({ minLength: 1 }), args: opt(str()) }, {}),
		(input, ctx, _callId, _admissionCaller, signal) => control("command", { ...input, origin: "model" }, ctx, signal),
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
		(input, ctx, callId, admissionCaller) =>
			getManager().place(
				{ ...input, origin: "model", requestId: `place:${ctx.sessionManager.getSessionId()}:${callId}` },
				admissionCaller ?? caller(ctx, pi),
			),
	);
	register(
		"agent_compact",
		"Compact without stopping active work. For primary self-compaction, supply a complete continuity summary; it applies after this tool batch.",
		compact,
		async (input, ctx, callId, _admissionCaller, signal) => {
			if (input.sessionId === ctx.sessionManager.getSessionId()) {
				if (input.instructions !== undefined)
					throw new Error("Primary self-compaction accepts summary, not instructions");
				const usage = ctx.getContextUsage();
				const compaction = {
					identity: String(input.sessionId),
					self: true,
					name: ctx.sessionManager.getSessionName(),
					provider: ctx.model?.provider,
					modelId: ctx.model?.id,
					thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
					...(usage === undefined
						? {}
						: { before: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } }),
					summaryChars: typeof input.summary === "string" ? input.summary.length : undefined,
				};
				selfCompaction.request(String(input.sessionId), callId, input.summary as string | undefined);
				return { text: "Continuity summary queued for this completed tool batch.", status: "queued", compaction };
			}
			if (input.summary !== undefined) throw new Error("Another agent's compaction accepts instructions, not summary");
			return control("compact", input, ctx, signal);
		},
	);

	const sessionHelp = "Type part of a session name or directory, then press Tab to insert its ID.";
	const outcome = (text: string, sessionId?: string, kind: ActionOutcome["kind"] = "success"): ActionOutcome =>
		sessionId === undefined ? { text, kind } : { text, sessionId, kind };
	const read = (text: string, sessionId?: string) => outcome(text, sessionId, "read");
	const excerpt = (value: string, limit = 48): string => {
		const collapsed = value.replace(/\s+/g, " ").trim();
		return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
	};
	const readLabel = async (sessionId: string) => {
		try {
			const response = (await getManager().status(sessionId)) as {
				conversation?: { name?: string; firstMessage?: string; identity?: string };
			};
			return response?.conversation;
		} catch {
			return undefined;
		}
	};
	const agentLabel = async (sessionId: string) => {
		const conversation = await readLabel(sessionId);
		return agentDisplayName({ ...conversation, id: conversation?.identity ?? sessionId });
	};
	// The reset tool retains its model-facing text independently of command labels.
	const resetToolLabel = async (sessionId: string) => {
		const conversation = await readLabel(sessionId);
		const name = typeof conversation?.name === "string" ? excerpt(conversation.name) : "";
		const first = typeof conversation?.firstMessage === "string" ? excerpt(conversation.firstMessage) : "";
		const id = typeof conversation?.identity === "string" ? conversation.identity : sessionId;
		const tail = id.slice(id.lastIndexOf(":") + 1);
		return name || first || (tail || id).slice(0, 8);
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
				const label = agentDisplayName({ id: created.sessionId, name: created.status?.name, firstMessage: prompt });
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
			run: async () => read(asText(await getManager().list())),
		},
		{
			name: "status",
			description: "Show agent state",
			args: [{ name: "session", optional: true, complete: "session" }],
			help: `Without a session, show bounded native conversation state. ${sessionHelp}`,
			run: async ([sessionId]) =>
				read(asText(await getManager().status(sessionId, undefined, undefined, {})), sessionId),
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
					const admission = receipt as { placement?: unknown; deduped?: boolean } | null;
					if (admission?.deduped === true)
						return outcome(`Input for “${label}” was already admitted.`, sessionId, "info");
					const placement = admission?.placement;
					let placed = "";
					if (placement === "placed") placed = " (placed)";
					if (placement === "unplaced") placed = " (unplaced: the agent reads it at its next tool boundary)";
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
			args: [
				{ name: "session", complete: "session-control" },
				{ name: "release", optional: true },
			],
			run: async ([sessionId, release], ctx) => {
				if (release !== undefined && release !== "release") throw new Error("Use release or omit the second argument");
				const stopped = await control(release === "release" ? "release" : "abort", { sessionId }, ctx);
				const label = await agentLabel(sessionId);
				if (release === "release") return releaseCommandOutcome(stopped, label, sessionId);
				const state = stopped as { settled?: boolean } | null;
				return outcome(
					state?.settled === true ? `Stop settled for “${label}”.` : `Stop requested for “${label}”.`,
					sessionId,
					"info",
				);
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
				const label = await agentLabel(sessionId);
				if (model !== undefined) {
					const configured = await configureOutcome(sessionId, label, async () => {
						const attached = (await control("attach", { sessionId, model }, ctx)) as { recovery?: unknown } | null;
						return typeof attached?.recovery === "string" ? { outcome: "applied" } : attached;
					});
					if (configured.kind === "error") return configured;
				} else await control("attach", { sessionId }, ctx);
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
				const identity = forked.identity;
				if (!identity) throw new Error("The host did not return a branch identity");
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
					status === "completed" ? "success" : "info",
				);
			},
		},
		{
			name: "inspect",
			description: "Read retained conversation evidence",
			args: [{ name: "session", complete: "session" }],
			run: async ([sessionId], ctx) => read(asText(await control("inspect", { sessionId }, ctx)), sessionId),
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
				if (!result.identity) throw new Error("The host did not return a rewind identity");
				return outcome(`Rewound “${label}” before entry ${entryId}`, result.identity);
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
				return configureOutcome(parsed.sessionId, await agentLabel(parsed.sessionId), () =>
					control("configure", { sessionId: parsed.sessionId, ...parsed.patch }, ctx),
				);
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
				const result = (await control(
					"command",
					{ sessionId, name, args: args.join(" "), origin: "operator" },
					ctx,
				)) as {
					reloaded?: boolean;
					text?: string;
				};
				const label = await agentLabel(sessionId);
				if (result?.reloaded !== true && typeof result?.text !== "string")
					throw new Error(`The host did not return a result for ${name}`);
				const commandText = result.text;
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
				if (!result.sessionId) throw new Error("The host did not return an agent identity");
				const label = result.status?.name || (await agentLabel(result.sessionId));
				return outcome(
					prompt === undefined
						? `Using “${label}” in ${basename(resolved)}`
						: `Task admitted for “${label}” in ${basename(resolved)}`,
					result.sessionId,
				);
			},
		},
		{
			name: "places",
			description: "List directory bindings",
			args: [],
			run: async () => read(asText(getManager().places.read())),
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
					removed ? `Removed the directory binding for ${resolved}.` : `No directory binding exists for ${resolved}.`,
					undefined,
					removed ? "success" : "info",
				);
			},
		},
		...createResetTimerActions((ctx) => ({
			control: (method, input) => control(method, input, ctx),
			label: agentLabel,
		})),
	];
	registerResetTimerTools(
		pi,
		(ctx) => ({
			control: (method, input) => control(method, input, ctx),
			label: resetToolLabel,
		}),
		cards.agent_reset,
	);
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
			control,
			newAgent: async ({ prompt, preset, cwd }, ctx, onCreated) => {
				const created = (await getManager().spawn(
					{ prompt, preset, cwd, origin: "operator" },
					caller(ctx, pi),
					onCreated,
				)) as { sessionId: string; cwd?: string; status?: { name?: string } };
				const label = agentDisplayName({ id: created.sessionId, name: created.status?.name, firstMessage: prompt });
				const place = basename(created.cwd ?? ctx.cwd);
				return outcome(
					prompt === undefined ? `Created idle agent “${label}” in ${place}` : `Started agent “${label}” in ${place}`,
					created.sessionId,
				);
			},
			newDefaults: (ctx) => {
				const { defaultPreset, choices } = presetChoices(refreshPreferences(ctx));
				return {
					cwd: ctx.cwd,
					presets: choices,
					...(defaultPreset === undefined ? {} : { preset: defaultPreset }),
					ownership: "The answer to the purpose comes back to this session, like agent_spawn.",
				};
			},
		},
		(input, ctx) => getManager().collaborate({ ...input, origin: "operator" }, caller(ctx, pi)),
		async (ctx, page) => getManager().sessionFigures(ctx.sessionManager.getSessionId(), page),
		{
			efforts: (ctx) => getManager().awareness(ctx.sessionManager.getSessionId(), ctx.cwd),
			observeEffort: async (id) =>
				formatPrimaryObservation(await getManager().observePrimary(id, { view: "activity" })),
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
	pi.registerCommand("id", createIdCommand());
	pi.registerCommand("restart", createRestartCommand({ hosts: agentRestartHosts, managedChild: () => false }));
	pi.registerMessageRenderer("agent.peer", renderAgentPeerMessage);
	pi.registerMessageRenderer("application-message", renderAgentApplicationMessage);
	pi.registerMessageRenderer(SELF_COMPACTION_NOTICE, renderAgentCompactionMessage);
	pi.registerMessageRenderer(PLANNING_BUDGET_NOTICE, renderAgentPlanningBudgetMessage);
	pi.on("session_start", async (_event, ctx) => {
		resetThreadNotices();
		selfCompaction.clear();
		refreshPreferences(ctx);
		agentFigures = "";
		const sessionId = ctx.sessionManager.getSessionId();
		primaries.get(sessionId)?.abort();
		const abort = new AbortController();
		primaries.set(sessionId, abort);
		const purpose = retainedPurpose(ctx.sessionManager, _event.reason);
		const workRefs = retainedWorkReferences(ctx.sessionManager);
		workReferences.set(sessionId, workRefs);
		const sendPeer = (text: string, details: unknown, wake: boolean) => {
			refreshPreferences(ctx);
			presented(ctx, details, text);
			pi.sendMessage(
				{ customType: "agent.peer", content: text, details, display: true },
				wake ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false },
			);
		};
		const retention = new PrimaryRetention(
			ctx.sessionManager,
			() => ctx.isIdle(),
			(text, details) => {
				const wake = !(
					details !== null &&
					typeof details === "object" &&
					(details as { wake?: unknown }).wake === false
				);
				sendPeer(text, details, wake);
			},
		);
		const inbox = new PrimaryInbox(ctx.sessionManager);
		const flush = (wake = true) => {
			if (abort.signal.aborted) return;
			try {
				if (!inbox.hasRows() || !ctx.isIdle()) return;
				inbox.flush((row, trigger) => sendPeer(row.text, row.details, trigger), wake);
			} catch (error) {
				ctx.ui.notify(`Primary inbox delivery paused: ${actionErrorCause(error)}`, "error");
			}
		};
		primaryDeliveries.set(sessionId, { retention, inbox, flush });
		peerQuestions.delete(sessionId);
		const retained = ctx.sessionManager.getEntries();
		questionsOf(ctx, retained);
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
			get workRefs() {
				return workReferences.get(sessionId) ?? workRefs;
			},
			model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
			thinkingLevel: pi.getThinkingLevel(),
			resumeInbox: flush,
			send: (text, details, sourceId, requireRetained) => {
				arrived(ctx, details);
				if (!requireRetained) {
					if (retention.hasQueued(sourceId)) throw new Error("Primary delivery awaits its queued source-ledger notice");
					inbox.admit(sourceId, text, details);
					flush();
					return;
				}
				if (inbox.hasPending(sourceId)) throw new Error("Primary delivery awaits its inbox notice");
				// Only a result that the session file retains settles the requests that its tuples name.
				const results = deliveredResults(details);
				providerBlocks.observe(details);
				retention.deliver(sourceId, text, details);
				continuity.delivered(sessionId, results);
			},
			receiveRetainedReplay: (details) => continuity.delivered(sessionId, deliveredResults(details)),
			status: (text) => {
				agentFigures = text ?? "";
				showAgentCell(ctx);
			},
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
		const projection = projectThreadNotices({
			scope: `${ctx.sessionManager.getSessionId()}:${threadNoticeLifecycle}`,
			messages: event.messages,
			associations,
			snapshots: threadNoticeSnapshots,
			marker: (original, text) => (original.role === "custom" ? { ...original, content: text } : original),
		});
		threadNoticeSnapshots = projection.snapshots;
		return { messages: projection.messages };
	});
	pi.on("session_tree", () => resetThreadNotices());
	pi.on("before_agent_start", async (event, ctx) => {
		event.systemPromptOptions.sections["agent-preferences"] = renderAgentPreferences(refreshPreferences(ctx));
		event.systemPromptOptions.sections["agent-efforts"] = formatEffortAwareness(
			await getManager().awareness(ctx.sessionManager.getSessionId(), ctx.cwd, "prompt"),
			"prompt",
		);
		const blocks = renderProviderBlockSection(providerBlocks, Date.now());
		if (blocks !== undefined) event.systemPromptOptions.sections["agent-provider-blocks"] = blocks;
	});
	pi.on("input", (event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		getManager().touchPrimary(id);
		if (event.source === "interactive" && getManager().recordPrimaryInput(id, event.text, event.source)) {
			pi.appendEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: purposeExcerpt(event.text) });
		}
	});
	pi.on("context", (event, ctx) => continuity.context(event, ctx));
	pi.on("turn_end", (event, ctx) => continuity.turnEnd(event, ctx, selfCompaction.requested));
	const inboxBoundary = (event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext) => {
		const inbox = primaryDeliveries.get(ctx.sessionManager.getSessionId())?.inbox.boundary();
		for (const entry of inbox?.entries ?? [])
			presented(ctx, entry.details, typeof entry.content === "string" ? entry.content : "");
		if (inbox) return { entries: [...event.entries, ...inbox.entries], continue: event.continue || inbox.continue };
	};
	pi.on("turn_end", inboxBoundary);
	pi.on("agent_before_settle", inboxBoundary);
	pi.on("tool_execution_end", (_event, ctx) => {
		getManager().touchPrimary(ctx.sessionManager.getSessionId());
	});
	pi.on("agent_settled", (_event, ctx) => {
		selfCompaction.clear();
		getManager().touchPrimary(ctx.sessionManager.getSessionId());
	});
	pi.on("agent_settled", (event, ctx) => {
		noticeUnanswered(ctx);
		const delivery = primaryDeliveries.get(ctx.sessionManager.getSessionId());
		delivery?.retention.settled();
		delivery?.flush(!event.aborted);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		resetThreadNotices();
		disposeFactorySettings();
		selfCompaction.clear();
		const id = ctx.sessionManager.getSessionId();
		primaryDeliveries.get(id)?.retention.clear();
		primaryDeliveries.delete(id);
		workReferences.delete(id);
		peerQuestions.delete(id);
		continuity.end(id);
		const abort = primaries.get(id);
		if (!abort) return;
		abort.abort();
		primaries.delete(id);
		await observedManager?.closePrimary(id, abort.signal);
	});
}

export default registerOrdinaryAgentExtension;
