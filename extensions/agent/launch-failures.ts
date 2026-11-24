/**
 * Failed automatic launches of each storage inside a sliding window. A recovery launch that keeps failing would
 * otherwise run again at every catalog notice. Inside one window a storage gets `limit` automatic launches; the
 * next one waits until the oldest failure leaves the window. An explicit act is not automatic: a caller does not
 * ask `capped` for a primary registration, and `clear` forgets a storage that an attachment names or whose
 * launch succeeded.
 */
export class LaunchFailures {
	private readonly storages = new Map<string, { times: number[]; reported?: string }>();
	private readonly limit: number;
	private readonly windowMs: number;
	private readonly bound: number;
	private readonly now: () => number;

	constructor(options: { limit: number; windowMs: number; storages: number; now?: () => number }) {
		this.limit = options.limit;
		this.windowMs = options.windowMs;
		this.bound = options.storages;
		this.now = options.now ?? (() => Date.now());
	}

	/** The storage's entry with only the failures of the current window; an empty window forgets the storage. */
	private current(storageId: string, now: number): { times: number[]; reported?: string } | undefined {
		const entry = this.storages.get(storageId);
		if (entry === undefined) return undefined;
		entry.times = entry.times.filter((time) => now - time < this.windowMs);
		if (entry.times.length > 0) return entry;
		this.storages.delete(storageId);
		return undefined;
	}

	/** True while the storage has used the automatic launches of its window. */
	capped(storageId: string): boolean {
		return this.waitsUntil(storageId) !== undefined;
	}

	/** The time at which a storage that waits may launch again: its oldest failure then leaves the window. */
	waitsUntil(storageId: string): number | undefined {
		const times = this.current(storageId, this.now())?.times;
		return times !== undefined && times.length >= this.limit ? (times[0] as number) + this.windowMs : undefined;
	}

	/**
	 * Record one failed launch. Returns the text to report, or undefined when this window already reported it:
	 * the first failure reports the error, and the failure that uses the last automatic launch reports the wait.
	 */
	failed(storageId: string, error: string): string | undefined {
		const now = this.now();
		const entry = this.current(storageId, now) ?? { times: [] };
		entry.times = [...entry.times, now].slice(-this.limit);
		this.storages.delete(storageId);
		this.storages.set(storageId, entry);
		while (this.storages.size > this.bound) {
			const oldest = this.storages.keys().next().value;
			if (oldest === undefined) break;
			this.storages.delete(oldest);
		}
		const text = entry.times.length >= this.limit ? this.waitText(error) : error;
		if (entry.reported === text) return undefined;
		entry.reported = text;
		return text;
	}

	clear(storageId: string): void {
		this.storages.delete(storageId);
	}

	/** The wait comes first, so a display that cuts a long text still states it. */
	private waitText(error: string): string {
		return `Recovery waits after ${this.limit} failed launches in ${this.windowMs / 1000} seconds; agent_attach or a primary registration tries at once. Last error: ${error}`;
	}
}

/**
 * One timer for the earliest time at which a waiting storage may launch again. A read that skips a waiting
 * storage asks for a replay; without it nothing would read the catalog again on a quiet machine, because a failed
 * launch causes no catalog notice. Many requests keep one timer, and it never holds the process open.
 */
export class LaunchReplay {
	private pending: { at: number; timer: ReturnType<typeof setTimeout> } | undefined;
	private closed = false;
	private readonly replay: () => void;
	private readonly now: () => number;

	constructor(replay: () => void, now: () => number = () => Date.now()) {
		this.replay = replay;
		this.now = now;
	}

	/** Ask for a replay at `at`. A pending replay that is due no later stays; a later one moves forward. */
	arm(at: number): void {
		if (this.closed || (this.pending !== undefined && this.pending.at <= at)) return;
		if (this.pending !== undefined) clearTimeout(this.pending.timer);
		const timer = setTimeout(
			() => {
				this.pending = undefined;
				this.replay();
			},
			Math.max(1, at - this.now()),
		);
		timer.unref?.();
		this.pending = { at, timer };
	}

	close(): void {
		this.closed = true;
		if (this.pending !== undefined) clearTimeout(this.pending.timer);
		this.pending = undefined;
	}
}
