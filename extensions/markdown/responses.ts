import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { basename } from "node:path";
import type { WriteInput } from "./store.ts";

export const SOURCE_BYTES = 2 * 1024 * 1024;
export const RESPONSE_VISITS = 2000;
export const RESPONSE_RESULTS = 30;
export interface Completeness { state: "complete" | "partial"; reason?: "length" | "aborted" | "error" | "tool-use"; note?: string }
export interface ResponseOrigin {
	kind: "ordinary-response" | "native-response";
	host?: string;
	session?: string;
	conversation?: string;
	entry: string;
	model: string;
	cwd?: string;
	capturedAt: string;
	parts: { chars: number }[];
}
export interface ResponseSnapshot {
	entryId: string;
	parts: string[];
	stop: string;
	completeness: Completeness;
	provenance: ResponseOrigin;
	timestamp?: number;
}
export interface ResponseRow {
	entryId: string;
	timestamp?: number;
	preview: string;
	bytes: number;
	stop: string;
	completeness: Completeness;
}
export interface RecentResponses {
	rows: ResponseRow[];
	cutoff: string | null;
	visited: number;
	stop: "end" | "visits" | "results" | "missing";
}
export function completeness(stop: string): Completeness {
	switch (stop) {
		case "stop": return { state: "complete" };
		case "toolUse": return { state: "complete", reason: "tool-use", note: "Text before tool calls; not task acceptance." };
		case "length": case "aborted": case "error": return { state: "partial", reason: stop };
		default: return { state: "partial", note: `Response stop: ${stop}` };
	}
}
export function responseSnapshot(message: AssistantMessage, entryId: string, origin: Omit<ResponseOrigin, "entry" | "model" | "parts" | "capturedAt">): ResponseSnapshot | undefined {
	const parts = message.content.flatMap((part) => part.type === "text" && part.text.trim() ? [part.text] : []);
	if (!parts.length) return undefined;
	return {
		entryId, parts, stop: message.stopReason, completeness: completeness(message.stopReason), timestamp: message.timestamp,
		provenance: { ...origin, host: hostname(), entry: entryId, model: `${message.provider}/${message.model}`, capturedAt: new Date().toISOString(), parts: parts.map((text) => ({ chars: text.length })) },
	};
}
export const responseDigest = (source: string): string => `sha256:${createHash("sha256").update(source).digest("hex")}`;
export function responseText(response: ResponseSnapshot): string {
	const source = response.parts.join("\n\n");
	if (Buffer.byteLength(source) > SOURCE_BYTES) throw new Error(`Response ${response.entryId} exceeds the ${SOURCE_BYTES}-byte source limit; no truncated document was saved.`);
	if (!validUnicode(source)) throw new Error("Response contains unpaired Unicode surrogates; no document was saved.");
	return source;
}
export function responseRow(response: ResponseSnapshot): ResponseRow {
	const first = response.parts[0].split(/\r?\n/u, 1)[0];
	return { entryId: response.entryId, timestamp: response.timestamp, preview: Array.from(first).slice(0, 160).join(""), bytes: response.parts.reduce((sum, part) => sum + Buffer.byteLength(part), 2 * (response.parts.length - 1)), stop: response.stop, completeness: response.completeness };
}
export const validUnicode = (value: string): boolean => !/[\uD800-\uDFFF]/u.test(value);
/** The response's label: the working directory's base name and the local time of the response. */
export function responseTitle(response: ResponseSnapshot): string {
	const date = new Date(response.timestamp ?? response.provenance.capturedAt);
	const pad = (value: number) => String(value).padStart(2, "0");
	const localTime = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const directory = basename(response.provenance.cwd ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ") || "workspace";
	return `Response · ${Array.from(directory).slice(0, 170).join("")} · ${localTime}`;
}
/** One snapshot per response, whoever captures it: the source key names host kind, conversation and entry. */
export function responseSnapshotWrite(response: ResponseSnapshot): { sourceKey: string; input: WriteInput } {
	const origin = response.provenance;
	const identity = origin.conversation === undefined ? origin.session : `${origin.session}:${origin.conversation}`;
	return {
		sourceKey: `response\0${origin.kind}\0${identity ?? ""}\0${response.entryId}`,
		input: { title: responseTitle(response), source: responseText(response), contentOrigin: origin, completeness: response.completeness, references: { state: "uninspected", truncated: false, items: [], omitted: 0 } },
	};
}
export type OrdinarySource = Pick<ExtensionContext["sessionManager"], "getEntry" | "getLeafId" | "getSessionId" | "getCwd">;
function ordinaryResponse(source: OrdinarySource, entry: SessionEntry): ResponseSnapshot | undefined {
	const id = entry.id;
	return entry?.type === "message" && entry.message.role === "assistant"
		? responseSnapshot(entry.message, id, { kind: "ordinary-response", session: source.getSessionId(), cwd: source.getCwd() }) : undefined;
}
/** Capture a leaf once; siblings and later appends never enter this walk. */
export function recentOrdinary(source: OrdinarySource, options: { leaf?: string | null; visits?: number; results?: number } = {}): RecentResponses {
	const cutoff = options.leaf === undefined ? source.getLeafId() : options.leaf;
	let id = cutoff;
	const rows: ResponseRow[] = [];
	let visited = 0;
	const visits = Math.min(RESPONSE_VISITS, Math.max(1, options.visits ?? RESPONSE_VISITS));
	const results = Math.min(RESPONSE_RESULTS, Math.max(1, options.results ?? RESPONSE_RESULTS));
	while (id && visited < visits && rows.length < results) {
		const entry = source.getEntry(id);
		visited++;
		if (!entry) return { rows, cutoff, visited, stop: "missing" };
		const response = ordinaryResponse(source, entry);
		if (response) rows.push(responseRow(response));
		id = entry.parentId;
	}
	return { rows, cutoff, visited, stop: !id ? "end" : rows.length >= results ? "results" : "visits" };
}
/**
 * The answer before the current request: the newest assistant response with text that precedes
 * the newest user message on the branch ending at `leaf`.
 */
export function previousOrdinary(source: OrdinarySource, leaf: string | null = source.getLeafId()): ResponseSnapshot {
	let id = leaf;
	let passedRequest = false;
	for (let visited = 0; id && visited < RESPONSE_VISITS; visited++) {
		const entry = source.getEntry(id);
		if (!entry) break;
		if (!passedRequest) passedRequest = entry.type === "message" && entry.message.role === "user";
		else {
			const response = ordinaryResponse(source, entry);
			if (response) {
				responseText(response);
				return response;
			}
		}
		id = entry.parentId;
	}
	throw new Error("No earlier response with text is visible on this branch within the visit limit.");
}
/** Identity must be visible from the captured branch, not merely present in the session file. */
export function readOrdinary(source: OrdinarySource, entryId: string, leaf: string | null): ResponseSnapshot {
	let id = leaf;
	for (let visited = 0; id && visited < RESPONSE_VISITS; visited++) {
		const entry = source.getEntry(id);
		if (!entry) break;
		if (id === entryId) {
			const response = ordinaryResponse(source, entry);
			if (!response) throw new Error("The selected entry has no assistant text.");
			responseText(response);
			return response;
		}
		id = entry.parentId;
	}
	throw new Error("The selected response is not visible within the captured branch and visit limit.");
}
