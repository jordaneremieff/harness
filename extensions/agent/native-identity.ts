import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";

export function canonicalIdentity(storageId: string, conversationId: ConversationId): string {
	return conversationId === ROOT_CONVERSATION_ID ? storageId : `${storageId}:${conversationId}`;
}
