/** Optional catalog intervention facts, separate from native operation rows. */
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { arr, bool, compile, int, lit, obj, oneOf, str, union, type Static } from "@earendil-works/pi-schema";

let providerBlockPromise: Promise<typeof import("./provider-block.ts")> | undefined;
function loadProviderBlock(): Promise<typeof import("./provider-block.ts")> {
	providerBlockPromise ??= import("./provider-block.ts");
	return providerBlockPromise;
}

const identity = str({ minLength: 1, maxLength: 512 });
/** Why no registered definition can take a live task; restart-limited work ends instead of blocking. */
const taskReason = oneOf(["missing_task", "task_too_old", "migration_failed"]);
export const CatalogAttentionHintSchema = union([
	obj({ identity, kind: lit("provider-blocked"), blockId: str({ minLength: 1, maxLength: 128 }) }),
	obj({ identity, kind: lit("task-blocked"), taskId: int({ minimum: 1 }), reason: taskReason }),
	obj({ identity, kind: lit("failed-turn") }),
]);
export const CatalogAttentionHintsSchema = obj({
	rows: arr(CatalogAttentionHintSchema),
	/** Publication coverage only, never completeness of human-question detection. */
	coverage: obj({ complete: bool(), omitted: int({ minimum: 0 }) }),
});
const attentionHints = compile(CatalogAttentionHintsSchema);
/** Whether `value` is a complete attention projection. */
export const isCatalogAttentionHints = attentionHints.check;
export type CatalogAttentionHint = Static<typeof CatalogAttentionHintSchema>;
export type CatalogAttentionHints = Static<typeof CatalogAttentionHintsSchema>;

/** The native summary state supplies turn failure, never its display text. */
export interface CatalogAttentionSource {
	readonly identity: string;
	readonly conversationId: ConversationId;
	readonly state: string;
}

/**
 * Recompute intervention hints from owned state. A provider block needs explicit
 * recovery. A blocked task needs host repair, not an answer to a question. A
 * failed turn needs a new input, including a run that ended at the native
 * restart limit: that outcome is terminal and is never resubmitted here.
 * Automatic retries and compaction diagnostics
 * do not establish a need for intervention. Absence remains unknown even when
 * publication coverage is complete.
 */
export async function projectCatalogAttention(
	harness: Harness,
	sources: readonly CatalogAttentionSource[],
	context: Context = BACKGROUND_CONTEXT,
): Promise<CatalogAttentionHints> {
	const { readProviderBlock } = await loadProviderBlock();
	const inspection = await harness.inspect(context);
	const blocks = await harness.commit(async (tx) => {
		const result = new Map<ConversationId, string>();
		for (const source of sources) {
			const block = await readProviderBlock(tx, source.conversationId);
			if (block !== undefined) result.set(source.conversationId, block.blockId);
		}
		return result;
	}, context);
	const rows: CatalogAttentionHint[] = [];
	for (const source of sources) {
		const blockId = blocks.get(source.conversationId);
		if (blockId !== undefined) {
			rows.push({ identity: source.identity, kind: "provider-blocked", blockId });
			continue;
		}
		const blocked = inspection.tasks.filter((task) => task.record.conversationId === source.conversationId && task.state.kind === "blocked")
			.sort((left, right) => left.record.id - right.record.id)[0];
		if (blocked?.state.kind === "blocked") {
			rows.push({ identity: source.identity, kind: "task-blocked", taskId: blocked.record.id, reason: blocked.state.reason });
			continue;
		}
		if (source.state === "failed") rows.push({ identity: source.identity, kind: "failed-turn" });
	}
	return { rows, coverage: { complete: true, omitted: 0 } };
}
