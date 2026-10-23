// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { loadRules, parseRules, type Rule, RulesError, specTerms, type TermSpec, termText } from "./scripts/rules.mts";
import { ALL_OPTIONS, count, run } from "./scripts/test-kit.mts";

const set = loadRules();
const termsRules = set.rules.filter((rule) => rule.terms !== undefined);

function word(term: string): string {
	return term.replace(/\*$/, "");
}

function fires(text: string, ruleId: string): boolean {
	return count(run(text, "md", ALL_OPTIONS), ruleId) > 0;
}

function mutated(change: (data: Record<string, unknown>) => void): unknown {
	const copy = JSON.parse(JSON.stringify(set)) as Record<string, unknown>;
	change(copy);
	return copy;
}

/** Plain words taken from a context regex source, used to find a sample that triggers the exemption. */
function candidates(source: string): string[] {
	const stripped = source.replace(/\\[a-zA-Z]/g, " ");
	return [...new Set(stripped.match(/[a-z]{3,}/gi) ?? [])];
}

test("short quoted lexical mentions are not uses of their terms", () => {
	for (const [open, close] of [['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"]]) {
		assert.equal(fires(`The report names ${open}pivotal${close}.`, "lexical.pivotal"), false);
		assert.equal(fires(`The report names ${open} robust ${close}.`, "lexical.robust"), false);
		assert.equal(fires(`The report names ${open}shed light${close}.`, "lexical.tier-two"), false);
		assert.equal(fires(`${open}This pivotal design is robust.${close}`, "lexical.pivotal"), true);
		assert.equal(fires(`${open}This pivotal design is robust.${close}`, "lexical.robust"), true);
		assert.equal(fires(`${open}a pivotal design${close}`, "lexical.pivotal"), true);
		assert.equal(fires(`${open}robust.${close}`, "lexical.robust"), true);
		assert.equal(fires(`${open}that's not nothing${close}`, "lexical.agent-speak"), true);
	}
});

test("mention exemptions preserve genuine uses, unmatched quotes and other rule groups", () => {
	assert.equal(count(run('The report names "pivotal". The pivotal design is robust.'), "lexical.pivotal"), 1);
	assert.equal(fires('The report names "pivotal”.', "lexical.pivotal"), true);
	assert.equal(fires("The report names ‘pivotal'.", "lexical.pivotal"), true);
	assert.equal(fires("The report calls it 'pivotal's effect.", "lexical.pivotal"), true);
	assert.equal(fires('The report names "pivotal', "lexical.pivotal"), true);
	assert.equal(fires('The report quotes "an outcome — here".', "punctuation.em-dash"), true);
	assert.equal(fires('The report quotes "pivotal\nwork".', "lexical.pivotal"), true);
});

test("inline code already excludes lexical mentions without hiding surrounding uses", () => {
	assert.equal(fires("The report names `pivotal` and `robust`.", "lexical.pivotal"), false);
	assert.equal(fires("The report names `pivotal` and `robust`.", "lexical.robust"), false);
	assert.equal(fires("The `pivotal` token appears in a pivotal design.", "lexical.pivotal"), true);
});

test("a context word in an earlier sentence or paragraph never hides a different term", () => {
	const text = "Here is a seamless overview of the plan.\n\n- **Status:** the fix is load-bearing; it is done.\n";
	const report = run(text);
	assert.equal(count(report, "lexical.agent-speak"), 1);
	assert.equal(count(report, "structure.bold-label"), 1);
	assert.equal(count(report, "punctuation.semicolon"), 1);
});

test("every term of every terms rule fires alone, in a sentence, a list item, a bold-label line and a quote", () => {
	const misses: string[] = [];
	for (const rule of termsRules) {
		for (const entry of rule.terms ?? []) {
			const w = word(termText(entry));
			const shapes = [
				`Here is a plain sentence that uses ${w} once.`,
				`- A list item that uses ${w} once.`,
				`- **Status:** a line that uses ${w} once.`,
				`> A quoted line that uses ${w} once.`,
			];
			for (const shape of shapes) if (!fires(shape, rule.id)) misses.push(`${rule.id} / ${w} / ${shape.slice(0, 12)}`);
		}
	}
	assert.deepEqual(misses, []);
});

test("a term-level exemption still exempts its own term", () => {
	const unguarded: string[] = [];
	for (const rule of termsRules) {
		for (const spec of specTerms(rule)) {
			const sample = candidates((spec.context ?? []).join(" ")).concat(candidates((spec.twin ?? []).join(" ")));
			const exempt = sample.some((c) => !fires(`The ${c} ${word(spec.term)} appears here.`, rule.id));
			if (!exempt) unguarded.push(`${rule.id} / ${spec.term}`);
		}
	}
	assert.deepEqual(unguarded, []);
});

function leaksFrom(rule: Rule, spec: TermSpec): string[] {
	const leaks: string[] = [];
	const sample = candidates((spec.context ?? []).join(" "));
	for (const other of rule.terms ?? []) {
		if (termText(other) === spec.term || typeof other !== "string") continue;
		const w = word(other);
		for (const c of sample) {
			const texts = [`The ${c} ${w} appears here.`, `A note about the ${c}.\n\nThe ${w} appears here.`, `A note about the ${c}. The ${w} appears here.`];
			for (const text of texts) if (!fires(text, rule.id)) leaks.push(`${rule.id}: ${c} hides ${w}`);
		}
	}
	return leaks;
}

test("a term-level exemption never hides another term of the same rule", () => {
	const leaks = termsRules.flatMap((rule) => specTerms(rule).flatMap((spec) => leaksFrom(rule, spec)));
	assert.deepEqual(leaks, []);
});

test("a rule-level exemption stops at the sentence, the paragraph and the list item", () => {
	assert.equal(fires("The message resonates with readers.", "lexical.resonate"), true);
	assert.equal(fires("The circuit has a resonant frequency near the message.\n\nThe message resonates.", "lexical.resonate"), true);
	assert.equal(fires("- The circuit frequency is fixed.\n- The message resonates.", "lexical.resonate"), true);
	assert.equal(fires("The circuit resonates at a set frequency.", "lexical.resonate"), false);
});

test("the loader refuses rule-level context on a rule with several terms", () => {
	const data = mutated((value) => {
		const rule = (value.rules as Array<Record<string, unknown>>).find((entry) => entry.id === "lexical.tier-one");
		if (rule === undefined) throw new Error("fixture rule missing");
		rule.context = ["\\bnote\\b"];
	});
	assert.throws(() => parseRules(data), (error: unknown) => error instanceof RulesError && /several terms cannot carry rule-level context/.test(error.message));
});

test("the loader checks term-level exemptions", () => {
	const data = mutated((value) => {
		const rule = (value.rules as Array<Record<string, unknown>>).find((entry) => entry.id === "lexical.agent-speak");
		if (rule === undefined) throw new Error("fixture rule missing");
		(rule.terms as unknown[])[0] = { term: "load-bearing", context: ["("] };
	});
	assert.throws(() => parseRules(data), RulesError);
});

test("every catalog family resolves to existing rules or a judgement item", () => {
	const ruleIds = new Set(set.rules.map((rule) => rule.id));
	const judgementIds = new Set(set.judgement.map((item) => item.id));
	for (const entry of set.catalog) {
		for (const id of entry.rules ?? []) assert.ok(ruleIds.has(id), `${entry.family}: ${id}`);
		if (entry.judgement !== undefined) assert.ok(judgementIds.has(entry.judgement), entry.family);
	}
	for (const item of set.judgement) assert.ok(set.catalog.some((entry) => entry.judgement === item.id), item.id);
	const required = [
		"invented-vocabulary", "coded-references", "buzzword-stacking", "stock-agent-speak", "emphasis-swaps", "performed-precision",
		"negative-parallelism", "padded-triplets", "individually-collectively", "punch-fragments", "copula-avoidance", "hollow-emphasis",
		"dash-connectors", "semicolon-chains", "colon-labels", "filler-parentheticals", "signposts", "bold-label-taxonomies",
		"root-cause-reveals", "conspicuous-formatting", "pendulum-compression", "vague-authority", "unearned-hedging",
		"symbol-swap-laundering", "compliance-performance", "presumed-context-questions", "candour-frames", "developer-term",
		"designed-state-as-failure",
	];
	const families = new Set(set.catalog.map((entry) => entry.family));
	for (const family of required) assert.ok(families.has(family), family);
});

test("the loader refuses a catalog entry that points nowhere", () => {
	const data = mutated((value) => {
		(value.catalog as Array<Record<string, unknown>>)[0] = { family: "x", rules: ["lexical.nope"] };
	});
	assert.throws(() => parseRules(data), /unknown rule/);
	const bad = mutated((value) => {
		(value.catalog as Array<Record<string, unknown>>)[0] = { family: "x", judgement: "nope" };
	});
	assert.throws(() => parseRules(bad), /unknown judgement/);
});

test("performed precision swaps: exempt with a named check or a quoting instruction", () => {
	assert.equal(fires("The new file is verbatim what you approved.", "epistemic.performed-precision-swap"), true);
	assert.equal(fires("The two outputs are precisely the same.", "epistemic.performed-precision-swap"), true);
	assert.equal(fires("The notes are word for word what was said.", "epistemic.performed-precision-swap"), true);
	assert.equal(fires("Quote the error verbatim in the ticket.", "epistemic.performed-precision-swap"), false);
	assert.equal(fires("A `diff` run shows the output is precisely the same.", "epistemic.performed-precision-swap"), false);
	assert.equal(fires("The files are byte for byte the same.", "epistemic.performed-precision"), true);
});

test("a lone 'identical' is not a performed-precision or presumed-context finding", () => {
	const report = run("The two configs are identical.", "md", ALL_OPTIONS);
	assert.equal(count(report, "epistemic.presumed-context"), 0);
	assert.equal(count(report, "epistemic.performed-precision"), 0);
});

test("rather-than figures fire, a design choice stays clean", () => {
	const figure = (text: string): number => count(run(text), "geometry.negative-parallelism");
	assert.equal(figure("The tool is built for speed rather than for safety."), 1);
	assert.equal(figure("Rather than a simple queue, it offers a full scheduler."), 1);
	assert.equal(figure("We chose a queue rather than a lock."), 0);
	assert.equal(figure("We chose a queue rather than a lock, and it offers fewer surprises."), 0);
	assert.equal(figure("Rather than wait, we ran the job again, later."), 0);
});

test("failure-framed headings fire, risk headings stay clean", () => {
	const heading = (text: string): number => count(run(text), "structure.failure-framed-heading");
	assert.equal(heading("## What can go wrong\n\nThe queue drops the oldest job at capacity.\n"), 1);
	assert.equal(heading("## What could go wrong?\n\nText.\n"), 1);
	assert.equal(heading("## Risks\n\nText.\n"), 0);
	assert.equal(heading("## Failure modes\n\nText.\n"), 0);
});

test("punch fragments: the staccato tag fires, short legitimate sentences stay clean", () => {
	const frag = (text: string): number => count(run(text), "geometry.punch-fragment");
	assert.equal(frag("You do not. That is the point."), 1);
	assert.equal(frag("Run it. Check the log."), 0);
	assert.equal(frag("Is it ready? Yes."), 0);
	assert.equal(frag("It works. That is fine."), 0);
	assert.equal(frag("See the guide for details. It covers setup."), 0);
});

test("recap openers cover 'As a reminder,'", () => {
	const recap = (text: string): number => count(run(text), "epistemic.recap-opener");
	assert.equal(recap("As a reminder, this session began with a request to fix the build."), 1);
	assert.equal(recap("The build failed. To recap, the cache was stale."), 1);
	assert.equal(recap("The reminder service runs hourly."), 0);
});

test("vague authority: a figure beside a study exempts only the study rule", () => {
	assert.equal(fires("Studies show that retries help.", "epistemic.vague-authority-study"), true);
	assert.equal(fires("Studies show a 12% drop in errors.", "epistemic.vague-authority-study"), false);
	assert.equal(fires("It is widely understood that retries help, at 12%.", "epistemic.vague-authority"), true);
});
