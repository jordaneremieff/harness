import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";

export const HANDLE_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
export function handleSlug(value: unknown): string {
	if (typeof value !== "string" || value.length > 64 || !new RegExp(HANDLE_PATTERN, "u").test(value)) throw new Error("handle requires a lowercase concern slug of 1..64 letters, digits, and single hyphens");
	return value;
}
/** The handle namespace is local to the selected catalog; creator and model do not change its address. */
export function handleStorageId(handle: string, catalogRoot: string): string {
	const hex = createHash("sha256").update(`pi.agent.handle\u0000${realpathSync(catalogRoot)}\u0000${handleSlug(handle)}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export function canonicalIdentity(storageId: string, conversationId: ConversationId): string {
	return conversationId === ROOT_CONVERSATION_ID ? storageId : `${storageId}:${conversationId}`;
}
/** Explicit handles never fall through to fuzzy names or primary endpoints. */
export function targetIdentity(selector: string, catalogRoot?: string): string {
	if (!selector.startsWith("@")) return selector;
	if (catalogRoot === undefined) throw new Error("Handle resolution requires the host catalog namespace");
	return handleStorageId(selector.slice(1), catalogRoot);
}
