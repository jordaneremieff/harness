import type { Participant } from "./participants.ts";

export type RequestState = "queued" | "working" | "answered" | "failed";
export type FileEvent = {
	type: "file";
	path: string;
	change: "modified" | "created" | "deleted";
	by?: Participant;
	thread?: string;
};
export type ShowEvent = {
	type: "show";
	by: Participant;
	doc: string;
	start?: number;
	end?: number;
	line?: number;
	message?: string;
};
export type PaneEvent =
	| { type: "workspace"; seq: number }
	| FileEvent
	| { type: "attach"; participant: Participant; doc?: string; line?: number }
	| ShowEvent
	| { type: "members"; members: Participant[] }
	| { type: "request"; thread: string; state: RequestState; by: Participant; at: number };

const RETAINED = 512;
const EVENT_BYTES = 2 * 1024 * 1024;
const WAIT_MS = 20_000;

export class PaneEvents {
	#cursor = 1;
	#retained: { cursor: number; event: PaneEvent; bytes: number }[] = [];
	#retainedBytes = 0;
	#waiters = new Set<() => void>();

	publish(event: PaneEvent): void {
		const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
		this.#retained.push({ cursor: ++this.#cursor, event, bytes });
		this.#retainedBytes += bytes;
		while (this.#retained.length > RETAINED || this.#retainedBytes > EVENT_BYTES) {
			this.#retainedBytes -= this.#retained.shift()?.bytes ?? 0;
		}
		for (const wake of this.#waiters) wake();
	}

	async after(since: number, signal: AbortSignal, state: () => PaneEvent[]) {
		if (!Number.isSafeInteger(since) || since < 0) throw Error("Invalid Editor event cursor.");
		if (since === 0) return { cursor: this.#cursor, events: [] };
		if (since === this.#cursor) {
			signal.throwIfAborted();
			if (this.#waiters.size >= 32) throw Error("Too many Editor event requests.");
			await new Promise<void>((resolve) => {
				const wake = () => {
					clearTimeout(timer);
					this.#waiters.delete(wake);
					signal.removeEventListener("abort", wake);
					resolve();
				};
				const timer = setTimeout(wake, WAIT_MS);
				this.#waiters.add(wake);
				signal.addEventListener("abort", wake, { once: true });
			});
		}
		const first = this.#retained[0]?.cursor ?? this.#cursor + 1;
		const missed = since < first - 1 || since > this.#cursor;
		return {
			cursor: this.#cursor,
			events: missed ? state() : this.#retained.filter((item) => item.cursor > since).map((item) => item.event),
		};
	}
}
