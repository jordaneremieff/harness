import { projectFrame, jsonDisplay } from "../server/projection.mts";
import type { EntryView } from "../shared/api.ts";
import { AgentError } from "./client.mts";
import type { ConversationFrame, InspectResult, JsonObject, Snapshot } from "./contract.mts";

/** Worker output retains source cursors and coverage; displayed content is independently bounded. */
function nativeEntry(entry: EntryView): JsonObject {
  const result: Record<string, unknown> = { id: entry.id, kind: entry.kind };
  if (entry.messages) result.model = entry.messages;
  if (entry.data) result.data = entry.data;
  if (entry.head !== undefined) result.head = entry.head;
  return result as JsonObject;
}
function status(source: ConversationFrame, display: ReturnType<typeof projectFrame>): JsonObject {
  const target = source.status;
  const result: Record<string, unknown> = {
    conversationId: source.conversationId, identity: target.identity, busy: display.status.busy,
    live: null, inbox: [], lastText: display.status.lastText ?? "",
    agent: { thinkingLevel: display.status.thinkingLevel ?? "", extensions: [], tools: [] },
    tasks: display.status.tasks?.value ?? [], submissions: display.status.submissions?.value ?? [],
  };
  for (const key of ["name", "model", "thinkingLevel"] as const) if (display.status[key] !== undefined) result[key] = display.status[key];
  return result as JsonObject;
}
function sourceCoverage(source: ConversationFrame["coverage"], display: ReturnType<typeof projectFrame>): ConversationFrame["coverage"] {
  const statusTruncated = display.status.tasks?.truncated || display.status.submissions?.truncated;
  return { complete: source.complete, entries: source.entries, bytes: source.bytes, hiddenExcluded: source.hiddenExcluded,
    entryLimitReached: source.entryLimitReached, byteLimitReached: source.byteLimitReached,
    truncated: display.coverage.truncated || statusTruncated === true,
    uiOmitted: display.coverage.omitted, uiComplete: display.coverage.complete && statusTruncated !== true };
}
export function transferFrame(source: ConversationFrame): ConversationFrame {
  const display = projectFrame(source);
  const bounded: ConversationFrame = { scope: source.scope, storageId: source.storageId, conversationId: source.conversationId,
    revision: source.revision, observedAt: source.observedAt,
    nextBefore: displayBoundary(source.nextBefore, source.entries.length, display.entries), sourceNextBefore: source.nextBefore, entries: display.entries.map(nativeEntry) as ConversationFrame["entries"],
    live: display.live.map(nativeEntry) as ConversationFrame["live"], status: status(source, display),
    coverage: sourceCoverage(source.coverage, display) };
  assertTransferBound(bounded);
  return bounded;
}
export function transferSnapshot(source: Snapshot): Snapshot {
  const display = projectFrame({ ...source, revision: 0, observedAt: "", live: [], status: { busy: false } });
  const bounded: Snapshot = { entries: display.entries.map(nativeEntry) as Snapshot["entries"], partial: source.partial,
    revision: source.revision, nextBefore: displayBoundary(source.nextBefore, source.entries.length, display.entries),
    sourceNextBefore: source.nextBefore, coverage: sourceCoverage(source.coverage, display) };
  assertTransferBound(bounded);
  return bounded;
}
export function transferInspect(source: InspectResult): InspectResult {
  const display = jsonDisplay(source, 128 * 1024);
  const value = display.value && typeof display.value === "object" && !Array.isArray(display.value) ? display.value : {};
  const result = { ...value, view: source.view, sessionId: source.sessionId, conversationId: source.conversationId } as InspectResult;
  // A cursor is opaque. Truncation never fabricates a continuation or changes its query meaning.
  if (source.nextCursor !== undefined) {
    if (Buffer.byteLength(JSON.stringify(source.nextCursor)) > 4096) throw new AgentError("protocol_error", "Inspection cursor exceeds the supported bound.");
    result.nextCursor = source.nextCursor;
  }
  for (const key of ["entryId", "offset", "nextOffset", "submissionId", "requestId", "operationId", "status"] as const) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  if (display.truncated) { result.uiTruncated = true; if (source.view === "exact") result.truncated = true; }
  assertTransferBound(result);
  return result;
}
function displayBoundary(source: number | null, nativeCount: number, entries: EntryView[]): number | null {
  if (entries.length === nativeCount || !entries.length) return source;
  const first = Number(entries[0]?.id);
  return Number.isSafeInteger(first) && first > 0 ? first : source;
}
function assertTransferBound(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw new AgentError("protocol_error", "Worker projection exceeds its transfer bound.");
}
