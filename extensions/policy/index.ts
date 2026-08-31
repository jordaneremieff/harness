/**
 * Policy: records paired tool calls and their outcomes against declarative
 * rules.
 *
 * The slice observes and nothing else. It returns no handler result, so it
 * blocks no call and changes no input, and it emits no model-visible text, so
 * it adds no context. Rules classify a call; the record carries every class the
 * call matched, its measured duration, and its outcome.
 *
 * Duration is measured here because no event carries it: `tool_call` and
 * `tool_result` are paired by call id and stamped on arrival.
 *
 * The slice sits in the path of every tool call, so a defect in it must never
 * reach that call. Every handler body runs inside a boundary that reports the
 * first failure once and then stops recording for the rest of the session.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	finishCall,
	startCall,
	trackPending,
	type ContentLike,
	type PendingCall,
	type ResultFacts,
	type SessionFacts,
} from "./record.ts";
import { PolicyWriter, resolvePolicyDir } from "./store.ts";

/** Marker Pi writes into the system prompt when project context files are loaded. */
const PROJECT_CONTEXT_MARKER = "<project_context>";

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
}

export default function registerPolicy(pi: ExtensionAPI) {
	const pending = new Map<string, ObservedCall>();
	let stopped = false;
	let failureReported = false;
	let writer: PolicyWriter | null = null;

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

	const recordWriter = (): PolicyWriter => {
		writer ??= new PolicyWriter(resolvePolicyDir(process.env, getAgentDir()), stop);
		return writer;
	};

	const complete = (
		callId: string,
		content: ContentLike[] | undefined,
		isError: boolean | undefined,
		details: unknown,
		usage: unknown,
	): void => {
		const call = pending.get(callId);
		if (!call) return;
		pending.delete(callId);
		const result: ResultFacts = {
			content,
			isError,
			truncated: readTruncated(details),
			tokens: readTokens(usage),
		};
		recordWriter().enqueue(finishCall(call, result, call.sessionFacts));
	};

	pi.on("tool_call", async (event, ctx) => {
		if (stopped) return;
		try {
			const call: ObservedCall = {
				...startCall(event.toolName, event.toolCallId, event.input as Record<string, unknown>),
				sessionFacts: sessionFacts(ctx),
			};
			trackPending(pending, call);
		} catch (error) {
			stop(error);
		}
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (stopped) return;
		try {
			complete(
				event.toolCallId,
				event.content as ContentLike[] | undefined,
				event.isError,
				(event as { details?: unknown }).details,
				event.usage,
			);
		} catch (error) {
			stop(error);
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (stopped) return;
		try {
			const outcome =
				event.result && typeof event.result === "object"
					? (event.result as { content?: ContentLike[]; details?: unknown; usage?: unknown })
					: {};
			complete(event.toolCallId, outcome.content, event.isError, outcome.details, outcome.usage);
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
