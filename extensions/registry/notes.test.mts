import assert from "node:assert/strict";
import { test } from "node:test";
import { RegistryNotes, noteTargets, simpleCommands, type NoteKnowledge, type NoteCall } from "./notes.ts";
import type { SettingsSnapshot } from "./configuration.ts";
import type { SettingRecord } from "./configuration-protocol.ts";

function row(name = "example.limit", env = "PI_EXAMPLE_LIMIT"): SettingRecord {
	return { name, key: name.split(".")[1], type: "integer", description: "Limit", env, secret: false, origin: "env", status: "valid", value: 7 };
}
function knowledge(): NoteKnowledge {
	const snapshot: SettingsSnapshot = { available: true, collection: { status: "available", slices: ["example"], malformed: 0, omitted: 0 },
		publications: [{ version: 1, slice: "example", source: { path: "/home/test/.pi/agent/harness.json", status: "loaded", digest: null, observedAt: "2026-10-29T00:00:00.000Z" }, records: [row()], diagnostics: [] }] };
	return { cwd: "/work/project", home: "/home/test", agentDir: "/home/test/.pi/agent", version: "1.4.0", packageDir: "/packages/pi", docsPath: "/packages/pi/docs", examplesPath: "/packages/pi/examples", settings: snapshot,
		resources: [{ kind: "extension", name: "example", path: "/loaded/extensions/example", entryPath: "/loaded/extensions/example/index.ts", tool: "example_tool" }, { kind: "skill", name: "audit-example", path: "/loaded/skills/audit-example" }, { kind: "prompt", name: "example-prompt", path: "/loaded/prompts/example.md" }] };
}
const read = (path: string): NoteCall => ({ name: "read", input: { path } });
const bash = (command: string): NoteCall => ({ name: "bash", input: { command } });
function keys(call: NoteCall, data = knowledge()): string { return noteTargets(call, data).map((target) => target.key).sort().join(","); }
function state(data = knowledge(), enabled: () => boolean = () => true) {
	let refreshed = 0;
	return { data, notes: new RegistryNotes(() => data, () => { refreshed += 1; return data.settings; }, enabled), refreshed: () => refreshed };
}
test("simple shell words retain quotes, escaped spaces, separators and pipes", () => {
	const commands = simpleCommands('cat "/space here/config"; head /other\\ path && env | rg "PI_EXAMPLE_LIMIT" || pi -v');
	assert.equal(commands.length, 5);
	assert.equal(commands[0].words[1].text, "/space here/config");
	assert.equal(commands[1].words[1].text, "/other path");
	assert.equal(commands[3].pipe, true);
	assert.equal(simpleCommands("cat <<EOF\n/path\nEOF").length, 0);
	assert.equal(simpleCommands("cat $(printenv FILE)").length, 0);
	assert.equal(simpleCommands("cat `pwd`/file").length, 0);
	assert.equal(simpleCommands("cat 'unterminated").length, 0);
	assert.equal(simpleCommands("cat /file &").length, 0);
});
test("shell redirections preserve discovery arguments and exclude output targets", () => {
	for (const redirect of [">/dev/null", "> /dev/null", ">>/dev/null", "2>/dev/null", "2> /dev/null", "2>&1", "&>/dev/null", "9>&8", '>"/other output"'])
		assert.equal(keys(bash(`ls -la ~/.pi/agent/extensions/ ${redirect}`)), "root:/home/test/.pi/agent/extensions", redirect);
	assert.equal(keys(bash(">/dev/null ls /loaded/extensions")), "root:/loaded/extensions");
	assert.equal(keys(bash("ls /elsewhere >/loaded/extensions")), "");
	assert.equal(keys(bash("cat /elsewhere >~/.pi/agent/harness.json")), "");
	for (const command of ["cat <~/.pi/agent/harness.json", "cat < ~/.pi/agent/harness.json", "jq . < ~/.pi/agent/harness.json", "wc 0<~/.pi/agent/harness.json", "grep PI_EXAMPLE_LIMIT < ~/.pi/agent/harness.json"])
		assert.match(keys(bash(command)), /document:/, command);
	assert.equal(keys(bash("env 2>/dev/null | rg -A 15 PI_EXAMPLE_LIMIT")), "setting:example.limit");
	for (const command of ["cat <<EOF\n~/.pi/agent/harness.json\nEOF", "ls <(printf /loaded/extensions)", "ls >(cat /loaded/extensions)", "(ls /loaded/extensions)"])
		assert.equal(keys(bash(command)), "", command);
});
test("simple cd changes resolution without changing the session development boundary", () => {
	for (const separator of ["&&", ";", "||"])
		assert.equal(keys(bash(`cd ~/.pi/agent ${separator} jq . harness.json`)), "document:/home/test/.pi/agent/harness.json");
	assert.equal(keys(bash("cd /home/test; cd .pi/agent; cat harness.json")), "document:/home/test/.pi/agent/harness.json");
	assert.equal(keys(bash('"cd" /home/test/.pi/agent; cat harness.json')), "document:/home/test/.pi/agent/harness.json");
	assert.equal(keys(bash("cd /loaded && ls extensions")), "root:/loaded/extensions");
	const data = knowledge(); data.cwd = "/loaded";
	assert.equal(keys(bash("cd /loaded/extensions; cat example/settings.ts"), data), "");
	assert.equal(keys(bash("cd /loaded | ls extensions")), "");
});
test("unresolved cd suppresses later relative targets but retains absolute and home targets", () => {
	for (const command of ["cd $UNKNOWN && cat harness.json", 'cd "$UNKNOWN"; ls extensions', "cd; cat harness.json", "cd /loaded/*; ls extensions", "cd $UNKNOWN; cd /home/test/.pi/agent; cat harness.json"])
		assert.equal(keys(bash(command)), "", command);
	assert.equal(keys(bash("cd $UNKNOWN; cat ~/.pi/agent/harness.json")), "document:/home/test/.pi/agent/harness.json");
	assert.equal(keys(bash("cd; cat /home/test/.pi/agent/harness.json")), "document:/home/test/.pi/agent/harness.json");
});
test("search and fd options consume separate values before path detection", () => {
	const searchOptions = ["-A", "-B", "-C", "--after-context", "--before-context", "--context", "-M", "--max-columns", "--max-filesize", "-j", "--threads", "-r", "--replace", "--sort", "--sortr", "--color", "--colors", "--type-add", "--include", "--exclude"];
	for (const program of ["rg", "grep"]) for (const option of searchOptions)
		assert.equal(keys(bash(`${program} -n ${option} 15 PI_EXAMPLE_LIMIT /loaded/extensions`)), "setting:example.limit", `${program} ${option}`);
	assert.equal(keys(bash("rg --replace PI_EXAMPLE_LIMIT other /loaded/extensions")), "");
	for (const option of ["--max-results", "--changed-within", "--changed-before", "-S", "--size", "-j", "--threads", "--exact-depth", "--format"])
		assert.equal(keys(bash(`fd ${option} 20 -t d . /loaded/extensions`)), "root:/loaded/extensions", option);
	for (const option of ["-x", "--exec", "-X", "--exec-batch"]) {
		assert.equal(keys(bash(`fd . ${option} ls /loaded/extensions`)), "", option);
		assert.equal(keys(bash(`fd . /loaded/extensions ${option} echo /other`)), "root:/loaded/extensions", option);
	}
});
test("settings document paths match exact loaded documents and reader arguments", () => {
	for (const path of ["~/.pi/agent/harness.json", "$HOME/.pi/agent/harness.json", `\${HOME}/.pi/agent/harness.json`, "../../home/test/.pi/agent/harness.json"])
		assert.equal(keys(read(path)), "document:/home/test/.pi/agent/harness.json", path);
	for (const command of ['cat "$HOME/.pi/agent/harness.json"', "head -n 10 ~/.pi/agent/harness.json", "tail -c 20 ~/.pi/agent/harness.json", "jq '.registry' ~/.pi/agent/harness.json", "rg limit ~/.pi/agent/harness.json", "grep limit ~/.pi/agent/harness.json", "sed -n '1,20p' ~/.pi/agent/harness.json", "awk '{print $1}' ~/.pi/agent/harness.json", "wc -c ~/.pi/agent/harness.json", "bat ~/.pi/agent/harness.json", "less ~/.pi/agent/harness.json", "more ~/.pi/agent/harness.json"])
		assert.match(keys(bash(command)), /document:/, command);
	for (const command of ["echo 'cat ~/.pi/agent/harness.json'", "printf '%s' ~/.pi/agent/harness.json", "cat '$HOME/.pi/agent/harness.json'", "cat ~/.pi/agent/other.json", "cat $(echo ~/.pi/agent/harness.json)", "cat <<EOF\n~/.pi/agent/harness.json\nEOF"])
		assert.equal(keys(bash(command)), "", command);
	assert.equal(keys(read("/other-copy/harness.json")), "");
	assert.equal(keys(bash("jq --arg example '/home/test/.pi/agent/harness.json' '.example'")), "");
	assert.equal(keys(bash("awk -v example='/home/test/.pi/agent/harness.json' 'BEGIN {print example}'")), "");
	assert.equal(keys(bash('cat "~/.pi/agent/harness.json"')), "");
});
test("published names match whole tokens with exact environment operations", () => {
	for (const command of ["printenv PI_EXAMPLE_LIMIT", "echo $PI_EXAMPLE_LIMIT", 'echo "$PI_EXAMPLE_LIMIT"', `echo \${PI_EXAMPLE_LIMIT}`, `echo "\${PI_EXAMPLE_LIMIT}"`, "env | rg PI_EXAMPLE_LIMIT", "env | grep 'PI_EXAMPLE_LIMIT'", "rg PI_EXAMPLE_LIMIT /loaded/extensions", "grep -n 'example.limit' /loaded/extensions", "git grep -e PI_EXAMPLE_LIMIT -- /loaded/extensions"])
		assert.match(keys(bash(command)), /setting:example.limit/, command);
	assert.equal(keys({ name: "grep", input: { pattern: "example.limit", path: "/loaded" } }), "setting:example.limit");
	for (const command of ["printenv PI_EXAMPLE_LIMIT_EXTRA", "printenv PI_EXAMPLE_LIMIT:other", "echo 'PI_EXAMPLE_LIMIT'", "echo '$PI_EXAMPLE_LIMIT'", "rg PI_EXAMPLE_LIMIT", "rg PI_EXAMPLE_LIMIT .", "grep PI_EXAMPLE_LIMIT /work/project/src", "env | grep PI_EXAMPLE_LIMIT_SUFFIX", "env | rg XPI_EXAMPLE_LIMIT", "env | rg example.limitExtra", "env | rg other.example.limit"])
		assert.equal(keys(bash(command)), "", command);
	assert.equal(keys({ name: "grep", input: { pattern: "PI_EXAMPLE_LIMIT", path: "/work/project" } }), "");
});
test("loaded extension files, resource roots and host files match exact provenance", () => {
	assert.equal(keys(read("/loaded/extensions/example/settings.ts")), "extension:/loaded/extensions/example");
	assert.equal(keys(bash("cat /loaded/extensions/example/settings.ts")), "extension:/loaded/extensions/example");
	assert.equal(keys(read("/loaded/extensions/example/index.ts")), "extension:/loaded/extensions/example");
	for (const path of ["/other/extensions/example/settings.ts", "/loaded/extensions/example-copy/index.ts", "/loaded/extensions/unpublished/settings.ts"])
		assert.equal(keys(read(path)), "");
	for (const root of ["/loaded/extensions", "/loaded/skills", "/loaded/prompts", "/home/test/.pi/agent/extensions", "/home/test/.pi/agent/skills", "/home/test/.pi/agent/prompts"]) {
		for (const call of [{ name: "ls", input: { path: root } }, { name: "find", input: { path: root, pattern: "*" } }, bash(`ls -la '${root}'`), bash(`find ${root} -maxdepth 1`), bash(`fd . ${root}`), bash(`tree -L 1 ${root}`), bash(`rg --files ${root}`)])
			assert.equal(keys(call), `root:${root}`);
	}
	assert.equal(keys(bash("fd /loaded/extensions")), "");
	assert.equal(keys(bash("fd . -E /loaded/extensions")), "");
	assert.equal(keys(bash("find /elsewhere -name /loaded/extensions")), "");
	assert.equal(keys(bash("ls /other/extensions")), "");
	assert.equal(keys(read("/home/test/.pi/agent/install/current-version")), "host:pi");
	assert.equal(keys(read("/packages/pi/package.json")), "host:pi");
	assert.equal(keys(read("/other/pi/package.json")), "");
	assert.equal(keys(bash("cat /packages/pi/package.json")), "");
	assert.equal(keys(bash("cat ~/.pi/agent/install/current-version")), "");
	assert.equal(keys(bash("pi --version")), "host:pi");
	assert.equal(keys(bash("pi -v")), "host:pi");
	assert.equal(keys(bash('echo "pi --version"')), "");
});
test("loaded extension paths cover source reads, searches and enumeration with directory dedupe", () => {
	for (const call of [read("/loaded/extensions/example/runtime.ts"), bash("cat /loaded/extensions/example/README.md"),
		bash("rg -n -A 15 unrelated /loaded/extensions/example/runtime.ts"), bash("fd . /loaded/extensions/example/src"),
		{ name: "grep", input: { pattern: "unrelated", path: "/loaded/extensions/example/runtime.ts" } },
		{ name: "ls", input: { path: "/loaded/extensions/example" } }, { name: "find", input: { path: "/loaded/extensions/example/src", pattern: "*" } }])
		assert.equal(keys(call), "extension:/loaded/extensions/example");
	const { notes } = state();
	assert.equal(notes.result(read("/loaded/extensions/example/runtime.ts"), "first").length, 1);
	assert.equal(notes.result(read("/loaded/extensions/example/settings.ts"), "second").length, 0);
	const data = knowledge(); data.cwd = "/loaded/extensions/example";
	assert.equal(state(data).notes.result(read("runtime.ts"), "development").length, 0);
	assert.equal(keys(read("/loaded/extensions/example-other/runtime.ts")), "");
});
test("extension notes retain entry provenance, prioritise environment rows and expose only known tool metadata", () => {
	const data = knowledge();
	const token = { ...row("example.token", "PI_EXAMPLE_TOKEN"), type: "string" as const, secret: true, secretState: "set" as const };
	delete token.value;
	data.settings.publications[0].records = [{ ...row("example.default", "PI_EXAMPLE_DEFAULT"), origin: "default" }, row(), token,
		{ ...token, name: "example.unset", key: "unset", env: "PI_EXAMPLE_UNSET", secretState: "unset", status: "invalid" }];
	const note = state(data).notes.result(read("/loaded/extensions/example/runtime.ts"), "source")[0];
	assert.match(note, /^\[registry\] example is loaded in this session from \/loaded\/extensions\/example\/index.ts\./);
	assert.ok(note.indexOf("example.limit =") < note.indexOf("example.default ="));
	assert.match(note, /example.token = set \(origin env, env PI_EXAMPLE_TOKEN\)/);
	assert.match(note, /example.unset = unset \(origin env, env PI_EXAMPLE_UNSET, validity invalid\)/);
	assert.match(note, /file values do not apply while the env var is set/);
	assert.match(note, /registry \{"kind":"setting","search":"example\."\}/);
	assert.match(note, /registry \{"kind":"tool","name":"example_tool","detail":true\}/);
	const native = knowledge();
	native.resources = native.resources?.map(({ tool: _tool, ...resource }) => resource) ?? null;
	assert.doesNotMatch(state(native).notes.result(read("/loaded/extensions/example/runtime.ts"), "native")[0], /"kind":"tool"/);
	data.settings.publications = [];
	assert.match(state(data).notes.result(read("/loaded/extensions/example/runtime.ts"), "no-publisher")[0], /It publishes no harness settings\./);
	assert.doesNotMatch(state(data).notes.result(read("/loaded/extensions/example/runtime.ts"), "no-settings-call")[0], /"kind":"setting"/);
});
test("Pi settings document matches only exact read paths and reader paths with the agent-directory exception", () => {
	for (const call of [read("~/.pi/agent/settings.json"), bash("jq '{extensions, packages}' ~/.pi/agent/settings.json"), bash("cat ~/.pi/agent/settings.json")])
		assert.equal(keys(call), "pi-settings:/home/test/.pi/agent/settings.json");
	assert.equal(keys(read("/other/.pi/agent/settings.json")), "");
	assert.equal(keys({ name: "grep", input: { pattern: "sources", path: "/home/test/.pi/agent/settings.json" } }), "");
	assert.equal(keys({ name: "write", input: { path: "/home/test/.pi/agent/settings.json" } }), "");
	const data = knowledge(); data.cwd = "/home/test/.pi";
	assert.match(keys(read("agent/settings.json"), data), /pi-settings:/);
	data.cwd = data.agentDir;
	assert.equal(keys(read("settings.json"), data), "");
});
test("Pi settings notes distinguish loaded provenance from configured sources and redact environment secrets", () => {
	const data = knowledge();
	data.resources = [...(data.resources ?? []), { kind: "extension", name: "example", path: "/loaded/extensions/example", entryPath: "/loaded/extensions/example/index.ts", tool: "second_tool" }];
	const token = { ...row("example.token", "PI_EXAMPLE_TOKEN"), type: "string" as const, secret: true, secretState: "set" as const };
	delete token.value;
	data.settings.publications[0].records.push(token);
	const { notes } = state(data);
	const note = notes.result(read("~/.pi/agent/settings.json"), "pi-settings")[0];
	assert.match(note, /^\[registry\] This session loaded 1 extensions; Pi settings list configured sources, not load results\./);
	assert.match(note, /Harness settings set by environment \(file values do not apply while set\):/);
	assert.match(note, /example.limit = 7 \(origin env, env PI_EXAMPLE_LIMIT\)/);
	assert.match(note, /example.token = set \(origin env, env PI_EXAMPLE_TOKEN\)/);
	assert.match(note, /registry \{"kind":"setting"\}; registry \{"kind":"setting","search":"<extension>\."\}/);
	assert.equal(notes.result(bash("cat ~/.pi/agent/settings.json"), "duplicate").length, 0);
	data.settings.publications[0].records = [{ ...row(), origin: "file" }];
	assert.match(state(data).notes.result(read("~/.pi/agent/settings.json"), "no-env")[0], /No harness setting is set by environment\./);
	data.resources = null;
	assert.equal(state(data).notes.result(read("~/.pi/agent/settings.json"), "unavailable").length, 0);
});
test("inside-cwd paths and unrelated tools never trigger", () => {
	const data = knowledge(); data.cwd = "/loaded";
	assert.equal(keys(read("extensions/example/settings.ts"), data), "");
	assert.equal(keys(bash("ls /loaded/extensions"), data), "");
	data.cwd = "/home/test/.pi/agent";
	assert.equal(keys(read("harness.json"), data), "");
	assert.equal(keys({ name: "registry", input: { kind: "setting" } }), "");
	assert.equal(keys({ name: "write", input: { path: "/home/test/.pi/agent/harness.json" } }), "");
});
test("agent-directory targets are exempt except when cwd is inside the agent directory", () => {
	const data = knowledge(); data.cwd = "/home/test/.pi";
	assert.match(keys(read("agent/harness.json"), data), /document:/);
	assert.match(keys(read("agent/install/current-version"), data), /host:/);
	assert.match(keys(bash("ls agent/skills"), data), /root:/);
	assert.match(keys(bash("rg PI_EXAMPLE_LIMIT agent"), data), /setting:/);
	data.cwd = data.agentDir;
	assert.equal(keys(read("harness.json"), data), "");
	assert.equal(keys(read("install/current-version"), data), "");
	assert.equal(keys(bash("ls skills"), data), "");
});
test("home-directory sessions retain discovery notes for their descendants", () => {
	const data = knowledge(); data.cwd = data.home;
	data.resources = [{ kind: "extension", name: "example", path: "/home/test/loaded/example" }];
	assert.match(keys(read(".pi/agent/harness.json"), data), /document:/);
	assert.match(keys(read("loaded/example/settings.ts"), data), /extension:/);
	assert.match(keys(bash("ls loaded"), data), /root:/);
	assert.match(keys(bash("grep PI_EXAMPLE_LIMIT loaded"), data), /setting:/);
	data.cwd = "/home/test/loaded";
	assert.equal(keys(read("example/settings.ts"), data), "");
});
test("resource notes include other loaded directories and source/scope inspection", () => {
	const data = knowledge();
	data.resources = [...(data.resources ?? []), { kind: "extension", name: "other", path: "/other/worktree/other" }];
	const note = state(data).notes.result(bash("ls /loaded/extensions"), "list")[0];
	assert.match(note, /extension example/);
	assert.match(note, /1 other loaded extension directories/);
	assert.match(note, /registry \{"kind":"tool","name":"<tool>"\}/);
	assert.doesNotMatch(note, /extension other\n/);
});
test("document notes prioritise environment rows and clip their nonsecret values to sixty characters", () => {
	const data = knowledge();
	data.settings.publications[0].records[0] = { ...row(), type: "string", value: "x".repeat(200) };
	const note = state(data).notes.result(read(data.settings.publications[0].source.path), "doc")[0];
	assert.match(note, /x{59}/);
	assert.doesNotMatch(note, /x{60}/);
	assert.ok(note.indexOf("example.limit =") < note.indexOf("file values for these keys"));
});
test("settings notes show safe values, origins, validity and calls", () => {
	const data = knowledge();
	data.settings.publications[0].records.push({ ...row("example.token", "PI_EXAMPLE_TOKEN"), type: "string", value: undefined, secret: true, secretState: "set", status: "invalid" });
	data.settings.publications[0].records.push({ ...row("example.file", "PI_EXAMPLE_FILE"), origin: "file" });
	data.settings.publications[0].records.push({ ...row("example.default", "PI_EXAMPLE_DEFAULT"), origin: "default" });
	const { notes } = state(data);
	const text = notes.result(read(data.settings.publications[0].source.path), "first").join("");
	assert.match(text, /^\[registry\] Configured values published by loaded extensions at /);
	assert.match(text, /running processes may not have applied file edits/);
	assert.match(text, /example.token = set \(origin env, env PI_EXAMPLE_TOKEN, validity invalid\)/);
	assert.match(text, /file values for these keys do not apply while the env var is set/);
	assert.match(text, /example: default \(defaults apply\)/);
	assert.match(text, /"name":"<slice>\.<key>"/);
	assert.doesNotMatch(text, /other settings use file or defaults/);
	assert.match(text, /registry \{"kind":"setting"\}/);
	assert.doesNotMatch(text, /secretState|undefined/);
	assert.match(notes.result(bash("printenv PI_EXAMPLE_LIMIT"), "name").join(""), /"name":"example.limit"/);
	assert.match(notes.result(read("/loaded/extensions/example/settings.ts"), "slice").join(""), /"search":"example\."/);
	assert.match(notes.result(bash("ls /loaded/extensions"), "root").join(""), /extension example/);
	assert.match(notes.result(bash("pi -v"), "pi").join(""), /version = 1.4.0/);
});
test("all-file/default settings and unavailable evidence retain honest boundaries", () => {
	const data = knowledge(); data.settings.publications[0].records[0].origin = "default";
	assert.match(state(data).notes.result(read(data.settings.publications[0].source.path), "first")[0], /example: limit \(defaults apply\)/);
	for (const change of [(data: NoteKnowledge) => { data.settings.available = false; }, (data: NoteKnowledge) => { data.settings.collection.malformed = 1; }, (data: NoteKnowledge) => { data.settings.collection.omitted = 1; }, (data: NoteKnowledge) => { data.settings.publications[0].diagnostics.push({ field: "coverage", code: "coverage", source: "file", message: "Additional diagnostics were omitted at the diagnostic limit." }); }]) {
		const sample = knowledge(); change(sample);
		assert.equal(state(sample).notes.result(bash("printenv PI_EXAMPLE_LIMIT"), "first").length, 0);
		assert.equal(state(sample).notes.result(read(sample.settings.publications[0].source.path), "doc").length, 0);
		assert.equal(state(sample).notes.result(read("~/.pi/agent/settings.json"), "pi-settings").length, 0);
		assert.equal(state(sample).notes.result(read("/loaded/extensions/example/runtime.ts"), "extension").length, 0);
	}
	data.resources = null;
	assert.equal(state(data).notes.result(bash("ls /loaded/extensions"), "first").length, 0);
	assert.equal(state(data).notes.result(read("/loaded/extensions/example/settings.ts"), "first").length, 0);
});
test("dedupe, refresh, reset, off switch and exceptions stay local", () => {
	const sample = state();
	assert.equal(sample.notes.result(bash("echo unrelated"), "no").length, 0);
	assert.equal(sample.refreshed(), 0);
	assert.equal(sample.notes.result(bash("printenv PI_EXAMPLE_LIMIT"), "first").length, 1);
	assert.equal(sample.notes.result(bash("printenv PI_EXAMPLE_LIMIT"), "second").length, 0);
	assert.equal(sample.refreshed(), 1);
	sample.notes.reset();
	assert.equal(sample.notes.result(bash("printenv PI_EXAMPLE_LIMIT"), "third").length, 1);
	let on = false;
	const toggle = state(knowledge(), () => on);
	assert.equal(toggle.notes.result(bash("pi -v"), "off").length, 0);
	on = true;
	assert.equal(toggle.notes.result(bash("pi -v"), "on").length, 1);
	const throwing = new RegistryNotes(() => { throw new Error("unavailable"); }, () => knowledge().settings, () => true);
	assert.equal(throwing.result(bash("pi -v"), "no").length, 0);
});
test("nested notes roll through ancestors without changing nested results", () => {
	const { notes } = state();
	assert.equal(notes.result(bash("pi -v"), "leaf", "middle").length, 0);
	assert.equal(notes.result({ name: "wrapper", input: {} }, "middle", "outer").length, 0);
	assert.equal(notes.result({ name: "wrapper", input: {} }, "outer").length, 1);
	assert.equal(notes.result({ name: "wrapper", input: {} }, "outer").length, 0);
});
test("notes and aggregate results stay inside line, byte and session caps", () => {
	const data = knowledge();
	data.settings.publications[0].records = Array.from({ length: 20 }, (_, i) => ({ ...row(`example.field${i}`, `PI_EXAMPLE_FIELD_${i}`), type: "string", value: "😀".repeat(300) }));
	const { notes } = state(data);
	const result = notes.result(bash('cat ~/.pi/agent/harness.json; cat /loaded/extensions/example/settings.ts; pi -v; ls /loaded/extensions'), "many");
	assert.ok(result.length > 0 && result.length <= 2);
	assert.ok(Buffer.byteLength(result.join("")) <= 1600);
	for (const text of result) {
		assert.ok(text.split("\n").length <= 10);
		assert.ok(Buffer.byteLength(text) <= 1200);
		assert.doesNotMatch(text, /\uFFFD/);
	}
	for (const call of [read("/loaded/extensions/example/runtime.ts"), read("~/.pi/agent/settings.json")]) {
		const note = state(data).notes.result(call, "bounded")[0];
		assert.ok(note);
		assert.ok(note.split("\n").length <= 10);
		assert.ok(Buffer.byteLength(note) <= 1200);
		assert.ok((note.match(/origin env/g) ?? []).length <= 6);
	}
	const capped = state(data).notes;
	let count = 0;
	for (let i = 0; i < 20; i += 1) count += capped.result(bash(`printenv PI_EXAMPLE_FIELD_${i}`), String(i)).length;
	assert.equal(count, 6);
});
