/** No conversation holds a wait for named results; these readers report none. */
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, SubmissionId, Tx } from "@earendil-works/pi-durable";
import type { AwaitFact, OwnAwaitFact } from "./await-facts.ts";

export { producerRetryFact } from "./await-facts.ts";

type AwaitReader = Tx | { readonly harness: Harness; readonly context: Context };

export async function ownAwaitFact(_tx: Tx, _conversationId: ConversationId): Promise<OwnAwaitFact | undefined> {
	return undefined;
}

export async function readAwaitFact(_tx: AwaitReader, _storageId: string, _conversationId: ConversationId, _heldInput?: SubmissionId): Promise<AwaitFact | undefined> {
	return undefined;
}

export async function releaseAwait(_tx: Tx, _storageId: string, _conversationId: ConversationId, _expectedRunId: number): Promise<{ released: boolean; awaiting?: AwaitFact }> {
	return { released: false };
}
