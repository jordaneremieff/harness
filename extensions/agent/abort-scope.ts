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
