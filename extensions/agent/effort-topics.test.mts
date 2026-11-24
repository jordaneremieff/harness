import assert from "node:assert/strict";
import { it } from "node:test";
import { MIN_SHARED_TOPICS, SHARED_TOPICS_SHOWN, sharedTopics, topicTerms } from "./effort-topics.ts";

it("keeps distinctive words and drops function words, generic agent work, identifiers and short words", () => {
	assert.deepEqual(
		[...topicTerms(["Please review the PaymentService retry idempotency in md-4e1cac1fe4430cdda5ea and 2026 runs"])],
		["payment", "service", "retry", "idempotency"],
	);
	assert.deepEqual([...topicTerms(["Fix the agent extension tests in this session and update the harness"])], []);
	assert.deepEqual([...topicTerms(["Refunds, retries and policies"])], ["refund", "retry", "policy"]);
	assert.deepEqual([...topicTerms(["status analysis process"])], ["status", "analysis", "process"]);
	assert.deepEqual(
		[...topicTerms(["Überprüfe die Zahlungsdienst Schnittstelle"])],
		["überprüfe", "zahlungsdienst", "schnittstelle"],
	);
	assert.deepEqual([...topicTerms([undefined, "", "deadbeef01 a1b2c3d4 2026x ".repeat(3)])], []);
});

it("bounds the terms and the text it reads", () => {
	const words = Array.from(
		{ length: 500 },
		(_, i) => `topic${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}`,
	);
	assert.equal(topicTerms([words.join(" ")]).size, 64);
	assert.equal(topicTerms(["x".repeat(5000), "payment design"]).size, 0, "text past the read bound is ignored");
});

it("relates two sessions only at the shared-term threshold and reports terms in a stable order", () => {
	const design = topicTerms(["Design the payment service API and its failure modes"]);
	const review = topicTerms(["Check the payment edge cases against the design"]);
	assert.deepEqual(sharedTopics(design, review), ["design", "payment"]);
	assert.deepEqual(sharedTopics(review, design), ["design", "payment"]);
	assert.equal(MIN_SHARED_TOPICS, 2);
	assert.deepEqual(sharedTopics(design, topicTerms(["Write the payment notes"])), [], "one shared term is not a topic");
	const many = topicTerms(["alpha bravo charlie delta echo foxtrot golf hotel india juliet"]);
	assert.equal(sharedTopics(many, many).length, SHARED_TOPICS_SHOWN);
	assert.deepEqual(sharedTopics(many, many), [...many].sort().slice(0, SHARED_TOPICS_SHOWN));
});
