/** Render a host control result for the model without losing structure. */
export function controlText(value: unknown): string {
	if (value === undefined) return "Host control completed without a result.";
	if (typeof value === "string") return value;
	try {
		const state = value as { retiring?: unknown; live?: unknown } | null;
		const cold = typeof state?.retiring === "boolean" && state?.live === false;
		const text = JSON.stringify(value);
		return cold ? `The agent is not running.\n${text}` : text;
	} catch {
		return "Host control returned a result that cannot be printed.";
	}
}
