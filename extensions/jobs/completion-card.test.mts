import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	CustomMessageComponent,
	initTheme,
	type MessageRenderOptions,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	completionContent,
	JOB_COMPLETION_MESSAGE,
	type CompletionJob,
	type JobCompletionDetails,
} from "./completion.ts";
import { completionHeader, renderJobCompletionMessage } from "./completion-card.ts";

const colors: Array<{ color: string; value: string }> = [];
const theme = {
	fg: (color: string, value: string) => {
		colors.push({ color, value });
		return value;
	},
	bg: (_color: string, value: string) => value,
	bold: (value: string) => value,
	getBgAnsi: () => "",
} as unknown as Theme;

/** A theme whose colours are visible escape codes, so a test can check what each row keeps. */
const ansiTheme = {
	fg: (_color: string, value: string) => `\x1b[38;5;1m${value}\x1b[39m`,
	bg: (_color: string, value: string) => `\x1b[48;5;2m${value}\x1b[49m`,
	bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
	getBgAnsi: () => "\x1b[48;5;2m",
} as unknown as Theme;

function options(expanded: boolean, key = "ctrl+o"): MessageRenderOptions {
	return {
		expanded,
		outputPad: 1,
		keyText: () => key,
		keyHint: (_binding: string, description: string) => `${key} ${description}`,
	} as unknown as MessageRenderOptions;
}

function job(overrides: Partial<CompletionJob> = {}): CompletionJob {
	return {
		id: "7",
		status: "succeeded",
		startedAt: 1_000,
		endedAt: 11_000,
		exitCode: 0,
		cancellationRequested: false,
		cwd: "/work/harness",
		...overrides,
	} as CompletionJob;
}

function details(
	overrides: Partial<CompletionJob> = {},
	text = "line 1\nline 2\nline 3\nline 4",
	outputBytes = 28,
): JobCompletionDetails {
	return { job: job(overrides), command: "npm test", tail: { text, omitted: false, outputBytes } };
}

function message(value: JobCompletionDetails, content = completionContent(value)) {
	return {
		role: "custom" as const,
		customType: JOB_COMPLETION_MESSAGE,
		display: true,
		timestamp: 0,
		content,
		details: value,
	};
}

function render(value: JobCompletionDetails, expanded = false, key = "ctrl+o", width = 80): string[] {
	const component = renderJobCompletionMessage(message(value), options(expanded, key), theme);
	assert.ok(component);
	return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

test("the header reports the known full identity, outcome, exit code, duration and command", () => {
	assert.deepEqual(completionHeader(details()), {
		label: "Job 7 succeeded",
		facts: ["exit 0", "10.0s", "command preview: npm test"],
	});
	assert.deepEqual(completionHeader(details({ status: "failed", exitCode: 2, endedAt: 3_500 })), {
		label: "Job 7 failed",
		facts: ["exit 2", "2.5s", "command preview: npm test"],
	});
	assert.deepEqual(completionHeader(details({ status: "timed_out", exitCode: null, endedAt: 91_000 })), {
		label: "Job 7 timed out",
		facts: ["1m 30s", "command preview: npm test"],
	});
	assert.deepEqual(completionHeader(details({ status: "lost", exitCode: undefined, endedAt: undefined })), {
		label: "Job 7 lost",
		facts: ["command preview: npm test"],
	});
	assert.deepEqual(completionHeader({ job: { id: "7", status: "running", exitCode: NaN } }), {
		label: "Completion notice for job 7",
		facts: [],
	});
	assert.deepEqual(completionHeader({ job: { status: "failed" } }), { label: "Job failed", facts: [] });
	assert.deepEqual(completionHeader(undefined), { label: "Completion notice", facts: [] });
	assert.deepEqual(
		render({ ...details(), job: {} as CompletionJob, command: "" }).slice(1, 3),
		[" [jobs] Completion notice", ""],
		"no facts, no second line",
	);
});

test("the label has its own colour, the title and body use the message colour, and the facts stay muted", () => {
	colors.length = 0;
	render(details());
	assert.ok(colors.some(({ color, value }) => color === "customMessageLabel" && value === "[jobs]"));
	assert.ok(colors.some(({ color, value }) => color === "customMessageText" && value === "Job 7 succeeded"));
	assert.ok(
		colors.some(({ color, value }) => color === "muted" && value === "exit 0 · 10.0s · command preview: npm test"),
	);
	assert.ok(colors.some(({ color, value }) => color === "customMessageText" && value === "line 4"));
});

test("a collapsed receipt summary shows the last output lines and an uncounted hint", () => {
	const lines = render(details());
	assert.equal(lines[0], "");
	assert.deepEqual(lines.slice(4, 7), [" line 2", " line 3", " line 4"]);
	assert.equal(lines[7], " ... (ctrl+o to expand)");
	assert.equal(lines[8], "");
	assert.equal(lines.length, 9);
	assert.equal(render(details(), false, "")[7], " ... (click to expand)");
});

test("the count covers only hidden visual rows of the same body", () => {
	const value = details({}, `${"x".repeat(55)}\nsecond\nthird\nfourth`);
	const card = renderJobCompletionMessage(message(value, value.tail.text), options(false), theme);
	assert.ok(card);
	assert.deepEqual(
		card
			.render(80)
			.slice(4, 8)
			.map((row) => row.trim()),
		["second", "third", "fourth", "... (1 more line, ctrl+o to expand)"],
	);
	assert.equal(card.render(42).at(-2)?.trim(), "... (2 more lines, ctrl+o to expand)");
	const complete = details({}, "only output");
	const short = renderJobCompletionMessage(message(complete, complete.tail.text), options(false), theme);
	assert.ok(short);
	assert.doesNotMatch(short.render(80).join("\n"), /to expand/u);

	const fallback = renderJobCompletionMessage(
		{ ...message(value, "\nfirst meaningful line\nsecond line"), details: undefined },
		options(false),
		theme,
	);
	assert.ok(fallback);
	assert.deepEqual(
		fallback
			.render(80)
			.slice(1, -1)
			.map((row) => row.trim()),
		["[jobs] Completion notice", "", "first meaningful line", "... (1 more line, ctrl+o to expand)"],
	);
});

test("the preview reports earlier output outside the completion without counting it", () => {
	const value = details();
	value.tail.omitted = true;
	assert.deepEqual(render(value).slice(-3, -1), [" [Excerpt: earlier output omitted]", " ... (ctrl+o to expand)"]);
	assert.match(render(value, true).join("\n"), /read the retained tail/u);
});

test("the preview wraps errors and outcomes as prose and stays within three visual lines", () => {
	assert.deepEqual(render(details({ status: "failed", exitCode: null, error: "spawn failed" }, "", 0)).slice(4, 6), [
		" spawn failed",
		" No output.",
	]);
	assert.deepEqual(render(details({ status: "lost", exitCode: undefined, endedAt: undefined }, "", 0)).slice(1, 5), [
		" [jobs] Job 7 lost",
		" command preview: npm test",
		"",
		" Output is unavailable after host loss.",
	]);
	const error = `The backend stopped ${"because a resource was unavailable ".repeat(6)}END`;
	const lines = render(details({ status: "failed", exitCode: 1, error }), false, "ctrl+o", 40);
	const body = lines.slice(4, -1);
	assert.equal(body.length, 4, "three body lines and the hint");
	assert.ok(
		body.slice(0, 3).every((line) => !line.endsWith("…")),
		"prose wraps at word boundaries",
	);
	assert.doesNotMatch(body.join("\n"), /END/u);
});

test("long output lines and facts clip with one ellipsis and keep the row background", () => {
	const long = details({}, `short\n${"x".repeat(200)}`, 210);
	const lines = render({ ...long, command: `npm test ${"-- extensions/jobs ".repeat(10)}` }, false, "ctrl+o", 64);
	assert.match(lines[2] ?? "", /^ exit 0 · 10\.0s · command preview: npm test .*…$/u);
	assert.match(lines[5] ?? "", /^ x+…$/u);
	assert.doesNotMatch(lines.join("\n"), /\.\.\.(?! \()/u, "clipped rows end in … rather than ...");
	const component = renderJobCompletionMessage(message(long), options(false), ansiTheme);
	assert.ok(component);
	for (const row of component.render(30)) {
		assert.equal(visibleWidth(row), 30);
		assert.ok(row.startsWith("\x1b[48;5;2m"), "each row starts on the message background");
		assert.doesNotMatch(row, /\x1b\[0m(?!\x1b\[48;5;2m)/u, "a reset never ends the background inside the row");
	}
	const clipped = component.render(30).find((row) => stripVTControlCharacters(row).includes("x…")) ?? "";
	assert.match(
		clipped,
		/\x1b\[38;5;1mx+…\x1b\[[\d;]*39m/u,
		"the ellipsis keeps the line's own colour and only then resets the foreground",
	);
});

test("an expanded card shows the header, a blank line and the whole message text without a hint", () => {
	const value = details({}, "# build\n**literal**\n| one | two |");
	const lines = render(value, true);
	assert.deepEqual(lines.slice(1, 4), [" [jobs] Job 7 succeeded", " exit 0 · 10.0s · command preview: npm test", ""]);
	const text = lines.join("\n");
	for (const line of completionContent(value).split("\n")) assert.ok(text.includes(line.slice(0, 40)), line);
	assert.doesNotMatch(text, /to expand/u);
});

test("terminal control sequences in the details and the content never reach the card", () => {
	const value: JobCompletionDetails = {
		job: job({ error: "bad\x1b]0;title\x07 thing" }),
		command: "echo \x1b[31mred\x1b[0m",
		tail: { text: "out\x1b[2Jput\u0007", omitted: false, outputBytes: 12 },
	};
	for (const expanded of [false, true]) {
		const component = renderJobCompletionMessage(
			message(value, "body \x1b[31mred\x1b]8;;http://x\x07link"),
			options(expanded),
			theme,
		);
		assert.ok(component);
		assert.doesNotMatch(component.render(80).join("\n"), /\x1b|\u0007/u, expanded ? "expanded" : "collapsed");
	}
});

test("the preview counts blank output lines inside the window and drops them at its edges", () => {
	assert.deepEqual(render(details({}, "first\nsecond\n\nthird\n\n", 20)).slice(4, 7), [" second", "", " third"]);
	const edge = render(details({}, "first\n\nsecond\nthird", 20));
	assert.deepEqual(edge.slice(4, 6), [" second", " third"], "a blank first line of the window is dropped");
	assert.match(edge[6] ?? "", /^ \.\.\. \(/u);
});

test("the hint dims the key from Pi's keyHint, mutes the rest and keeps the row background", () => {
	const piHint = {
		...options(false),
		keyHint: (_binding: string, description: string) => `\x1b[2mctrl+o\x1b[22m\x1b[38;5;3m ${description}\x1b[39m`,
	} as unknown as MessageRenderOptions;
	const component = renderJobCompletionMessage(message(details()), piHint, ansiTheme);
	assert.ok(component);
	const rows = component.render(80);
	const hint = rows.find((row) => stripVTControlCharacters(row).includes("to expand")) ?? "";
	assert.equal(stripVTControlCharacters(hint).trim(), "... (ctrl+o to expand)");
	assert.ok(hint.includes("\x1b[2mctrl+o"), "the key comes from Pi's keyHint");
	assert.match(hint, /\x1b\[38;5;1m\.\.\. \(\x1b\[39m/u, "the rest is muted");
	for (const row of rows) {
		assert.ok(row.startsWith("\x1b[48;5;2m"));
		const body = row.slice(0, -5);
		for (const match of body.matchAll(/\x1b\[(?:0|49)?m/gu))
			assert.ok(
				body.startsWith("\x1b[48;5;2m", (match.index ?? 0) + match[0].length),
				"every reset restores the background",
			);
	}
});

test("display text keeps tabs and removes control sequences", () => {
	const lines = render(details({}, "col\tvalue \x1b[31mred\x1b[0m \u202ebidi", 30));
	assert.match(
		lines.join("\n"),
		/col {3}value red bidi/u,
		"the tab stays whitespace and draws as three spaces, as Pi's Text does",
	);
	assert.doesNotMatch(lines.join("\n"), /\\t|\\u|\u202e/u);
});

test("Pi's custom message shell supplies disclosure keys, theme, padding and click dispatch", async (t) => {
	initTheme("dark", false);
	const nativeTui = await import(
		createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")
	);
	const previous = nativeTui.getKeybindings();
	t.after(() => nativeTui.setKeybindings(previous));
	const bindings = (keys: string[]) =>
		new nativeTui.KeybindingsManager({
			...nativeTui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys: keys, description: "Toggle tool output" },
		});
	nativeTui.setKeybindings(bindings([]));
	const value = details({ id: "d5b9bde7-6e43-4a07-a284-f022679d4be9" }, "short\n**literal**\n" + "界".repeat(65));
	const stored = message(value);
	let hostTheme: Theme | undefined;
	const card = new CustomMessageComponent(stored, (entry, opts, colors) => {
		hostTheme = colors;
		return renderJobCompletionMessage(entry, opts, colors);
	});
	const body = (width = 90) => card.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
	const rows = body();
	assert.deepEqual(rows.slice(0, 5), [
		"",
		"",
		` [jobs] Job ${value.job.id} succeeded`,
		" exit 0 · 10.0s · command preview: npm test",
		"",
	]);
	assert.equal(rows[6], " **literal**");
	assert.match(rows[7] ?? "", /^ 界+…$/u);
	assert.deepEqual(rows.slice(-2), [" ... (click to expand)", ""]);
	assert.ok(hostTheme);
	assert.ok(card.render(90)[2]?.includes(hostTheme.fg("customMessageLabel", hostTheme.bold("[jobs]"))));
	assert.ok(
		card.render(90)[2]?.includes(hostTheme.fg("customMessageText", hostTheme.bold(`Job ${value.job.id} succeeded`))),
	);
	assert.ok(card.render(90)[6]?.includes(hostTheme.fg("customMessageText", "**literal**")));
	assert.ok(card.render(90)[3]?.includes(hostTheme.fg("muted", "exit 0 · 10.0s · command preview: npm test")));
	assert.ok(card.render(90)[3]?.startsWith(hostTheme.getBgAnsi("customMessageBg")));
	assert.match(body(26)[2] ?? "", /^ \[jobs\] Job .+…$/u);
	assert.ok(card.render(26).every((row) => visibleWidth(row) <= 26));

	body();
	assert.equal(card.handleMouse({ type: "click", button: "left", x: 3, y: 6, width: 90 } as never)?.handled, true);
	assert.match(body().join("\n"), /Background job/u);
	assert.doesNotMatch(body().join("\n"), /to expand/u);
	assert.equal(stored.content, completionContent(value), "display never changes the retained copy");
	nativeTui.setKeybindings(bindings(["ctrl+p"]));
	card.setExpanded(true);
	assert.doesNotMatch(body().join("\n"), /to expand/u);
	card.setExpanded(false);
	assert.equal(body().at(-2), " ... (ctrl+p to expand)");
	assert.ok(card.render(90).at(-2)?.includes(hostTheme.fg("dim", "ctrl+p")));

	nativeTui.setKeybindings(bindings([]));
	const single = details({}, "only output");
	const same = new CustomMessageComponent(message(single, single.tail.text), renderJobCompletionMessage);
	assert.doesNotMatch(same.render(90).join("\n"), /to expand/u);
});

test("a left click anywhere on the card toggles it, as on Pi's cards, and Pi's global expansion resets the choice", () => {
	const stored = message(details());
	const card = (expanded: boolean) => {
		const component = renderJobCompletionMessage(stored, options(expanded), theme);
		assert.ok(component);
		return component;
	};
	const at = (component: { handleMouse?(event: never): unknown }, y: number, patch: Record<string, unknown> = {}) =>
		component.handleMouse?.({
			type: "click",
			button: "left",
			x: 2,
			y,
			width: 80,
			height: 40,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
			...patch,
		} as never) as { handled?: boolean } | undefined;
	const text = (component: { render(width: number): readonly string[] }) =>
		component
			.render(80)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
	const collapsed = card(false);
	const body = collapsed
		.render(80)
		.findIndex((line, index) => index > 2 && stripVTControlCharacters(line).trim() !== "");
	assert.match(text(collapsed), /to expand\)/u);
	assert.equal(at(collapsed, 0), undefined, "a click on the padding row passes through");
	assert.equal(at(collapsed, body, { button: "right" }), undefined, "a right click passes through");
	assert.equal(
		at(collapsed, body, { type: "press" }),
		undefined,
		"a press or a drag passes through, so text selection works",
	);
	assert.equal(at(collapsed, body)?.handled, true, "a click on the body toggles, as Pi's MouseRegion does");
	assert.doesNotMatch(text(collapsed), /to expand\)/u);
	assert.equal(
		at(collapsed, 1, { shift: true })?.handled,
		true,
		"a modified click on the header toggles too; Pi does not filter modifiers",
	);
	assert.match(text(collapsed), /to expand\)/u);
	assert.equal(
		at(collapsed, body, { clickCount: 2 })?.handled,
		true,
		"each click of a multi-click toggles; Pi does not filter the click count",
	);
	assert.doesNotMatch(
		text(card(false)),
		/to expand\)/u,
		"a rebuild over the same stored message keeps the local choice",
	);
	assert.doesNotMatch(text(card(true)), /to expand\)/u);
	assert.match(text(card(false)), /to expand\)/u, "a change of Pi's global expansion discards the local choice");
});
