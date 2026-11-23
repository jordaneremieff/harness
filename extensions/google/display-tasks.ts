import { type CardCall, count, type Data, field, list, object, pick, type Presenter, text } from "./display-data.ts";
import { displayDate, displayInstant } from "./display-dates.ts";

function taskCall(args: Data) {
	return { subject: field(args.taskId), facts: [field(args.taskListId)].filter(Boolean) };
}

function pagingFacts(args: Data): string[] {
	return [
		typeof args.limit === "number" ? `limit ${args.limit}` : "",
		typeof args.cursor === "string" && args.cursor ? "continued page" : "",
	].filter(Boolean);
}

function taskWriteCall(args: Data, create: boolean): CardCall {
	const call = taskCall(args);
	if (create) call.subject = field(args.title);
	const options = create ? pick(args, "due", "parentTaskId") : pick(args, "title", "due");
	const due = displayDate(args.due);
	if (due) call.facts.push(`due ${due}`);
	if (args.due === null) call.facts.push("clear due date");
	if (typeof args.notes === "string") options.notes = count([...args.notes].length, "character");
	return { ...call, ...(Object.keys(options).length ? { args: options } : {}) };
}

function taskLine(task: Data): string {
	const title = field(object(task.externalData).title);
	const status = field(task.status);
	const due = displayDate(task.due);
	return [
		title || field(task.taskId),
		status === "needsAction" ? "needs action" : status,
		due ? `due ${due}` : "",
		task.hidden === true ? "hidden" : "",
		task.deleted === true ? "deleted" : "",
	]
		.filter(Boolean)
		.join(" · ");
}

function taskDetails(task: Data): string[] {
	const parent = field(task.parentTaskId);
	const updated = displayInstant(task.updated);
	const completed = displayInstant(task.completed);
	return [
		parent ? `Parent task: ${parent}` : "",
		updated ? `Updated: ${updated}` : "",
		completed ? `Completed: ${completed}` : "",
	].filter(Boolean);
}

function noteLines(task: Data): string[] {
	const contents = object(task.externalData);
	const notes = text(contents.notes);
	return notes ? notes.split("\n") : [];
}

function nextTaskPage(lists: boolean, args: Data, data: Data) {
	const cursor = typeof data.nextCursor === "string" ? data.nextCursor : undefined;
	const next = cursor
		? {
				args: {
					...(lists
						? pick(args, "limit")
						: pick(args, "taskListId", "limit", "includeCompleted", "dueMin", "dueMax", "updatedMin")),
					cursor,
				},
			}
		: undefined;
	return next;
}

function taskPageRow(value: unknown, i: number, lists: boolean) {
	const record = object(value);
	const title = field(object(record.externalData).title);
	const id = field(lists ? record.taskListId : record.taskId);
	const line = lists ? title || id : taskLine(record);

	const metadata = lists ? taskListDetails(record) : taskDetails(record);
	const notes = lists ? [] : noteLines(record);
	const clipped = !lists && object(record.externalData).truncated === true;
	const evidence = [
		...metadata,
		...(notes.length ? ["Notes:", ...notes] : []),
		...(clipped ? ["The service truncated the task title or notes."] : []),
	];
	const header = id ? `: ${id}` : "";
	return {
		line,
		details: id || evidence.length ? [`${i + 1}. ${lists ? "Task list" : "Task"}${header}`, ...evidence] : [],
	};
}

function taskListDetails(record: Data): string[] {
	const updated = displayInstant(record.updated);
	return updated ? [`Updated: ${updated}`] : [];
}

function taskPageOutcome(records: unknown, noun: string, hasNext: boolean): string {
	if (!Array.isArray(records)) return `No ${noun} page was returned.`;
	const continuation = hasNext ? `More ${noun}s are available.` : "No next page was returned.";
	return `Returned ${count(records.length, noun)} on this page. ${continuation}`;
}

function taskFilters(args: Data): string[] {
	const dueMin = displayInstant(args.dueMin);
	const dueMax = displayInstant(args.dueMax);
	const updatedMin = displayInstant(args.updatedMin);
	return [
		dueMin && `due from ${dueMin}`,
		dueMax && `due until ${dueMax}`,
		updatedMin && `updated since ${updatedMin}`,
	].filter(Boolean);
}

function taskListPage(lists: boolean): Presenter {
	return {
		call(args) {
			const options = lists ? {} : pick(args, "includeCompleted", "dueMin", "dueMax", "updatedMin");
			return {
				subject: lists ? "task lists" : field(args.taskListId),
				facts: [...pagingFacts(args), ...(lists ? [] : taskFilters(args))],
				...(Object.keys(options).length ? { args: options } : {}),
			};
		},
		result({ args, data, status, isError }) {
			if (isError || status === "error") return;
			const records = lists ? data.taskLists : data.tasks;
			const next = nextTaskPage(lists, args, data);
			const body: string[] = [];
			const details: string[] = [];
			for (const [i, value] of list(records).entries()) {
				const row = taskPageRow(value, i, lists);
				if (row.line) body.push(`${i + 1}. ${row.line}`);
				details.push(...row.details);
			}
			const noun = lists ? "task list" : "task";
			return {
				outcome: taskPageOutcome(records, noun, Boolean(next)),
				body,
				details,
				next,
			};
		},
	};
}

function taskReceipt(args: Data, data: Data) {
	const id = field(data.taskId);
	const returnedList = field(data.taskListId);
	const line = taskLine(data);
	const body = line ? [line] : [];
	const details = [
		...(id && id !== field(args.taskId) ? [`Task: ${id}`] : []),
		...(returnedList && returnedList !== field(args.taskListId) ? [`Task list: ${returnedList}`] : []),
		...taskDetails(data),
	];
	const requestedId = field(args.taskId);
	const hasTask = Boolean(id && (!requestedId || id === requestedId));
	return { hasTask, body, details };
}

const taskRead: Presenter["result"] = ({ args, data, status, isError }) => {
	if (isError || status === "error") return;
	const { hasTask, body, details } = taskReceipt(args, data);
	body.push(...noteLines(data));
	if (object(data.externalData).truncated === true) details.push("The service truncated the task title or notes.");
	return { outcome: hasTask ? "Returned a task." : "No task was identified in the response.", body, details };
};

function taskWriteOutcome(action: "create" | "update" | "complete", hasTask: boolean, state: unknown): string {
	if (action === "complete") {
		return hasTask && state === "completed" ? "Marked the task complete." : "The response did not confirm completion.";
	}
	if (!hasTask) return "The response did not confirm the task write.";
	return action === "create" ? "Created a task." : "Updated the task.";
}

function taskResult(action: "create" | "update" | "complete"): Presenter["result"] {
	return ({ args, data, status, isError }) => {
		if (isError || status === "error") return;
		const { hasTask, body, details } = taskReceipt(args, data);
		return { outcome: taskWriteOutcome(action, hasTask, data.status), body, details };
	};
}

export const tasksPresenters: Record<string, Presenter> = {
	tasks_lists_list: taskListPage(true),
	tasks_list: taskListPage(false),
	tasks_get: { call: taskCall, result: taskRead },
	tasks_create: {
		call: (args) => taskWriteCall(args, true),
		result: taskResult("create"),
	},
	tasks_update: {
		call: (args) => taskWriteCall(args, false),
		result: taskResult("update"),
	},
	tasks_complete: { call: taskCall, result: taskResult("complete") },
	tasks_delete: {
		call: taskCall,
		result({ args, data, status, isError }) {
			if (isError || status === "error") return;
			const id = field(data.taskId);
			const requestedId = field(args.taskId);
			const deleted = id && (!requestedId || id === requestedId) && data.deleted === true;
			return {
				outcome: deleted ? "Deleted the task." : "The response did not confirm deletion.",
				details: id && id !== requestedId ? [`Task: ${id}`] : [],
			};
		},
	},
};
