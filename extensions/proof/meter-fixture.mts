/**
 * Stand-in prose meter for tests. It implements the report contract and picks
 * its behaviour from a marker word in the text on standard input. When
 * PI_PROOF_TEST_LOG names a file, each run appends one line to it.
 */
import { appendFileSync } from "node:fs";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const text = Buffer.concat(chunks).toString("utf8");
if (process.env.PI_PROOF_TEST_LOG) appendFileSync(process.env.PI_PROOF_TEST_LOG, `${text.length}\n`);

function report(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		contract: 1,
		meterVersion: "fixture",
		input: { kind: "md", words: 10, sentences: 1, lines: 1 },
		hard: [],
		scored: [],
		score: { sq: 10, band: "green", reliable: true, threshold: 40, components: {} },
		calibration: { cohort: "fixture cohort", n: 12, date: "2026-01-01", status: "calibrated" },
		omitted: { hard: 0, scored: 0, perRuleCap: 5, byRule: {}, skippedFiles: [] },
		...over,
	});
}

if (text.includes("EXIT4")) {
	process.stderr.write("usage: bad input\n");
	process.exit(4);
}
if (text.includes("EXIT9")) process.exit(9);
if (text.includes("NOTJSON")) {
	process.stdout.write("not json at all");
	process.exit(0);
}
if (text.includes("BADCONTRACT")) {
	process.stdout.write(report({ contract: 2 }));
	process.exit(0);
}
if (text.includes("HANG")) {
	if (process.env.PI_PROOF_TEST_LOG) appendFileSync(process.env.PI_PROOF_TEST_LOG, `pid ${process.pid}\n`);
	setInterval(() => {}, 1000);
} else if (text.includes("HARD")) {
	process.stdout.write(
		report({
			hard: [{ rule: "punctuation.em-dash", severity: "hard", line: 2, column: 1, text: "x", message: "Em dash found" }],
		}),
	);
	process.exit(1);
} else if (text.includes("AMBER")) {
	process.stdout.write(
		report({
			scored: [{ rule: "lexical.filler", severity: "scored", line: 1, text: "x", message: "Filler phrase" }],
			score: { sq: 55, band: "amber", reliable: true, threshold: 70, components: {} },
		}),
	);
	process.exit(0);
} else if (text.includes("SHORT2") || text.includes("SHORT1")) {
	const scored = [1, 2].slice(0, text.includes("SHORT2") ? 2 : 1).map((line) => ({
		rule: "lexical.filler",
		severity: "scored",
		line,
		text: "x",
		message: "Filler phrase",
	}));
	process.stdout.write(report({ scored, score: { sq: 30, band: null, reliable: false, threshold: 70, components: {} } }));
	process.exit(0);
} else if (text.includes("UNRELIABLE")) {
	process.stdout.write(report({ score: { sq: 90, band: null, reliable: false, threshold: 70, components: {} } }));
	process.exit(0);
} else {
	process.stdout.write(report());
	process.exit(0);
}
