import { createRexBudget, type RexBudget } from "./deadline.ts";

/**
 * A question to the operator through Rex's prompt API (`rex.ui.input` and `rex.ui.pick`). Rex shows the question in
 * the command palette of every connected Rex app; the first answer ends it everywhere. Only an action that the server
 * configuration defines may ask, so the question travels through the configured `pi_ask` action.
 */

/** The configuration action that forwards a question to `rex.ui`. */
export const ASK_ACTION = "pi_ask";
/** The first control API revision whose apps receive prompts. */
export const ASK_API_REVISION = 17;
export const ASK_DEFAULT_MS = 300000;
/** Rex waits at most one hour for an answer. */
export const ASK_LIMIT_MS = 3600000;
/** Time beyond the question's own wait for target selection, the action call and its settlement. */
export const ASK_MARGIN_MS = 30000;
export const ASK_BUDGET_LIMIT_MS = ASK_LIMIT_MS + ASK_MARGIN_MS;
export const ASK_MAX_CHOICES = 50;

export interface AskChoice {
	id: string;
	title?: string;
	subtitle?: string;
	detail?: string;
	selected?: boolean;
}
export interface AskRequest {
	op: "ask";
	question: string;
	choices?: AskChoice[];
	multiple?: boolean;
	allowOther?: boolean;
	placeholder?: string;
	value?: string;
	confirm?: string;
	timeoutMs?: number;
}
export type AskAnswer = { text: string } | { choice: string } | { choices: string[] };
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

/** Rex reasons for a question without an answer. A person who closes the prompt declines it; `cancelled` stays the caller's own cancellation. */
const REASONS: Record<string, AskOutcome> = {
	cancelled: "declined",
	timeout: "timeout",
	no_client: "no_client",
	unsupported: "unsupported",
	busy: "busy",
	failed: "failed",
};

/** Outcomes where Rex could not put the question to anybody, so the asking session can still ask in its own dialog. */
export const ASK_UNREACHED: ReadonlySet<string> = new Set([
	"not_configured",
	"unsupported",
	"no_client",
	"unavailable",
]);

/** Text as one line without control or format characters, as the palette and the dialogs show it. */
const plain = (text: string) =>
	text
		.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();

/** The cross-field rules of a question, shared by request validation and the core. */
export function askProblem(request: AskRequest): string | undefined {
	const choices = request.choices;
	if (typeof request.question === "string" && !plain(request.question)) return "the question needs visible text";
	if (!choices && request.multiple) return "multiple requires choices";
	if (!choices && request.allowOther) return "allowOther requires choices";
	if (request.multiple && request.allowOther) return "multiple and allowOther cannot be combined";
	if (choices && new Set(choices.map((choice) => choice.id)).size !== choices.length)
		return "choice ids must be unique";
	if (choices?.some((choice) => choice.selected) && !request.multiple) return "selected applies only with multiple";
	return undefined;
}

export function askWaitMs(timeoutMs: number | undefined): number {
	const value = timeoutMs ?? ASK_DEFAULT_MS;
	if (!Number.isSafeInteger(value) || value < 10000 || value > ASK_LIMIT_MS)
		throw new Error(`A Rex question waits from 10000 to ${ASK_LIMIT_MS} ms.`);
	return value;
}
/** The whole allowance of one question: its wait plus the margin for the calls around it. */
export function askBudgetMs(timeoutMs: number | undefined): number {
	return askWaitMs(timeoutMs) + ASK_MARGIN_MS;
}
/** A question's deadline: its own wait, not the cap for terminal work, because a person answers it. */
export function askBudget(timeoutMs: number | undefined, signal?: AbortSignal): RexBudget {
	return createRexBudget(askBudgetMs(timeoutMs), ASK_BUDGET_LIMIT_MS, signal, undefined, ASK_BUDGET_LIMIT_MS);
}

/** The title names who asks, because several sessions and agents can ask the same person. */
export function askTitle(question: string, asker: string | undefined): string {
	const who = asker === undefined ? "" : [...plain(asker)].slice(0, 64).join("");
	const text = plain(question);
	return who && !text.startsWith(`${who}:`) ? `${who}: ${text}` : text;
}

/** The `rex.ui` table for this question, in Rex's own field names. */
export function askPrompt(
	request: AskRequest,
	asker: string | undefined,
): { kind: "input" | "pick"; prompt: Record<string, unknown>; title: string } {
	const problem = askProblem(request);
	if (problem) throw new Error(`Invalid Rex question: ${problem}.`);
	const title = askTitle(request.question, asker);
	if (!title) throw new Error("Invalid Rex question: the question is empty.");
	const prompt: Record<string, unknown> = { title, timeout: Math.floor(askWaitMs(request.timeoutMs) / 1000) };
	if (request.placeholder !== undefined) prompt.placeholder = request.placeholder;
	if (request.value !== undefined) prompt.value = request.value;
	if (request.confirm !== undefined) prompt.confirm = request.confirm;
	if (!request.choices) return { kind: "input", prompt, title };
	prompt.items = request.choices.map((choice) => ({
		id: choice.id,
		...(choice.title === undefined ? {} : { title: choice.title }),
		...(choice.subtitle === undefined ? {} : { subtitle: choice.subtitle }),
		...(choice.detail === undefined ? {} : { detail: choice.detail }),
		...(choice.selected ? { selected: true } : {}),
	}));
	if (request.multiple) prompt.multiple = true;
	if (request.allowOther) prompt.allow_other = true;
	return { kind: "pick", prompt, title };
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Read what the `pi_ask` action returned: an answer the question offered, or Rex's reason for none. */
export function askSettlement(request: AskRequest, value: unknown): AskSettlement {
	const reply = object(value);
	if (typeof reply.why === "string")
		return {
			outcome: REASONS[reply.why] ?? "failed",
			reason: reply.why,
			...(typeof reply.detail === "string" && reply.detail ? { detail: reply.detail } : {}),
		};
	const answer = offeredAnswer(request, reply.answer);
	return answer
		? { outcome: "answered", answer }
		: { outcome: "failed", detail: "Rex returned an answer that this question did not offer." };
}

/** The answer in the form the question offered, or nothing for an answer it did not offer. */
function offeredAnswer(request: AskRequest, answer: unknown): AskAnswer | undefined {
	if (!request.choices) return typeof answer === "string" ? { text: answer } : undefined;
	const ids = new Set(request.choices.map((choice) => choice.id));
	if (request.multiple) return chosenIds(ids, answer);
	if (typeof answer === "string") return ids.has(answer) ? { choice: answer } : undefined;
	const typed = object(answer).text;
	return request.allowOther && typeof typed === "string" ? { text: typed } : undefined;
}
/** Several chosen IDs. Lua encodes an empty list as an empty table, which JSON shows as an object. */
function chosenIds(ids: ReadonlySet<string>, answer: unknown): AskAnswer | undefined {
	const empty =
		answer !== null && typeof answer === "object" && !Array.isArray(answer) && Object.keys(answer).length === 0;
	const list: unknown[] | undefined = Array.isArray(answer) ? answer : empty ? [] : undefined;
	return list?.every((id) => typeof id === "string" && ids.has(id)) ? { choices: list as string[] } : undefined;
}

/**
 * A finished `rex do` call of the `pi_ask` action, read as the question's settlement. A complete answer in its output
 * stands even when the call was stopped (`stop`) as the answer arrived; any other result of a stopped call is the stop.
 */
export function askCliSettlement(
	request: AskRequest,
	raw: { outcome: string; exitCode: number | null; stdout: string; stderr: string },
	stop?: "cancelled" | "timeout",
): AskSettlement | { outcome: "cancelled" | "timeout" } {
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
		return { outcome: "failed", detail: raw.stderr || `The Rex CLI ended with ${raw.outcome}.` };
	if (raw.exitCode !== 0) return askCliFailure(raw.stderr);
	return parsed ?? { outcome: "failed", detail: "Rex did not return complete JSON for the question." };
}

/** A failed `rex do` call: the CLI's wait ended, the action is missing, or Rex reported another failure. */
export function askCliFailure(stderr: string): AskSettlement {
	const text = stderr.trim();
	if (/did not finish within --timeout/.test(text))
		return { outcome: "timeout", detail: "The question's wait ended before an answer." };
	if (new RegExp(`no action named "${ASK_ACTION}"`).test(text)) return { outcome: "not_configured" };
	return { outcome: "failed", ...(text ? { detail: [...text].slice(0, 2048).join("") } : {}) };
}

/** What a settled question means for the agent that asked it. */
export function askMeaning(outcome: string, channel: "rex" | "dialog"): string {
	if (outcome === "answered")
		return channel === "rex"
			? "A person using a connected Rex app answered. The answer covers this question only."
			: "The operator answered in this session's dialog. The answer covers this question only.";
	if (outcome === "superseded")
		return "The operator typed into this session while the question waited, so the question was closed without an answer. When that input reaches you after this result, read it before you act on the question.";
	return "No answer arrived. Do not act on what the question asked. Put the question in your final message, or continue work that does not depend on it.";
}

/** Why a question has no answer, for the agent and the person who reads its card. */
export function askTrouble(outcome: string, detail?: string): string {
	const known: Record<string, string> = {
		declined: "The person closed the question without answering.",
		timeout: "Nobody answered within the wait.",
		no_client: "No Rex app is connected to the server.",
		unsupported: "No connected Rex app can show questions; the apps can be older than the server.",
		not_configured: `The Rex server has no ${ASK_ACTION} action. The operator adds it with /rex setup in an ordinary Pi session.`,
		unavailable: "Rex could not be reached before the question was asked.",
		cancelled: "The call ended before an answer; Rex closed the question.",
		superseded: "The operator typed into the session instead of answering; the question was closed.",
	};
	return detail ?? known[outcome] ?? "Rex could not ask the question.";
}

/** The dialogs of an ordinary Pi session that a question can fall back to. Both close on the signal or the timeout. */
export interface AskDialogs {
	select(
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
	input(
		title: string,
		placeholder?: string,
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
}

const OTHER = "Other: type an answer";
const DONE = "Done";
const TYPE = "Type another answer";

/**
 * Option labels for the choices, in order, each different from every other label and from the dialog's own rows, so
 * the label that the dialog returns names exactly one choice.
 */
export function choiceLabels(choices: readonly AskChoice[]): string[] {
	const used = new Set([OTHER, DONE, TYPE]);
	return choices.map((choice) => {
		const base = plain(
			[choice.title ?? choice.id, choice.subtitle, choice.detail && `(${choice.detail})`].filter(Boolean).join(" · "),
		);
		let label = used.has(base) ? `${base} [${plain(choice.id)}]` : base;
		for (let copy = 2; used.has(label); copy++) label = `${base} [${plain(choice.id)}] (${copy})`;
		used.add(label);
		return label;
	});
}

/**
 * Ask in this session's own dialog. The same answer forms apply: free text, one choice, several choices, or typed
 * text in place of a choice. Pi's dialogs have no multiple choice, so each pick toggles a choice until Done, and
 * no prefilled text field, so a proposed text is offered as a choice beside typing another answer.
 */
export async function askInDialog(
	request: AskRequest,
	title: string,
	dialogs: AskDialogs,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<AskSettlement> {
	const deadline = Date.now() + timeoutMs;
	const ask: DialogTurn = {
		request,
		title,
		dialogs,
		options: () => ({ signal, timeout: Math.max(1, deadline - Date.now()) }),
		ended: () => ({ outcome: Date.now() >= deadline ? "timeout" : "declined" }),
	};
	if (!request.choices) return dialogText(ask);
	return request.multiple ? dialogTicks(ask, request.choices) : dialogChoice(ask, request.choices);
}

interface DialogTurn {
	request: AskRequest;
	title: string;
	dialogs: AskDialogs;
	options(): { signal: AbortSignal; timeout: number };
	ended(): AskSettlement;
}
const unoffered: AskSettlement = { outcome: "failed", detail: "The dialog returned an option it did not offer." };

async function dialogText(ask: DialogTurn): Promise<AskSettlement> {
	const value = ask.request.value;
	if (value) {
		const proposed = `Use ${JSON.stringify(value)}`;
		const picked = await ask.dialogs.select(ask.title, [proposed, TYPE], ask.options());
		if (picked === undefined) return ask.ended();
		if (picked === proposed) return { outcome: "answered", answer: { text: value } };
	}
	const text = await ask.dialogs.input(ask.title, ask.request.placeholder, ask.options());
	return text === undefined ? ask.ended() : { outcome: "answered", answer: { text } };
}

async function dialogChoice(ask: DialogTurn, choices: readonly AskChoice[]): Promise<AskSettlement> {
	const labels = choiceLabels(choices);
	const picked = await ask.dialogs.select(
		ask.title,
		ask.request.allowOther ? [...labels, OTHER] : labels,
		ask.options(),
	);
	if (picked === undefined) return ask.ended();
	if (picked === OTHER && ask.request.allowOther)
		return dialogText({ ...ask, request: { ...ask.request, value: undefined } });
	const id = choices[labels.indexOf(picked)]?.id;
	return id === undefined ? unoffered : { outcome: "answered", answer: { choice: id } };
}

async function dialogTicks(ask: DialogTurn, choices: readonly AskChoice[]): Promise<AskSettlement> {
	const labels = choiceLabels(choices);
	const ticked = new Set(choices.filter((choice) => choice.selected).map((choice) => choice.id));
	for (;;) {
		const rows = choices.map((choice, index) => `${ticked.has(choice.id) ? "[x]" : "[ ]"} ${labels[index]}`);
		const picked = await ask.dialogs.select(
			`${ask.title} (pick to tick, then ${DONE})`,
			[...rows, DONE],
			ask.options(),
		);
		if (picked === undefined) return ask.ended();
		if (picked === DONE)
			return {
				outcome: "answered",
				answer: { choices: choices.filter((choice) => ticked.has(choice.id)).map((choice) => choice.id) },
			};
		const id = choices[rows.indexOf(picked)]?.id;
		if (id === undefined) return unoffered;
		if (!ticked.delete(id)) ticked.add(id);
	}
}
