import {
	createBashToolDefinition,
	type AgentToolResult,
	type Theme,
	type ThemeColor,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { displayText, executionErrorLabel } from "./completion.ts";

export interface JobView {
	id?: string;
	commandPreview?: string;
	cwd?: string;
	owner?: string;
	observedAt?: number;
	status?: string;
	startedAt?: number;
	endedAt?: number;
	exitCode?: number | null;
	error?: string;
	cancellationRequested?: boolean;
	timeoutSeconds?: number;
}

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
type NativeBashContext = Parameters<NonNullable<ReturnType<typeof createBashToolDefinition>["renderCall"]>>[2];
type Options = { expanded: boolean; isPartial?: boolean };
type Hidden = number | "details";
const BODY_ROWS = 5;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function textOf(value: unknown): string {
	return typeof value === "string" ? displayText(value).replace(/\t/gu, "   ") : "";
}

function lineOf(value: unknown): string | undefined {
	return textOf(value).replace(/\s+/gu, " ").trim() || undefined;
}

function knownNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function count(value: number, one: string, many: string): string {
	return `${value} ${value === 1 ? one : many}`;
}

export function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	return `${hours ? `${hours}h ` : ""}${minutes % 60}m ${Math.floor(seconds) % 60}s`;
}

function jobDuration(job: JobView): string | undefined {
	const { startedAt, endedAt, observedAt } = job;
	if (!knownNumber(startedAt)) return undefined;
	if (knownNumber(endedAt) && endedAt >= startedAt) return `final ${formatDuration(endedAt - startedAt)}`;
	if (job.status === "running" && knownNumber(observedAt) && observedAt >= startedAt)
		return `elapsed ${formatDuration(observedAt - startedAt)} at observation`;
	return undefined;
}

function jobState(job: JobView): string | undefined {
	switch (job.status) {
		case "running":
			return job.cancellationRequested ? "cancellation requested" : "running";
		case "succeeded":
		case "failed":
		case "cancelled":
			return job.status;
		case "timed_out":
			return "timed out";
		case "lost":
			return "host lost";
		default:
			return undefined;
	}
}

function jobOutcome(job: JobView, admitted: boolean): string {
	const id = lineOf(job.id);
	if (admitted) return id ? `Accepted job ${id}.` : "Accepted a background job.";
	switch (jobState(job)) {
		case "running":
			return "Job recorded as running at observation.";
		case "cancellation requested":
			return "Cancellation requested.";
		case "cancelled":
			return "Cancelled";
		case "succeeded":
			return "Job succeeded.";
		case "failed":
			return "Job failed.";
		case "timed out":
			return "Job timed out.";
		case "host lost":
			return "Job lost its host.";
		default:
			return "Job state is not established.";
	}
}

function jobFacts(job: JobView, showId = true, evidence = false): string[] {
	const id = lineOf(job.id);
	const cwd = lineOf(job.cwd);
	const command = lineOf(job.commandPreview);
	const home = homedir();
	const directory = cwd === home || cwd?.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
	return [
		showId && id ? `job ${id}` : undefined,
		knownNumber(job.exitCode) ? `exit ${job.exitCode}` : undefined,
		jobDuration(job),
		knownNumber(job.timeoutSeconds) ? `timeout ${job.timeoutSeconds}s` : undefined,
		job.cancellationRequested === true &&
		job.status !== "running" &&
		job.status !== "timed_out" &&
		job.status !== "cancelled"
			? "cancellation requested"
			: undefined,
		directory && evidence ? `directory: ${directory}` : directory,
		lineOf(job.owner),
		command ? `command preview${evidence ? ":" : ""} ${command}` : undefined,
	].filter((fact): fact is string => fact !== undefined);
}

function jobError(job: JobView): string | undefined {
	const error = textOf(job.error).trim();
	return error ? `${executionErrorLabel(job.status)}: ${error}` : undefined;
}

function clipRow(line: string, width: number): string {
	return truncateToWidth(line, width, "…").replace(/\x1b\[0m…\x1b\[0m$/u, "…\x1b[22;23;24;25;27;28;29;39m");
}

function expansionHint(theme: Theme, context: RenderContext, width: number, hidden: Hidden, pending = false): string[] {
	const key = context.keyText?.("app.tools.expand");
	if (!key && pending) return [];
	const action = key
		? (context.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("dim", key) + theme.fg("muted", " to expand"))
		: theme.fg("muted", "click to expand");
	const prefix = hidden === "details" ? "" : `${count(hidden, "more line", "more lines")}, `;
	return [clipRow(theme.fg("muted", `... (${prefix}`) + action + theme.fg("muted", ")"), width)];
}

function wrapped(text: string, width: number): string[] {
	return text ? wrapTextWithAnsi(text, width) : [];
}

function component(draw: (width: number) => string[], resultPresent?: () => boolean): Component {
	let cache: { width: number; result?: boolean; lines: string[] } | undefined;
	return {
		render(width) {
			const result = resultPresent?.();
			if (cache?.width !== width || cache.result !== result) cache = { width, result, lines: draw(width) };
			return cache.lines;
		},
		invalidate() {
			cache = undefined;
		},
	};
}

interface CallCopy {
	name: string;
	subject?: string;
	facts?: string[];
	body?: string;
	cursor?: string;
}

function jobsCall(args: unknown): CallCopy {
	const call = record(args);
	const cursor = knownNumber(call?.cursor) ? `cursor ${call.cursor}` : undefined;
	return {
		name: "jobs",
		subject: [lineOf(call?.action), lineOf(call?.id)].filter(Boolean).join(" "),
		facts: cursor ? [cursor] : undefined,
		cursor: record(call?.taskCursor) ? `  taskCursor: ${displayText(JSON.stringify(call?.taskCursor))}` : undefined,
	};
}

function bashCall(args: unknown): CallCopy {
	const call = record(args);
	return {
		name: "bash",
		subject: call?.background === true ? "launch" : undefined,
		facts: knownNumber(call?.timeout) ? [`timeout ${call.timeout}s`] : undefined,
		body: textOf(call?.command),
	};
}

function callRows(copy: CallCopy, width: number, theme: Theme, expanded: boolean): { rows: string[]; hidden?: Hidden } {
	const { name, subject, facts, body, cursor } = copy;
	const title = theme.fg("toolTitle", theme.bold(name)) + (subject ? ` ${theme.fg("accent", subject)}` : "");
	const fact = facts?.length ? theme.fg("muted", facts.join(" · ")) : "";
	const headings = [title, ...(fact ? [fact] : [])];
	const rows = expanded
		? headings.flatMap((line) => wrapped(line, width))
		: headings.map((line) => clipRow(line, width));
	const visual = wrapped(body ?? "", width);
	const shown = expanded ? visual : visual.slice(0, BODY_ROWS);
	rows.push(...shown.map((line) => theme.fg("toolOutput", line)));
	if (expanded && cursor) rows.push(...wrapped(cursor, width).map((line) => theme.fg("muted", line)));
	const hidden =
		visual.length - shown.length ||
		(cursor || headings.some((line) => visibleWidth(line) > width) ? "details" : undefined);
	return { rows, hidden };
}

function renderCall(copy: CallCopy, theme: Theme, context: RenderContext): Component {
	return component(
		(width) => {
			const { rows, hidden } = callRows(copy, width, theme, context.expanded);
			if (!context.expanded && !context.state?.jobsResult && hidden !== undefined)
				rows.push(...expansionHint(theme, context, width, hidden, true));
			return rows;
		},
		() => context.state?.jobsResult === true,
	);
}

interface ResultCopy {
	outcome: string;
	body?: string;
	details?: string[];
	limit?: string;
	color?: ThemeColor;
}

function continuation(args: unknown): string {
	return `Continue with jobs ${displayText(JSON.stringify(args))}`;
}

function logPageOutcome(logs: Record<string, unknown>, start: number | undefined, next: number | undefined): string {
	const bytes = next !== undefined && start !== undefined && next >= start ? next - start : undefined;
	const page =
		bytes === undefined ? "Read a retained log page" : `Read ${count(bytes, "byte", "bytes")} from retained logs`;
	const pending = knownNumber(logs.pendingBytes) && logs.pendingBytes > 0 ? logs.pendingBytes : undefined;
	const coverage =
		logs.more === true ? "more output is available" : logs.more === false ? "reached the readable end" : undefined;
	const pendingFact =
		pending === undefined ? undefined : `${count(pending, "byte", "bytes")} in an incomplete UTF-8 suffix`;
	return `${[page, coverage, pendingFact].filter(Boolean).join("; ")}.`;
}

function logsCopy(logs: Record<string, unknown>, earliest: number, args: unknown): ResultCopy {
	const job = record(logs.job) ?? {};
	const call = record(args);
	const id = lineOf(logs.id) ?? lineOf(job.id) ?? lineOf(call?.id);
	const start = call ? Math.max(knownNumber(call.cursor) ? call.cursor : 0, earliest) : undefined;
	const next = knownNumber(logs.next) ? logs.next : undefined;
	const error = jobError(job);
	return {
		outcome: logPageOutcome(logs, start, next),
		body: typeof logs.text === "string" ? textOf(logs.text) : undefined,
		details: [
			...jobFacts({ ...job, id }, true, true),
			`earliest byte: ${earliest}`,
			...(next === undefined ? [] : [`next byte: ${next}`]),
			...(knownNumber(logs.end) ? [`end byte: ${logs.end}`] : []),
			...(error ? [error] : []),
			...(logs.more === true && id && next !== undefined ? [continuation({ action: "logs", id, cursor: next })] : []),
		],
		limit: logs.gap === true ? "[Excerpt: earlier output was discarded]" : undefined,
	};
}

function listCopy(jobs: unknown[], nextTaskCursor: unknown): ResultCopy {
	const partial = nextTaskCursor !== undefined;
	const entries = jobs.map((entry) => (record(entry) ?? {}) as JobView);
	const scope = count(jobs.length, "job", "jobs");
	return {
		outcome: partial
			? `Listed ${scope} on this page; another page is available.`
			: jobs.length
				? `Listed ${scope}.`
				: "No jobs.",
		body: entries
			.map((job) => [jobState(job), ...jobFacts(job)].filter(Boolean).join(" · "))
			.filter(Boolean)
			.join("\n"),
		details: partial ? [continuation({ action: "list", taskCursor: nextTaskCursor })] : undefined,
	};
}

function singleCopy(job: JobView, admitted: boolean, args: unknown): ResultCopy {
	const idOnCall = lineOf(job.id) === lineOf(record(args)?.id);
	// Admission clocks do not establish that the job process started.
	const facts = admitted ? jobFacts({ ...job, startedAt: undefined }, false) : jobFacts(job, !idOnCall);
	const error = jobError(job);
	return {
		outcome: jobOutcome(job, admitted),
		body: [
			...facts,
			...(job.status === "lost" ? ["Output is unavailable after host loss; the command was not run again."] : []),
			...(error ? [error] : []),
		].join("\n"),
	};
}

function resultText(result: AgentToolResult<unknown>): string {
	return textOf(
		result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n"),
	).trim();
}

function receiptCopy(details: unknown, args: unknown, admitted: boolean): ResultCopy | undefined {
	const data = record(details);
	if (!data) return undefined;
	if (Array.isArray(data.jobs)) return listCopy(data.jobs, data.nextTaskCursor);
	if (knownNumber(data.earliest)) return logsCopy(data, data.earliest, args);
	const job = record(data.job);
	return job && (lineOf(job.id) || jobState(job)) ? singleCopy(job, admitted, args) : undefined;
}

function resultCopy(result: AgentToolResult<unknown>, context: RenderContext, admitted: boolean): ResultCopy {
	const receipt = context.isError ? undefined : receiptCopy(result.details, context.args, admitted);
	if (receipt) return receipt;
	const [outcome, ...body] = resultText(result).split("\n");
	return {
		outcome: outcome || (context.isError ? "No diagnostic was retained." : "No job result was retained."),
		body: context.isError ? body.join("\n") : undefined,
		details: !context.isError && body.length ? [body.join("\n")] : undefined,
		color: context.isError ? "error" : undefined,
	};
}

function resultHidden(
	copy: ResultCopy,
	call: CallCopy,
	width: number,
	theme: Theme,
	bodyHidden: number,
): Hidden | undefined {
	const callHidden = callRows(call, width, theme, false).hidden;
	if (typeof callHidden === "number") return callHidden + bodyHidden;
	return (
		bodyHidden ||
		callHidden ||
		(copy.details?.length || (copy.limit && visibleWidth(copy.limit) > width) ? "details" : undefined)
	);
}

function resultEvidence(copy: ResultCopy, expanded: boolean, width: number, theme: Theme): string[] {
	const rows: string[] = [];
	if (expanded && copy.details?.length) {
		const color = copy.color ?? "toolOutput";
		rows.push("", ...copy.details.flatMap((line) => wrapped(line, width).map((row) => theme.fg(color, row))));
	}
	if (copy.limit) {
		const limit = theme.fg("warning", copy.limit);
		rows.push(...(expanded ? wrapped(limit, width) : [clipRow(limit, width)]));
	}
	return rows;
}

function renderResult(
	copy: ResultCopy,
	call: CallCopy,
	options: Options,
	theme: Theme,
	context: RenderContext,
): Component {
	if (context.state) context.state.jobsResult = true;
	return component((width) => {
		const expanded = options.expanded;
		const bodyColor = copy.color ?? "toolOutput";
		const [outcome = "", ...overflow] = wrapped(copy.outcome, width);
		const body = [...overflow, ...wrapped(copy.body ?? "", width)];
		const shown = expanded ? body : body.slice(0, BODY_ROWS);
		const rows = [
			"",
			theme.fg(copy.color ?? (options.isPartial ? "muted" : "toolOutput"), outcome),
			...shown.map((row) => theme.fg(bodyColor, row)),
		];
		rows.push(...resultEvidence(copy, expanded, width, theme));
		if (!expanded) {
			const hidden = resultHidden(copy, call, width, theme, body.length - shown.length);
			if (hidden) rows.push(...expansionHint(theme, context, width, hidden));
		}
		return rows.map((row) => clipRow(row, width));
	});
}

export function renderJobsCall(args: unknown, theme: Theme, context: RenderContext): Component {
	return renderCall(jobsCall(args), theme, context);
}

export function renderJobsResult(
	result: AgentToolResult<unknown>,
	options: Options,
	theme: Theme,
	context: RenderContext,
): Component {
	return renderResult(resultCopy(result, context, false), jobsCall(context.args), options, theme, context);
}

let nativeBash: ReturnType<typeof createBashToolDefinition> | undefined;

function nativeRenderers() {
	nativeBash ??= createBashToolDefinition(process.cwd());
	return nativeBash;
}

export function renderBashCall(args: unknown, theme: Theme, context: RenderContext): Component {
	const native = nativeRenderers().renderCall;
	if (record(args)?.background !== true && native) return native(args as never, theme, context as NativeBashContext);
	return renderCall(bashCall(args), theme, context);
}

export function renderBashResult(
	result: AgentToolResult<unknown>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Component {
	const admitted = Boolean(record(record(result.details)?.job));
	const native = nativeRenderers().renderResult;
	if (!admitted && record(context.args)?.background !== true && native)
		return native(result as never, options, theme, context as NativeBashContext);
	const call =
		record(context.args)?.background === true || !nativeRenderers().renderCall
			? bashCall(context.args)
			: { name: "bash" };
	return renderResult(resultCopy(result, context, admitted), call, options, theme, context);
}

/** Collapsed state notes use the message preview height in the self-drawn shell. */
export const YIELD_NOTE_LINES = 3;

interface YieldFacts {
	note: string;
	at?: number;
	jobs: { id: string; commandPreview?: string; state: string }[];
	omitted: number;
	error?: string;
	settled: boolean;
}

export function yieldClock(at: number, now = Date.now()): string {
	const date = new Date(at);
	const today = new Date(now);
	const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
	if (date.toDateString() === today.toDateString()) return time;
	const day = date.toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
		...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
	});
	return `${day} ${time}`;
}

export function yieldSummary(jobs: readonly { state: string }[], omitted: number): string[] {
	if (omitted > 0) return [count(jobs.length + omitted, "job open", "jobs open")];
	const running = jobs.filter((job) => job.state === "running").length;
	const settled = jobs.length - running;
	return [
		...(running > 0 ? [count(running, "job still runs", "jobs still run")] : []),
		...(settled > 0 ? [count(settled, "job completion pending", "job completions pending")] : []),
	];
}

function yieldHeadings(facts: YieldFacts, theme: Theme): string[] {
	const error = facts.error !== undefined;
	const status = error ? "Could not end the turn" : facts.settled ? "Turn ended" : "Ending turn";
	const title = `${theme.fg("toolTitle", theme.bold("jobs_yield"))} ${theme.fg("accent", status)}`;
	const secondary = error ? [] : yieldSummary(facts.jobs, facts.omitted);
	if (facts.at !== undefined) secondary.push(yieldClock(facts.at));
	return [title, ...(secondary.length ? [theme.fg("muted", secondary.join(" · "))] : [])];
}

function yieldDetails(jobs: YieldFacts["jobs"], width: number, theme: Theme): string[] {
	const rows = jobs.flatMap((job) => {
		const facts = [
			`job ${job.id}`,
			job.state === "running" ? "running" : "completion pending",
			job.commandPreview ? `command preview: ${job.commandPreview}` : undefined,
		];
		return wrapped(facts.filter(Boolean).join(" · "), width).map((row) => theme.fg("toolOutput", row));
	});
	return [
		...(rows.length ? ["", ...rows] : []),
		"",
		...wrapped("Each job completion starts the next turn.", width).map((row) => theme.fg("muted", row)),
	];
}

function yieldDisclosure(
	facts: YieldFacts,
	headings: string[],
	width: number,
	noteHidden: number,
	errorHidden: number,
): Hidden | undefined {
	return (
		noteHidden ||
		errorHidden ||
		((facts.settled && facts.error === undefined) || headings.some((line) => visibleWidth(line) > width)
			? "details"
			: undefined)
	);
}

function yieldBody(facts: YieldFacts, expanded: boolean, width: number, theme: Theme) {
	const note = wrapped(facts.note, width);
	const shown = expanded ? note : note.slice(0, YIELD_NOTE_LINES);
	const diagnostic = wrapped(facts.error ?? "", width);
	const errorRows = expanded ? diagnostic : diagnostic.slice(0, BODY_ROWS);
	const rows = [
		...(shown.length ? ["", ...shown.map((row) => theme.fg("toolOutput", row))] : []),
		...(errorRows.length ? ["", ...errorRows.map((row) => theme.fg("error", row))] : []),
	];
	return { rows, noteHidden: note.length - shown.length, errorHidden: diagnostic.length - errorRows.length };
}

function yieldCard(facts: YieldFacts, theme: Theme, context: RenderContext): Component {
	const hiddenByResult = () => !facts.settled && context.state?.yieldResult === true;
	return component((width) => {
		if (hiddenByResult()) return [];
		const pad = Math.max(0, Math.min(context.outputPad ?? 1, Math.floor((width - 1) / 2)));
		const inner = Math.max(1, width - pad * 2);
		const expanded = context.expanded;
		const error = facts.error !== undefined;
		const headings = yieldHeadings(facts, theme);
		const rows = headings.flatMap((line) => (expanded ? wrapped(line, inner) : [clipRow(line, inner)]));
		const body = yieldBody(facts, expanded, inner, theme);
		rows.push(...body.rows);
		if (expanded && facts.settled && !error) rows.push(...yieldDetails(facts.jobs, inner, theme));
		if (facts.omitted > 0)
			rows.push(clipRow(theme.fg("warning", `[Excerpt: ${count(facts.omitted, "job", "jobs")} not listed]`), inner));
		if (!expanded) {
			const hidden = yieldDisclosure(facts, headings, inner, body.noteHidden, body.errorHidden);
			if (hidden) rows.push(...expansionHint(theme, context, inner, hidden, !facts.settled));
		}
		const color = error ? "toolErrorBg" : "customMessageBg";
		const background = theme.getBgAnsi(color);
		return ["", ...rows, ""].map((row) => {
			const line = clipRow(row, inner);
			const content = line.replace(/\x1b\[(?:0|49)?m/gu, (reset) => reset + background);
			return theme.bg(color, " ".repeat(pad) + content + " ".repeat(Math.max(0, inner - visibleWidth(line)) + pad));
		});
	}, hiddenByResult);
}

function yieldRows(value: unknown): YieldFacts["jobs"] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const job = record(entry);
		const id = lineOf(job?.id);
		if (!id || (job?.state !== "running" && job?.state !== "settled")) return [];
		return [{ id, commandPreview: lineOf(job.commandPreview), state: job.state }];
	});
}

export function renderYieldCall(args: unknown, theme: Theme, context: RenderContext): Component {
	return yieldCard({ note: textOf(record(args)?.note).trim(), jobs: [], omitted: 0, settled: false }, theme, context);
}

export function renderYieldResult(
	result: AgentToolResult<unknown>,
	options: Options,
	theme: Theme,
	context: RenderContext,
): Component {
	if (context.state) context.state.yieldResult = true;
	const details = record(result.details);
	const at = details?.at;
	const omitted = details?.omitted;
	return yieldCard(
		{
			note: textOf(details?.note ?? record(context.args)?.note).trim(),
			jobs: yieldRows(details?.jobs),
			omitted: knownNumber(omitted) && Number.isSafeInteger(omitted) && omitted > 0 ? omitted : 0,
			at: knownNumber(at) && Number.isFinite(new Date(at).getTime()) ? at : undefined,
			error: context.isError ? resultText(result) || "No diagnostic was retained." : undefined,
			settled: true,
		},
		theme,
		{ ...context, expanded: options.expanded },
	);
}
