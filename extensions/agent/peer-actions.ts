/**
 * Local peer-window commands and placement rules. A slash input that names no
 * local command is not executed here: it keeps its text and follows the native
 * handoff path, so Pi owns completion, expansion, and submission.
 */
import type { AgentConversationEntry } from "./dashboard-types.ts";
import type { PeerSlot, PeerWindowState } from "./peer-contract.ts";
import { peerKey } from "./peer-contract.ts";

export interface LocalCommand {
	name: string;
	args: string[];
}

/** Commands the peer composer handles itself. Any other slash text leaves for native Pi. */
/**
 * Commands the peer composer handles itself. Every name is distinct from Pi's
 * own slash commands, so a native command name always follows the handoff path.
 */
const LOCAL_COMMANDS = new Set(["all", "view", "focus", "expand", "restore", "close", "pi", "continue", "scroll", "mode", "repair", "help", "refresh", "tasks", "steer", "send", "followup", "auto"]);

export function parseLocalCommand(text: string): LocalCommand | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const [head, ...args] = trimmed.slice(1).split(/\s+/);
	const name = head?.toLowerCase() ?? "";
	if (!LOCAL_COMMANDS.has(name)) return undefined;
	return { name, args };
}

export type SubmitPurpose =
	| { kind: "empty" }
	| { kind: "local"; command: LocalCommand }
	| { kind: "plain"; text: string }
	| { kind: "handoff"; text: string };

/** Route one composer submit. Only a known local command stays in the window. */
export function classifySubmit(text: string): SubmitPurpose {
	const trimmed = text.trim();
	if (trimmed === "") return { kind: "empty" };
	const command = parseLocalCommand(trimmed);
	if (command) return { kind: "local", command };
	if (trimmed.startsWith("/")) return { kind: "handoff", text };
	return { kind: "plain", text };
}

function textOf(entry: AgentConversationEntry): string {
	const parts: string[] = [];
	for (const message of entry.model ?? []) {
		const content = message.content;
		if (typeof content === "string") parts.push(content);
		else for (const part of content) if (part.type === "text") parts.push(part.text);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

export interface EntryChoice {
	value: string;
	label: string;
	description: string;
}

/**
 * Committed decisions that can carry a fork or repair. Live partial IDs and
 * blocks without visible text are absent by construction; the caller passes
 * only committed blocks.
 */
export function committedEntryChoices(entries: readonly AgentConversationEntry[], limit = 40): EntryChoice[] {
	const choices: EntryChoice[] = [];
	for (let index = entries.length - 1; index >= 0 && choices.length < limit; index--) {
		const entry = entries[index];
		if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
		const text = textOf(entry);
		if (text === "") continue;
		const role = entry.kind === "pi.user" ? "You" : "Agent";
		const preview = text.length > 60 ? `${text.slice(0, 57)}…` : text;
		choices.push({ value: entry.id, label: `${role}: ${preview}`, description: `entry ${entry.id}` });
	}
	return choices;
}

/** First visible text of one entry, for command notices. */
export function entryPreview(entry: AgentConversationEntry, limit = 48): string {
	const text = textOf(entry);
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function slotOf(state: PeerWindowState, key: string): "left" | "right" | undefined {
	if (state.left && peerKey(state.left) === key) return "left";
	if (state.right && peerKey(state.right) === key) return "right";
	return undefined;
}

export function slotValue(state: PeerWindowState, side: "left" | "right"): PeerSlot {
	return side === "left" ? state.left : state.right;
}

export function setSlot(state: PeerWindowState, side: "left" | "right", value: PeerSlot): void {
	if (side === "left") state.left = value;
	else state.right = value;
}

export function otherSide(side: "left" | "right"): "left" | "right" {
	return side === "left" ? "right" : "left";
}

/**
 * Place one peer beside a source side without moving the source. A reuse of an
 * already visible peer focuses its existing pane instead of cloning it.
 */
export function placeBeside(state: PeerWindowState, source: "left" | "right", value: Exclude<PeerSlot, undefined>): "left" | "right" {
	const key = peerKey(value);
	const visible = slotOf(state, key);
	if (visible) return visible;
	const opposite = otherSide(source);
	setSlot(state, opposite, value);
	return opposite;
}

/** The side that receives a newly created peer: an empty side, else the non-focused side. */
export function placementForNew(state: PeerWindowState): "left" | "right" {
	if (!state.left) return "left";
	if (!state.right) return "right";
	return otherSide(state.focus);
}
