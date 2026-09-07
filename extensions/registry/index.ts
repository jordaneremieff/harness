/**
 * registry: one read-only lookup over the session's own Pi-owned resource records.
 *
 * The extension registers `registry` and a bounded observer over the
 * system-prompt inputs Pi passes to before_agent_start. It builds no second
 * registry and no filesystem index: every record is a projection of a Pi
 * registration entry, and the only file it can open is one a resolved record
 * already points at.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { lookup } from "./lookup.ts";
import { readModels } from "./models.ts";
import { ObservationStore } from "./observer.ts";
import {
	CONTAINS_MAX,
	CONTAINS_MIN,
	CURSOR_MAX_BYTES,
	LIMIT_DEFAULT,
	LIMIT_MAX,
	LIMIT_MIN,
	NAME_MAX,
	NAME_MIN,
	QUERY_KINDS,
	decodeCursor,
	type RawParams,
} from "./query.ts";
import type { HostSnapshot, ObservationSnapshot, SurfaceAvailability } from "./records.ts";

export const RegistryParams = Type.Object(
	{
		name: Type.Optional(
			Type.String({
				minLength: NAME_MIN,
				maxLength: NAME_MAX,
				description: "Exact case-sensitive resource name. A skill also answers to its skill:<name> invocation form.",
			}),
		),
		match: Type.Optional(
			StringEnum(["exact", "substring"] as const, {
				description: "Name comparison mode; exact is the default. Both are case-sensitive.",
			}),
		),
		kind: Type.Optional(
			StringEnum(QUERY_KINDS, { description: "Resource kind. model queries the model catalog; context_file returns prior observed paths only." }),
		),
		search: Type.Optional(Type.String({ minLength: 1, maxLength: NAME_MAX,
			description: "Literal case-insensitive search over names, descriptions, and tool usage guidelines, not file contents." })),
		detail: Type.Optional(Type.Boolean({ description: "Return parameters and promptGuidelines for kind tool and one exact name; no search or contains." })),
		provider: Type.Optional(Type.String({ minLength: 1, maxLength: NAME_MAX, description: "Exact provider ID; requires kind model." })),
		available: Type.Optional(Type.Boolean({ description: "Filter cached availability; requires kind model. Not remote health." })),
		contains: Type.Optional(
			Type.String({
				minLength: CONTAINS_MIN,
				maxLength: CONTAINS_MAX,
				description:
					"Literal, case-insensitive content query against one uniquely resolved file-backed skill or prompt.",
			}),
		),
		limit: Type.Optional(
			Type.Integer({
				minimum: LIMIT_MIN,
				maximum: LIMIT_MAX,
				description: `Records per page; default ${LIMIT_DEFAULT}.`,
			}),
		),
		cursor: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: CURSOR_MAX_BYTES,
				description: "Opaque continuation from a previous page. Pass it as the only argument.",
			}),
		),
	},
	{ additionalProperties: false },
);

/**
 * Read the Pi surfaces this tool projects.
 *
 * Each surface is probed independently so one absent accessor is reported as
 * unavailable instead of collapsing the whole snapshot into an empty result.
 */
export function readSnapshot(pi: ExtensionAPI, observation: ObservationSnapshot | null, at: number): HostSnapshot {
	const availability: SurfaceAvailability = { tools: false, activeTools: false, commands: false };
	let tools: HostSnapshot["tools"] = [];
	let activeTools: string[] = [];
	let commands: HostSnapshot["commands"] = [];
	try {
		const all = pi.getAllTools();
		if (Array.isArray(all)) {
			tools = all.map((tool) => ({
				name: tool.name,
				...(tool.description === undefined ? {} : { description: tool.description }),
				sourceInfo: tool.sourceInfo,
				parameters: tool.parameters,
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
	return { tools, activeTools, commands, observation, availability, at };
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

	pi.registerTool<typeof RegistryParams, Record<string, unknown>>({
		name: "registry",
		label: "Registry",
		description:
			"Look up session tools, commands, skills, prompt templates, model catalog, and prior observed context-file paths. Use search for purpose discovery across names, descriptions, and tool usage guidelines, kind model with canonical provider/id name for model selection facts, and detail true with kind tool and an exact name for its parameters and guidelines. With no arguments it returns a host summary and its observation boundaries. name is case-sensitive; a skill also answers to its skill:<name> invocation form and results keep both names. contains runs one literal, case-insensitive content search over a single uniquely resolved file-backed skill or prompt and returns matching lines with context. Results carry every sourceInfo field, the observation time, and the evidence type, and tool records separate configured presence from active status. Complete results are bounded to 50 KiB and 2000 lines; scans read at most 256 KiB. Read-only: it accepts no file path, crawls no directory, and mutates nothing.",
		promptSnippet: "Discover session resources, models, tool schemas, and observed context paths",
		promptGuidelines: [
			"Use an already-visible tool directly when its purpose and arguments fit the task. Use registry when the needed resource, model capability, tool arguments, or instruction source is uncertain. Use search with a short task phrase when the name is unknown.",
			"Use registry detail true with kind tool and an exact name to inspect parameters and guidelines; registry presence does not activate a tool. Model availability is a cached local snapshot, not credential validity or remote health.",
			"Use registry with contains to quote a line from one named skill or prompt file rather than reading the file by path.",
			"Treat a registry partial, unavailable, or not_yet_observed result as incomplete evidence, not absence. Search is literal: no matching phrase does not prove no relevant capability exists. Try another short term or inspect a bounded kind list.",
		],
		parameters: RegistryParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const at = Date.now();
			const abortSignal = signal ? AbortSignal.any([signal, sessionAbort.signal]) : sessionAbort.signal;
			if (abortSignal.aborted) {
				const result = await lookup({
					params: params as RawParams, epoch, signal: abortSignal, session: {},
					snapshot: { tools: [], activeTools: [], commands: [], observation: null,
						availability: { tools: false, activeTools: false, commands: false }, at },
				});
				return { content: [{ type: "text" as const, text: result.text }], details: result.details };
			}
			const snapshot = readSnapshot(pi, observations.snapshot(), at);
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
				epoch,
				signal: abortSignal,
			});
			return { content: [{ type: "text" as const, text: result.text }], details: result.details };
		},
	});
}
