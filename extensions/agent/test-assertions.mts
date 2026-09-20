import assert from "node:assert/strict";

/** Assert that a fixture or observation exists before its fields are inspected. */
export function defined<T>(value: T | null | undefined): T {
	assert.ok(value !== undefined && value !== null, "Expected a fixture value or observed result");
	return value;
}
