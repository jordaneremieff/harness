import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

function setup(postMessage?: (packet: unknown) => unknown) {
	const source = readFileSync(new URL("./model.ts", import.meta.url), "utf8");
	const window = {
		webkit: postMessage ? { messageHandlers: { explorer: { postMessage } } } : undefined,
	} as unknown as Window;
	runInNewContext(stripTypeScriptTypes(source), { window });
	return window.explorer;
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const app = setup();
const { project, find, fuzzy, excerpt } = app.model;

test("uses the Git zero-count coordinate for leading insertions and deletions", () => {
	const insertion = project(
		["a", "b"],
		["new", "a", "b"],
		[{ baseStart: 0, baseCount: 0, headStart: 1, headCount: 1 }],
		false,
	);
	assert.deepEqual(clone(insertion.filter((item) => item.type === "line")), [
		{ type: "line", kind: "add", head: 1 },
		{ type: "line", kind: "context", base: 1, head: 2 },
		{ type: "line", kind: "context", base: 2, head: 3 },
	]);
	const deletion = project(["old", "a"], ["a"], [{ baseStart: 1, baseCount: 1, headStart: 0, headCount: 0 }], true);
	assert.deepEqual(clone(deletion.filter((item) => item.type === "line")), [
		{ type: "line", kind: "del", base: 1 },
		{ type: "line", kind: "context", base: 2, head: 1 },
	]);
});

test("folds distant context and pairs word changes without shifting line numbers", () => {
	const base = Array.from({ length: 22 }, (_, index) => `let total = ${index + 1};`);
	const head = [...base];
	head[15] = "let total = 91;";
	const rows = project(base, head, [{ baseStart: 16, baseCount: 1, headStart: 16, headCount: 1 }], true);
	assert.deepEqual(clone(rows[0]), { type: "fold", key: "1:1", base: 1, head: 1, count: 12 });
	assert.deepEqual(clone(rows.find((row) => row.type === "line" && row.kind === "pair")), {
		type: "line",
		kind: "pair",
		base: 16,
		head: 16,
		word: { base: [12, 14], head: [12, 14] },
	});
});

test("Quick open prefers a matching filename and Find uses literal source offsets", () => {
	assert.equal(
		fuzzy(["viewtest/config.txt", "one/ReviewTest.ts", "other/rvw.ts"], "viewtest")[0]?.path,
		"one/ReviewTest.ts",
	);
	assert.equal(fuzzy(["src/ReviewWorker.ts", "test/index.ts"], "rvww")[0]?.path, "src/ReviewWorker.ts");
	assert.deepEqual(clone(find(["😀 x[foo] x[foo]"], "X[FOO]", "head")), [
		{ side: "head", line: 1, start: 3, end: 9 },
		{ side: "head", line: 1, start: 10, end: 16 },
	]);
});

test("review message preserves the exact quote and uses a nonconflicting fence", () => {
	const id = "n-0123456789aabbccddee";
	const text = excerpt("repo", "my scope", [
		{ path: "a.md", start: 2, end: 4, quote: "  ```\r\n\r\n end", commit: "abcde12345", id, text: "Please clarify." },
		{ path: "b.txt", commit: null, text: "Why this file?" },
	]);
	assert.equal(
		text,
		`Review comments on repo, my scope (2 comments)\n\n1. a.md, lines 2–4, at abcde12 (note ${id})\n\`\`\`\`markdown\n  \`\`\`\r\n\r\n end\n\`\`\`\`\nPlease clarify.\n\n2. b.txt, at working tree\nWhy this file?`,
	);
});

test("requests use the reply-capable bridge and ignore wrong-version events", async () => {
	const captured: unknown[] = [];
	const connected = setup((packet) => {
		captured.push(packet);
		return { ok: false, error: { code: "uncertain", message: "Not confirmed", retryable: true } };
	});
	await assert.rejects(connected.request("prompt", { requestId: "r", threadId: "t", text: "ask" }), {
		code: "uncertain",
		retryable: true,
	});
	assert.deepEqual(clone(captured[0]), { v: 1, type: "prompt", requestId: "r", threadId: "t", text: "ask" });
	const events: string[] = [];
	connected.listen((event) => events.push(event.type));
	connected.receive({ v: 2, type: "open" });
	connected.receive({ v: 1, type: "unrecognised" });
	connected.receive({ v: 1, type: "open" });
	assert.deepEqual(events, ["open"]);
});

const detected: [string, string][] = [
	["toml", "x.toml Cargo.lock"],
	[
		"ini",
		"x.ini x.cfg x.conf x.properties x.env x.service x.socket x.timer .editorconfig .gitconfig .npmrc .env .env.local .env.production.ts",
	],
	["c", "x.c x.h"],
	["ruby", "x.rb x.gemspec x.rake Gemfile Rakefile"],
	["php", "x.php"],
	["lua", "x.lua"],
	["dockerfile", "Dockerfile Containerfile x.dockerfile"],
	["makefile", "Makefile GNUmakefile makefile x.mk"],
	["ignore", ".gitignore .gitattributes .dockerignore .npmignore .prettierignore"],
	["python", "x.py-tpl Tiltfile"],
	["json", "x.JSON5 Package.resolved"],
	["yaml", "x.neon"],
	["markdown", "x.apib"],
	["bash", ".zshrc .zprofile .bashrc .bash_profile"],
	["gomod", "go.mod go.work"],
	["hcl", "x.tf x.tfvars x.hcl"],
	["graphql", "x.graphql x.gql"],
	["protobuf", "x.proto"],
	["dbml", "x.dbml"],
	["gettext", "x.po x.pot"],
	["plantuml", "x.puml x.plantuml"],
	["rst", "x.rst"],
	["csv", "x.csv"],
	["tsv", "x.tsv"],
	["erb", "x.erb"],
	["handlebars", "x.hbs x.handlebars"],
	["gotemplate", "x.tpl x.tmpl x.gotmpl"],
	["svelte", "x.svelte"],
	["astro", "x.astro"],
	["text", "go.sum unknown x.wasm x.cpp x.mm x.java x.kt x.cs dockerfile README.gitignore"],
];

for (const [id, paths] of detected) {
	test(`detects ${id} from the leaf name or extension`, () => {
		for (const path of paths.split(" ")) assert.equal(app.model.language(`nested/${path}`).id, id, path);
	});
}

test("uses the interpreter only when the name and extension are unknown", () => {
	const { language } = app.model;
	assert.equal(language("bin/check", "#!/bin/sh -e").id, "bash");
	assert.equal(language("bin/tool.unknown", "#! /usr/local/bin/python3.12 -u").id, "python");
	assert.equal(language("bin/tool", "#!/usr/bin/env ruby").id, "ruby");
	assert.equal(language("bin/tool", "#!/usr/bin/env -S ts-node --quiet").id, "typescript");
	assert.equal(language("bin/tool", "#!/usr/bin/env -S lua5.4 -i").id, "lua");
	assert.equal(language("bin/tool", "#!/usr/bin/env make").id, "text");
	assert.equal(language("bin/tool", " #!/usr/bin/env ruby").id, "text");
	assert.equal(language("x.ts", "#!/usr/bin/env node").id, "typescript");
	assert.equal(language("Dockerfile", "#!/usr/bin/env ruby").id, "dockerfile");
});
