import { bool, int, nul, obj, opt, str, union } from "@earendil-works/pi-schema";
import { GRANTS } from "./gws.ts";
import { external, GoogleError, ok, TextBudget } from "./result.ts";
import type { ToolSpec } from "./tools.ts";

const TaskListId = str({ minLength: 1, maxLength: 512 });
const TaskId = str({ minLength: 1, maxLength: 512 });
const Timestamp = str({ minLength: 1, maxLength: 64 });

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function taskView(task: Record<string, unknown>, budget: TextBudget, notesBytes: number) {
	const title = budget.clip(task.title, 1024);
	const notes = budget.clip(task.notes, notesBytes);
	return {
		taskId: text(task.id),
		status: text(task.status),
		due: text(task.due) || undefined,
		completed: text(task.completed) || undefined,
		updated: text(task.updated) || undefined,
		parentTaskId: text(task.parent) || undefined,
		position: text(task.position) || undefined,
		hidden: task.hidden === true,
		deleted: task.deleted === true,
		externalData: external("tasks", {
			title: title.text,
			notes: notes.text,
			truncated: title.truncated || notes.truncated,
		}),
	};
}

export const tasksTools: ToolSpec[] = [
	{
		name: "tasks_lists_list",
		label: "Task lists",
		description: "List Google Tasks task lists with native pagination.",
		parameters: obj({
			limit: opt(int({ minimum: 1, maximum: 100, default: 50 })),
			cursor: opt(str({ minLength: 1, maxLength: 4096 })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: GRANTS.tasksRead }, signal, async (operation) => {
				const args = value as { limit?: number; cursor?: string };
				const response = await operation.call<Record<string, unknown>>("tasks", ["tasklists", "list"], {
					params: {
						maxResults: args.limit ?? 50,
						...(args.cursor ? { pageToken: args.cursor } : {}),
					},
				});
				const budget = new TextBudget();
				return ok({
					taskLists: (Array.isArray(response.items) ? response.items.filter(object) : []).map((item) => ({
						taskListId: text(item.id),
						updated: text(item.updated) || undefined,
						externalData: external("tasks", { title: budget.clip(item.title, 1024).text }),
					})),
					nextCursor: text(response.nextPageToken) || undefined,
				});
			}),
	},
	{
		name: "tasks_list",
		label: "Tasks",
		description:
			"List the tasks of one task list with bounded titles and notes; completed tasks are omitted unless requested.",
		parameters: obj({
			taskListId: TaskListId,
			limit: opt(int({ minimum: 1, maximum: 100, default: 20 })),
			cursor: opt(str({ minLength: 1, maxLength: 4096 })),
			includeCompleted: opt(bool({ default: false })),
			dueMin: opt(Timestamp),
			dueMax: opt(Timestamp),
			updatedMin: opt(Timestamp),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: GRANTS.tasksRead }, signal, async (operation) => {
				const args = value as {
					taskListId: string;
					limit?: number;
					cursor?: string;
					includeCompleted?: boolean;
					dueMin?: string;
					dueMax?: string;
					updatedMin?: string;
				};
				const response = await operation.call<Record<string, unknown>>("tasks", ["tasks", "list"], {
					params: {
						tasklist: args.taskListId,
						maxResults: args.limit ?? 20,
						...(args.cursor ? { pageToken: args.cursor } : {}),
						showCompleted: args.includeCompleted ?? false,
						showHidden: args.includeCompleted ?? false,
						showDeleted: false,
						...(args.dueMin ? { dueMin: args.dueMin } : {}),
						...(args.dueMax ? { dueMax: args.dueMax } : {}),
						...(args.updatedMin ? { updatedMin: args.updatedMin } : {}),
					},
				});
				const budget = new TextBudget();
				return ok({
					taskListId: args.taskListId,
					tasks: (Array.isArray(response.items) ? response.items.filter(object) : []).map((item) =>
						taskView(item, budget, 2048),
					),
					nextCursor: text(response.nextPageToken) || undefined,
				});
			}),
	},
	{
		name: "tasks_get",
		label: "Task",
		description: "Read one task with its bounded notes.",
		parameters: obj({ taskListId: TaskListId, taskId: TaskId }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: GRANTS.tasksRead }, signal, async (operation) => {
				const args = value as { taskListId: string; taskId: string };
				const response = await operation.call<Record<string, unknown>>("tasks", ["tasks", "get"], {
					params: { tasklist: args.taskListId, task: args.taskId },
				});
				return ok({ taskListId: args.taskListId, ...taskView(response, new TextBudget(), 16384) });
			}),
	},
	{
		name: "tasks_create",
		label: "Task create",
		description: "Create one task in a task list.",
		parameters: obj({
			taskListId: TaskListId,
			title: str({ minLength: 1, maxLength: 1024 }),
			notes: opt(str({ maxLength: 8192 })),
			due: opt(Timestamp),
			parentTaskId: opt(TaskId),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: GRANTS.tasksWrite }, signal, async (operation) => {
				const args = value as {
					taskListId: string;
					title: string;
					notes?: string;
					due?: string;
					parentTaskId?: string;
				};
				const response = await operation.call<Record<string, unknown>>("tasks", ["tasks", "insert"], {
					params: {
						tasklist: args.taskListId,
						...(args.parentTaskId ? { parent: args.parentTaskId } : {}),
					},
					body: {
						title: args.title,
						...(args.notes !== undefined ? { notes: args.notes } : {}),
						...(args.due !== undefined ? { due: args.due } : {}),
					},
				});
				return ok({ taskListId: args.taskListId, ...taskView(response, new TextBudget(), 2048) });
			}),
	},
	{
		name: "tasks_update",
		label: "Task update",
		description: "Change the title, notes or due date of one task; a null due date clears it.",
		parameters: obj({
			taskListId: TaskListId,
			taskId: TaskId,
			title: opt(str({ minLength: 1, maxLength: 1024 })),
			notes: opt(str({ maxLength: 8192 })),
			due: opt(union([Timestamp, nul()])),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: GRANTS.tasksWrite }, signal, async (operation) => {
				const args = value as {
					taskListId: string;
					taskId: string;
					title?: string;
					notes?: string;
					due?: string | null;
				};
				if (args.title === undefined && args.notes === undefined && args.due === undefined)
					throw new GoogleError("INVALID_ARGUMENT", "A task update requires a title, notes or due value.");
				const response = await operation.call<Record<string, unknown>>("tasks", ["tasks", "patch"], {
					params: { tasklist: args.taskListId, task: args.taskId },
					body: {
						...(args.title !== undefined ? { title: args.title } : {}),
						...(args.notes !== undefined ? { notes: args.notes } : {}),
						...(args.due !== undefined ? { due: args.due } : {}),
					},
				});
				return ok({ taskListId: args.taskListId, ...taskView(response, new TextBudget(), 2048) });
			}),
	},
	{
		name: "tasks_complete",
		label: "Task complete",
		description: "Mark one task completed.",
		parameters: obj({ taskListId: TaskListId, taskId: TaskId }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: GRANTS.tasksWrite }, signal, async (operation) => {
				const args = value as { taskListId: string; taskId: string };
				const response = await operation.call<Record<string, unknown>>("tasks", ["tasks", "patch"], {
					params: { tasklist: args.taskListId, task: args.taskId },
					body: { status: "completed" },
				});
				return ok({ taskListId: args.taskListId, ...taskView(response, new TextBudget(), 2048) });
			}),
	},
	{
		name: "tasks_delete",
		label: "Task delete",
		description: "Delete one task from a task list; these tools cannot restore it.",
		parameters: obj({ taskListId: TaskListId, taskId: TaskId }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: GRANTS.tasksWrite }, signal, async (operation) => {
				const args = value as { taskListId: string; taskId: string };
				await operation.call("tasks", ["tasks", "delete"], {
					params: { tasklist: args.taskListId, task: args.taskId },
					allowEmpty: true,
				});
				return ok({ taskListId: args.taskListId, taskId: args.taskId, deleted: true });
			}),
	},
];
