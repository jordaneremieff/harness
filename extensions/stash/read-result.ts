/** The bounded artifact and its revision token on both tool entrypoints. */
import type { readStash } from "./store.ts";
import { boundedOutput, sanitizeTerminalText } from "./text.ts";

export function readStashResult(result: Extract<Awaited<ReturnType<typeof readStash>>, { ok: true }>) {
	const sanitized = sanitizeTerminalText(result.content);
	const bounded = boundedOutput(
		`${sanitized.text}\n\n[Artifact digest: ${result.digest}]`,
		`Digest: ${result.digest}. Full artifact: ${result.path}`,
	);
	return {
		content: [{ type: "text" as const, text: bounded.text }],
		details: {
			id: result.id,
			path: result.path,
			digest: result.digest,
			truncated: bounded.truncated,
			controlsEscaped: sanitized.changed,
			totalBytes: bounded.totalBytes,
			totalLines: bounded.totalLines,
		},
	};
}
