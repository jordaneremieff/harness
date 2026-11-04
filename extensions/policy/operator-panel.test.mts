/** The attached-terminal policy panel: the shared panel and approval reader over a host request route. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { operatorPanel, type OperatorPanelHost } from "./operator-panel.ts";
import { readPanelRequest, serializeSnapshot, serializeFireSummary } from "./panel-protocol.ts";
import type { RuleSnapshot } from "./local-rules.ts";
import type { RuleRecord } from "./rule.ts";

type JsonValue = Parameters<OperatorPanelHost["request"]>[0];
const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text } as unknown as OperatorPanelHost["theme"];
const flush = async () => { for (let round = 0; round < 10; round++) await new Promise((resolve) => setImmediate(resolve)); };

function rule(id: string): RuleRecord {
	return {
		id,
		source: { kind: "package" },
		matcher: { kind: "declarative", language: "facts/v1", spec: { phase: "input", when: { op: "eq", path: ["tool"], value: "bash" }, action: { kind: "guide", text: "Mind it." }, onUnavailable: "skip" } },
		definition: { revision: "aaaaaaaaaaaa", state: "active", authority: "steer-or-block", effect: "steer", purpose: "Guide.", note: "Note." },
		matcherAvailable: true,
		staleOverride: false,
	} as unknown as RuleRecord;
}

function snapshot(): RuleSnapshot {
	return { records: new Map([["local.scan", rule("local.scan")]]), pending: [], data: new Map(), health: { status: "ok", path: "/tmp/policy" } };
}

function hostFixture(answers: Partial<Record<string, (request: Record<string, unknown>) => unknown>> = {}) {
	const requests: Record<string, unknown>[] = [];
	const inputs: Array<string | undefined> = [];
	const notices: string[] = [];
	let closed = 0;
	const host: OperatorPanelHost = {
		target: { id: "conversation-1" }, theme, tui: { requestRender() {} }, rows: () => 24,
		request: async (data) => {
			const request = data as Record<string, unknown>;
			requests.push(request);
			const custom = answers[String(request.op)];
			if (custom) return { text: "custom", data: custom(request) as JsonValue };
			if (request.op === "load") return { text: "load", data: { op: "load", snapshot: serializeSnapshot(snapshot()), fireSummary: serializeFireSummary({ fires: new Map(), firesByModel: new Map(), partial: false }), activity: { records: [], partial: false, byteLimited: false, recordLimited: false, bytesRead: 0 }, scope: { cwd: "/work" } } as unknown as JsonValue };
			if (request.op === "lifecycle") return { text: "ok", data: { op: "lifecycle", outcome: `Disabled ${String(request.id)}.`, snapshot: serializeSnapshot(snapshot()) } as unknown as JsonValue };
			if (request.op === "refresh") return { text: "ok", data: { op: "refresh", snapshot: serializeSnapshot(snapshot()) } as unknown as JsonValue };
			throw new Error(`unexpected ${String(request.op)}`);
		},
		dialogs: {
			select: async (_title, choices) => choices[0]?.value,
			input: async () => inputs.shift(),
			notify: (text) => { notices.push(text); },
		},
		close: () => { closed++; },
	};
	return { host, requests, inputs, notices, closed: () => closed };
}

test("the panel loads the registry through the host and runs a lifecycle control with a reason and the shown target identity", async () => {
	const f = hostFixture();
	f.inputs.push("panel reason");
	const instance = operatorPanel().open(f.host);
	assert.match(instance.render(100).join("\n"), /Read policy registry/);
	await flush();
	const lines = instance.render(120).map(stripVTControlCharacters);
	assert.ok(lines.some((line) => line.includes("local.scan")), lines.join("\n"));
	assert.ok(lines.some((line) => line.includes("[Filter]")), "Filter is a visible control");
	assert.deepEqual(f.requests[0], { op: "load" });
	instance.handleInput("d");
	await flush();
	const lifecycle = f.requests.find((request) => request.op === "lifecycle");
	assert.ok(lifecycle, JSON.stringify(f.requests));
	assert.equal(lifecycle.verb, "disable");
	assert.equal(lifecycle.id, "local.scan");
	assert.equal(lifecycle.reason, "panel reason");
	assert.equal(typeof lifecycle.expectedIdentity, "string");
	assert.match(instance.render(120).join("\n"), /Disabled local\.scan/);
	instance.handleInput("\x1b");
	assert.equal(f.closed(), 1);
	instance.dispose();
});

test("a cancelled reason sends no control, and a host refusal is shown with a refreshed registry", async () => {
	const f = hostFixture({ lifecycle: () => { throw new Error("target identity changed"); } });
	f.inputs.push(undefined, "retry reason");
	const instance = operatorPanel().open(f.host);
	await flush();
	instance.handleInput("d");
	await flush();
	assert.equal(f.requests.filter((request) => request.op === "lifecycle").length, 0, "a cancelled reason sends nothing");
	assert.match(instance.render(120).join("\n"), /canceled|No rules changed/i);
	instance.handleInput("d");
	await flush();
	assert.equal(f.requests.filter((request) => request.op === "lifecycle").length, 1);
	assert.match(instance.render(120).join("\n"), /Action refused: target identity changed/);
	assert.ok(f.requests.some((request) => request.op === "refresh"), "a refusal refreshes the registry");
	instance.dispose();
});

test("an unreadable registry is reported and Esc returns", async () => {
	const f = hostFixture({ load: () => { throw new Error("store locked"); } });
	const instance = operatorPanel().open(f.host);
	await flush();
	assert.match(instance.render(80).join("\n"), /store locked/);
	instance.handleInput("\x1b");
	assert.equal(f.closed(), 1);
	assert.throws(() => readPanelRequest({ op: "approve", proposalId: "x", effect: "exact" }), /steer or block/);
	instance.dispose();
});
