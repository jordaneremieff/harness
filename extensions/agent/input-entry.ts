import type { InputEntry } from "@earendil-works/pi-durable";

export const AGENT_INPUT_KIND = "agent.input";

/** Only explicit operator admissions use the native operator-input kind. */
export function inputEntry(origin: "operator" | "model" | undefined, identity?: string): InputEntry | undefined {
	if (origin === "operator") return undefined;
	return {
		kind: AGENT_INPUT_KIND,
		data: { author: { role: origin === "model" ? "agent" : "unknown", ...(identity === undefined ? {} : { identity }) } },
	};
}

/** Input kinds owned by native operator admission and Agent admission. */
export function isInputKind(kind: string): boolean {
	return kind === "pi.user" || kind === AGENT_INPUT_KIND;
}
