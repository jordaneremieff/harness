/**
 * Retains task-scoped extension failures of the Durable scheduler as model-less transcript evidence.
 *
 * Only an `extension_error` report that names a task is admitted. The scheduler emits these for a hook
 * that threw, a section that failed to render and a tool's invalid structured output; the public report
 * shape does not tell them apart. Every other report is ignored: other kinds, and an `extension_error`
 * without a task, such as an agent composition failure. Agent's own observer, recovery and
 * provider-notice diagnostics carry no task, and a rejected write of this sink is reported outside any
 * task, so retention can never feed itself.
 */
import { types } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness, Report } from "@earendil-works/pi-durable";
import { safeProviderError } from "./primary-observation.ts";

/** Entry kind of one retained report. The entry has `data` only, so it adds nothing to model context. */
export const TASK_HOOK_REPORT_KIND = "agent.host-report";
export const TASK_HOOK_REPORT_FORMAT = "agent.task-extension-error/1";

/** Reports held at once: those waiting for a storage owner or a turn, plus the one write in flight. */
const PENDING_LIMIT = 32;
/** Byte bound of one entry's serialized `data`. */
const ENTRY_DATA_BYTES = 4096;
const MESSAGE_BYTES = 2048;
const NAME_BYTES = 160;
/** Longest wait of an orderly close for writes already admitted. */
const DRAIN_WAIT_MS = 250;
const MESSAGE_UNAVAILABLE = "[error message unavailable]";
const MESSAGE_OVERSIZED = "[error message omitted: entry byte bound]";

type TaskHookReportData = {
	format: typeof TASK_HOOK_REPORT_FORMAT;
	kind: "extension_error";
	taskId: number;
	taskKind: string;
	extension?: string;
	/** Main message after credential-pattern redaction, control escaping and a byte bound. Never a stack or cause. */
	message: string;
	redacted: boolean;
	truncated: boolean;
	observedAt: number;
	/** Admissible reports dropped by the pending bound since the previous retained report. */
	omittedReports: number;
};
type Pending = { readonly conversationId: ConversationId; readonly data: TaskHookReportData };

/**
 * The main message, read as data only: an explicit string, or an own string `message` data property.
 * No getter, proxy trap or `toString` runs, and `stack` and `cause` are never read.
 */
function mainMessage(error: unknown): string {
	if (typeof error === "string") return error;
	if (error === null || typeof error !== "object" || types.isProxy(error)) return MESSAGE_UNAVAILABLE;
	const value: unknown = Object.getOwnPropertyDescriptor(error, "message")?.value;
	return typeof value === "string" ? value : MESSAGE_UNAVAILABLE;
}

function positiveId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function fitsEntry(data: TaskHookReportData): boolean {
	return Buffer.byteLength(JSON.stringify(data)) <= ENTRY_DATA_BYTES;
}

function retainedReport(report: Report, observedAt: number, omittedReports: number): Pending | undefined {
	if (report.kind !== "extension_error" || report.task === undefined) return undefined;
	const { task } = report;
	if (!positiveId(task.id) || !positiveId(task.conversationId) || typeof task.kind !== "string") return undefined;
	if (!Number.isSafeInteger(observedAt) || observedAt < 0) return undefined;
	const message = safeProviderError(mainMessage(report.error), MESSAGE_BYTES);
	const taskKind = safeProviderError(task.kind, NAME_BYTES);
	const extension = typeof report.extension === "string" ? safeProviderError(report.extension, NAME_BYTES) : undefined;
	const data: TaskHookReportData = {
		format: TASK_HOOK_REPORT_FORMAT,
		kind: "extension_error",
		taskId: task.id,
		taskKind: taskKind.text,
		...(extension === undefined ? {} : { extension: extension.text }),
		message: message.text,
		redacted: message.redacted || taskKind.redacted || extension?.redacted === true,
		truncated: message.truncated || taskKind.truncated || extension?.truncated === true,
		observedAt,
		omittedReports,
	};
	if (!fitsEntry(data)) {
		data.message = MESSAGE_OVERSIZED;
		data.truncated = true;
		if (!fitsEntry(data)) return undefined;
	}
	return { conversationId: task.conversationId, data };
}

/**
 * One bounded serial sink. Reports recorded before `bind` wait in the pending queue; after `bind` each is
 * written by its own commit, one at a time. A rejected write disables the sink for the rest of its life.
 */
export class TaskHookReports {
	private harness: Harness | undefined;
	private readonly queue: Pending[] = [];
	private running: Promise<void> | undefined;
	private closing: Promise<void> | undefined;
	private writing = false;
	private sealed = false;
	private closed = false;
	private failed = false;
	private omitted = 0;
	private droppedCount = 0;
	private readonly onFailure: (error: unknown) => void;
	private readonly now: () => number;

	/**
	 * `onFailure` receives the rejection that disabled the sink, at most once and never after `close`
	 * returns. It must stay outside any task: a diagnostic it raises must not be a task-scoped report.
	 */
	constructor(onFailure: (error: unknown) => void = () => {}, now: () => number = Date.now) {
		this.onFailure = onFailure;
		this.now = now;
	}

	/** Admissible reports that were not written: pending bound, unusable shape, disabled sink, or close. */
	get dropped(): number {
		return this.droppedCount;
	}

	/** Never throws and never waits; safe to call from the Harness report callback. */
	record(report: Report): void {
		try {
			if (report.kind !== "extension_error" || report.task === undefined) return;
			if (this.sealed || this.failed) {
				this.droppedCount++;
				return;
			}
			if (this.queue.length + (this.writing ? 1 : 0) >= PENDING_LIMIT) {
				this.droppedCount++;
				this.omitted++;
				return;
			}
			const retained = retainedReport(report, this.now(), this.omitted);
			if (retained === undefined) {
				this.droppedCount++;
				return;
			}
			this.omitted = 0;
			this.queue.push(retained);
			this.schedule();
		} catch {
			this.droppedCount++;
		}
	}

	/** Give the sink its storage owner and start writing the pending reports. */
	bind(harness: Harness): void {
		if (this.harness !== undefined) throw new Error("Task hook reports already have a storage owner");
		if (this.sealed) return;
		this.harness = harness;
		this.schedule();
	}

	private schedule(): void {
		const harness = this.harness;
		if (harness === undefined || this.running !== undefined || this.failed || this.queue.length === 0) return;
		this.running = this.drain(harness).finally(() => {
			this.running = undefined;
			this.schedule();
		});
	}

	private async drain(harness: Harness): Promise<void> {
		for (let item = this.queue.shift(); item !== undefined; item = this.queue.shift()) {
			const { conversationId, data } = item;
			this.writing = true;
			try {
				await harness.commit((tx) => tx.appendEntry(conversationId, { kind: TASK_HOOK_REPORT_KIND, data }), BACKGROUND_CONTEXT);
			} catch (error) {
				this.disable(error);
				return;
			} finally {
				this.writing = false;
			}
		}
	}

	private disable(error: unknown): void {
		this.failed = true;
		this.droppedCount += this.queue.length + 1;
		this.queue.length = 0;
		if (this.closed) return;
		try {
			this.onFailure(error);
		} catch {
			// A failing diagnostic must not become another report.
		}
	}

	/** Settles when no write is in flight and none is pending for a bound sink. Unbounded: a stalled write stalls it. */
	async flush(): Promise<void> {
		while (this.running !== undefined) await this.running;
	}

	/**
	 * Admit no further report, then wait a bounded time for admitted writes. Reports still pending at the
	 * bound are dropped; a write already in flight stays with the Harness, which settles it at its own close.
	 */
	close(): Promise<void> {
		this.closing ??= this.finish();
		return this.closing;
	}

	private async finish(): Promise<void> {
		this.sealed = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (this.harness !== undefined) {
				const bound = new Promise<void>((resolve) => {
					timer = setTimeout(resolve, DRAIN_WAIT_MS);
				});
				await Promise.race([this.flush(), bound]);
			}
		} finally {
			clearTimeout(timer);
			this.droppedCount += this.queue.length;
			this.queue.length = 0;
			this.closed = true;
		}
	}
}
