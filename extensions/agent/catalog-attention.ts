/** Optional catalog intervention facts, separate from native operation rows. */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { readProviderBlock } from "./provider-block.ts";

const closed = { additionalProperties: false } as const;
const identity = Type.String({ minLength: 1, maxLength: 512 });
const taskReason = Type.Union([Type.Literal("missing_task"), Type.Literal("task_too_old"), Type.Literal("migration_failed")]);
export const CatalogAttentionHintSchema = Type.Union([
	Type.Object({ identity, kind: Type.Literal("provider-blocked"), blockId: Type.String({ minLength: 1, maxLength: 128 }) }, closed),
	Type.Object({ identity, kind: Type.Literal("task-blocked"), taskId: Type.Integer({ minimum: 1 }), reason: taskReason }, closed),
	Type.Object({ identity, kind: Type.Literal("failed-turn") }, closed),
]);
export const CatalogAttentionHintsSchema = Type.Object({
	rows: Type.Array(CatalogAttentionHintSchema),
	/** Publication coverage only, never completeness of human-question detection. */
	coverage: Type.Object({ complete: Type.Boolean(), omitted: Type.Integer({ minimum: 0 }) }, closed),
}, closed);
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
 * failed turn needs a new input. Automatic retries and compaction diagnostics
 * do not establish a need for intervention. Absence remains unknown even when
 * publication coverage is complete.
 */
export async function projectCatalogAttention(
	harness: Harness,
	sources: readonly CatalogAttentionSource[],
	context: Context = BACKGROUND_CONTEXT,
): Promise<CatalogAttentionHints> {
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
