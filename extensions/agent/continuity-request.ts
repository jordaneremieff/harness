/** Native request-boundary insertion of the frozen continuity note for the current context head. */
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, GenerationHooks } from "@earendil-works/pi-durable";
import type { FrozenContinuity } from "./continuity-mirror.ts";
import { projectNativeContinuity } from "./continuity-projection.ts";

export interface ContinuitySource {
	/** Settles what a new context head still has to read; resolves without storage access when nothing is owed. */
	prepare?(conversationId: ConversationId, context: Context): Promise<void>;
	current(conversationId: ConversationId): FrozenContinuity | undefined;
}
export interface ContinuityMismatch {
	readonly conversationId: ConversationId;
	readonly headId: number;
	readonly mismatch: "head-message" | "head-shape";
}

/**
 * The first request of a context head waits for the source's one read of that head. After it the
 * hook reads memory and computes a pure projection: no storage access, clock, or await lies between
 * the head lookup and the insertion. Durable reports a throw from a hook and still sends the
 * request, so a mismatch inserts nothing and goes to the host diagnostic instead of throwing.
 */
export function continuityRequestHooks(source: () => ContinuitySource | undefined, mismatch: (found: ContinuityMismatch) => void): Partial<GenerationHooks> {
	return {
		async beforeRequest(request, api, context) {
			const held = source();
			await held?.prepare?.(api.conversationId, context);
			const frozen = held?.current(api.conversationId);
			if (frozen === undefined) return undefined;
			const projected = projectNativeContinuity(request.messages, frozen.head, frozen.text);
			if (projected.mismatch === "head-message" || projected.mismatch === "head-shape") {
				mismatch({ conversationId: api.conversationId, headId: frozen.head.id, mismatch: projected.mismatch });
				return undefined;
			}
			return { messages: projected.messages };
		},
	};
}
