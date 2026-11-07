/** Parse one requested deadline: epoch milliseconds or an ISO 8601 date-time string. */
export function parseDeliverAt(value: unknown): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Date.parse(value)
				: Number.NaN;
	if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error("deliverAt must be an epoch-millisecond time or an ISO 8601 date-time string");
	}
	return parsed;
}
