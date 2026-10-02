import assert from "node:assert/strict";
import { it } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TaskGraphRow, TaskLabel, TasksFrame } from "./live-frames.ts";
import { orderTaskRows, PeerTasksView, type PeerTasksSource } from "./peer-tasks.ts";

initTheme("dark");
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

function row(patch: Partial<TaskGraphRow> & { id: number }): TaskGraphRow {
	return {
		kind: "pi.generation",
		conversationId: 1,
		background: false,
		abortRequested: false,
		status: "running",
		phase: "work",
		waitsOn: [],
		conversations: [],
		...patch,
	};
}

function label(patch: Partial<TaskLabel> & { conversationId: number }): TaskLabel {
	return { identity: "storage", ...patch };
}

function frame(tasks: readonly TaskGraphRow[], labels: readonly TaskLabel[] = []): TasksFrame {
	return { scope: "tasks", storageId: "storage", revision: 2, observedAt: new Date(0).toISOString(), tasks, labels, coverage: { complete: true, live: true } };
}

function source(value: TasksFrame): PeerTasksSource & { listeners: Array<() => void> } {
	const listeners: Array<() => void> = [];
	return {
		listeners,
		tasks: async () => value,
		subscribe: (listener) => {
			listeners.push(listener);
			return () => {};
		},
	};
}

it("orders owner edges root-first with their children", () => {
	const ordered = orderTaskRows([row({ id: 2, owner: 1 }), row({ id: 1 }), row({ id: 3, owner: 2 })]);
	assert.deepEqual(ordered.map((entry) => [entry.row.id, entry.depth]), [[1, 0], [2, 1], [3, 2]]);
});

it("renders each live task with state, boundary, abort, and owned conversations", async () => {
	const view = new PeerTasksView({
		theme,
		id: "storage",
		source: source(
			frame(
				[
					row({ id: 1, kind: "pi.generation" }),
					row({ id: 2, owner: 1, kind: "pi.tool", status: "waiting", phase: "waiting", waitsOn: [1], background: true, abortRequested: true, conversations: [1] }),
				],
				[label({ conversationId: 1, name: "root agent" })],
			),
		),
	});
	await view.refresh();
	const lines = view.render(100, 12);
	assert.match(lines[0] ?? "", /TASKS\s+2 tasks · live/u);
	assert.match(lines[1] ?? "", /pi\.generation/u);
	assert.match(lines[2] ?? "", /pi\.tool/u);
	assert.match(lines[2] ?? "", /background/u);
	assert.match(lines[2] ?? "", /abort requested/u);
	assert.match(lines[2] ?? "", /root agent · #1/u);
	assert.ok(lines.every((line) => visibleWidth(line) <= 100));
	assert.equal(lines.length, 12);
});

it("names the selected peer from its conversation label", async () => {
	const selected: Array<{ identity: string; conversationId: number }> = [];
	const view = new PeerTasksView({
		theme,
		id: "storage",
		source: source(frame([row({ id: 1, conversationId: 3 })], [label({ conversationId: 3, name: "worker", identity: "storage:3" })])),
		onSelectConversation: (identity, conversationId) => selected.push({ identity, conversationId }),
	});
	await view.refresh();
	assert.equal(view.handleInput("\r"), true);
	assert.deepEqual(selected, [{ identity: "storage:3", conversationId: 3 }]);
});

it("reports an empty live graph distinctly from a cold storage", async () => {
	const view = new PeerTasksView({ theme, id: "storage", source: source(frame([])) });
	await view.refresh();
	const lines = view.render(90, 4);
	assert.match(lines[1] ?? "", /No live tasks/u);
	const cold = new PeerTasksView({ theme, id: "storage", source: { tasks: async () => ({ ...frame([]), coverage: { complete: false, live: false } }) } });
	await cold.refresh();
	assert.match(cold.render(90, 4)[1] ?? "", /No live host/u);
});

it("keeps every rendered line inside the allocated width", async () => {
	const view = new PeerTasksView({
		theme,
		id: "storage",
		source: source(frame([row({ id: 1, conversations: [1] })], [label({ conversationId: 1, firstMessage: "a very long first message ".repeat(20) })])),
	});
	await view.refresh();
	for (const width of [40, 12, 4]) {
		const lines = view.render(width, 6);
		assert.equal(lines.length, 6);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
	}
});
