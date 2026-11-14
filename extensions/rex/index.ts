import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Schema, Static } from "@earendil-works/pi-schema";
import { boundResult, deadlineResult, floatBounds, resultByteLimit, RexCore, type RexRequest } from "./core.ts";
import { liveCalls, ordinaryOwner, ordinaryOwnershipStore, ordinaryStatusStore, resultChannels, serialiseOwners, type RexAdapterOptions } from "./config.ts";
import { rexContribution } from "./durable.ts";
import { createRexBudget } from "./deadline.ts";
import { toolDisplay } from "./display.ts";
import { publishRexToolDisplay } from "./presentation.ts";
import { publishSettings, readSettings } from "./settings.ts";
import { REX_GUIDANCE, ResultSchema, toolSpecs, validateRequest, type StatusRequest } from "./schema.ts";
import { rexStatus, type RexExecutor } from "./status.ts";
import { createTabLabelProjector, type TabLabelProjectorOptions } from "./tab-label.ts";
import { createConversationKeeper, runAnswered, type ConversationKeeperOptions, type FloatedPane } from "./keep-visible.ts";

type RegistrationOptions = RexAdapterOptions & {
	createTabLabelProjector?: (options: TabLabelProjectorOptions) => ReturnType<typeof createTabLabelProjector>;
	createConversationKeeper?: (options: ConversationKeeperOptions) => ReturnType<typeof createConversationKeeper>;
};

/** Blocks of a confirmed floating pane that a `rex_terminal` create returned, with the bounds it requested. */
function createdFloats(tool: string, request: unknown, result: unknown): FloatedPane[] {
	const call = request as { op?: unknown; kind?: unknown; bounds?: number[] } | undefined;
	if (tool !== "rex_terminal" || call?.op !== "create" || call.kind !== "float") return [];
	const effects = (result as { ok?: unknown; effects?: { state?: unknown; resources?: unknown } } | undefined);
	if (effects?.ok !== true || effects.effects?.state !== "confirmed" || !Array.isArray(effects.effects.resources)) return [];
	const bounds = floatBounds(call.bounds);
	return effects.effects.resources.flatMap((resource: { kind?: unknown; blockId?: unknown }) => resource?.kind === "block" && typeof resource.blockId === "string" ? [{ blockId: resource.blockId, bounds }] : []);
}

export function registerRex(pi: ExtensionAPI, options: RegistrationOptions = {}): void {
	const agentDir = getAgentDir();
	const stopPublisher = publishSettings(pi.events, { agentDir });
	const settings = readSettings({ agentDir }).values;
	const tabLabels = (options.createTabLabelProjector ?? createTabLabelProjector)({
		agentDir,
		settings,
		getSessionName: () => pi.getSessionName(),
	});
	const keeper = (options.createConversationKeeper ?? createConversationKeeper)({ settings });
	const serialise = serialiseOwners();
	const active = new Set<RexExecutor>();
	const invocations = liveCalls();
	let lifetime = new AbortController();
	const stopCalls = async () => {
		lifetime.abort();
		try { for (const core of active) core.dispose(); }
		finally { await invocations.drain(); }
	};
	const tools: ToolDefinition<Schema>[] = [];
	// One record set: the registration spreads the same renderer records the pure display module returns.
	const displayRecords = new Map(toolDisplay().tools.map((record) => [record.name, record]));
	for (const spec of toolSpecs) {
		const tool: ToolDefinition<typeof spec.parameters> = {
			...(displayRecords.get(spec.name) ?? {}),
			name: spec.name, label: spec.label, description: spec.description,
			parameters: spec.parameters, outputSchema: ResultSchema,
			promptSnippet: spec.description,
			promptGuidelines: spec.name === "rex_environment" ? [REX_GUIDANCE] : undefined,
			execute: async (callId, args: Static<typeof spec.parameters>, signal, _onUpdate, ctx) => {
				const validated = validateRequest(spec.name, args);
				if (!validated.ok) return resultChannels(validated);
				const budget = createRexBudget(validated.request.timeoutMs, settings.maxWaitMs, AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]));
				try {
				const ownerId = ordinaryOwner(ctx);
				const coreOptions = { ...settings, store: ordinaryOwnershipStore(pi, ctx, settings.maxRecords, serialise, budget), isCallActive: invocations.isCallActive };
				const core = options.createCore?.(coreOptions) ?? new RexCore(coreOptions);
				const release = invocations.enter(ownerId, callId);
				active.add(core);
				const context = { ownerId, callId, cwd: ctx.cwd, signal: budget.signal, budget };
				try {
					const result = spec.name === "rex_status"
						? await rexStatus(validated.request as StatusRequest, context, core, ordinaryStatusStore(pi, ctx, serialise, context.signal, budget), async () => ({ host: "ordinary", state: ctx.isIdle() ? "idle" : "active", observedAt: new Date().toISOString(), source: "ExtensionContext.isIdle()", note: "Current ordinary host activity only. Pi's interactive reporter owns TUI lifecycle output. Headless and RPC callers do not gain terminal attachment." }))
						: await core.execute(validated.request as RexRequest, context);
					keeper.floated(createdFloats(spec.name, validated.request, result));
					return resultChannels(boundResult(deadlineResult(result, budget, validated.request.op), resultByteLimit(settings.maxOutputBytes)));
				} finally { active.delete(core); try { core.dispose(); } finally { release(); } }
				} finally { budget.dispose(); }
			},
		};
		tools.push(tool);
		pi.registerTool(tool);
	}
	const stopDisplay = publishRexToolDisplay(pi.events, tools);
	pi.on("session_start", async (_event, ctx) => { await stopCalls(); lifetime = new AbortController(); tabLabels.start(ctx); keeper.start(ctx); });
	// The conversation needs the operator when its run ends with an answer or an error, or a dialog waits.
	// A run that ends quietly in a tool call leaves the arrangement alone: its work can still be running.
	pi.on("agent_settled", (event, ctx) => { if (runAnswered(ctx.sessionManager.getBranch(), event.aborted)) keeper.attention(ctx); });
	pi.on("ui_prompt_start", (_event, ctx) => { keeper.attention(ctx); });
	pi.on("session_info_changed", (_event, ctx) => { tabLabels.refresh(ctx); });
	pi.on("input", (event, ctx) => { if (event.source === "interactive") tabLabels.input(ctx); });
	pi.on("session_shutdown", async () => {
		const labelsStopped = tabLabels.shutdown();
		const keeperStopped = keeper.shutdown();
		try { await stopCalls(); }
		finally {
			try { await Promise.all([labelsStopped, keeperStopped]); }
			finally { try { stopDisplay(); } finally { stopPublisher(); } }
		}
	});
	pi.events.emit("durable:contribution", rexContribution(fileURLToPath(import.meta.url), pi.events, stopPublisher, options));
}

export default registerRex;
