/**
 * Policy: records what every tool call did and what it cost, against
 * declarative rules.
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
import { appendRecord, resolvePolicyDir } from "./store.ts";

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

export default function registerPolicy(pi: ExtensionAPI) {
	const pending = new Map<string, PendingCall>();
	let facts: SessionFacts | null = null;
	let stopped = false;

	/** Session facts are read once: the system prompt is rebuilt on demand. */
	const sessionFacts = (ctx: ExtensionContext): SessionFacts => {
		if (facts) return facts;
		facts = {
			session: ctx.sessionManager.getSessionId(),
			mode: ctx.mode,
			cwd: ctx.cwd,
			projectContext: ctx.getSystemPrompt().includes(PROJECT_CONTEXT_MARKER),
		};
		return facts;
	};

	const stop = (error: unknown): void => {
		if (stopped) return;
		stopped = true;
		pending.clear();
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(`[policy] recording stopped for this session: ${reason}`);
	};

	pi.on("tool_call", async (event, ctx) => {
		if (stopped) return;
		try {
			sessionFacts(ctx);
			trackPending(
				pending,
				startCall(event.toolName, event.toolCallId, event.input as Record<string, unknown>),
			);
		} catch (error) {
			stop(error);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (stopped) return;
		try {
			const call = pending.get(event.toolCallId);
			if (!call) return;
			pending.delete(event.toolCallId);
			const result: ResultFacts = {
				content: event.content as ContentLike[] | undefined,
				isError: event.isError,
				truncated: readTruncated((event as { details?: unknown }).details),
				tokens: readTokens(event.usage),
			};
			const record = finishCall(call, result, sessionFacts(ctx));
			const failure = await appendRecord(resolvePolicyDir(process.env, getAgentDir()), record);
			if (failure) stop(failure);
		} catch (error) {
			stop(error);
		}
	});

	pi.on("session_shutdown", async () => {
		pending.clear();
	});
}
