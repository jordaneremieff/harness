import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	outstandingRequiredObligations,
	projectObligations,
	sanitizeWorkReference,
	unacceptedObligations,
	type ReferencedExchange,
	type WorkReference,
} from "./work-references.ts";

function ref(overrides: Partial<WorkReference> = {}): WorkReference {
	return { obligationId: "ob-1", artifact: "docs/plan.md", revision: "rev-a", ...overrides };
}

function exchange(author: string, reference: WorkReference, timestamp: number): ReferencedExchange {
	return { author, reference, timestamp };
}

describe("sanitizeWorkReference", () => {
	it("preserves opaque artifact and revision strings verbatim", () => {
		const result = sanitizeWorkReference({
			obligationId: "ob-1",
			artifact: "src/a.ts:41",
			revision: "abc123deadbeef",
		});
		assert.deepEqual(result, {
			reference: { obligationId: "ob-1", artifact: "src/a.ts:41", revision: "abc123deadbeef" },
		});
	});
	it("rejects oversized or control-bearing identity fields instead of rewriting them", () => {
		// A control character or an oversize identity must not be silently
		// stripped or truncated — two distinct revisions/obligation ids would
		// otherwise collapse into one and mis-match dispositions.
		assert.ok("error" in sanitizeWorkReference({ obligationId: "x\u0000y", artifact: "a", revision: "r" }));
		assert.ok("error" in sanitizeWorkReference({ obligationId: "o", artifact: "a".repeat(500), revision: "r" }));
		assert.ok("error" in sanitizeWorkReference({ obligationId: "o", artifact: "a", revision: "r\u001f" }));
		assert.ok("error" in sanitizeWorkReference({ obligationId: "o".repeat(200), artifact: "a", revision: "r" }));
		// Presentation-only fields stay bounded without participating in matching.
		const result = sanitizeWorkReference({
			obligationId: "o",
			artifact: "a",
			revision: "r",
			reviewer: "v".repeat(500),
			outcome: "disagreed",
			reason: "z\u001fz",
		});
		assert.ok("reference" in result, JSON.stringify(result));
		const reference = (result as { reference: WorkReference }).reference;
		assert.equal(reference.reviewer?.length, 200);
		assert.equal(reference.reason, "zz");
	});
	it("requires non-empty obligationId, artifact, and revision", () => {
		for (const raw of [
			{ obligationId: "", artifact: "a", revision: "r" },
			{ obligationId: "o", artifact: " ", revision: "r" },
			{ obligationId: "o", artifact: "a", revision: "" },
			null,
			[],
			"nope",
		]) {
			const result = sanitizeWorkReference(raw);
			assert.ok("error" in result, JSON.stringify(raw));
		}
	});
	it("requires a reason for any non-accepted outcome", () => {
		for (const outcome of ["corrected", "disagreed", "unavailable", "superseded"]) {
			const result = sanitizeWorkReference({ obligationId: "o", artifact: "a", revision: "r", outcome });
			assert.ok("error" in result, `${outcome} needs a reason`);
		}
		const accepted = sanitizeWorkReference({ obligationId: "o", artifact: "a", revision: "r", outcome: "accepted" });
		assert.ok("reference" in accepted, "accepted needs no reason");
	});
	it("rejects an unknown outcome and a non-boolean required flag", () => {
		assert.ok("error" in sanitizeWorkReference({ obligationId: "o", artifact: "a", revision: "r", outcome: "maybe" }));
		assert.ok("error" in sanitizeWorkReference({ obligationId: "o", artifact: "a", revision: "r", required: "yes" }));
	});
});

describe("projectObligations", () => {
	it("opens a required obligation and closes it only by the requester's own exact disposition", () => {
		const request = exchange("worker-a", ref({ required: true, reviewer: "worker-b" }), 1);
		const unrelated = exchange("worker-b", ref({ outcome: "accepted" }), 2);
		const views = projectObligations([request, unrelated]);
		assert.equal(views.length, 2);
		assert.equal(outstandingRequiredObligations(views).length, 1, "a reviewer's disposition does not clear the requester's obligation");

		const own = exchange("worker-a", ref({ outcome: "accepted" }), 3);
		const closed = projectObligations([request, unrelated, own]);
		assert.equal(outstandingRequiredObligations(closed).length, 0);
		const closedView = closed.find((view) => view.requester === "worker-a")!;
		assert.equal(closedView.outcome, "accepted");
	});
	it("never lets a v1 disposition clear a v2 request", () => {
		const v1 = exchange("worker-a", ref({ revision: "rev-1", required: true }), 1);
		const v1done = exchange("worker-a", ref({ revision: "rev-1", outcome: "accepted" }), 2);
		const v2 = exchange("worker-a", ref({ revision: "rev-2", required: true }), 3);
		const views = projectObligations([v1, v1done, v2]);
		assert.equal(outstandingRequiredObligations(views).length, 1);
		assert.equal(outstandingRequiredObligations(views)[0].revision, "rev-2");
	});
	it("keeps a non-accepted disposition and its reason visible rather than faking success", () => {
		const request = exchange("worker-a", ref({ required: true }), 1);
		const disagree = exchange("worker-a", ref({ outcome: "disagreed", reason: "the spec changed" }), 2);
		const views = projectObligations([request, disagree]);
		assert.equal(outstandingRequiredObligations(views).length, 0, "a disagreement closes the obligation");
		const view = views.find((view) => view.requester === "worker-a")!;
		assert.equal(view.outcome, "disagreed");
		assert.equal(view.reason, "the spec changed");
		assert.equal(unacceptedObligations(views).length, 1, "a disagreement stays visible as non-accepted");
		assert.equal(unacceptedObligations(views)[0].reason, "the spec changed");
	});
	it("keeps an unavailable reviewer in the unresolved set rather than reading as closed", () => {
		const request = exchange("worker-a", ref({ required: true, reviewer: "worker-b" }), 1);
		const unavailable = exchange("worker-a", ref({ outcome: "unavailable", reason: "no reviewer available" }), 2);
		const views = projectObligations([request, unavailable]);
		assert.equal(outstandingRequiredObligations(views).length, 1, "unavailable stays unresolved");
		assert.equal(outstandingRequiredObligations(views)[0].outcome, "unavailable");
		assert.equal(unacceptedObligations(views).length, 0);
	});
	it("leaves a dangling disposition visible but unable to clear anything", () => {
		const dangling = exchange("worker-a", ref({ outcome: "unavailable", reason: "no reviewer" }), 1);
		const views = projectObligations([dangling]);
		assert.equal(views.length, 1);
		assert.equal(views[0].outcome, "unavailable");
		assert.equal(outstandingRequiredObligations(views).length, 0);
	});
	it("matches obligationId, artifact, and revision exactly", () => {
		const request = exchange("worker-a", ref({ artifact: "A.md", revision: "r1", required: true }), 1);
		const wrongArtifact = exchange("worker-a", ref({ artifact: "B.md", revision: "r1", outcome: "accepted" }), 2);
		const wrongObligation = exchange("worker-a", ref({ obligationId: "other", artifact: "A.md", revision: "r1", outcome: "accepted" }), 3);
		const views = projectObligations([request, wrongArtifact, wrongObligation]);
		assert.equal(outstandingRequiredObligations(views).length, 1);
	});
});
