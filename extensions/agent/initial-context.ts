import type { Message } from "@earendil-works/pi-ai";

/** Projected conversation messages only; never ordinary runtime or system state. */
export type InitialMessage = Exclude<Message, { role: "system" }>;
export const INITIAL_CONTEXT_BYTES = 64 * 1024 * 1024;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function content(value: unknown, assistant: boolean): boolean {
	if (!assistant && typeof value === "string") return true;
	return Array.isArray(value) && value.every(part => {
		if (!object(part)) return false;
		if (part.type === "text") return typeof part.text === "string";
		if (part.type === "image") return !assistant && typeof part.data === "string" && typeof part.mimeType === "string";
		if (part.type === "thinking") return assistant && typeof part.thinking === "string";
		return assistant && part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string" && object(part.arguments) && (part.argumentsError === undefined || typeof part.argumentsError === "string");
	});
}
function initialMessage(value: unknown): value is InitialMessage {
	if (!object(value) || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return false;
	if (value.role === "user") return content(value.content, false);
	if (value.role === "toolResult") return Array.isArray(value.content) && content(value.content, false) && typeof value.toolCallId === "string" && typeof value.toolName === "string" && typeof value.isError === "boolean";
	return value.role === "assistant" && content(value.content, true) && typeof value.api === "string" && typeof value.provider === "string" && typeof value.model === "string" && object(value.usage) && typeof value.stopReason === "string";
}
export function parseInitialContext(text: string): InitialMessage[] {
	if (Buffer.byteLength(text) > INITIAL_CONTEXT_BYTES) throw new Error("Saved context exceeds the native creation bound");
	const value: unknown = JSON.parse(text);
	if (!Array.isArray(value) || !value.every(initialMessage)) throw new Error("Saved context contains an invalid conversation message");
	return value;
}
/** stdin has an explicit end and byte ceiling; it is not a persistent control channel. */
export async function readInitialContext(): Promise<InitialMessage[]> {
	const chunks: Buffer[] = []; let bytes = 0;
	for await (const chunk of process.stdin) {
		const buffer = Buffer.from(chunk); bytes += buffer.length;
		if (bytes > INITIAL_CONTEXT_BYTES) throw new Error("Saved context exceeds the native creation bound");
		chunks.push(buffer);
	}
	return parseInitialContext(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
}
