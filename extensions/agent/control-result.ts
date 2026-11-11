/** Render a host control result for the model without losing structure. */
export function controlText(value: unknown): string {
	if (value === undefined) return "Host control completed without a result.";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return "Host control returned a result that cannot be printed.";
	}
}
