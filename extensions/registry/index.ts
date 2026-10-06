/**
 * registry: one read-only lookup over the session's own Pi-owned resource records.
 *
 * The extension registers `registry` and a bounded observer over the
 * system-prompt inputs Pi passes to before_agent_start. It builds no second
 * registry and no filesystem index: every record is a projection of a Pi
 * registration entry, and the only file it can open is one a resolved record
 * already points at.
 */

import { toolDisplayPublisher } from "./tool-display.ts";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { REGISTRY_DESCRIPTION, REGISTRY_PROMPT_GUIDELINES, REGISTRY_PROMPT_SNIPPET, RegistryParams } from "./contract.ts";
import { createRegistryDurableContribution } from "./durable.ts";
import { lookup } from "./lookup.ts";
import { RegistryOutputSchema } from "./output.ts";
import { readContext } from "./host.ts";
import { readModels } from "./models.ts";
import { ObservationStore } from "./observer.ts";
import { renderRegistryCall, renderRegistryResult } from "./presentation.ts";
import { decodeCursor, type RawParams } from "./query.ts";
import { projectNamespace, type HostSnapshot, type ObservationSnapshot, type SurfaceAvailability } from "./records.ts";

export { RegistryParams };

/**
 * Read the Pi surfaces this tool projects.
 *
 * Each surface is probed independently so one absent accessor is reported as
 * unavailable instead of collapsing the whole snapshot into an empty result.
 */
export function readSnapshot(pi: ExtensionAPI, observation: ObservationSnapshot | null, at: number, ctx?: Pick<ExtensionToolContext, "tools">): HostSnapshot {
	const availability: SurfaceAvailability = { tools: false, activeTools: false, commands: false };
	let tools: HostSnapshot["tools"] = [];
	let activeTools: string[] = [];
	let callableTools: string[] | undefined;
	if (ctx) {
		availability.callableTools = false;
		try {
			const callable = ctx.tools;
			if (Array.isArray(callable)) {
				callableTools = callable.map((tool) => tool.name);
				availability.callableTools = true;
			}
		} catch { /* A missing callable snapshot is not an empty callable set. */ }
	}
	let commands: HostSnapshot["commands"] = [];
	try {
		const all = pi.getAllTools();
		if (Array.isArray(all)) {
			tools = all.map((tool) => ({
				name: tool.name,
				...(tool.description === undefined ? {} : { description: tool.description }),
				sourceInfo: tool.sourceInfo,
				parameters: tool.parameters,
				...(tool.exposure === undefined ? {} : { exposure: tool.exposure }),
				...(tool.namespace === undefined ? {} : { namespace: projectNamespace(tool.namespace) }),
				...(tool.annotations === undefined ? {} : { annotations: { ...tool.annotations } }),
				...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: [...tool.promptGuidelines] }),
			}));
			availability.tools = true;
		}
	} catch {
		availability.tools = false;
	}
	try {
		const active = pi.getActiveTools();
		if (Array.isArray(active)) {
			activeTools = [...active];
			availability.activeTools = true;
		}
	} catch {
		availability.activeTools = false;
	}
	try {
		const all = pi.getCommands();
		if (Array.isArray(all)) {
			commands = all.map((command) => ({
				name: command.name,
				...(command.description === undefined ? {} : { description: command.description }),
				source: command.source,
				sourceInfo: command.sourceInfo,
			}));
			availability.commands = true;
		}
	} catch {
		availability.commands = false;
	}
	return { tools, activeTools, ...(callableTools ? { callableTools } : {}), commands, observation, availability, at };
}

function sessionFacts(ctx: ExtensionContext) {
	const facts: {
		cwd?: string;
		mode?: string;
		hasUI?: boolean;
		projectTrusted?: boolean;
		sessionId?: string;
		sessionFile?: string | null;
	} = {};
	if (typeof ctx.cwd === "string") facts.cwd = ctx.cwd;
	if (typeof ctx.mode === "string") facts.mode = ctx.mode;
	if (typeof ctx.hasUI === "boolean") facts.hasUI = ctx.hasUI;
	try {
		if (typeof ctx.isProjectTrusted === "function") facts.projectTrusted = ctx.isProjectTrusted();
	} catch {
		// An unavailable trust probe stays unavailable rather than guessing a value.
	}
	try { facts.sessionId = ctx.sessionManager.getSessionId(); }
	catch { /* Session metadata remains unavailable when its accessor fails. */ }
	try { facts.sessionFile = ctx.sessionManager.getSessionFile() ?? null; }
	catch { /* An unavailable accessor is not an ephemeral session. */ }
	return facts;
}

export default function registerRegistry(pi: ExtensionAPI) {
	const { registerTool, publish } = toolDisplayPublisher(pi);
	// The host, when one is listening, installs the native Durable form. In an
	// ordinary session nothing subscribes and the emission has no effect.
	pi.events.emit("durable:contribution", createRegistryDurableContribution(fileURLToPath(import.meta.url)));
	const observations = new ObservationStore();
	// The epoch separates one session's cursors from the next. A cursor issued
	// before a session boundary can never resume against the new session.
	let epoch = randomUUID();
	let sessionAbort = new AbortController();
	const reset = () => {
		sessionAbort.abort();
		sessionAbort = new AbortController();
		epoch = randomUUID();
		observations.clear();
	};

	pi.on("before_agent_start", async (event) => {
		const options = event.systemPromptOptions;
		if (options) observations.observe(options, Date.now());
		else observations.clear();
	});

	pi.on("session_start", async () => { reset(); });

	pi.on("session_shutdown", async () => {
		reset();
		sessionAbort.abort();
	});

	registerTool<typeof RegistryParams, Record<string, unknown>>({
		name: "registry",
		label: "Registry",
		description: REGISTRY_DESCRIPTION,
		promptSnippet: REGISTRY_PROMPT_SNIPPET,
		promptGuidelines: [...REGISTRY_PROMPT_GUIDELINES],
		parameters: RegistryParams,
		outputSchema: RegistryOutputSchema,
		renderCall: renderRegistryCall,
		renderResult: renderRegistryResult,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const at = Date.now();
			const abortSignal = signal ? AbortSignal.any([signal, sessionAbort.signal]) : sessionAbort.signal;
			if (abortSignal.aborted) {
				const result = await lookup({
					params: params as RawParams, epoch, signal: abortSignal, session: {},
					snapshot: { tools: [], activeTools: [], commands: [], observation: null,
						availability: { tools: false, activeTools: false, commands: false }, at },
				});
				return { content: [{ type: "text" as const, text: result.text }], details: result.details, structuredContent: result.structuredContent };
			}
			const snapshot = readSnapshot(pi, observations.snapshot(), at, ctx);
			let modelQuery = params.kind === "model";
			if (params.cursor !== undefined) {
				try { modelQuery = decodeCursor(params.cursor).query.kind === "model"; }
				catch { /* The query layer returns the bounded validation error. */ }
			}
			const result = await lookup({
				...(modelQuery ? { models: readModels(ctx, at) } : {}),
				params: params as RawParams,
				snapshot,
				session: sessionFacts(ctx),
				readContext: () => readContext(ctx, at),
				epoch,
				signal: abortSignal,
			});
			return { content: [{ type: "text" as const, text: result.text }], details: result.details, structuredContent: result.structuredContent };
		},
	});
	publish();
}
