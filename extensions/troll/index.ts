import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { obj, type Static, str } from "@earendil-works/pi-schema";
import { Text } from "@earendil-works/pi-tui";
import {
	type Endpoint,
	EndpointError,
	type Exchange,
	isSessionId,
	liveEndpoint,
	liveEndpoints,
	openEndpoint,
	type ReplyFields,
	START_WAIT_MS,
	type StatusOutcome,
	submit as submitTo,
	TEXT_LIMIT,
} from "./endpoint.ts";
import {
	type BranchEntry,
	type NoticeOutcome,
	REPLY_TYPE,
	ROLE_TYPE,
	ROUND_LIMIT,
	replyContent,
	replyFromBranch,
	roundState,
	SENT_TYPE,
	SUBMIT_TOOL,
	storedRole,
	waitingRounds,
} from "./exchange.ts";
import {
	findPi,
	OPENING_LIMIT,
	openingMessage,
	openPane,
	paneBounds,
	parseOriginFlag,
	TROLL_FLAG,
	trollArgv,
} from "./launch.ts";
import { publishSettings, readSettings } from "./settings.ts";

const doctrine = readFileSync(new URL("./doctrine.md", import.meta.url), "utf8");
export interface Timing {
	/** How long a target waits for the run of a troll message to start before it reports the message as waiting. */
	startWaitMs: number;
	/** How long a target keeps a waiting message before it reports that the run never started. */
	giveUpMs: number;
}
const TIMING: Timing = { startWaitMs: START_WAIT_MS, giveUpMs: 60000 };

const SubmitParams = obj({
	session: str({ description: "Exact session ID of the target Pi session.", minLength: 1, maxLength: 128 }),
	message: str({
		description: "The exact message to submit in the target session as the operator's own message.",
		minLength: 1,
		maxLength: TEXT_LIMIT,
	}),
});
type SubmitOutcome = "submitted" | "waiting" | "busy" | "refused" | "unavailable" | "uncertain";
type Outcome = { outcome: SubmitOutcome; detail: string; round?: number };
/** A troll message that this session took, from submission until its reply. */
interface Running {
	exchange: Exchange;
	text: string;
	leaf: string | null;
	started: boolean;
	wake?: () => void;
	giveUp?: ReturnType<typeof setTimeout>;
}

export default function troll(pi: ExtensionAPI): void {
	registerTroll(pi, TIMING);
}

export function registerTroll(pi: ExtensionAPI, timing: Timing): void {
	const agentDir = getAgentDir();
	const dir = join(agentDir, "troll");
	const stopPublications = publishSettings(pi.events, { agentDir });
	let live: ExtensionContext | undefined;
	let own: string | undefined;
	let endpoint: Endpoint | undefined;
	let endpointProblem = "The session has not opened its troll endpoint yet.";
	let closed = false;
	let running: Running | undefined;
	// In a troll session: the origin from --troll, and the connections that wait for answers.
	let origin: { id: string; pid?: number } | undefined;
	const waiting = new Set<() => void>();

	pi.registerFlag(TROLL_FLAG, {
		description: "Start this session as a troll for the given origin session. /troll sets it.",
		type: "string",
	});

	/** The troll's start command, or the reason that /troll cannot open it from this session. */
	function trollCommand(args: string, ctx: ExtensionContext): { argv: string[] } | string {
		if (ctx.mode !== "tui") return "/troll needs Pi's interactive terminal.";
		if (!endpoint) return `/troll cannot start: the troll could not reach this session. ${endpointProblem}`;
		const program = findPi(process.env);
		if (!program) return "/troll found no pi program on PATH to start the troll session.";
		const name = ctx.sessionManager.getSessionName();
		const from = { id: ctx.sessionManager.getSessionId(), pid: process.pid, ...(name ? { name } : {}) };
		const opening = openingMessage(from, args.trim());
		if (Buffer.byteLength(opening) > OPENING_LIMIT)
			return "The instruction is longer than 8 KB. Shorten it, or run /troll and give the material in the troll pane.";
		return { argv: trollArgv(program, from, opening, readSettings({ agentDir }).values) };
	}

	pi.registerCommand("troll", {
		description:
			"Open a troll in a floating pane that challenges this session's latest answer, or the target and approach your words give",
		handler: async (args, ctx) => {
			const command = trollCommand(args, ctx);
			if (typeof command === "string") {
				ctx.ui.notify(command, "error");
				return;
			}
			const result = await openPane({
				argv: command.argv,
				cwd: ctx.cwd,
				...paneBounds(readSettings({ agentDir }).values),
			});
			if (result.outcome === "created") ctx.ui.notify("The troll opened in a floating pane of this tab.", "info");
			else ctx.ui.notify(result.detail, result.outcome === "uncertain" ? "warning" : "error");
		},
	});

	function finish(entry: Running, fields: ReplyFields): void {
		if (running === entry) running = undefined;
		clearTimeout(entry.giveUp);
		if (!entry.exchange.answered) {
			entry.exchange.status("refused", "The session closed before its run started.");
			return;
		}
		if (!entry.exchange.reply(fields) && fields.outcome !== "closed")
			live?.ui.notify("The troll pane closed before this answer reached it.", "warning");
	}

	/** The reason that this session cannot take a troll message now. */
	function refusal(exchange: Exchange, ctx: ExtensionContext | undefined): [StatusOutcome, string] | undefined {
		const { request } = exchange;
		if (!ctx || closed) return ["refused", "The session is not ready."];
		if (request.target !== own) return ["refused", "The request names another session."];
		if (request.from === own) return ["refused", "A session does not submit to itself."];
		if (running) return ["busy", "The session still runs an earlier troll message. Nothing was submitted."];
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return ["busy", "The session is working. Nothing was submitted."];
		return undefined;
	}

	/** Takes one troll message while idle and submits it through Pi's own user-message path. */
	async function take(exchange: Exchange): Promise<void> {
		const ctx = live;
		const refused = refusal(exchange, ctx);
		if (refused || !ctx) {
			exchange.status(...(refused ?? ["refused", "The session is not ready."]));
			return;
		}
		const { request } = exchange;
		const entry: Running = {
			exchange,
			text: request.text,
			leaf: ctx.sessionManager.getLeafId() ?? null,
			started: false,
		};
		running = entry;
		const started = new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), timing.startWaitMs);
			entry.wake = () => {
				clearTimeout(timer);
				resolve(true);
			};
		});
		try {
			pi.sendUserMessage(request.text);
		} catch {
			running = undefined;
			exchange.status("refused", "Pi did not take the message. Nothing was submitted.");
			return;
		}
		const didStart = await started;
		if (running !== entry) return;
		if (didStart) {
			ctx.ui.notify(`Troll round ${request.round}: the troll pane submitted the message.`, "info");
			exchange.status("submitted", "The session took the message as the operator's and started its run.");
			return;
		}
		exchange.status(
			"waiting",
			"The session took the message but has not started its run. Its answer, or a notice that it did not run the message, follows.",
		);
		entry.giveUp = setTimeout(() => {
			if (running === entry && !entry.started)
				finish(entry, { outcome: "not-started", text: "", truncated: false, otherInputs: 0 });
		}, timing.giveUpMs);
		entry.giveUp.unref?.();
	}

	type Admission = Outcome | { round: number };
	/** The next round's number, or the reason that this troll may not submit now. */
	function admit(target: string, message: string, branch: BranchEntry[]): Admission {
		if (!isSessionId(target)) return { outcome: "refused", detail: "Give the exact session ID of the target." };
		if (!own || target === own) return { outcome: "refused", detail: "The troll does not submit to its own session." };
		if (!message.trim()) return { outcome: "refused", detail: "The message is empty." };
		const state = roundState(branch);
		if (state.halt)
			return { outcome: "refused", detail: `${state.halt} Another round needs the operator's word here.` };
		if (state.rounds >= ROUND_LIMIT)
			return {
				outcome: "refused",
				detail: `${ROUND_LIMIT} rounds followed the operator's last message. Report to the operator; another round needs their word here.`,
			};
		return { round: state.rounds + 1 };
	}

	/** The one process that takes submissions for the target. The origin pane wins where it still runs. */
	async function resolveTarget(target: string): Promise<string | Outcome> {
		const pane = origin?.pid && target === origin.id ? await liveEndpoint(dir, target, origin.pid) : undefined;
		if (pane) return pane;
		const found = await liveEndpoints(dir, target);
		if (found.length === 1 && found[0]) return found[0].path;
		if (found.length > 1)
			return {
				outcome: "refused",
				detail:
					"More than one Pi process runs that session, so the troll cannot tell which pane to use. Close the others, or run /troll from the pane you mean.",
			};
		return {
			outcome: "unavailable",
			detail:
				"No troll endpoint answers for that session. It is not a running interactive Pi session on this machine with the troll extension loaded; a session that started before the extension became active needs a restart.",
		};
	}

	function notice(from: string, round: number, fields: ReplyFields | { outcome: NoticeOutcome }, trigger: boolean) {
		const reply =
			"text" in fields ? fields : { ...fields, text: "" as const, truncated: false as const, otherInputs: 0 as const };
		pi.sendMessage(
			{
				customType: REPLY_TYPE,
				content: replyContent(from, round, reply),
				display: true,
				details: { from, round, outcome: reply.outcome, otherInputs: reply.otherInputs, truncated: reply.truncated },
			},
			trigger ? { triggerTurn: true, deliverAs: "followUp" } : {},
		);
	}

	async function deliver(target: string, round: number, text: string, signal?: AbortSignal): Promise<Outcome> {
		const path = await resolveTarget(target);
		if (typeof path !== "string") return path;
		signal?.throwIfAborted();
		pi.appendEntry(SENT_TYPE, { session: target, round });
		try {
			const submission = await submitTo(path, { version: 1, op: "submit", target, from: own ?? "", round, text });
			const { outcome, detail } = submission.status;
			if (outcome === "submitted" || outcome === "waiting") {
				waiting.add(submission.close);
				void submission.reply.then((reply) => {
					waiting.delete(submission.close);
					if (!closed) notice(target, round, reply ?? { outcome: "lost" }, true);
				});
			}
			return { outcome, detail, round };
		} catch (error) {
			if (error instanceof EndpointError && error.reason === "absent")
				return { outcome: "unavailable", detail: "The session's troll endpoint closed. Nothing was submitted." };
			return {
				outcome: "uncertain",
				detail:
					"The submission is unconfirmed and may have arrived. Its answer will not arrive here; read the target's history before you submit again.",
				round,
			};
		}
	}

	function registerSubmit(): void {
		pi.registerTool({
			name: SUBMIT_TOOL,
			label: "Troll submit",
			description:
				"Submit a message in another interactive Pi session on this machine as the operator's own message. The target takes it only while idle. Its answer arrives here as a troll-reply message when its run ends.",
			promptSnippet: "Submit the troll's message in the target session as the operator's message",
			promptGuidelines: [
				"Use troll_submit to deliver each round to the target session unless the operator's instruction asks for another process. A submitted result means the target started its run; its answer arrives later as a troll-reply message.",
			],
			parameters: SubmitParams,
			renderCall(args, theme, context) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const call = (args ?? {}) as { session?: unknown; message?: unknown };
				const session = typeof call.session === "string" ? call.session : "";
				const message = typeof call.message === "string" ? call.message : "";
				text.setText(
					`${theme.fg("toolTitle", theme.bold("troll_submit "))}${theme.fg("muted", `to ${session}`)}${message ? `\n${message}` : ""}`,
				);
				return text;
			},
			renderResult(result, _options, theme, context) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const details = result.details as { outcome?: string; round?: number } | undefined;
				const first = result.content[0];
				const line = first?.type === "text" ? first.text : "";
				text.setText(
					details?.outcome === "submitted"
						? theme.fg(
								"success",
								`Submitted round ${details.round}. The answer arrives here when the target's run ends.`,
							)
						: theme.fg("warning", line),
				);
				return text;
			},
			async execute(_id, params: Static<typeof SubmitParams>, signal, _update, ctx) {
				const target = params.session.trim();
				const admitted = admit(target, params.message, ctx.sessionManager.getBranch() as BranchEntry[]);
				signal?.throwIfAborted();
				const result = "outcome" in admitted ? admitted : await deliver(target, admitted.round, params.message, signal);
				return {
					content: [{ type: "text" as const, text: `${result.outcome}: ${result.detail}` }],
					details: { outcome: result.outcome, session: target, ...(result.round ? { round: result.round } : {}) },
				};
			},
		});
	}

	/** Takes the troll role from --troll or from the session's own record, which keeps it when the session resumes. */
	function startRole(branch: BranchEntry[]): void {
		const flagged = parseOriginFlag(pi.getFlag(TROLL_FLAG));
		const stored = storedRole(branch);
		origin = flagged ?? stored;
		if (flagged && (flagged.id !== stored?.id || flagged.pid !== stored?.pid)) pi.appendEntry(ROLE_TYPE, flagged);
		if (!origin) return;
		registerSubmit();
		// Connections that waited for answers ended with the previous instance of this session.
		for (const round of waitingRounds(branch)) notice(round.session, round.round, { outcome: "restarted" }, false);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		live = ctx;
		own = ctx.sessionManager.getSessionId();
		startRole(ctx.sessionManager.getBranch() as BranchEntry[]);
		try {
			const opened = await openEndpoint(dir, own, take);
			if (closed) opened.close();
			else endpoint = opened;
		} catch (error) {
			endpointProblem = error instanceof Error ? error.message : "The endpoint did not open.";
		}
	});

	pi.on("before_agent_start", (event) => {
		if (origin) event.systemPromptOptions.sections.troll = doctrine;
		// The run that starts with the troll's exact text confirms that the session took the message.
		const entry = running;
		if (!entry || entry.started || event.messageType !== "user" || event.prompt !== entry.text) return;
		entry.started = true;
		clearTimeout(entry.giveUp);
		entry.wake?.();
	});

	pi.on("agent_settled", (event, ctx) => {
		const entry = running;
		if (!entry?.started) return;
		finish(entry, replyFromBranch(ctx.sessionManager.getBranch() as BranchEntry[], entry, event.aborted));
	});

	pi.on("session_shutdown", () => {
		closed = true;
		if (running) finish(running, { outcome: "closed", text: "", truncated: false, otherInputs: 0 });
		endpoint?.close();
		endpoint = undefined;
		live = undefined;
		for (const close of waiting) close();
		waiting.clear();
		stopPublications();
	});
}
