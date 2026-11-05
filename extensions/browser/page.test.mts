import assert from "node:assert/strict";
import { it } from "node:test";
import { createContext, runInContext, Script } from "node:vm";
import { syntaxError } from "./operations.ts";
import {
	ACTION_TYPES,
	type ElementAction,
	INSPECT_VIEWS,
	actionScript,
	evaluationForgetScript,
	evaluationPollScript,
	evaluationStartScript,
	inspectScript,
	pollScript,
} from "./page.ts";

const ORIGIN = "https://a.example";

function obj(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

interface Evaluation {
	started: Record<string, unknown>;
	poll: () => Record<string, unknown>;
	ran: boolean;
}

interface EvaluationOptions {
	maxBytes?: number;
	origin?: string;
}

/** Runs one evaluation start script in a fresh isolated-world stand-in and keeps its run entry readable. */
function startExpression(expression: string, options: EvaluationOptions = {}): Evaluation {
	const markers = { ran: false };
	const sandbox = {
		location: { href: `${ORIGIN}/page`, origin: options.origin ?? ORIGIN },
		document: { title: "Example", readyState: "complete", visibilityState: "visible" },
		performance: { timeOrigin: 1000, now: () => 5 },
		Promise,
		Map,
		TextEncoder,
		TextDecoder,
		JSON,
		markers,
	};
	const context = createContext(sandbox);
	const encoded = runInContext(
		evaluationStartScript(ORIGIN, "run-1", expression, options.maxBytes ?? 32_768),
		context,
	) as string;
	return {
		started: JSON.parse(encoded) as Record<string, unknown>,
		poll: () => JSON.parse(runInContext(evaluationPollScript("run-1"), context) as string) as Record<string, unknown>,
		ran: markers.ran,
	};
}

function outcomeOf(value: unknown): Record<string, unknown> {
	return obj(obj(value).outcome);
}

async function settleMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

it("every generated page script parses", () => {
	for (const view of INSPECT_VIEWS) {
		new Script(inspectScript(ORIGIN, { view, selector: null, offset: 0, limit: 60, maxChars: 2000 }));
		new Script(inspectScript(ORIGIN, { view, selector: "#target", offset: 10, limit: 20, maxChars: 200 }));
	}
	const elementActions = ACTION_TYPES.filter((type): type is ElementAction => type !== "navigate");
	for (const type of elementActions) {
		new Script(
			actionScript(ORIGIN, {
				id: "action-1",
				type,
				selector: "#target",
				index: null,
				value: type === "fill" || type === "select" ? "value" : null,
				key: type === "press" ? "Enter" : null,
			}),
		);
	}
	new Script(pollScript("action-1", { selector: "#done" }, 1000));
	new Script(pollScript(null, null, null));
	new Script(evaluationStartScript(ORIGIN, "run-1", "1 + 1", 32_768));
	new Script(evaluationPollScript("run-1"));
	new Script(evaluationForgetScript("run-1"));
});

it("encodes a settled number", () => {
	const evaluation = startExpression("1 + 1");
	const outcome = outcomeOf(evaluation.started);
	assert.equal(evaluation.started.kind, "settled");
	assert.equal(outcome.state, "fulfilled");
	assert.equal(outcome.awaited, false);
	assert.equal(outcome.valueType, "number");
	assert.equal(outcome.value, 2);
});

it("distinguishes undefined from a missing result", () => {
	const outcome = outcomeOf(startExpression("undefined").started);
	assert.equal(outcome.valueType, "undefined");
	assert.equal("value" in outcome, false);
	assert.equal("unserializable" in outcome, false);
});

it("reports a top-level non-finite number as a special value", () => {
	const outcome = outcomeOf(startExpression("Number.NaN").started);
	assert.equal(outcome.valueType, "number");
	assert.equal(outcome.special, "NaN");
	assert.equal("value" in outcome, false);
});

it("reports a nested non-finite number at its path", () => {
	const outcome = outcomeOf(startExpression("({ n: Number.NaN })").started);
	assert.equal(obj(outcome.unserializable).path, "$.n");
});

it("reports a cycle as unserializable", () => {
	const outcome = outcomeOf(startExpression("(() => { const o = {}; o.self = o; return o; })()").started);
	assert.equal(obj(outcome.unserializable).reason, "Circular reference.");
});

it("reports a Map as unserializable", () => {
	const outcome = outcomeOf(startExpression('new Map([["a", 1]])').started);
	assert.equal(outcome.valueType, "object");
	assert.match(String(obj(outcome.unserializable).reason), /not JSON data/);
});

it("encodes a Date as an ISO string", () => {
	const outcome = outcomeOf(startExpression('new Date("2020-01-02T03:04:05.000Z")').started);
	assert.equal(outcome.value, "2020-01-02T03:04:05.000Z");
});

it("counts nested undefined values that JSON drops", () => {
	const outcome = outcomeOf(startExpression("({ a: undefined, b: 1 })").started);
	assert.equal(outcome.undefinedDropped, 1);
	assert.deepEqual(outcome.value, { b: 1 });
});

it("reports a bigint as a special value", () => {
	const outcome = outcomeOf(startExpression("10n").started);
	assert.equal(outcome.valueType, "bigint");
	assert.equal(outcome.special, "10");
});

it("marks a value larger than maxBytes as too large with a preview", () => {
	const outcome = outcomeOf(startExpression('"x".repeat(20)', { maxBytes: 8 }).started);
	assert.equal(outcome.tooLarge, true);
	assert.equal(outcome.bytes, 22);
	assert.equal(String(outcome.preview).length, 8);
	assert.equal("value" in outcome, false);
});

it("keeps a multibyte preview within maxBytes bytes without a split character", () => {
	const outcome = outcomeOf(startExpression('"é".repeat(20)', { maxBytes: 8 }).started);
	assert.equal(outcome.tooLarge, true);
	const preview = String(outcome.preview);
	assert.ok(Buffer.byteLength(preview) <= 8);
	assert.equal(preview, '"ééé');
});

it("reports a synchronous throw as settled with the error name and message", () => {
	const evaluation = startExpression('(() => { throw new RangeError("bad range"); })()');
	const outcome = outcomeOf(evaluation.started);
	assert.equal(evaluation.started.kind, "settled");
	assert.equal(outcome.state, "threw");
	assert.equal(obj(outcome.error).name, "RangeError");
	assert.equal(obj(outcome.error).message, "bad range");
});

it("reads a rejected promise back through the poll script", async () => {
	const evaluation = startExpression('Promise.reject(new TypeError("no"))');
	assert.equal(evaluation.started.kind, "pending");
	await settleMicrotasks();
	const polled = evaluation.poll();
	assert.equal(polled.kind, "settled");
	const outcome = obj(polled.outcome);
	assert.equal(outcome.state, "rejected");
	assert.equal(obj(outcome.error).name, "TypeError");
	assert.equal(obj(outcome.error).message, "no");
});

it("keeps a non-Error rejection as the thrown value", async () => {
	const evaluation = startExpression('Promise.reject("plain text")');
	assert.equal(evaluation.started.kind, "pending");
	await settleMicrotasks();
	const outcome = obj(evaluation.poll().outcome);
	assert.equal(outcome.state, "rejected");
	assert.equal(obj(outcome.error).name, null);
	assert.equal(obj(obj(outcome.error).thrown).value, "plain text");
});

it("refuses an origin mismatch without evaluating the expression", () => {
	const evaluation = startExpression("(globalThis.markers.ran = true, 1)", { origin: "https://b.example" });
	assert.equal(evaluation.started.kind, "origin-mismatch");
	assert.equal(obj(evaluation.started.page).origin, "https://b.example");
	assert.equal(evaluation.ran, false);
});

it("syntaxError accepts valid expressions and rejects invalid ones", () => {
	assert.equal(syntaxError("1 + 1"), null);
	assert.equal(syntaxError("({ a: 1 })"), null);
	const problem = syntaxError("1 +");
	assert.equal(typeof problem, "string");
	assert.notEqual(problem, null);
});
