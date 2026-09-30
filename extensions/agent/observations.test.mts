import assert from "node:assert/strict";
import { test } from "node:test";
import { Check, Errors } from "typebox/value";
import type { TSchema } from "typebox";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { DetachedRunView } from "./detached.ts";
import { projectInspection } from "./worker.ts";
import { InspectOutputSchema, OBSERVATION_BYTES, RunsOutputSchema, StatusOutputSchema, liveStatusRow, observationResult, runsObservation, statusObservation } from "./observations.ts";

function valid(schema: TSchema, value: unknown) {
	assert.equal(Check(schema, value), true, JSON.stringify([...Errors(schema, value)]));
}
const json = (value: unknown) => observationResult(value).structuredContent;

test("inspection schemas cover empty, paged, exact, selected, partial, and failed saved outcomes", () => {
	const manager = SessionManager.inMemory();
	const inspect = (options = {}) => json(projectInspection(manager, manager.getSessionId(), options));
	valid(InspectOutputSchema, inspect());
	const user = manager.appendMessage({ role: "user", content: "request", timestamp: 1 });
	manager.appendCustomEntry("agent.operation", { operationId: "operation" });
	for (const view of ["branch", "search", "result"] as const) {
		valid(InspectOutputSchema, inspect({ view, ...(view === "search" ? { query: "request" } : {}) }));
	}
	const result = manager.appendCustomEntry("agent.result", { operationId: "operation", status: "failed", error: { message: "failure" }, text: "x".repeat(30000) });
	for (const options of [{}, { entryId: user }, { view: "result" }, { view: "result", entryId: result }, { view: "result", entryId: result, offset: 12000 }]) valid(InspectOutputSchema, inspect(options));
	const selected = inspect({ view: "result" });
	assert.equal(selected.status, "failed"); assert.equal(selected.truncated, true);
	assert.equal(selected.operationId, "operation"); assert.equal(selected.entryId, result);
	for (const view of [undefined, "branch", "search", "result"] as const) {
		const value = projectInspection(manager, manager.getSessionId(), { view, ...(view === "search" ? { query: "request" } : {}) }, undefined, { available: false, bytes: 0, unfinishedTail: true, reason: "capture unavailable" });
		valid(InspectOutputSchema, json(value));
	}
	assert.throws(() => inspect({ entryId: "absent" }), /no entry/);
});

test("status and run projections bound records without exposing request data or inventing live state", () => {
	const run: DetachedRunView = { runId: "run", sessionId: "session", sessionsRoot: "/private-store", agentDir: "/private-config", cwd: "/work", prompt: "PRIVATE_REQUEST", logFile: "/private-log", startedAt: "2026-01-01T00:00:00.000Z", pid: 1, launchState: "started", state: "failed", error: "failure", summary: "result", acknowledged: true };
	const runs = runsObservation([run], true);
	valid(RunsOutputSchema, json(runs));
	for (const state of ["launching", "running", "abandoned", "finished", "failed"] as const) valid(RunsOutputSchema, json(runsObservation([{ ...run, state, progress: { runId: "run", updatedAt: run.startedAt, entryCount: 1, currentTool: "read", lastText: "partial", error: "progress error" } }], true)));
	assert.doesNotMatch(JSON.stringify(runs), /PRIVATE_REQUEST|private-store|private-config|private-log/);
	assert.equal(runs.runs[0].error, "failure");
	valid(RunsOutputSchema, json(runsObservation([], false)));
	const large = runsObservation(Array.from({ length: 1000 }, (_, n) => ({ ...run, runId: `run-${n}` })), true);
	assert.ok(Buffer.byteLength(JSON.stringify(large)) < OBSERVATION_BYTES);
	assert.equal(large.coverage.complete, false);
	assert.equal(large.coverage.total, large.coverage.returned + large.coverage.omitted);
	const row = liveStatusRow({ sessionId: "session", cwd: "/work", tipId: null, model: { provider: "test", modelId: "model", thinkingLevel: "off" }, operation: null, tools: ["read"], activeTools: ["read"], extensions: [], entryCount: 1 });
	for (const source of ["live-owner", "detached-owner", "inventory", "read-only-capture", "detached-record"] as const) valid(StatusOutputSchema, json(statusObservation(source, [row])));
	const omitted = statusObservation("live-owner", [{ ...row, tools: ["x".repeat(40000)] }]);
	assert.equal(omitted.coverage.omitted, 1); assert.deepEqual(omitted.sessions, []);
	valid(StatusOutputSchema, json(omitted));
	const escaped = statusObservation("detached-record", Array.from({ length: 1000 }, () => row), "\u0000".repeat(2000));
	assert.ok(Buffer.byteLength(JSON.stringify(escaped)) < OBSERVATION_BYTES);
	assert.equal(escaped.coverage.complete, false); valid(StatusOutputSchema, json(escaped));
});
