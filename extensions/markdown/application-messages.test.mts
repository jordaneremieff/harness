import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	SessionManager,
	type BoundaryResult,
	type CustomMessageEntryDraft,
	type ExtensionAPI,
	type ExtensionContext,
	type MessageStartEvent,
} from "@earendil-works/pi-coding-agent";
import { markdownMessages } from "./application-messages.ts";
import type { PromptReply } from "./live-bridge.ts";

type Sent = Parameters<ExtensionAPI["sendMessage"]>[0];
type Message = MessageStartEvent["message"];
const id = (n: number) => `${n.toString(16).padStart(8, "0")}-cafe-4567-8000-000000000000`;
const user = { role: "user" as const, content: "Another question.", timestamp: 1 };
function foreign(id: string, reply: "final" | "none" = "final"): CustomMessageEntryDraft {
	return {
		type: "custom_message",
		customType: "application-message",
		display: true,
		content: `[Notebook] #${id.slice(0, 8).toLowerCase()} · Note · ${reply === "final" ? "reply in your final message" : "no reply needed"}\n\nA note.`,
		details: { version: 1, source: "notebook", application: "Notebook", id, subject: "Note", reply },
	};
}
function fixture() {
	const manager = SessionManager.inMemory();
	let run = new AbortController();
	const ctx: Pick<ExtensionContext, "sessionManager" | "signal"> = {
		sessionManager: manager,
		get signal() {
			return run.signal;
		},
	};
	type Handler = (event: object, context: typeof ctx) => unknown;
	const handlers = new Map<string, Handler>();
	const sent: Sent[] = [];
	const route = markdownMessages({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		sendMessage: (message: Sent) => sent.push(message),
	} as unknown as ExtensionAPI);
	const emit = (type: string, fields: object = {}) => handlers.get(type)?.({ type, ...fields }, ctx);
	const boundary = (
		type: "turn_end" | "agent_before_settle",
		pendingMessages: Message[],
		entries: CustomMessageEntryDraft[],
		fields?: object,
	) => {
		const result = emit(type, { context: { pendingMessages }, entries, continue: false, ...fields }) as
			| BoundaryResult
			| undefined;
		return result;
	};
	return {
		manager,
		sent,
		emit,
		end: route.end,
		startTurn: () => emit("turn_start"),
		stop: () => run.abort(),
		restart: () => {
			run = new AbortController();
			emit("turn_start");
		},
		send(n: number, idle = false) {
			const replies: Parameters<PromptReply>[] = [];
			const receipt = route.send(
				{ operationId: id(n).toUpperCase(), handle: "pane-handle", text: `Question ${n}?\r\n\t👩‍💻` },
				(...args) => replies.push(args),
				idle,
			);
			assert.deepEqual(receipt, { status: "requested" });
			const message = sent.at(-1);
			assert.ok(message);
			return { message, replies };
		},
		append(message: Sent) {
			return manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
		place(message: Sent) {
			emit("message_start", { message: { ...message, role: "custom", timestamp: 1 } });
			return this.append(message);
		},
		turn(
			message: ReturnType<typeof fauxAssistantMessage>,
			pendingMessages: Message[] = [],
			entries: CustomMessageEntryDraft[] = [],
		) {
			const messageEntryId = manager.appendMessage(message);
			return boundary("turn_end", pendingMessages, entries, { message, messageEntryId });
		},
		beforeSettle: (entries: CustomMessageEntryDraft[] = []) => boundary("agent_before_settle", [], entries),
	};
}

test("an abort without a queue clear leaves future follow-ups alone", () => {
	const pi = fixture();
	const ask = pi.send(1);
	pi.stop();
	assert.equal(
		pi.turn(fauxAssistantMessage("", { stopReason: "aborted" }), [user]),
		undefined,
		"a partial preview does not prove loss",
	);
	pi.emit("agent_settled", { aborted: true });
	pi.restart();
	pi.emit("message_start", { message: user });
	assert.equal(
		pi.turn(fauxAssistantMessage("Earlier answer."), [{ ...ask.message, role: "custom", timestamp: 1 }]),
		undefined,
	);
	assert.deepEqual(ask.replies, []);
	pi.startTurn();
	pi.place(ask.message);
	assert.equal(pi.turn(fauxAssistantMessage("The later answer.")), undefined);
	assert.deepEqual(ask.replies, [
		["working", ""],
		["answer", "The later answer."],
	]);
	assert.equal(pi.sent.length, 1);
});

test("the next healthy turn takes restored and stopped-turn inputs once, regardless of boundary order", () => {
	const pi = fixture();
	pi.append(foreign(id(10)));
	const cleared = pi.send(11);
	pi.stop();
	const notice = foreign(id(12), "none");
	const tool = fauxAssistantMessage(fauxToolCall("lookup", {}), { stopReason: "toolUse" });
	const result = pi.turn(tool, [], [notice]);
	assert.deepEqual(result, { entries: [notice, { type: "custom_message", ...cleared.message }], continue: true });
	pi.append(notice);
	pi.append(cleared.message);
	// Another application restores a request after this handler. The same UUID belongs to two different sources.
	pi.append(foreign(id(11)));
	pi.append(foreign(id(11).toUpperCase()));
	const stopped = pi.send(13);
	pi.startTurn();
	pi.place(stopped.message);
	pi.emit("message_start", { message: user });
	pi.manager.appendMessage(user);
	assert.equal(pi.turn(fauxAssistantMessage("Interrupted.", { stopReason: "aborted" })), undefined);
	pi.emit("agent_settled", { aborted: true });
	assert.deepEqual(cleared.replies, []);
	assert.deepEqual(stopped.replies, []);
	pi.restart();
	assert.deepEqual(cleared.replies, [["working", ""]]);
	assert.deepEqual(stopped.replies, [["working", ""]]);
	pi.emit("message_start", { message: user });
	pi.turn(fauxAssistantMessage(fauxToolCall("lookup", {}), { stopReason: "length" }));
	pi.startTurn();
	pi.turn(fauxAssistantMessage("Final answer."));
	for (const [ask, ref] of [
		[cleared, "#0000000b"],
		[stopped, "#0000000d"],
	] as const) {
		assert.deepEqual(ask.replies, [
			["working", ""],
			["answer", `Shared reply for ${ref} and 4 other messages:\n\nFinal answer.`],
		]);
	}
	assert.equal(pi.sent.length, 2);
});

test("pre-settlement restores dropped requests without a stop and verifies which drafts Pi kept", () => {
	const pi = fixture();
	const hidden = pi.send(21),
		replaced = pi.send(22),
		kept = pi.send(23);
	assert.equal(pi.turn(fauxAssistantMessage("An earlier answer."), [user]), undefined);
	const restored = pi.beforeSettle();
	assert.deepEqual(restored, {
		entries: [hidden, replaced, kept].map((ask) => ({ type: "custom_message", ...ask.message })),
		continue: true,
	});
	const hiddenEntry = pi.append(hidden.message);
	pi.manager.appendContextEdit(hiddenEntry, null);
	pi.append({ ...replaced.message, content: "Different question." });
	pi.append(kept.message);
	pi.startTurn();
	for (const ask of [hidden, replaced])
		assert.deepEqual(ask.replies, [["error", "Pi did not keep this request in the context for the next turn."]]);
	assert.deepEqual(kept.replies, [["working", ""]]);
	pi.turn(fauxAssistantMessage("The retained request's answer."));
	assert.deepEqual(kept.replies, [
		["working", ""],
		["answer", "The retained request's answer."],
	]);
	assert.equal(pi.sent.length, 3);
});

test("an idle Ask shares another application's restored input even when Markdown restored nothing", () => {
	const pi = fixture();
	pi.stop();
	assert.equal(pi.turn(fauxAssistantMessage("", { stopReason: "aborted" })), undefined);
	pi.append(foreign(id(33)));
	pi.emit("agent_settled", { aborted: true });
	const ask = pi.send(31, true);
	pi.restart();
	pi.place(ask.message);
	pi.turn(fauxAssistantMessage("Answer."));
	assert.deepEqual(ask.replies, [
		["working", ""],
		["answer", "Shared reply for #0000001f and 1 other message:\n\nAnswer."],
	]);
});

test("a failed run start is not a lost follow-up on a later run", () => {
	for (const idle of [true, false]) {
		const pi = fixture();
		const ask = pi.send(32, idle);
		// isIdle() is false during manual compaction; Pi still identifies the custom trigger before the run starts.
		if (!idle) pi.emit("before_agent_start", { messageType: "custom", message: ask.message });
		pi.startTurn();
		pi.emit("message_start", { message: user });
		assert.equal(pi.turn(fauxAssistantMessage("An unrelated answer.")), undefined);
		assert.deepEqual(ask.replies, []);
	}
});

test("blank, errored and aborted answers give working requests an unanswered reason", () => {
	for (const stopReason of ["stop", "error", "aborted"] as const) {
		const pi = fixture();
		const ask = pi.send(41, true);
		pi.place(ask.message);
		pi.turn(fauxAssistantMessage(stopReason === "stop" ? " \n " : "Incomplete answer.", { stopReason }));
		if (stopReason !== "stop") assert.deepEqual(ask.replies, [["working", ""]]);
		pi.emit("agent_settled", { aborted: stopReason === "aborted" });
		assert.equal(ask.replies.length, 2);
		assert.equal(ask.replies[1][0], "error");
		assert.match(ask.replies[1][1], /\S/u);
	}
});

test("ending the route withdraws queued and working requests without replay on a later branch", () => {
	const pi = fixture();
	const working = pi.send(51, true),
		queued = pi.send(52);
	pi.place(working.message);
	pi.end("The conversation changed branches before Pi answered this request.");
	assert.equal(pi.turn(fauxAssistantMessage("Unrelated branch answer.")), undefined);
	const withdrawn = ["error", "The conversation changed branches before Pi answered this request."];
	assert.deepEqual(working.replies, [["working", ""], withdrawn]);
	assert.deepEqual(queued.replies, [withdrawn]);
});
