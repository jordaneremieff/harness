import assert from "node:assert/strict";
import { test } from "node:test";
import type { Data } from "./display-data.ts";
import { tasksPresenters } from "./display-tasks.ts";

function result(name: string, data: Data, args: Data = {}) {
	const card = tasksPresenters[name]?.result({ args, data, error: {}, status: "ok", isError: false });
	assert.ok(card);
	return card;
}

const address = { taskListId: "list-1", taskId: "task-42" };
const due = "2026-11-26T00:00:00.000Z";
const task = {
	...address,
	status: "needsAction",
	due,
	parentTaskId: "parent-8",
	externalData: { title: "Check inventory", notes: "Check the north shelf.\n\x1b[31mBring the list.\x1b[0m" },
};

test("task-list pages retain titles and nullable pagination state", () => {
	const args = { limit: 20, cursor: "old-cursor" };
	const page = result(
		"tasks_lists_list",
		{
			taskLists: [{ taskListId: "list-1", externalData: { title: "Stocktake" } }],
			nextCursor: " token+== ",
		},
		args,
	);
	assert.match(page.outcome, /1 task list on this page.*More task lists/);
	assert.deepEqual(page.body, ["1. Stocktake"]);
	assert.deepEqual(page.next, { args: { ...args, cursor: " token+== " } });
	assert.match(result("tasks_lists_list", { taskLists: [] }).outcome, /0 task lists on this page.*No next page/);
});

test("task pages preserve filters and expose task notes on expansion", () => {
	const args = {
		taskListId: "list-1",
		cursor: "older",
		limit: 1,
		includeCompleted: false,
		dueMin: due,
		dueMax: due,
		updatedMin: due,
	};
	const page = result("tasks_list", { taskListId: "list-1", tasks: [task], nextCursor: "opaque+/==" }, args);
	assert.match(page.outcome, /1 task on this page.*More tasks/);
	assert.deepEqual(page.body, [`1. Check inventory · needs action · due ${due}`]);
	assert.deepEqual(page.details, [
		"1. Task: task-42",
		"Parent task: parent-8",
		"Notes:",
		"Check the north shelf.",
		"Bring the list.",
	]);
	assert.deepEqual(page.next, { args: { ...args, cursor: "opaque+/==" } });
});

test("a task read displays retained notes but supplies no continuation", () => {
	const card = result("tasks_get", { ...task, externalData: { ...task.externalData, truncated: true } }, address);
	assert.deepEqual(card.body?.slice(1), ["Check the north shelf.", "Bring the list."]);
	assert.match(card.details?.join(" ") ?? "", /truncated the task title or notes/);
	assert.equal(card.next, undefined);
});

test("task write calls summarise notes and write receipts omit note prose", () => {
	const update = tasksPresenters.tasks_update;
	const create = tasksPresenters.tasks_create;
	assert.ok(update && create);
	assert.deepEqual(update.call({ ...address, notes: "secret", due: null }).args, { due: null, notes: "6 characters" });
	assert.deepEqual(create.call({ ...address, title: "Check inventory", notes: "", due }).args, {
		due,
		notes: "0 characters",
	});
	const created = result("tasks_create", task);
	const updated = result("tasks_update", task, address);
	assert.match(created.outcome, /^Created/);
	assert.match(updated.outcome, /^Updated/);
	assert.doesNotMatch(JSON.stringify([created, updated]), /Check the north shelf\./);
	assert.doesNotMatch(result("tasks_update", {}, address).outcome, /^Updated/);
});

test("completion and deletion require their distinct success evidence", () => {
	assert.match(result("tasks_complete", { ...task, status: "completed", completed: due }, address).outcome, /^Marked/);
	assert.doesNotMatch(result("tasks_complete", task, address).outcome, /^Marked/);
	assert.match(result("tasks_delete", { ...address, deleted: true }, address).outcome, /^Deleted/);
	assert.doesNotMatch(result("tasks_delete", { ...address, deleted: false }, address).outcome, /^Deleted/);
	assert.equal(
		tasksPresenters.tasks_delete?.result({
			args: address,
			data: {},
			error: { code: "NOT_FOUND" },
			status: "error",
			isError: true,
		}),
		undefined,
	);
});
