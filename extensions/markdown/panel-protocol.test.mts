import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { acquireResponse, PAGE_BYTES, readPanelAnswer, readPanelRequest, responsePage } from "./panel-protocol.ts";
import { responseSnapshot, responseText, validUnicode } from "./responses.ts";

const snapshot = (text: string) => {
	const value = responseSnapshot(fauxAssistantMessage(text), "42", { kind: "native-response", session: "storage", conversation: "1" });
	assert.ok(value);
	return value;
};
test("finite request union rejects malformed and extra data", () => {
	for (const value of [null, {}, { op: "launch" }, { op: "recent", executable: "x" }, { op: "response", entryId: "42", offset: -1 }, { op: "response", entryId: "42", offset: 0.5 }, { op: "response", entryId: "42" }, { op: "published", cursor: 1 }]) assert.throws(() => readPanelRequest(value));
	assert.deepEqual(readPanelRequest({ op: "recent" }), { op: "recent" });
	assert.deepEqual(readPanelRequest({ op: "published", cursor: "next" }), { op: "published", cursor: "next" });
	assert.deepEqual(readPanelRequest({ op: "response", entryId: "42", offset: 0 }), { op: "response", entryId: "42", offset: 0 });
});
test("Unicode pages preserve surrogate pairs, combining marks and source part boundaries", async () => {
	const value = snapshot(`${"x".repeat(PAGE_BYTES - 1)}😀e\u0301${"y".repeat(PAGE_BYTES)}\nlast`);
	value.parts.push("another part");
	value.provenance.parts.push({ chars: 12 });
	const first = responsePage(value, 0);
	assert.equal(first.nextOffset, PAGE_BYTES - 1);
	assert.ok(validUnicode(first.text));
	const result = await acquireResponse("42", async (request) => {
		assert.equal(request.op, "response");
		if (request.op !== "response") throw new Error("unexpected");
		return responsePage(value, request.offset);
	}, new AbortController().signal);
	assert.deepEqual(result.parts, value.parts);
	assert.equal(result.timestamp, value.timestamp);
	assert.equal(result.provenance.host, value.provenance.host);
	assert.equal(responseText(result), responseText(value));
	const combining = snapshot(`${"x".repeat(PAGE_BYTES - 1)}e\u0301`);
	assert.equal(responsePage(combining, 0).nextOffset, PAGE_BYTES);
	const joined = await acquireResponse("42", async (request) => responsePage(combining, request.op === "response" ? request.offset : 0), new AbortController().signal);
	assert.equal(responseText(joined), responseText(combining));
	assert.throws(() => responsePage(value, PAGE_BYTES), /boundary/u);
});
test("page identity, digest and completeness mismatches fail before materialization", async () => {
	const value = snapshot("x".repeat(PAGE_BYTES + 2));
	const request = { op: "response", entryId: "42", offset: 0 } as const;
	assert.throws(() => readPanelAnswer(request, { ...responsePage(value, 0), entryId: "43" }));
	assert.throws(() => readPanelAnswer(request, { ...responsePage(value, 0), nextOffset: 1 }));
	for (const patch of [{ digest: `sha256:${"0".repeat(64)}` }, { stop: "aborted" }, { timestamp: 0 }, { completeness: { state: "partial", reason: "length" } }] as const) {
		await assert.rejects(acquireResponse("42", async (req) => {
			const offset = req.op === "response" ? req.offset : 0;
			return { ...responsePage(value, offset), ...(offset ? patch : {}) };
		}, new AbortController().signal), /changed/u);
	}
	await assert.rejects(acquireResponse("42", async () => ({ ...responsePage(snapshot("same"), 0), text: "evil" }), new AbortController().signal), /digest/u);
});
test("published rows require a store identity, but an absent store has none", () => {
	const request = { op: "published" } as const;
	const absent = { op: "published", rows: [], root: "/store", limited: false };
	assert.deepEqual(readPanelAnswer(request, absent), absent);
	assert.throws(() => readPanelAnswer(request, { ...absent, storeId: "invalid" }));
	const present = { ...absent, rows: [{ id: `md-${"a".repeat(20)}`, title: "Document", revision: 1, bytes: 2, kind: "published", digest: `sha256:${"b".repeat(64)}`, updatedAt: "2026-01-01T00:00:00Z" }] };
	assert.throws(() => readPanelAnswer(request, present));
	assert.equal(readPanelAnswer(request, { ...present, storeId: "c".repeat(32) }).op, "published");
});
test("withdrawn acquisition drops a late page", async () => {
	const controller = new AbortController();
	await assert.rejects(acquireResponse("42", async () => { controller.abort(); return responsePage(snapshot("text"), 0); }, controller.signal), /abort/iu);
});
