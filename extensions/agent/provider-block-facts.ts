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
	const target = block.originalResults[0]?.sessionId;
	const dispatch = block.source === "provider" ? "This call reached the provider." : "This call did not reach the provider; the host reused a retained block.";
	const recovery = target === undefined ? "Recovery target unavailable: no retained original result identity." : `Target: ${target}. Choose an explicit provider/model under your existing authority, then call agent_configure({sessionId:${JSON.stringify(target)},model:<explicit provider/model>}). After successful configuration, send a new agent_send follow-up.`;
	return `${PROVIDER_BLOCK_ERROR} ${dispatch} Received at: ${new Date(block.timestamp).toISOString()}. Provider evidence: ${block.error}${block.errorRedacted ? " [credential redacted]" : ""}${block.errorTruncated ? " [truncated]" : ""} A provider time without a stated zone has an unspecified zone. Block ${block.blockId}. ${recovery} Replaying the original request keeps its original settled result.`;
}
