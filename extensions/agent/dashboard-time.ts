export function dashboardTime(at: number, exact: boolean, now = Date.now()): string {
	if (!exact) {
		const minutes = Math.max(0, Math.floor((now - at) / 60000));
		return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
	}
	return new Date(at).toLocaleString("en-US", {
		year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
	});
}
