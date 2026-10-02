/** Structured observations expose bounded evidence, never manager or execution handles. */
import { Type, type Static, type TSchema } from "typebox";
import type { DetachedRunView } from "./detached.ts";
import type { WorkerStatus } from "./worker.ts";

const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const text = Type.String();
const count = Type.Integer({ minimum: 0 });
const nullableText = Type.Union([text, Type.Null()]);
const nullableCount = Type.Union([count, Type.Null()]);
const fragment = { text, nextOffset: nullableCount, truncated: Type.Boolean() };
const omissions = object({ providerSignatures: count, imagePayloads: count, redactedThinking: count });
const capture = object({ mode: Type.Literal("read-only"), snapshot: Type.Literal(true), available: Type.Boolean(), bytes: count, unfinishedTail: Type.Boolean(), liveState: Type.Literal("unavailable"), reason: Type.Optional(text) });
const coverage = object({ total: count, returned: count, omitted: count, complete: Type.Boolean() });
const boundary = "Observation is not task acceptance, approval, or execution authority. Omitted records remain unknown. Recorded detached state is not live owner status.";
export const OBSERVATION_BYTES = 24000;

export const ListOutputSchema = object({
	rows: Type.Array(object({ sessionId: text, cwd: text, path: text, modifiedAt: Type.Number(), name: Type.Optional(text), firstMessage: Type.Optional(text), metadataPartial: Type.Boolean(), previewTruncated: Type.Optional(Type.Boolean()) })),
	nextCursor: nullableText,
	coverage: object({ directoryEntries: count, inventoryFiles: count, start: count, next: count, filesRead: count, captureBytes: count, partialMetadata: count, skipped: Type.Array(object({ file: text, reason: text })), exhausted: Type.Boolean() }),
	order: text, observedAt: text, scope: text, continuation: text, authority: text,
});

const runSchema = object({
	runId: text, sessionId: text, currentSessionId: Type.Optional(text), state: Type.Union([Type.Literal("launching"), Type.Literal("running"), Type.Literal("finished"), Type.Literal("failed"), Type.Literal("abandoned")]),
	startedAt: text, finishedAt: Type.Optional(text), pid: count, acknowledged: Type.Boolean(), error: Type.Optional(text), summary: Type.Optional(text),
	progress: Type.Optional(object({ updatedAt: text, entryCount: count, currentTool: Type.Optional(text), lastText: Type.Optional(text), error: Type.Optional(text) })),
});
export type RunObservation = Static<typeof runSchema>;
export function runObservation(run: DetachedRunView): RunObservation {
	return { runId: run.runId, sessionId: run.sessionId, currentSessionId: run.currentSessionId, state: run.state, startedAt: run.startedAt, finishedAt: run.finishedAt, pid: run.pid, acknowledged: run.acknowledged === true, error: run.error, summary: run.summary,
		...(run.progress ? { progress: { updatedAt: run.progress.updatedAt, entryCount: run.progress.entryCount, currentTool: run.progress.currentTool, lastText: run.progress.lastText, error: run.progress.error } } : {}) };
}
export const RunsOutputSchema = object({ runs: Type.Array(runSchema), found: Type.Union([Type.Boolean(), Type.Null()]), coverage, observedAt: text, boundary: text, unavailable: Type.Optional(text) });
export type RunsObservation = Static<typeof RunsOutputSchema>;

const runningToolSchema = object({ toolCallId: text, name: text, startedAt: text, elapsedMs: count });
const activityResultSchema = object({ operationId: text, status: text });
const compactionFailureSchema = object({ reason: Type.Union([Type.Literal("manual"), Type.Literal("threshold"), Type.Literal("overflow")]), errorMessage: Type.Optional(text), at: text });
const autoRetrySchema = object({ attempt: count, maxAttempts: count, delayMs: count, errorMessage: text });
const activitySchema = object({ runningTools: Type.Optional(Type.Array(runningToolSchema)), operation: Type.Optional(nullableText), result: Type.Optional(activityResultSchema), state: Type.Union([Type.Literal("working"), Type.Literal("idle")]), currentTool: Type.Optional(text), lastText: Type.Optional(text), pending: count, lastPersistedAt: nullableText });
const statusRowSchema = object({
	sessionId: text, cwd: text, modifiedAt: Type.Optional(Type.Number()), primary: Type.Optional(Type.Boolean()), name: Type.Optional(text), tipId: Type.Optional(nullableText),
	model: Type.Optional(object({ provider: text, modelId: text, thinkingLevel: Type.Optional(text), available: Type.Optional(Type.Boolean()) })),
	operation: Type.Optional(nullableText), entryCount: Type.Optional(count), tools: Type.Optional(Type.Array(text)), activeTools: Type.Optional(Type.Array(text)), extensions: Type.Optional(Type.Array(text)), lastError: Type.Optional(text), compactionFailure: Type.Optional(compactionFailureSchema), autoRetry: Type.Optional(autoRetrySchema),
	capture: Type.Optional(capture), run: Type.Optional(runSchema), activity: Type.Optional(activitySchema), unavailable: Type.Optional(text),
});
export type StatusRow = Static<typeof statusRowSchema>;
export const StatusOutputSchema = object({
	source: Type.Union([Type.Literal("inventory"), Type.Literal("live-owner"), Type.Literal("detached-owner"), Type.Literal("read-only-capture"), Type.Literal("detached-record"), Type.Literal("unavailable")]),
	sessions: Type.Array(statusRowSchema), coverage, observedAt: text, boundary: text, unavailable: Type.Optional(text),
	inventory: Type.Optional(object({ stored: count, held: count, primaries: count, detached: count })),
});
export type StatusObservation = Static<typeof StatusOutputSchema>;

/** Keep exact record identities; omit whole oversized records rather than invent truncated IDs. */
function bounded<T>(records: T[], reserve = 4000) {
	const rows: T[] = [];
	let bytes = 0;
	for (const row of records) {
		const size = Buffer.byteLength(JSON.stringify(row)) + 1;
		if (bytes + size > OBSERVATION_BYTES - reserve) break;
		rows.push(row); bytes += size;
	}
	return { rows, coverage: { total: records.length, returned: rows.length, omitted: records.length - rows.length, complete: rows.length === records.length } };
}
export function runsObservation(runs: DetachedRunView[], found: boolean): RunsObservation {
	const result = bounded(runs.map(runObservation));
	return { runs: result.rows, found, coverage: result.coverage, observedAt: new Date().toISOString(), boundary };
}
export function statusObservation(source: StatusObservation["source"], sessions: StatusRow[], unavailable?: string): StatusObservation {
	const detail = unavailable?.slice(0, 2000);
	const result = bounded(sessions, 4000 + Buffer.byteLength(JSON.stringify(detail ?? "")));
	return { source, sessions: result.rows, coverage: result.coverage, observedAt: new Date().toISOString(), boundary, ...(detail ? { unavailable: detail } : {}) };
}
/** Retained owners that cannot supply a structured observation are not empty inventories. */
export function unavailableObservation(kind: "status"): StatusObservation;
export function unavailableObservation(kind: "runs"): RunsObservation;
export function unavailableObservation(kind: "status" | "runs"): StatusObservation | RunsObservation {
	const common = { coverage: { total: 0, returned: 0, omitted: 0, complete: false }, observedAt: new Date().toISOString(), boundary,
		unavailable: "The retained owner did not supply structured observation data. Its text remains available; a fresh owner is required for structured status and runs." };
	return kind === "status" ? { ...common, source: "unavailable", sessions: [] } : { ...common, found: null, runs: [] };
}
/** Supervision prioritizes process-held workers, never stored-file metadata rows. */
export function supervisionObservation(held: StatusRow[], primaries: StatusRow[], runs: DetachedRunView[], stored: number): StatusObservation {
	const workers = [...held].sort((a, b) => Number(b.activity?.state === "working") - Number(a.activity?.state === "working")).map(({ tools: _tools, activeTools: _activeTools, extensions: _extensions, ...row }) => row);
	const seen = new Set(workers.map((row) => row.sessionId));
	const roots = primaries.filter((row) => !seen.has(row.sessionId));
	for (const row of roots) seen.add(row.sessionId);
	const detached = runs.filter((run) => !seen.has(run.currentSessionId ?? run.sessionId)).map((run) => ({ sessionId: run.currentSessionId ?? run.sessionId, cwd: run.cwd, run: runObservation(run) }));
	return { ...statusObservation("inventory", [...workers, ...roots, ...detached]), inventory: { stored, held: workers.length, primaries: roots.length, detached: detached.length } };
}
export function liveStatusRow(status: WorkerStatus): StatusRow {
	return { sessionId: status.sessionId, cwd: status.cwd, name: status.name, tipId: status.tipId,
		model: { provider: status.model.provider, modelId: status.model.modelId, thinkingLevel: status.model.thinkingLevel }, operation: status.operation,
		entryCount: status.entryCount, tools: [...status.tools], activeTools: [...status.activeTools], extensions: [...status.extensions], lastError: status.lastError, compactionFailure: status.compactionFailure, autoRetry: status.autoRetry, ...(status.activity ? { activity: { ...status.activity } } : {}) };
}

const inspectionBase = {
	sessionId: text, execution: object({ current: Type.Union([object({ id: text }), Type.Null()]), recovery: text }), liveOwner: Type.Boolean(), capture: Type.Optional(capture), lastError: Type.Optional(object(fragment)),
};
const evidence = object({ id: text, parentId: nullableText, type: text, timestamp: text, role: Type.Optional(text), fromId: Type.Optional(nullableText), path: Type.Optional(text), matchOffset: Type.Optional(count), preview: Type.Optional(text) });
const selection = {
	view: Type.Optional(Type.Union([Type.Literal("history"), Type.Literal("branch"), Type.Literal("search"), Type.Literal("result")])), fromId: Type.Optional(nullableText), evidence: Type.Optional(Type.Array(evidence)), resultEntryId: Type.Optional(text), operationId: Type.Optional(text), continuation: Type.Optional(nullableText),
	coverage: Type.Optional(object({ visits: Type.Optional(count), slots: Type.Optional(count), scannedBytes: Type.Optional(count), complete: Type.Boolean(), reason: Type.Optional(text) })), scope: Type.Optional(text), boundary: Type.Optional(text),
};
export const InspectOutputSchema = Type.Union([
	object({ ...inspectionBase, view: Type.Literal("activity"), text, observedAt: text, nextCursor: nullableCount,
		turns: Type.Array(object({ startIndex: count, endIndex: count, partial: Type.Boolean(), rows: Type.Array(object({ entryId: text, timestamp: text, kind: text, text, toolCallId: Type.Optional(text), outcome: Type.Optional(text), isError: Type.Optional(Type.Boolean()), durationMs: Type.Optional(count), ageMs: Type.Optional(count), runningForMs: Type.Optional(count), resultEntryId: Type.Optional(text), count: Type.Optional(count), entryIds: Type.Optional(Type.Array(text)) })) })),
		metadata: object({ name: Type.Optional(text), cwd: text, model: Type.Optional(object({ provider: text, modelId: text, thinkingLevel: Type.Optional(text) })), entryCount: count, lastPersistedAt: nullableText, lastPersistedAgeMs: nullableCount,
			ownerState: Type.Union([Type.Literal("working"), Type.Literal("idle"), Type.Literal("unavailable")]), currentTools: Type.Array(text), runningTools: Type.Array(runningToolSchema), operation: nullableText, result: Type.Optional(activityResultSchema), pending: nullableCount, lastText: Type.Optional(text), lastError: Type.Optional(text), compactionFailure: Type.Optional(compactionFailureSchema), autoRetry: Type.Optional(autoRetrySchema) }),
		coverage: object({ turnsConsidered: count, turnsRendered: count, considered: count, rendered: count, omitted: count, failuresOmitted: count, lookaheadEntries: count, truncated: Type.Boolean(), headerTruncated: Type.Boolean(), excerptsClipped: Type.Boolean(), entryLimitReached: Type.Boolean(), rowLimitReached: Type.Boolean(), thinking: count }),
	}),
	object({ ...inspectionBase, result: Type.Optional(object({ entryId: Type.Optional(text), ...fragment })), entries: Type.Array(object({ id: text, parentId: nullableText, type: text, role: Type.Optional(text), ...fragment, omissions: Type.Optional(omissions), preview: Type.Optional(object({ text, truncated: Type.Boolean() })) })), nextCursor: nullableCount, order: Type.Literal("newestFirst"), detail: text, resultOffset: Type.Optional(count), resultPersistence: Type.Optional(text) }),
	object({ ...inspectionBase, ...selection, entryId: text, offset: count, ...fragment, omissions: Type.Optional(omissions), status: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("aborted")])), resultPersistence: Type.Optional(text), detail: Type.Optional(text) }),
	object({ ...inspectionBase, ...selection }),
]);

/** Match JSON text semantics, including omission of absent optional properties. */
export function observationResult(value: unknown, pretty = false) {
	const text = JSON.stringify(value, null, pretty ? 2 : undefined);
	return { content: [{ type: "text" as const, text }], details: undefined, structuredContent: JSON.parse(text) };
}
