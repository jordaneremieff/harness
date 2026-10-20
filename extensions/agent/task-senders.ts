import { communicationIdentity, parseCommunicationLink, type CommunicationInputLink } from "./communication.ts";

/** Checked requester facts, separate from communication kind and reply routing. */
export type TaskInputSender = {
	readonly identity: string;
	readonly name?: string;
};
export type TaskSenders = Readonly<Record<string, TaskInputSender>>;
export const TASK_SENDER_PAGE_ENTRIES = 200;
export const TASK_SENDER_PAGE_BYTES = 32_768;
export const TASK_SENDER_ENTRY_KIND = "agent.task-sender";
export type RetainedTaskSender = {
	readonly sender: TaskInputSender;
	readonly recordedAt: number;
};
export type TaskSenderRecord = RetainedTaskSender & {
	readonly format: "agent.task-sender/1";
	readonly target: CommunicationInputLink;
};
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function senderName(value: unknown): value is string {
	return typeof value === "string" && Buffer.byteLength(value, "utf8") <= 160 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && ![...value].some((point) => { const code = point.codePointAt(0) as number; return code >= 0xd800 && code <= 0xdfff; });
}
export function parseTaskInputSender(value: unknown): TaskInputSender | undefined {
	if (!object(value) || Object.keys(value).some((key) => key !== "identity" && key !== "name") || typeof value.identity !== "string" || !communicationIdentity(value.identity) || (value.name !== undefined && !senderName(value.name))) return undefined;
	return { identity: value.identity, ...(value.name === undefined ? {} : { name: value.name }) };
}
/** An unavailable name does not erase the checked requester identity. */
export function taskInputSender(identity: string, name?: unknown): TaskInputSender | undefined {
	return parseTaskInputSender({ identity, ...(senderName(name) ? { name } : {}) });
}
export function retainTaskInputSender(value: unknown, recordedAt: number): RetainedTaskSender | undefined {
	const sender = parseTaskInputSender(value);
	return sender === undefined || !Number.isSafeInteger(recordedAt) || recordedAt < 0 ? undefined : { sender, recordedAt };
}
export function parseTaskSenderRecord(value: unknown): TaskSenderRecord | undefined {
	if (!object(value) || Object.keys(value).some((key) => !["format", "target", "sender", "recordedAt"].includes(key)) || value.format !== "agent.task-sender/1") return undefined;
	const target = parseCommunicationLink(value.target);
	const retained = retainTaskInputSender(value.sender, value.recordedAt as number);
	return target?.mode !== "input" || retained === undefined ? undefined : { format: "agent.task-sender/1", target, ...retained };
}
/** Omitted hints mean unknown; their independent bound never removes native entries. */
export function boundTaskSenders(values: readonly (readonly [string, TaskInputSender])[]): TaskSenders | undefined {
	const result: Record<string, TaskInputSender> = {};
	let bytes = 2;
	for (const [entryId, value] of values.slice(0, TASK_SENDER_PAGE_ENTRIES)) {
		const sender = parseTaskInputSender(value);
		if (sender === undefined || !/^[1-9][0-9]*$/u.test(entryId) || !Number.isSafeInteger(Number(entryId))) continue;
		const size = Buffer.byteLength(JSON.stringify(entryId)) + 1 + Buffer.byteLength(JSON.stringify(sender)) + (Object.keys(result).length === 0 ? 0 : 1);
		if (bytes + size > TASK_SENDER_PAGE_BYTES) break;
		bytes += size;
		result[entryId] = sender;
	}
	return Object.keys(result).length === 0 ? undefined : result;
}
