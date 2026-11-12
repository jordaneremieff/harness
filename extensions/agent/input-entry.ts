import type { InputEntry } from "@earendil-works/pi-durable";

export const AGENT_INPUT_KIND = "agent.input";

/**
 * What one admitted input is. The class tells the recipient how to treat the
 * input; it never selects the time at which the input is placed.
 */
export const INPUT_CLASSES = ["operator", "steer", "followUp", "report", "result", "check-in", "timer", "thread-notice"] as const;
export type InputClass = (typeof INPUT_CLASSES)[number];

/** Class, sender and request identity that one placed input carries in its entry data and its route note. */
export type InputLabel = {
	readonly class: InputClass;
	readonly sender?: string;
	readonly requestId: string;
};

export function isInputClass(value: unknown): value is InputClass {
	return typeof value === "string" && (INPUT_CLASSES as readonly string[]).includes(value);
}

/** Class of an input that a caller sent directly: a correction, other operator input, or new work. */
export function sentInputClass(origin: "operator" | "model" | undefined, whenBusy: "steer" | "followUp" | "reject" | null | undefined): InputClass {
	if (whenBusy === "steer") return "steer";
	return origin === "operator" ? "operator" : "followUp";
}

/**
 * Only explicit operator admissions use the native operator-input kind. That
 * kind has no entry data, so an operator-origin input reads as class
 * `operator` whatever its label says.
 */
export function inputEntry(origin: "operator" | "model" | undefined, identity?: string, label?: InputLabel): InputEntry | undefined {
	if (origin === "operator") return undefined;
	return {
		kind: AGENT_INPUT_KIND,
		data: {
			author: { role: origin === "model" ? "agent" : "unknown", ...(identity === undefined ? {} : { identity }) },
			...(label === undefined ? {} : { class: label.class, ...(label.sender === undefined ? {} : { sender: label.sender }), requestId: label.requestId }),
		},
	};
}

/** Label of one retained input entry; an entry written without a label yields none. */
export function inputLabel(entry: { readonly kind: string; readonly data?: unknown }, requestId: string, operator?: string): InputLabel | undefined {
	if (entry.kind === "pi.user") return { class: "operator", ...(operator === undefined ? {} : { sender: operator }), requestId };
	if (entry.kind !== AGENT_INPUT_KIND || entry.data === null || typeof entry.data !== "object") return undefined;
	const data = entry.data as { class?: unknown; sender?: unknown; requestId?: unknown };
	if (!isInputClass(data.class)) return undefined;
	return { class: data.class, ...(typeof data.sender === "string" ? { sender: data.sender } : {}), requestId: typeof data.requestId === "string" ? data.requestId : requestId };
}

/** Input kinds owned by native operator admission and Agent admission. */
export function isInputKind(kind: string): boolean {
	return kind === "pi.user" || kind === AGENT_INPUT_KIND;
}
