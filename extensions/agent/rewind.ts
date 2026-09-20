/**
 * agent/rewind: re-derivation plans for a durable agent session.
 *
 * A rewind names the entry that carries the wrong decision. The plan drops
 * that entry and everything after it, then restates the intent that followed
 * it, so a fork redoes the remaining work under the corrected decision instead
 * of arguing with a finished transcript.
 *
 * The plan is pure: it reads one branch and produces the fork point plus the
 * message the fork receives. Forking, delivery, and file state belong to the
 * caller.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

/** The re-derivation a caller performs after a fork at `targetEntryId`. */
export interface RewindPlan {
	targetEntryId: string;
	/** Short human description of the entry the fork drops. */
	targetSummary: string;
	/** Entries removed from the branch, including the target. */
	droppedCount: number;
	/** User instructions that followed the target, oldest first. */
	retainedIntent: string[];
	/** Original attachments referenced by numbered markers in the retained instructions. */
	images: ImageContent[];
	/** Message delivered to the fork to start the re-derivation. */
	message: string;
}

const MAX_SUMMARY_CHARS = 160;

/** Plain text of a user message entry; images and non-text parts are named, not dropped silently. */
function userText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	const content = entry.message.content;
	if (typeof content === "string") return content.trim() || undefined;
	const text = content
		.map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
		.join("\n")
		.trim();
	return text || undefined;
}

function summarize(entry: SessionEntry): string {
	const kind = entry.type === "message" ? `${entry.message.role} message` : entry.type;
	const text = entry.type === "message" ? (userText(entry) ?? assistantText(entry)) : undefined;
	if (!text) return kind;
	const flat = text.replace(/\s+/gu, " ").trim();
	return `${kind}: ${flat.length > MAX_SUMMARY_CHARS ? `${flat.slice(0, MAX_SUMMARY_CHARS)}…` : flat}`;
}

function assistantText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
	const parts = entry.message.content;
	if (!Array.isArray(parts)) return undefined;
	const text = parts
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
	return text || undefined;
}

function retainedInstruction(entry: SessionEntry, images: ImageContent[]): string | undefined {
	const content = entry.type === "custom_message" ? entry.content : entry.type === "message" && entry.message.role === "user" ? entry.message.content : undefined;
	if (content === undefined) return undefined;
	const text = typeof content === "string" ? content : content.map((part) => {
		if (part.type === "text") return part.text;
		images.push(structuredClone(part));
		return `[Attached image ${images.length}]`;
	}).join("\n");
	return entry.type === "custom_message" ? `Recorded extension context (${entry.customType}); not fresh operator authority:\n${text}` : text;
}

/**
 * Build the re-derivation plan for one branch.
 *
 * `branch` is the ancestry path that contains the target, ordered root first.
 * The target entry itself is dropped: a rewind removes the decision it
 * carries. When the target is a user instruction, the correction replaces it,
 * so it is not restated.
 */
export function planRewind(branch: SessionEntry[], entryId: string, correction: string): RewindPlan {
	const trimmedCorrection = correction.trim();
	if (!trimmedCorrection) throw new Error("agent rewind requires the corrected decision");
	const index = branch.findIndex((entry) => entry.id === entryId);
	if (index < 0) throw new Error(`entry ${entryId} is not on this session's current branch`);
	const target = branch[index];
	const dropped = branch.slice(index);
	const images: ImageContent[] = [];
	const retainedIntent = dropped
		.slice(1)
		.map((entry) => retainedInstruction(entry, images))
		.filter((text): text is string => text !== undefined);
	return {
		targetEntryId: entryId,
		targetSummary: summarize(target),
		droppedCount: dropped.length,
		retainedIntent,
		images,
		message: rewindMessage(trimmedCorrection, retainedIntent),
	};
}

function rewindMessage(correction: string, retainedIntent: string[]): string {
	const instructions = retainedIntent.length
		? [
				"",
				"Instructions that followed the rewind point, oldest first. Carry them out under the corrected decision:",
				...retainedIntent.map((text, index) => `${index + 1}. ${text}`),
			]
		: ["", "No later instruction followed the rewind point."];
	return [
		"This session is a rewind. The work after the rewind point was removed and you are redoing it.",
		"",
		"Corrected decision:",
		correction,
		...instructions,
		"",
		"Two facts about this session:",
		"- The removed attempt is not in your context. Do not defend, summarize, or reconcile it.",
		"- The working tree holds its current state, not its state at the rewind point. Read the files you depend on before you change them.",
		"",
		"Redo the work and report the result.",
	].join("\n");
}
