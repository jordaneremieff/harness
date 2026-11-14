/**
 * The Work view of one native conversation: each request whose work the conversation declared, its
 * route, its state note, its exact dependencies and its final report. Every read is passive: the
 * conversation's live frame or one status read, then result pages and final report pages that follow
 * the exact continuations the host returns. The view admits no input, changes no work and keeps no
 * store. Leaving a view, or selecting another conversation, aborts its reads.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Static } from "@earendil-works/pi-schema";
import { type Action, Browser, type KeyHint, type OperatorView, plainLine, plainText, ReaderView, type ViewHost } from "../../operator-ui/index.ts";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { dashboardClock } from "./dashboard-time.ts";
import { ResultOutputSchema } from "./observation-schema.ts";
import { type FinalReportDelivery, type FinalReportRead, type OpenWorkDependencyView, type OpenWorkView, OpenWorkViewSchema } from "./open-work-schema.ts";
import { matchesSchema } from "./schema-check.ts";

/** Selectors of one exact `agent_inspect` result call, without its tool name. */
export interface ResultCall {
	readonly sessionId: string;
	readonly view: "result";
	readonly submissionId: number;
	readonly requestId?: string;
	readonly finalReport?: true;
	readonly offset?: number;
}

/** What the Work view reads. Each read is passive: it starts no host, admits no input and acknowledges no delivery. */
export interface WorkSource {
	/** The conversation status of the newest live frame, read in memory; undefined while no live frame is current. */
	live(): { readonly status: unknown; readonly observedAt: string; readonly revision: number } | undefined;
	/** One status read of the conversation. */
	status(signal: AbortSignal): Promise<unknown>;
	/** One result page: an answer page, or a final report page with `finalReport: true`. */
	inspect(call: ResultCall, signal: AbortSignal): Promise<unknown>;
}

type ResultPage = Static<typeof ResultOutputSchema>;
type Close = NonNullable<OpenWorkView["close"]>;

/** One row of the Work list: a request, one of its dependencies, or its final report. */
export type WorkRow =
	| { readonly kind: "request"; readonly key: string; readonly item: OpenWorkView }
	| { readonly kind: "dependency"; readonly key: string; readonly item: OpenWorkView; readonly dependency: OpenWorkDependencyView }
	| { readonly kind: "report"; readonly key: string; readonly item: OpenWorkView; readonly close: Close };

/** Answer and report pages followed in one read; a longer text stops with its exact continuation. */
export const WORK_READ_PAGES = 64;

/** Declared work items of one conversation status; an item that does not match the public shape is counted, not shown. */
export function readWork(status: unknown): { items: OpenWorkView[]; unreadable: number } {
	if (status === null || typeof status !== "object") throw new Error("The status names no conversation");
	const list = (status as { openWork?: unknown }).openWork;
	if (list === undefined) return { items: [], unreadable: 0 };
	if (!Array.isArray(list)) return { items: [], unreadable: 1 };
	const items = list.filter((item): item is OpenWorkView => matchesSchema(OpenWorkViewSchema, item));
	return { items, unreadable: list.length - items.length };
}

/** Open items first, oldest declaration first; then closed items, newest close first. Each request precedes its dependencies and its final report. */
export function workRows(items: readonly OpenWorkView[]): WorkRow[] {
	const open = items.filter((item) => item.state === "open").sort((a, b) => a.declaredAt - b.declaredAt);
	const closed = items.filter((item) => item.state === "closed").sort((a, b) => (b.close?.at ?? b.updatedAt) - (a.close?.at ?? a.updatedAt));
	return [...open, ...closed].flatMap((item): WorkRow[] => [
		{ kind: "request", key: `request:${item.requestId}`, item },
		...item.dependencies.map((dependency): WorkRow => ({ kind: "dependency", key: `dependency:${item.requestId}:${dependency.sessionId}:${dependency.submissionId}`, item, dependency })),
		...(item.close === undefined ? [] : [{ kind: "report" as const, key: `report:${item.requestId}`, item, close: item.close }]),
	]);
}

/** The exact call text a model would use; the view issues the same selectors. */
export function callText(call: { readonly tool?: string } & ResultCall): string {
	const { tool: _tool, ...selectors } = call;
	return `agent_inspect(${JSON.stringify(selectors)})`;
}

function exactCall(call: { readonly tool?: string } & ResultCall): ResultCall {
	const { tool: _tool, ...selectors } = call;
	return selectors;
}

/** One dependency's state in plain words; an arrived result is never task acceptance. */
export function dependencyWords(dependency: OpenWorkDependencyView): { label: string; meaning: string; color: "success" | "accent" | "warning" | "muted" } {
	if (dependency.state === "arrived") return { label: "result arrived", meaning: "Its result arrived. An arrived result is not task acceptance.", color: "success" };
	if (dependency.state === "state-note") return { label: "state note", meaning: "Its producer answered with a state note: the producer's own declared work is still open, so its result is still to come.", color: "accent" };
	if (dependency.unavailable !== undefined) return { label: "not established", meaning: `No committed fact establishes its state: ${plainLine(dependency.unavailable)}.`, color: "warning" };
	return { label: "pending", meaning: "Its input has not settled, so no answer has arrived.", color: "muted" };
}

const DELIVERY_LABEL: Record<FinalReportDelivery, string> = {
	retained: "kept for reading", delivered: "delivered", active: "delivering", parked: "delivery parked", fallback: "fallback copies", terminal: "delivery ended", absent: "no report row",
};

/** Delivery of a final report in plain words; delivery is not task acceptance. */
export function deliveryWords(delivery: FinalReportDelivery | undefined, ownerId: string): string {
	switch (delivery) {
		case "retained": return "Kept here for reading: the reply recipient is this conversation, so the report never enters it as an input.";
		case "delivered": return `Delivered: ${ownerId} acknowledged the report. Delivery is not task acceptance.`;
		case "active": return `Delivery to ${ownerId} is in progress.`;
		case "parked": return `Delivery parked: ${ownerId} cannot be reached now. The report stays retained.`;
		case "fallback": return `No live owning session: copies went to live sessions, and ${ownerId} has not acknowledged the report.`;
		case "terminal": return `Delivery to ${ownerId} ended without admission. The report stays readable here.`;
		case "absent": return `No retained report row for ${ownerId} was found.`;
		default: return "The status names no delivery state.";
	}
}

const CLOSE_GLYPH: Record<Close["status"], { glyph: string; color: "success" | "error" | "warning" }> = {
	done: { glyph: "✓", color: "success" }, failed: { glyph: "✗", color: "error" }, stopped: { glyph: "■", color: "warning" }, reset: { glyph: "↺", color: "warning" },
};

const CLOSE_MEANING: Record<Close["status"], string> = {
	done: "the agent completed it", failed: "the agent completed it as failed", stopped: "a host stop closed it", reset: "a context reset closed it",
};

function arrivedCount(item: OpenWorkView): string {
	if (item.dependencies.length === 0) return "no dependency";
	const arrived = item.dependencies.filter((dependency) => dependency.state === "arrived").length;
	return `${arrived} of ${item.dependencies.length} arrived`;
}

/** One list line; the detail holds the full identities. */
export function workLine(row: WorkRow, theme: Theme): string {
	const dot = theme.fg("muted", " · ");
	if (row.kind === "request") {
		const { item } = row;
		const state = item.close === undefined ? theme.fg("accent", "○ open") : theme.fg(CLOSE_GLYPH[item.close.status].color, `${CLOSE_GLYPH[item.close.status].glyph} ${item.close.status}`);
		return `${state}${dot}${item.close === undefined ? `${arrivedCount(item)}${dot}` : ""}${plainLine(item.note)}`;
	}
	if (row.kind === "dependency") {
		const words = dependencyWords(row.dependency);
		return `  ↳ ${theme.fg(words.color, words.label)}${dot}${plainLine(row.dependency.sessionId)} #${row.dependency.submissionId}`;
	}
	const delivery = row.close.delivery === undefined ? "" : `${dot}${DELIVERY_LABEL[row.close.delivery]}`;
	return `  ↳ ${theme.fg(CLOSE_GLYPH[row.close.status].color, "final report")}${delivery}`;
}

function requestDetail(item: OpenWorkView, target: string): string[] {
	const lines = [`Request ${item.requestId}`];
	if (item.close === undefined) lines.push(`Work open: it owes a final report to ${item.replyTo}. The answer of its input is a state note, not the result.`);
	else lines.push(`Work closed (${item.close.status}) at ${dashboardClock(item.close.at)}: ${CLOSE_MEANING[item.close.status]}. Its final report is the result of the request.`);
	lines.push(
		`Input: submission ${item.submissionId} of ${target}`,
		`Requester: ${item.requester} (${item.origin === "operator" ? "operator request" : "model request"})`,
		`Reply recipient: ${item.replyTo}`,
		`Declared ${dashboardClock(item.declaredAt)} · updated ${dashboardClock(item.updatedAt)}`,
		"",
		"What remains",
		plainText(item.note),
		"",
		"Dependencies",
	);
	if (item.dependencies.length === 0) lines.push(item.close === undefined ? "None: no result wakes this work. The agent completes it itself." : "None.");
	for (const dependency of item.dependencies) lines.push(`${dependencyWords(dependency).label} · ${dependency.sessionId} submission ${dependency.submissionId}${dependency.requestId === undefined ? "" : ` · request ${dependency.requestId}`}`);
	if (item.close !== undefined) lines.push("", "Final report", ...reportFacts(item, item.close));
	return lines;
}

function reportFacts(item: OpenWorkView, close: Close): string[] {
	return [
		`Report request: ${close.reportRequestId}`,
		`Status: ${close.status} · closed ${dashboardClock(close.at)}`,
		`Reply recipient: ${item.replyTo}`,
		`Delivery: ${deliveryWords(close.delivery, item.replyTo)}`,
		`Read: ${callText(close.read)}`,
	];
}

/** The detail of one row: full identities, states in plain words and the exact read call. */
export function workDetail(row: WorkRow, target: string): string {
	if (row.kind === "request") return requestDetail(row.item, target).join("\n");
	if (row.kind === "dependency") {
		const { dependency } = row;
		const words = dependencyWords(dependency);
		return [
			`Dependency of request ${row.item.requestId}`,
			`State: ${words.label}`,
			words.meaning,
			"",
			`Session: ${dependency.sessionId}`,
			`Submission: ${dependency.submissionId}`,
			...(dependency.requestId === undefined ? [] : [`Request: ${dependency.requestId}`]),
			`Read: ${callText(dependency.inspect)}`,
			"",
			"Enter reads its result. A read neither acknowledges nor withdraws its delivery.",
		].join("\n");
	}
	return [`Final report of request ${row.item.requestId}`, ...reportFacts(row.item, row.close), "", "Enter reads the complete report."].join("\n");
}

const errorText = (error: unknown) => plainLine(error instanceof Error ? error.message : String(error));

/** The declared work of one conversation as a list with a detail. */
export class WorkView implements OperatorView {
	readonly title = "Work";
	focused = false;
	private readonly host: ViewHost;
	private readonly source: WorkSource;
	private readonly browser: Browser<WorkRow>;
	private items: readonly OpenWorkView[] = [];
	private unreadable = 0;
	private observedAt?: number;
	private mode: "unread" | "read" | "live" | "kept" = "unread";
	private liveRevision?: number;
	private error?: string;
	private reading?: AbortController;

	constructor(host: ViewHost, source: WorkSource) {
		this.host = host;
		this.source = source;
		this.browser = new Browser<WorkRow>({
			title: "Declared work",
			host,
			key: (row) => row.key,
			line: (row, _width, theme) => workLine(row, theme),
			detail: (row) => (row === undefined ? "" : workDetail(row, host.target.id)),
			actions: (row) => this.rowActions(row),
			status: () => this.statusText(),
			empty: () => (this.mode === "unread" ? (this.error ? "" : "Reading the declared work…") : "No declared work is open or retained for this conversation."),
		});
		if (!this.sync()) void this.read();
	}

	/** True while the current live frame supplies the items. */
	private sync(): boolean {
		const live = this.source.live();
		if (live === undefined) {
			if (this.mode === "live") this.mode = "kept";
			return false;
		}
		if (this.mode !== "live" || live.revision !== this.liveRevision) {
			this.reading?.abort();
			this.liveRevision = live.revision;
			try {
				this.apply(live.status, Date.parse(live.observedAt), "live");
			} catch (error) {
				this.error = errorText(error);
			}
		}
		return true;
	}

	private apply(status: unknown, at: number, mode: "read" | "live"): void {
		const { items, unreadable } = readWork(status);
		this.items = items;
		this.unreadable = unreadable;
		this.observedAt = Number.isFinite(at) ? at : undefined;
		this.mode = mode;
		this.error = undefined;
		this.browser.setItems(workRows(items));
	}

	private async read(): Promise<void> {
		this.reading?.abort();
		const controller = new AbortController();
		this.reading = controller;
		const signal = AbortSignal.any([this.host.signal, controller.signal]);
		this.error = undefined;
		try {
			const status = await this.source.status(signal);
			if (signal.aborted) return;
			this.apply(status, Date.now(), "read");
		} catch (error) {
			if (!signal.aborted) this.error = `The declared work could not be read: ${errorText(error)}`;
		} finally {
			if (this.reading === controller) this.reading = undefined;
			this.host.requestRender();
		}
	}

	private statusText(): string {
		if (this.error) return `${this.error} · r reads again`;
		if (this.mode === "unread") return "";
		const open = this.items.filter((item) => item.state === "open").length;
		const facts = [`${open} open`, `${this.items.length - open} closed`];
		const at = this.observedAt === undefined ? "" : ` ${dashboardClock(this.observedAt)}`;
		if (this.mode === "live") facts.push("live");
		else if (this.mode === "kept") facts.push(`last live${at}; r reads again`);
		else facts.push(this.reading ? "reading…" : `read${at}`);
		if (this.unreadable) facts.push(`${this.unreadable} ${this.unreadable === 1 ? "item" : "items"} could not be read`);
		return facts.join(" · ");
	}

	private rowActions(row: WorkRow | undefined): Action[] {
		const actions: Action[] = [];
		if (row?.kind === "dependency") actions.push({ id: "read", label: "Read result", key: "enter", short: "read result", primary: true, description: "The dependency's result, read without acknowledging its delivery", run: () => this.openResult(row.dependency) });
		if (row?.kind === "report") actions.push({ id: "read", label: "Read final report", key: "enter", short: "read report", primary: true, description: "The complete retained report, page by page", run: () => this.openReport(row.item, row.close) });
		if (this.mode !== "live") actions.push({ id: "refresh", label: "Read again", key: "r", short: "read again", primary: true, disabled: this.reading ? "A read is in progress" : undefined, run: () => void this.read() });
		return actions;
	}

	private openResult(dependency: OpenWorkDependencyView): void {
		this.browser.push((child) => pagedReader(child, this.source, { kind: "answer", title: `Result ${dependency.sessionId} #${dependency.submissionId}`, call: exactCall(dependency.inspect) }));
	}

	private openReport(item: OpenWorkView, close: Close): void {
		this.browser.push((child) => pagedReader(child, this.source, { kind: "report", title: `Final report ${item.requestId}`, call: exactCall(close.read), kept: close.message }));
	}

	render(width: number, height: number): string[] {
		this.sync();
		this.browser.focused = this.focused;
		return this.browser.render(width, height);
	}
	handleInput(data: string): boolean {
		return this.browser.handleInput(data);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.browser.handleMouse(event);
	}
	actions(): readonly Action[] {
		return this.browser.actions();
	}
	keys(): readonly KeyHint[] {
		return this.browser.keys();
	}
	editing(): boolean {
		return this.browser.editing();
	}
	escape(): boolean {
		return this.browser.escape();
	}
	focusNext(backward: boolean): boolean {
		return this.browser.focusNext(backward);
	}
	focusEdge(backward: boolean): void {
		this.browser.focusEdge(backward);
	}
	invalidate(): void {
		this.browser.invalidate();
	}
	dispose(): void {
		this.reading?.abort();
	}
}

type Paging = { readonly title: string; readonly call: ResultCall } & ({ readonly kind: "answer" } | { readonly kind: "report"; readonly kept: string });

const INPUT_WORDS: Record<ResultPage["status"], string> = {
	queued: "queued: it waits for its turn",
	placed: "placed: the producer works on it and has not answered",
	done: "answered",
	unanswered: "ended without an answer",
	unavailable: "no retained result",
};

type Chunk = { readonly text: string; readonly offset: number; readonly nextOffset: number | null; readonly length?: number; readonly next?: ResultCall };

/** The page text, its offset and the exact continuation, for the kind of text this reader follows. */
function chunkOf(page: ResultPage, kind: Paging["kind"]): Chunk | undefined {
	if (page.status === "unavailable") return undefined;
	if (kind === "report") {
		const report = page.finalReport;
		if (report === undefined) return undefined;
		return { text: report.text, offset: report.offset, nextOffset: report.nextOffset, length: report.length, ...(page.finalReportContinuation === undefined ? {} : { next: exactCall(page.finalReportContinuation) }) };
	}
	if (page.answer === undefined) return undefined;
	return { text: page.answer, offset: page.offset ?? 0, nextOffset: page.nextOffset ?? null, ...(page.answerContinuation === undefined ? {} : { next: exactCall(page.answerContinuation) }) };
}

function answerHeading(page: ResultPage): string[] {
	const lines = [`Input: ${INPUT_WORDS[page.status]}`];
	if (page.requestId !== undefined) lines.push(`Request: ${page.requestId}`);
	if (page.status !== "unavailable" && page.work !== undefined) {
		const report = page.work.finalReport;
		if (page.work.state === "open") lines.push("Its request declared work that is still open: an answer is a state note, and the final report comes later.");
		else lines.push(`Its request declared work that closed${report?.status === undefined ? "" : ` (${report.status})`}: an answer is a state note, and final report ${report?.requestId ?? ""} is the result. f reads it.`);
	}
	if (page.reason !== undefined) lines.push(plainLine(page.reason));
	return lines;
}

function reportHeading(page: ResultPage, kept: string): string[] {
	if (page.status !== "unavailable" && page.finalReport !== undefined) {
		const report = page.finalReport;
		return [`Report request: ${report.requestId}`, ...(report.status === undefined ? [] : [`Status: ${report.status}`]), `Reply recipient: ${report.ownerId}`];
	}
	const lines = [page.reason === undefined ? "The host returned no report page." : plainLine(page.reason)];
	if (kept) lines.push("", "The closed work item keeps this message, which is not the retained report:", "", plainText(kept));
	return lines;
}

/**
 * A reader that follows exact continuations: each next page is read with the call the previous page
 * returned, and a page must start where the previous one ended. The joined text is the retained text.
 */
class PagedReader {
	private first?: ResultPage;
	private text = "";
	private length?: number;
	private progress = "Reading…";
	private rest?: ResultCall;
	private reading?: AbortController;
	private readonly host: ViewHost;
	private readonly source: WorkSource;
	private readonly paging: Paging;

	constructor(host: ViewHost, source: WorkSource, paging: Paging) {
		this.host = host;
		this.source = source;
		this.paging = paging;
	}

	view(): OperatorView {
		void this.read();
		return new ReaderView(this.paging.title, this.host, () => this.content(), () => this.actions());
	}

	private async read(): Promise<void> {
		this.reading?.abort();
		const controller = new AbortController();
		this.reading = controller;
		const signal = AbortSignal.any([this.host.signal, controller.signal]);
		this.first = undefined;
		this.text = "";
		this.length = undefined;
		this.rest = undefined;
		this.progress = "Reading…";
		this.host.requestRender();
		try {
			await this.follow(signal);
		} catch (error) {
			if (!signal.aborted) this.progress = `The read stopped: ${errorText(error)}`;
		} finally {
			if (this.reading === controller) this.reading = undefined;
			this.host.requestRender();
		}
	}

	/** Read pages until the text ends, a page carries no text, or the page bound leaves an exact continuation. */
	private async follow(signal: AbortSignal): Promise<void> {
		let call: ResultCall | undefined = this.paging.call;
		let expected = call.offset ?? 0;
		for (let pages = 1; call !== undefined; pages++) {
			const page = await this.page(call, signal);
			if (page === undefined) return;
			const chunk = chunkOf(page, this.paging.kind);
			if (chunk === undefined) break;
			expected = this.append(chunk, expected);
			call = this.continuation(chunk.next, pages);
		}
		if (this.rest !== undefined) this.progress = `Shown ${this.count()} characters; the text continues: ${callText(this.rest)}`;
		else this.progress = this.text ? `Complete: ${this.text.length} characters` : "";
	}

	/** Append one page that starts where the text ends; returns the offset where the next page must start. */
	private append(chunk: Chunk, expected: number): number {
		if (chunk.offset !== expected) throw new Error(`A page started at offset ${chunk.offset}, not at ${expected}`);
		this.text += chunk.text;
		this.length = chunk.length;
		return chunk.nextOffset ?? expected + chunk.text.length;
	}

	/** The next exact call, or undefined at the page bound, which keeps that call to show. */
	private continuation(next: ResultCall | undefined, pages: number): ResultCall | undefined {
		if (next !== undefined && pages >= WORK_READ_PAGES) {
			this.rest = next;
			return undefined;
		}
		this.progress = next === undefined ? "" : `Reading… ${this.count()} characters`;
		this.host.requestRender();
		return next;
	}

	/** One page, or undefined once the read was aborted, so a stale page never changes the text. */
	private async page(call: ResultCall, signal: AbortSignal): Promise<ResultPage | undefined> {
		const value = await this.source.inspect(call, signal);
		if (signal.aborted) return undefined;
		if (!matchesSchema(ResultOutputSchema, value)) throw new Error("The host answered with an unreadable result page");
		this.first ??= value;
		return value;
	}

	private count(): string {
		return `${this.text.length}${this.length === undefined ? "" : ` of ${this.length}`}`;
	}

	private content(): string {
		const first = this.first;
		const heading = first === undefined ? [] : this.paging.kind === "report" ? reportHeading(first, this.paging.kept) : answerHeading(first);
		return [this.paging.title, ...heading, ...(this.progress ? [this.progress] : []), ...(this.text ? ["", plainText(this.text)] : [])].join("\n");
	}

	private actions(): Action[] {
		const list: Action[] = [{ id: "refresh", label: "Read again", key: "r", short: "read again", primary: true, disabled: this.reading ? "A read is in progress" : undefined, run: () => void this.read() }];
		const report = this.first?.status === "unavailable" ? undefined : this.first?.work?.finalReport;
		if (this.paging.kind === "answer" && report !== undefined) {
			const call = exactCall(report.read as FinalReportRead);
			const title = `Final report ${report.requestId}`;
			list.unshift({ id: "report", label: "Read its final report", key: "f", short: "final report", primary: true, description: title, run: () => this.host.push((child) => pagedReader(child, this.source, { kind: "report", title, call, kept: "" })) });
		}
		return list;
	}
}

function pagedReader(host: ViewHost, source: WorkSource, paging: Paging): OperatorView {
	return new PagedReader(host, source, paging).view();
}
