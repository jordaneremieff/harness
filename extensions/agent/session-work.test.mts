import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/chord";
import { retainedSentWork, SENT_WORK_ENTRY, sentWorkIdentity } from "./session-work.ts";

const storage = "12345678-1234-4234-8234-123456789abc";

function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "agent-sent-work-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const session = SessionManager.create(root, root);
	const user = session.appendMessage({ role: "user", content: "Review the change", timestamp: 1 });
	return { root, session, user };
}

function receipt(session: SessionManager, toolName: string, details: JsonValue, isError = false) {
	session.appendMessage({ role: "toolResult", toolCallId: "call", toolName, content: [], details, isError, timestamp: 2 });
}

test("restores successful retained dispatches across branches and custom markers after disk reopen", (t) => {
	const { session, root, user } = fixture(t);
	for (const [index, tool] of ["agent_send", "agent_steer", "agent_spawn", "agent_place"].entries()) {
		receipt(session, tool, { result: { sessionId: `${storage}:${index + 2}`, submissionId: index + 1, requestId: `request-${index}` } });
	}
	receipt(session, "agent_rewind", { identity: `${storage}:6`, submissionId: 9 });
	receipt(session, "agent_send", { identity: `${storage}:7`, timerId: 3 });
	session.branch(user);
	session.appendCustomEntry(SENT_WORK_ENTRY, { sessionId: `${storage}:1` });
	session.appendCustomEntry(SENT_WORK_ENTRY, { sessionId: `${storage}:2` });
	const path = session.getSessionFile();
	assert.ok(path);
	const reopened = SessionManager.open(path, root);
	assert.equal(reopened.getBranch().some((entry) => entry.type === "message" && entry.message.role === "toolResult"), false);
	assert.deepEqual([...retainedSentWork(reopened.getEntries())].sort(), [storage, ...Array.from({ length: 6 }, (_, index) => `${storage}:${index + 2}`)].sort());
});

test("ignores failure, report, idle creation, attachment, observations, and malformed evidence", (t) => {
	const { session } = fixture(t);
	const result = { result: { sessionId: storage, submissionId: 1 } };
	receipt(session, "agent_send", result, true);
	for (const tool of ["agent_status", "agent_profile", "agent_attach", "unrelated"]) receipt(session, tool, result);
	receipt(session, "agent_send", { admitted: true, sourceId: "report" });
	receipt(session, "agent_spawn", { sessionId: storage });
	receipt(session, "agent_place", { sessionId: storage });
	for (const value of [null, "@handle", `${storage}:0`, `${storage}:9007199254740992`, "other", `${storage}:2:3`]) {
		session.appendCustomEntry(SENT_WORK_ENTRY, { sessionId: value });
		receipt(session, "agent_send", { result: { sessionId: value, submissionId: 1 } });
	}
	receipt(session, "agent_send", { result: { sessionId: storage, submissionId: 0 } });
	assert.deepEqual([...retainedSentWork(session.getEntries())], []);
});

test("historical nested call arguments prove no admission; forward work markers survive disk reopen", (t) => {
	const { session, root } = fixture(t);
	session.appendMessage({ role: "toolResult", toolCallId: "script", toolName: "codemode", content: [], isError: false, timestamp: 2,
		nestedCalls: { complete: true, calls: [{ id: "nested", name: "agent_send", arguments: { sessionId: `${storage}:2`, message: "Task" }, status: "ok" }] },
	});
	assert.deepEqual([...retainedSentWork(session.getEntries())], [], "public nested records contain no admitted result identity");
	session.appendCustomEntry(SENT_WORK_ENTRY, { sessionId: `${storage}:2` });
	const path = session.getSessionFile();
	assert.ok(path);
	assert.deepEqual([...retainedSentWork(SessionManager.open(path, root).getEntries())], [`${storage}:2`]);
});

test("sent-work fallback retains targets after peer settlement regardless of reply route", (t) => {
	const { session } = fixture(t);
	receipt(session, "agent_send", { result: { sessionId: `${storage}:2`, submissionId: 1 }, replyTo: "another-primary" });
	session.appendCustomMessageEntry("agent.peer", "Settled", true, { requestId: "request", submissionId: 1 });
	assert.deepEqual([...retainedSentWork(session.getEntries())], [`${storage}:2`]);
	assert.equal(sentWorkIdentity(`${storage}:01`), storage);
});
