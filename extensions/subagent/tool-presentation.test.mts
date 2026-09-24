import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderDispatchCall, renderWorkerCall, renderWorkerResult } from "./tool-presentation.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): string[] }, width = 160) => component.render(width).map(stripVTControlCharacters).join("\n");
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
		assert.match(screen(renderWorkerCall("subagent_continue", { id: "source", message: "Continue" }, theme, call)), /retained session/);
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
