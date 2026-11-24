import assert from "node:assert/strict";
import { it } from "node:test";
import { RecoveryOrder } from "./recovery-order.ts";

it("completes the entry of every read that began before an acquisition settled, and of no later read", () => {
	const order = new RecoveryOrder();
	const first = order.begin();
	const second = order.begin();
	assert.equal(order.done("storage", first.at), false);
	order.settled("storage");
	assert.equal(order.done("storage", first.at), true);
	assert.equal(order.done("storage", second.at), true, "the outcome is newer than the overlapping read");
	assert.equal(order.done("other", first.at), false, "an outcome covers its own storage only");
	const later = order.begin();
	assert.equal(order.done("storage", later.at), false, "a read that began after the outcome acts on its own evidence");
});

it("keeps no outcome once every read has ended, and counts a repeated end once", () => {
	const order = new RecoveryOrder();
	const first = order.begin();
	const second = order.begin();
	order.settled("storage");
	first.end();
	first.end();
	assert.equal(order.done("storage", second.at), true, "an open read keeps the outcomes it can still use");
	second.end();
	assert.equal(order.done("storage", second.at), false);
});

it("does not count an acquisition that was withdrawn", () => {
	const order = new RecoveryOrder();
	const read = order.begin();
	order.settled("storage");
	order.withdraw("storage");
	assert.equal(order.done("storage", read.at), false);
});
