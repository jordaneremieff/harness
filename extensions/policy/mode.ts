/**
 * Active mechanism selection.
 *
 * The mode names which mechanism acts on a matched call. Every mode records.
 * `observe` acts on nothing, `notice` shows the operator a flag, `annotate`
 * appends one line of guidance to the flagged tool result, and `enforce`
 * blocks the flagged call with a reason that names the preferred form. The
 * modes are exclusive so a recorded effect belongs to one mechanism.
 *
 * An unrecognized session flag is a configuration error. Machine settings
 * use the shared reader's safe default and rejected-source diagnostics.
 */

export type PolicyMode = "observe" | "notice" | "annotate" | "enforce";

export const POLICY_MODES: readonly PolicyMode[] = ["observe", "notice", "annotate", "enforce"];

function isPolicyMode(value: string): value is PolicyMode {
	return (POLICY_MODES as readonly string[]).includes(value);
}

/** Resolve one explicit setting, rejecting empty and unrecognized values. */
export function resolvePolicyModeValue(value: string, source: string): PolicyMode {
	const raw = value.trim();
	if (!isPolicyMode(raw)) {
		throw new Error(`${source} must be one of ${POLICY_MODES.join(", ")}; received "${raw}"`);
	}
	return raw;
}
