/**
 * Active mechanism selection.
 *
 * The mode names which mechanism acts on a matched call. Every mode records.
 * `observe` acts on nothing, `notice` shows the operator a flag, and `annotate`
 * appends one line of guidance to the flagged tool result. The modes are
 * exclusive so a recorded effect belongs to one mechanism.
 *
 * An unrecognized value is a configuration error, not a reason to guess. The
 * caller reports it once and stops recording for the session.
 */

export type PolicyMode = "observe" | "notice" | "annotate";

export const POLICY_MODES: readonly PolicyMode[] = ["observe", "notice", "annotate"];

const DEFAULT_MODE: PolicyMode = "observe";

function isPolicyMode(value: string): value is PolicyMode {
	return (POLICY_MODES as readonly string[]).includes(value);
}

/** Mode from `PI_POLICY_MODE`; `observe` when the variable is unset or empty. */
export function resolvePolicyMode(env: NodeJS.ProcessEnv = process.env): PolicyMode {
	const raw = env.PI_POLICY_MODE?.trim();
	if (raw === undefined || raw === "") return DEFAULT_MODE;
	if (!isPolicyMode(raw)) {
		throw new Error(`PI_POLICY_MODE must be one of ${POLICY_MODES.join(", ")}; received "${raw}"`);
	}
	return raw;
}
