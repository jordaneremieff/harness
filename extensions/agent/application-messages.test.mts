import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	SessionManager,
	type AgentBeforeSettleEvent,
	type BoundaryResult,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionEvent,
	type MessageEndEventResult,
	type MessageStartEvent,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { registerApplicationMessages } from "./application-messages.ts";

const RECEIVER = "harness:application-messages:receiver";
const REQUEST = "harness:application-messages:request";
const REPLY = "harness:application-messages:reply";
const GUIDANCE = "Use the notebook index to locate related notes.";
const OTHER_GUIDANCE = "Use the catalogue to locate related entries.";

function request(sessionId: string, n: number, reply: "final" | "none" = "final") {
	return {
		version: 1 as const,
		sessionId,
		extension: "notebook",
		application: "Notebook",
		id: `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
		subject: `Note ${n}`,
		reply,
		text: `What does note ${n} mean?`,
	};
}

type Request = ReturnType<typeof request> & { guidance?: string };
type Receipt = { status: "requested"; reference: string } | { status: "rejected"; message: string };
type Reply = {
	version: 1;
	extension: string;
	id: string;
	status: "working" | "answer" | "unanswered";
	text: string;
	shared?: number;
};
type Publication = { version: 1; deliver: (message: Request) => Receipt };
type Sent = Parameters<ExtensionAPI["sendMessage"]>[0];
type Options = Parameters<ExtensionAPI["sendMessage"]>[1];
type Message = MessageStartEvent["message"];
type Custom = Extract<Message, { role: "custom" }>;
type Boundary =
	| Omit<TurnEndEvent, "context" | "entries" | "continue">
	| Omit<AgentBeforeSettleEvent, "context" | "entries" | "continue">;

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...(stopReason === "toolUse" ? [{ type: "toolCall" as const, id: "call", name: "lookup", arguments: {} }] : []),
		],
		api: "fixture",
		provider: "fixture",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

function fixture() {
	const bus = new EventEmitter();
	let session = SessionManager.inMemory("/work");
	let active = false;
	let initial: Custom | undefined;
	let turnIndex = 0;
	let outcome: TurnEndEvent["outcome"] = "completed";
	const queue: Message[] = [];
	const run: Message[] = [];
	const sent: Array<{ message: Sent; options: Options; idle: boolean }> = [];
	const replies: Reply[] = [];
	const publications: Publication[] = [];
	const priorBoundary = new Map<Boundary["type"], BoundaryResult>();
	const handlers = new Map<string, Array<(event: ExtensionEvent, ctx: ExtensionContext) => unknown>>();
	const ctx = {
		get sessionManager() {
			return session;
		},
		isIdle: () => !active,
	} as unknown as ExtensionContext;
	const pi = {
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				bus.on(channel, handler);
				return () => {
					bus.off(channel, handler);
				};
			},
			emit(channel: string, data: unknown) {
				bus.emit(channel, data);
			},
		},
		on(type: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
			return () => list.splice(list.indexOf(handler), 1);
		},
		registerMessageRenderer() {},
		sendMessage(message: Sent, options?: Options) {
			sent.push({ message, options, idle: !active });
			const custom: Custom = { ...message, role: "custom", timestamp: 0 };
			assert.equal(options?.triggerTurn, true, "The receiver restores dropped messages through boundary drafts");
			if (!active) {
				active = true;
				initial = custom;
			} else {
				queue.push(custom);
			}
		},
	};

	async function emit(event: ExtensionEvent) {
		for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx);
	}
	async function place(message: Message) {
		await emit({ type: "message_start", message });
		for (const handler of handlers.get("message_end") ?? []) {
			const result = (await handler({ type: "message_end", message }, ctx)) as MessageEndEventResult | undefined;
			if (result?.message?.role === message.role) message = result.message;
		}
		run.push(message);
		if (message.role === "custom") {
			const id = session.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			return { id, message };
		}
		assert.ok(message.role === "user" || message.role === "assistant" || message.role === "toolResult");
		return { id: session.appendMessage(message), message };
	}
	function appendDrafts(target: SessionManager, entries: BoundaryResult["entries"]) {
		for (const entry of entries ?? []) {
			assert.ok(entry.type === "custom_message");
			target.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
		}
	}
	async function boundary(event: Boundary) {
		const prior = priorBoundary.get(event.type);
		priorBoundary.delete(event.type);
		let entries = prior?.entries ?? [];
		let shouldContinue = prior?.continue ?? false;
		for (const handler of handlers.get(event.type) ?? []) {
			const header = session.getHeader();
			assert.ok(header);
			const preview = SessionManager.inMemory("/work", undefined, [header, ...session.getBranch()]);
			appendDrafts(preview, entries);
			const projection = preview.buildSessionProjection();
			const llmMessages = convertToLlm(projection.messages);
			const result = (await handler(
				{
					...event,
					entries,
					continue: shouldContinue,
					context: {
						contextEntries: projection.entries,
						contextMessages: projection.messages,
						llmMessages,
						pendingMessages: queue.slice(),
						canContinue: queue.length > 0 || (llmMessages.length > 0 && llmMessages.at(-1)?.role !== "assistant"),
					},
				},
				ctx,
			)) as BoundaryResult | undefined;
			const continued = result?.continue ?? shouldContinue;
			assert.equal(continued, shouldContinue, "The receiver must leave continuation to Pi and other handlers");
			shouldContinue = continued;
			entries = result?.entries ?? entries;
		}
		// Pi commits the returned drafts after the boundary handlers, without message events.
		appendDrafts(session, entries);
	}
	function user(text: string): Message {
		return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
	}
	async function nextTurn() {
		await emit({ type: "turn_start", turnIndex, timestamp: 0 });
	}

	bus.on(REPLY, (data: Reply) => replies.push(data));
	return {
		bus,
		emit,
		sent,
		replies,
		publications,
		get session() {
			return session;
		},
		customMessages: () => session.buildContextEntries().filter((entry) => entry.type === "custom_message"),
		register() {
			const receiveBoundary = registerApplicationMessages(pi as unknown as ExtensionAPI);
			for (const type of ["turn_end", "agent_before_settle"] as const) {
				pi.on(type, (event) => {
					if (event.type === "turn_end" || event.type === "agent_before_settle") return receiveBoundary(event);
				});
			}
		},
		stageBoundary(type: Boundary["type"], result: BoundaryResult) {
			priorBoundary.set(type, result);
		},
		rewriteAnswer(text: string) {
			pi.on("message_end", (event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					return { message: { ...event.message, content: [{ type: "text", text }] } };
				}
			});
		},
		connect() {
			bus.on(RECEIVER, (data: Publication) => publications.push(data));
			bus.emit(REQUEST, { version: 1 });
		},
		deliver(message: Request) {
			const receiver = publications.at(-1);
			assert.ok(receiver);
			return receiver.deliver(message);
		},
		async bind(reason: "startup" | "new" = "startup") {
			if (reason === "new") session = SessionManager.inMemory("/work");
			await emit({ type: "session_start", reason });
		},
		async begin(prompt = "Operator prompt") {
			const message = initial;
			initial = undefined;
			active = true;
			turnIndex = 0;
			outcome = "completed";
			await emit({ type: "agent_start" });
			await nextTurn();
			await place(message ?? user(prompt));
		},
		async turn(response: AssistantMessage) {
			const { id, message } = await place(response);
			assert.equal(message.role, "assistant");
			const toolResults: ToolResultMessage[] = [];
			const toolResultEntryIds: string[] = [];
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const result: ToolResultMessage = {
					role: "toolResult",
					toolCallId: block.id,
					toolName: block.name,
					content: [{ type: "text", text: "A result." }],
					isError: false,
					timestamp: 0,
				};
				toolResults.push(result);
				toolResultEntryIds.push((await place(result)).id);
			}
			outcome = message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "completed";
			await boundary({
				type: "turn_end",
				turnIndex,
				outcome,
				message,
				toolResults,
				messageEntryId: id,
				toolResultEntryIds,
			});
			turnIndex += 1;
		},
		nextTurn,
		user: (text: string) => place(user(text)),
		queueUser: (text: string) => queue.push(user(text)),
		clearQueue() {
			queue.length = 0;
		},
		async drain() {
			const pending = queue.splice(0);
			await nextTurn();
			for (const message of pending) await place(message);
		},
		async settle(aborted = false) {
			await emit({ type: "agent_end", messages: run.splice(0) });
			// A bare abort leaves the queue intact and bypasses the pre-settlement boundary.
			if (!aborted) {
				assert.equal(queue.length, 0);
				await boundary({ type: "agent_before_settle", outcome });
			}
			active = false;
			await emit({ type: "agent_settled", aborted });
		},
	};
}

async function bound() {
	const pi = fixture();
	pi.register();
	pi.connect();
	await pi.bind();
	return pi;
}

function working(message: Request): Reply {
	return { version: 1, id: message.id, extension: message.extension, status: "working", text: "" };
}

function answer(message: Request, text: string, shared?: number): Reply {
	return { ...working(message), status: "answer", text, ...(shared === undefined ? {} : { shared }) };
}

function assertUnanswered(reply: Reply | undefined, message: Request) {
	assert.ok(reply);
	assert.equal(reply.version, 1);
	assert.equal(reply.status, "unanswered");
	assert.equal(reply.id, message.id);
	assert.equal(reply.extension, message.extension);
	assert.match(reply.text, /\S/u);
}

it("publishes before or in response to sender setup and preserves the callable", () => {
	for (const receiverFirst of [true, false]) {
		const pi = fixture();
		if (receiverFirst) pi.register();
		pi.connect();
		if (!receiverFirst) pi.register();
		assert.equal(pi.publications.length, 1);
		const [first] = pi.publications;
		assert.equal(first.version, 1);
		assert.equal(typeof first.deliver, "function");
		pi.bus.emit(REQUEST, { version: 2 });
		assert.equal(pi.publications.length, 1);
		pi.bus.emit(REQUEST, { version: 1 });
		assert.equal(pi.publications.length, 2);
		assert.equal(pi.publications[1].deliver, first.deliver);
	}
});

it("refuses before binding, after shutdown, and for a different session", async () => {
	const pi = fixture();
	pi.connect();
	pi.register();
	const first = request(pi.session.getSessionId(), 1);
	assert.equal(pi.deliver(first).status, "rejected");
	await pi.bind();
	assert.equal(pi.deliver({ ...first, sessionId: "other-session" }).status, "rejected");
	await pi.emit({ type: "session_shutdown", reason: "new" });
	assert.equal(pi.deliver(first).status, "rejected");
	await pi.bind("new");
	assert.equal(pi.deliver(first).status, "rejected");
	assert.deepEqual(pi.sent, []);
	assert.equal(pi.deliver({ ...first, sessionId: pi.session.getSessionId() }).status, "requested");
});

it("starts an idle run once per request and returns the first receipt before and after its answer", async () => {
	const pi = await bound();
	const original = request(pi.session.getSessionId(), 0xab);
	const message = { ...original, id: original.id.toUpperCase() };
	const receipt = pi.deliver(message);
	assert.deepEqual(receipt, { status: "requested", reference: "#000000ab" });
	assert.deepEqual(pi.deliver({ ...original, text: "Replacement" }), receipt);
	assert.equal(pi.sent.length, 1);
	assert.equal(pi.sent[0].idle, true);
	assert.deepEqual(pi.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.deepEqual(pi.replies, []);
	await pi.begin();
	assert.deepEqual(pi.replies, [working(message)]);
	pi.rewriteAnswer("The finalized answer.");
	await pi.turn(assistant("The text before finalization."));
	await pi.settle();
	assert.deepEqual(pi.deliver(original), receipt);
	assert.equal(pi.sent.length, 1);
	assert.deepEqual(pi.replies, [working(message), answer(message, "The finalized answer.")]);
});

function explanation(message: Sent, requestText: string) {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	assert.ok(text.endsWith(`\n\n${requestText}`));
	return text.slice(text.indexOf("\n") + 1, -requestText.length).trim();
}

it("includes explanation and per-extension guidance once across queued and retained context, and restores it after compaction", async () => {
	const pi = await bound();
	const sessionId = pi.session.getSessionId();
	const make = (n: number) => request(sessionId, n, "none");
	await pi.begin();
	pi.deliver(make(1));
	pi.deliver({ ...make(2), guidance: GUIDANCE });
	pi.deliver({ ...make(3), guidance: GUIDANCE });
	pi.deliver({ ...make(4), extension: "catalogue", application: "Catalogue", guidance: OTHER_GUIDANCE });
	const general = explanation(pi.sent[0].message, make(1).text);
	assert.notEqual(general, "");
	const guide = explanation(pi.sent[1].message, make(2).text);
	assert.ok(guide.includes(GUIDANCE));
	assert.ok(!guide.includes(general));
	assert.equal(explanation(pi.sent[2].message, make(3).text), "");
	const otherGuide = explanation(pi.sent[3].message, make(4).text);
	assert.ok(otherGuide.includes(OTHER_GUIDANCE));
	assert.ok(!otherGuide.includes(general));
	await pi.turn(assistant("An answer to the operator."));
	await pi.drain();
	const retained = pi.session.buildContextEntries().filter((entry) => entry.type === "custom_message");
	assert.equal(retained.length, 4);
	pi.deliver({ ...make(5), guidance: GUIDANCE });
	assert.equal(explanation(pi.sent[4].message, make(5).text), "");
	await pi.turn(assistant("A response to the first batch."));
	await pi.drain();
	await pi.turn(assistant("A response to the next batch."));
	await pi.settle();

	pi.session.appendCompaction("A summary of prior work.", retained[2].id, 100);
	const compactionEntry = pi.session.buildContextEntries().find((entry) => entry.type === "compaction");
	assert.ok(compactionEntry);
	await pi.emit({ type: "session_compact", compactionEntry, fromExtension: false, reason: "manual", willRetry: false });
	pi.deliver(make(6));
	pi.deliver({ ...make(7), guidance: GUIDANCE });
	assert.equal(explanation(pi.sent[5].message, make(6).text), general);
	assert.equal(explanation(pi.sent[6].message, make(7).text), guide);
	assert.deepEqual(pi.replies, []);
});

it("routes the first final text to all requests since the previous answer and counts other inputs", async () => {
	const pi = await bound();
	const sessionId = pi.session.getSessionId();
	const first = request(sessionId, 1);
	const second = { ...request(sessionId, 2), id: first.id, extension: "catalogue", application: "Catalogue" };
	const third = request(sessionId, 3);
	await pi.begin();
	pi.deliver(first);
	pi.deliver(second);
	assert.deepEqual(
		pi.sent.map(({ idle, options }) => ({ idle, options })),
		Array.from({ length: 2 }, () => ({ idle: false, options: { triggerTurn: true, deliverAs: "followUp" } })),
	);
	pi.deliver(request(sessionId, 4, "none"));
	await pi.turn(assistant("An answer to the initial operator prompt."));
	assert.equal(pi.replies.length, 0);
	await pi.drain();
	await pi.turn(assistant("Tool preamble.", "toolUse"));
	assert.deepEqual(pi.replies, [working(first), working(second)]);
	await pi.nextTurn();
	await pi.user("Another operator prompt");
	pi.bus.on(REPLY, (reply: Reply) => {
		if (reply.id === first.id && reply.extension === first.extension && reply.status === "answer") pi.deliver(third);
	});
	await pi.turn(assistant("First group."));
	assert.equal(pi.replies.length, 4);
	assert.deepEqual(
		pi.replies.find((reply) => reply.status === "answer" && reply.extension === first.extension),
		answer(first, "First group.", 2),
	);
	assert.deepEqual(
		pi.replies.find((reply) => reply.status === "answer" && reply.extension === second.extension),
		answer(second, "First group.", 2),
	);
	await pi.drain();
	await pi.turn(assistant("Second group."));
	await pi.settle();
	assert.deepEqual(pi.replies.slice(4), [working(third), answer(third, "Second group.")]);
});

it("refuses a full inbox without displacing an admitted request", async () => {
	const pi = await bound();
	const make = (n: number) => request(pi.session.getSessionId(), n);
	await pi.begin();
	for (let n = 0; n < 64; n++) assert.equal(pi.deliver(make(n)).status, "requested");
	assert.equal(pi.deliver(make(64)).status, "rejected");
	assert.equal(pi.deliver(make(0)).status, "requested");
	assert.equal(pi.sent.length, 64);
	await pi.drain();
	await pi.turn(assistant("An answer to all requests."));
	assert.equal(pi.replies.filter((reply) => reply.status === "answer").length, 64);
	assert.equal(pi.deliver(make(64)).status, "requested");
});

it("never routes a no-reply request, even at settlement", async () => {
	const pi = await bound();
	assert.equal(pi.deliver(request(pi.session.getSessionId(), 1, "none")).status, "requested");
	await pi.begin();
	await pi.turn(assistant("A final message."));
	await pi.settle();
	assert.deepEqual(pi.replies, []);
});

it("settles blank finals and requests without a final as unanswered", async () => {
	for (const result of ["blank", "error", "aborted", "missing"] as const) {
		const pi = await bound();
		const message = request(pi.session.getSessionId(), 1);
		pi.deliver(message);
		await pi.begin();
		if (result === "blank") {
			await pi.turn(assistant(" \n "));
			assertUnanswered(pi.replies[1], message);
		} else {
			if (result !== "missing") await pi.turn(assistant("This text is not a final answer.", result));
			assert.deepEqual(pi.replies, [working(message)]);
		}
		await pi.settle(result === "aborted");
		assert.equal(pi.replies.length, 2);
		assertUnanswered(pi.replies[1], message);
	}
});

it("does not duplicate a queued follow-up when an abort leaves Pi's queue intact", async () => {
	const pi = await bound();
	const message = request(pi.session.getSessionId(), 1);
	await pi.begin();
	pi.deliver(message);
	await pi.turn(assistant("An aborted response.", "aborted"));
	await pi.settle(true);
	assert.deepEqual(pi.customMessages(), []);
	assert.deepEqual(pi.replies, []);

	await pi.begin();
	await pi.turn(assistant("An answer to the operator."));
	assert.deepEqual(pi.replies, []);
	await pi.drain();
	await pi.turn(assistant("An answer to the queued request."));
	await pi.settle();
	assert.equal(pi.customMessages().length, 1);
	assert.equal(pi.sent.length, 1);
	assert.deepEqual(pi.replies, [working(message), answer(message, "An answer to the queued request.")]);
});

it("restores a cleared follow-up at the aborted turn's empty boundary for the next run", async () => {
	const pi = await bound();
	const message = { ...request(pi.session.getSessionId(), 1), guidance: GUIDANCE };
	await pi.begin();
	const receipt = pi.deliver(message);
	pi.clearQueue();
	await pi.turn(assistant("An aborted response.", "aborted"));
	const [restored] = pi.customMessages();
	assert.deepEqual(restored?.content, pi.sent[0].message.content);
	await pi.settle(true);
	assert.deepEqual(pi.replies, []);
	assert.deepEqual(pi.deliver(message), receipt);

	await pi.begin();
	assert.deepEqual(pi.replies, [working(message)]);
	await pi.turn(assistant("A later answer."));
	await pi.settle();
	assert.deepEqual(pi.replies, [working(message), answer(message, "A later answer.", 1)]);
	assert.equal(pi.customMessages().length, 1);
	assert.equal(pi.sent.length, 1);
});

it("waits for an empty preview after a late clear and activates restored requests on tool continuation", async () => {
	const pi = await bound();
	const message = request(pi.session.getSessionId(), 1);
	await pi.begin();
	pi.deliver(message);
	await pi.turn(assistant("An aborted response.", "aborted"));
	pi.clearQueue();
	await pi.settle(true);
	assert.deepEqual(pi.customMessages(), []);

	await pi.begin();
	pi.queueUser("An ordinary follow-up.");
	await pi.turn(assistant("An answer to the operator."));
	assert.deepEqual(pi.customMessages(), [], "An unrelated pending message does not prove that the request was dropped");
	await pi.drain();
	await pi.turn(assistant("Tool preamble.", "toolUse"));
	assert.equal(pi.customMessages().length, 1);
	assert.deepEqual(pi.replies, []);

	await pi.nextTurn();
	assert.deepEqual(pi.replies, [working(message)]);
	await pi.turn(assistant("An answer after the tool."));
	await pi.settle();
	assert.deepEqual(pi.replies, [working(message), answer(message, "An answer after the tool.", 1)]);
	assert.equal(pi.customMessages().length, 1);
	assert.equal(pi.sent.length, 1);
});

it("recovers at pre-settlement after a clear and preserves the preceding boundary draft", async () => {
	const pi = await bound();
	const message = request(pi.session.getSessionId(), 1);
	await pi.begin();
	pi.deliver(message);
	await pi.turn(assistant("An answer to the operator."));
	assert.deepEqual(pi.customMessages(), []);
	pi.clearQueue();
	pi.stageBoundary("agent_before_settle", {
		entries: [{ type: "custom_message", customType: "fixture.prior", content: "Prior draft", display: false }],
		continue: false,
	});
	await pi.settle();
	assert.deepEqual(
		pi.customMessages().map((entry) => entry.content),
		["Prior draft", pi.sent[0].message.content],
	);
	assert.equal(pi.sent.length, 1);
	assert.deepEqual(pi.replies, []);

	await pi.begin();
	await pi.turn(assistant("A later answer."));
	await pi.settle();
	assert.deepEqual(pi.replies, [working(message), answer(message, "A later answer.", 1)]);
});

it("ends a waiting request's application reply route on tree navigation or shutdown", async () => {
	for (const event of ["session_tree", "session_shutdown"] as const) {
		const pi = await bound();
		const message = request(pi.session.getSessionId(), 1);
		await pi.begin();
		const oldBranchPoint = pi.session.getLeafId();
		assert.ok(oldBranchPoint);
		pi.deliver(message);
		pi.clearQueue();
		await pi.turn(assistant("An aborted response.", "aborted"));
		await pi.settle(true);
		assert.deepEqual(pi.replies, []);
		if (event === "session_tree") {
			const oldLeafId = pi.session.getLeafId();
			pi.session.branch(oldBranchPoint);
			await pi.emit({ type: event, oldLeafId, newLeafId: oldBranchPoint });
		} else {
			await pi.emit({ type: event, reason: "reload" });
			assert.ok(pi.session.buildContextEntries().some((entry) => entry.type === "custom_message"));
		}
		assert.equal(pi.replies.length, 1);
		assertUnanswered(pi.replies[0], message);
		if (event === "session_tree") {
			await pi.begin();
			await pi.turn(assistant("An answer on another branch."));
			await pi.settle();
			assert.equal(pi.replies.length, 1);
		}
	}
});
