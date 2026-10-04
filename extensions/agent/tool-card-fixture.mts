import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AgentConversationSummary } from "./dashboard-types.ts";

export const targetId = "12345678-1234-1234-1234-123456789abc";
export const forkId = `${targetId}:2`;
export const rows: AgentConversationSummary[] = [
	{ id: targetId, storageId: targetId, name: "Parser review", cwd: "/work", model: { provider: "provider", modelId: "model", thinkingLevel: "high" }, modifiedAt: 1, owner: "unknown", state: "idle", cost: 0, partial: false },
	{ id: forkId, storageId: targetId, name: "Fork review", cwd: "/work", model: { provider: "provider", modelId: "model", thinkingLevel: "high" }, modifiedAt: 1, owner: "unknown", state: "idle", cost: 0, partial: false },
];
const model = { provider: "provider", modelId: "model" };
const agent = { model, thinkingLevel: "high" };
const snapshot = { identity: targetId, conversationId: 1, name: "Parser review", busy: false, cwd: "/work", state: "idle", agent };
const admission = { identity: targetId, conversationId: 1, submissionId: 405, deduped: false };
const threadId = `${targetId}/0123456789abcdef0123456789abcdef`;
export interface CardFixture { args: Record<string, unknown>; details: unknown }
export const fixtures: Record<string, CardFixture> = {
	agent_send: { args: { sessionId: targetId, message: "Review the parser.\nCheck edge cases." }, details: admission },
	agent_steer: { args: { sessionId: targetId, message: "Review the parser.\nCheck edge cases." }, details: admission },
	agent_spawn: { args: { name: "Parser review", prompt: "Review the parser." }, details: { sessionId: targetId, status: snapshot, admission } },
	agent_attach: { args: { sessionId: targetId }, details: { sessionId: targetId, status: snapshot } },
	agent_place: { args: { area: "/work", topic: "Parser review" }, details: { sessionId: targetId, status: snapshot } },
	agent_status: { args: { sessionId: targetId }, details: { sessionId: targetId, status: snapshot } },
	agent_fork: { args: { sessionId: targetId, entryId: "5" }, details: { identity: forkId, conversationId: 2, deduped: false, status: { ...snapshot, identity: forkId, conversationId: 2, name: "Fork review" } } },
	agent_rewind: { args: { sessionId: targetId, entryId: "5", correction: "Check the other branch" }, details: { identity: forkId, conversationId: 2, predecessorEntryId: 5, submissionId: 406, deduped: false, status: { ...snapshot, identity: forkId, conversationId: 2, name: "Fork review" } } },
	agent_configure: { args: { sessionId: targetId, thinkingLevel: "high" }, details: { identity: targetId, conversationId: 1, status: snapshot } },
	agent_abort: { args: { sessionId: targetId }, details: { identity: targetId, conversationId: 1, background: false } },
	agent_command: { args: { sessionId: targetId, name: "reload" }, details: { identity: targetId, conversationId: 1, name: "reload", reloaded: true, inventory: { contributions: [{}, {}] } } },
	agent_profile: { args: { sessionId: targetId, action: "read" }, details: { identity: targetId, name: "Parser review", role: "Review parser source", expertise: "Saved source notes", revision: "abc", model, thinkingLevel: "high", live: false, requests: [] } },
	agent_list: { args: { query: "parser", limit: 5 }, details: { rows: [{ identity: targetId, name: "Parser review", role: "Review parser source" }], nextCursor: null, coverage: { complete: true, storagesVisited: 1, unavailable: [] } } },
	agent_inspect: { args: { sessionId: targetId, view: "result", submissionId: "405" }, details: { view: "result", submissionId: 405, status: "done", answer: "Source review finished." } },
	agent_compact: { args: { sessionId: targetId, summary: "Keep the source facts." }, details: { status: "submitted", taskId: 7, submissionId: 405 } },
	agent_collaborate: { args: { action: "post", threadId, message: "The parser handles this case." }, details: { threadId, sequence: 3, deduped: false } },
	agent_reset: { args: { sessionId: targetId, handoff: "Review the other branch." }, details: { text: "Reset queued for “Parser review”; it places at the next native boundary and starts no model turn." } },
};
export function fixtureResult(details: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: typeof details === "string" ? details : JSON.stringify(details, null, 2) }], details };
}
