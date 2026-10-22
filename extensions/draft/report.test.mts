// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { renderText, useColor } from "./scripts/report.mts";
import { filler, run } from "./scripts/test-kit.mts";

test("useColor needs a terminal and respects NO_COLOR and dumb terminals", () => {
	assert.equal(useColor({}, true), true);
	assert.equal(useColor({}, false), false);
	assert.equal(useColor({ NO_COLOR: "1" }, true), false);
	assert.equal(useColor({ NO_COLOR: "" }, true), true);
	assert.equal(useColor({ TERM: "dumb" }, true), false);
});

test("text output lists findings with positions and ends with the score", () => {
	const report = run(`${filler(60)}\n\nA dash \u2014 here.\n`);
	const text = renderText(report, { verbose: false, quiet: false, color: false });
	assert.match(text, /Hard findings \(1\)/);
	assert.match(text, /\d+:\d+\s{2}punctuation\.em-dash/);
	assert.match(text, /Score: SQ [\d.]+, band green/);
	assert.ok(!text.includes("\u001B["));
});

test("colour wraps only the band and only when asked", () => {
	const report = run(filler(80));
	const text = renderText(report, { verbose: false, quiet: false, color: true });
	assert.match(text, /\u001B\[32mgreen\u001B\[0m/);
});

test("quiet output is one line and verbose output adds component metrics", () => {
	const report = run(filler(80));
	assert.equal(renderText(report, { verbose: false, quiet: true, color: false }).trim().split("\n").length, 1);
	assert.match(renderText(report, { verbose: true, quiet: false, color: false }), /lexical: \{/);
});

test("a short text says no band is given", () => {
	const text = renderText(run("Frankly, no."), { verbose: false, quiet: false, color: false });
	assert.match(text, /band unavailable/);
});

test("omitted findings are named", () => {
	const text = renderText(run(Array.from({ length: 60 }, () => "A dash \u2014 here.").join("\n\n")), {
		verbose: false,
		quiet: false,
		color: false,
	});
	assert.match(text, /Omitted beyond 50 per rule: punctuation\.em-dash 10/);
});
