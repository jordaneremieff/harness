/** The bounded artifact and its revision token on both tool entrypoints. */
import type { readStash } from "./store.ts";
import { CHECKPOINT_NOTICE, checkpointMetadata, collectionId, type StashCollection } from "./collection.ts";
import { parseFrontmatter } from "./format.ts";
import { boundedOutput, sanitizeTerminalText } from "./text.ts";

/** Read next to the digest, so the first stash_edit of an active handover carries the acknowledgement it needs. */
export const ACTIVE_EDIT_NOTE =
	"This handover is active: pass allowActive: true to stash_edit when the edit serves this effort.";

export function readStashResult(
	result: Extract<Awaited<ReturnType<typeof readStash>>, { ok: true }>,
	collection: StashCollection = "handovers",
) {
	const meta = parseFrontmatter(result.content).meta;
	const provenance = collection === "checkpoints" ? checkpointMetadata(meta) : undefined;
	const editNote = collection === "handovers" && meta.state === "active" ? ` ${ACTIVE_EDIT_NOTE}` : "";
	const label =
		collection === "checkpoints"
			? `[Checkpoint ${collectionId(result.id, collection)}]\n${CHECKPOINT_NOTICE}\nSource: ${provenance?.source ?? "unknown"}\nWorkspace: ${provenance?.workspace ?? "unknown"}\nThe artifact's stored state is not a checkpoint lifecycle.\n\n`
			: "";
	const sanitized = sanitizeTerminalText(result.content);
	const bounded = boundedOutput(
		`${label}${sanitized.text}\n\n[Artifact digest: ${result.digest}]${editNote ? `\n${editNote.trim()}` : ""}`,
		`Digest: ${result.digest}.${editNote} Full artifact: ${result.path}`,
	);
	return {
		content: [{ type: "text" as const, text: bounded.text }],
		details: {
			id: collectionId(result.id, collection),
			collection,
			provisional: collection === "checkpoints",
			...provenance,
			coverage: { complete: !bounded.truncated },
			path: result.path,
			digest: result.digest,
			truncated: bounded.truncated,
			controlsEscaped: sanitized.changed,
			totalBytes: bounded.totalBytes,
			totalLines: bounded.totalLines,
		},
	};
}
