import type { ObservationClock } from "./observation-pump.ts";

export interface ManualClock extends ObservationClock {
	/** Move time forward and run every timer that becomes due. */
	advance(ms: number): void;
	/** Timers waiting for time to move, after any cancellation. */
	readonly pending: number;
}

interface Timer {
	readonly due: number;
	readonly run: () => void;
}

/** A deterministic clock for scheduler tests; nothing runs on its own. */
export function manualClock(start = 0): ManualClock {
	let now = start;
	let next = 0;
	const timers = new Map<number, Timer>();
	const earliestDue = (): number | undefined => {
		let found: number | undefined;
		for (const [id, timer] of timers) if (timer.due <= now && (found === undefined || timer.due < (timers.get(found)?.due ?? Infinity))) found = id;
		return found;
	};
	return {
		now: () => now,
		after(delayMs, run) {
			const id = ++next;
			timers.set(id, { due: now + Math.max(0, delayMs), run });
			return () => { timers.delete(id); };
		},
		advance(ms) {
			now += ms;
			for (let id = earliestDue(); id !== undefined; id = earliestDue()) {
				const timer = timers.get(id);
				timers.delete(id);
				timer?.run();
			}
		},
		get pending() {
			return timers.size;
		},
	};
}
