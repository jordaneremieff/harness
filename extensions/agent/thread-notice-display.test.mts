import assert from "node:assert/strict";
import { it } from "node:test";
import type { Communication } from "./communication.ts";
import { THREAD_NOTICE_DISPLAY_UNITS, threadEventDisplayText, threadEventPhrase, threadNoticeDisplayText, threadNoticeSummary } from "./thread-notice-display.ts";

const event = (kind: string, message: string, source = "") => ({ kind, message, source });
const notice = (overrides: Partial<Extract<Communication, { kind: "notice" }>["metadata"]> = {}, text = "", name?: string): Extract<Communication, { kind: "notice" }> => ({
	format: "agent.communication/1",
	kind: "notice",
	sender: { identity: "7f7f7f7f-1111-4222-8333-444444444444", ...(name === undefined ? {} : { name }) },
	body: { text, complete: false, redacted: false },
	recordedAt: 1,
	metadata: { threadId: "thread-a", title: "Parser contract", event: 4, frameRevision: 1, eventKind: "contribution", passive: true, ...overrides },
});

it("names each thread event kind with a verb phrase whose object is the thread", () => {
	assert.equal(threadEventPhrase("contribution"), "posted in");
	assert.equal(threadEventPhrase("carried-authority"), "relayed operator direction in");
	assert.equal(threadEventPhrase("join"), "joined");
	assert.equal(threadEventPhrase("leave"), "left");
	assert.equal(threadEventPhrase("close"), "closed");
	assert.equal(threadEventPhrase("revise"), "revised the frame of");
	assert.equal(threadEventPhrase("create"), "created");
	assert.equal(threadEventPhrase("unknown"), undefined);
	assert.equal(threadEventPhrase(undefined), undefined);
});

it("shows what an event says instead of its stored form", () => {
	assert.equal(threadEventDisplayText(event("contribution", "The parser rejects empty frames.")), "The parser rejects empty frames.");
	assert.equal(threadEventDisplayText(event("carried-authority", "Hold publication.", "Operator chat, 18 Nov")), "Hold publication.\n\nSource: Operator chat, 18 Nov");
	assert.equal(threadEventDisplayText(event("join", "Joined the thread.")), "", "a join without a statement has no text beyond its heading");
	assert.equal(threadEventDisplayText(event("leave", "Left the thread.")), "");
	assert.equal(threadEventDisplayText(event("join", "Reviewing the parser; holds the gate.", "Assignment")), "Reviewing the parser; holds the gate.\n\nSource: Assignment");
	assert.equal(threadEventDisplayText(event("close", "Landed on main.")), "Landed on main.");
	const frame = JSON.stringify({ title: "Parser contract", purpose: "Settle the parser contract.", authority: "Operator: no publication.", source: "Chat", restrictions: "", acceptance: "Tests pass.", integrator: "7f7f7f7f-1111-4222-8333-444444444444" });
	const revised = threadEventDisplayText(event("revise", frame));
	assert.equal(revised, "**Purpose:** Settle the parser contract.\n\n**Operator direction (as carried):** Operator: no publication.\n\n**Source:** Chat\n\n**Acceptance:** Tests pass.");
	assert.doesNotMatch(revised, /[{}"]|integrator/u, "the frame JSON and identities stay out of the display");
	assert.equal(threadEventDisplayText(event("create", "not a frame")), "not a frame", "an unreadable frame keeps its stored text");
});

it("keeps the whole text for a notified recipient and an excerpt cut at a word for a passive one", () => {
	const long = `${"word ".repeat(100)}end`;
	assert.equal(threadNoticeDisplayText(event("contribution", long), false), long);
	const excerpt = threadNoticeDisplayText(event("contribution", long), true);
	assert.ok(excerpt.endsWith("word…"), excerpt);
	assert.ok(excerpt.length <= THREAD_NOTICE_DISPLAY_UNITS + 1);
	assert.equal(threadNoticeDisplayText(event("contribution", "Short post."), true), "Short post.");
});

it("summarises a notice as who did what in which thread, then the start of its text", () => {
	assert.equal(threadNoticeSummary(notice({}, "The parser\n  rejects empty frames.", "Peer")), "Peer posted in thread “Parser contract” (#4): The parser rejects empty frames.");
	assert.equal(threadNoticeSummary(notice({ eventKind: "close", title: undefined })), "7f7f7f7f-1111-4222-8333-444444444444 closed thread thread-a (#4)");
	assert.equal(threadNoticeSummary(notice({ eventKind: undefined, event: undefined }, "", "Peer")), "Thread notice from Peer in thread “Parser contract”");
});
