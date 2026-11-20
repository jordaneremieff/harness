import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Schema, Static } from "@earendil-works/pi-schema";
import {
	boundResult,
	deadlineResult,
	floatBounds,
	resultByteLimit,
	RexCore,
	type RexCallContext,
	type RexRequest,
	type RexResult,
} from "./core.ts";
import { createRexBudget, type RexBudget } from "./deadline.ts";
import {
	liveCalls,
	ordinaryOwner,
	ordinaryOwnershipStore,
	ordinaryStatusStore,
	resultChannels,
	serialiseOwners,
	type RexAdapterOptions,
} from "./config.ts";
import { rexContribution } from "./durable.ts";
import { toolDisplay } from "./display.ts";
import { publishRexToolDisplay } from "./presentation.ts";
import { publishSettings, readSettings } from "./settings.ts";
import {
	REX_GUIDANCE,
	ResultSchema,
	toolSpecs,
	validateRequest,
	type RexToolName,
	type StatusRequest,
} from "./schema.ts";
import { rexStatus, type RexExecutor } from "./status.ts";
import { createTabLabelProjector, type TabLabelProjectorOptions } from "./tab-label.ts";
import {
	createConversationKeeper,
	runAnswered,
	type ConversationKeeperOptions,
	type FloatedPane,
} from "./keep-visible.ts";
import { createSessionPaneRegistrar, type SessionPaneRegistrarOptions } from "./session-pane.ts";
import { registerRexCommand } from "./setup.ts";
import { createPaletteCollector, paletteRegistryPath } from "./palette.ts";
import { paneStackingCommand } from "./pane-stacking.ts";

type RegistrationOptions = RexAdapterOptions & {
	createTabLabelProjector?: (options: TabLabelProjectorOptions) => ReturnType<typeof createTabLabelProjector>;
	createConversationKeeper?: (options: ConversationKeeperOptions) => ReturnType<typeof createConversationKeeper>;
	createSessionPaneRegistrar?: (options: SessionPaneRegistrarOptions) => ReturnType<typeof createSessionPaneRegistrar>;
};

/** Blocks of a confirmed floating pane that a `rex_terminal` create returned, with the bounds it requested; a pane created to stay floating is never handed over. */
function createdFloats(tool: string, request: unknown, result: unknown): FloatedPane[] {
	const call = request as { op?: unknown; kind?: unknown; bounds?: number[]; keepFloating?: unknown } | undefined;
	if (tool !== "rex_terminal" || call?.op !== "create" || call.kind !== "float" || call.keepFloating === true)
		return [];
	const effects = result as { ok?: unknown; effects?: { state?: unknown; resources?: unknown } } | undefined;
	if (effects?.ok !== true || effects.effects?.state !== "confirmed" || !Array.isArray(effects.effects.resources))
		return [];
	const bounds = floatBounds(call.bounds);
	return effects.effects.resources.flatMap((resource: { kind?: unknown; blockId?: unknown }) =>
		resource?.kind === "block" && typeof resource.blockId === "string" ? [{ blockId: resource.blockId, bounds }] : [],
	);
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
	// The agents of this session open their panes on its tab: their inherited launch context is this record.
	const panes = (options.createSessionPaneRegistrar ?? createSessionPaneRegistrar)({ agentDir });
	// Commands that extensions offer in the Rex palette, recorded for the runtime that /rex setup installs.
	const palette = createPaletteCollector({
		events: pi.events,
		agentDir,
		packageRoot: fileURLToPath(new URL("../..", import.meta.url)),
		paneStacking: () => paneStackingCommand(process.env.REX_SERVER ?? "unix:///", process.env),
	});
	const serialise = serialiseOwners();
	const active = new Set<RexExecutor>();
	const invocations = liveCalls();
	let lifetime = new AbortController();
	const stopCalls = async () => {
		lifetime.abort();
		try {
			for (const core of active) core.dispose();
		} finally {
			await invocations.drain();
		}
	};
	const tools: ToolDefinition<Schema>[] = [];
	// One record set: the registration spreads the same renderer records the pure display module returns.
	const displayRecords = new Map(toolDisplay().tools.map((record) => [record.name, record]));
	/** One operation on its core. */
	const perform = async (
		name: RexToolName,
		request: RexRequest | StatusRequest,
		core: RexExecutor,
		context: RexCallContext,
		ctx: ExtensionToolContext,
	): Promise<RexResult> => {
		if (name === "rex_status") {
			const budget = context.budget;
			return rexStatus(
				request as StatusRequest,
				context,
				core,
				ordinaryStatusStore(pi, ctx, serialise, context.signal, budget),
				async () => ({
					host: "ordinary",
					state: ctx.isIdle() ? "idle" : "active",
					observedAt: new Date().toISOString(),
					source: "ExtensionContext.isIdle()",
					note: "Current ordinary host activity only. Pi's interactive reporter owns TUI lifecycle output. Headless and RPC callers do not gain terminal attachment.",
				}),
			);
		}
		return core.execute(request as RexRequest, context);
	};
	/** A fresh core for one call, with its live-call identity held until the call's cleanup. */
	const withCore = async (
		callId: string,
		ctx: ExtensionToolContext,
		budget: RexBudget,
		use: (core: RexExecutor, ownerId: string) => Promise<RexResult>,
	): Promise<RexResult> => {
		const ownerId = ordinaryOwner(ctx);
		const coreOptions = {
			...settings,
			store: ordinaryOwnershipStore(pi, ctx, settings.maxRecords, serialise, budget),
			isCallActive: invocations.isCallActive,
		};
		const core = options.createCore?.(coreOptions) ?? new RexCore(coreOptions);
		const release = invocations.enter(ownerId, callId);
		active.add(core);
		try {
			return await use(core, ownerId);
		} finally {
			active.delete(core);
			try {
				core.dispose();
			} finally {
				release();
			}
		}
	};
	/** A validated call within one budget. */
	const run = async (
		name: RexToolName,
		request: RexRequest | StatusRequest,
		callId: string,
		signal: AbortSignal | undefined,
		ctx: ExtensionToolContext,
	): Promise<RexResult> => {
		const budget = createRexBudget(
			request.timeoutMs,
			settings.maxWaitMs,
			AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]),
		);
		try {
			const result = await withCore(callId, ctx, budget, (core, ownerId) =>
				perform(name, request, core, { ownerId, callId, cwd: ctx.cwd, signal: budget.signal, budget }, ctx),
			);
			keeper.floated(createdFloats(name, request, result));
			return deadlineResult(result, budget, request.op);
		} finally {
			budget.dispose();
		}
	};
	for (const spec of toolSpecs) {
		const tool: ToolDefinition<typeof spec.parameters> = {
			...(displayRecords.get(spec.name) ?? {}),
			name: spec.name,
			label: spec.label,
			description: spec.description,
			parameters: spec.parameters,
			outputSchema: ResultSchema,
			promptSnippet: spec.description,
			promptGuidelines: spec.name === "rex_environment" ? [REX_GUIDANCE] : undefined,
			execute: async (callId, args: Static<typeof spec.parameters>, signal, _onUpdate, ctx) => {
				const validated = validateRequest(spec.name, args);
				if (!validated.ok) return resultChannels(validated);
				return resultChannels(
					boundResult(
						await run(spec.name, validated.request, callId, signal, ctx),
						resultByteLimit(settings.maxOutputBytes),
					),
				);
			},
		};
		tools.push(tool);
		pi.registerTool(tool);
	}
	const stopDisplay = publishRexToolDisplay(pi.events, tools);
	registerRexCommand(pi, { executable: settings.executable, registryPath: paletteRegistryPath(agentDir) });
	pi.on("session_start", async (_event, ctx) => {
		await stopCalls();
		lifetime = new AbortController();
		tabLabels.start(ctx);
		keeper.start(ctx);
		panes.start(ctx);
		palette.start(ctx);
	});
	// The conversation needs the operator when its run ends with an answer or an error, or a dialog waits.
	// A run that ends quietly in a tool call leaves the arrangement alone: its work can still be running.
	pi.on("agent_settled", (event, ctx) => {
		if (runAnswered(ctx.sessionManager.getBranch(), event.aborted)) keeper.attention(ctx);
	});
	pi.on("ui_prompt_start", (_event, ctx) => {
		keeper.attention(ctx);
	});
	pi.on("session_info_changed", (_event, ctx) => {
		tabLabels.refresh(ctx);
	});
	pi.on("input", (event, ctx) => {
		if (event.source === "interactive") tabLabels.input(ctx);
	});
	pi.on("session_shutdown", async () => {
		panes.shutdown();
		palette.shutdown();
		const labelsStopped = tabLabels.shutdown();
		const keeperStopped = keeper.shutdown();
		try {
			await stopCalls();
		} finally {
			try {
				await Promise.all([labelsStopped, keeperStopped]);
			} finally {
				try {
					stopDisplay();
				} finally {
					stopPublisher();
				}
			}
		}
	});
	pi.events.emit(
		"durable:contribution",
		rexContribution(fileURLToPath(import.meta.url), pi.events, stopPublisher, options),
	);
}

export default registerRex;
