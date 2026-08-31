/**
 * Composition of the policy domains.
 *
 * This module names every active domain and dispatches by tool. It holds no
 * knowledge of any domain's input shape, parser, or rules, so a second domain
 * changes only the list below.
 */

import type { Domain } from "./rule.ts";
import { shellDomain } from "./shell-rules.ts";

/** Every domain this slice applies. One domain owns one tool. */
const DOMAINS: readonly Domain[] = [shellDomain];

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

/** Rule ids a call matches, sorted and deduplicated. */
export function classify(tool: string, input: Record<string, unknown>): string[] {
	const domain = domainFor(tool);
	const captured = domain?.capture(input);
	if (domain === undefined || captured === undefined) return [];
	return domain.classify(captured);
}

/** Guidance for the given rule ids, in the order given, without repeats. */
export function notesFor(tool: string, ruleIds: readonly string[]): string[] {
	const domain = domainFor(tool);
	if (!domain) return [];
	const notes: string[] = [];
	for (const id of ruleIds) {
		const note = domain.note(id);
		if (note !== undefined && !notes.includes(note)) notes.push(note);
	}
	return notes;
}
