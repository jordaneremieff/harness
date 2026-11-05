export function dashboardTime(at: number, exact: boolean, now = Date.now()): string {
	if (!exact) {
		const minutes = Math.max(0, Math.floor((now - at) / 60000));
		return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
	}
	return new Date(at).toLocaleString("en-US", {
		year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
	});
}

/** A fixed local time for retained records: the clock time today, the date and time on other days. */
export function dashboardClock(at: number, now = Date.now()): string {
	const date = new Date(at);
	const today = new Date(now);
	const clock = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
	if (date.toDateString() === today.toDateString()) return clock;
	const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
	return `${day}, ${clock}`;
}
