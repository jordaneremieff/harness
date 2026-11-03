/** Object-keyed validation of stored data and host-protocol JSON Schemas. */
import { compile, type Static, type Validator } from "@earendil-works/pi-schema";

const validators = new WeakMap<object, Validator<unknown>>();

function validator(schema: object): Validator<unknown> {
	let compiled = validators.get(schema);
	if (compiled === undefined) {
		compiled = compile(schema);
		validators.set(schema, compiled);
	}
	return compiled;
}

/**
 * JSON has no NaN or Infinity, but pi-schema's `number` accepts them; the data
 * validated here is JSON, so a non-finite number never matches.
 */
function finiteNumbers(value: unknown): boolean {
	if (typeof value === "number") return Number.isFinite(value);
	if (value === null || typeof value !== "object") return true;
	if (Array.isArray(value)) return value.every(finiteNumbers);
	return Object.values(value).every(finiteNumbers);
}

/** Whether `value` matches `schema` and contains only finite JSON numbers. */
export function matchesSchema<T extends object>(schema: T, value: unknown): value is Static<T> {
	return validator(schema).check(value) && finiteNumbers(value);
}

/** The first `limit` mismatches as `<path> <message>`, with `/` for the root. */
export function schemaErrors(schema: object, value: unknown, limit: number): string[] {
	return validator(schema).errors(value).slice(0, limit).map((error) => `${error.path === "" ? "/" : error.path} ${error.message}`);
}
