// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { ALL_OPTIONS, count, filler, run } from "./test-kit.mts";

const linksDoc = (anchors: boolean): string => {
	const paragraphs: string[] = [];
	for (let i = 0; i < 60; i++) {
		const url = `https://example.org/reference/section-${i}/details/with/a/very/long/path/segment?query=${"x".repeat(30)}`;
		paragraphs.push(anchors ? `The team wrote [note ${i}](${url}) after the review.` : `The team wrote note ${i} after the review.`);
	}
	return `${filler(150)}\n\n${paragraphs.join("\n\n")}\n`;
};

test("D1: sixty long-url links add no findings and no score", () => {
	const withLinks = run(linksDoc(true));
	const plain = run(linksDoc(false));
	assert.ok(Math.abs(withLinks.score.sq - plain.score.sq) <= 1);
	assert.equal(count(withLinks, "punctuation.parenthetical-aside"), 0);
	assert.equal(count(withLinks, "punctuation.spaced-hyphen"), 0);
	assert.equal(count(withLinks, "punctuation.double-hyphen"), 0);
	assert.equal(withLinks.hard.length, 0);
});

test("D2: ten label shapes give one finding each, mid-sentence bold gives none", () => {
	const shapes = [
		"- **Label:** text here",
		"* **Label**: text here",
		"+ **Label** - text here",
		"1. **Label:** text here",
		"2) **Label**: text here",
		"- **label** \u2013 text here",
		"- **Label** \u2014 text here",
		"1. **Label** - text here",
		"<li><b>Label:</b> text here</li>",
		"<ul>\n<li><strong>Label</strong> - text here</li>\n</ul>",
	];
	for (const shape of shapes) assert.equal(count(run(shape), "structure.bold-label"), 1, shape);
	for (const clean of ["- Use **bold** inside a sentence", "A line with **bold** words.", "- **Whole item bold**", "- plain item: with colon"])
		assert.equal(count(run(clean), "structure.bold-label"), 0, clean);
});

test("D3: em and en dashes are flagged with correct lines, never inside code", () => {
	const report = run("Line one.\nTwo \u2014 here.\nThree \u2013 there.\n\n`a \u2014 b`\n\n```\nc \u2013 d\n```\n");
	const dashes = report.hard.filter((finding) => finding.rule.endsWith("-dash"));
	assert.deepEqual(
		dashes.map((finding) => [finding.rule, finding.line]),
		[
			["punctuation.em-dash", 2],
			["punctuation.en-dash", 3],
		],
	);
});

test("D4 and D11: a single semicolon is reported, entities and code are not", () => {
	assert.equal(count(run("One clause; another clause."), "punctuation.semicolon"), 1);
	assert.equal(count(run("The first clause ends here;\nthe second starts."), "punctuation.semicolon"), 1);
	assert.equal(count(run("Fish &amp; chips are fine."), "punctuation.semicolon"), 0);
	assert.equal(count(run("Use `a; b` in the shell."), "punctuation.semicolon"), 0);
	assert.equal(count(run("Pears, plums; oats, rye."), "punctuation.semicolon"), 0);
	const strict = run("One clause; another clause.", "md", { strictSemicolons: true });
	assert.equal(strict.hard.filter((finding) => finding.rule === "punctuation.semicolon").length, 1);
	assert.equal(strict.scored.filter((finding) => finding.rule === "punctuation.semicolon").length, 0);
});

test("D5: uniform sentence length scores higher geometry than varied length", () => {
	const uniform = Array.from({ length: 12 }, (_, i) => `The service number ${i} reads the shared queue and then writes every result to the disk log file.`).join(" ");
	const varied =
		"The queue stalled. Nobody noticed for an hour, because the dashboard only refreshed on deploys, and the deploy that day was late. We found it by reading the log. It was a lock. The fix took ten minutes once we knew where to look, but finding the lock took most of the afternoon and two people. Then the backlog drained. Good.";
	const a = run(uniform).score.components.geometry.value;
	const b = run(varied).score.components.geometry.value;
	assert.ok(a > b, `uniform ${a} should exceed varied ${b}`);
	assert.ok(run(varied.repeat(3)).score.sq < 15);
});

test("D6: a phrase counts once even when two rules could match it", () => {
	const report = run(`${filler(60)} The result is a testament to the design. The plan is seamless.`);
	assert.equal(report.scored.filter((finding) => finding.text.toLowerCase().includes("testament")).length, 1);
	assert.equal(count(report, "epistemic.evaluative"), 0);
	assert.equal(count(report, "lexical.tier-one"), 2);
});

test("D8: links add no anchors and a source file counts anchors from comments only", () => {
	const a = run(linksDoc(true)).score.components.epistemic.metrics.anchors;
	const b = run(linksDoc(false)).score.components.epistemic.metrics.anchors;
	assert.equal(a, b);
	const code = "const some_value = readConfig(path_to_file);\n// The cache is cold.\n";
	assert.equal(run(code, "ts").score.components.epistemic.metrics.anchors, 0);
});

test("D9: a single long or conjunction parenthetical is flagged, a short one is not", () => {
	assert.equal(count(run("The note (this one has exactly thirty six chars) ends."), "punctuation.parenthetical-aside"), 1);
	assert.equal(count(run("The note (which was late) ends."), "punctuation.parenthetical-aside"), 0);
	assert.equal(count(run("The note (nightly) ends."), "punctuation.parenthetical-aside"), 0);
});

test("D10: nested lists have no swaps, spaced hyphens between words do", () => {
	const nested = "- one\n  - two\n    - three\n\n| a | b |\n| - | - |\n";
	assert.equal(count(run(nested), "punctuation.spaced-hyphen"), 0);
	assert.equal(count(run("Alpha - beta."), "punctuation.spaced-hyphen"), 1);
	assert.equal(count(run("Subtract 5 - 3 here."), "punctuation.spaced-hyphen"), 0);
});

test("D12: truncated ids are found inside inline code, not in fenced code", () => {
	assert.equal(count(run("Compare `3fa91c2e...` now."), "structure.truncated-hex-id"), 1);
	assert.equal(count(run("```\n3fa91c2e...\n```\n"), "structure.truncated-hex-id"), 0);
});

test("D16: unclosed fences are not prose, long fences close on a long marker", () => {
	const report = run("Plain intro sentence.\n\n```\nThis is truly honest to be honest code\n");
	assert.equal(count(report, "epistemic.candour-frame"), 0);
	const long = run("````\n```\nTo be honest\n````\nAfter the fence.\n");
	assert.equal(count(long, "epistemic.candour-frame"), 0);
});

test("D17: a ten-bullet list of short phrases is ten sentences", () => {
	const list = Array.from({ length: 10 }, (_, i) => `- phrase number ${i}`).join("\n");
	assert.equal(run(list).input.sentences, 10);
});

test("D18: technical senses of stock words are not lexical hits", () => {
	for (const clean of [
		"Dynamic dispatch picks the method at run time.",
		"The test harness runs in four seconds.",
		"Set text-align: center for the box.",
		"Use robust standard errors for the fit.",
		"The struct needs memory alignment to eight bytes.",
		"The critical section holds the lock.",
		"The Kerberos realm is set in the config.",
	]) {
		const report = run(clean, "md", ALL_OPTIONS);
		const lexical = report.scored.filter((finding) => finding.rule.startsWith("lexical."));
		assert.deepEqual(lexical, [], clean);
	}
	assert.ok(count(run("A dynamic and robust solution awaits."), "lexical.dynamic") >= 1);
	assert.ok(count(run("A dynamic and robust solution awaits."), "lexical.robust") >= 1);
});

test("D19: ordinary verbs are not copula avoidance, claim usage is", () => {
	assert.equal(count(run("Mark a job as failed when it times out."), "geometry.copula-avoidance"), 0);
	assert.equal(count(run("The cache acts as a proxy for the database."), "geometry.copula-avoidance"), 0);
	assert.equal(count(run("The rewrite stands as a testament to patience."), "geometry.copula-avoidance"), 1);
	assert.equal(count(run("Rather than wait, we ran the job again, later."), "geometry.negative-parallelism"), 0);
	assert.equal(count(run("It is not only fast but also safe."), "geometry.negative-parallelism"), 1);
});

test("D20: a short subject line reports its finding and gives no band", () => {
	const report = run("A pivotal change", "text");
	assert.ok(count(report, "lexical.pivotal") >= 1);
	assert.equal(report.score.reliable, false);
	assert.equal(report.score.band, null);
});

test("D21: number lists and code-like lists are not triads", () => {
	for (const clean of ["Pick 1, 2, and 3.", "Use red_a, red_b, and red_c.", "Ask Ana, Bo, and Cy."])
		assert.equal(count(run(clean), "geometry.triad"), 0, clean);
	assert.equal(count(run("It is fast, reliable, and scalable."), "geometry.triad"), 1);
});

test("D15: a code-only source file has no prose and scores zero", () => {
	const report = run("const label = '# not prose';\nconst n = 1;\n", "ts");
	assert.equal(report.input.words, 0);
	assert.equal(report.score.sq, 0);
});

test("a scored hit that overlaps a hard hit is not double reported", () => {
	const report = run("- **Risk** - low\n");
	assert.equal(count(report, "structure.bold-label"), 1);
	assert.equal(count(report, "punctuation.spaced-hyphen"), 0);
});

test("see-also is flagged by position, not at the end", () => {
	assert.equal(count(run("# T\n\n## See also\n\nBody.\n"), "structure.see-also-top"), 1);
	assert.equal(count(run(`# T\n\n${filler(80)}\n\n${filler(80)}\n\n## See also\n\n- [a](b)\n`), "structure.see-also-top"), 0);
});

test("firstOnly reports each coded reference once", () => {
	const report = run("Ticket QX-4521 shows it. Ticket QX-4521 again. Another QX-9000.");
	assert.equal(count(report, "epistemic.unexplained-code"), 2);
});

test("candour frames inside quotes are exempt, outside they are hard", () => {
	assert.equal(count(run('The phrase "to be honest" is a tell.'), "epistemic.candour-frame"), 0);
	assert.equal(count(run("Frankly, this is slow."), "epistemic.candour-frame"), 1);
});

test("spelling and time options switch the advisory checks", () => {
	assert.equal(count(run("We normalize the color."), "spelling.ize-yze"), 1);
	assert.equal(count(run("We normalize the color.", "md", { spelling: "off" }), "spelling.ize-yze"), 0);
	assert.equal(count(run("It ran at 14:30."), "time.twenty-four-hour"), 0);
	assert.equal(count(run("It ran at 14:30.", "md", { times: "12h" }), "time.twenty-four-hour"), 1);
	assert.equal(count(run("We emphasize the size and the prize."), "spelling.ize-yze"), 1);
	assert.equal(count(run("Call `normalize()` and the normalizeText helper."), "spelling.ize-yze"), 0);
});

test("performed precision is exempt when the check is named", () => {
	assert.equal(count(run("The files are byte for byte the same."), "epistemic.performed-precision"), 1);
	assert.equal(count(run("A `cmp` run showed the files are byte for byte the same."), "epistemic.performed-precision"), 0);
});

test("commit rules run only on commit text", () => {
	const subject = `feat: ${"long ".repeat(20)}`;
	assert.equal(count(run(subject, "commit"), "commit.subject-length"), 1);
	assert.equal(count(run(subject, "md"), "commit.subject-length"), 0);
	assert.equal(count(run("Merge branch main into topic ".repeat(4), "commit"), "commit.subject-length"), 0);
	assert.equal(count(run("fix: handle empty input.", "commit"), "commit.subject-period"), 1);
	assert.equal(count(run("fix: handle empty input\n\nBody sentence ends here.", "commit"), "commit.subject-period"), 0);
	assert.equal(count(run("misc changes", "commit"), "commit.subject-generic"), 1);
	assert.equal(count(run("fix: reject empty input", "commit"), "commit.subject-generic"), 0);
	assert.equal(count(run("wip", "commit"), "commit.subject-generic"), 1);
	assert.equal(count(run("I fixed the parser", "commit"), "commit.subject-narrated"), 1);
	assert.equal(count(run("fix: reject empty input\n\nAddressed review feedback.", "commit"), "commit.apologetic-leak"), 1);
});

test("html input: tags and attributes are not prose, list-item labels are found", () => {
	const html = '<ul><li><b>Status:</b> done</li></ul><p>See <a href="https://example.org/x">the page</a> now \u2014 quickly.</p>';
	const report = run(html, "html");
	assert.equal(count(report, "structure.bold-label"), 1);
	assert.equal(count(report, "punctuation.em-dash"), 1);
	assert.equal(count(report, "link.bare-url"), 0);
	assert.equal(count(run("<p>Visit https://example.org/y today.</p>", "html"), "link.bare-url"), 1);
});

test("source files: comments are checked, strings are not", () => {
	const source = 'const note = "a dash \u2014 in a string";\n// A dash \u2014 in a comment.\n';
	const report = run(source, "ts");
	assert.deepEqual(
		report.hard.map((finding) => [finding.rule, finding.line]),
		[["punctuation.em-dash", 2]],
	);
});

test("heading density flags many headings on little text only", () => {
	const dense = "# One\n\nShort text here.\n\n# Two\n\nMore text.\n\n# Three\n\nLast bit.\n";
	assert.equal(count(run(dense), "geometry.heading-density"), 1);
	assert.equal(count(run(`# One\n\n${filler(300)}\n\n## Two\n\n${filler(300)}\n\n## Three\n\n${filler(300)}\n\n## Four\n\n${filler(300)}\n`), "geometry.heading-density"), 0);
});

test("a dense paragraph and heavy bold are scored findings", () => {
	assert.equal(count(run("The cache holds the data. ".repeat(40)), "geometry.pendulum-block"), 1);
	assert.equal(count(run("The **a** and **b** and **c** and **d** fail in this short text."), "geometry.bold-density"), 1);
});

test("coined compounds respect the standard-compound list", () => {
	assert.equal(count(run("The client-side check and the kernel-level hook are standard."), "lexical.coined-compound"), 0);
	assert.equal(count(run("The retry is state-gated here."), "lexical.coined-compound"), 1);
});

test("the developer term is advisory only", () => {
	const report = run("The developer approved the change.");
	assert.equal(count(report, "lexical.developer-term"), 1);
	assert.equal(report.score.components.lexical.metrics.hits, 0);
});

test("negative parallelism covers noun-phrase subjects and exempts concrete diagnoses", () => {
	assert.equal(count(run("The cache is not a cache, it is a lookup table."), "geometry.negative-parallelism"), 1);
	assert.equal(count(run("The cache is not the issue, it is the dependency graph."), "geometry.negative-parallelism"), 1);
	assert.equal(count(run("The failure is not in `parse_input`, it is in the caller."), "geometry.negative-parallelism"), 0);
	assert.equal(count(run("The bug is not in src/parse.mts, it is in the loader."), "geometry.negative-parallelism"), 0);
	assert.equal(count(run("The cache is not stale. It is empty."), "geometry.negative-parallelism"), 0);
});

test("each-small then together is the individually/collectively figure", () => {
	assert.equal(count(run("Each one is small. Together they add up to a full outage."), "geometry.individually-collectively"), 1);
	assert.equal(count(run("Every package is minor. Collectively, they form a large surface."), "geometry.individually-collectively"), 1);
	assert.equal(count(run("Each package is small. The build uses four of them."), "geometry.individually-collectively"), 0);
});

test("hollow emphasis covers doubled adverbs and reflexives, not by/in itself", () => {
	assert.equal(count(run("The change simply just did the thing itself."), "epistemic.hollow-emphasis"), 2);
	assert.equal(count(run("It works just simply fine."), "epistemic.hollow-emphasis"), 1);
	assert.equal(count(run("The loop runs by itself, and that is a case in itself."), "epistemic.hollow-emphasis"), 0);
});

test("hyphen chains and abstract-label compounds are coined, standard ones are not", () => {
	assert.equal(count(run("The filled-from-no-position handling added a performed-structure layer."), "lexical.coined-chain"), 2);
	assert.equal(count(run("The end-to-end test uses a state-of-the-art parser and an off-by-one guard."), "lexical.coined-chain"), 0);
	assert.equal(count(run("The data-structure walk checks the cursor-position."), "lexical.coined-chain"), 0);
});

test("technical senses of robust, dynamic and align stay quiet", () => {
	for (const clean of [
		"The fix should be robust against null input before we ship it.",
		"The parser stays robust to malformed headers.",
		"The loader reads dynamic config at start.",
		"Align to a page boundary before mapping.",
		"The text alignment of the table cells is fixed.",
	]) {
		assert.deepEqual(
			run(clean).scored.filter((finding) => finding.rule.startsWith("lexical.")),
			[],
			clean,
		);
	}
	assert.equal(count(run("A robust approach wins."), "lexical.robust"), 1);
});

test("en dash: a digit range is exempt, other en dashes stay hard", () => {
	assert.equal(count(run("Builds from 2020\u20132024 ship."), "punctuation.en-dash"), 0);
	assert.equal(count(run("The plan \u2013 mostly works."), "punctuation.en-dash"), 1);
});

test("code chip soup needs three spans, a colon and a pipe on one line", () => {
	assert.equal(count(run("* Run `a`: set `B`, pass `--c`, wire `d.e` | ok."), "structure.code-chip-soup"), 1);
	assert.equal(count(run("* Run `a` and set `B` and wire `d.e` here."), "structure.code-chip-soup"), 0);
});
