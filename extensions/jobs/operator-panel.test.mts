import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord/json";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { operatorPanel } from "./operator-panel.ts";
import type { PanelSnapshot } from "./panel-protocol.ts";

function fixture() {
	const module = operatorPanel();
	const abort = new AbortController();
	const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
	const pending: {
		data: JsonValue;
		signal: AbortSignal | undefined;
		reply(data: JsonValue): void;
		fail(message: string): void;
	}[] = [];
	let renders = 0;
	let nested: ReturnType<typeof module.open> | undefined;
	const host = {
		theme,
		signal: abort.signal,
		requestRender: () => renders++,
		push: (open: (host: Omit<Parameters<typeof module.open>[0], "request">) => ReturnType<typeof module.open>) => {
			nested = open(host);
		},
		request: (data: JsonValue, signal?: AbortSignal) =>
			new Promise<{ text: string; data: JsonValue }>((resolve, reject) => {
				pending.push({
					data,
					signal,
					reply: (data) => resolve({ text: "jobs", data }),
					fail: (message) => reject(new Error(message)),
				});
			}),
	};
	assert.equal(pending.length, 0, "loading the module starts no reads");
	const view = module.open(host);
	assert.equal(module.version, 2);
	assert.equal(view.title, "Jobs");
	return { abort, pending, view, renders: () => renders, nested: () => nested };
}

const observedAt = 1_800_000_000_000;
const next = { after: 5, order: "descending" };
const firstPage: PanelSnapshot = {
	observedAt,
	jobs: [
		{
			id: 3,
			state: "Running",
			startedAt: observedAt - 65_000,
			command: "printf \u001b]52;c;clipboard\u0007first\nnext",
		},
		{
			id: 5,
			state: "Failed",
			startedAt: observedAt - 10_000,
			endedAt: observedAt - 8_000,
			command: "build project",
			exitCode: 7,
			cwd: "/work/project",
		},
	],
	next,
};

function mouse(type: TuiMouseEvent["type"], x: number, y: number, width: number, height: number): TuiMouseEvent {
	return { type, x, y, width, height, button: "left", screenX: x, screenY: y, shift: false, alt: false, ctrl: false };
}

test("the panel reads once per open or explicit action, lists states, and shows bound job details", async () => {
	const { view, pending, nested } = fixture();
	const action = (id: string) => view.actions?.().find((entry) => entry.id === id);
	assert.deepEqual(
		pending.map((entry) => entry.data),
		[{ op: "list" }],
	);
	assert.match(view.render(60, 8).join("\n"), /Reading jobs/u);
	assert.ok(action("refresh")?.disabled);
	action("refresh")?.run();
	assert.equal(pending.length, 1);
	pending[0]?.reply(firstPage);
	await Promise.resolve();
	const wide = view.render(110, 9).join("\n");
	assert.match(wide, /Latest jobs.*More finished jobs/u);
	assert.match(wide, /Running 1m 5s · printf first next/u);
	assert.doesNotMatch(wide, /clipboard|\u001b/u);
	assert.match(wide, /Failed 2s · build project/u);
	assert.equal(view.handleMouse?.(mouse("press", 4, 2, 110, 9)), undefined);
	assert.doesNotMatch(view.render(110, 9).join("\n"), /exit 7/u);
	assert.equal(view.handleMouse?.(mouse("click", 4, 2, 100, 9)), undefined);
	assert.ok(view.handleMouse?.(mouse("click", 4, 2, 110, 9))?.handled);
	assert.match(view.render(110, 9).join("\n"), /#5 · Failed · 2s · exit 7/u);
	assert.equal(view.handleInput("\u001b[A"), true);
	assert.match(view.render(110, 9).join("\n"), /#3 · Running/u);
	assert.equal(view.handleInput("\u001b[B"), true);
	assert.equal(view.render(35, 4).length, 4);
	assert.equal(view.handleInput("\r"), true);
	const detail = nested();
	assert.ok(detail);
	assert.match(detail.render(35, 9).join("\n"), /exit 7[\s\S]*build project[\s\S]*\/work\/project/u);
	assert.equal(pending.length, 1, "render, selection and nested details are local");
	assert.equal(action("older")?.key, "]");
	action("older")?.run();
	assert.deepEqual(pending[1]?.data, { op: "list", cursor: next });
	pending[1]?.reply({ observedAt, jobs: [{ id: 1, command: "earlier", state: "Succeeded" }] });
	await Promise.resolve();
	assert.match(view.render(80, 6).join("\n"), /Older finished jobs[\s\S]*earlier/u);
	assert.equal(action("older"), undefined);
	assert.equal(action("refresh")?.label, "Latest jobs");
	action("refresh")?.run();
	assert.deepEqual(pending[2]?.data, { op: "list" });
	pending[2]?.fail("host disconnected\u001b[31m");
	await Promise.resolve();
	const stale = view.render(80, 6).join("\n");
	assert.match(stale, /Stale snapshot.*host disconnected[\s\S]*earlier/u);
	assert.doesNotMatch(stale, /\u001b/u);
});

test("empty and unavailable are distinct, and an answer after withdrawal cannot update the panel", async () => {
	const failed = fixture();
	failed.pending[0]?.fail("host unavailable");
	await Promise.resolve();
	assert.match(failed.view.render(60, 4)[0] ?? "", /^Jobs unavailable/u);
	const { view, pending, abort, renders } = fixture();
	pending[0]?.reply({ observedAt, jobs: [] });
	await Promise.resolve();
	assert.match(view.render(60, 4)[0] ?? "", /^No managed jobs for this agent\./u);
	view.actions?.()[0]?.run();
	assert.equal(pending[1]?.signal, abort.signal);
	const beforeClose = renders();
	abort.abort();
	view.dispose?.();
	pending[1]?.reply(firstPage);
	await Promise.resolve();
	assert.equal(renders(), beforeClose);
	view.actions?.()[0]?.run();
	assert.equal(pending.length, 2);
});
