import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { boundResult, resultByteLimit, RexCore, type RexRequest } from "./core.ts";
import { liveCalls, ordinaryOwner, ordinaryOwnershipStore, ordinaryStatusStore, resultChannels, serialiseOwners, type RexAdapterOptions } from "./config.ts";
import { rexContribution } from "./durable.ts";
import { createRexToolDisplay, publishRexToolDisplay } from "./display.ts";
import { publishSettings, readSettings } from "./settings.ts";
import { REX_GUIDANCE, ResultSchema, toolSpecs, validateRequest, type StatusRequest } from "./schema.ts";
import { rexStatus, type RexExecutor } from "./status.ts";

export function registerRex(pi: ExtensionAPI, options: RexAdapterOptions = {}): void {
	const agentDir = getAgentDir();
	const stopPublisher = publishSettings(pi.events, { agentDir });
	const settings = readSettings({ agentDir }).values;
	const serialise = serialiseOwners();
	const active = new Set<RexExecutor>();
	const invocations = liveCalls();
	let lifetime = new AbortController();
	const stopCalls = async () => {
		lifetime.abort();
		try { for (const core of active) core.dispose(); }
		finally { await invocations.drain(); }
	};
	const tools: ToolDefinition<TSchema>[] = [];
	for (const spec of toolSpecs) {
		const tool: ToolDefinition<TSchema> = {
			...createRexToolDisplay(spec.name),
			name: spec.name, label: spec.label, description: spec.description,
			parameters: spec.parameters, outputSchema: ResultSchema,
			promptSnippet: spec.description,
			promptGuidelines: spec.name === "rex_environment" ? [REX_GUIDANCE] : undefined,
			execute: async (callId, args, signal, _onUpdate, ctx) => {
				const validated = validateRequest(spec.name, args);
				if (!validated.ok) return resultChannels(validated);
				const ownerId = ordinaryOwner(ctx);
				const coreOptions = { ...settings, store: ordinaryOwnershipStore(pi, ctx, settings.maxRecords, serialise), isCallActive: invocations.isCallActive };
				const core = options.createCore?.(coreOptions) ?? new RexCore(coreOptions);
				const release = invocations.enter(ownerId, callId);
				active.add(core);
				const context = { ownerId, callId, cwd: ctx.cwd, signal: AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]) };
				try {
					const result = spec.name === "rex_status"
						? await rexStatus(validated.request as StatusRequest, context, core, ordinaryStatusStore(pi, ctx, serialise, context.signal), async () => ({ host: "ordinary", state: ctx.isIdle() ? "idle" : "active", observedAt: new Date().toISOString(), source: "ExtensionContext.isIdle()", note: "Current ordinary host activity only. Pi's interactive reporter owns TUI lifecycle output. Headless and RPC callers do not gain terminal attachment." }))
						: await core.execute(validated.request as RexRequest, context);
					return resultChannels(boundResult(result, resultByteLimit(settings.maxOutputBytes)));
				} finally { active.delete(core); try { core.dispose(); } finally { release(); } }
			},
		};
		tools.push(tool);
		pi.registerTool<TSchema>(tool);
	}
	const stopDisplay = publishRexToolDisplay(pi.events, tools);
	pi.on("session_start", async () => { await stopCalls(); lifetime = new AbortController(); });
	pi.on("session_shutdown", async () => { try { await stopCalls(); } finally { try { stopDisplay(); } finally { stopPublisher(); } } });
	pi.events.emit("durable:contribution", rexContribution(fileURLToPath(import.meta.url), pi.events, stopPublisher, options));
}

export default registerRex;
