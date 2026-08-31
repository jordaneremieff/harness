/**
 * Domain-neutral rule and domain contracts.
 *
 * A domain owns one tool, the text it reads from that tool's input, the context
 * shape its rules inspect, and the guidance each rule carries. The classifier
 * holds none of that knowledge, so a second domain lands without a change to
 * the generic path.
 */

/** One observation a domain makes about a captured input. */
export interface Rule<TContext> {
	/** Stable identifier recorded on a matched call, prefixed by its group. */
	id: string;
	/** Grouping the owning domain assigns to its ids. */
	group: string;
	/** Whether this context matches the observation. */
	matches(context: TContext): boolean;
	/** One line of guidance, emitted only in annotate mode. */
	note: string;
}

/** One policy domain: every rule that reads one tool's input. */
export interface Domain {
	/** Tool whose calls this domain reads. */
	readonly tool: string;
	/** Text this domain reads from the tool input, or undefined to read none. */
	capture(input: Record<string, unknown>): string | undefined;
	/** Rule ids the captured text matches, sorted and deduplicated. */
	classify(captured: string): string[];
	/** Guidance for one of this domain's rule ids. */
	note(ruleId: string): string | undefined;
}
