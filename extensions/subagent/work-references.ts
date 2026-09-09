/**
 * Lightweight task/artifact/revision/review-disposition references.
 *
 * Agents decide which reviews are needed, who performs them, and whether
 * evidence is acceptable. The runtime only preserves and exposes those
 * decisions: it assigns the requester as the message author's runtime source
 * identity, matches dispositions to requests by exact obligation id, artifact,
 * and revision, and never judges truth or blocks completion.
 *
 * Two shapes share one object, distinguished by `outcome`:
 * - a request (no `outcome`): opens an obligation against an exact artifact
 *   and revision, naming an intended reviewer and an optional required flag;
 * - a disposition (`outcome` set): the requester closes its own obligation.
 * A critique or reply is a normal peer message and is evidence, not a
 * disposition; only the requester's own disposition clears the obligation.
 */

export const WORK_REFERENCE_LIMITS = {
	obligationId: 128,
	artifact: 200,
	revision: 200,
	reviewer: 200,
	reason: 1000,
} as const;

export type ReferenceOutcome = "accepted" | "corrected" | "disagreed" | "unavailable" | "superseded";

const OUTCOMES = new Set<ReferenceOutcome>(["accepted", "corrected", "disagreed", "unavailable", "superseded"]);

export interface WorkReference {
	obligationId: string;
	artifact: string;
	revision: string;
	/** Intended reviewer address. The requester is the message author (runtime
	 * source identity), never a field an agent fills in about itself. */
	reviewer?: string;
	/** Declared required flag. Optional; only present when the agent says so. */
	required?: boolean;
	/** Present only on a disposition; a request carries no outcome. */
	outcome?: ReferenceOutcome;
	/** Bounded reason; required for any non-accepted outcome. */
	reason?: string;
}

export type WorkReferenceResult = { reference: WorkReference } | { error: string };

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

/** Presentation-only bound: strip control characters and cap the length. */
function cleanPresentation(text: string, max: number): string {
	return text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

/**
 * Identity fields are opaque and participate in exact matching. They are never
 * rewritten — truncating or stripping control characters would let two
 * distinct revisions or obligation ids collapse into one. A value that is
 * empty, oversized, or carries control characters is rejected instead.
 */
function identity(value: unknown, field: string, max: number): string | { error: string } {
	if (typeof value !== "string") return { error: `${field} must be a string` };
	if (!value.trim()) return { error: `${field} must be non-empty` };
	if (value.length > max) return { error: `${field} exceeds ${max} characters` };
	if (/[\u0000-\u001f\u007f]/.test(value)) return { error: `${field} must not contain control characters` };
	return value;
}

/**
 * Validate an agent-supplied reference. Opaque identity strings (obligation
 * id, artifact, revision) are preserved exactly and rejected when malformed or
 * oversized; presentation fields (reviewer, reason) are bounded. Control
 * characters are never silently stripped from an identity.
 */
export function sanitizeWorkReference(raw: unknown): WorkReferenceResult {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: "reference must be an object with obligationId, artifact, and revision" };
	}
	const obj = raw as Record<string, unknown>;
	const obligationId = identity(obj.obligationId, "reference.obligationId", WORK_REFERENCE_LIMITS.obligationId);
	if (typeof obligationId !== "string") return { error: obligationId.error };
	const artifact = identity(obj.artifact, "reference.artifact", WORK_REFERENCE_LIMITS.artifact);
	if (typeof artifact !== "string") return { error: artifact.error };
	const revision = identity(obj.revision, "reference.revision", WORK_REFERENCE_LIMITS.revision);
	if (typeof revision !== "string") return { error: revision.error };
	const reviewerRaw = asString(obj.reviewer);
	const reviewer = reviewerRaw === null ? undefined : cleanPresentation(reviewerRaw, WORK_REFERENCE_LIMITS.reviewer);
	const requiredRaw = asBoolean(obj.required);
	if (obj.required !== undefined && requiredRaw === null) {
		return { error: "reference.required must be a boolean when present" };
	}
	let outcome: ReferenceOutcome | undefined;
	if (obj.outcome !== undefined) {
		const outcomeRaw = asString(obj.outcome);
		if (outcomeRaw === null || !OUTCOMES.has(outcomeRaw as ReferenceOutcome)) {
			return { error: `reference.outcome must be one of ${[...OUTCOMES].join(", ")} when present` };
		}
		outcome = outcomeRaw as ReferenceOutcome;
	}
	const reasonRaw = asString(obj.reason);
	const reason = reasonRaw === null ? undefined : cleanPresentation(reasonRaw, WORK_REFERENCE_LIMITS.reason);
	if (outcome !== undefined && outcome !== "accepted" && !reason) {
		return { error: "a non-accepted disposition needs a bounded reason" };
	}
	const reference: WorkReference = { obligationId, artifact, revision };
	if (reviewer !== undefined) reference.reviewer = reviewer;
	if (requiredRaw === true) reference.required = true;
	if (outcome !== undefined) reference.outcome = outcome;
	if (reason !== undefined) reference.reason = reason;
	return { reference };
}

/** One reference-bearing exchange, in the order it was recorded. */
export interface ReferencedExchange {
	/** Runtime source identity of the author (the peer's own address). */
	author: string;
	reference: WorkReference;
	timestamp: number;
}

export interface ObligationView {
	obligationId: string;
	artifact: string;
	revision: string;
	requester: string;
	reviewer: string | null;
	required: boolean;
	outcome: ReferenceOutcome | null;
	reason: string | null;
}

function keyOf(author: string, reference: WorkReference): string {
	return `${author}\u0000${reference.obligationId}\u0000${reference.artifact}\u0000${reference.revision}`;
}

/**
 * Fold reference-bearing exchanges into obligations. Matching is exact on
 * obligation id, artifact, revision, AND requester authorship, in recorded
 * order: a v1 disposition never clears a v2 request, and an unrelated author's
 * disposition never clears another requester's obligation. A later request for
 * the same exact key supersedes its reviewer/required fields. A disposition
 * with no matching request stays visible but clears nothing.
 */
export function projectObligations(exchanges: readonly ReferencedExchange[]): ObligationView[] {
	const views = new Map<string, ObligationView>();
	for (const exchange of [...exchanges].sort((a, b) => a.timestamp - b.timestamp)) {
		const reference = exchange.reference;
		const key = keyOf(exchange.author, reference);
		if (reference.outcome === undefined) {
			views.set(key, {
				obligationId: reference.obligationId,
				artifact: reference.artifact,
				revision: reference.revision,
				requester: exchange.author,
				reviewer: reference.reviewer ?? null,
				required: reference.required === true,
				outcome: null,
				reason: null,
			});
			continue;
		}
		const prior = views.get(key);
		if (prior) {
			prior.outcome = reference.outcome;
			prior.reason = reference.reason ?? null;
		} else {
			views.set(key, {
				obligationId: reference.obligationId,
				artifact: reference.artifact,
				revision: reference.revision,
				requester: exchange.author,
				reviewer: null,
				required: false,
				outcome: reference.outcome,
				reason: reference.reason ?? null,
			});
		}
	}
	return [...views.values()];
}

/** Required obligations that no matching disposition has closed, plus a
 * requester that closed its own obligation with `unavailable` (the reviewer
 * never engaged). These are unresolved required work: exposed for agents and
 * the operator, never used to block completion. */
export function outstandingRequiredObligations(views: readonly ObligationView[]): ObligationView[] {
	return views.filter(
		(view) => view.required && (view.outcome === null || view.outcome === "unavailable"),
	);
}

/** Dispositions closed without acceptance. A reasoned disagreement stays
 * explicitly visible as non-accepted rather than reading as silent success. */
export function unacceptedObligations(views: readonly ObligationView[]): ObligationView[] {
	return views.filter((view) => view.outcome === "disagreed");
}
