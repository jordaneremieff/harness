import assert from "node:assert/strict";
import { test } from "node:test";
import { createFake, errorCode, methodCalls } from "./fake-gws.test-support.mts";
import { SCOPES } from "./gws.ts";

function params(args: string[]): Record<string, unknown> {
	return JSON.parse(args[args.indexOf("--params") + 1]) as Record<string, unknown>;
}
function body(args: string[]): Record<string, unknown> {
	return JSON.parse(args[args.indexOf("--json") + 1]) as Record<string, unknown>;
}

test("tasks_lists_list returns titles as external data and forwards pagination", async () => {
	const fake = await createFake({
		responses: {
			"tasks tasklists list": {
				stdout: { items: [{ id: "list-1", title: "Work", updated: "2026-11-01T00:00:00Z" }], nextPageToken: "next" },
			},
		},
	});
	try {
		const result = await fake.tool("tasks_lists_list", { limit: 5, cursor: "page-2" });
		assert.equal(result.status, "ok", JSON.stringify(result));
		const data = result.data as {
			taskLists: { taskListId: string; externalData: Record<string, unknown> }[];
			nextCursor?: string;
		};
		assert.equal(data.taskLists[0]?.taskListId, "list-1");
		assert.equal(data.taskLists[0]?.externalData.trust, "untrusted");
		assert.match(JSON.stringify(data.taskLists[0]?.externalData), /Work/);
		assert.equal(data.nextCursor, "next");
		const [call] = methodCalls(await fake.calls(), "tasks tasklists list");
		assert.equal(params(call.args).maxResults, 5);
		assert.equal(params(call.args).pageToken, "page-2");
	} finally {
		await fake.cleanup();
	}
});

test("tasks_list hides completed tasks by default and returns titles and notes as external data", async () => {
	const fake = await createFake({
		responses: {
			"tasks tasks list": {
				stdout: {
					items: [{ id: "task-1", title: "Review notes", notes: "Read the agenda", status: "needsAction" }],
				},
			},
		},
	});
	try {
		const result = await fake.tool("tasks_list", { taskListId: "list-1" });
		assert.equal(result.status, "ok", JSON.stringify(result));
		const data = result.data as { tasks: { externalData: Record<string, unknown> }[] };
		assert.equal(data.tasks[0]?.externalData.trust, "untrusted");
		assert.match(JSON.stringify(data.tasks[0]?.externalData), /Review notes/);
		assert.match(JSON.stringify(data.tasks[0]?.externalData), /Read the agenda/);
		const defaults = params(methodCalls(await fake.calls(), "tasks tasks list")[0].args);
		assert.equal(defaults.showCompleted, false);
		assert.equal(defaults.showHidden, false);
		assert.equal(defaults.showDeleted, false);
		const included = await fake.tool("tasks_list", { taskListId: "list-1", includeCompleted: true });
		assert.equal(included.status, "ok", JSON.stringify(included));
		const shown = params(methodCalls(await fake.calls(), "tasks tasks list")[1].args);
		assert.equal(shown.showCompleted, true);
		assert.equal(shown.showHidden, true);
		assert.equal(shown.showDeleted, false);
	} finally {
		await fake.cleanup();
	}
});

test("tasks_get returns the task view for the given ids", async () => {
	const fake = await createFake({
		responses: {
			"tasks tasks get": {
				stdout: {
					id: "task-1",
					status: "needsAction",
					title: "Prepare notes",
					notes: "Draft the outline",
					due: "2026-11-20T00:00:00Z",
					parent: "task-0",
				},
			},
		},
	});
	try {
		const result = await fake.tool("tasks_get", { taskListId: "list-1", taskId: "task-1" });
		assert.equal(result.status, "ok", JSON.stringify(result));
		const data = result.data as Record<string, unknown> & { externalData: Record<string, unknown> };
		assert.equal(data.taskListId, "list-1");
		assert.equal(data.taskId, "task-1");
		assert.equal(data.parentTaskId, "task-0");
		assert.equal(data.due, "2026-11-20T00:00:00Z");
		assert.match(JSON.stringify(data.externalData), /Draft the outline/);
		const [call] = methodCalls(await fake.calls(), "tasks tasks get");
		assert.equal(params(call.args).tasklist, "list-1");
		assert.equal(params(call.args).task, "task-1");
	} finally {
		await fake.cleanup();
	}
});

test("tasks_create sends notes and due in the body and the parent in params", async () => {
	const fake = await createFake({
		responses: { "tasks tasks insert": { stdout: { id: "task-2", title: "Draft", status: "needsAction" } } },
	});
	try {
		const result = await fake.tool("tasks_create", {
			taskListId: "list-1",
			title: "Draft",
			notes: "Write the summary",
			due: "2026-11-21T00:00:00Z",
			parentTaskId: "task-1",
		});
		assert.equal(result.status, "ok", JSON.stringify(result));
		const [call] = methodCalls(await fake.calls(), "tasks tasks insert");
		assert.equal(params(call.args).tasklist, "list-1");
		assert.equal(params(call.args).parent, "task-1");
		const sent = body(call.args);
		assert.equal(sent.title, "Draft");
		assert.equal(sent.notes, "Write the summary");
		assert.equal(sent.due, "2026-11-21T00:00:00Z");
	} finally {
		await fake.cleanup();
	}
});

test("tasks_update sends only provided fields and rejects an empty update", async () => {
	const fake = await createFake({
		responses: { "tasks tasks patch": { stdout: { id: "task-1", title: "Updated", status: "needsAction" } } },
	});
	try {
		const cleared = await fake.tool("tasks_update", { taskListId: "list-1", taskId: "task-1", due: null });
		assert.equal(cleared.status, "ok", JSON.stringify(cleared));
		const [call] = methodCalls(await fake.calls(), "tasks tasks patch");
		assert.deepEqual(body(call.args), { due: null });
		const invalid = await fake.tool("tasks_update", { taskListId: "list-1", taskId: "task-1" });
		assert.equal(errorCode(invalid), "INVALID_ARGUMENT");
		assert.equal(methodCalls(await fake.calls(), "tasks tasks patch").length, 1);
	} finally {
		await fake.cleanup();
	}
});

test("tasks_complete patches the task status to completed", async () => {
	const fake = await createFake({
		responses: {
			"tasks tasks patch": {
				stdout: {
					id: "task-1",
					status: "completed",
					title: "Done",
					completed: "2026-11-13T00:00:00Z",
				},
			},
		},
	});
	try {
		const result = await fake.tool("tasks_complete", { taskListId: "list-1", taskId: "task-1" });
		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.equal((result.data as Record<string, unknown>).status, "completed");
		const [call] = methodCalls(await fake.calls(), "tasks tasks patch");
		assert.deepEqual(body(call.args), { status: "completed" });
		assert.deepEqual(params(call.args), { tasklist: "list-1", task: "task-1" });
	} finally {
		await fake.cleanup();
	}
});

test("tasks_delete deletes one task and reports it", async () => {
	const fake = await createFake({ responses: { "tasks tasks delete": { stdout: "" } } });
	try {
		const result = await fake.tool("tasks_delete", { taskListId: "list-1", taskId: "task-1" });
		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.deepEqual(result.data, { taskListId: "list-1", taskId: "task-1", deleted: true });
		const [call] = methodCalls(await fake.calls(), "tasks tasks delete");
		assert.deepEqual(params(call.args), { tasklist: "list-1", task: "task-1" });
	} finally {
		await fake.cleanup();
	}
});

test("a read-only grant permits reads but not writes", async () => {
	const fake = await createFake({
		scopes: [SCOPES.tasksRead],
		responses: {
			"tasks tasks list": { stdout: { items: [{ id: "task-1", title: "Review", status: "needsAction" }] } },
			"tasks tasks insert": { stdout: { id: "task-2", title: "Draft" } },
		},
	});
	try {
		const write = await fake.tool("tasks_create", { taskListId: "list-1", title: "Draft" });
		assert.equal(errorCode(write), "SCOPE_REQUIRED");
		assert.equal(methodCalls(await fake.calls(), "tasks tasks insert").length, 0);
		const read = await fake.tool("tasks_list", { taskListId: "list-1" });
		assert.equal(read.status, "ok", JSON.stringify(read));
		assert.equal(methodCalls(await fake.calls(), "tasks tasks list").length, 1);
	} finally {
		await fake.cleanup();
	}
});
