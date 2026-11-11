/** Observation time follows process elapsed time from one wall-clock origin. */
export interface ObservationClock {
	now(): number;
}

export function createObservationClock(
	wallNow: () => number = Date.now,
	monotonicNow: () => number = () => performance.now(),
): ObservationClock {
	const wallOrigin = wallNow();
	const monotonicOrigin = monotonicNow();
	return { now: () => wallOrigin + (monotonicNow() - monotonicOrigin) };
}
