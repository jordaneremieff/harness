import { plainLine } from "./view-text.ts";

/** Local display copy and its semantic outcome; neither is a host result protocol. */
export interface ActionOutcome {
	readonly text: string;
	readonly sessionId?: string;
	readonly kind?: "read" | "info" | "success" | "warning" | "error";
}

/** Display name, first-task excerpt, or full identity when no name is known. */
export function agentDisplayName(row: {
	readonly id: string;
	readonly name?: string;
	readonly firstMessage?: string;
}): string {
	const name = plainLine(row.name ?? "");
	if (name) return name;
	const first = plainLine(row.firstMessage ?? "");
	if (first) return first.length > 48 ? `${first.slice(0, 47)}…` : first;
	return row.id;
}

export function actionErrorCause(error: unknown): string {
	return plainLine(error instanceof Error ? error.message : String(error)) || "No error detail returned";
}

/** A config write succeeds only when the owner reports that it applied. */
export async function configureOutcome(
	sessionId: string,
	label: string,
	configure: () => Promise<unknown>,
): Promise<ActionOutcome> {
	let cause: string;
	try {
		const result = (await configure()) as { outcome?: unknown; reason?: unknown; error?: unknown } | null;
		if (result?.outcome === "applied")
			return { text: `Updated configuration for “${label}”.`, sessionId, kind: "success" };
		const detail = result?.error ?? result?.reason;
		cause =
			typeof detail === "string" && plainLine(detail)
				? plainLine(detail)
				: "The host did not report an applied configuration";
	} catch (error) {
		cause = actionErrorCause(error);
	}
	return { text: `Configuration for “${label}” did not apply: ${cause}`, sessionId, kind: "error" };
}
