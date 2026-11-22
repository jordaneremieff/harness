import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWriting, describeFindings, MAX_EXAMPLES } from "./checks.ts";
import { compile } from "@earendil-works/pi-schema";
import { describeRules, invalidCheckField } from "./check-rules.ts";
import { readSettings, settings } from "./settings.ts";
import { loadLexicon, loadReader, writingOptions } from "./writing-config.ts";

const rules = (text: string, options?: Parameters<typeof checkWriting>[1]) =>
	checkWriting(text, options).map((entry) => entry.rule);

test("the checksRules schema agrees with the owner's structural checks", () => {
	const schema = compile(settings.fields.checksRules.schema);
	for (const value of [
		{},
		{ lexicon: "terms.txt" },
		{ lexicon: "\u2028terms.txt" },
		{
			rules: {
				dashes: { enabled: false, limit: 0 },
				identifiers: {},
				escapedBreaks: {},
				labelLines: {},
				opening: {},
				negations: {},
			},
		},
		{
			rules: {
				phrases: { phrases: ["stock phrase"], addPhrases: [], removePhrases: ["other"] },
				coinages: { allow: ["well-known"] },
			},
		},
		{ rules: { codeSpans: { perHundred: 1.5, minWords: 1 }, processNarration: { limit: 1, share: 1 } } },
		{ rules: { codeSpans: { limit: 1.5 } } },
	]) {
		assert.equal(invalidCheckField(value), undefined, JSON.stringify(value));
		assert.equal(schema.check(value), true, JSON.stringify(value));
	}
	for (const value of [
		null,
		[],
		{ extra: true },
		{ lexicon: " " },
		{ lexicon: "x\n" },
		{ lexicon: "x".repeat(4097) },
		{ rules: [] },
		{ rules: { extra: {} } },
		{ rules: { dashes: { enabled: "yes" } } },
		{ rules: { dashes: { limit: 1.5 } } },
		{ rules: { dashes: { perHundred: 1 } } },
		{ rules: { phrases: { addPhrases: [""] } } },
		{ rules: { phrases: { removePhrases: ["x".repeat(121)] } } },
		{ rules: { coinages: { allow: Array(129).fill("word") } } },
		{ rules: { codeSpans: { minWords: -1 } } },
		{ rules: { codeSpans: { perHundred: -1 } } },
		{ rules: { processNarration: { limit: 0 } } },
		{ rules: { processNarration: { share: 1.1 } } },
	]) {
		assert.notEqual(invalidCheckField(value), undefined, JSON.stringify(value));
		assert.equal(schema.check(value), false, JSON.stringify(value));
	}

	const conflictingRate = { rules: { codeSpans: { limit: 1, perHundred: 2 } } };
	assert.equal(schema.check(conflictingRate), true);
	assert.equal(invalidCheckField(conflictingRate), "checksRules.rules.codeSpans.limit");
});

test("dash checks catch clause punctuation and leave ranges and list markers alone", () => {
	const source =
		"The roof holds — the walls are dry.\nThe roof holds – the walls are dry.\nThe roof holds - the walls are dry.\nThe roof holds--the walls are dry.";
	const [finding] = checkWriting(source);
	assert.equal(finding.rule, "dashes");
	assert.equal(finding.count, 4);
	assert.equal(finding.limit, 0);
	assert.deepEqual(
		finding.examples.map((entry) => entry.line),
		[1, 2, 3, 4],
	);
	assert.deepEqual(rules("- Read pages 3-5.\n- Read the results."), []);
});
test("an en dash beside code is a range only between range ends; dash excerpts quote the source", () => {
	assert.deepEqual(rules("The logs cover `2026-11-13`–`2026-11-22` and (`v1.2` – `v1.4`)."), []);
	assert.deepEqual(rules("The window is (`2026-10-23T09:25:00Z`–\n`2026-11-22T09:25:00Z`)."), []);
	for (const clause of [
		"Read `2026-11-13`–the archive.",
		"Upgrade to `1.6.0` – it fixes the leak.",
		"The patch is small – `2` files change.",
		"Merge `main`–`release` first.",
	])
		assert.deepEqual(rules(clause), ["dashes"], clause);
	const [finding] = checkWriting("Use the `main` branch – it is current – for `release`.");
	assert.equal(finding.rule, "dashes");
	assert.equal(finding.count, 2);
	assert.match(finding.examples[0].text, /^Use the `main` branch – it is current/u);
	const [continued] = checkWriting("The display opens\n    - it is current.");
	assert.deepEqual(continued.examples, [{ line: 2, text: "The display opens - it is current." }]);
	const [linked] = checkWriting(
		"See [the guide](https://example.com/a/very/long/path/to/the/guide.html) – it covers setup.",
	);
	assert.equal(linked.examples[0].text, "See [the guide – it covers setup.");
});
test("en dashes next to a digit, month name or present mark ranges", () => {
	assert.deepEqual(rules("3–5. February 2021 – present. Apr. – May. May–June. Monday – 3 October. Jan – present."), []);
	const [finding] = checkWriting("3—5. May — June. Monday – Tuesday. The display – now opens.");
	assert.equal(finding?.rule, "dashes");
	assert.equal(finding.count, 4);
	assert.deepEqual(rules("Displays – newer models only. Now – present-day details follow."), ["dashes"]);
});
test("literal newline and tab escapes count only outside code", () => {
	assert.deepEqual(rules(String.raw`The roof holds.\nThe walls are dry.\r\tYes.`), ["escapedBreaks"]);
	assert.deepEqual(rules("The pattern `\\n` denotes a line break.\n\tThe next line starts here."), []);
});
test("phrases match without case distinctions, at boundaries, with replace, removal and addition", () => {
	assert.deepEqual(rules("The house is dry. FRANKLY, I expected rain."), ["phrases"]);
	assert.deepEqual(rules("The author borrows from Honestlyish."), []);
	const overrides = {
		rules: { phrases: { phrases: ["bright star"], removePhrases: ["BRIGHT STAR"], addPhrases: ["dark sky"] } },
	};
	const findings = checkWriting("Frankly, look at the bright star in the dark\nsky.", overrides);
	assert.deepEqual(
		findings.map((finding) => [finding.rule, finding.count, finding.examples[0].line]),
		[["phrases", 1, 1]],
	);
});
test("the prose projection skips quoted and executable material, preserves link labels", () => {
	const source = [
		"---",
		"title: Honestly — a title",
		"---",
		"# The house is dry",
		"",
		"> Honestly — a quote",
		"A lazy continuation — of the quote.",
		"",
		"<!-- honestly —",
		"also frankly — -->",
		"",
		"```markdown",
		"Honestly — a fence",
		"```",
		"",
		"    Honestly — indented code",
		"",
		"Read [`frankly —`](<https://example.test/—>) and [the plan](/tmp/—).",
		"",
		"[other]: <https://example.test/honestly—>",
		"",
	].join("\n");
	assert.deepEqual(rules(source), []);
	assert.deepEqual(rules(`${source}\nRead the [honestly useful plan](/tmp/project).`), ["phrases"]);
});
test("indented code inside a list item is not prose", () => {
	assert.deepEqual(rules('-     echo "Hello — world"'), []);
	assert.deepEqual(rules('1.     echo "Hello — world"'), []);
	assert.deepEqual(rules('-\t\techo "Hello — world"'), []);
	assert.deepEqual(rules('-     echo "Hello — world"\n      echo "Goodbye — world"'), []);
	assert.deepEqual(rules('-    echo "Hello — world"'), ["dashes"]);
	assert.deepEqual(rules('-\techo "Hello — world"'), ["dashes"]);
	const findings = checkWriting("-     ```\n      Only code — here.\n\n  Check the prose — here.");
	assert.deepEqual(
		findings.map(({ rule, examples }) => [rule, examples[0].line]),
		[["dashes", 4]],
	);
});
test("label lines count list and inline-code labels, not tables or headings", () => {
	const prefix = "# Heading: not a label\n\n| Name | Value |\n| --- | --- |\n| Name: | Value |\n\nThe roof holds.\n\n";
	const labels = "**Water:** None.\n- **Roof**: Dry.\n- *Walls:* Dry.\n- `paint`: Green.\nPlain label: Present.";
	const [finding] = checkWriting(prefix + labels, { rules: { labelLines: { limit: 3 } } });
	assert.equal(finding.rule, "labelLines");
	assert.equal(finding.count, 5);
	assert.deepEqual(rules(`${prefix}Three labels:\n- **Roof**: Dry.\n- \`paint\`: Green.`), []);
	assert.deepEqual(rules("| Name | Value |\n| --- | --- |\n| Honestly — yes | Value |"), ["dashes", "phrases"]);
});
test("coinages count distinct alphabetic compounds and honour all allow lists", () => {
	const text =
		"The well-known firm bought a thought-engine, a context-pump and a reason-meter. That REASON-METER was the first one.";
	const [finding] = checkWriting(`A hands-on guide to three-part and one-letter names. ${text}`, {
		rules: { coinages: { limit: 2 } },
	});
	assert.equal(finding.rule, "coinages");
	assert.equal(finding.count, 3);
	assert.deepEqual(
		finding.examples.map((item) => item.text),
		["thought-engine", "context-pump", "reason-meter"],
	);
	assert.deepEqual(checkWriting(text, { rules: { coinages: { limit: 2, allow: ["Reason-Meter"] } } }), []);
	assert.deepEqual(checkWriting(text, { rules: { coinages: { limit: 2 } } }, new Set(["context-pump"])), []);
});
const coined = (text: string) =>
	checkWriting(text, { rules: { coinages: { limit: 0 } } })
		.find((finding) => finding.rule === "coinages")
		?.examples.map((item) => item.text) ?? [];
test("coinages leave out prefixed words, phrasal and set phrases, established compounds and exact names", () => {
	assert.deepEqual(
		coined(
			"A non-agent tool re-reads the pre-existing file per-session, and a multi-step job runs mid-run. The top-level, half-open and in-memory ranges are fine.",
		),
		[],
	);
	assert.deepEqual(
		coined(
			"Read the files end-to-end, step-by-step and out-of-order. Use a test-only, machine-wide, code-like setting. The check-ins, carve-outs and trade-offs stay.",
		),
		[],
	);
	assert.deepEqual(
		coined(
			"The gateway forwards x-origin-path and x-request-id to google-vertex/gemini-4-neon. The bounds.rg-search-uncapped rule, php-fpm.conf and Command-K stay.",
		),
		[],
	);
	assert.deepEqual(coined("Restart php-fpm after the change.\n\n```sh\nsystemctl restart php-fpm\n```"), []);
	assert.deepEqual(coined("Run `systemctl restart cert-manager`, then check that cert-manager renews."), []);
	assert.deepEqual(coined("Restart php-fpm after the change."), ["php-fpm"]);
});
test("coinages count coined, capitalised and buzzword compounds, even beside one span of the term", () => {
	assert.deepEqual(coined("The `cert-manager` controller renews cert-manager certificates."), ["cert-manager"]);
	assert.deepEqual(coined("Each pure-core/thin-adapter split adds a WARM-SAFE marker and a non-agent-owned path."), [
		"pure-core",
		"thin-adapter",
		"WARM-SAFE",
		"non-agent-owned",
	]);
	assert.deepEqual(coined("# Agent-Slice Design\n\nThe Agent-Slice holds high-leverage, context-aware state."), [
		"Agent-Slice",
		"high-leverage",
		"context-aware",
	]);
	assert.deepEqual(
		coined(
			"The Pure-Core pattern feeds an AI-powered, self-healing, friction-free and next-level agent-as-a-service that makes word-for-word, jargon-y copies of doctrine-out steps.",
		),
		[
			"Pure-Core",
			"AI-powered",
			"self-healing",
			"friction-free",
			"next-level",
			"agent-as-a-service",
			"word-for-word",
			"jargon-y",
			"doctrine-out",
		],
	);
	assert.deepEqual(coined("The thought-engine/2 split runs on google-vertex/gemini-4-neon and php-fpm:8.2."), [
		"thought-engine",
	]);
	assert.deepEqual(coined("We dropped the ~~thought-engine~~ idea. The reason-meter[^1] feeds it."), [
		"thought-engine",
		"reason-meter",
	]);
	const glossary = `| Term |\n| --- |\n${"| `day-file` |\n"}\nThe day-file holds the work.`;
	assert.deepEqual(coined(glossary), ["day-file"]);
});
test("technical identifiers must be bare; date, relative path, words and links do not count", () => {
	const prose =
		"Entry f7ac8123 and commit af45123 refer to /tmp/one from ~/tmp/two. The ID is 12345678-abcd-1234-abcd-123456789abc.";
	const [finding] = checkWriting(prose, { rules: { identifiers: { limit: 3 } } });
	assert.equal(finding.rule, "identifiers");
	assert.equal(finding.count, 5);
	assert.deepEqual(
		rules("Commit `af45123` went to `entries`. The path is ./tmp/one or relative/path. Add 2026-11-18 and abcdefad."),
		[],
	);
});
test("inline code uses a strict density threshold and minimum word count", () => {
	const code = "`roof` ".repeat(19);
	assert.deepEqual(rules("Dry ".repeat(150) + code), ["codeSpans"]);
	assert.deepEqual(rules("Dry ".repeat(149) + code), []);
	assert.deepEqual(rules("Dry ".repeat(150) + "`roof` ".repeat(18)), []);
});
test("inline code density counts names in running prose, not data values, tables or headings", () => {
	const prose = "Dry ".repeat(150);
	const values =
		"`2026-10-23T09:25:00Z` `90/402` `22.4%` `v1.6.0` `1.6.0-rc.1` `$4282.74` `16 KiB` `10 KB/s` `1,447 ms` `3 µs` `≈ 2 ms` `>= 3` `1h30m` `4K` `+10:00` `14:00 UTC` `22 Nov 2026` ".repeat(
			3,
		);
	assert.deepEqual(rules(prose + values), []);
	const table = `| Name | Path |\n| --- | --- |\n${"| `roof` | `tile` |\n".repeat(20)}`;
	assert.deepEqual(rules(`# The \`roof\` and \`tile\`\n\n${prose}\n\n${table}`), []);
	assert.deepEqual(rules(`${prose}${"`7d9aadde5` ".repeat(19)}`), ["codeSpans"]);
	assert.deepEqual(rules(`${prose}${"`1234567d` ".repeat(19)}`), ["codeSpans"]);
});
test("a finding lists every flagged passage up to a bound, grouped by source line", () => {
	const source = Array.from({ length: MAX_EXAMPLES + 5 }, (_, index) => `**Label ${index}:** Value.`).join("\n\n");
	const [finding] = checkWriting(source);
	assert.equal(finding.rule, "labelLines");
	assert.equal(finding.count, MAX_EXAMPLES + 5);
	assert.equal(finding.examples.length, MAX_EXAMPLES);
	const [summary, repair] = describeFindings([finding], true);
	assert.match(summary, /^Label lines: 45 found\. Limit: 8\. Line 1: "\*\*Label 0:\*\*"\. Line 3: /u);
	assert.match(summary, /5 more not listed\.$/u);
	assert.match(repair, /as a sentence/u);
	const [compounds] = describeFindings(
		checkWriting("A thought-engine and a reason-meter.\nA day-file.", { rules: { coinages: { limit: 1 } } }),
		true,
	);
	assert.equal(
		compounds,
		'Unlisted compounds: 3 found. Limit: 1. Line 1: "thought-engine", "reason-meter". Line 2: "day-file".',
	);
	const [spans] = checkWriting(
		`${"Dry ".repeat(200)}${Array.from({ length: 60 }, (_, index) => `\`name${index}\``).join(" ")}`,
	);
	assert.equal(spans.rule, "codeSpans");
	assert.equal(spans.unlisted, 20);
	assert.match(
		describeFindings([spans], false)[0],
		/^Inline code spans: 30 found per 100 words of prose\. .+ 20 more not listed\.$/u,
	);
});
test("process narration requires both a minimum sentence count and share", () => {
	const text = "The roof is dry. I checked it. We ran a probe. Checks passed. I read the report.";
	assert.deepEqual(rules(text), ["processNarration"]);
	assert.deepEqual(rules(text + " The roof is dry.".repeat(50)), []);
	assert.deepEqual(rules("The roof is dry. I checked it."), []);
});
test("past-tense bullets and verification lines count once per line", () => {
	const text = [
		"The roof is dry.",
		"",
		"- Checked the tiles.",
		"- Ran the probe. Lint clean.",
		"- The board says 9/9 and all green.",
		"- Then 9 tests, 0 failures, typecheck clean.",
		"- The card says checks pass.",
		"- The first probe passed.",
		"",
		"Read the results here.",
	].join("\n");
	const [finding] = checkWriting(text);
	assert.equal(finding.rule, "processNarration");
	assert.equal(finding.count, 6);
	assert.deepEqual(
		finding.examples.map((example) => example.line),
		[3, 4, 5, 6, 7, 8],
	);
	assert.deepEqual(rules("The date is 13/12/2026. Read the checks. Read the results."), []);
	assert.deepEqual(
		rules("The window shows 90/402 failed calls.\nIt had 42/351 schema errors.\nPi 0.84.4/0.84.2 is old."),
		[],
	);
	assert.deepEqual(rules("The roof is dry.\nThe board says 9/9.\nThe suite says 130/130."), ["processNarration"]);
	assert.deepEqual(rules("The roof is dry.\nThe suite reports 129/130 pass.\nUnit tests: 412/415."), [
		"processNarration",
	]);
});
test("ordinary past-tense verbs are not verification records", () => {
	assert.deepEqual(rules("The bill passed in June.\nThe delegation passed through Kyoto."), []);
	assert.deepEqual(rules("The tests passed.\nThe checks passed."), ["processNarration", "opening"]);
	assert.deepEqual(rules("The build passed.\nThe first probe passed."), ["processNarration", "opening"]);
	assert.deepEqual(rules("The lint passed.\nThe typecheck passed."), ["processNarration", "opening"]);
});
test("only the first prose paragraph triggers opening, including a verification record", () => {
	assert.deepEqual(rules("# Roof\n\n> The house is dry.\n\n**This report** describes the roof."), ["opening"]);
	assert.deepEqual(rules("## Roof\n\nI inspected the roof."), ["opening"]);
	assert.deepEqual(rules("## Roof\n\nAll tests pass."), ["opening"]);
	assert.deepEqual(rules("The roof is dry.\n\nThis report describes the walls."), []);
});
test("contrast frames count distinct sentences, ordinary negations pass", () => {
	const text =
		"The roof is not grey, but green. This isn't paint, it's tile. It is not damp; it is dry. Rather than spend more, take the bus.";
	assert.deepEqual(rules(text, { rules: { negations: { limit: 2 } } }), ["negations"]);
	assert.deepEqual(rules("The roof is not damp. We did not need a probe. Leave it shut rather than open it."), []);
});

test("bold lead-ins that end with a period count as label lines", () => {
	const source = [
		"# Title",
		"",
		"- **Months.** The data covers six months.",
		"- **Cost.** It cost little.",
		"",
		"**This whole line is emphasis.**",
		"",
	].join("\n");
	const findings = checkWriting(source, { rules: { labelLines: { limit: 1 } } });
	const labels = findings.find((finding) => finding.rule === "labelLines");
	assert.equal(labels?.count, 2);
});

test("the machine document supplies bounded configuration, with environment precedence and named errors", async () => {
	const root = await mkdtemp(join(tmpdir(), "writing-config-"));
	try {
		const file = join(root, "harness.json");
		await writeFile(
			file,
			JSON.stringify({
				version: 1,
				markdown: {
					checks: "warn",
					checksRules: {
						rules: { opening: { enabled: false }, codeSpans: { perHundred: 9, minWords: 200 } },
						lexicon: "words.txt",
					},
				},
			}),
		);
		await writeFile(join(root, "words.txt"), "some-term\nrare-term\n");
		const options = writingOptions(root, readSettings({ agentDir: root, env: {} }));
		assert.equal(options.mode, "warn");
		assert.deepEqual(await loadLexicon(options), new Set(["some-term", "rare-term"]));
		assert.equal(await loadReader(options), undefined);
		const summary = describeRules(options.mode, options.overrides).join("\n");
		assert.match(summary, /^Publication reports where a document breaks these writing rules/u);
		assert.match(summary, /inline code only for text the reader must type/u);
		assert.doesNotMatch(summary, /description of the document/u);
		const bad = readSettings({
			agentDir: root,
			env: { PI_MARKDOWN_CHECKS_RULES: '{"rules":{"processNarration":{"share":2}}}' },
		});
		assert.equal(bad.checksIssue, "PI_MARKDOWN_CHECKS_RULES: markdown.checksRules.rules.processNarration.share");
		assert.equal(bad.records.find((record) => record.key === "checksRules")?.status, "invalid");
		await writeFile(file, '{"version":1,"markdown":{"checksRules":{"rules":{"dashes":{"limit":"none"}}}}}');
		await assert.rejects(
			loadLexicon(writingOptions(root, readSettings({ agentDir: root, env: {} }))),
			/harness\.json: markdown\.checksRules\.rules\.dashes\.limit/u,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
