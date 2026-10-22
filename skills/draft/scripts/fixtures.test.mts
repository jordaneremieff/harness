// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeText } from "./analyze.mts";
import type { Kind } from "./extract.mts";
import { analyzerFor } from "./test-kit.mts";

interface Fixture {
	id: string;
	kind: string;
	text: string;
	expectFlag: string[];
	expectClean: string[];
	note?: string;
}

/** The one map from fixture family to rule ids. A trailing `*` matches any rule id with that prefix. */
const FAMILIES: Record<string, string[]> = {
	"em-dash": ["punctuation.em-dash"],
	"en-dash": ["punctuation.en-dash"],
	semicolon: ["punctuation.semicolon"],
	"bold-label-bullet": ["structure.bold-label"],
	"bare-url": ["link.bare-url"],
	autolink: ["link.autolink"],
	"url-as-anchor": ["link.url-anchor"],
	"truncated-hex-id": ["structure.truncated-hex-id"],
	"meta-opener": ["structure.meta-opener"],
	"candour-frame": ["epistemic.candour-frame"],
	"compliance-narration": ["laundering.compliance-narration"],
	signpost: ["epistemic.signpost"],
	"root-cause-reveal": ["epistemic.root-cause-reveal"],
	"two-step": ["geometry.individually-collectively"],
	"performed-precision": ["epistemic.performed-precision"],
	"negative-parallelism": ["geometry.negative-parallelism", "geometry.negative-contrast"],
	triplet: ["geometry.triad"],
	"copula-avoidance": ["geometry.copula-avoidance"],
	"hollow-emphasis": ["epistemic.hollow-emphasis"],
	"vague-authority": ["epistemic.vague-authority"],
	"colon-label-opener": ["punctuation.colon-label"],
	"closing-menu": ["epistemic.closing-menu", "epistemic.closing-offer"],
	"buzzword-cluster": ["lexical.*", "epistemic.evaluative"],
	"invented-compound": ["lexical.coined-compound", "lexical.coined-chain", "lexical.coined-curated"],
	"american-spelling": ["spelling.*"],
	"long-parenthetical": ["punctuation.parenthetical-aside", "punctuation.quoted-name-parenthetical"],
	"middle-dot": ["punctuation.middle-dot"],
	"see-also-heading": ["structure.see-also-top"],
	"spaced-hyphen": ["punctuation.spaced-hyphen"],
	"code-chip-soup": ["structure.code-chip-soup"],
	"commit-subject-long": ["commit.subject-length"],
	"commit-subject-period": ["commit.subject-period"],
	"commit-generic-subject": ["commit.subject-generic"],
	"narrated-commit": ["commit.subject-narrated"],
};

/** Fixtures whose label the reviewed rule decisions supersede. The reason is the audit trail. */
const SUPERSEDED: Record<string, string> = {
	"en-dash-year-range": "A digit-to-digit range is exempt from the en dash rule by decision.",
};

const fixtures = JSON.parse(readFileSync(fileURLToPath(new URL("../data/fixtures.json", import.meta.url)), "utf8")) as Fixture[];
const analyzer = analyzerFor({ spelling: "au", times: "off", strictSemicolons: false });

function reported(fixture: Fixture): string[] {
	const kind: Kind = fixture.kind === "commit" ? "commit" : "md";
	const report = analyzeText(analyzer, fixture.text, kind);
	return [...report.hard, ...report.scored].map((finding) => finding.rule);
}

function familyHit(family: string, ids: string[]): boolean {
	const targets = FAMILIES[family];
	assert.ok(targets, `fixture family ${family} has no rule mapping`);
	return targets.some((target) => ids.some((id) => (target.endsWith("*") ? id.startsWith(target.slice(0, -1)) : id === target)));
}

test("every fixture family maps to rule ids that exist", () => {
	const known = new Set(fixtures.flatMap((fixture) => [...fixture.expectFlag, ...fixture.expectClean]));
	for (const family of known) assert.ok(FAMILIES[family], family);
});

for (const fixture of fixtures) {
	test(`fixture ${fixture.id}`, () => {
		const ids = reported(fixture);
		const exempt = SUPERSEDED[fixture.id] !== undefined;
		for (const family of fixture.expectFlag) assert.ok(exempt || familyHit(family, ids), `${family} not reported; got ${ids.join(", ")}`);
		for (const family of fixture.expectClean) assert.ok(!familyHit(family, ids), `${family} reported; got ${ids.join(", ")}`);
	});
}
