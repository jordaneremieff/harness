import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

/**
 * Editor placement for prompt templates and skills chosen in the Commands view. The editor is
 * Pi's native editor; these helpers only call its public text methods.
 */

export interface DraftEditor {
	getEditorText(): string;
	setEditorText(text: string): void;
	pasteToEditor(text: string): void;
}

export type DraftPlacement = "insert" | "replace";

/**
 * Prepare a prompt template or skill invocation as editor text. An empty
 * editor simply receives the line. Otherwise `insert` pastes at the cursor
 * through Pi's paste handling, and `replace` returns the replaced draft so the
 * caller can offer recovery.
 */
export function prepareDraft(editor: DraftEditor, line: string, placement: DraftPlacement): { replaced?: string } {
	const existing = editor.getEditorText();
	if (existing.length === 0) {
		editor.setEditorText(line);
		return {};
	}
	if (placement === "insert") {
		editor.pasteToEditor(line);
		return {};
	}
	editor.setEditorText(line);
	return { replaced: existing };
}

/** Put a replaced draft back: whole when the editor is empty, else at the cursor. */
export function restoreDraft(editor: DraftEditor, text: string): void {
	if (editor.getEditorText().length === 0) editor.setEditorText(text);
	else editor.pasteToEditor(text);
}

/** Exact registration identity: invocation name, kind, and every provenance field. */
export function commandIdentity(command: SlashCommandInfo): string {
	const info = command.sourceInfo;
	return JSON.stringify([
		command.name,
		command.source,
		info.path,
		info.source,
		info.scope,
		info.origin,
		info.baseDir ?? null,
		info.changelogPath ?? null,
	]);
}

export function commandLine(name: string, args: string): string {
	const trimmed = args.trim();
	return trimmed ? `/${name} ${trimmed}` : `/${name}`;
}

export type DispatchOutcome = { kind: "sent"; line: string } | { kind: "changed" } | { kind: "not-extension" };

/** Send an extension command only if its exact registration is still current. */
export function dispatchCommand(
	host: Pick<ExtensionAPI, "getCommands" | "sendUserMessage">,
	command: SlashCommandInfo,
	args: string,
): DispatchOutcome {
	if (command.source !== "extension") return { kind: "not-extension" };
	const identity = commandIdentity(command);
	const current = host.getCommands().find((candidate) => commandIdentity(candidate) === identity);
	if (!current) return { kind: "changed" };
	const line = commandLine(current.name, args);
	host.sendUserMessage(line, { expandPromptTemplates: true });
	return { kind: "sent", line };
}
