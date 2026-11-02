/**
 * Validation of TypeBox-built JSON Schemas through pi-schema.
 *
 * Tool parameter and output schemas stay TypeBox because Pi's tool contract
 * types them that way; the same schemas validate stored and host-protocol data
 * here. TypeBox schemas are JSON Schema, so pi-schema compiles them as they are.
 * Each schema compiles once.
 */
import { compile, type Validator } from "@earendil-works/pi-schema";
import type { Static, TSchema } from "typebox";

const validators = new WeakMap<TSchema, Validator<unknown>>();

function validator(schema: TSchema): Validator<unknown> {
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

/** Whether `value` matches `schema`; narrows to the schema's TypeBox static type. */
export function matchesSchema<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
	return validator(schema).check(value) && finiteNumbers(value);
}

/** The first `limit` mismatches as `<path> <message>`, with `/` for the root. */
export function schemaErrors(schema: TSchema, value: unknown, limit: number): string[] {
	return validator(schema).errors(value).slice(0, limit).map((error) => `${error.path === "" ? "/" : error.path} ${error.message}`);
}
