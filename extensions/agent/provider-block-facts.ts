import { str, int, bool, lit, union, arr, obj, type Static } from "@earendil-works/pi-schema";
import { ResultReferenceSchema } from "./result-schema.ts";

export const PROVIDER_BLOCK_ERROR = "Agent host: quota exceeded; explicit recovery required.";
export const STALE_PROVIDER_ERROR = "Agent host: request superseded by explicit model configuration.";
export const ProviderBlockFactSchema = obj({
	blockId: str({ minLength: 1, maxLength: 128 }),
	conversationId: int({ minimum: 1 }), providerSessionId: str({ minLength: 1, maxLength: 256 }),
	epoch: int({ minimum: 0 }),
	model: obj({ provider: str({ maxLength: 256 }), modelId: str({ maxLength: 256 }) }),
	error: str({ maxLength: 4096 }), errorRedacted: bool(), errorTruncated: bool(),
	source: union([lit("provider"), lit("host-block")]), timestamp: int({ minimum: 0 }),
	originalResults: arr(ResultReferenceSchema, { maxItems: 16 }), omittedOriginalResults: int({ minimum: 0 }),
});
export type ProviderBlockFact = Static<typeof ProviderBlockFactSchema>;

export function providerBlockText(block: ProviderBlockFact): string {
	return `${PROVIDER_BLOCK_ERROR} Provider evidence: ${block.error}${block.errorRedacted ? " [credential redacted]" : ""}${block.errorTruncated ? " [truncated]" : ""} Block ${block.blockId}. Use explicit validated model configuration before a new recovery send.`;
}
