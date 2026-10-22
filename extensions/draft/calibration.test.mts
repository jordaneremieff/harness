// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { run } from "./scripts/test-kit.mts";

const CAREFUL =
	"The nightly export now writes to the new bucket. Two runs failed on Monday because the service account lacked write access. I added the role and reran both jobs. They finished in 11 and 14 minutes. The old bucket stays read only until Friday. After that the lifecycle rule deletes it. One question is open. Should the archive job move too? I recommend yes. It shares the same account and the same schedule. The change is in the branch export-bucket. Tests pass locally and the CI run has not finished yet.";

// The same content, joined and split so that sentence lengths vary.
const CAREFUL_VARIED =
	"The nightly export now writes to the new bucket. Two runs failed on Monday because the service account lacked write access, so I added the role and reran both jobs, and they finished in 11 and 14 minutes. The old bucket stays read only until Friday, then the lifecycle rule deletes it. One question is open: should the archive job move too? Yes. It shares the same account and the same schedule. The change is in the branch export-bucket. Tests pass locally and the CI run has not finished yet.";

const SLOP_DENSE =
	"Great question! Let's dive in. This pivotal change is not only a technical update, but also a testament to our holistic approach. It is important to note that the new pipeline serves as a robust, scalable, and seamless foundation. Underneath all of it, the real issue is the seam between the services. To be honest, this is a nuanced landscape that fosters collaboration and unlocks the potential of the platform. In summary, the team can now navigate the evolving landscape with confidence. Hope this helps!";

test("a careful reply stays green", () => {
	const report = run(CAREFUL);
	assert.equal(report.score.reliable, true);
	assert.equal(report.score.band, "green");
	assert.ok(report.score.sq < 15, String(report.score.sq));
});

test("a slop-dense reply is red", () => {
	const report = run(SLOP_DENSE);
	assert.equal(report.score.band, "red");
	assert.ok(report.score.sq >= 35, String(report.score.sq));
});

test("sentence-length variation alone moves the score by no more than a fixed margin", () => {
	const margin = 8;
	const a = run(CAREFUL).score.sq;
	const b = run(CAREFUL_VARIED).score.sq;
	assert.ok(Math.abs(a - b) <= margin, `uniform ${a} varied ${b}`);
	assert.equal(run(CAREFUL_VARIED).score.band, "green");
});
