import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { explorerApplicationRoutes } from "./application-messages.ts";
import type { LivePublisher } from "./live-bridge.ts";

const publication = "harness:application-messages:receiver";
const request = "harness:application-messages:request";
const reply = "harness:application-messages:reply";
function ask() {
	const id = randomUUID().toUpperCase();
	return { requestId: id, threadId: id, root: "/project/engine", text: "\treturn '👩‍💻';\r\nWhy here?" };
}

test("Explorer delivers the root, thread and exact body, and routes a shared answer by ID", async () => {
	const events = createEventBus();
	const requests: unknown[] = [];
	const messages: Record<string, unknown>[] = [];
	const report = (id: string, status: string, text: string, extra = {}) =>
		events.emit(reply, { version: 1, extension: "explorer", id, status, text, ...extra });
	events.on(request, (payload) => {
		requests.push(payload);
		events.emit(publication, {
			version: 1,
			deliver(message: Record<string, unknown>) {
				messages.push(message);
				const id = String(message.id);
				report(id, "working", "");
				return { status: "requested", reference: `#${id.slice(0, 8).toLowerCase()}` };
			},
		});
	});
	const route = explorerApplicationRoutes(events)("session", () => {});
	assert.deepEqual(requests, [{ version: 1 }]);
	const updates: Parameters<LivePublisher>[] = [];
	assert.ok(route.observe);
	const close = await route.observe((...update) => updates.push(update));
	const first = ask();
	const next = { ...ask(), threadId: first.requestId };
	assert.deepEqual(await route.submit(first), { status: "requested" });
	assert.deepEqual(await route.submit(next), { status: "requested" });
	const { guidance, ...envelope } = messages[0];
	assert.match(String(guidance), /explorer_notes.*op "read"/u);
	assert.deepEqual(envelope, {
		version: 1,
		sessionId: "session",
		extension: "explorer",
		application: "Explorer",
		id: first.requestId,
		subject: "engine",
		place: "root /project/engine",
		reply: "final",
		text: first.text,
	});
	assert.deepEqual(messages[1], { ...envelope, id: next.requestId, follows: first.requestId, guidance });
	report(next.requestId, "answer", "Not from this sender", { extension: "other" });
	report(next.requestId, "answer", "Unknown version", { version: 2 });
	report(randomUUID(), "answer", "Not from this route");
	for (const id of [next.requestId, first.requestId]) report(id, "answer", "Both answers", { shared: 1 });
	report(first.requestId, "unanswered", "Late reply");
	assert.deepEqual(updates, [
		["working", "", first.requestId],
		["working", "", next.requestId],
		...[next.requestId, first.requestId].map((id) => [
			"answer",
			`Shared reply for #${id.slice(0, 8).toLowerCase()} and 1 other message:\n\nBoth answers`,
			id,
		]),
	]);
	const another = { ...ask(), root: `/parent/${"🥝".repeat(150)}/name\n\u200B\u2028end` };
	await route.submit(another);
	assert.equal(messages[2].subject, "name end");
	const label = String(messages[2].place);
	assert.ok(label.length <= 200 && label.startsWith("root …") && label.endsWith("/name end"));
	assert.doesNotMatch(label, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u);
	report(another.requestId, "unanswered", "The conversation closed.");
	assert.deepEqual(updates.at(-1), ["error", "The conversation closed.", another.requestId]);
	const last = ask();
	await route.submit(last);
	close();
	report(last.requestId, "answer", "After detach");
	assert.deepEqual(updates.at(-1), ["working", "", last.requestId]);
});

test("without a receiver Explorer refuses; the latest valid publication supplies the receipt", async () => {
	const events = createEventBus();
	const route = explorerApplicationRoutes(events)("session", () => {});
	const updates: Parameters<LivePublisher>[] = [];
	assert.ok(route.observe);
	await route.observe((...update) => updates.push(update));
	const prompt = ask();
	assert.deepEqual(await route.submit(prompt), {
		status: "rejected",
		message: "This conversation has no application message receiver.",
	});
	const receipt = { status: "rejected", message: "The conversation changed." };
	events.emit(publication, { version: 1, deliver: () => receipt });
	events.emit(publication, { version: 2, deliver: () => assert.fail("Version 2 is unknown") });
	events.emit(publication, { version: 1 });
	assert.deepEqual(await route.submit(prompt), receipt);
	events.emit(reply, {
		version: 1,
		extension: "explorer",
		id: prompt.requestId,
		status: "answer",
		text: "Not delivered",
	});
	assert.deepEqual(updates, []);
	events.emit(publication, {
		version: 1,
		deliver: ({ id }: { id: string }) => ({ status: "requested", reference: `#${id.slice(0, 8).toLowerCase()}` }),
	});
	assert.deepEqual(await route.submit(ask()), { status: "requested" });
});
