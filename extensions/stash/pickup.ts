import { parseFrontmatter } from "./format.ts";
import { sanitizeTerminalText } from "./text.ts";

interface PickupContext {
	currentCwd?: string;
	/**
	 * Timestamp recorded when pickup found the artifact already active. The
	 * message then disowns the earlier session's claim instead of leaving the
	 * fresh session to reconcile a phantom predecessor.
	 */
	activatedAt?: string;
	/** Operator note added at pickup time; newer than the artifact and authoritative on conflict. */
	note?: string;
}

const MAX_NOTE_CHARS = 20_000;

/** Build the one-step user message emitted when an operator picks a stash. */
export function buildPickupMessage(id: string, artifact: string, context: PickupContext = {}): string {
	const safeId = sanitizeTerminalText(id).text;
	const safeArtifact = sanitizeTerminalText(artifact).text;
	const recordedProject = parseFrontmatter(artifact).meta.project;
	const currentCwd = context.currentCwd ? sanitizeTerminalText(context.currentCwd).text.replace(/\n/g, "↵") : undefined;
	const safeProject = typeof recordedProject === "string" ? sanitizeTerminalText(recordedProject).text.replace(/\n/g, "↵") : undefined;
	const rawNote = context.note?.trim();
	if (rawNote !== undefined && rawNote.length > MAX_NOTE_CHARS) {
		throw new Error(`operator note exceeds ${MAX_NOTE_CHARS} characters`);
	}
	const workspace = currentCwd
		? [
				`Current workspace (unchanged): ${currentCwd}`,
				...(safeProject ? [`Recorded stash project: ${safeProject}`] : []),
				...(safeProject && safeProject !== currentCwd
					? ["The recorded project differs from the current workspace. Verify the intended context before editing files."]
					: []),
			]
		: [];
	const ownership =
		context.activatedAt !== undefined
			? [
					`This stash was already active (activated ${sanitizeTerminalText(context.activatedAt).text}); any earlier session's claim on it is superseded. You are the current owner of this effort.`,
				]
			: [];
	const amendment =
		rawNote !== undefined && rawNote.length > 0
			? [
					"Operator amendment (added at pickup, newer than the artifact below):",
					sanitizeTerminalText(rawNote).text,
					"Where the amendment conflicts with the artifact, the amendment wins.",
				]
			: [];
	return [
		"Resume the stashed effort in the artifact below. Re-ground its claims against the current workspace, then continue from its next actions.",
		`When this effort reaches a terminal outcome, call stash_complete with id ${safeId} and a concrete outcome so the handover lifecycle is closed.`,
		...ownership,
		...workspace,
		...(amendment.length > 0 ? ["", ...amendment] : []),
		"",
		`Stash: ${safeId}`,
		"",
		"--- BEGIN STASH ARTIFACT ---",
		safeArtifact.trimEnd(),
		"--- END STASH ARTIFACT ---",
	].join("\n");
}
