import { parseFrontmatter } from "./format.ts";
import { sanitizeTerminalText } from "./text.ts";

interface PickupContext {
	currentCwd?: string;
}

/** Build the one-step user message emitted when an operator picks a stash. */
export function buildPickupMessage(id: string, artifact: string, context: PickupContext = {}): string {
	const safeId = sanitizeTerminalText(id).text;
	const safeArtifact = sanitizeTerminalText(artifact).text;
	const recordedProject = parseFrontmatter(artifact).meta.project;
	const currentCwd = context.currentCwd ? sanitizeTerminalText(context.currentCwd).text.replace(/\n/g, "↵") : undefined;
	const safeProject = typeof recordedProject === "string" ? sanitizeTerminalText(recordedProject).text.replace(/\n/g, "↵") : undefined;
	const workspace = currentCwd
		? [
				`Current workspace (unchanged): ${currentCwd}`,
				...(safeProject ? [`Recorded stash project: ${safeProject}`] : []),
				...(safeProject && safeProject !== currentCwd
					? ["The recorded project differs from the current workspace. Verify the intended context before editing files."]
					: []),
			]
		: [];
	return [
		"Resume the stashed effort in the artifact below. Re-ground its claims against the current workspace, then continue from its next actions.",
		`When this effort reaches a terminal outcome, call stash_complete with id ${safeId} and a concrete outcome so the handover lifecycle is closed.`,
		...workspace,
		"",
		`Stash: ${safeId}`,
		"",
		"--- BEGIN STASH ARTIFACT ---",
		safeArtifact.trimEnd(),
		"--- END STASH ARTIFACT ---",
	].join("\n");
}
