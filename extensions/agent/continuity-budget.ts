import { createHash } from "node:crypto";

const validTokens = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Compare observations from one run; an initial sample above the budget is not a crossing. */
export function planningBudgetCrossed(previousTokens: number | undefined, tokens: number, budget: number | undefined, window: number | undefined): boolean {
	return validTokens(previousTokens) && validTokens(tokens) && validTokens(budget) && budget > 0 && validTokens(window) && budget < window
		&& previousTokens < budget && tokens >= budget;
}
export function planningBudgetSourceId(ownerId: string, producerIdentity: string, producerRunId: number): string {
	return `child-budget:${createHash("sha256").update(JSON.stringify([ownerId, producerIdentity, producerRunId])).digest("hex")}`;
}
export function planningBudgetBody(identity: string, tokens: number, budget: number, model: string): string {
	return `Child ${identity} reported ${tokens} context tokens, at or above its planning budget of ${budget} for ${model}. The budget is a planning preference, not a limit.`;
}
