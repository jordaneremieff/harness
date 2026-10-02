import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentTasksView } from "./agent-tasks.ts";
import { theme } from "./dashboard-test-fixture.mts";
import type { TasksFrame } from "./live-frames.ts";
const frame: TasksFrame = {
	scope: "tasks",
	storageId: "storage",
	revision: 1,
	observedAt: new Date(0).toISOString(),
	coverage: { complete: true, live: true },
	labels: [
		{ conversationId: 1, identity: "storage", name: "Root" },
		{ conversationId: 2, identity: "storage:2", name: "Child" },
	],
	tasks: Array.from({ length: 30 }, (_, index) => ({
		id: index + 1,
		kind: "turn",
		conversationId: 1,
		background: false,
		abortRequested: false,
		status: "running",
		phase: "model",
		waitsOn: [],
		conversations: [2],
	})),
};
it("Tasks selection stays visible under paging and resolves full identities", async () => {
	const choices: string[][] = [];
	const view = new AgentTasksView({
		theme,
		id: "storage",
		source: { tasks: async () => frame },
		onChooseConversations: (labels) => choices.push(labels.map((label) => label.identity)),
	});
	await view.refresh();
	view.render(80, 10);
	view.handleInput("\x1b[F");
	const screen = view.render(80, 10).join("\n");
	assert.match(screen, /› turn/);
	assert.equal(view.selected()?.row.id, 30);
	view.handleInput("\r");
	assert.deepEqual(choices, [["storage", "storage:2"]]);
	view.dispose();
});
it("an unresolved conversation does not dispatch a numeric ID", async () => {
	const identities: string[] = [];
	const notices: string[] = [];
	const view = new AgentTasksView({
		theme,
		id: "storage",
		source: { tasks: async () => ({ ...frame, labels: [], tasks: [{ ...frame.tasks[0], conversations: [] }] }) },
		onSelectConversation: (id) => identities.push(id),
		onNotice: (text) => notices.push(text),
	});
	await view.refresh();
	view.handleInput("\r");
	assert.deepEqual(identities, []);
	assert.match(notices[0], /no resolved/);
	view.dispose();
});
