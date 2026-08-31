/**
 * Policy: records paired tool calls and their outcomes against declarative
 * rules, and runs the one mechanism the active mode selects.
 *
 * Every mode records. `observe` acts on nothing. `notice` shows the operator a
 * flag in the terminal and adds no model-visible text. `annotate` appends one
 * capped line of guidance to a flagged result, at most once per rule id per
 * session. `enforce` blocks a flagged call with a reason that names the
 * preferred form. No mode changes a tool input: every flagged form blocks
 * rather than rewrites, because no rewrite is provably semantics-preserving
 * and Pi does not re-validate a mutated input.
 *
 * Duration is measured here because no event carries it: `tool_call` and
 * `tool_result` are paired by call id and stamped on arrival.
 *
 * The slice sits in the path of every tool call, so a defect in it must never
 * reach that call. Every handler body runs inside a boundary that reports the
 * first failure once and then stops acting for the rest of the session.
 */

import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { notesFor } from "./classify.ts";
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
	const guidanceFor = (tool: string, classes: readonly string[]): string => {
		let text = POLICY_PREFIX;
		const included = new Set<string>();
		for (const id of classes) {
			const [note] = notesFor(tool, [id]);
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
	const sessionFacts = (ctx: ExtensionContext): SessionFacts => ({
		session: ctx.sessionManager.getSessionId(),
		mode: ctx.mode,
		cwd: ctx.cwd,
		projectContext: ctx.getSystemPrompt().includes(PROJECT_CONTEXT_MARKER),
	});

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
	const annotationFor = (tool: string, classes: string[], session: string): Annotation | undefined => {
		const annotated = annotatedIdsFor(session);
		let text = POLICY_PREFIX;
		const ids: string[] = [];
		const included = new Set<string>();
		for (const id of classes) {
			if (annotated.has(id)) continue;
			const [note] = notesFor(tool, [id]);
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

	pi.on("tool_call", async (event, ctx) => {
		if (stopped) return;
		try {
			const call: ObservedCall = {
				...startCall(event.toolName, event.toolCallId, event.input as Record<string, unknown>),
				sessionFacts: sessionFacts(ctx),
			};
			trackPending(pending, call);
			if (mode === "enforce" && call.classes.length > 0) {
				const reason = guidanceFor(call.tool, call.classes);
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
				if (mode === "annotate" && event.isError !== true) {
					annotation = annotationFor(call.tool, call.classes, call.sessionFacts.session);
					if (annotation) effects.annotationBytes = Buffer.byteLength(annotation.text, "utf8");
				}
			}
			// Admission gates the visible effects: no notice or annotation without its record.
			if (!writeRecord(
				call,
				event.content as ContentLike[] | undefined,
				event.isError,
				(event as { details?: unknown }).details,
				event.usage,
				effects,
			)) return;
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
