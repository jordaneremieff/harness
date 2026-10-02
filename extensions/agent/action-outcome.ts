/**
 * Presentation helpers shared by the command surface and the dashboard: a
 * stable display name for one agent, and a short human summary for a control
 * result that a caller returned as JSON text instead of display text.
 */

/** One action outcome with display text and an optional agent identity. */
export interface ActionOutcome {
	readonly text: string;
	readonly sessionId?: string;
}

function condensed(text: string): string {
	return text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** Last identity segment, so `storage:conversation` shows the conversation. */
export function shortIdentity(identity: string): string {
	const tail = identity.includes(":") ? identity.slice(identity.lastIndexOf(":") + 1) : identity;
	return (tail === "" ? identity : tail).slice(0, 8);
}

export function excerpt(value: string, limit = 48): string {
	const collapsed = condensed(value);
	return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/** Display name of one stored agent: name, else first-task excerpt, else short identity. */
export function agentDisplayName(row: { readonly id: string; readonly name?: string; readonly firstMessage?: string }): string {
	const name = condensed(row.name ?? "");
	if (name !== "") return name;
	const first = condensed(row.firstMessage ?? "");
	if (first !== "") return excerpt(first);
	return shortIdentity(row.id);
}

/** Agent identity carried by a raw control result. */
function resultIdentity(value: Record<string, unknown>): string | undefined {
	for (const key of ["sessionId", "identity"]) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate !== "") return candidate;
	}
	return undefined;
}

/** A JSON object with control-result fields; observation output stays raw text. */
function isControlResult(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return ["sessionId", "identity", "submissionId", "conversationId", "deduped", "admission", "outcome", "removed", "recovery"].some((key) => key in record);
}

function parseControlResult(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const value: unknown = JSON.parse(trimmed);
		return isControlResult(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Short human summary of one control result. The action name is not carried by
 * a legacy result, so the summary states the observed effect and the agent.
 */
function controlSubject(value: Record<string, unknown>, nameFor?: (sessionId: string) => string | undefined): string | undefined {
	const identity = resultIdentity(value);
	if (identity === undefined) return undefined;
	return nameFor?.(identity) ?? shortIdentity(identity);
}

export function summarizeControlResult(value: Record<string, unknown>, nameFor?: (sessionId: string) => string | undefined): string {
	const label = controlSubject(value, nameFor);
	const named = label === undefined ? "" : ` for “${label}”`;
	const error = typeof value.error === "string" && value.error !== "" ? `: ${excerpt(value.error, 80)}` : "";
	if (value.outcome === "failed") return `Action failed${named}${error}`;
	if (value.outcome === "applied") return `Configuration applied${named}`;
	if (typeof value.submissionId === "number") {
		return value.deduped === true ? `Input was already admitted${named}` : `Input admitted${named} (submission ${value.submissionId})`;
	}
	if (value.deduped === true) return `Already applied${named}`;
	if (typeof value.removed === "boolean") return value.removed ? "Removed the directory binding" : "No directory binding to remove";
	if (value.admission !== undefined) return `Started agent${named}`;
	if (typeof value.recovery === "string") return `Connected${named}; retained work resumes`;
	return `Action completed${named}`;
}

/**
 * Display text for one action result. Outcome objects carry their text; a
 * string that parses as a control result is summarized; other strings pass
 * through unchanged.
 */
export function actionOutcomeText(result: string | ActionOutcome | undefined, nameFor?: (sessionId: string) => string | undefined): string | undefined {
	if (result === undefined) return undefined;
	if (typeof result === "object") return result.text;
	const parsed = parseControlResult(result);
	return parsed === undefined ? result : summarizeControlResult(parsed, nameFor);
}

/** Agent identity carried by one action result, for selection and follow. */
export function outcomeSessionId(result: string | ActionOutcome | undefined): string | undefined {
	if (result === undefined) return undefined;
	if (typeof result === "object") return result.sessionId;
	const parsed = parseControlResult(result);
	return parsed === undefined ? undefined : resultIdentity(parsed);
}
