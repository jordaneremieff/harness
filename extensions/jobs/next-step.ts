/**
 * The next step an agent takes while a background job runs, and the guard on checks in a row. A job's completion is a
 * follow-up: an ordinary session receives it only once the agent stops calling tools, and a Durable conversation only
 * once the current run ends. A status or logs check therefore never brings the completion sooner; checks in a row only
 * hold the turn open as a timed wait. Each text tells the agent to continue other ready work or to end the turn, so the
 * completion starts the next one, and the third check of the same job in a row is refused.
 */

/** Where the completion arrives: `turn` for an ordinary session that offers `jobs_yield`, `run` for a Durable conversation. */
export type CompletionRoute = "turn" | "run";

/** The number of the first check of one running job in a row that the guard refuses. */
export const CHECK_LIMIT = 3;

const ARRIVAL: Readonly<Record<CompletionRoute, string>> = {
	turn: "its completion message arrives only after your turn ends",
	run: "its completion arrives as a new input only after this run ends",
};

const END: Readonly<Record<CompletionRoute, string>> = {
	turn: "call jobs_yield now, and the completion starts your next turn",
	run: "end this run now, and the completion starts the next run",
};

/** The next step after `bash` admits a background job. */
export function admittedNextStep(id: string, route: CompletionRoute): string {
	return `Job ${id} runs in the background. ${capitalize(ARRIVAL[route])}; do not check its status or logs to wait for it. Continue other ready work; if none is ready, ${END[route]}.`;
}

/** The next step after an allowed check of a running job; `check` is its number in the current streak. */
export function runningNextStep(id: string, check: number, route: CompletionRoute): string {
	const opening =
		check > 1
			? `This is check ${check} of job ${id} in a row while it runs, and check ${CHECK_LIMIT} in a row is refused. If you are waiting for it to finish, stop checking: ${ARRIVAL[route]}.`
			: `Job ${id} still runs. If you are waiting for it to finish, do not check it again: ${ARRIVAL[route]}, so another check only postpones it.`;
	return `${opening} Continue other ready work; if none is ready, ${END[route]}.`;
}

/** The refusal of a check at or past the limit. */
export function refusedCheck(id: string, check: number, route: CompletionRoute): string {
	return `Refused: this would be check ${check} of job ${id} in a row while it runs, and checks in a row only hold the ${route} open as a timed wait. This call returns nothing. ${capitalize(ARRIVAL[route])}. Continue other ready work; if none is ready, ${END[route]}. A job that never exits, such as a server, sends no completion: to wait for a condition such as its readiness, start a finite job that exits once the condition holds.`;
}

/** A call of `jobs` that only reads: status, logs and list. Any other call, cancellation included, is other work. */
export function isJobRead(name: unknown, args: unknown): boolean {
	if (name !== "jobs" || typeof args !== "object" || args === null) return false;
	const action = (args as { action?: unknown }).action;
	return action === "status" || action === "logs" || action === "list";
}

/** Whether a model reply calls no tool: an answer, which ends every streak. */
export function callsNoTool(content: unknown): boolean {
	return !(
		Array.isArray(content) &&
		content.some(
			(part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "toolCall",
		)
	);
}

/**
 * Checks of running jobs in a row, counted per job for one conversation. A check is a status read of a job whose
 * completion is still due, or a logs read of such a job that reaches the end of the readable output. A call of any
 * other tool that runs ends the streak, and so does a model reply without tool calls; an ordinary session also ends it
 * when a run starts. A call that never runs, because it was blocked, invalid or unknown, is no work and leaves the
 * streak as it was.
 */
export class CheckStreak {
	readonly #counts = new Map<string, number>();

	/** Records one check of a running job and returns its number in the streak. */
	check(id: string): number {
		const count = (this.#counts.get(id) ?? 0) + 1;
		this.#counts.set(id, count);
		return count;
	}

	end(): void {
		this.#counts.clear();
	}

	/** A settled or cancelled job sends its completion or none; its checks no longer wait for anything. */
	forget(id: string): void {
		this.#counts.delete(id);
	}

	get empty(): boolean {
		return this.#counts.size === 0;
	}
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
