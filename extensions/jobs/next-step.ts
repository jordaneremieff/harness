/**
 * The next step an agent takes while a background job runs. A job's completion is a follow-up: an ordinary session
 * receives it only once the agent stops calling tools, and a Durable conversation only once the current run ends. A
 * status or logs check therefore never brings the completion sooner; it only keeps the turn open as a timed wait.
 * Each text tells the agent to continue other ready work or to end the turn, so the completion starts the next one.
 */

/** Where the completion arrives: `turn` for an ordinary session that offers `jobs_yield`, `run` for a Durable conversation. */
export type CompletionRoute = "turn" | "run";

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

/**
 * The next step after a status or logs read of a job whose completion is still to come. `checks` counts such reads
 * of this job while it runs, this one included; from the second read on, the text names the repetition.
 */
export function runningNextStep(id: string, checks: number, route: CompletionRoute): string {
	const opening =
		checks > 1
			? `This is check ${checks} of job ${id} while it runs. If you are waiting for it to finish, stop checking: ${ARRIVAL[route]}.`
			: `Job ${id} still runs. If you are waiting for it to finish, do not check it again: ${ARRIVAL[route]}, so another check only postpones it.`;
	return `${opening} Continue other ready work; if none is ready, ${END[route]}.`;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
