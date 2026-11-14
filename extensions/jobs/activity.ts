import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompletionJob } from "./completion.ts";

/**
 * Job activity outside the transcript: a footer status while jobs run, and one child record per job in the
 * terminal's program status records (OSC 7501, a generic terminal protocol). Records carry only facts of the job
 * record, never command text or output, because terminals can forward them to notifications and other devices.
 */

export const ACTIVITY_LIMITS = Object.freeze({
	settledRecords: 8,
	messageChars: 160,
	messageBytes: 2048,
	titleChars: 64,
	titleBytes: 192,
	sequenceBytes: 4096,
});
export const FOOTER_STATUS_KEY = "jobs";
const RECORD_TITLE = "Background job";
const ID_SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/u;
const ID_PATH = /^[A-Za-z0-9_.+-]{1,32}(?:\/[A-Za-z0-9_.+-]{1,32}){0,7}$/u;

export type StatusRecordState = "working" | "done" | "error" | "clear";
export interface StatusRecord {
	id: string;
	state: StatusRecordState;
	title?: string;
	msg?: string;
}

/** The record id for a job, or undefined when the job id cannot form one protocol id segment. */
export function recordId(jobId: string): string | undefined {
	const segment = jobId.replaceAll("-", "");
	return ID_SEGMENT.test(segment) ? `jobs/${segment}` : undefined;
}

/** Single-line text: control characters become spaces, then the text is cut on code point boundaries. */
function fitText(text: string, maxChars: number, maxBytes: number): string {
	const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
	let kept = "";
	let chars = 0;
	let bytes = 0;
	for (const character of flat) {
		const size = Buffer.byteLength(character);
		if (chars + 1 > maxChars || bytes + size > maxBytes) break;
		kept += character;
		chars += 1;
		bytes += size;
	}
	return kept.trimEnd();
}

/** One report: `ESC ] 7501 ; key=value:key=value ESC \`, with base64 free text. A clear report carries only its id. */
export function formatStatusRecord(record: StatusRecord): string {
	if (!ID_PATH.test(record.id) || Buffer.byteLength(record.id) > 128) throw new Error("Invalid status record id");
	const pairs = [`state=${record.state}`, `id=${record.id}`];
	if (record.state !== "clear") {
		const title = fitText(record.title ?? "", ACTIVITY_LIMITS.titleChars, ACTIVITY_LIMITS.titleBytes);
		if (title) pairs.push(`title=${Buffer.from(title, "utf8").toString("base64")}`);
		const msg = fitText(record.msg ?? "", ACTIVITY_LIMITS.messageChars, ACTIVITY_LIMITS.messageBytes);
		if (msg) pairs.push(`msg=${Buffer.from(msg, "utf8").toString("base64")}`);
	}
	const sequence = `\x1b]7501;${pairs.join(":")}\x1b\\`;
	if (Buffer.byteLength(sequence) >= ACTIVITY_LIMITS.sequenceBytes) throw new Error("Status record exceeds the sequence limit");
	return sequence;
}

/** Whole minutes between the record's own start and end times. */
export function elapsedText(startedAt: number, endedAt: number): string {
	const minutes = Math.floor(Math.max(0, endedAt - startedAt) / 60_000);
	return minutes < 1 ? "< 1 min" : `${minutes} min`;
}

/**
 * What is known about the completion message. `queued`: Pi was busy when the message was sent and holds it for
 * the conversation. `sent`: Pi was idle when the message was sent and it is not in the conversation yet.
 * `added`: an exact signal showed the message in the conversation. `absent`: a run settled and the message is not
 * in the conversation; Pi may still hold it or may have discarded it. `unsent`: sending failed at once.
 */
export type Delivery = "queued" | "sent" | "added" | "absent" | "unsent";
const DELIVERY_TEXT: Record<Delivery, string> = {
	queued: "completion queued for the conversation",
	sent: "completion sent, not in the conversation",
	added: "completion in the conversation",
	absent: "completion not in the conversation",
	unsent: "completion not sent",
};

/** Delivery states that a later signal can still change to `added`. */
export function awaitsConversation(delivery: Delivery | undefined): boolean {
	return delivery === "queued" || delivery === "sent" || delivery === "absent";
}

/** The settled record's message: the job outcome, then the delivery state when one is known. */
export function settledMessage(job: CompletionJob, delivery?: Delivery): string {
	const elapsed = job.endedAt === undefined ? undefined : elapsedText(job.startedAt, job.endedAt);
	const parts: string[] = [];
	if (job.status === "timed_out") parts.push(elapsed === undefined ? "Background job timed out" : `Background job timed out after ${elapsed}`);
	else {
		const outcome = job.status === "succeeded" ? "succeeded" : job.status === "lost" ? "lost" : "failed";
		parts.push(`Background job ${outcome}`);
		if (typeof job.exitCode === "number") parts.push(`exit ${job.exitCode}`);
		if (elapsed !== undefined) parts.push(elapsed);
	}
	if (delivery) parts.push(DELIVERY_TEXT[delivery]);
	return parts.join(" · ");
}

export function footerText(running: number): string | undefined {
	return running > 0 ? `jobs: ${running} running` : undefined;
}

export interface ActivityOutput {
	write(text: string): void;
	isTTY: () => boolean;
	env: () => Record<string, string | undefined>;
}

const processOutput: ActivityOutput = {
	write: (text) => {
		process.stdout.write(text);
	},
	isTTY: () => process.stdout.isTTY === true,
	env: () => process.env,
};

type FooterContext = Pick<ExtensionContext, "hasUI" | "mode" | "ui">;

const settledState = (job: CompletionJob): StatusRecordState => (job.status === "succeeded" ? "done" : "error");

/** Tracks this session's jobs for the footer and the terminal; every call after shutdown has no effect. */
export function createJobActivity(output: ActivityOutput = processOutput) {
	const running = new Map<string, string | undefined>();
	/** Retained settled records by job id, oldest first; each keeps what its rewrite needs. */
	const settled = new Map<string, { id: string; job: CompletionJob; delivery?: Delivery }>();
	let footer: FooterContext | undefined;
	let closed = false;

	const terminalEnabled = (ctx: FooterContext) =>
		ctx.mode === "tui" && output.isTTY() && output.env().PI_PROGRAM_STATUS !== "0";
	const write = (record: StatusRecord) => output.write(formatStatusRecord(record));
	const showFooter = () => {
		if (footer?.hasUI) footer.ui.setStatus(FOOTER_STATUS_KEY, footerText(running.size));
	};

	return {
		start(job: CompletionJob, ctx: FooterContext): void {
			if (closed) return;
			footer = ctx;
			const id = terminalEnabled(ctx) ? recordId(job.id) : undefined;
			running.set(job.id, id);
			if (id) write({ id, state: "working", title: RECORD_TITLE, msg: "Background job running" });
			showFooter();
		},
		settle(job: CompletionJob, delivery?: Delivery): void {
			if (closed || !running.has(job.id)) return;
			const id = running.get(job.id);
			running.delete(job.id);
			if (id) {
				write({ id, state: settledState(job), title: RECORD_TITLE, msg: settledMessage(job, delivery) });
				settled.set(job.id, { id, job, delivery });
				for (const [jobId, record] of settled) {
					if (settled.size <= ACTIVITY_LIMITS.settledRecords) break;
					settled.delete(jobId);
					write({ id: record.id, state: "clear" });
				}
			}
			showFooter();
		},
		/** Ids of the jobs that run now. */
		runningJobs(): string[] {
			return closed ? [] : [...running.keys()];
		},
		/**
		 * Rewrites the records of the given jobs that still run after the session's run settled, with what their
		 * completion will do: start the next turn, or wait for the next prompt after an aborted run. Returns the
		 * records written.
		 */
		runSettled(next: "turn" | "prompt", jobIds: readonly string[]): number {
			if (closed) return 0;
			const msg = `Background job running · ${next === "turn" ? "its completion starts the next turn" : "its completion waits for the next prompt"}`;
			let written = 0;
			for (const jobId of jobIds) {
				const id = running.get(jobId);
				if (!id) continue;
				write({ id, state: "working", title: RECORD_TITLE, msg });
				written += 1;
			}
			return written;
		},
		/** Rewrites a retained settled record with a new delivery state; an evicted or unchanged record writes nothing. */
		deliver(jobId: string, delivery: Delivery): void {
			const record = settled.get(jobId);
			if (closed || !record || record.delivery === delivery) return;
			record.delivery = delivery;
			write({ id: record.id, state: settledState(record.job), title: RECORD_TITLE, msg: settledMessage(record.job, delivery) });
		},
		/** Job ids of retained settled records whose completion is not yet known to be in the conversation. */
		awaiting(): string[] {
			if (closed) return [];
			return [...settled].flatMap(([jobId, record]) => (awaitsConversation(record.delivery) ? [jobId] : []));
		},
		cancel(job: CompletionJob): void {
			if (closed || !running.has(job.id)) return;
			const id = running.get(job.id);
			running.delete(job.id);
			if (id) write({ id, state: "clear" });
			showFooter();
		},
		/** Clears records of jobs that still run; settled records stay for the terminal to show or clear. */
		shutdown(ctx?: FooterContext): void {
			if (closed) return;
			closed = true;
			for (const id of running.values()) if (id) write({ id, state: "clear" });
			running.clear();
			if (ctx) footer = ctx;
			showFooter();
		},
	};
}
export type JobActivity = ReturnType<typeof createJobActivity>;
