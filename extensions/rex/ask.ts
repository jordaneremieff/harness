import { createRexBudget, type RexBudget } from "./deadline.ts";

/**
 * A question to the operator through Rex's prompt API. Rex shows a short menu of choices in the command palette of
 * every connected Rex app, then a field for an optional note; the first answer ends the question everywhere. Only an
 * action that the server configuration defines may ask, so the question travels through the configured `pi_ask`
 * action, which runs both prompts.
 */

/** The configuration action that shows the question and the note field. */
export const ASK_ACTION = "pi_ask";
/**
 * The description of the current `pi_ask` action. A server that lists `pi_ask` with another description runs an
 * earlier block, whose action does not take this question.
 */
export const ASK_ACTION_DESCRIPTION =
	"Shows a question from a Pi agent, then a field for an optional note. Pi runs this action; run by hand, it does nothing.";
/** The first control API revision whose apps receive prompts. */
export const ASK_API_REVISION = 17;
/** Rex waits at most one hour for an answer, and a person can take that long. */
export const ASK_LIMIT_MS = 3_600_000;
export const ASK_DEFAULT_MS = ASK_LIMIT_MS;
export const ASK_MIN_MS = 10_000;
/** Time beyond the question's own wait for server checks, the action call and its settlement. */
export const ASK_MARGIN_MS = 30_000;
export const ASK_BUDGET_LIMIT_MS = ASK_LIMIT_MS + ASK_MARGIN_MS;
/** Time between two attempts while every Rex app shows another question. */
export const ASK_RETRY_MS = 2000;
export const ASK_MIN_CHOICES = 2;
export const ASK_MAX_CHOICES = 4;
/**
 * The Rex palette shows the title and each subtitle on one line of about 50 characters and cuts off the rest without
 * a mark, so each visible field fits that line.
 */
export const ASK_QUESTION_MAX = 45;
/** About as many characters as the title line shows. */
export const ASK_TITLE_LINE = 50;
/** The act that the asking session shows in full: a few sentences, not a document. */
export const ASK_ABOUT_MAX = 1200;
export const ASK_CHOICE_MAX = 40;
export const ASK_SUBTITLE_MAX = 48;
export const ASK_ID_MAX = 64;
/** The detail at the far end of the recommended choice's row. */
export const ASK_RECOMMENDED = "recommended";

export interface AskChoice {
	id: string;
	title: string;
	subtitle: string;
	recommended?: boolean;
}
export interface AskRequest {
	op: "ask";
	/** The complete act, shown in the asking session; Rex shows only the question and the choices. */
	about: string;
	question: string;
	choices: AskChoice[];
	timeoutMs?: number;
}
export interface AskAnswer {
	choice: string;
	/** The operator's note; an empty string means none. */
	note: string;
}
export type AskOutcome =
	| "answered"
	| "declined"
	| "timeout"
	| "no_client"
	| "unsupported"
	| "busy"
	| "failed"
	| "not_configured"
	| "unavailable";
export interface AskSettlement {
	outcome: AskOutcome;
	answer?: AskAnswer;
	/** Rex's own reason word when no answer arrived. */
	reason?: string;
	detail?: string;
}

/** Rex reasons for a prompt without an answer. A person who closes a prompt declines the question. */
const REASONS: Readonly<Record<string, AskOutcome>> = {
	cancelled: "declined",
	timeout: "timeout",
	no_client: "no_client",
	unsupported: "unsupported",
	busy: "busy",
	failed: "failed",
};

/** Text as one line without control or format characters, as the palette shows it. */
export const plain = (text: string) =>
	text
		.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();

/** The cross-field rules of a question that its schema cannot express. */
export function askProblem(request: Record<string, unknown>): string | undefined {
	if (typeof request.about === "string" && !plain(request.about)) return "about needs visible text";
	if (typeof request.question === "string" && !plain(request.question)) return "question needs visible text";
	const choices = (Array.isArray(request.choices) ? request.choices : []).map(object);
	if (new Set(choices.map((choice) => choice.id)).size !== choices.length) return "choice ids must be unique";
	const blank = (key: string) =>
		choices.some((choice) => {
			const value = choice[key];
			return typeof value === "string" && !plain(value);
		});
	if (blank("title")) return "each choice title needs visible text";
	if (blank("subtitle")) return "each choice subtitle needs visible text";
	if (choices.filter((choice) => choice.recommended === true).length > 1) return "recommend at most one choice";
	return undefined;
}

export function askWaitMs(timeoutMs: number | undefined): number {
	const value = timeoutMs ?? ASK_DEFAULT_MS;
	if (!Number.isSafeInteger(value) || value < ASK_MIN_MS || value > ASK_LIMIT_MS)
		throw new Error(`A Rex question waits from ${ASK_MIN_MS} to ${ASK_LIMIT_MS} ms.`);
	return value;
}
/** A question's deadline: its own wait plus the margin, not the cap for terminal work, because a person answers it. */
export function askBudget(timeoutMs: number | undefined, signal?: AbortSignal): RexBudget {
	return createRexBudget(
		askWaitMs(timeoutMs) + ASK_MARGIN_MS,
		ASK_BUDGET_LIMIT_MS,
		signal,
		undefined,
		ASK_BUDGET_LIMIT_MS,
	);
}

/**
 * The title names who asks, because several sessions and agents can ask the same person. The question comes first, so
 * the one line that Rex shows always holds it, and the name follows only when the whole title fits that line.
 */
export function askTitle(question: string, asker: string | undefined): string {
	const who = asker === undefined ? "" : plain(asker);
	const text = plain(question);
	const titled = `${text} · ${who}`;
	return who && [...titled].length <= ASK_TITLE_LINE ? titled : text;
}

/** The label of the tab that holds the launch block, unless it is missing or Rex's default. */
export function askTabLabel(view: unknown, blockId: string): string | undefined {
	const { windows } = object(view);
	if (!Array.isArray(windows)) return undefined;
	for (const candidate of windows) {
		const { window_id: id, label, layers } = object(candidate);
		if (typeof id !== "string" || !id || !Array.isArray(layers)) continue;
		const holds = layers.some((layer) => {
			const { blocks } = object(layer);
			return Array.isArray(blocks) && blocks.some((block) => object(block).block_id === blockId);
		});
		if (!holds) continue;
		const name = typeof label === "string" ? plain(label) : "";
		return name && name !== `Window ${id.slice(-8)}` ? name : undefined;
	}
	return undefined;
}

/** The arguments of the `pi_ask` action: the palette title, the rows, and the whole wait in seconds. */
export function askArguments(request: AskRequest, asker: string | undefined, waitMs: number) {
	return {
		title: askTitle(request.question, asker),
		items: request.choices.map((choice) => ({
			id: choice.id,
			title: plain(choice.title),
			subtitle: plain(choice.subtitle),
			...(choice.recommended ? { detail: ASK_RECOMMENDED } : {}),
		})),
		wait: Math.max(1, Math.min(ASK_LIMIT_MS / 1000, Math.ceil(waitMs / 1000))),
	};
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Read what the `pi_ask` action returned: an offered choice with its note, or Rex's reason for no answer. */
export function askSettlement(request: AskRequest, value: unknown): AskSettlement {
	const reply = object(value);
	if (typeof reply.why === "string") {
		const outcome = REASONS[reply.why] ?? "failed";
		const detail = typeof reply.detail === "string" && reply.detail ? reply.detail : afterChoice(outcome, reply);
		return { outcome, reason: reply.why, ...(detail ? { detail } : {}) };
	}
	const offered = request.choices.some((choice) => choice.id === reply.choice);
	return offered && typeof reply.note === "string"
		? { outcome: "answered", answer: { choice: reply.choice as string, note: reply.note } }
		: { outcome: "failed", detail: "Rex returned an answer that this question did not offer." };
}

/** Why a question that the operator had already picked a choice for has no answer: the note was never sent. */
function afterChoice(outcome: AskOutcome, reply: Record<string, unknown>): string | undefined {
	if (typeof reply.choice !== "string") return undefined;
	if (outcome === "declined") return "The operator picked a choice and then closed the note, so nothing is approved.";
	if (outcome === "timeout")
		return "The operator picked a choice, but the wait ended before the note was sent, so nothing is approved.";
	return undefined;
}

export interface AskCliRun {
	outcome: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/**
 * A finished `rex do` call of the `pi_ask` action, read as the question's settlement. A complete answer in its output
 * stands even when the call was stopped as the answer arrived; any other result of a stopped call is the stop.
 */
export function askCliSettlement(
	request: AskRequest,
	raw: AskCliRun,
	stop?: "cancelled" | "timeout",
): AskSettlement | { outcome: "cancelled" } {
	let parsed: AskSettlement | undefined;
	try {
		parsed = askSettlement(request, JSON.parse(raw.stdout));
	} catch {
		parsed = undefined;
	}
	if (parsed?.outcome === "answered") return parsed;
	if (raw.outcome === "cancelled" || stop === "cancelled") return { outcome: "cancelled" };
	if (raw.outcome === "timeout" || stop === "timeout")
		return { outcome: "timeout", detail: "The call's deadline ended before an answer." };
	if (raw.outcome !== "exited")
		return { outcome: "failed", detail: raw.stderr.trim() || `The Rex CLI ended with ${raw.outcome}.` };
	if (raw.exitCode !== 0) return askCliFailure(raw.stderr);
	return parsed ?? { outcome: "failed", detail: "Rex did not return complete JSON for the question." };
}

/** A failed `rex do` call: the CLI's wait ended, the action is missing, or Rex reported another failure. */
export function askCliFailure(stderr: string): AskSettlement {
	const text = stderr.trim();
	if (/did not finish within --timeout/u.test(text))
		return { outcome: "timeout", detail: "The question's wait ended before an answer." };
	if (text.includes(`no action named "${ASK_ACTION}"`)) return { outcome: "not_configured" };
	return { outcome: "failed", ...(text ? { detail: [...text].slice(0, 2048).join("") } : {}) };
}

/** What a settled question means for the agent that asked it. */
export function askMeaning(outcome: string, answer?: AskAnswer): string {
	if (outcome === "answered")
		return `The operator chose ${JSON.stringify(answer?.choice)} in Rex${answer?.note ? " and added a note" : " without a note"}. The answer approves only the act that this question asked about. Carry out the chosen act${answer?.note ? " and follow the note" : ""} in this run.`;
	if (outcome === "superseded")
		return "The operator sent a message to this session while the question waited, so the question closed without an answer and nothing is approved. Read that message when it reaches you after this result. Do not act on what you asked unless that message approves it. Ask nothing more through rex_ask in this run; if the message leaves the question open, put the question in your final report.";
	return "No answer arrived, so nothing is approved. Do not act on what you asked. Put the question in your final report, and ask nothing more through rex_ask in this run.";
}

/** Why a question has no answer, for the agent and the person who reads its card. */
export function askTrouble(outcome: string, detail?: string): string {
	const known: Record<string, string> = {
		declined: "The operator closed the question without answering.",
		timeout: "Nobody answered within the wait.",
		no_client: "No Rex app is connected to the server.",
		unsupported: "No connected Rex app can show questions; the apps can be older than the server.",
		not_configured: `The Rex server has not loaded the ${ASK_ACTION} action. The operator loads it with /rex setup in an ordinary Pi session.`,
		unavailable: "Rex could not be reached before the question was asked.",
		cancelled: "The call ended before an answer; Rex closed the question.",
		superseded: "The operator sent a message to this session instead of answering; Rex closed the question.",
	};
	return detail ?? known[outcome] ?? "Rex could not ask the question.";
}
