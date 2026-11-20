import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Catalogue, EditResult, Entry, SettingsContext } from "../../../../protocol.ts";
import {
	begin,
	blocker,
	compareResult,
	display,
	draftKey,
	pointer,
	responseGate,
	resultLabel,
	scopeNotice,
	searchCatalogue,
	sectionFor,
	targetKey,
} from "./state.ts";

const context: SettingsContext = {
	version: 1,
	machine: "device",
	agentDir: "/agent",
	cwd: "/project",
	projectDir: "/project/.pi",
	host: { kind: "ordinary", pid: 5, piVersion: "1", piPackage: "/package" },
	projectTrusted: true,
	documents: [
		{
			document: "pi-global",
			scope: "global",
			path: "/agent/settings.json",
			status: "loaded",
			revision: null,
			writable: true,
		},
		{
			document: "pi-project",
			scope: "project",
			path: "/project/.pi/settings.json",
			status: "missing",
			revision: null,
			writable: true,
		},
	],
};
const entry: Entry = {
	id: "pi:/compaction/enabled",
	group: "pi",
	category: "History",
	path: ["compaction", "enabled"],
	label: "Compact history",
	description: "Summarise older turns",
	kind: "setting",
	value: { type: "boolean" },
	scopes: ["global", "project"],
	owner: "Pi",
	ownerState: "available",
	schema: "first",
	saved: { global: { present: true, value: false } },
	resolved: { source: "global", value: false },
	apply: { timing: "pi", text: "On reload" },
	diagnostics: [],
};
test("groups special records in Advanced and keeps a single Tools page", () => {
	assert.equal(sectionFor({ ...entry, category: "Tools" }), "tools");
	assert.equal(sectionFor({ ...entry, path: ["codemode", "enabled"] }), "tools");
	assert.equal(sectionFor({ ...entry, kind: "internal", category: "Tools" }), "advanced:internal");
	assert.equal(sectionFor({ ...entry, kind: "deprecated" }), "advanced:deprecated");
	assert.equal(sectionFor({ ...entry, kind: "unregistered" }), "advanced:unregistered");
	assert.equal(sectionFor({ ...entry, group: "harness", ownerState: "absent" }), "advanced:unmanaged");
});

test("shows values without JSON quotes and scope only where it matters", () => {
	assert.equal(display("light"), "light");
	assert.equal(display({ "a/b": "soft" }), "a/b: soft");
	assert.equal(scopeNotice(entry, "global"), undefined);
	assert.equal(scopeNotice(entry, "project"), "Set in Global");
	assert.equal(scopeNotice({ ...entry, scopes: ["global"] }, "project"), "Global only");
	const overriden: Entry = {
		...entry,
		saved: { ...entry.saved, project: { present: true, value: true } },
		resolved: { source: "project", value: true },
	};
	assert.equal(scopeNotice(overriden, "global"), "Overridden in Project");
	assert.equal(scopeNotice(overriden, "project"), undefined);
});

const catalogue: Catalogue = {
	version: 1,
	generation: 1,
	observedAt: "",
	context,
	entries: [entry],
	owners: [],
	coverage: [],
};

test("binds a draft to its original scope, file, value and owner schema", () => {
	const global = begin(entry, "global", context, "set");
	const project = begin(entry, "project", context, "set");
	assert.notEqual(draftKey(entry.id, "global"), draftKey(entry.id, "project"));
	assert.deepEqual(global.change.base, { present: true, value: false });
	assert.deepEqual(project.change.base, { present: false });
	assert.equal(global.change.schema, "first");
	assert.equal(blocker(global, catalogue), undefined);
	assert.match(blocker(global, { ...catalogue, entries: [{ ...entry, schema: "second" }] }) ?? "", /owner/);
	assert.match(blocker(global, { ...catalogue, entries: [{ ...entry, ownerState: "changed" }] }) ?? "", /owner/);
	assert.match(blocker(global, { ...catalogue, entries: [] }) ?? "", /no longer editable/);
	assert.match(blocker(project, { ...catalogue, context: { ...context, projectTrusted: false } }) ?? "", /trust/);
	const changedFiles = context.documents.map((file) => ({ ...file, path: "/elsewhere" }));
	assert.match(
		blocker(global, { ...catalogue, context: { ...context, documents: changedFiles } }) ?? "",
		/original file/,
	);
});

test("search uses words across catalogue metadata and never searches values", () => {
	assert.deepEqual(searchCatalogue([entry], "HiStory enabled"), [entry]);
	assert.deepEqual(searchCatalogue([entry], "false"), []);
	assert.deepEqual(searchCatalogue([entry], "No match"), []);
	assert.equal(pointer(["one/two", "a~b"]), "/one~1two/a~0b");
});

test("catalogue and tool replies match the target and the latest ticket", () => {
	const gate = responseGate();
	const first = gate.issue(targetKey(context));
	const second = gate.issue(targetKey(context));
	assert.equal(gate.accepts(first, targetKey(context)), false);
	assert.equal(gate.accepts(second, targetKey({ ...context, host: { ...context.host, pid: 6 } })), false);
	assert.equal(gate.accepts(second, targetKey({ ...context, projectTrusted: false })), true);
});

test("only an acknowledged write in the same document clears a draft", () => {
	const draft = begin(entry, "global", context, "set");
	const result: EditResult = {
		mode: "commit",
		outcome: "partial",
		summary: "Saved global.",
		documents: [
			{
				document: "pi-global",
				scope: "global",
				path: draft.path,
				outcome: "committed",
				before: null,
				after: "other",
				changes: [{ id: entry.id, scope: "global", action: "set", status: "ok", problems: [], notes: [] }],
			},
		],
	};
	assert.equal(compareResult(draft, result).saved, true);
	assert.equal(resultLabel(result, draft), "Saved");
	const [file] = result.documents;
	const [change] = file.changes;
	assert.equal(
		resultLabel(
			{ ...result, documents: [{ ...file, outcome: "conflict", changes: [{ ...change, status: "conflict" }] }] },
			draft,
		),
		"Not saved: changed elsewhere",
	);
	assert.equal(compareResult({ ...draft, path: "/other" }, result).saved, false);
	assert.equal(compareResult(draft, { ...result, mode: "preview" }).saved, false);
	assert.equal(compareResult(begin(entry, "project", context, "set"), result).saved, false);
});
