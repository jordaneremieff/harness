import assert from "node:assert/strict";
import { it } from "node:test";
import { SessionManager, type ContextEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import register from "./ordinary-entry.ts";

type Hook = (event: unknown, ctx: ExtensionContext) => unknown;
const recipient = "00000000-0000-4000-8000-000000000002";
const sender = "00000000-0000-4000-8000-000000000001";
function fixture(manager?: SessionManager) {
	const hooks = new Map<string, Hook[]>();
	const branch: unknown[] = [];
	let sessionId = manager?.getSessionId() ?? recipient, sent = 0;
	register({ events: { on: () => () => {}, emit() {} }, on(name: string, handler: Hook) { hooks.set(name, [...hooks.get(name) ?? [], handler]); }, getThinkingLevel: () => "off", registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, sendMessage() { sent++; } } as unknown as ExtensionAPI);
	const ctx = { sessionManager: { getSessionId: () => sessionId, getBranch: () => manager?.getBranch() ?? branch } } as unknown as ExtensionContext;
	const hook = (name: string, event: unknown) => { const handlers = hooks.get(name); assert.ok(handlers?.length); return handlers.map((handler) => handler(event, ctx)).at(-1); };
	return { branch, hook, sent: () => sent, session: (id: string) => { sessionId = id; }, project: (messages: ContextEvent["messages"]) => (hook("context", { type: "context", messages }) as { messages: ContextEvent["messages"] }).messages };
}
function notice(sequence: number, passive = true, target = recipient) {
	const communicationPassive = { format: "agent.communication-passive/1", requestId: `deliver:thread:${sequence}`, value: { format: "agent.communication/1", kind: "notice", sender: { identity: sender }, body: { text: "Passive event fact", complete: true, redacted: false }, recordedAt: sequence, metadata: { threadId: "thread", event: sequence, frameRevision: 1, eventKind: "post", passive: true } } };
	const details = { sourceId: `thread:${sequence}`, deliveryRecipient: target, passive, wake: !passive, ...(passive ? { communicationPassive } : {}) };
	const entry = { type: "custom_message", id: `entry:${sequence}`, parentId: null, timestamp: new Date(sequence).toISOString(), customType: "agent.peer", content: `Event fact ${sequence}`, display: true, details } as const;
	return { entry, message: { role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details, timestamp: sequence } as ContextEvent["messages"][number] };
}
it("freezes ordinary passive thread ranges without changing active or unmatched messages", () => {
	const f = fixture();
	const notices = [notice(1), notice(2), notice(3)], active = notice(9, false);
	f.branch.push(...notices.map((item) => item.entry), active.entry);
	const unmatched = { ...notices[0].message, content: "UNMATCHED_SOURCE", timestamp: 11 } as ContextEvent["messages"][number];
	const messages = [...notices.map((item) => item.message), active.message, unmatched];
	const originals = structuredClone(messages), entries = structuredClone(f.branch);
	const first = f.project(messages);
	assert.equal(first.length, 3);
	assert.deepEqual(first.slice(1), [active.message, unmatched]);
	assert.ok(first[0].role === "custom" && typeof first[0].content === "string");
	assert.match(first[0].content, /passive event range 1\.\.3/u);
	assert.match(first[0].content, /agent_collaborate/u);
	const frozen = structuredClone(first[0]);
	const fourth = notice(4); f.branch.push(fourth.entry); messages.splice(3, 0, fourth.message);
	const second = f.project(messages);
	assert.equal(second.length, 4);
	assert.deepEqual(second[0], frozen);
	assert.ok(second[1].role === "custom" && typeof second[1].content === "string");
	assert.match(second[1].content, /passive event range 4\.\.4/u);
	assert.deepEqual(second.slice(2), [active.message, unmatched]);
	assert.deepEqual(f.project(messages), second);
	assert.deepEqual(messages.filter((message) => message !== fourth.message), originals);
	assert.deepEqual(f.branch.slice(0, -1), entries);
	assert.equal(f.sent(), 0);
	f.hook("session_tree", {});
	const reset = f.project(messages);
	assert.equal(reset.length, 3);
	assert.ok(reset[0].role === "custom" && typeof reset[0].content === "string");
	assert.match(reset[0].content, /passive event range 1\.\.4/u);
});
it("matches actual retained SDK tuples before the ordinary provider boundary", () => {
	const manager = SessionManager.inMemory(), f = fixture(manager);
	const append = (sequence: number) => {
		const value = notice(sequence, true, manager.getSessionId());
		manager.appendCustomMessageEntry(value.entry.customType, value.entry.content, value.entry.display, value.entry.details);
	};
	append(1); append(2); append(3);
	const original = structuredClone(manager.getBranch());
	const first = f.project(manager.buildSessionContext().messages);
	assert.equal(first.length, 1);
	const frozen = structuredClone(first[0]);
	append(4);
	const second = f.project(manager.buildSessionContext().messages);
	assert.equal(second.length, 2);
	assert.deepEqual(second[0], frozen);
	assert.deepEqual(manager.getBranch().slice(0, -1), original);
	assert.equal(f.sent(), 0);
});
it("keeps recipient scopes separate and discards snapshots on shutdown", async () => {
	const f = fixture(), initial = [notice(1), notice(2)];
	f.branch.push(...initial.map((item) => item.entry));
	const messages = initial.map((item) => item.message);
	assert.equal(f.project(messages).length, 1);
	f.session("00000000-0000-4000-8000-000000000003");
	assert.deepEqual(f.project(messages), messages);
	f.session(recipient);
	const third = notice(3); f.branch.push(third.entry); messages.push(third.message);
	assert.equal(f.project(messages).length, 1);
	const fourth = notice(4); f.branch.push(fourth.entry); messages.push(fourth.message);
	assert.equal(f.project(messages).length, 2);
	await f.hook("session_shutdown", { type: "session_shutdown" });
	assert.equal(f.project(messages).length, 1);
	assert.equal(f.sent(), 0);
});
