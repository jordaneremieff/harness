/**
 * Policy: records paired tool calls and their outcomes against declarative
 * rules, and runs the one mechanism the active mode selects.
 *
 * Every mode records. `observe` acts on nothing. `notice` shows the operator a
 * flag in the terminal and adds no model-visible text. `annotate` appends one
 * capped line of guidance to a flagged result, at most once per rule id per
 * session. `enforce` blocks built-ins and in-scope promoted agent classes;
 * in-scope active agent classes receive annotation guidance, while scoped-out
 * agent classes only record. No mode changes a tool input,
 * because no rewrite is provably semantics-preserving and Pi does not
 * re-validate a mutated input.
 *
 * Duration is measured here because no event carries it: `tool_call` and
 * `tool_result` are paired by call id and stamped on arrival.
 *
 * The slice sits in the path of every tool call, so a defect in it must never
 * reach that call. Every handler body runs inside a boundary that reports the
 * first failure once and then stops acting for the rest of the session.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	agentClass,
	type AgentMatch,
	AgentRules,
	type AgentRule,
	type AgentScope,
	type AgentState,
	isAgentClass,
	needsOperatorConfirm,
	validateMatch,
	validateNote,
	validateScope,
	validateSlug,
} from "./agent-rules.ts";
import { bindAgentRules, notesFor } from "./classify.ts";
import { resolvePolicyMode, type PolicyMode } from "./mode.ts";
import {
	finishCall,
	startCall,
	trackPending,
	type CallEffects,
	type ContentLike,
	type PendingCall,
	type ResultFacts,
	type SessionFacts,
} from "./record.ts";
import { PolicyWriter, resolvePolicyDir } from "./store.ts";

/** Marker Pi writes into the system prompt when project context files are loaded. */
const PROJECT_CONTEXT_MARKER = "<project_context>";

/** Prefix that marks harness guidance so it is not read as tool output. */
const POLICY_PREFIX = "[policy]";

/** Upper bound on one appended or returned guidance line. */
const MAX_GUIDANCE_BYTES = 512;

/** Sessions whose annotated rule ids are still tracked. */
const MAX_ANNOTATED_SESSIONS = 16;

/** Maximum model-visible output from a rule registry listing. */
const MAX_RULE_LIST_BYTES = 50 * 1024;

const NonEmptyString = Type.String({ minLength: 1 });
const StringChoice = Type.Union([NonEmptyString, Type.Array(NonEmptyString, { minItems: 1 })]);
const OperandsMatchSchema = Type.Object(
	{
		min: Type.Optional(Type.Integer({ minimum: 0 })),
		max: Type.Optional(Type.Integer({ minimum: 0 })),
		any: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
		at: Type.Optional(Type.Record(Type.String({ pattern: "^\\d+$" }), StringChoice, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);
const PipeMatchSchema = Type.Object(
	{
		from: Type.Optional(Type.Boolean()),
		to: Type.Optional(Type.Boolean()),
		fromRedirect: Type.Optional(Type.Boolean()),
		toRedirect: Type.Optional(Type.Boolean()),
		next: Type.Optional(StringChoice),
		later: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
	},
	{ additionalProperties: false },
);
const MatchSchema = Type.Object(
	{
		tool: Type.Literal("bash"),
		command: StringChoice,
		flags: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
		absentFlags: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
		operands: Type.Optional(OperandsMatchSchema),
		pipe: Type.Optional(PipeMatchSchema),
	},
	{ additionalProperties: false },
);
const ScopeSchema = Type.Object(
	{
		exclude: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
		providers: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
		models: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
	},
	{ additionalProperties: false },
);
const AgentStateSchema = StringEnum(["active", "promoted", "disabled", "discarded"] as const);

function readTruncated(details: unknown): boolean {
	if (!details || typeof details !== "object") return false;
	const truncation = (details as { truncation?: unknown }).truncation;
	if (!truncation || typeof truncation !== "object") return false;
	return (truncation as { truncated?: unknown }).truncated === true;
}

function readTokens(usage: unknown): number | null {
	if (!usage || typeof usage !== "object") return null;
	const total = (usage as { totalTokens?: unknown }).totalTokens;
	return typeof total === "number" ? total : null;
}

function modelName(ctx: ExtensionContext): string | null {
	const model = ctx.model;
	return model ? `${model.provider}/${model.id}` : null;
}

function toolText(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function toolFailure(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return "unknown policy rule tool failure";
	}
}

function rulesText(entries: readonly AgentRule[]): string {
	if (entries.length === 0) return "No agent rules.";
	const marker = "\n\n[agent rule list truncated]";
	let text = "";
	for (const rule of entries) {
		const block = [
			`slug: ${rule.slug}`,
			`state: ${rule.state}`,
			`note: ${rule.note}`,
			`match: ${JSON.stringify(rule.match)}`,
			`scope: ${rule.scope === undefined ? "everywhere" : JSON.stringify(rule.scope)}`,
			`model: ${rule.model}`,
			`session: ${rule.session}`,
			`at: ${rule.at}`,
		].join("\n");
		const candidate = text.length === 0 ? block : `${text}\n\n${block}`;
		if (Buffer.byteLength(`${candidate}${marker}`, "utf8") > MAX_RULE_LIST_BYTES) return `${text}${marker}`;
		text = candidate;
	}
	return text;
}

interface ObservedCall extends PendingCall {
	sessionFacts: SessionFacts;
	/** The call was blocked at the tool boundary. */
	blocked?: boolean;
	/** The reason returned with the block, used to confirm Pi applied it. */
	blockReason?: string;
}

interface Annotation {
	text: string;
	/** Rule ids whose guidance this text carries. */
	ids: string[];
}

export default function registerPolicy(pi: ExtensionAPI) {
	const pending = new Map<string, ObservedCall>();
	let stopped = false;
	let failureReported = false;
	let writer: PolicyWriter | null = null;
	let mode: PolicyMode = "observe";

	/** Rule ids already annotated, per session, so history survives a session round-trip. */
	const annotatedBySession = new Map<string, Set<string>>();

	/**
	 * One guidance line for the rule ids a call matched: the prefix plus the
	 * rules' notes in match order, deduplicated and byte-capped. The same text
	 * serves the annotation and the enforcement block reason, so the model sees
	 * one consistent instruction from both mechanisms.
	 */
	const guidanceFor = (tool: string, classes: readonly string[], model: string | null): string => {
		let text = POLICY_PREFIX;
		const included = new Set<string>();
		for (const id of classes) {
			const [note] = notesFor(tool, [id], model);
			if (note === undefined || included.has(note)) continue;
			const candidate = `${text} ${note}`;
			if (Buffer.byteLength(candidate, "utf8") > MAX_GUIDANCE_BYTES) break;
			text = candidate;
			included.add(note);
		}
		if (text === POLICY_PREFIX) {
			throw new Error("policy rules matched but no guidance exists for the matched classes");
		}
		return text;
	};

	/** Bind mutable context facts to the call that observed them. */
	const sessionFacts = (ctx: ExtensionContext): SessionFacts => {
		const model = ctx.model;
		return {
			session: ctx.sessionManager.getSessionId(),
			mode: ctx.mode,
			cwd: ctx.cwd,
			model: model ? `${model.provider}/${model.id}` : null,
			thinkingLevel: ctx.thinkingLevel ?? null,
			projectContext: ctx.getSystemPrompt().includes(PROJECT_CONTEXT_MARKER),
		};
	};

	/**
	 * Stop recording and report once. This runs inside the handler's own catch,
	 * so it must not throw: a thrown value can carry a failing `message` getter
	 * or primitive conversion, and a throw out of a `tool_call` handler makes Pi
	 * replace the call with an error result instead of running the tool.
	 */
	const stop = (error: unknown): void => {
		stopped = true;
		pending.clear();
		if (failureReported) return;
		failureReported = true;
		let reason = "reason unavailable";
		try {
			reason = error instanceof Error ? error.message : String(error);
		} catch {
			// A thrown value that cannot describe itself still stops recording.
		}
		try {
			console.warn(`[policy] recording stopped for this session: ${reason}`);
		} catch {
			// A failing console leaves no channel to report through.
		}
	};

	try {
		mode = resolvePolicyMode(process.env);
	} catch (error) {
		stop(error);
	}

	const rules = AgentRules.load(resolvePolicyDir(process.env, getAgentDir()));
	bindAgentRules(rules);

	const recordWriter = (): PolicyWriter => {
		writer ??= new PolicyWriter(resolvePolicyDir(process.env, getAgentDir()), stop);
		return writer;
	};

	const takeCall = (callId: string): ObservedCall | undefined => {
		const call = pending.get(callId);
		if (call) pending.delete(callId);
		return call;
	};

	const writeRecord = (
		call: ObservedCall,
		content: ContentLike[] | undefined,
		isError: boolean | undefined,
		details: unknown,
		usage: unknown,
		effects: CallEffects,
	): boolean => {
		const result: ResultFacts = {
			content,
			isError,
			truncated: readTruncated(details),
			tokens: readTokens(usage),
		};
		return recordWriter().enqueue(finishCall(call, result, call.sessionFacts, mode, effects), call.blocked === true);
	};

	/** Rule ids already annotated in one session, created on first use. */
	const annotatedIdsFor = (session: string): Set<string> => {
		let ids = annotatedBySession.get(session);
		if (ids) return ids;
		if (annotatedBySession.size >= MAX_ANNOTATED_SESSIONS) {
			const oldest = annotatedBySession.keys().next();
			if (!oldest.done) annotatedBySession.delete(oldest.value);
		}
		ids = new Set();
		annotatedBySession.set(session, ids);
		return ids;
	};

	/**
	 * Build guidance for the rule ids this session has not annotated yet.
	 *
	 * One rule id reaches the model once per session, so a repeated command
	 * class costs nothing after its first flag. Rules that share wording
	 * contribute one line. The byte cap stops the text, and any id left outside
	 * the cap stays unmarked for a later call.
	 */
	const annotationFor = (
		tool: string,
		classes: string[],
		session: string,
		model: string | null,
	): Annotation | undefined => {
		const annotated = annotatedIdsFor(session);
		let text = POLICY_PREFIX;
		const ids: string[] = [];
		const included = new Set<string>();
		for (const id of classes) {
			if (annotated.has(id)) continue;
			const [note] = notesFor(tool, [id], model);
			if (note === undefined) continue;
			if (included.has(note)) {
				ids.push(id);
				continue;
			}
			const candidate = `${text} ${note}`;
			if (Buffer.byteLength(candidate, "utf8") > MAX_GUIDANCE_BYTES) break;
			text = candidate;
			included.add(note);
			ids.push(id);
		}
		if (included.size === 0) return undefined;
		return { text, ids };
	};

	pi.registerTool({
		name: "policy_rule_add",
		label: "Add Policy Rule",
		description: "Add an active agent-authored shell policy rule to the append-only policy registry.",
		executionMode: "sequential",
		parameters: Type.Object(
			{
				slug: Type.String(),
				note: Type.String(),
				match: MatchSchema,
				scope: Type.Optional(ScopeSchema),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const validation =
					validateSlug(params.slug) ??
					validateNote(params.note) ??
					validateMatch(params.match) ??
					validateScope(params.scope);
				if (validation) return toolText(validation);
				const model = modelName(ctx);
				if (model === null) return toolText("cannot attribute a rule without a model");
				const rule: AgentRule = {
					slug: params.slug,
					note: params.note,
					match: params.match as AgentMatch,
					state: "active",
					model,
					session: ctx.sessionManager.getSessionId(),
					at: new Date().toISOString(),
				};
				if (params.scope !== undefined) rule.scope = params.scope as AgentScope;
				const failure = await rules.add(rule);
				return toolText(failure ?? `Added policy class ${agentClass(rule.slug)} in active state.`);
			} catch (error) {
				return toolText(toolFailure(error));
			}
		},
	});

	pi.registerTool({
		name: "policy_rule_list",
		label: "List Policy Rules",
		description: "List non-discarded agent-authored policy rules and their posture, match, scope, and attribution.",
		executionMode: "sequential",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			try {
				return toolText(rulesText(rules.list()));
			} catch (error) {
				return toolText(toolFailure(error));
			}
		},
	});

	pi.registerTool({
		name: "policy_rule_set_state",
		label: "Set Policy Rule State",
		description: "Change an agent-authored policy rule between active, promoted, disabled, and discarded posture.",
		executionMode: "sequential",
		parameters: Type.Object(
			{
				slug: Type.String(),
				state: AgentStateSchema,
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const current = rules.get(params.slug);
				if (!current) return toolText(`unknown agent rule "${params.slug}"`);
				const requested = params.state as AgentState;
				if (needsOperatorConfirm(current.state, requested)) {
					if (!ctx.hasUI) {
						return toolText(
							`cannot lower promoted rule "${current.slug}" in ${ctx.mode} mode: lowering a promoted rule requires operator confirmation`,
						);
					}
					const ok = await ctx.ui.confirm(
						`Lower promoted policy rule ${current.slug}?`,
						`Rule "${current.slug}" would change from ${current.state} to ${requested}.\n\nNote: ${current.note}`,
					);
					if (!ok) return toolText("state change declined by the operator");
				}
				const model = modelName(ctx);
				if (model === null) return toolText("cannot attribute a rule state change without a model");
				const failure = await rules.setState(
					current.slug,
					requested,
					model,
					ctx.sessionManager.getSessionId(),
					new Date().toISOString(),
				);
				return toolText(failure ?? `Set policy class ${agentClass(current.slug)} to ${requested}.`);
			} catch (error) {
				return toolText(toolFailure(error));
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (stopped) return;
		try {
			const facts = sessionFacts(ctx);
			const call: ObservedCall = {
				...startCall(event.toolName, event.toolCallId, event.input as Record<string, unknown>),
				sessionFacts: facts,
			};
			trackPending(pending, call);
			const blocking = call.classes.filter((id) => !isAgentClass(id) || rules.isBlocking(id, facts.model));
			if (mode === "enforce" && blocking.length > 0) {
				const reason = guidanceFor(call.tool, blocking, facts.model);
				// A block is never returned without capacity for its record.
				if (!recordWriter().tryReserve()) {
					stop(new Error("policy writer cannot admit a block record"));
					return;
				}
				call.blocked = true;
				call.blockReason = reason;
				return { block: true, reason };
			}
		} catch (error) {
			stop(error);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (stopped) return;
		try {
			const call = takeCall(event.toolCallId);
			if (!call) return;
			const effects: CallEffects = {};
			let annotation: Annotation | undefined;
			if (call.classes.length > 0) {
				if (mode === "notice" && ctx.mode === "tui") effects.notified = true;
				if ((mode === "annotate" || mode === "enforce") && call.blocked !== true && event.isError !== true) {
					annotation = annotationFor(call.tool, call.classes, call.sessionFacts.session, call.sessionFacts.model);
					if (annotation) effects.annotationBytes = Buffer.byteLength(annotation.text, "utf8");
				}
			}
			// Admission gates the visible effects: no notice or annotation without its record.
			if (
				!writeRecord(
					call,
					event.content as ContentLike[] | undefined,
					event.isError,
					(event as { details?: unknown }).details,
					event.usage,
					effects,
				)
			)
				return;
			if (effects.notified === true) {
				ctx.ui.notify(`${POLICY_PREFIX} ${call.classes.join(", ")}`, "warning");
			}
			if (annotation) {
				const annotated = annotatedIdsFor(call.sessionFacts.session);
				for (const id of annotation.ids) annotated.add(id);
				return {
					content: [...(event.content ?? []), { type: "text", text: annotation.text }],
				};
			}
		} catch (error) {
			stop(error);
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (stopped) return;
		try {
			const call = takeCall(event.toolCallId);
			if (!call) return;
			const outcome =
				event.result && typeof event.result === "object"
					? (event.result as { content?: ContentLike[]; details?: unknown; usage?: unknown })
					: {};
			// A block is recorded only when Pi applied it: the finalized result
			// text is the exact reason. An abort that pre-empted the block leaves
			// the call recorded as an error without the blocked flag.
			const outcomeText = (outcome.content ?? []).map((part) => part.text ?? "").join("");
			writeRecord(call, outcome.content, event.isError, outcome.details, outcome.usage, {
				blocked: call.blocked === true && call.blockReason !== undefined && outcomeText === call.blockReason,
			});
		} catch (error) {
			stop(error);
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			stopped = true;
			pending.clear();
			await writer?.close();
		} catch (error) {
			stop(error);
		}
	});
}
