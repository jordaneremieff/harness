import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	BAND_CRITICAL_PERCENT,
	BAND_WARNING_PERCENT,
	bandTone,
	buildBar,
	composeLine1,
	composeLine2,
	formatDuration,
	formatTokens,
	folderLabel,
	hitRatePercent,
	sanitizeDisplay,
	type Line1Parts,
} from "./format.ts";

/** Plain colorizer: no escapes, so visibleWidth equals string length. */
const plain = (_color: string, text: string) => text;

/** Recording colorizer: tags each call so tests can assert the tone used. */
function recording() {
	const calls: { color: string; text: string }[] = [];
	const fg = (color: string, text: string) => {
		calls.push({ color, text });
		return text;
	};
	return { calls, fg };
}

const MIN = 60_000;

describe("formatTokens", () => {
	it("formats across the k/M boundaries", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(1000), "1.0k");
		assert.equal(formatTokens(9_500), "9.5k");
		assert.equal(formatTokens(42_000), "42k");
		assert.equal(formatTokens(999_499), "999k");
		assert.equal(formatTokens(1_000_000), "1.0M");
		assert.equal(formatTokens(1_234_567), "1.2M");
		assert.equal(formatTokens(10_000_000), "10M");
	});
});

describe("formatDuration", () => {
	it("formats seconds, minutes, and hours", () => {
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(45_000), "45s");
		assert.equal(formatDuration(60_000), "1m");
		assert.equal(formatDuration(12 * MIN), "12m");
		assert.equal(formatDuration(60 * MIN), "1h0m");
		assert.equal(formatDuration(65 * MIN), "1h5m");
	});
});

describe("bandTone", () => {
	it("follows the documented ramp bands", () => {
		assert.equal(bandTone(0), "success");
		assert.equal(bandTone(BAND_WARNING_PERCENT), "success");
		assert.equal(bandTone(BAND_WARNING_PERCENT + 1), "warning");
		assert.equal(bandTone(BAND_CRITICAL_PERCENT), "warning");
		assert.equal(bandTone(BAND_CRITICAL_PERCENT + 1), "error");
	});
});

describe("buildBar", () => {
	it("fills cells proportionally and labels with the clamped percent", () => {
		const { calls, fg } = recording();
		const bar = buildBar(50, fg);
		assert.equal(visibleWidth(bar), 14); // 10 cells + space + "50%"
		// The space between bar and label sits outside the colored spans.
		assert.deepEqual(
			calls.map((c) => c.text).join(""),
			"█████░░░░░50%",
		);
		assert.equal(calls[0].color, "success");
		assert.equal(calls[1].color, "dim");
	});
	it("colors the filled cells and label by band", () => {
		const warn = recording();
		warn.fg && buildBar(70, warn.fg);
		assert.equal(warn.calls[0].color, "warning");
		assert.equal(warn.calls[2].color, "warning");
		const crit = recording();
		buildBar(90, crit.fg);
		assert.equal(crit.calls[0].color, "error");
		assert.equal(crit.calls[2].color, "error");
	});
	it("handles empty and full bars", () => {
		assert.equal(visibleWidth(buildBar(0, plain)), 13); // cells + space + "0%"
		assert.equal(visibleWidth(buildBar(100, plain)), 15); // cells + space + "100%"
		const { calls, fg } = recording();
		buildBar(0, fg);
		assert.equal(calls[0].text, "");
		assert.equal(calls[1].text, "░".repeat(10));
	});
});

describe("hitRatePercent", () => {
	it("is null before any usage and rounds the share otherwise", () => {
		assert.equal(hitRatePercent(0, 0, 0), null);
		assert.equal(hitRatePercent(80, 10, 10), 80);
		assert.equal(hitRatePercent(1, 0, 2), 33);
	});
});

describe("sanitizeDisplay", () => {
	it("strips control characters, collapses whitespace, trims", () => {
		assert.equal(sanitizeDisplay("alpha\nbeta\tgamma"), "alpha beta gamma");
		assert.equal(sanitizeDisplay("  pad  ed  "), "pad ed");
		const hostile = "\x1b[31mred\x1b[0m \x07";
		const clean = sanitizeDisplay(hostile);
		assert.ok(!clean.includes("\x1b"), "escape stripped");
		assert.ok(!clean.includes("\n"));
		assert.equal(clean, "[31mred [0m");
	});
});

describe("folderLabel", () => {
	it("abbreviates paths under home and passes others through", () => {
		assert.equal(folderLabel("/Users/x/work/app", "/Users/x"), "~/work/app");
		assert.equal(folderLabel("/Users/x", "/Users/x"), "~");
		assert.equal(folderLabel("/opt/tool", "/Users/x"), "/opt/tool");
		assert.equal(folderLabel("/Users/x2/other", "/Users/x"), "/Users/x2/other");
		assert.equal(folderLabel("/work/app", undefined), "/work/app");
	});
});

function parts(over: Partial<Line1Parts> = {}): Line1Parts {
	return {
		model: "Model",
		contextBar: "█████░░░░░ 50%",
		tokens: "42k/200k",
		cost: "~$1.23",
		duration: "12m",
		cacheDot: "●",
		cacheRate: "94% hit",
		...over,
	};
}

describe("composeLine1", () => {
	it("joins everything with the separator when it fits", () => {
		const line = composeLine1(parts(), " | ", 200, visibleWidth);
		assert.equal(line, "Model | █████░░░░░ 50% | 42k/200k | ~$1.23 | 12m | ● 94% hit");
	});
	it("sheds in the documented order as width tightens", () => {
		const p = parts();
		// Each width below isolates one shed step.
		const seq: string[] = [];
		for (const width of [59, 51, 47, 41, 30]) {
			seq.push(composeLine1(p, " | ", width, visibleWidth));
		}
		assert.equal(seq[0], "Model | █████░░░░░ 50% | 42k/200k | ~$1.23 | 12m | ●");
		assert.equal(seq[1], "Model | █████░░░░░ 50% | 42k/200k | ~$1.23 | 12m");
		assert.equal(seq[2], "Model | █████░░░░░ 50% | 42k/200k | ~$1.23");
		assert.equal(seq[3], "Model | █████░░░░░ 50% | ~$1.23");
		assert.equal(seq[4], "Model | █████░░░░░ 50%");
	});
	it("never sheds model or context bar", () => {
		const line = composeLine1(parts(), " | ", 5, visibleWidth);
		assert.equal(line, "Model | █████░░░░░ 50%");
	});
	it("omits absent segments cleanly", () => {
		const line = composeLine1({ model: "M" }, " | ", 200, visibleWidth);
		assert.equal(line, "M");
	});
});

describe("composeLine2", () => {
	it("drops statuses from the right and keeps the project label", () => {
		const statuses = ["one", "two", "three"];
		assert.equal(
			composeLine2("~/app (main)", statuses, " | ", 200, visibleWidth),
			"~/app (main) | one | two | three",
		);
		assert.equal(
			composeLine2("~/app (main)", statuses, " | ", 31, visibleWidth),
			"~/app (main) | one | two",
		);
		assert.equal(composeLine2("~/app (main)", statuses, " | ", 15, visibleWidth), "~/app (main)");
		assert.equal(composeLine2("~/app (main)", [], " | ", 200, visibleWidth), "~/app (main)");
	});
});
