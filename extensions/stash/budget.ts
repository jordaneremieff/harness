import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { UsageState } from "@earendil-works/pi-durable";

export interface SessionBudget {
	contextTokens: number;
	costUsd: number;
}

export type BudgetAction = { kind: "status" } | { kind: "off" } | { kind: "set"; budget: SessionBudget };
export type BudgetContext = { kind: "unavailable" } | { kind: "host_estimate" | "request_estimate"; tokens: number };
export type BudgetCost = { kind: "unavailable"; reason: string } | { kind: "recorded"; usd: number };
export const BUDGET_USAGE = "Usage: /stash budget [<context-tokens> <cost-usd>|off]";
export const BUDGET_NOTICE = "[stash-budget] Local budget notice, not a new operator request.";
export const ORDINARY_COST: BudgetCost = { kind: "unavailable", reason: "the ordinary extension API has no maintained conversation cost counter" };

export function budgetAction(parts: readonly string[]): BudgetAction {
	if (!parts.length) return { kind: "status" };
	if (parts.length === 1 && parts[0] === "off") return { kind: "off" };
	if (parts.length !== 2 || !/^\d+$/.test(parts[0] ?? "") || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(parts[1] ?? "")) throw new Error(BUDGET_USAGE);
	const contextTokens = Number(parts[0]);
	const costUsd = Number(parts[1]);
	if (!Number.isSafeInteger(contextTokens) || contextTokens <= 0 || !Number.isFinite(costUsd) || costUsd <= 0) throw new Error(BUDGET_USAGE);
	return { kind: "set", budget: { contextTokens, costUsd } };
}

export function budgetContext(read: () => ContextUsage | undefined): BudgetContext {
	try {
		const tokens = read()?.tokens;
		if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) return { kind: "host_estimate", tokens };
	} catch { /* An unavailable observation is not zero. */ }
	return { kind: "unavailable" };
}

/** Read Pi's conversation aggregate, never a storage total or a transcript. */
export function conversationCost(state: Readonly<UsageState> | undefined): BudgetCost {
	if (!state) return { kind: "unavailable", reason: "the conversation usage counter is unavailable" };
	let usd = 0;
	for (const bucket of [state.models, state.tools]) {
		for (const usage of Object.values(bucket)) {
			const amount = usage.cost?.total;
			if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return { kind: "unavailable", reason: "a conversation usage bucket has no valid cost" };
			// Zero does not distinguish an unpriced response from free use.
			if (amount === 0) return { kind: "unavailable", reason: "a zero-cost usage bucket does not establish price coverage" };
			usd += amount;
		}
	}
	return Number.isFinite(usd) ? { kind: "recorded", usd } : { kind: "unavailable", reason: "the conversation cost total is invalid" };
}

const reached = (value: number, limit: number) => value >= limit ? "at or above budget" : "below budget";

export function budgetNotice(budget: SessionBudget, context: BudgetContext, cost: BudgetCost): string {
	return [
		BUDGET_NOTICE,
		context.kind === "unavailable"
			? `Absolute context tokens: unavailable; selected budget ${budget.contextTokens} tokens.`
			: `Absolute context ${context.kind === "host_estimate" ? "host estimate" : "request estimate"}: ${Math.round(context.tokens)} tokens / ${budget.contextTokens}-token budget (${reached(context.tokens, budget.contextTokens)}). This is not a measured provider payload count.`,
		cost.kind === "unavailable"
			? `Current-conversation cumulative cost: unavailable (${cost.reason}); selected budget USD ${budget.costUsd}.`
			: `Current-conversation cumulative recorded cost: USD ${cost.usd.toFixed(6)} / USD ${budget.costUsd} budget (${reached(cost.usd, budget.costUsd)}). Pi uses provider-reported amounts where supported and model-price estimates otherwise; combined price provenance and coverage are unverified. It is not a billing or quota measurement.`,
		"Cost covers committed responses and tool usage, including compaction attempts; an in-flight response is not included. These notices do not change percentage gates or perform a continuity act.",
	].join("\n");
}

export function budgetStatus(budget: SessionBudget | undefined, delivery: "turn" | "command" = "turn"): string {
	if (!budget) return "Stash budget: disabled for this conversation. Select budgets with /stash budget <context-tokens> <cost-usd>.";
	return [
		delivery === "turn" ? "Stash budget notices: enabled for this conversation." : "Stash budget: selected for this conversation. Native automatic per-turn notices are unavailable; /stash budget reports a current snapshot.",
		`Context budget: ${budget.contextTokens} tokens; cost budget: USD ${budget.costUsd}. Selection lasts until /stash budget off or extension reload; reset and compaction do not clear it.`,
	].join("\n");
}
