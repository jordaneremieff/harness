/** The attached-terminal policy view: the shared view and artifact review over a host request route. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { JsonValue, OperatorView, PanelHost } from "../../operator-ui/index.ts";
import { operatorPanel } from "./operator-panel.ts";
import { readPanelRequest, serializeFireSummary, serializeSnapshot } from "./panel-protocol.ts";
import type { RuleSnapshot } from "./local-rules.ts";
import type { RuleRecord } from "./rule.ts";
import { viewTheme } from "./view-fixture.mts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const flush = async () => {
	for (let round = 0; round < 10; round++) await new Promise((resolve) => setImmediate(resolve));
};

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

/** A panel host over a fake route, with the nested views a frame would keep. */
function hostFixture(answers: Partial<Record<string, (request: Record<string, unknown>) => unknown>> = {}) {
	const requests: Record<string, unknown>[] = [];
	const layers: Array<{ view: OperatorView; controller: AbortController }> = [];
	const notices: string[] = [];
	const answer = async (data: JsonValue) => {
		const request = data as Record<string, unknown>;
		requests.push(request);
		const custom = answers[String(request.op)];
		if (custom) return { text: "custom", data: custom(request) as JsonValue };
		if (request.op === "load") return { text: "load", data: { op: "load", snapshot: serializeSnapshot(snapshot()), fireSummary: serializeFireSummary({ fires: new Map(), firesByModel: new Map(), partial: false }), activity: { records: [], partial: false, byteLimited: false, recordLimited: false, bytesRead: 0 }, scope: { cwd: "/work" } } as unknown as JsonValue };
		if (request.op === "lifecycle") return { text: "ok", data: { op: "lifecycle", outcome: `Disabled ${String(request.id)}.`, snapshot: serializeSnapshot(snapshot()) } as unknown as JsonValue };
		if (request.op === "refresh") return { text: "ok", data: { op: "refresh", snapshot: serializeSnapshot(snapshot()) } as unknown as JsonValue };
		throw new Error(`unexpected ${String(request.op)}`);
	};
	const host = (controller: AbortController): PanelHost => ({
		theme: viewTheme,
		target: { id: "conversation-1", label: "Reviewer · work" },
		signal: controller.signal,
		requestRender: () => {},
		notify: (text) => notices.push(text),
		push: (open) => {
			const child = new AbortController();
			layers.push({ view: open(host(child)), controller: child });
		},
		back: () => {
			const index = layers.findIndex((layer) => layer.controller === controller);
			for (const layer of layers.splice(Math.max(1, index))) layer.controller.abort();
		},
		focusActions: () => {},
		close: () => {},
		request: answer,
	});
	const root = new AbortController();
	layers.push({ view: operatorPanel().open(host(root)), controller: root });
	const top = () => layers.at(-1)?.view;
	return {
		requests,
		notices,
		top,
		depth: () => layers.length,
		screen: () => (top()?.render(120, 24) ?? []).map((line) => stripVTControlCharacters(line)).join("\n"),
		action(label: string) {
			const action = top()?.actions?.().find((candidate) => candidate.label === label);
			assert.ok(action, `no action ${label}`);
			return action;
		},
		type(text: string) {
			for (const key of text) top()?.handleInput(key);
		},
	};
}

test("the view loads the registry through the host and runs a lifecycle control with a reason and the shown target identity", async () => {
	const f = hostFixture();
	assert.match(f.screen(), /Reading the policy registry/);
	await flush();
	assert.match(f.screen(), /local\.scan/);
	assert.deepEqual(f.requests[0], { op: "load" });
	f.action("Disable…").run();
	f.type("panel reason");
	f.action("Disable rule").run();
	await flush();
	const lifecycle = f.requests.find((request) => request.op === "lifecycle");
	assert.ok(lifecycle, JSON.stringify(f.requests));
	assert.equal(lifecycle.verb, "disable");
	assert.equal(lifecycle.id, "local.scan");
	assert.equal(lifecycle.reason, "panel reason");
	assert.equal(typeof lifecycle.expectedIdentity, "string");
	assert.ok(f.notices.includes("Disabled local.scan."));
	assert.equal(f.depth(), 1);
});

test("a cancelled form sends no control, and a host refusal keeps the form and refreshes the registry", async () => {
	const f = hostFixture({
		lifecycle: () => {
			throw new Error("target identity changed");
		},
	});
	await flush();
	f.action("Disable…").run();
	f.action("Cancel").run();
	assert.equal(f.requests.filter((request) => request.op === "lifecycle").length, 0, "a cancelled form sends nothing");
	f.action("Disable…").run();
	f.type("retry reason");
	f.action("Disable rule").run();
	await flush();
	assert.equal(f.requests.filter((request) => request.op === "lifecycle").length, 1);
	assert.match(f.screen(), /target identity changed/);
	assert.equal(f.depth(), 2, "the staged form stays after a refusal");
	assert.ok(f.requests.some((request) => request.op === "refresh"), "a refusal refreshes the registry");
});

test("an unreadable registry is reported in the view, and the request union refuses an exact effect", async () => {
	const f = hostFixture({
		load: () => {
			throw new Error("store locked");
		},
	});
	await flush();
	assert.match(f.screen(), /store locked/);
	assert.throws(() => readPanelRequest({ op: "approve", proposalId: "x", effect: "exact" }), /steer or block/);
});
