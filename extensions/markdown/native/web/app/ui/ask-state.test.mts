import assert from "node:assert/strict";
import test from "node:test";
import { plain, scripts } from "../../test/load.mts";

const { reader } = scripts(["app/core/exact.ts", "app/ui/logic.ts", "app/ui/ask-state.ts"], { reader: {} });
const version = (presentation: string, generation: number) => ({ documentKey: "A", presentation, generation });
function question(draft: string): ReaderThread {
	return { threadId: "question", draft, messages: [] };
}

test("revisions and a round trip through another document preserve the card, private batch and late answer", () => {
	const sessions = reader.createAskSessions();
	const a = sessions.show("A", "Alpha", "digest-a");
	const thread = question("Can you clarify this?");
	a.threads.push(thread);
	a.current = thread;
	a.visible = true;
	a.heldThread = thread;
	a.comments.push({ text: "First comment", authoredRevision: 1 });
	a.overall = "Keep both points in view.";
	a.overallRevision = 1;
	const message: ReaderAskMessage = { requestId: "one", state: "sending", text: "Prior question", authoredRevision: 1 };
	thread.messages.push(message);
	sessions.register(a, thread, message);
	const b = sessions.show("B", "Beta", "digest-b");
	assert.equal(b.current, null);
	assert.deepEqual(plain(b.comments), []);
	assert.equal(b.overall, "");
	b.threads.push(question("B only"));
	const delivery = sessions.delivery("one", "question");
	assert.equal(delivery?.owner, a);
	assert.equal(sessions.delivery("one", "unrelated"), undefined);
	assert.ok(delivery);
	delivery.message.state = "answered";
	delivery.message.detail = "A's answer";
	assert.equal(sessions.show("A", "Revised Alpha", "digest-new"), a);
	assert.equal(a.current, thread);
	assert.equal(a.current.draft, "Can you clarify this?");
	assert.equal(a.current.messages[0].detail, "A's answer");
	assert.equal(a.visible, true);
	assert.equal(a.heldThread, thread);
	assert.equal(a.comments[0].text, "First comment");
	assert.equal(a.overall, "Keep both points in view.");
	assert.equal(a.overallRevision, 1);
	assert.equal(sessions.show("B", "Beta", "digest-b").threads[0].draft, "B only");
});

test("uncertain sends replay the identical packet; a confirmed fresh refusal permits remapped coordinates", () => {
	const sessions = reader.createAskSessions();
	const a = sessions.show("A", "alpha", "one");
	const message: ReaderAskMessage = { requestId: "q", state: "sending", text: "Explain this", authoredRevision: 1 };
	const thread = {
		...question(""),
		threadId: "q",
		messages: [message],
		range: { start: 0, end: 5 },
		quote: "alpha",
		sourceAnchor: reader.uiLogic.capturePassage("alpha", { start: 0, end: 5 }),
	};
	a.threads.push(thread);
	const first = sessions.packet(thread, message, version("p1", 0));
	sessions.change([{ start: 0, end: 0, expected: "", text: "new " }], "new alpha");
	assert.deepEqual(plain(thread.range), { start: 4, end: 9 });
	const updated = version("p2", 1);
	assert.equal(sessions.packet(thread, message, updated), first);
	assert.deepEqual(plain(first.quoteRange), { start: 0, end: 5 });
	sessions.releasePacket(message);
	const retry = sessions.packet(thread, message, updated);
	assert.deepEqual(plain(retry), {
		...updated,
		requestId: "q",
		threadId: "q",
		text: "Explain this",
		quote: "alpha",
		quoteRange: { start: 4, end: 9 },
		passageAnchor: { text: "alpha", contexts: [] },
		authoredRevision: 1,
	});
});

function viewOf(source: string): ReaderPassageView {
	let start = 0;
	return {
		blocks: source.split("\n").map((line, i) => {
			const block = {
				key: String(i),
				start,
				end: start + line.length,
				type: line.startsWith("# ") ? "heading1" : "paragraph",
			};
			start += line.length + 1;
			return block;
		}),
	};
}

test("a replaced pending or parked comment cannot move to another occurrence, even after a second edit and refresh", () => {
	const original = "# Alpha\nStatus: ready.\n# Beta\nStatus: ready.";
	const changed = original.replace("ready", "done");
	const sessions = reader.createAskSessions(),
		a = sessions.show("A", original, "v1");
	const range = { start: original.indexOf("ready"), end: original.indexOf("ready") + 5 };
	const item: ReaderComment = {
		text: "Clarify",
		quote: "ready",
		authoredRevision: 1,
		range,
		sourceAnchor: reader.uiLogic.capturePassage(original, range, viewOf(original), "ready"),
	};
	a.parked = [{ comment: item, text: item.text, index: 0 }];
	sessions.change([{ ...range, expected: "ready", text: "done" }], changed);
	sessions.change([{ start: changed.length, end: changed.length, expected: "", text: "!" }], `${changed}!`);
	assert.equal(item.range, undefined);
	assert.equal(
		item.sourceAnchor,
		undefined,
		"recovery cannot store unrestricted evidence while native rendering is pending",
	);
	sessions.render(viewOf(`${changed}!`));
	sessions.show("A", original.replace("# Alpha", "# Gamma"), "v3");
	sessions.render(viewOf(original.replace("# Alpha", "# Gamma")));
	assert.equal(item.range, undefined);
	assert.equal(item.quote, "ready");
	assert.equal(item.authoredRevision, 1);
});

test("a refetched review mark follows known edits but never reanchors after its passage was deleted", () => {
	const source = "# Section\nAlpha ready.",
		quote = "ready";
	const range = { start: source.indexOf(quote), end: source.indexOf(quote) + quote.length };
	const sessions = reader.createAskSessions(),
		owner = sessions.show("A", source, "original");
	sessions.render(viewOf(source));
	const seed = {
		text: "Explain",
		quote,
		range,
		sourceAnchor: reader.uiLogic.capturePassage(source, range, viewOf(source), quote),
		anchorDigest: "original",
	};
	const mark = sessions.trackReview(owner, "row", seed);
	assert.deepEqual(plain(mark.range), range);
	sessions.change([{ start: 0, end: 0, expected: "", text: "🍐\n" }], `🍐\n${source}`);
	assert.equal(mark.range?.start, range.start + 3);
	const revised = `🍐\n${source.replace("ready", "gone")}`;
	sessions.change([{ start: range.start + 3, end: range.end + 3, expected: quote, text: "gone" }], revised);
	sessions.render(viewOf(revised));
	assert.equal(mark.range, undefined);
	sessions.show("B", "B", "other");
	const other = sessions.trackReview(sessions.shown, "row", seed);
	assert.notEqual(other, mark);
	sessions.show("A", source, "original");
	sessions.render(viewOf(source));
	assert.equal(sessions.trackReview(owner, "row", structuredClone(seed)), mark);
	assert.equal(mark.range, undefined);
	assert.equal(mark.quote, quote);
});

test("restored offsets are authoritative only for matching source, including repeated headings and emoji", () => {
	const text = "# Same\n🍋 pass\n# Same\n🍋 pass",
		range = { start: text.lastIndexOf("pass"), end: text.length };
	const anchor = reader.uiLogic.capturePassage(text, range, viewOf(text), "pass");
	const sessions = reader.createAskSessions(),
		a = sessions.show("A", text, "original");
	const item: ReaderComment = {
		text: "Here",
		range: { ...range },
		anchorDigest: "original",
		sourceAnchor: anchor,
		quote: "pass",
	};
	a.comments = [item];
	sessions.render(viewOf(text));
	sessions.restoreRanges(a);
	assert.deepEqual(plain(item.range), range);
	sessions.show("B", "Other", "other");
	sessions.show("A", text, "original");
	sessions.render(viewOf(text));
	assert.deepEqual(plain(item.range), range);
	sessions.show("A", `${text}!`, "changed");
	sessions.render(viewOf(`${text}!`));
	assert.equal(item.range, undefined);
});

test("private drafts keep only proven ranges, with parked items intact after a batch consume", () => {
	const sessions = reader.createAskSessions(),
		digest = `sha256:${"a".repeat(64)}`,
		owner = sessions.show("A", "abcd", digest);
	const comment = {
		text: "Explain",
		quote: "bc",
		range: { start: 1, end: 3 },
		authoredRevision: 1,
		sourceAnchor: { text: "bc", contexts: [] },
	};
	owner.comments.push(comment);
	owner.overall = "Together";
	owner.overallRevision = 2;
	owner.parked = [{ text: "Explain", index: 0, comment }];
	assert.deepEqual(plain(sessions.snapshot(owner)), {
		comments: [{ ...comment, anchorDigest: digest }],
		overall: "Together",
		overallRevision: 2,
		parked: [{ text: "Explain", index: 0, comment: { ...comment, anchorDigest: digest } }],
	});
	const remaining = sessions.snapshot(owner, true);
	assert.deepEqual(plain(remaining), {
		comments: [],
		overall: "",
		parked: [{ text: "Explain", index: 0, comment: { ...comment, anchorDigest: digest } }],
	});
	owner.digest = undefined;
	assert.equal(sessions.snapshot(owner)?.comments[0].range, undefined);
	comment.sourceAnchor.text = "previous markdown";
	assert.deepEqual(plain(sessions.snapshot(owner)?.comments[0]), { text: "Explain", quote: "bc", authoredRevision: 1 });
	assert.equal(remaining?.parked?.[0].comment?.sourceAnchor?.text, "bc");
});

test("batch members, the overall comment and a follow-up keep their own authored revisions", () => {
	const sessions = reader.createAskSessions();
	const thread: ReaderThread = {
		...question(""),
		threadId: "batch",
		comments: [
			{ text: "On the first version", range: { start: 3, end: 5 }, quote: "it", authoredRevision: 1 },
			{ text: "On the second version", authoredRevision: 2 },
		],
		overall: "General direction",
	};
	const batch: ReaderAskMessage = { requestId: "batch", text: "Batch", state: "sending", authoredRevision: 3 };
	const followUp: ReaderAskMessage = {
		requestId: "follow-up",
		text: "And another thing",
		state: "sending",
		authoredRevision: 4,
	};
	thread.messages.push(batch, followUp);
	const v = version("p5", 7);
	assert.deepEqual(plain(sessions.packet(thread, batch, v)), {
		...v,
		requestId: "batch",
		threadId: "batch",
		overall: "General direction",
		authoredRevision: 3,
		annotations: [
			{ text: "On the first version", quote: "it", quoteRange: { start: 3, end: 5 }, authoredRevision: 1 },
			{ text: "On the second version", authoredRevision: 2 },
		],
	});
	assert.deepEqual(plain(sessions.packet(thread, followUp, v)), {
		...v,
		requestId: "follow-up",
		threadId: "batch",
		text: "And another thing",
		authoredRevision: 4,
	});
});

test("Save As moves the private batch and its open editor without changing passage coordinates", () => {
	const sessions = reader.createAskSessions(),
		old = sessions.show("private", "same");
	const range = { start: 1, end: 3 },
		comment = { text: "active", range },
		closed = { text: "closed", range };
	old.comments.push(comment);
	old.parked = [
		{ text: "closed", comment: closed, index: 0 },
		{ text: "earlier overall", index: -1, authoredRevision: 2 },
	];
	old.overall = "source overall";
	old.overallRevision = 3;
	const editor = { ...question(""), pendingComment: comment };
	old.visible = true;
	old.current = editor;
	const card = { ...question("card"), range };
	old.threads.push(card);
	const next = sessions.show("destination", "same");
	const existing = { text: "existing" };
	next.comments.push(existing);
	next.overall = "destination overall";
	next.overallRevision = 7;
	sessions.moveUnsent(old, next);
	assert.equal(next.comments[0], existing);
	assert.equal(next.comments[1], comment);
	assert.equal(next.current, editor);
	assert.equal(next.visible, true);
	assert.equal(next.comments[1].range, range);
	assert.equal(next.threads[0], card);
	assert.equal(card.range, range);
	assert.equal(next.parked?.[0].comment, closed);
	assert.equal(next.parked?.[0].index, 1);
	assert.equal(next.overall, "destination overall");
	assert.equal(next.overallRevision, 7);
	assert.deepEqual(plain(next.parked?.slice(1)), [
		{ text: "earlier overall", index: -1, authoredRevision: 2 },
		{ text: "source overall", index: -1, authoredRevision: 3 },
	]);
	assert.equal(old.current, null);
	assert.equal(old.visible, false);
	assert.equal(old.threads.length, 0);
	assert.equal(old.comments.length, 0);
	assert.equal(old.overall, "");
	assert.equal(old.overallRevision, undefined);
	assert.equal(old.parked, undefined);
	sessions.moveUnsent(old, next);
	sessions.moveUnsent(next, next);
	assert.equal(next.comments.length, 2);
	assert.equal(next.threads.length, 1);
	assert.equal(next.parked?.length, 3);
});

test("Save As detaches only the unsent follow-up and leaves each attempted request at its original destination", () => {
	const sessions = reader.createAskSessions(),
		old = sessions.show("old", "alpha", "d");
	const message: ReaderAskMessage = { requestId: "old-request", text: "attempted", state: "unknown" };
	const thread: ReaderThread = {
		threadId: "delivered",
		draft: "my reply",
		draftRevision: 4,
		quote: "alpha",
		range: { start: 0, end: 5 },
		messages: [message],
	};
	old.threads.push(thread);
	old.current = thread;
	old.visible = true;
	old.heldThread = thread;
	old.overall = "move this overall";
	old.overallRevision = 5;
	sessions.register(old, thread, message);
	const original = sessions.packet(thread, message, { documentKey: old.documentKey, presentation: "p", generation: 1 });
	const next = sessions.show("new", "alpha", "d");
	const existing = question("different unsent draft");
	next.current = existing;
	next.visible = true;
	const other: ReaderThread = {
		threadId: "other",
		messages: [{ requestId: "other", text: "already sent", state: "sent" }],
		draft: "different follow-up",
	};
	next.threads.push(existing, other);
	sessions.moveUnsent(old, next);
	const fresh = next.threads[2];
	assert.notEqual(fresh, thread);
	assert.equal(fresh.draft, "my reply");
	assert.equal(fresh.draftRevision, 4);
	assert.equal(fresh.threadId, "");
	assert.equal(fresh.messages.length, 0);
	assert.equal(fresh.range, thread.range);
	assert.equal(old.heldThread, thread);
	assert.equal(old.current, thread);
	assert.equal(old.threads.length, 1);
	assert.equal(thread.draft, "");
	assert.equal(thread.draftRevision, undefined);
	assert.equal(next.current, existing);
	assert.equal(other.draft, "different follow-up");
	assert.equal(next.overall, "move this overall");
	assert.equal(next.overallRevision, 5);
	const result = sessions.delivery("old-request", "delivered");
	assert.ok(result);
	result.message.detail = "late reply";
	assert.equal(result.owner, old);
	assert.equal(result.thread, thread);
	assert.equal(thread.messages[0].detail, "late reply");
	assert.equal(sessions.packet(thread, message, { documentKey: "new", presentation: "q", generation: 3 }), original);
	assert.equal(sessions.show("old", "alpha", "d").current, thread);
	assert.equal(sessions.show("new", "alpha", "d").current, existing);
	assert.equal(fresh.messages.length, 0);
});
