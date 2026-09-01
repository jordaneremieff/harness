/**
 * Composition of the policy domains.
 *
 * This module names every active domain and dispatches by tool. It holds no
 * knowledge of any domain's input shape, parser, or rules, so a second domain
 * changes only the list below.
 */

import type { AgentRules } from "./agent-rules.ts";
import type { Domain } from "./rule.ts";
import { shellDomain } from "./shell-rules.ts";

/** Every domain this slice applies. One domain owns one tool. */
const DOMAINS: readonly Domain[] = [shellDomain];

let agentRules: AgentRules | null = null;

/** Bind the registry used to extend domain classification and guidance. */
export function bindAgentRules(rules: AgentRules | null): void {
	agentRules = rules;
}

function domainFor(tool: string): Domain | undefined {
	return DOMAINS.find((domain) => domain.tool === tool);
}

/** Input text the tool's domain declares, or undefined when none applies. */
export function captureFor(tool: string, input: Record<string, unknown>): string | undefined {
	return domainFor(tool)?.capture(input);
}

/**
 * Redaction the owning domain applies to captured text before persistence.
 *
 * A domain without a redaction keeps its capture unchanged. The neutral path
 * never applies one domain's redaction to another domain's capture.
 */
export function redactFor(tool: string, captured: string): string {
	return domainFor(tool)?.redact?.(captured) ?? captured;
}

/** Rule ids the captured text matches, sorted and deduplicated without a scope check. */
export function classifyCaptured(tool: string, captured: string): string[] {
	const domain = domainFor(tool);
	if (!domain) return [];
	const matched = domain.classify(captured);
	if (!agentRules) return matched;
	return [...new Set([...matched, ...agentRules.classify(captured)])].sort();
}

/**
 * Rule ids a call matches, read from the tool input.
 *
 * The input is captured once; a caller that needs both the classes and the
 * recorded text should capture once and use `classifyCaptured`, so a later
 * mutation or accessor cannot make the two disagree.
 */
export function classify(tool: string, input: Record<string, unknown>): string[] {
	const captured = captureFor(tool, input);
	return captured === undefined ? [] : classifyCaptured(tool, captured);
}

/** In-scope guidance for the given rule ids, in order and without repeats. */
export function notesFor(tool: string, ruleIds: readonly string[], model: string | null): string[] {
	const domain = domainFor(tool);
	if (!domain) return [];
	const notes: string[] = [];
	for (const id of ruleIds) {
		const note = domain.note(id) ?? agentRules?.noteFor(id, model);
		if (note !== undefined && !notes.includes(note)) notes.push(note);
	}
	return notes;
}
