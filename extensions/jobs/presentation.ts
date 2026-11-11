import { createBashToolDefinition, type AgentToolResult, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { displayText, executionErrorLabel } from "./completion.ts";

/** Facts a job card can show. Absent fields are unknown, not empty. */
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

interface LogView {
	id?: string;
	text?: string;
	earliest?: number;
	next?: number;
	end?: number;
	gap?: boolean;
	more?: boolean;
	pendingBytes?: number;
	job?: JobView;
}

type NativeBash = ReturnType<typeof createBashToolDefinition>;
/** Pi's tool render context; the job cards use its previous component and host key hints. */
type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
type NativeContext = Parameters<NonNullable<NativeBash["renderCall"]>>[2];
const COMPACT_ERROR_CHARS = 120;

/** One retained string as display text: terminal controls removed, newlines and tabs kept. */
function textOf(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const clean = displayText(value);
	return clean.length > 0 ? clean : undefined;
}

/** One retained string on one card line. */
function lineOf(value: unknown): string | undefined {
	return textOf(value)?.replace(/\s+/gu, " ").trim() || undefined;
}

function jobView(value: unknown): JobView | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as JobView;
}

function logView(value: unknown): LogView | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as LogView;
	return typeof record.earliest === "number" ? record : undefined;
}

function known(value: string | undefined): string {
	return value ?? "unknown";
}

function seconds(start: number, end: number): string {
	const value = Math.max(0, (end - start) / 1000);
	return value < 10 ? `${value.toFixed(1)}s` : `${Math.round(value)}s`;
}

/** Elapsed time uses the snapshot clock. A missing clock stays unknown. */
function duration(job: JobView): string {
	if (typeof job.startedAt !== "number") return "duration unknown";
	if (typeof job.endedAt === "number") return `final ${seconds(job.startedAt, job.endedAt)}`;
	if (job.status === "running" && typeof job.observedAt === "number") return `elapsed ${seconds(job.startedAt, job.observedAt)} at observation`;
	return job.status === "running" ? "elapsed unknown" : "duration unknown";
}

function stateLabel(job: JobView): string {
	if (job.status === "running" && job.cancellationRequested) return "cancellation requested";
	if (job.status === "running") return "accepted, running";
	if (job.status === "cancelled") return "settled cancellation";
	if (job.status === "timed_out") return "timed out";
	if (job.status === "lost") return "host lost";
	if (job.status === "succeeded" || job.status === "failed") return job.status;
	return "unknown";
}

/** A requested cancellation on a settled job is a fact worth a word; its absence is routine. */
function requestLabel(job: JobView): string | undefined {
	return job.cancellationRequested && job.status !== "running" && job.status !== "cancelled" && job.status !== "timed_out" ? "cancellation requested" : undefined;
}

/** Short stable identity and the context that tells repeated commands apart. */
function contextLine(job: JobView): string | undefined {
	const id = lineOf(job.id);
	const cwd = lineOf(job.cwd);
	const folder = cwd ? basename(cwd) || cwd : undefined;
	const parts = [id ? `job ${id}` : undefined, folder ? `in ${folder}` : undefined, lineOf(job.owner)].filter((part): part is string => part !== undefined);
	return parts.length ? parts.join(" · ") : undefined;
}

function exitLabel(job: JobView): string | undefined {
	if (typeof job.exitCode === "number") return `exit ${job.exitCode}`;
	if (job.exitCode === null) return "exit unavailable";
	if (job.status === "failed" || job.status === "succeeded") return "exit unknown";
	return undefined;
}

function compactError(error: string | undefined): string | undefined {
	if (error === undefined) return undefined;
	const flat = error.replace(/\s+/gu, " ").trim();
	if (flat.length <= COMPACT_ERROR_CHARS) return flat;
	return `${flat.slice(0, COMPACT_ERROR_CHARS - 1)}…`;
}

/** The exceptional state leads; exit and duration follow; the routine absence of a cancel request says nothing. */
function compactJob(job: JobView): string[] {
	const facts = [stateLabel(job), requestLabel(job), exitLabel(job), duration(job)].filter((fact): fact is string => fact !== undefined);
	const context = contextLine(job);
	const lines = [lineOf(job.commandPreview) ?? "command unknown", ...(context ? [context] : []), [...new Set(facts)].join(" · ")];
	const error = compactError(textOf(job.error));
	if (error) lines.push(`${executionErrorLabel(job.status)}: ${error}`);
	return lines;
}

function lossLines(job: JobView): string[] {
	if (job.status !== "lost") return [];
	return [
		"The host stopped while the command ran.",
		"Output is unavailable. The command was not run again.",
		"Zero retained bytes does not mean the command produced no output.",
	];
}

function detailJob(job: JobView, logs?: LogView): string[] {
	const lines = [
		...compactJob(job),
		`id: ${known(lineOf(job.id))}`,
		`owner: ${known(lineOf(job.owner))}`,
		`working directory: ${known(lineOf(job.cwd))}`,
		`timeout: ${typeof job.timeoutSeconds === "number" ? `${job.timeoutSeconds}s` : "none"}`,
		`cancel request: ${job.cancellationRequested === undefined ? "unknown" : job.cancellationRequested ? "yes" : "no"}`,
		...lossLines(job),
	];
	const error = textOf(job.error);
	if (error) lines.push(`${executionErrorLabel(job.status)}: ${error}`);
	if (logs) lines.push(...logDetail(logs));
	else lines.push("Logs are not in this result.");
	return lines;
}

function flag(value: boolean | undefined, yes: string): string {
	if (value === undefined) return "unknown";
	return value ? yes : "no";
}

/** The retained page as display text; the raw bytes stay in the result. */
function logTextLines(text: string | undefined): string[] {
	if (text === undefined) return ["Log text is unavailable."];
	if (text.length === 0) return ["This page has no output."];
	return ["Retained page:", displayText(text)];
}

function logDetail(logs: LogView): string[] {
	const lines = [
		`log id: ${known(lineOf(logs.id))}`,
		`earliest: ${logs.earliest ?? "unknown"}`,
		`next: ${logs.next ?? "unknown"}`,
		`end: ${logs.end ?? "unknown"}`,
		`gap: ${flag(logs.gap, "yes, earlier output was discarded")}`,
		`more: ${flag(logs.more, "yes")}`,
		`pending bytes: ${typeof logs.pendingBytes === "number" ? String(logs.pendingBytes) : "unknown"}`,
	];
	if (logs.gap) lines.push("Output before the retained tail is unavailable.");
	if ((logs.pendingBytes ?? 0) > 0) lines.push("An incomplete UTF-8 suffix is pending. It is not missing output.");
	return [...lines, ...logTextLines(logs.text)];
}

function compactLogs(logs: LogView): string[] {
	const job = logs.job;
	const lines = job ? compactJob({ ...job, error: undefined }) : [`log ${known(lineOf(logs.id))}`];
	const marks = [
		logs.gap ? "output gap" : undefined,
		logs.more ? "more output" : undefined,
		(logs.pendingBytes ?? 0) > 0 ? "output pending" : undefined,
		logs.text === undefined ? "output unavailable" : undefined,
	].filter((mark): mark is string => mark !== undefined);
	if (marks.length > 0) lines.push(marks.join(" · "));
	return lines;
}

/** The disclosure hint names the operator's configured expansion key when the host supplies one. */
function expansionHint(context: RenderContext): string {
	const key = typeof context.keyText === "function" ? context.keyText("app.tools.expand") : "";
	return key ? `... (${key} to expand)` : "... (expand for full details)";
}

function card(lines: string[], theme: Theme, context: RenderContext, hint = false): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const [title, ...rest] = lines;
	text.setText([theme.fg("toolTitle", title ?? "command unknown"), ...rest.map((line) => theme.fg("toolOutput", line)), ...(hint ? [theme.fg("muted", expansionHint(context))] : [])].join("\n"));
	return text;
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function logsLines(logs: LogView, expanded: boolean): string[] {
	if (!expanded) return compactLogs(logs);
	return logs.job ? detailJob(logs.job, logs) : ["command unknown", "unknown", ...logDetail(logs)];
}

function listLines(jobs: unknown[], expanded: boolean, nextTaskCursor?: unknown): string[] {
	if (jobs.length === 0 && nextTaskCursor === undefined) return ["No jobs"];
	const lines = jobs.flatMap((entry, index) => {
		const job = jobView(entry) ?? {};
		const rows = expanded ? detailJob(job) : compactJob(job);
		return index === 0 ? rows : ["", ...rows];
	});
	if (nextTaskCursor !== undefined) {
		lines.push("More jobs: partial page");
		if (expanded) lines.push(`nextTaskCursor: ${JSON.stringify(nextTaskCursor)}`);
	}
	return lines;
}

/** Card lines and whether a collapsed card hides more. Fallback text is the model-visible result text. */
function jobsLines(details: unknown, expanded: boolean, isError: boolean, fallback: string): { lines: string[]; more: boolean } {
	const cleanFallback = displayText(fallback);
	const logs = logView(details);
	if (logs) {
		const lines = logsLines(logs, expanded);
		return { lines: isError && cleanFallback ? [...lines, cleanFallback] : lines, more: !expanded };
	}
	const record = jobView(details) as { jobs?: unknown; job?: unknown; nextTaskCursor?: unknown } | undefined;
	if (Array.isArray(record?.jobs)) return { lines: listLines(record.jobs, expanded, record.nextTaskCursor), more: !expanded && (record.jobs.length > 0 || record.nextTaskCursor !== undefined) };
	const job = jobView(record?.job);
	if (job) return { lines: expanded ? detailJob(job) : compactJob(job), more: !expanded };
	if (cleanFallback) {
		const [first = "unknown", ...rest] = cleanFallback.split("\n");
		return { lines: expanded ? [cleanFallback] : [first], more: !expanded && rest.length > 0 };
	}
	return { lines: ["command unknown", "unknown"], more: false };
}

let nativeBash: ReturnType<typeof createBashToolDefinition> | undefined;

function nativeRenderers(): ReturnType<typeof createBashToolDefinition> {
	nativeBash ??= createBashToolDefinition(process.cwd());
	return nativeBash;
}

export function renderJobsCall(args: unknown, theme: Theme, context: RenderContext): Text {
	const record = args !== null && typeof args === "object" ? (args as { action?: unknown; id?: unknown }) : {};
	const action = textOf(record.action) ?? "unknown";
	const id = textOf(record.id);
	return card([`jobs ${action}${id ? ` ${id}` : ""}`], theme, context);
}

export function renderJobsResult(result: AgentToolResult<unknown>, options: { expanded: boolean }, theme: Theme, context: RenderContext): Text {
	const { lines, more } = jobsLines(result.details, options.expanded, result.isError === true, result.isError ? resultText(result) : "");
	return card(lines, theme, context, more);
}

export function renderBashCall(args: unknown, theme: Theme, context: RenderContext): Text {
	const native = nativeRenderers().renderCall;
	if (native) return native(args as never, theme, context as NativeContext) as Text;
	const command = textOf((args as { command?: unknown } | null)?.command);
	return card([command ?? "command unknown"], theme, context);
}

export function renderBashResult(
	result: AgentToolResult<unknown>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Text | ReturnType<NonNullable<ReturnType<typeof createBashToolDefinition>["renderResult"]>> {
	if (jobView(result.details) && jobView((result.details as { job?: unknown }).job)) return renderJobsResult(result, options, theme, context);
	const native = nativeRenderers().renderResult;
	if (native) return native(result as never, options, theme, context as NativeContext);
	const { lines, more } = jobsLines(result.details, options.expanded, result.isError === true, resultText(result));
	return card(lines, theme, context, more);
}
