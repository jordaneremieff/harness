export function dashboardTime(at: number, exact: boolean): string {
	const date = new Date(at);
	return exact
		? date.toISOString()
		: date.toLocaleString("en-US", {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
				hour12: true,
			});
}
