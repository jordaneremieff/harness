import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { availabilityFailure, fallbackModelsFor, normalizeFallback } from "./fallback.ts";

describe("declared model fallback", () => {
	it("selects only explicit or configured rosters with bounded validation", () => {
		const config = JSON.stringify({ default: ["one/model"], review: ["two/model"] });
		assert.deepEqual(fallbackModelsFor(undefined, undefined, undefined), []);
		assert.deepEqual(fallbackModelsFor(undefined, undefined, config), ["one/model"]);
		assert.deepEqual(fallbackModelsFor(undefined, "review", config), ["two/model"]);
		assert.deepEqual(fallbackModelsFor([], "review", "invalid"), []);
		assert.deepEqual(fallbackModelsFor(["three/model"], "review", config), ["three/model"]);
		for (const raw of ["", "[]", "null", '{"review":["bare"]}', '{"bad class":[]}', "x".repeat(17000)]) {
			assert.throws(() => fallbackModelsFor(undefined, undefined, raw));
		}
		assert.throws(() => fallbackModelsFor(undefined, "missing", config));
		assert.throws(() => fallbackModelsFor(undefined, "review", undefined));
		assert.throws(() => fallbackModelsFor(["one/model", "one/model"], undefined, undefined));
		assert.throws(() =>
			fallbackModelsFor(
				Array.from({ length: 5 }, (_, i) => `p/m${i}`),
				undefined,
				undefined,
			),
		);
	});
	it("does not classify unrelated failures as availability failures", () => {
		for (const text of ["401 unauthorized", "invalid_api_key", "authentication failed", "token expired"])
			assert.equal(availabilityFailure(text), "authentication");
		for (const text of ["402 payment required", "insufficient_quota", "credit balance is too low", "quota exhausted"])
			assert.equal(availabilityFailure(text), "quota");
		assert.equal(availabilityFailure("429 Too many requests"), "rate-limit");
		for (const text of [
			"403 forbidden",
			"400 invalid schema",
			"tool failed",
			"EOF",
			"network timeout",
			"context too long",
			"aborted",
			"permission denied",
		])
			assert.equal(availabilityFailure(text), null);
	});
	it("contains malformed current records and preserves bounded fallback evidence", () => {
		const plan = {
			requested: "one/model",
			taskClass: undefined,
			candidates: ["one/model", "two/model"],
			index: 1,
			thinkingExplicit: false,
			exhausted: false,
			events: [{ model: "one/model", phase: "runtime", reason: "quota" }],
		};
		assert.deepEqual(normalizeFallback(plan), plan);
		assert.notEqual(normalizeFallback(plan)?.events, plan.events);
		for (const bad of [
			null,
			{},
			{ ...plan, index: 7 },
			{ ...plan, events: [null] },
			{ ...plan, candidates: ["one/model"] },
		])
			assert.equal(normalizeFallback(bad), undefined);
	});
	it("preserves actual SDK sessions, limits, results, and reporting during fallback", { timeout: 90000 }, async () => {
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[fileURLToPath(new URL("./fallback-child.mts", import.meta.url))],
			{ timeout: 85000, maxBuffer: 1024 * 1024 },
		);
		assert.match(stdout, /model fallback child: PASS/);
	});
});
