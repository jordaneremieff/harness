import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	renderControlResult,
	renderDispatchCall,
	renderMessageCall,
	renderMessageResult,
	renderPeersCall,
	renderPeersResult,
	renderProfilesCall,
	renderProfilesResult,
	renderReportCall,
	renderReportResult,
	renderWorkerCall,
	renderWorkerResult,
} from "./tool-presentation.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const tagTheme = { fg: (color: string, value: string) => `[${color}]${value}`, bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): string[] }, width = 160) => component.render(width).map(stripVTControlCharacters).join("\n");
const tagged = (component: { render(width: number): string[] }, width = 240) => component.render(width).join("\n");
const call = { expanded: false, argsComplete: true };
const options = { expanded: false, isPartial: false };
const context = { isError: false };

describe("subagent tool presentation", () => {
	it("shows requested configuration separately for every task rather than the batch default", () => {
		const args = { model: "provider/default", thinking: "high", tasks: [{ task: "Inspect the parser", model: "other/reviewer", thinking: "low" }, { task: "Read the contract", profile: "checker" }] };
		const before = structuredClone(args);
		const text = screen(renderDispatchCall(args, theme, call, "protocol"));
		assert.match(text, /batch: 2 tasks/);
		assert.match(text, /Requested: other\/reviewer · thinking low/);
		assert.match(text, /Requested: provider\/default · thinking high/);
		assert.doesNotMatch(text, /Resolved|running|Started/);
		assert.deepEqual(args, before);
	});

	it("keeps inherited and profile configuration unresolved until result data exists", () => {
		assert.match(screen(renderDispatchCall({ task: "Review", profile: "reviewer" }, theme, call, "")), /profile reviewer or parent/);
		assert.match(screen(renderDispatchCall({ task: "Review" }, theme, call, "")), /parent \(unresolved\)/);
		assert.deepEqual(
			trimmed(renderWorkerCall("subagent_continue", { id: "source", message: "Continue" }, theme, call)),
			["subagent_continue · source", "Continue"],
		);
	});

	it("renders partial and malformed streamed args safely and refreshes the reused component", () => {
		for (const args of [undefined, null, { plan: { members: [null, 4, { model: [] }] } }, { tasks: [null, { task: {}, thinking: 4 }] }]) {
			for (const expanded of [false, true]) assert.ok(renderDispatchCall(args, theme, { ...call, expanded, argsComplete: false }, "protocol").render(20).length);
		}
		const initial = renderDispatchCall({}, theme, { ...call, argsComplete: false }, "");
		assert.match(screen(initial), /task pending/);
		const updated = renderDispatchCall({ task: "Complete task", model: "p/m", thinking: "off" }, theme, { ...call, lastComponent: initial }, "");
		assert.equal(initial, updated);
		assert.match(screen(updated), /p\/m · thinking off/);
		assert.doesNotMatch(screen(updated), /task pending/);
	});

	it("shows resolved records, requested thinking, fallback, errors, and unknowns without mutating evidence", () => {
		const result = { content: [{ type: "text" as const, text: "Started one worker\nfull evidence" }], details: { workers: [
			{ id: "worker-a", label: "Review", state: "running", model: "fallback/model", thinking: "high", thinkingRequested: "max", modelFallback: { requested: "first/model", events: [{ model: "first/model", reason: "quota", phase: "preflight" }] } },
			{ id: "worker-b", state: "failed", model: null, error: "Setup refused" },
		] } };
		const before = structuredClone(result);
		const text = screen(renderWorkerResult(result, options, theme, context));
		assert.match(text, /Review · running/);
		assert.match(text, /Resolved: fallback\/model · thinking high \(requested max\)/);
		assert.match(text, /Fallback: requested first\/model/);
		assert.match(text, /model unknown · thinking unknown/);
		assert.match(text, /Setup refused/);
		const expanded = screen(renderWorkerResult(result, { ...options, expanded: true }, theme, context));
		assert.match(expanded, /worker-a/);
		assert.match(expanded, /quota/);
		assert.match(expanded, /full evidence/);
		assert.deepEqual(result, before);
	});

	it("keeps preflight plan models distinct from started workers", () => {
		const args = { dryRun: true, plan: { name: "panel-review", members: [{ task: "one", model: "p/a" }, { task: "two", model: "q/b" }] } };
		assert.match(screen(renderDispatchCall(args, theme, call, "")), /Preview only; no workers or model calls/);
		const result = { content: [{ type: "text" as const, text: "complete plan" }], details: { dryRun: true, plan: { members: [{ role: "reviewer", label: "one", model: "p/a", thinking: "low" }] } } };
		const text = screen(renderWorkerResult(result, options, theme, context));
		assert.match(text, /Local preflight preview; no workers started/);
		assert.match(text, /Preflight: p\/a · thinking low/);
		assert.doesNotMatch(text, /Resolved|state unknown/);
	});

	it("retains complete expanded arguments, protocol, and all batch members", () => {
		const tasks = Array.from({ length: 7 }, (_, i) => ({ task: `Task ${i}\nEND ${i}`, model: `provider/model-${i}` }));
		const collapsed = screen(renderDispatchCall({ tasks }, theme, call, "PROTOCOL"));
		assert.match(collapsed, /3 more tasks/);
		assert.doesNotMatch(collapsed, /model-6/);
		const expanded = screen(renderDispatchCall({ tasks, sharedContext: "full shared text" }, theme, { ...call, expanded: true }, "PROTOCOL"));
		assert.match(expanded, /model-6/);
		assert.match(expanded, /END 6/);
		assert.match(expanded, /full shared text/);
		assert.match(expanded, /PROTOCOL/);
	});

	it("escapes terminal controls and wraps long identities across narrow and wide native rows", () => {
		const unsafe = "日本語 😀\x1b]52;c;test\x07\u202e";
		const args = { task: unsafe, model: `provider/${"long-model-".repeat(20)}`, thinking: "high" };
		for (const expanded of [false, true]) {
			const rendered = renderDispatchCall(args, theme, { ...call, expanded }, unsafe);
			for (const width of [12, 24, 80, 160]) {
				assert.ok(rendered.render(width).every((line) => visibleWidth(line) <= width));
				assert.doesNotMatch(screen(rendered, width), /[\x1b\x07\u202e]/u);
			}
		}
		const result = { content: [{ type: "text" as const, text: unsafe }], details: { worker: { label: unsafe, model: unsafe, thinking: unsafe } } };
		for (const expanded of [false, true]) assert.doesNotMatch(screen(renderWorkerResult(result, { ...options, expanded }, theme, context)), /[\x1b\x07\u202e]/u);
	});

	it("bounds each expanded source prefix before escape expansion without splitting surrogate pairs", () => {
		const notice = "[Display limit; full text remains in native tool history.]";
		const render = (text: string) => renderWorkerResult({ content: [{ type: "text", text }], details: undefined }, { ...options, expanded: true }, theme, context).render(800).map((line) => stripVTControlCharacters(line).trimEnd()).join("");
		const controls = "\u202e".repeat(64_000);
		const escaped = "\\u{202e}".repeat(64_000);
		assert.equal(escaped.length, 512_000);
		assert.equal(render(controls), escaped);
		assert.equal(render(`${controls}OMITTED`), escaped + notice);
		assert.equal(render(`${"x".repeat(63_999)}\u{e0001}OMITTED`), "x".repeat(63_999) + notice);
	});

	it("marks clipped evidence, avoids duplicate errors, and keeps plan JSON in expansion", () => {
		const result = { content: [{ type: "text" as const, text: "x".repeat(900) }], details: undefined };
		assert.match(screen(renderWorkerResult(result, options, theme, context)), /…/);
		const failed = { content: [{ type: "text" as const, text: "Exact setup error" }], details: { worker: { error: "Exact setup error" } } };
		assert.equal(screen(renderWorkerResult(failed, options, theme, { isError: true })).split("Exact setup error").length - 1, 1);
		const plan = { content: [{ type: "text" as const, text: '{"members":[]}' }], details: { dryRun: true, plan: { members: [] } } };
		assert.doesNotMatch(screen(renderWorkerResult(plan, options, theme, context)), /"members"/);
		assert.match(screen(renderWorkerResult(plan, { ...options, expanded: true }, theme, context)), /"members"/);
	});

	it("labels errors and partial results without metadata or success inference", () => {
		const result = { content: [{ type: "text" as const, text: "No worker started" }], details: undefined };
		assert.match(screen(renderWorkerResult(result, options, theme, { isError: true })), /Tool error/);
		assert.match(screen(renderWorkerResult(result, { ...options, isPartial: true }, theme, context)), /Partial result/);
		assert.doesNotMatch(screen(renderWorkerResult(result, options, theme, context)), /Resolved/);
	});
});

const resultCtx = (isError: boolean, args?: unknown) => ({ isError, args });
const ok = (text: string, details: unknown) => ({ content: [{ type: "text" as const, text }], details });

const trimmed = (component: { render(width: number): string[] }, width = 160) =>
	component.render(width).map((line) => stripVTControlCharacters(line).trim());

describe("subagent control and collaboration cards", () => {
	it("shows one heading and at most one qualifier row for control calls", () => {
		assert.deepEqual(trimmed(renderWorkerCall("subagent_steer", { id: "bg-1", message: "fix the timeout" }, theme, call)), [
			"subagent_steer · bg-1",
			"fix the timeout",
		]);
		assert.deepEqual(trimmed(renderWorkerCall("subagent_interrupt", { id: "bg-1" }, theme, call)), ["subagent_interrupt · bg-1"]);
		assert.deepEqual(trimmed(renderWorkerCall("subagent_kill", { id: "bg-1" }, theme, call)), ["subagent_kill · bg-1"]);
		const clipped = trimmed(renderWorkerCall("subagent_steer", { id: "bg-1", message: "x".repeat(300) }, theme, call));
		assert.match(clipped.join("\n"), /…/);
		assert.match(clipped.at(-1) ?? "", /Expand for message|Ctrl\+O to expand message/);
	});

	it("keeps streamed or missing control arguments safe and refreshes the reused component", () => {
		for (const args of [undefined, null, {}, { id: 4 }]) {
			for (const expanded of [false, true]) assert.ok(renderWorkerCall("subagent_kill", args, theme, { ...call, expanded, argsComplete: false }).render(20).length);
		}
		assert.match(screen(renderWorkerCall("subagent_steer", {}, theme, { ...call, argsComplete: false })), /id pending/);
		assert.deepEqual(trimmed(renderWorkerCall("subagent_steer", {}, theme, call)), ["subagent_steer"]);
		const initial = renderWorkerCall("subagent_kill", {}, theme, { ...call, argsComplete: false });
		const updated = renderWorkerCall("subagent_kill", { id: "bg-2" }, theme, { ...call, lastComponent: initial });
		assert.equal(initial, updated);
		assert.match(screen(updated), /bg-2/);
		assert.match(screen(renderWorkerCall("subagent_kill", { id: "bg-2" }, theme, { ...call, expanded: true })), /"bg-2"/);
	});

	it("states a control outcome without repeating the request, and colors it from the structured result", () => {
		const steer = tagged(renderControlResult("steer", ok("Steer queued for bg-1: fix", { id: "bg-1", ok: true }), options, tagTheme, resultCtx(false)));
		assert.match(steer, /\[success\]/);
		assert.match(steer, /Queued for delivery; not proof of worker action/);
		assert.doesNotMatch(steer, /bg-1|fix/);
		assert.match(
			tagged(renderControlResult("steer", ok("Resume queued for bg-1: go", { id: "bg-1", ok: true }), options, tagTheme, resultCtx(false))),
			/Resume queued; not proof of worker action/,
		);
		assert.match(
			tagged(renderControlResult("steer", ok("Prompt started for bg-1: go", { id: "bg-1", ok: true }), options, tagTheme, resultCtx(false))),
			/Prompt started for an idle worker; not proof of action/,
		);
		const refused = tagged(renderControlResult("steer", ok("No worker with id bg-9 in the store.", { id: "bg-9", ok: false }), options, tagTheme, resultCtx(false)));
		assert.match(refused, /\[warning\]/);
		assert.doesNotMatch(refused, /\[error\]/);
		assert.match(refused, /No worker with id bg-9 in the store\./);
		assert.match(tagged(renderControlResult("kill", ok("Worker bg-1 cancelled after 12s.", { id: "bg-1", state: "cancelled" }), options, tagTheme, resultCtx(false))), /\[success\].*Cancelled/);
		const alreadyTerminal = tagged(renderControlResult("kill", ok("Worker bg-1 is already done; nothing to cancel.", { id: "bg-1", state: "done" }), options, tagTheme, resultCtx(false)));
		assert.match(alreadyTerminal, /\[warning\]/);
		assert.doesNotMatch(alreadyTerminal, /\[error\]/);
		assert.match(alreadyTerminal, /Worker bg-1 is already done; nothing to cancel\./);
		assert.match(tagged(renderControlResult("kill", ok("Worker bg-1 is done after 12s: it settled before the abort landed.", { id: "bg-1", state: "done" }), options, tagTheme, resultCtx(false))), /\[warning\]/);
		assert.match(tagged(renderControlResult("kill", ok("No worker with id bg-9 in the store.", {}), options, tagTheme, resultCtx(false))), /\[warning\]/);
		assert.match(tagged(renderControlResult("interrupt", ok("Interrupted bg-1: the worker stays alive; resumable.", {}), options, tagTheme, resultCtx(false))), /\[success\].*Interrupted; the worker stays resumable/);
		assert.match(tagged(renderControlResult("interrupt", ok("No live worker bg-9 in this session.", {}), options, tagTheme, resultCtx(false))), /\[warning\]/);
	});

	it("handles control errors, partials, and malformed details without a false outcome", () => {
		assert.match(screen(renderControlResult("steer", ok("boom", undefined), options, theme, resultCtx(true))), /Tool error/);
		assert.match(screen(renderControlResult("steer", ok("boom", undefined), options, theme, resultCtx(true))), /boom/);
		assert.match(screen(renderControlResult("kill", ok("waiting", undefined), { ...options, isPartial: true }, theme, resultCtx(false))), /Partial result/);
		const malformed = screen(renderControlResult("steer", { content: [{ type: "text" as const, text: "" }], details: { ok: "yes" } }, options, tagTheme, resultCtx(false)));
		assert.match(malformed, /No outcome text/);
		assert.doesNotMatch(malformed, /\[success\]|\[error\]/);
		const expanded = screen(renderControlResult("steer", ok("Steer queued", { id: "bg-1", ok: true }), { ...options, expanded: true }, theme, resultCtx(false)));
		assert.match(expanded, /"ok": true/);
	});

	it("renders report calls and receipts without claiming parent receipt", () => {
		assert.deepEqual(trimmed(renderReportCall({ message: "blocked on the parser" }, theme, call)), ["subagent_report · blocked on the parser"]);
		assert.deepEqual(trimmed(renderReportCall({}, theme, { ...call, argsComplete: false })), ["subagent_report", "message pending"]);
		assert.match(screen(renderReportCall({ message: "x" }, theme, { ...call, expanded: true })), /"message"/);
		const details = { status: "sent_unconfirmed", workerId: "bg-7", ownerSession: "01abc", reportNumber: 3, messageBytes: 120, sentAt: 1 };
		const text = "Report #3 sent to the dispatching session (120 bytes). Status: sent_unconfirmed.";
		const card = screen(renderReportResult(ok(text, details), options, theme, resultCtx(false)));
		assert.deepEqual(trimmed(renderReportResult(ok(text, details), options, theme, resultCtx(false))), [
			"Report #3 sent (120 bytes) to session 01abc · sent_unconfirmed (not proof of receipt or action)",
		]);
		assert.match(card, /Report #3 sent \(120 bytes\) to session 01abc/);
		assert.match(card, /sent_unconfirmed \(not proof of receipt or action\)/);
		assert.doesNotMatch(card, /received|read|acted/i);
		assert.doesNotMatch(card, /the send call returned/);
		assert.doesNotMatch(card, /Expand|Ctrl\+O/);
		assert.match(screen(renderReportResult(ok(text, details), { ...options, expanded: true }, theme, resultCtx(false))), /sentAt/);
		assert.match(screen(renderReportResult(ok("report failed", undefined), options, theme, resultCtx(true))), /report failed/);
		assert.match(screen(renderReportResult(ok("", {}), options, theme, resultCtx(false))), /Outcome unknown/);
	});

	it("summarizes a peer page by count and continuation instead of raw records", () => {
		const peers = Array.from({ length: 5 }, (_, i) => ({ id: `bg-${i + 2}`, parent: "bg-1", label: `review-parser#${i + 1}` }));
		const details = { self: "bg-1", total: 5, offset: 0, nextOffset: 32, peers };
		assert.deepEqual(trimmed(renderPeersResult(ok(JSON.stringify(details), details), options, theme, resultCtx(false))), [
			"Self bg-1 · family of 5 (self included) · more at offset 32",
			"Expand for peer addresses",
		]);
		const expanded = screen(renderPeersResult(ok(JSON.stringify(details), details), { ...options, expanded: true }, theme, resultCtx(false)));
		assert.match(expanded, /review-parser#1 · bg-2 · parent bg-1/);
		assert.match(expanded, /bg-6/);
		assert.match(screen(renderPeersResult(ok("not a peer", undefined), options, theme, resultCtx(true))), /Tool error/);
		assert.match(screen(renderPeersResult(ok("not a peer", undefined), options, theme, resultCtx(true))), /not a peer/);
		assert.match(screen(renderPeersResult(ok("{}", { self: "bg-1", total: 1, offset: 0, nextOffset: null, peers: [] }), options, theme, resultCtx(false))), /family of 1 \(self included\)/);
		assert.deepEqual(trimmed(renderPeersCall({ offset: 32 }, theme, call)), ["subagent_peers · from entry 32"]);
		assert.deepEqual(trimmed(renderPeersCall({}, theme, call)), ["subagent_peers"]);
		for (const args of [undefined, null, { offset: "x" }]) assert.ok(renderPeersCall(args, theme, call).render(20).length);
	});

	it("separates a peer send from a receipt read and keeps receipt state exact", () => {
		assert.deepEqual(trimmed(renderMessageCall({ to: "bg-2", message: "need the citation" }, theme, call)), [
			"subagent_message → bg-2",
			"need the citation",
		]);
		assert.match(screen(renderMessageCall({ to: "bg-2", message: "x", replyTo: "pm-1", reference: { obligationId: "o1" } }, theme, call)), /x · reply pm-1 · reference/);
		assert.deepEqual(trimmed(renderMessageCall({ id: "pm-1" }, theme, call)), ["subagent_message · receipt pm-1"]);
		assert.match(screen(renderMessageCall({}, theme, { ...call, argsComplete: false })), /target pending/);
		assert.match(screen(renderMessageCall({ id: "pm-1" }, theme, { ...call, expanded: true })), /"pm-1"/);
		const receipt = { id: "pm-1", from: "bg-1", to: "bg-2", replyTo: null, sentAt: 1 };
		const send = trimmed(renderMessageResult(ok("raw", { ...receipt, status: "sent_unconfirmed" }), options, theme, resultCtx(false, { to: "bg-2", message: "x" })));
		assert.deepEqual(send, ["pm-1 · sent_unconfirmed (not proof of receipt or action)"]);
		assert.doesNotMatch(send.join("\n"), /Peer message to/);
		assert.match(
			screen(renderMessageResult(ok("raw", { ...receipt, status: "sent_unconfirmed" }), { ...options, expanded: true }, theme, resultCtx(false, { to: "bg-2", message: "x" }))),
			/the send call returned; not proof of receipt, persistence, or action/,
		);
		const read = trimmed(renderMessageResult(ok("raw", { ...receipt, status: "context_seen" }), options, theme, resultCtx(false, { id: "pm-1" })));
		assert.deepEqual(read, ["context_seen (context observed; not proof of model understanding)"]);
		assert.doesNotMatch(read.join("\n"), /pm-1/);
		assert.deepEqual(trimmed(renderMessageResult(ok("", { ...receipt, status: "target_closed" }), options, theme, resultCtx(false, { id: "pm-1" }))), [
			"target_closed (endpoint closed before context observation)",
		]);
		assert.deepEqual(trimmed(renderMessageResult(ok("", { ...receipt, status: "weird" }), options, theme, resultCtx(false, { id: "pm-1" }))), [
			"weird (status not recognized; expand for the retained receipt)",
		]);
		assert.match(screen(renderMessageResult(ok("Peer is unavailable; nothing was sent", undefined), options, theme, resultCtx(true, { to: "bg-2", message: "x" }))), /Peer is unavailable/);
		assert.deepEqual(trimmed(renderMessageResult(ok("", {}), options, theme, resultCtx(false, { id: "pm-1" }))), [
			"status unknown (no retained status in this result)",
		]);
	});

	it("describes a profile request in the heading and one combined qualifier row", () => {
		const digest = "a".repeat(64);
		const definition = { model: "p/x", thinking: "high", cwd: ".", grounding: [{ name: "a", path: "b" }], instructions: "abc" };
		const update = trimmed(renderProfilesCall({ action: "update", name: "check-profile", definition, expectedSha256: digest }, theme, call));
		assert.equal(update[0], "subagent_profiles · update · check-profile");
		assert.equal(update[1], "definition: p/x · thinking high · cwd . · 1 grounding pointer · 3 instruction chars · digest aaaaaaaaaaaa…");
		assert.match(update[2] ?? "", /Expand for profile definition|Ctrl\+O to expand profile definition/);
		assert.deepEqual(trimmed(renderProfilesCall({ action: "list" }, theme, call)), ["subagent_profiles · list"]);
		assert.deepEqual(trimmed(renderProfilesCall({ action: "read", name: "check-profile" }, theme, call)), ["subagent_profiles · read · check-profile"]);
		assert.deepEqual(trimmed(renderProfilesCall({ action: "disable", name: "check-profile", expectedSha256: digest }, theme, call)), [
			"subagent_profiles · disable · check-profile",
			"digest aaaaaaaaaaaa…",
			"Expand for profile definition",
		]);
		assert.match(screen(renderProfilesCall({}, theme, { ...call, argsComplete: false })), /action pending/);
		for (const args of [undefined, null, { action: 4, definition: [] }]) assert.ok(renderProfilesCall(args, theme, call).render(20).length);
		assert.match(screen(renderProfilesCall({ action: "update", name: "x", definition: {}, expectedSha256: digest }, theme, { ...call, expanded: true })), /"expectedSha256"/);
	});

	it("summarizes profile list, read, and mutation results from structured details", () => {
		const entry = { ok: true, name: "check-profile", path: "/p", sha256: "a".repeat(64), enabled: true, model: "p/x", thinking: "high" };
		const listDetails = { filter: null, text: "one", entries: [entry, { ok: false, name: "broken", path: "/q", sha256: null, error: "bad json" }, entry, entry], truncated: true };
		const list = trimmed(renderProfilesResult(ok("one", listDetails), options, theme, resultCtx(false)));
		assert.deepEqual(list, ["4 profiles · 3 enabled · 1 unreadable · list truncated", "Expand for profile names and records"]);
		const read = trimmed(renderProfilesResult(ok("{}", { action: "read", entry }), options, theme, resultCtx(false)));
		assert.deepEqual(read, ["enabled · p/x", "sha256 aaaaaaaaaaaa…; retain for a later mutation"]);
		const update = trimmed(renderProfilesResult(ok("{}", { action: "update", name: "check-profile", entry }), options, theme, resultCtx(false)));
		assert.deepEqual(update, ["Replaced", "new digest aaaaaaaaaaaa… · existing worker snapshots are unchanged"]);
		assert.deepEqual(trimmed(renderProfilesResult(ok("{}", { action: "remove", name: "check-profile", entry: null }), options, theme, resultCtx(false))), [
			"Removed",
			"existing worker snapshots are unchanged",
		]);
		assert.match(screen(renderProfilesResult(ok("{}", { action: "enable", name: "check-profile", entry }), options, theme, resultCtx(false))), /Enabled/);
		assert.match(screen(renderProfilesResult(ok("invalid digest", undefined), options, theme, resultCtx(true))), /invalid digest/);
		assert.match(screen(renderProfilesResult(ok("{}", { action: "update", name: "check-profile", entry }), { ...options, expanded: true }, theme, resultCtx(false))), /"action": "update"/);
	});

	it("escapes controls, clips long values, and stays within narrow widths", () => {
		const unsafe = "日本語 😀\x1b]52;c;test\x07\u202e";
		const long = `message ${unsafe} ${'x'.repeat(400)}`;
		const calls = [
			renderWorkerCall("subagent_steer", { id: unsafe, message: long }, theme, call),
			renderReportCall({ message: long }, theme, call),
			renderMessageCall({ to: unsafe, message: long }, theme, call),
			renderMessageCall({ id: unsafe }, theme, call),
			renderPeersCall({ offset: 1 }, theme, call),
			renderProfilesCall({ action: "update", name: "check-profile", definition: { instructions: long }, expectedSha256: "a".repeat(64) }, theme, call),
		];
		const results = [
			renderControlResult("steer", ok(long, { id: unsafe, ok: true }), options, theme, resultCtx(false)),
			renderReportResult(ok(long, { status: "sent_unconfirmed", reportNumber: 1, messageBytes: 1, ownerSession: unsafe }), options, theme, resultCtx(false)),
			renderPeersResult(ok(long, { self: unsafe, total: 1, offset: 0, nextOffset: null, peers: [{ id: unsafe, label: unsafe, parent: unsafe }] }), options, theme, resultCtx(false)),
			renderMessageResult(ok(long, { id: unsafe, from: unsafe, to: unsafe, replyTo: null, sentAt: 1, status: "sent_unconfirmed" }), options, theme, resultCtx(false, { id: unsafe })),
			renderProfilesResult(ok(long, { action: "read", entry: { ok: false, name: unsafe, path: unsafe, sha256: null, error: long } }), options, theme, resultCtx(false)),
		];
		assert.match(screen(calls[0]), /…/);
		for (const component of [...calls, ...results]) {
			for (const width of [12, 24, 80, 160]) {
				const lines = component.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				assert.doesNotMatch(lines.map(stripVTControlCharacters).join("\n"), /[\x1b\x07\u202e]/u);
			}
		}
	});

	it("does not mutate the result on any new renderer", () => {
		const details = { id: "bg-1", ok: true };
		const result = { content: [{ type: "text" as const, text: "Steer queued" }], details };
		const before = structuredClone(result);
		renderControlResult("steer", result, options, theme, resultCtx(false));
		renderControlResult("steer", result, { ...options, expanded: true }, theme, resultCtx(false));
		assert.deepEqual(result, before);
	});
});
