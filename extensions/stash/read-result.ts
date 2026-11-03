/** The bounded artifact and its revision token on both tool entrypoints. */
import type { readStash } from "./store.ts";
import { CHECKPOINT_NOTICE, checkpointMetadata, collectionId, type StashCollection } from "./collection.ts";
import { parseFrontmatter } from "./format.ts";
import { boundedOutput, sanitizeTerminalText } from "./text.ts";

export function readStashResult(result: Extract<Awaited<ReturnType<typeof readStash>>, { ok: true }>, collection: StashCollection = "handovers") {
	const provenance = collection === "checkpoints" ? checkpointMetadata(parseFrontmatter(result.content).meta) : undefined;
	const label = collection === "checkpoints" ? `[Checkpoint ${collectionId(result.id, collection)}]\n${CHECKPOINT_NOTICE}\nSource: ${provenance?.source ?? "unknown"}\nWorkspace: ${provenance?.workspace ?? "unknown"}\nThe artifact's stored state is not a checkpoint lifecycle.\n\n` : "";
	const sanitized = sanitizeTerminalText(result.content);
	const bounded = boundedOutput(
		`${label}${sanitized.text}\n\n[Artifact digest: ${result.digest}]`,
		`Digest: ${result.digest}. Full artifact: ${result.path}`,
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
