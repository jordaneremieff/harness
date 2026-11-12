import type * as Durable from "@earendil-works/pi-durable";

async function taskPathCrossesBackground(tx: Durable.Tx, first: Durable.TaskId): Promise<boolean | undefined> {
	let taskId: Durable.TaskId | undefined = first;
	const visited = new Set<Durable.TaskId>();
	while (taskId !== undefined) {
		if (visited.has(taskId)) return undefined;
		visited.add(taskId);
		const task = await tx.task(taskId);
		if (!task) return undefined;
		if (task.background) return true;
		taskId = task.owner;
	}
	return false;
}

async function abortParent(tx: Durable.Tx, current: Durable.ConversationId, background: boolean): Promise<Durable.ConversationId | "unknown" | undefined> {
	const record = await tx.conversation(current);
	if (!record) return "unknown";
	if (!record.owner) return undefined;
	if (!background) {
		const crosses = await taskPathCrossesBackground(tx, record.owner.taskId);
		if (crosses === undefined) return "unknown";
		if (crosses) return undefined;
	}
	return record.owner.conversationId;
}

/** Exact ownership walk: true only when every record of the chain from `start` up to the target is retained. */
async function belowTarget(tx: Durable.Tx, start: Durable.ConversationId, targetId: Durable.ConversationId, background: boolean): Promise<boolean> {
	const visited = new Set<Durable.ConversationId>([start]);
	let current = await abortParent(tx, start, background);
	while (current !== undefined && current !== "unknown") {
		if (current === targetId) return true;
		if (visited.has(current)) return false;
		visited.add(current);
		current = await abortParent(tx, current, background);
	}
	return false;
}

/**
 * Conversations whose work an abort of the target stops: the target first, then each conversation whose ownership
 * chain leads up to it. Without `background`, a chain through a background task is outside the scope. Read it before
 * the abort, while the owning tasks are retained.
 */
export async function abortScopeConversations(tx: Durable.Tx, targetId: Durable.ConversationId, background: boolean): Promise<Durable.ConversationId[]> {
	const scope: Durable.ConversationId[] = [targetId];
	let cursor: Durable.Cursor | undefined;
	do {
		const page = await tx.scanConversations({}, 50, cursor);
		for (const record of page.items) if (record.id !== targetId && await belowTarget(tx, record.id, targetId, background)) scope.push(record.id);
		cursor = page.next;
	} while (cursor);
	return scope;
}

/** Conservative ownership walk for a caller in the target storage. */
export async function abortScopeContains(tx: Durable.Tx, caller: Durable.ConversationId, targetId: Durable.ConversationId, background: boolean): Promise<boolean> {
	let current: Durable.ConversationId | "unknown" | undefined = caller;
	const visited = new Set<Durable.ConversationId>();
	while (current !== undefined && current !== "unknown") {
		if (current === targetId || visited.has(current)) return true;
		visited.add(current);
		current = await abortParent(tx, current, background);
	}
	return current === "unknown";
}
