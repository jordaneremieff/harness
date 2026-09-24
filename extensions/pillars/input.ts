/** Input diagnostics never serialize arbitrary objects, paths, tokens, or string bodies. */
export function received(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return `array (${value.length} items; contents withheld)`;
	if (typeof value === "string") return `string (${value.length} code units; contents withheld)`;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return typeof value;
}

export class InputError extends Error {
	constructor(field: string, value: unknown, valid: string) {
		super(`${field}: received ${received(value)}. ${valid}`);
	}
}

export function inputObject(input: unknown, fields: readonly string[]): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input)))
		throw new InputError("input", input, "Send a JSON object; use {} for defaults.");
	const args = input as Record<string, unknown>;
	for (const key of Object.keys(args)) {
		if (!fields.includes(key))
			throw new InputError("input", key, `Remove the unsupported field (name withheld). Only ${fields.join(", ")} are valid fields; use {} for defaults.`);
	}
	return args;
}
