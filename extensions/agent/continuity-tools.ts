import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { communicationIdentity } from "./communication.ts";
import { WORK_MESSAGE_CHARS } from "./open-work-schema.ts";

type Input = Record<string, unknown>;

/** Continuity accepts only closed JSON argument shapes, not target or permission claims. */
function closed(input: unknown, fields: readonly string[]): input is Input {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) return false;
	let count = 0;
	for (const key in input) {
		if (++count > fields.length || !fields.includes(key)) return false;
		const property = Object.getOwnPropertyDescriptor(input, key);
		if (!property || !("value" in property)) return false;
	}
	// JSON arguments have enumerable string keys only. Reject other object forms.
	return Reflect.ownKeys(input).length === count;
}

function target(input: unknown): input is string {
	return typeof input === "string" && communicationIdentity(input);
}

function message(input: unknown): input is string {
	return typeof input === "string" && input.length >= 1 && input.length <= 8000;
}

function optional(input: Input, key: string, accepts: (value: unknown) => boolean): boolean {
	return !Object.hasOwn(input, key) || accepts(input[key]);
}

function acceptsAbort(input: unknown): boolean {
	return closed(input, ["sessionId", "background", "release", "timerId"])
		&& target(input.sessionId)
		&& optional(input, "background", (value) => typeof value === "boolean")
		&& optional(input, "release", (value) => typeof value === "boolean")
		&& optional(input, "timerId", (value) => Number.isSafeInteger(value) && (value as number) >= 1)
		&& !(input.release === true && (input.background === true || Object.hasOwn(input, "timerId")));
}

function acceptsSteer(input: unknown): boolean {
	return closed(input, ["sessionId", "message", "replyTo"])
		&& target(input.sessionId) && message(input.message)
		&& optional(input, "replyTo", target);
}

function acceptsReport(input: unknown): boolean {
	return closed(input, ["sessionId", "message", "mode", "passive"])
		&& input.mode === "report" && target(input.sessionId) && message(input.message)
		&& optional(input, "passive", (value) => typeof value === "boolean");
}

/** Native `agent_work complete`: closes one declared item and sends its final report. */
function acceptsNativeCompletion(input: unknown): boolean {
	return closed(input, ["action", "request", "status", "message"])
		&& input.action === "complete"
		&& typeof input.request === "string" && input.request.length >= 1 && input.request.length <= 1024
		&& (input.status === "done" || input.status === "failed")
		&& typeof input.message === "string" && input.message.length >= 1 && input.message.length <= WORK_MESSAGE_CHARS;
}

export function declareContinuityTools(pi: ExtensionAPI, runtime: "native" | "ordinary"): void {
	pi.events.on("harness:continuity-tools", (data) => {
		if (data === null || typeof data !== "object") return;
		const request = data as { version?: unknown; declare?: unknown };
		if (request.version !== 1 || typeof request.declare !== "function") return;
		const declare = request.declare as (tool: { name: string; act: "compaction" | "worker-resolution" | "work-completion"; accepts?: (input: unknown) => boolean }) => void;
		declare({ name: "agent_compact", act: "compaction" });
		declare({ name: "agent_abort", act: "worker-resolution", accepts: acceptsAbort });
		declare({ name: "agent_steer", act: "worker-resolution", accepts: acceptsSteer });
		declare({ name: "agent_send", act: "worker-resolution", accepts: acceptsReport });
		// An ordinary session declares no work: its `agent_work` only ends a turn with a state note.
		if (runtime === "native") declare({ name: "agent_work", act: "work-completion", accepts: acceptsNativeCompletion });
	});
}
