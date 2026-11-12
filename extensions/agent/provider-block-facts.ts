import { str, int, bool, lit, union, arr, obj, type Static } from "@earendil-works/pi-schema";
import { ResultReferenceSchema } from "./result-schema.ts";
import { safeProviderError } from "./primary-observation.ts";

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

/** OpenAI Codex's explicit content-refusal wording; other wording stays unclassified. */
const CONTENT_REFUSAL_WORDINGS = ["This content was flagged for possible cybersecurity risk"];
export function isProviderContentRefusal(error: string): boolean {
	return CONTENT_REFUSAL_WORDINGS.some((wording) => error.includes(wording));
}

/** Present retained model failure detail without changing the native settlement. */
export function modelFailureText(reason: string, detail: unknown, block?: ProviderBlockFact): string {
	if (block !== undefined || reason !== "model_error" || typeof detail !== "string" || detail.trim() === "") return reason;
	const refusal = isProviderContentRefusal(safeProviderError(detail).text);
	const prefix = `${refusal ? "content_refusal" : "model_error"}: `;
	const recovery = refusal ? " The provider refused this content. Repeating the same task on this provider fails. Choose another explicit provider/model under your existing authority, or change the form of the task. No automatic substitution or host retry." : "";
	// Result communication accepts at most 1,024 UTF-8 bytes for its reason.
	const evidence = safeProviderError(detail, 1024 - Buffer.byteLength(`${prefix} [credential redacted] [truncated]${recovery}`));
	return `${prefix}${evidence.text}${evidence.redacted ? " [credential redacted]" : ""}${evidence.truncated ? " [truncated]" : ""}${recovery}`;
}

function receivedText(block: ProviderBlockFact): string {
	const date = new Date(block.timestamp);
	return Number.isFinite(date.getTime()) ? `Received at: ${date.toISOString()}.` : "Receive time unavailable.";
}

export function providerBlockSummary(block: ProviderBlockFact): string[] {
	return [
		`${block.source === "provider" ? "Provider call refused." : "Retained host refusal."} ${receivedText(block)}`,
		block.originalResults[0] === undefined ? "Recovery target unavailable: no retained original result identity."
			: "Recovery: explicit model with agent_configure, then a new agent_send.",
	];
}

export function providerBlockText(block: ProviderBlockFact): string {
	const target = block.originalResults[0]?.sessionId;
	const received = receivedText(block);
	const dispatch = block.source === "provider" ? "This call reached the provider." : "This call did not reach the provider; the host reused a retained block.";
	const recovery = target === undefined ? "Recovery target unavailable: no retained original result identity." : `Target: ${target}. Choose an explicit provider/model under your existing authority, then call agent_configure({sessionId:${JSON.stringify(target)},model:<explicit provider/model>}). After successful configuration, send a new agent_send follow-up.`;
	return `${PROVIDER_BLOCK_ERROR} ${dispatch} ${received} Provider evidence: ${block.error}${block.errorRedacted ? " [credential redacted]" : ""}${block.errorTruncated ? " [truncated]" : ""} A provider time without a stated zone has an unspecified zone. Block ${block.blockId}. ${recovery} Replaying the original request keeps its original settled result.`;
}
