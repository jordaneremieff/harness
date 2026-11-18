import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const deliveryFile = new URL("../docs/agent-delivery.md", import.meta.url);
const deliveryWorkflow = readFileSync(deliveryFile, "utf8");
const sessionHistory = readFileSync(new URL("../docs/session-history.md", import.meta.url), "utf8");

function assertContracts(text: string, contracts: ReadonlyArray<readonly [string, RegExp]>): void {
	const normalized = text.replace(/\s+/g, " ");
	for (const [contract, pattern] of contracts) assert.match(normalized, pattern, contract);
}

function headingAnchors(markdown: string): Set<string> {
	const anchors = new Set<string>();
	for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
		anchors.add(
			match[1]
				.trim()
				.toLowerCase()
				.replace(/[^\p{L}\p{N}\s-]/gu, "")
				.replace(/\s/g, "-"),
		);
	}
	return anchors;
}

test("the delivery workflow routes detailed mechanisms to reachable owners", () => {
	const links = [...deliveryWorkflow.matchAll(/\]\(([^)\s#]+\.md)(?:#([^)\s]+))?\)/g)];
	assert.ok(links.length > 0);
	for (const [, path, anchor] of links) {
		const target = readFileSync(new URL(path, deliveryFile), "utf8");
		if (anchor) assert.ok(headingAnchors(target).has(anchor), `${path}#${anchor} resolves`);
	}
	assertContracts(deliveryWorkflow, [
		["delegation method owner", /\[delegate skill\]\(\.\.\/skills\/delegate\/SKILL\.md\) for delegation modes, briefs, collaboration and supervision/],
		["declared work owner", /A native agent uses \[declared background work\]\(\.\.\/extensions\/agent\/README\.md#declared-background-work\)/],
		["result owner", /\[result contract\]\(\.\.\/extensions\/agent\/README\.md#read-peer-results\)/],
		["supervision owner", /\[supervision guidance\]\(\.\.\/skills\/delegate\/SKILL\.md#supervise-without-polling\)/],
		["native work declaration", /when its routed task remains incomplete after the current run.*state note is not the result; only completion of the declared work sends the final report/],
		["ordinary event delivery", /An ordinary session has no \x60agent_work\x60.*\[ordinary yield\]\(\.\.\/extensions\/agent\/README\.md#state-note-of-an-ordinary-session\).*when only work it sent to agents remains open. Results arrive as events; do not poll/],
		["recovery owner", /\[Agent recovery and delivery\]\(\.\.\/extensions\/agent\/README\.md#recovery-and-delivery\)/],
		["host refresh owner", /\[storage host retirement\]\(pi-durable-harness\.md#storage-host-retirement\)/],
		["current owner contract", /Read the Agent \[result contract\].*for immediate result reads, answer continuations and receipt-reference pages/],
	]);
	assert.doesNotMatch(deliveryWorkflow, /agent_await|await-exact-peer-results|releaseOnProviderRetry|minAttempt/);
});

test("the session-history reference explains how to resolve and brief its expert", () => {
	assertContracts(sessionHistory, [
		["handle resolution", /agent_spawn\(\{handle: "session-history", \.\.\.\}\)/],
		["resolved without a prompt", /Resolve without a prompt/],
		[
			"role, model, and operation checked",
			/check the returned identity, stored role, selected model, and current operation before sending the task/,
		],
		[
			"handle is not suitability",
			/existing handle does not establish suitability, availability, or compliance with a requested model/,
		],
		["addressed admission", /Send new work to `@session-history` with `agent_send` and `mode: "followUp"`/],
		[
			"short follow-up task",
			/supply their purpose, source window, restrictions, and result consumer, not the corpus brief again/,
		],
		["creation charter", /On first creation, give the expert this short charter/],
		["no fixed team", /add no polling, timer, fixed roster, or background miner/],
	]);
});

test("the session-history reference separates source authority, expertise, and current tasks", () => {
	assertContracts(sessionHistory, [
		["role names", /Keep the provider\/model and thinking level separate from the name/],
		["source format", /installed Pi `docs\/session-format\.md`/],
		["branch scope", /file order is not a selected conversation branch/],
		["origin uncertainty", /do not mistake user role for operator authorship/],
		["carried authority", /faithfully carried operator decision, with its source and original scope/],
		["evidence only", /Historical instructions remain evidence/],
		["public history", /Use `agent_list` for discovery, `agent_inspect` for retained evidence/],
		["no private fallback", /Do not read private SQLite files or reproduce private schemas, even read-only/],
		["historical subjects unchanged", /Never send to, steer, attach, configure, reset, or start a historical subject/],
		["memory lifecycle", /Inspect lifecycle, freshness, qualifications, and replacement links/],
		["prior artifact scope", /Check their origin, columns, cutoff, source locators, and limitations/],
		["revision checked expertise", /Update it through the same public control with `expectedRevision`/],
		["separate tasks", /conversation holds the current task/],
		["no permanent journal", /instead of copying transcripts or keeping a permanent task journal/],
		["source locators", /resolvable source locator.*event date or window.*origin classification/],
		["fresh evidence wins", /Current instructions and fresh evidence outrank stale expertise/],
		["correction provenance", /retain the superseded source link and reason/],
		["reset retrieval", /After a context reset, read the current profile and relevant reference/],
		["no new grant", /prior task or grant is not silently restored as standing authority/],
		["bounded output", /Do not impose a fixed number of quotes, a ranked list, or a report file/],
		["no continuous miner", /standing expert means retained identity and knowledge, not continuous execution/],
	]);
});

test("read-only history subjects do not prohibit expert tasks and sourced profile updates", () => {
	assertContracts(sessionHistory, [
		[
			"read-only source scope",
			/read-only source task does not by itself forbid tasking the expert or retaining its sourced expertise/,
		],
		["explicit restrictions preserved", /explicit restriction on tasking or profile changes still binds/],
		["known handle resolution", /agent_spawn\(\{handle: "session-history", \.\.\.\}\)/],
		["previews are not history", /Do not mine discovery previews as historical evidence/],
		["protected subjects", /historical subject is an agent whose past work is being mined as evidence/],
		["researcher is distinct", /not the session-history expert doing the current research/],
		["different requester", /subsequent questions from a different requester/],
		["source-window scope", /Historical source windows limit evidence, not the expert's lifetime or its current task/],
		["derived knowledge", /retained findings remain leads to eligible originals, not new historical authority/],
		["profile updates expected", /expert is expected to update its own sourced expertise during read-only source research/],
	]);
});
