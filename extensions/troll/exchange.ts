import { type ReplyFields, TEXT_LIMIT } from "./endpoint.ts";

export const REPLY_TYPE = "troll-reply";
export const SUBMIT_TOOL = "troll_submit";
/** Custom entry that marks a session as a troll, with its origin; it keeps the role when the session resumes. */
export const ROLE_TYPE = "troll-role";
/** Custom entry written before a submission goes out, so a restart knows about a round still in flight. */
export const SENT_TYPE = "troll-sent";

/** The fields of a session entry that this exchange reads. */
export interface BranchEntry {
	type: string;
	id: string;
	customType?: string;
	data?: unknown;
	details?: unknown;
	message?: { role?: string; content?: unknown; toolName?: string; details?: unknown };
}
/** Notices that the troll writes itself when an answer cannot arrive. */
export type NoticeOutcome = "lost" | "restarted";
export type ExchangeOutcome = ReplyFields["outcome"] | NoticeOutcome;
/** The tool outcomes that may have put a message in the target session. */
const DELIVERED = ["submitted", "waiting", "uncertain"];

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const role = (entry: BranchEntry, name: string) => entry.type === "message" && entry.message?.role === name;

export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => object(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => (block as { text: string }).text)
		.join("\n");
}

/** Cuts text to a UTF-8 byte limit without splitting a character. */
export function clip(text: string, limit = TEXT_LIMIT): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text) <= limit) return { text, truncated: false };
	let size = 0;
	let end = 0;
	for (const char of text) {
		size += Buffer.byteLength(char);
		if (size > limit) break;
		end += char.length;
	}
	return { text: text.slice(0, end), truncated: true };
}

/**
 * The answer to a submitted message: the last public assistant text after the first user entry with the submitted
 * text on the branch that grew from the leaf recorded at submission, and the other user entries after it.
 */
export function replyFromBranch(
	branch: readonly BranchEntry[],
	submitted: { text: string; leaf: string | null },
	aborted: boolean,
): ReplyFields {
	const start = submitted.leaf === null ? 0 : branch.findIndex((entry) => entry.id === submitted.leaf) + 1;
	const grown = start > 0 || submitted.leaf === null ? branch.slice(start) : [];
	const index = grown.findIndex(
		(entry) => role(entry, "user") && messageText(entry.message?.content) === submitted.text,
	);
	if (index < 0) return { outcome: "not-run", text: "", truncated: false, otherInputs: 0 };
	const after = grown.slice(index + 1);
	let answer = "";
	for (const entry of after) {
		if (!role(entry, "assistant")) continue;
		const text = messageText(entry.message?.content);
		if (text.trim()) answer = text;
	}
	return {
		outcome: aborted ? "aborted" : answer.trim() ? "answered" : "unanswered",
		...clip(answer),
		otherInputs: after.filter((entry) => role(entry, "user")).length,
	};
}

function submitted(entry: BranchEntry): Record<string, unknown> | undefined {
	if (!role(entry, "toolResult") || entry.message?.toolName !== SUBMIT_TOOL) return undefined;
	const details = entry.message.details;
	return object(details) && DELIVERED.includes(details.outcome as string) ? details : undefined;
}
function replyDetails(entry: BranchEntry): Record<string, unknown> | undefined {
	return entry.type === "custom_message" && entry.customType === REPLY_TYPE && object(entry.details)
		? entry.details
		: undefined;
}

/** Rounds since the operator's latest message here, and the reason that stops automatic rounds. */
export function roundState(branch: readonly BranchEntry[]): { rounds: number; halt?: string } {
	let latest = -1;
	branch.forEach((entry, index) => {
		if (role(entry, "user")) latest = index;
	});
	let rounds = 0;
	let halt: string | undefined;
	for (const entry of branch.slice(latest + 1)) {
		if (submitted(entry)) rounds++;
		const reply = replyDetails(entry);
		if (!reply) continue;
		halt =
			reply.outcome !== "answered"
				? "The last round did not end with an answer."
				: typeof reply.otherInputs === "number" && reply.otherInputs > 0
					? "The operator added input in the target session during its run."
					: undefined;
	}
	return { rounds, ...(halt ? { halt } : {}) };
}

function sessionRound(value: unknown): { session: string; round: number } | undefined {
	return object(value) && typeof value.session === "string" && typeof value.round === "number"
		? { session: value.session, round: value.round }
		: undefined;
}

/** How one branch entry changes the set of rounds that wait for an answer. */
function waitingChange(entry: BranchEntry): { key: string; round?: { session: string; round: number } } | undefined {
	const marker = entry.type === "custom" && entry.customType === SENT_TYPE ? sessionRound(entry.data) : undefined;
	if (marker) return { key: `${marker.session}#${marker.round}`, round: marker };
	const result =
		role(entry, "toolResult") && entry.message?.toolName === SUBMIT_TOOL ? entry.message.details : undefined;
	const sent = sessionRound(result);
	if (sent && object(result)) {
		const delivered = result.outcome === "submitted" || result.outcome === "waiting";
		return { key: `${sent.session}#${sent.round}`, ...(delivered ? { round: sent } : {}) };
	}
	const reply = replyDetails(entry);
	return reply ? { key: `${String(reply.from)}#${String(reply.round)}` } : undefined;
}

/** Rounds that went out, or may have gone out, and whose answer or notice has not arrived, by target and round. */
export function waitingRounds(branch: readonly BranchEntry[]): Array<{ session: string; round: number }> {
	const waiting = new Map<string, { session: string; round: number }>();
	for (const entry of branch) {
		const change = waitingChange(entry);
		if (!change) continue;
		if (change.round) waiting.set(change.key, change.round);
		else waiting.delete(change.key);
	}
	return [...waiting.values()];
}

/** The origin that the latest role entry on the branch records. */
export function storedRole(branch: readonly BranchEntry[]): { id: string; pid?: number } | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== ROLE_TYPE || !object(entry.data)) continue;
		const { id, pid } = entry.data;
		if (typeof id !== "string" || !id) return undefined;
		return { id, ...(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}) };
	}
	return undefined;
}

const OUTCOME_LINES: Record<ExchangeOutcome, string> = {
	answered: "Its run ended with this answer.",
	aborted: "Its run was interrupted before it ended.",
	unanswered: "Its run ended without a public answer to the troll's message.",
	"not-run": "The troll's message is not in the session's history after its run, so the session did not run it.",
	"not-started":
		"The session did not start a run for the troll's message within a minute. It may still run it, so read its history before you submit again.",
	closed: "The target session closed or restarted before its run ended.",
	lost: "The connection to the target closed before its run ended, so its answer did not arrive. The target process may have ended.",
	restarted: "This troll session restarted while it waited, so the answer will not arrive here.",
};

/** The text that brings an answer, or the notice that none arrives, into the troll session. */
export function replyContent(
	from: string,
	round: number,
	reply: ReplyFields | { outcome: NoticeOutcome; text: ""; truncated: false; otherInputs: 0 },
): string {
	const lines = [`Session ${from}, troll round ${round}.`, OUTCOME_LINES[reply.outcome]];
	if (reply.outcome !== "answered" && reply.outcome !== "unanswered")
		lines.push("Read the target's history before you decide anything, and report to the operator.");
	if (reply.otherInputs > 0)
		lines.push(
			`The operator added ${reply.otherInputs} other message${reply.otherInputs === 1 ? "" : "s"} in that session during the run, so the answer may address them too.`,
		);
	if (reply.truncated) lines.push("The answer is cut at 64 KB; read the rest in that session's history.");
	return reply.text ? `${lines.join("\n")}\n\n${reply.text}` : lines.join("\n");
}
