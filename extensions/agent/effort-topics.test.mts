import assert from "node:assert/strict";
import { it } from "node:test";
import { MIN_SHARED_TOPICS, SHARED_TOPICS_SHOWN, sharedTopics, topicTerms } from "./effort-topics.ts";

const terms = (...texts: (string | undefined)[]) => [...topicTerms(texts)];

it("keeps distinctive words and drops function words, generic agent work, identifiers and short words", () => {
	assert.deepEqual(
		terms("Please review the PaymentGateway retry idempotency in md-4e1cac1fe4430cdda5ea and 2026 runs"),
		["payment", "gateway", "retry", "idempotency"],
	);
	assert.deepEqual(terms("Fix the agent extension tests in this session and update the harness"), []);
	assert.deepEqual(terms("Refunds, retries and policies"), ["refund", "retry", "policy"]);
	assert.deepEqual(terms("Überprüfe die Zahlungsdienst Schnittstelle"), [
		"überprüfe",
		"zahlungsdienst",
		"schnittstelle",
	]);
	assert.deepEqual(terms(undefined, "", "deadbeef01 a1b2c3d4 2026x ".repeat(3)), []);
});

it("folds plurals after sibilant endings so stop words and subjects match their plural", () => {
	assert.deepEqual(terms("branches fixes pushes commits"), [], "plural stop words stay excluded");
	assert.deepEqual(terms("batches mailboxes crashes indexes"), ["batch", "mailbox", "crash", "index"]);
	assert.deepEqual(terms("caches niches approaches searches"), ["cache", "niche", "approach"]);
	assert.deepEqual(sharedTopics(topicTerms(["Tune the batch cache"]), topicTerms(["batches and caches"])), [
		"batch",
		"cache",
	]);
});

it("excludes inflected forms of generic words and generic engineering nouns", () => {
	assert.deepEqual(
		terms("reviewing reviewed updating updated fixing fixed failed created testing checking investigating broken"),
		[],
	);
	assert.deepEqual(terms("error config server service schema query production staging debug audit settings"), []);
	const billing = topicTerms(["Reviewing the updated billing code"]);
	const markdown = topicTerms(["Reviewing the updated markdown extension"]);
	assert.deepEqual(sharedTopics(billing, markdown), [], "generic inflected words never relate two sessions");
});

it("keeps three-letter acronyms written in capitals and splits camel case around them", () => {
	assert.deepEqual(terms("Tune the RDS SQL indexes behind the MCPs"), ["tune", "rds", "sql", "index", "mcp"]);
	assert.deepEqual(terms("Wrap the API and the CLI for the SDK"), ["wrap"], "generic acronyms name no subject");
	assert.deepEqual(terms("HTTPProxy OAuthToken JSONParser"), ["proxy", "oauth", "token", "parser"]);
	assert.deepEqual(terms("PLEASE FIX THE BUG NOW"), [], "capitals across the whole text mark no acronym");
	assert.deepEqual(terms("rds sql"), [], "lowercase short words are not acronyms");
});

it("ignores paths, URLs, addresses and snake_case identifiers", () => {
	assert.deepEqual(terms("Read /srv/someone/billing/notes.md and ~/drafts/ledger.txt"), []);
	assert.deepEqual(terms("See https://example.com/ledger and ops@example.com"), []);
	assert.deepEqual(terms("Call agent_spawn and rex_terminal for the ledger"), ["ledger"]);
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
	const design = topicTerms(["Design the payment gateway and its failure modes"]);
	const review = topicTerms(["Check the payment edge cases against the design"]);
	assert.deepEqual(sharedTopics(design, review), ["design", "payment"]);
	assert.deepEqual(sharedTopics(review, design), ["design", "payment"]);
	assert.equal(MIN_SHARED_TOPICS, 2);
	assert.deepEqual(sharedTopics(design, topicTerms(["Write the payment notes"])), [], "one shared term is not a topic");
	const many = topicTerms(["alpha bravo charlie delta echo foxtrot golf hotel india juliet"]);
	assert.equal(sharedTopics(many, many).length, SHARED_TOPICS_SHOWN);
	assert.deepEqual(sharedTopics(many, many), [...many].sort().slice(0, SHARED_TOPICS_SHOWN));
});
