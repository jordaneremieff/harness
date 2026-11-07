/**
 * agent/observation-pump: latest-state scheduling for observation work.
 *
 * Invalidation sets one dirty bit. A pass runs at most once per interval and
 * never overlaps another pass. Work that arrives during a pass keeps the dirty
 * bit, so the next pass carries the newest state instead of rebuilding for
 * every intermediate change. The caller's clock supplies waiting, which keeps
 * the cadence testable without wall-clock timers. The default clock measures
 * elapsed time with the monotonic clock, so a wall-clock correction does not
 * delay or rush a pass.
 */

export interface ObservationClock {
	now(): number;
	/** Run `run` after `delayMs`; the returned function cancels the wait. */
	after(delayMs: number, run: () => void): () => void;
}

export interface ObservationPump {
	/** Request a pass for the current state. Cheap; safe to call for every change. */
	markDirty(): void;
	/** Drop a waiting pass and its dirty state. An in-flight pass finishes. */
	cancelPending(): void;
	/** Stop the pump. Later marks do nothing. */
	dispose(): void;
}

export interface ObservationPumpOptions {
	/** Minimum time between pass starts. */
	readonly intervalMs: number;
	readonly run: () => void | Promise<void>;
	readonly onError: (error: unknown) => void;
	readonly clock?: ObservationClock;
}

const monotonicClock: ObservationClock = {
	now: () => performance.now(),
	after(delayMs, run) {
		const timer = setTimeout(run, delayMs);
		return () => clearTimeout(timer);
	},
};

/**
 * Create one latest-state pump. The first mark after a quiet period runs
 * without waiting; later marks wait for the interval measured from the last
 * pass start. A mark during a pass waits for that pass to settle.
 */
export function createObservationPump(options: ObservationPumpOptions): ObservationPump {
	if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) throw new RangeError("observation pump intervalMs must be a finite nonnegative number");
	const clock = options.clock ?? monotonicClock;
	let dirty = false;
	let pending: (() => void) | undefined;
	let inFlight = false;
	let lastStart: number | undefined;
	let disposed = false;

	function schedule(): void {
		if (disposed || inFlight || pending !== undefined || !dirty) return;
		const delay = lastStart === undefined ? 0 : Math.max(0, lastStart + options.intervalMs - clock.now());
		pending = clock.after(delay, () => {
			pending = undefined;
			void pass();
		});
	}

	async function pass(): Promise<void> {
		if (disposed || !dirty) return;
		dirty = false;
		inFlight = true;
		lastStart = clock.now();
		try {
			await options.run();
		} catch (error) {
			try { options.onError(error); } catch { /* A failure report must not break later passes. */ }
		} finally {
			inFlight = false;
			if (!disposed && dirty) schedule();
		}
	}

	return {
		markDirty() {
			if (disposed) return;
			dirty = true;
			schedule();
		},
		cancelPending() {
			dirty = false;
			pending?.();
			pending = undefined;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			dirty = false;
			pending?.();
			pending = undefined;
		},
	};
}
