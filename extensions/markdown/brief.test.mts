import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, formatBrief, BRIEF_SCAN_BYTES } from "./brief.ts";
import { transcriptMessage } from "./brief-tool.ts";

const user = (text: string) => ({ role: "user" as const, text });
const assistant = (text: string) => ({ role: "assistant" as const, text });
const tool = (text: string) => ({ role: "toolResult" as const, text });

test("three typed requests use the current branch order and skip likely injected user content", () => {
	const latest = `I need the result. ${"🍎".repeat(700)}`;
	const brief = buildBrief({ title: "Roof", checks: ["Check text."], messages: [
		user(""), user("<header>Context</header>"), user("# Kickoff"), user("Read docs/example.md first"), user("A".repeat(3001)),
		user(latest), user("What did it cost?"), user("Does the roof hold?"), user("Too old."),
	] });
	assert.deepEqual(brief.requests, ["Does the roof hold?", "What did it cost?", [...latest].slice(0, 600).join("")]);
	assert.equal(brief.skipped, 5);
	const text = formatBrief(brief);
	assert.match(text, /Writing brief for "Roof"/u);
	assert.match(text, /latest requests in this conversation, oldest first/u);
	assert.match(text, /Check text\.$/u);
});

test("the default reader does not have the work history and the brief reports unavailable transcripts", () => {
	const brief = buildBrief({ checks: [] });
	assert.equal(brief.requests, undefined);
	assert.equal(brief.terms, undefined);
	assert.match(brief.reader, /reads this document on its own.*did not see your tool calls/u);
	assert.match(formatBrief(brief), /could not read the conversation/u);
	assert.equal(buildBrief({ reader: "  A station manager.  ", checks: [] }).reader, "A station manager.");
});

test("only names in assistant prose count, ranked by use and filtered against request vocabulary and the lexicon", () => {
	const messages = [tool("only_tool only_tool only_tool backup-path backup-path knownThing"), assistant("freshPath freshPath used_name backup-path used_name knownThing common `exact name` /tmp/widget ca132e9b module.entry 12345678-abcd-1234-abcd-123456789abc 2026-11-18T10:02:03Z 1234 `nil` `function` `var` `~/tmp/a-socket` {\"noise_key\": true}"), user("Explain knownThing and used_name. Also explain the exact name."), assistant("tooOld"), user("Earlier question.")];
	const brief = buildBrief({ checks: [], messages });
	assert.deepEqual(brief.terms, ["freshPath", "backup-path", "module.entry"]);
	const configured = buildBrief({ checks: [], messages, lexicon: new Set(["freshpath", "backup-path", "explain", "and", "question", "earlier"]) });
	assert.deepEqual(configured.terms, ["module.entry"]);
});

test("term collection bounds the scan by UTF-8 bytes and limits the returned names", () => {
	const suffix = Array.from({ length: 30 }, (_, i) => `term_${i}`).join(" ");
	const output = buildBrief({ checks: [], messages: [assistant(`tooOld ${"界".repeat(BRIEF_SCAN_BYTES / 3)}${suffix}`), user("What happened?")] });
	assert.equal(output.limited, true);
	assert.equal(output.terms?.length, 15);
	assert.ok(!output.terms?.includes("tooOld"));
});

test("the transcript adapter retains visible text, not reasoning, tool arguments or tool details", () => {
	assert.deepEqual(transcriptMessage({ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "toolCall", arguments: { password: "not text" } }, { type: "text", text: "Keep this." }] }), assistant("Keep this."));
	assert.equal(transcriptMessage({ role: "system", content: "Injected." }), undefined);
});
