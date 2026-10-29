import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DurableRecallState, NOTICE_BYTES, type RecallState, WATERMARK_CAP } from "./durable-state.ts";

const id = (value: number) => value as unknown as ConversationId;
function state(watermark: string, count = 1): RecallState {
	return {
		watermark,
		notices: Array.from({ length: count }, (_, index) => ({
			occurrence: `${index}`,
			text: "x".repeat(2048),
			root: "/fixture",
			slug: "subject",
			digest: "a".repeat(64),
		})),
	};
}

test("watermark-only eviction preserves visible notice bytes and refreshes empty retention order", () => {
	const cache = new DurableRecallState();
	const visible = state("visible");
	cache.set(id(-1), visible);
	for (let i = 0; i < WATERMARK_CAP; i++) cache.set(id(i), { watermark: `${i}`, notices: [] });
	assert.equal(cache.get(id(0))?.watermark, "0");
	cache.set(id(WATERMARK_CAP), { watermark: "overflow", notices: [] });
	assert.equal(cache.get(id(1)), undefined);
	assert.equal(cache.get(id(0))?.watermark, "0");
	assert.deepEqual(cache.get(id(-1)), visible);
	for (let i = WATERMARK_CAP + 1; i < WATERMARK_CAP * 3; i++) cache.set(id(i), { watermark: `${i}`, notices: [] });
	assert.deepEqual(cache.get(id(-1)), visible);
});

test("visible conversations evict least-recently-used state only past the host byte budget", () => {
	const cache = new DurableRecallState();
	const notices = state("visible", 128);
	const bytes = Buffer.byteLength(JSON.stringify(notices.notices));
	const fitting = Math.floor(NOTICE_BYTES / bytes);
	assert.ok(fitting > 1);
	for (let i = 0; i < fitting; i++) cache.set(id(i), notices);
	for (let i = 0; i < fitting; i++) assert.deepEqual(cache.get(id(i)), notices);
	cache.get(id(0));
	cache.set(id(fitting), notices);
	assert.equal(cache.get(id(1)), undefined);
	assert.deepEqual(cache.get(id(0)), notices);
	assert.deepEqual(cache.get(id(fitting)), notices);
	cache.delete(id(0));
	cache.set(id(fitting + 1), notices);
	assert.deepEqual(cache.get(id(2)), notices);
});

test("caller mutation does not change cached bytes or notice order", () => {
	const cache = new DurableRecallState();
	const original = state("original");
	cache.set(id(1), original);
	original.notices.push(...state("extra").notices);
	original.notices[0].text = "changed outside the cache";
	const first = cache.get(id(1));
	assert.ok(first);
	first.notices[0].root = "/changed";
	first.notices.length = 0;
	assert.equal(cache.get(id(1))?.notices.length, 1);
	assert.equal(cache.get(id(1))?.notices[0].text, "x".repeat(2048));
	assert.equal(cache.get(id(1))?.notices[0].root, "/fixture");
});
