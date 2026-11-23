import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	briefInputProblems,
	briefPreview,
	briefPreviewText,
	briefRefusal,
	briefSourceProblems,
	briefSourceToken,
	renderBrief,
} from "./brief.ts";

const required = {
	objective: "Document the parser.",
	endCondition: "Stop after the check passes.",
	result: "One paragraph.",
};

test("renders the exact standard brief with all sections and trimmed fields", () => {
	const rendered = renderBrief({
		...required,
		objective: "  Document the parser. \n",
		purpose: " Make the examples discoverable. ",
		operator: [
			{ quote: "  Use the examples.\nKeep them short.  ", source: "  Task request! ", scope: " Examples only " },
			{ quote: "Preserve the API.", source: "Decision log.", scope: "  " },
		],
		context: [" First fact.\nSecond line.  ", "  Third fact.  "],
		sources: [" README.md existing API "],
		permitted: [" Change docs. "],
		restrictions: [" Do not change the API. "],
		checks: [" Run the example. "],
	});
	assert.equal(
		rendered.text,
		`# Task brief

## Objective
Document the parser.

## Purpose
Make the examples discoverable.

## Operator decisions
These are the operator's words, quoted with their source and scope. The rest of this brief is the requester's direction.

> Use the examples.
> Keep them short.
Source: Task request! Scope: Examples only.

> Preserve the API.
Source: Decision log.

## Context
- First fact.
  Second line.
- Third fact.

## Sources
- README.md existing API

## Permitted
- Change docs.

## Restrictions
- Do not change the API.

## Checks
- Run the example.

## End condition
Stop after the check passes.

## Result
One paragraph.

Make every other tool call first. Give the complete result in your last message, or in the agent_work complete report when you declared open work.`,
	);
	assert.deepEqual(rendered.brief, {
		kind: "task",
		characters: rendered.text.length,
		sections: [
			"objective",
			"purpose",
			"operator",
			"context",
			"sources",
			"permitted",
			"restrictions",
			"checks",
			"endCondition",
			"result",
		],
	});
});

test("renders the exact minimal brief and omits empty optional sections", () => {
	const rendered = renderBrief({
		...required,
		kind: "task",
		objective: " Count 🧭. ",
		purpose: " \t",
		checks: [],
		operator: [],
	});
	assert.equal(
		rendered.text,
		`# Task brief

## Objective
Count 🧭.

## End condition
Stop after the check passes.

## Result
One paragraph.

Make every other tool call first. Give the complete result in your last message, or in the agent_work complete report when you declared open work.`,
	);
	assert.deepEqual(rendered.brief.sections, ["objective", "endCondition", "result"]);
	assert.equal(rendered.brief.characters, rendered.text.length - 1);
});

test("renders each non-task kind's instruction and no extra punctuation after a source or scope ending in a question mark", () => {
	const cases = {
		Lead: "You lead this outcome. Do the work yourself, divide it, or use helpers selectively. Keep the exact result reference of each delegated part and let results arrive as events. Return one answer that covers the whole result and names any gap.",
		Review:
			"This is an independent review. Test the claim, its omitted cases and its evidence against the defining sources, not against the author's conclusion; repeating the author's commands alone is not independent review. Give each finding a disposition and its evidence.",
		Partner:
			"This is a shared inquiry. Challenge the framing and the approach where the evidence supports it, and propose a better route or a changed division of work when you find one.",
		Handoff:
			"This hands over existing work. Continue from the state below, keep its open references, and do not repeat finished steps.",
	};
	for (const [kind, instruction] of Object.entries(cases)) {
		assert.ok(
			renderBrief({ ...required, kind: kind.toLowerCase() }).text.startsWith(
				`# ${kind} brief\n\n${instruction}\n\n## Objective`,
			),
		);
	}
	assert.match(
		renderBrief({
			...required,
			operator: [{ quote: "Yes.\r\nProceed.", source: "Which thread?", scope: "This task?" }],
		}).text,
		/^> Yes\.\n> Proceed\.\nSource: Which thread\? Scope: This task\?$/mu,
	);
});

test("recognises path tokens without treating URLs, globs or prose as local files", () => {
	for (const [entry, token] of [
		["  `README.md#conventions`, setup", "README.md"],
		["<./src/index.ts:7:3> contract", "./src/index.ts"],
		["('../source.ts:7#symbol'); note", "../source.ts"],
		['"/work/docs/intro". note', "/work/docs/intro"],
		["(pkg/v1) note", undefined],
		["extensions/agent/brief.ts:192:4 parser", "extensions/agent/brief.ts"],
		["origin/main branch", undefined],
		["7447f1c9-e9c8-ccbf-29ad-4d26ea94c0e4/e7e1d7428412dc8785b75a24ea09df87 thread", undefined],
		["@earendil-works/pi-coding-agent package", undefined],
		["1.6.0 version", undefined],
		["v1.6.0 tag", undefined],
		["d425a3c61:extensions/agent/brief.ts Git object", undefined],
		["d425a3c61:extensions/agent/brief.ts:192 Git object with line", undefined],
		["extensions/agent directory", undefined],
		["./extensions/agent directory", "./extensions/agent"],
		["~/README.md reference", "~/README.md"],
		["file.a1234567", "file.a1234567"],
		["https://example.test/manual#section note", undefined],
		["git+ssh://host/repo", undefined],
		["src/*.ts", undefined],
		["file?.ts", undefined],
		["src/[a-z].ts", undefined],
		["{docs,src}/guide.md", undefined],
		["123abcd commit", undefined],
		[".gitignore", undefined],
		["file.123456789", undefined],
		["", undefined],
	] as const)
		assert.equal(briefSourceToken(entry), token, entry);
});

test("resolves sources against the recipient directory and only checks non-relative paths without it", (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "brief-sources-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const child = join(cwd, "child");
	mkdirSync(child);
	writeFileSync(join(cwd, "caller.md"), "caller");
	writeFileSync(join(child, "child.md"), "child");
	const absoluteMissing = join(cwd, "missing");
	const sources = ["./child.md:1", "../caller.md", "~/", absoluteMissing, "https://example.test", "./child/*.md"];
	assert.equal(briefSourceToken("~/"), "~/");
	assert.deepEqual(briefSourceProblems({ sources: ["caller.md"] }, cwd), []);
	assert.deepEqual(briefSourceProblems({ sources: ["extensions/agent", "./extensions/agent"] }, cwd), [
		`Source path does not exist: ./extensions/agent (resolved ${join(cwd, "extensions", "agent")})`,
	]);
	assert.deepEqual(briefSourceProblems({ sources }, child), [
		`Source path does not exist: ${absoluteMissing} (resolved ${absoluteMissing})`,
	]);
	assert.deepEqual(briefSourceProblems({ sessionId: "@parser", sources: ["child.md", "caller.md"] }, child), [
		`Source path does not exist: caller.md (resolved ${join(child, "caller.md")})`,
	]);
	const missingHome = `~/missing-${cwd.split("/").at(-1)}.md`;
	assert.deepEqual(briefSourceProblems({ sources: [...sources, missingHome] }), [
		`Source path does not exist: ${absoluteMissing} (resolved ${absoluteMissing})`,
		`Source path does not exist: ${missingHome} (resolved ${join(homedir(), missingHome.slice(2))})`,
	]);
});

test("returns exact aggregate problems and a copyable preview without a repair instruction", () => {
	const input = {
		...required,
		sessionId: "@parser",
		cwd: ".",
		trust: false,
		objective: " \n",
		endCondition: "",
		result: "\t",
		context: ["ok", "  "],
		operator: [{ quote: "  ", source: "\t" }],
		sources: ["/invalid/path/brief.md"],
	};
	const fields = briefInputProblems(input, ["cwd", "trust"]);
	assert.deepEqual(fields, [
		"sessionId cannot be combined with creation fields: cwd, trust.",
		"objective must not be blank.",
		"operator[0].quote must not be blank.",
		"operator[0].source must not be blank.",
		"context[1] must not be blank.",
		"endCondition must not be blank.",
		"result must not be blank.",
	]);
	assert.deepEqual(briefInputProblems({ ...required, mode: "followUp" }, []), ["mode requires sessionId."]);
	const sources = briefSourceProblems(input, "/");
	assert.equal(
		briefRefusal(fields, sources),
		[
			...fields,
			"Source path does not exist: /invalid/path/brief.md (resolved /invalid/path/brief.md)",
			"Correct each path, or move a path that does not exist yet from sources into context.",
		].join("\n"),
	);
	const rendered = renderBrief(input);
	const preview = briefPreview(rendered, [...fields, ...sources]);
	assert.deepEqual(preview, {
		preview: true,
		brief: { ...rendered.brief, text: rendered.text },
		problems: [...fields, ...sources],
	});
	assert.equal(briefPreviewText(preview), [rendered.text, "\nNothing was sent.", ...fields, ...sources].join("\n"));
});
