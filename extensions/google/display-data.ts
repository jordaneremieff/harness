import { stripTerminalSequences } from "@earendil-works/pi-tui";

export type Data = Record<string, unknown>;

export interface CardCall {
	subject: string;
	facts?: string[];
	args?: Data;
}

export interface CardResult {
	outcome: string;
	body?: string[];
	details?: string[];
	next?: { name?: string; args: Data };
}

export interface ResultContext {
	args: Data;
	data: Data;
	error: Data;
	status: "ok" | "partial" | "error";
	isError: boolean;
}

export interface Presenter {
	call(args: Data): CardCall;
	result(context: ResultContext): CardResult | undefined;
}

export function object(value: unknown): Data {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
}

export function text(value: unknown): string {
	return typeof value === "string"
		? stripTerminalSequences(value.replace(/\r\n?/g, "\n"))
				.replaceAll("\t", "   ")
				.replace(/[\p{Cc}\p{Bidi_Control}\p{Cs}]/gu, (char) => (char === "\n" ? char : ""))
		: "";
}

export function field(value: unknown): string {
	return text(value).replace(/\s+/g, " ").trim();
}

export function count(n: number, singular: string, plural = `${singular}s`): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

export function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function pick(data: Data, ...keys: string[]): Data {
	return Object.fromEntries(
		keys.filter((key) => Object.hasOwn(data, key) && data[key] !== undefined).map((key) => [key, data[key]]),
	);
}
