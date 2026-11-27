import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assess, type Grid, type HistoryCommit, parseGrid, partMapper, renderText, summariseHistory } from "./grid.mts";

const script = fileURLToPath(new URL("./grid.mts", import.meta.url));
const example = new URL("../references/example.md", import.meta.url);
const timeout = 5000;

function part(id: string, hides: string | null = `The ${id} representation`) {
	return { id, name: id.toUpperCase(), paths: [`${id}/`], hides };
}

function requirement(id: string, owner: string, dependencies: string[] = []) {
	return {
		id,
		text: `Do ${id}`,
		source: "Manual",
		owners: { [owner]: `${owner}/file.ts:1` },
		relies: Object.fromEntries(dependencies.map((to) => [to, `${owner}/file.ts:2`])),
		unknown: [] as string[],
	};
}

function change(id: string, edited: string[], unknown: string[] = []) {
	return {
		id,
		text: `Change ${id}`,
		source: "Manual",
		edits: Object.fromEntries(edited.map((p) => [p, `${p}/file.ts:1`])),
		unknown,
	};
}

function input() {
	return { subject: "Fixture", parts: [part("a"), part("b"), part("c")], requirements: [requirement("R1", "a")] };
}

function parse(value: unknown, options?: Parameters<typeof parseGrid>[1]) {
	return parseGrid(JSON.stringify(value), options);
}

function valid(value: unknown): Grid {
	const result = parse(value);
	if (!result.ok) assert.fail(JSON.stringify(result.errors));
	return result.grid;
}

async function assessed(value: unknown, options?: Parameters<typeof assess>[1]) {
	const result = await assess(valid(value), options);
	if (!result.ok) assert.fail(JSON.stringify(result.errors));
	return result;
}

function invalid(value: unknown, expected: [string, RegExp][], options?: Parameters<typeof parseGrid>[1]) {
	const result = parse(value, options);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.errors.length, expected.length, JSON.stringify(result.errors));
	for (const [location, fix] of expected) {
		const problem = result.errors.find((error) => error.location === location && fix.test(error.message));
		assert.ok(problem, `Expected ${location} with ${fix}; received ${JSON.stringify(result.errors)}`);
	}
}

function fixtureDirectory(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "decompose-grid-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function saveJson(dir: string, value: unknown): string {
	const path = join(dir, "grid.json");
	writeFileSync(path, JSON.stringify(value));
	return path;
}

function cli(args: string[], env = process.env) {
	const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout, env });
	assert.ifError(result.error);
	return result;
}

function parsedStdout(result: ReturnType<typeof cli>, status = 0) {
	assert.equal(result.status, status, result.stderr);
	assert.equal(result.stderr, "");
	return JSON.parse(result.stdout);
}

test("assess orders tied parts and requirements by declaration and a chain by reliance", async () => {
	const independent = await assessed({ ...input(), parts: [part("c"), part("b"), part("a")] });
	assert.equal(independent.order, "independent");
	assert.deepEqual(independent.layers, [{ layer: 0, nodes: ["c", "b", "a"] }]);
	const tied = await assessed({
		...input(),
		requirements: [requirement("R9", "b"), requirement("R6", "a"), requirement("R2", "a")],
	});
	assert.deepEqual(
		tied.requirements.map(({ id }) => id),
		["R6", "R2", "R9"],
	);
	assert.equal(independent.evidenceChecked, false);

	const chain = await assessed({
		...input(),
		requirements: [requirement("R2", "a", ["b"]), requirement("R3", "c"), requirement("R1", "b", ["c"])],
	});
	assert.equal(chain.order, "layered");
	assert.deepEqual(chain.layers, [
		{ layer: 0, nodes: ["c"] },
		{ layer: 1, nodes: ["b"] },
		{ layer: 2, nodes: ["a"] },
	]);
	assert.deepEqual(
		chain.nodes.map(({ id }) => id),
		["c", "b", "a"],
	);
	assert.deepEqual(
		chain.requirements.map(({ id }) => id),
		["R3", "R1", "R2"],
	);
	assert.deepEqual(chain.nodes[0].usedBy, ["b"]);
	assert.deepEqual(chain.nodes[0].leanedOnBy, ["a", "b"]);
	assert.deepEqual(chain.nodes[1].reliesOn, ["c"]);
});

test("assess reports a tangle with its internal edges and labels", async () => {
	const result = await assessed({
		...input(),
		requirements: [requirement("R1", "a", ["b"]), requirement("R2", "b", ["a"]), requirement("R3", "a", ["b"])],
	});
	assert.equal(result.order, "tangled");
	assert.deepEqual(result.nodes.find(({ id }) => id === "a")?.leanedOnBy, ["b"]);
	assert.deepEqual(result.nodes.find(({ id }) => id === "b")?.leanedOnBy, ["a"]);
	assert.match(renderText(result), /tangle: a, b rely on each other in a loop/);
	assert.deepEqual(result.tangles, [
		{
			parts: ["a", "b"],
			edges: [
				{
					from: "a",
					to: "b",
					labels: [
						{ kind: "requirement", requirement: "R1", evidence: "a/file.ts:2" },
						{ kind: "requirement", requirement: "R3", evidence: "a/file.ts:2" },
					],
				},
				{ from: "b", to: "a", labels: [{ kind: "requirement", requirement: "R2", evidence: "b/file.ts:2" }] },
			],
		},
	]);
});

test("a co-owner can rely on another owner and close a loop; each use keeps its evidence", async () => {
	const req = {
		...requirement("R1", "a"),
		owners: { a: "a/file.ts:1", b: "b/file.ts:1" },
		relies: { b: "a/file.ts:2 uses B", a: "b/file.ts:2 uses A", c: ["a/file.ts:3", "b/file.ts:3"] },
	};
	const grid = { ...input(), requirements: [req, requirement("R2", "c", ["a"])] };
	const result = await assessed(grid);
	assert.equal(result.order, "tangled");
	assert.deepEqual(result.tangles[0].parts, ["a", "b", "c"]);
	assert.deepEqual(result.requirements[0].cells, { a: "Ox", b: "Ox", c: "x" });
	assert.deepEqual(result.requirements[0].relies.c, ["a/file.ts:3", "b/file.ts:3"]);
	assert.deepEqual(
		result.tangles[0].edges.filter(({ to }) => to === "c"),
		[
			{ from: "a", to: "c", labels: [{ kind: "requirement", requirement: "R1", evidence: "a/file.ts:3" }] },
			{ from: "b", to: "c", labels: [{ kind: "requirement", requirement: "R1", evidence: "b/file.ts:3" }] },
		],
	);
	invalid({ ...grid, requirements: [{ ...req, relies: { a: ["b/file.ts:2", "a/file.ts:3"], c: [], b: [2] } }] }, [
		["requirements[0].relies.a[1]", /cannot rely on itself.*other owner/],
		["requirements[0].relies.c", /non-empty array/],
		["requirements[0].relies.b[0]", /non-empty string/],
	]);
});

test("a chain next to a cycle is not part of the tangle", async () => {
	const result = await assessed({
		...input(),
		parts: [...input().parts, part("d"), part("e")],
		requirements: [requirement("R1", "a", ["b", "e"]), requirement("R2", "b", ["a"]), requirement("R3", "c", ["d"])],
	});
	assert.deepEqual(
		result.tangles.map(({ parts }) => parts),
		[["a", "b"]],
	);
	assert.deepEqual(result.layers, [
		{ layer: 0, nodes: ["e", "d"] },
		{ layer: 1, nodes: ["a", "b", "c"] },
	]);
});

test("a shared decision orders its knowers even without requirement reliance", async () => {
	const result = await assessed({
		...input(),
		decisions: [{ id: "schema", name: "Schema", knownBy: { a: "a/file.ts:1", b: "b/file.ts:1" } }],
	});
	assert.equal(result.order, "layered");
	assert.deepEqual(result.layers, [
		{ layer: 0, nodes: ["schema", "c"] },
		{ layer: 1, nodes: ["a", "b"] },
	]);
	assert.deepEqual(
		result.changes.map(({ id, kind, width, totalParts }) => ({ id, kind, width, totalParts })),
		[{ id: "schema", kind: "decision", width: 2, totalParts: 3 }],
	);
	assert.deepEqual(result.candidates[0], { kind: "shared-decision", ids: ["schema", "a", "b"], count: 2 });
	assert.ok(result.candidates.some(({ kind, ids }) => kind === "unplaced-decision" && ids[0] === "schema"));
});

test("assess reports scattered and shared homes by count and declared order", async () => {
	const result = await assessed({
		...input(),
		parts: [part("c"), part("b", null), part("a"), part("d"), part("e")],
		decisions: [{ id: "schema", name: "Schema", knownBy: { a: "a/file.ts", b: "b/file.ts" } }],
		requirements: [
			{ ...requirement("R2", "a"), owners: { a: "a/file.ts", b: "b/file.ts", c: "c/file.ts" }, unknown: ["e"] },
			{ ...requirement("R1", "a"), owners: { a: "a/file.ts", b: "b/file.ts", c: "c/file.ts", d: "d/file.ts" } },
			requirement("R3", "a"),
		],
	});
	assert.deepEqual(result.homes, {
		scattered: [
			{ requirement: "R2", owners: ["a", "b", "c"] },
			{ requirement: "R1", owners: ["a", "b", "c", "d"] },
		],
		sharedHomes: [
			{ part: "a", requirements: ["R2", "R1", "R3"] },
			{ part: "c", requirements: ["R2", "R1"] },
			{ part: "b", requirements: ["R2", "R1"] },
		],
		noSecret: ["b"],
		idle: ["e"],
	});
	assert.deepEqual(
		result.candidates.map(({ kind, ids }) => [kind, ids[0]]),
		[
			["shared-decision", "schema"],
			["no-secret", "b"],
			["unplaced-decision", "schema"],
			["idle", "e"],
		],
	);
	assert.deepEqual(
		result.changes.map(({ id }) => id),
		["schema"],
	);
	const homes = renderText(result)
		.split("\n")
		.filter((line) => line.startsWith("Homes:"));
	assert.equal(homes.length, 2);
	assert.match(homes[0], /2 of 3 .*\(R2, R1\)/);
	assert.match(homes[1], /a owns 3.*c 2, b 2/);
	const none = await assessed({
		...input(),
		requirements: [requirement("R1", "a"), requirement("R2", "b"), requirement("R3", "c")],
	});
	assert.doesNotMatch(renderText(none), /^Homes:/m);
});

test("change rows order by width, kind and id; only declared rows count towards landings", async () => {
	const result = await assessed({
		...input(),
		requirements: [{ ...requirement("R1", "a"), owners: { a: "a/file.ts", b: "b/file.ts" } }],
		decisions: [{ id: "schema", name: "Schema", knownBy: { a: "a/file.ts", b: "b/file.ts" } }],
		changes: [change("Z", ["a", "b"], ["c"]), change("A", ["a", "b"]), change("Y", ["a"]), change("X", [], ["c"])],
	});
	assert.deepEqual(
		result.changes.map(({ id, kind, width }) => [id, kind, width]),
		[
			["A", "declared", 2],
			["Z", "declared", 2],
			["schema", "decision", 2],
			["Y", "declared", 1],
			["X", "declared", 0],
		],
	);
	assert.deepEqual(result.changes[1].cells, { a: "E", b: "E", c: "?" });
	assert.deepEqual(
		result.nodes
			.filter(({ kind }) => kind === "part")
			.map(({ id, landings }) => [id, landings])
			.sort(),
		[
			["a", 3],
			["b", 2],
			["c", 0],
		],
	);
});

test("assess checks named commits against the edits and unknown marks", async () => {
	const grid = {
		...input(),
		parts: [...input().parts, part("d")],
		changes: [{ ...change("C1", ["a", "b"], ["d"]), commits: ["a1b2c3d", "b1a2e3a"] }],
	};
	const result = await assessed(grid, {
		readCommit: (id) => (id === "a1b2c3d" ? ["a/file", "c/file", "unmapped"] : ["a/file", "d/file", "unmapped"]),
	});
	const [row] = result.changes;
	assert.deepEqual(row.observed, ["a", "c", "d"]);
	assert.deepEqual(row.reasonedOnly, ["b"]);
	assert.deepEqual(row.unmarked, ["c"]);
	assert.equal(row.unmappedFiles, 1);
	assert.deepEqual(row.cells, { a: "H", b: "E", c: "!", d: "?" });
	assert.match(renderText(result), /\| C1: Change C1 \| H \| E \| ! \| \? \| 2 of 4 \|/);
	const failed = await assess(valid(grid), {
		readCommit: (id) => {
			throw new Error(`Missing ${id}`);
		},
	});
	assert.equal(failed.ok, false);
	if (!failed.ok) {
		assert.deepEqual(
			failed.errors.map(({ location }) => location),
			["changes[0].commits[0]", "changes[0].commits[1]"],
		);
		assert.match(failed.errors[0].message, /Use a readable commit id/);
	}
});

test("validation: subject, mode, known fields and minimum list sizes", () => {
	invalid({ subject: " ", mode: "analysis", parts: [], requirements: [], extra: true }, [
		["subject", /Supply a non-empty string/],
		["mode", /Use "code" or "plan"/],
		["parts", /at least 2/],
		["requirements", /at least 1/],
		["extra", /Remove/],
	]);
	assert.equal(valid(input()).mode, "code");
	assert.deepEqual(valid(input()).decisions, []);
	assert.deepEqual(valid(input()).changes, []);
	assert.deepEqual(
		valid({ ...input(), changes: [{ ...change("C1", ["a"]), unknown: undefined }] }).changes[0].unknown,
		[],
	);
	invalid({ ...input(), requirements: [{ ...requirement("R1", "a"), unknown: null }] }, [
		["requirements[0].unknown", /Supply an array/],
	]);
	assert.deepEqual(parseGrid("{").ok, false);
	invalid([], [["$", /Supply one JSON object/]]);
});

test("validation: node namespace and unique requirement and change ids", () => {
	invalid(
		{
			...input(),
			parts: [...input().parts, { ...part("Invalid"), name: "" }, part("b")],
			decisions: [{ id: "b", name: "", knownBy: { a: "a/file", b: "b/file" } }],
			requirements: [requirement("R1", "a"), { ...requirement("R1", "a"), text: "" }],
			changes: [change("C1", ["a"]), change("C1", ["a"])],
		},
		[
			["parts[3].id", /lowercase/],
			["parts[3].name", /non-empty/],
			["parts[4].id", /unique/],
			["parts[4].paths[0]", /only one part/],
			["decisions[0].id", /unique/],
			["decisions[0].name", /non-empty/],
			["requirements[1].id", /unique/],
			["requirements[1].text", /non-empty/],
			["changes[1].id", /unique/],
		],
	);
});

test("validation: paths require code prefixes without absolute, parent or backslash forms or duplicates", () => {
	invalid(
		{
			...input(),
			parts: [
				{ ...part("a"), paths: ["a/", "/abs", "a/../x", "a\\b", ["C:", "abs"].join("/")] },
				{ ...part("b"), paths: ["./a/"] },
				{ ...part("c"), paths: [] },
			],
		},
		[
			["parts[0].paths[1]", /repository-relative/],
			["parts[0].paths[2]", /repository-relative/],
			["parts[0].paths[3]", /repository-relative/],
			["parts[0].paths[4]", /repository-relative/],
			["parts[1].paths[0]", /only one part/],
			["parts[2].paths", /non-empty/],
		],
	);
});

test("validation: hides is a non-empty string or null", () => {
	invalid({ ...input(), parts: [part("a", ""), part("b", null)] }, [["parts[0].hides", /describe.*or use null/i]]);
});

test("validation: knownBy is an object with at least two declared parts", () => {
	invalid(
		{
			...input(),
			decisions: [
				{ id: "schema", name: "Schema", knownBy: { a: "a/file" } },
				{ id: "other", name: "Other", knownBy: { a: "a/file", beyond: "b/file" } },
			],
		},
		[
			["decisions[0].knownBy", /at least two parts.*hides/],
			["decisions[1].knownBy.beyond", /Use a declared part id/],
		],
	);
});

test("validation: requirements require a source and owner, with disjoint known and unknown marks", () => {
	invalid(
		{
			...input(),
			requirements: [
				{ ...requirement("R1", "a", ["a", "b", "beyond"]), source: "", unknown: ["a", "b", "c", "c", "missing"] },
				{ ...requirement("R2", "a"), owners: {}, relies: undefined },
			],
		},
		[
			["requirements[0].source", /non-empty/],
			["requirements[0].relies.a", /cannot rely on itself.*place of use in the other owner/],
			["requirements[0].relies.beyond", /declared part or decision/],
			["requirements[0].unknown[0]", /Remove a/],
			["requirements[0].unknown[1]", /Remove b/],
			["requirements[0].unknown[3]", /only once/],
			["requirements[0].unknown[4]", /declared part or decision/],
			["requirements[1].owners", /at least one owner/],
		],
	);
});

test("validation: changes require a source and distinct edits and unknown parts, and check commit syntax", () => {
	invalid(
		{
			...input(),
			decisions: [{ id: "schema", name: "Schema", knownBy: { a: "a/file", b: "b/file" } }],
			changes: [
				{
					...change("C1", ["a", "schema"], ["a", "schema"]),
					source: null,
					commits: ["abcde", "p123456", "f".repeat(41)],
				},
				change("C2", []),
			],
		},
		[
			["changes[0].source", /non-empty/],
			["changes[0].edits.schema", /declared part id/],
			["changes[0].unknown[0]", /Remove a/],
			["changes[0].unknown[1]", /declared part id/],
			["changes[0].commits[0]", /7 to 40 hexadecimal/],
			["changes[0].commits[1]", /7 to 40 hexadecimal/],
			["changes[0].commits[2]", /7 to 40 hexadecimal/],
			["changes[1]", /Add at least one part/],
		],
	);
});

test("validation: code evidence has a location and belongs to the right part", () => {
	invalid(
		{
			...input(),
			parts: [...input().parts, { ...part("inner"), paths: ["a/inner/"] }],
			decisions: [{ id: "schema", name: "Schema", knownBy: { a: "b/file", b: "b/file:0" } }],
			requirements: [
				{
					...requirement("R1", "a"),
					owners: { a: "a/inner/file" },
					relies: { b: "a/inner/file:22", c: "a/file:no", inner: "" },
				},
			],
			changes: [{ ...change("C1", ["a"]), edits: { a: "c/file:1" } }],
		},
		[
			["decisions[0].knownBy.a", /inside part a/],
			["decisions[0].knownBy.b", /one-based/],
			["requirements[0].owners.a", /belongs to inner/],
			["requirements[0].relies.b", /inside part a/],
			["requirements[0].relies.c", /"a\/file:no".*src\/store\/record\.ts:8-21,40 field list/],
			["requirements[0].relies.inner", /non-empty/],
			["changes[0].edits.a", /inside part a/],
		],
	);
});

test("validation: the owner that directly uses a decision is a knower", async () => {
	const req = {
		...requirement("R1", "a"),
		owners: { a: "a/file", b: "b/file" },
		relies: { schema: "b/file:1 use here" },
	};
	const grid = {
		...input(),
		decisions: [{ id: "schema", name: "Schema", knownBy: { a: "a/file", c: "c/file" } }],
		requirements: [req],
	};
	invalid(grid, [["requirements[0].relies.schema", /List b.*knownBy/]]);
	const result = await assessed({ ...grid, requirements: [{ ...req, relies: { schema: "a/file:1 use here" } }] });
	assert.deepEqual(result.nodes.find(({ id }) => id === "b")?.reliesOn, []);
});

test("validation: --repo checks existence, file line counts and directory citations", (t) => {
	const repo = fixtureDirectory(t);
	for (const id of ["a", "b"]) mkdirSync(join(repo, id));
	writeFileSync(join(repo, "a/file.ts"), "first\r\nsecond");
	writeFileSync(join(repo, "b/file.ts"), "one line\n");
	mkdirSync(join(repo, "b/dir"));
	symlinkSync(tmpdir(), join(repo, "a/outside"));
	const grid = {
		...input(),
		requirements: [
			{ ...requirement("R1", "a"), owners: { a: "a/file.ts:3", b: "b/dir:1", c: "c/missing.ts" } },
			{ ...requirement("R2", "a"), owners: { a: "a/file.ts:2", b: "b/dir" } },
			{ ...requirement("R3", "a"), owners: { a: "a/outside" } },
			{ ...requirement("R4", "b"), owners: { b: "b/file.ts:2" } },
		],
	};
	assert.equal(parse(grid).ok, true);
	invalid(
		grid,
		[
			["requirements[0].owners.a", /existing line.*has 2 lines/],
			["requirements[0].owners.b", /Remove the line number/],
			["requirements[0].owners.c", /existing file or directory/],
			["requirements[2].owners.a", /inside --repo/],
			["requirements[3].owners.b", /existing line.*has 1 lines/],
		],
		{ repo },
	);
});

test("repository validation checks existing prefix kinds and accepts absent historical paths", (t) => {
	const repo = fixtureDirectory(t);
	mkdirSync(join(repo, "a"));
	writeFileSync(join(repo, "a/file.ts"), "present\n");
	const grid = {
		...input(),
		parts: [
			{ ...part("a"), paths: ["a/", "a", "a/file.ts/", "a/historical.ts", "a/file.ts/former-child/"] },
			part("b"),
		],
	};
	assert.equal(parse(grid).ok, true);
	for (const command of ["assess", "history"] as const) {
		invalid(
			grid,
			[
				["parts[0].paths[1]", /End a directory prefix with "\/"/],
				["parts[0].paths[2]", /Remove the trailing "\/" from a file path/],
			],
			{ command, repo },
		);
	}
});

test("mapping selects the longest prefix and distinguishes exact files and directory boundaries", () => {
	const map = partMapper([
		{ id: "outer", paths: ["src/"] },
		{ id: "nested", paths: ["src/child/"] },
		{ id: "exact", paths: ["src/child/file.ts"] },
	]);
	assert.equal(map("src/child/file.ts"), "exact");
	assert.equal(map("src/child/file.ts.bak"), "nested");
	assert.equal(map("src/childish/new.ts"), "outer");
	assert.equal(map("src/child"), "outer");
	assert.equal(map("src/child/"), "nested");
	assert.equal(map("src/"), "outer");
	assert.equal(map("src"), undefined);
	assert.equal(map("elsewhere"), undefined);
});

test("plan mode uses the named owner for each citation; history validates its own fields", async (t) => {
	const grid = {
		...input(),
		mode: "plan",
		parts: [part("a"), { ...part("b"), paths: [] }, { ...part("c"), paths: undefined }],
		requirements: [
			{
				...requirement("R1", "a"),
				owners: { a: "A will hold the job.", b: "B defines the job interface." },
				relies: { c: ["a: Uses C.", "b: Also uses C."], b: "a: Uses B." },
			},
		],
	};
	const result = await assessed(grid, { evidenceChecked: true });
	assert.equal(result.evidenceChecked, false);
	assert.deepEqual(result.layers, [
		{ layer: 0, nodes: ["c"] },
		{ layer: 1, nodes: ["b"] },
		{ layer: 2, nodes: ["a"] },
	]);
	assert.deepEqual(result.nodes[0].usedBy, ["a", "b"]);
	assert.equal(result.order, "layered");
	const req = grid.requirements[0];
	invalid(
		{
			...grid,
			requirements: [{ ...req, relies: { b: ["Uses B", "c: Uses B", "b: Uses itself", "a:Uses B", "a: "] } }],
		},
		[
			["requirements[0].relies.b[0]", /<owner-id>: <evidence>/],
			["requirements[0].relies.b[1]", /<owner-id>: <evidence>/],
			["requirements[0].relies.b[2]", /cannot rely on itself.*<owner-id>: <evidence>/],
			["requirements[0].relies.b[3]", /<owner-id>: <evidence>/],
			["requirements[0].relies.b[4]", /<owner-id>: <evidence>/],
		],
	);
	const sole = await assessed({
		...grid,
		requirements: [{ ...req, owners: { a: "A owns this." }, relies: { b: "Uses B." } }],
	});
	assert.deepEqual(sole.nodes.find(({ id }) => id === "b")?.usedBy, ["a"]);
	invalid({ ...grid, requirements: [{ ...req, owners: { a: "A owns this." }, relies: { a: "Its own work." } }] }, [
		["requirements[0].relies.a", /cannot rely on itself/],
	]);
	const dir = fixtureDirectory(t);
	const plan = saveJson(dir, grid);
	const refused = cli(["history", plan, "--repo", dir]);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /mode: Use a code grid/);
	assert.equal(
		parse({ ...input(), requirements: null, decisions: "not a list", changes: {}, extra: true }, { command: "history" })
			.ok,
		true,
	);
});

test("Markdown tables preserve column order, cell marks, legends and exactly forty rows", async () => {
	const result = await assessed({
		...input(),
		parts: [part("a"), { ...part("b"), name: "B | name\npart" }, part("c")],
		decisions: [{ id: "schema", name: "Shared | schema\ncomment", knownBy: { a: "a/file.ts", b: "b/file.ts" } }],
		requirements: Array.from({ length: 42 }, (_, i) => ({
			...requirement(`R${String(i).padStart(2, "0")}`, "a", ["schema"]),
			text: "a | b\nnext",
			unknown: ["b"],
		})),
		changes: [change("C1", ["a"], ["b"])],
	});
	const text = renderText(result);
	assert.match(text, /\| Requirement \| shared: schema \| c \| a \| b \|/);
	assert.match(text, /Layer 0: schema \(shared\), c/);
	assert.match(text, /\| Node \| Name \| Layer \| Used by \| Leaned on by \| Owns \| Edited by \| Hides \|/);
	assert.ok(text.includes("| shared: schema | Shared \\| schema<br>comment | 0 | a, b | 2: a, b |  |  |  |"));
	assert.ok(text.includes("| b | B \\| name<br>part | 1 |  | 0 |  |  | The b representation |"));
	assert.match(text, /\| Change \| c \| a \| b \| Width \|/);
	assert.ok(text.includes("| decision schema: Shared \\| schema<br>comment |"));
	assert.match(text, /^shared-decision schema: known by 2 of 3 parts \(a, b\), owned by none$/m);
	assert.doesNotMatch(text, /unplaced-decision schema/);
	assert.deepEqual(result.nodes.find(({ id }) => id === "a")?.editedBy, ["C1"]);
	assert.match(text, /\| R00: a \\\| b<br>next \| x \| {2}\| O \| \? \|/);
	assert.match(text, /\| C1: Change C1 \| {2}\| E \| \? \| 1 of 3 \|/);
	assert.match(text, /^Requirements legend:/m);
	assert.match(text, /^Changes legend:/m);
	assert.match(text, /2 more rows omitted/);
	assert.equal(text.match(/^\| R\d\d:/gm)?.length, 40);
	assert.equal(result.requirements.length, 42);
});

test("history summarises only non-bulk commits and includes pair shares, all spread buckets and unmapped directories", async () => {
	const grid = valid({ ...input(), parts: [...input().parts, part("d")] });
	const data = [
		["a/file", "b/file", "c/file", "d/file", "x/a"],
		["a/file", "b/file", "c/file"],
		["a/file", "b/file", "x/a"],
		["a/file", "a/other", "x/a"],
		["README.md", "y/file"],
		["a/file", "b/file", "c/file", "d/file", "x/a", "x/b"],
	];
	const commits: HistoryCommit[] = data.map((files, i) => ({
		id: String(1234569 + i),
		date: `2025-01-0${7 - i}`,
		subject: "s".repeat(101),
		files,
	}));
	const summary = await summariseHistory(grid, commits, { bulk: 5, top: 1 });
	assert.equal(summary.window.commits, 6);
	assert.equal(summary.window.oldest, "2025-01-02");
	assert.equal(summary.window.newest, "2025-01-07");
	assert.deepEqual(summary.bulk, {
		commits: 1,
		largest: [{ id: "1234574", date: "2025-01-02", files: 6, parts: 4, subject: "s".repeat(100) }],
	});
	assert.match(renderText(summary), /^\| 1234574 \| 2025-01-02 \| 6 \| 4 \| s+ \|$/m);
	assert.doesNotMatch(renderText(summary), /older commits not read/);
	const capped = await summariseHistory(grid, commits, { bulk: 5, maxCommits: 6 });
	assert.match(renderText(capped), /\(limit 6 reached, older commits not read\)/);
	assert.deepEqual(summary.mapping, {
		mappedFiles: 11,
		unmappedFiles: 5,
		commitsWithNoPart: 1,
		unmappedDirectories: [
			{ directory: "x", files: 3 },
			{ directory: ".", files: 1 },
			{ directory: "y", files: 1 },
		],
		topUnmappedFiles: [
			{ path: "x/a", commits: 3 },
			{ path: "README.md", commits: 1 },
			{ path: "y/file", commits: 1 },
		],
		unmatchedPaths: [],
	});
	assert.deepEqual(
		summary.parts.map(({ id, commits, alone, together }) => [id, commits, alone, together]),
		[
			["a", 4, 1, 3],
			["b", 3, 0, 3],
			["c", 2, 0, 2],
			["d", 1, 0, 1],
		],
	);
	assert.deepEqual(summary.spread, { one: 1, two: 1, three: 1, fourOrMore: 1 });
	assert.deepEqual(summary.pairs[0], {
		parts: ["a", "b"],
		count: 3,
		shares: [0.75, 1],
		grid: { relies: [], decisions: [] },
	});
	assert.equal(summary.pairs.length, 6);
	assert.equal(summary.widest[0].width, 4);
	assert.equal(summary.widest[0].subject.length, 100);
	assert.equal(summary.widest.length, 3);
	const text = renderText(summary);
	assert.match(text, /75\.0% \| 100\.0% \| not explained/);
	assert.match(text, /5 more rows omitted/);
	assert.match(text, /… 2 more commits changed two or more parts\./);
	assert.doesNotMatch(text, /Paths that matched no changed file:/);
});

test("history ranks unmapped paths by commit count and finds unused prefixes after skips and bulk", async () => {
	const grid = valid({
		...input(),
		skip: ["aaaaaaa"],
		parts: [
			{ ...part("z"), paths: ["bulk/", "src/", "missing.ts"] },
			{ ...part("a"), paths: ["src/file.ts", "skipped/", "a/"] },
		],
	});
	const date = "2025-01-02";
	const others = Array.from({ length: 10 }, (_, i) => `other/${i}`);
	const summary = await summariseHistory(
		grid,
		[
			{ id: "aaaaaaa", date, subject: "Skipped", files: ["skipped/file.ts", "ignored.ts"] },
			{ id: "bbbbbbb", date, subject: "Bulk", files: [...others, "bulk/only.ts", "also-ignored.ts"] },
			{ id: "ccccccc", date, subject: "Kept", files: [...others, "src/file.ts", "other/9"] },
			{ id: "ddddddd", date, subject: "Kept", files: ["other/9", "other/z", "a/file.ts"] },
		],
		{ bulk: 11, top: 1 },
	);
	assert.deepEqual(summary.mapping.unmatchedPaths, [
		{ part: "z", path: "bulk/" },
		{ part: "z", path: "src/" },
		{ part: "z", path: "missing.ts" },
		{ part: "a", path: "skipped/" },
	]);
	assert.deepEqual(summary.mapping.topUnmappedFiles, [
		{ path: "other/9", commits: 2 },
		...others.slice(0, 9).map((path) => ({ path, commits: 1 })),
	]);
	assert.equal(summary.parts.find(({ id }) => id === "z")?.commits, 0);
	const text = renderText(summary);
	assert.match(
		text,
		/^Window: 4 non-merge commits read \(limit 2000\), committed 2025-01-02 to 2025-01-02;[^\n]+\nPaths that matched no changed file: bulk\/ \(z\), src\/ \(z\), missing\.ts \(z\), skipped\/ \(a\)$/m,
	);
	assert.match(
		text,
		/Top unmapped directories:[\s\S]+\n\nTop unmapped files:\n\| Path \| Commits \|\n\| --- \| --- \|\n\| other\/9 \| 2 \|/,
	);
});

function testGitEnvironment(dir: string): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
		HOME: dir,
		XDG_CONFIG_HOME: dir,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(dir, "absent.gitconfig"),
		GIT_AUTHOR_NAME: "Fixture Author",
		GIT_AUTHOR_EMAIL: "author@example.test",
		GIT_COMMITTER_NAME: "Fixture Committer",
		GIT_COMMITTER_EMAIL: "committer@example.test",
	};
}

function gitFixture(t: TestContext) {
	const dir = fixtureDirectory(t);
	const env = testGitEnvironment(dir);
	const git = (args: string[], day = 1, input?: string) =>
		execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			timeout,
			input,
			env: { ...env, GIT_AUTHOR_DATE: `2025-02-0${day}T12:00:00Z`, GIT_COMMITTER_DATE: `2025-02-0${day}T12:00:00Z` },
		}).trim();
	git(["init", "-q", "-b", "main", "--template="]);
	return { dir, env, git };
}

test("shallow history sets aside boundary commits and assess rejects them as evidence", (t) => {
	const { dir, env, git } = gitFixture(t);
	for (const id of ["a", "b"]) {
		mkdirSync(join(dir, id));
		writeFileSync(join(dir, id, "file.ts"), "Initial\n");
	}
	git(["add", "a", "b"]);
	git(["commit", "-qm", "Initial"]);
	writeFileSync(join(dir, "b/file.ts"), "Boundary\n");
	git(["commit", "-qam", "Boundary"], 2);
	const boundary = git(["rev-parse", "HEAD"]).slice(0, 12);
	writeFileSync(join(dir, "a/file.ts"), "Tip\n");
	git(["commit", "-qam", "Tip"], 3);
	const clone = join(dir, "shallow copy");
	git(["clone", "-q", "--template=", "--depth", "2", pathToFileURL(dir).href, clone]);
	const file = saveJson(dir, { ...input(), changes: [{ ...change("C1", ["a"]), commits: [boundary] }] });
	const historyArgs = ["history", file, "--repo", clone, "--max-commits", "2"];
	for (const flags of [[], ["--pair", "a,b"]]) {
		const text = cli([...historyArgs, ...flags], env);
		assert.equal(text.status, 0, text.stderr);
		assert.match(
			text.stdout,
			/^Window: 1 non-merge commits read \(limit 2 reached, older commits not read\), committed 2025-02-03 to 2025-02-03;.* Shallow clone: 1 boundary commits set aside; older history is not present\.$/m,
		);
		const result = parsedStdout(cli([...historyArgs, ...flags, "--format", "json"], env));
		assert.equal(result.window.shallow, true);
		assert.equal(result.window.boundaryCommits, 1);
		assert.equal(result.window.commits, 1);
		if (flags.length) assert.deepEqual(result.pair, { parts: ["a", "b"], total: 0, commits: [] });
		else {
			assert.deepEqual(result.pairs, []);
			assert.deepEqual(result.widest, []);
			assert.deepEqual(result.spread, { one: 1, two: 0, three: 0, fourOrMore: 0 });
			assert.equal(result.mapping.mappedFiles, 1);
		}
	}
	const failure = parsedStdout(cli(["assess", file, "--repo", clone, "--format", "json"], env), 1);
	assert.equal(failure.errors[0].location, "changes[0].commits[0]");
	assert.ok(failure.errors[0].message.includes(boundary));
	assert.match(failure.errors[0].message, /shallow clone.*Fetch more history or remove the id/);
});

test("directory evidence maps a part root and a nested part to their longest prefixes", (t) => {
	const repo = fixtureDirectory(t);
	mkdirSync(join(repo, "src/core"), { recursive: true });
	const grid = {
		...input(),
		parts: [
			{ ...part("a"), paths: ["src/"] },
			{ ...part("b"), paths: ["src/core/"] },
		],
		requirements: [
			{ ...requirement("R1", "a"), owners: { a: "src/" } },
			{ ...requirement("R2", "b"), owners: { b: "src/core/ root" }, relies: { a: "src/core/ uses the outer part" } },
		],
	};
	const file = saveJson(repo, grid);
	const result = parsedStdout(cli(["assess", file, "--repo", repo, "--format", "json"]));
	assert.deepEqual(
		result.layers.map(({ nodes }: { nodes: string[] }) => nodes),
		[["a"], ["b"]],
	);
	invalid(
		{ ...grid, requirements: [{ ...grid.requirements[0], owners: { a: "src/core/" } }] },
		[["requirements[0].owners.a", /this path belongs to b/]],
		{ repo },
	);
});

test("a note may hold a colon and digits when no declared path has a space", async () => {
	const evidence = "a/file.ts see step 2:9";
	const grid = { ...input(), requirements: [{ ...requirement("R1", "a"), owners: { a: evidence } }] };
	const result = await assessed(grid);
	assert.equal(result.requirements[0].owners.a, evidence);
});

test("line citations with spaced paths work in assess and history", (t) => {
	const { dir, env, git } = gitFixture(t);
	for (const [folder, contents] of [
		["src/my dir", "first\nsecond\n"],
		["b", "first\n"],
	]) {
		mkdirSync(join(dir, folder), { recursive: true });
		writeFileSync(join(dir, folder, "file.ts"), contents);
	}
	git(["add", "src", "b"]);
	git(["commit", "-qm", "Two parts"]);
	const grid = {
		...input(),
		parts: [{ ...part("a"), paths: ["src/my dir/"] }, part("b")],
		requirements: [
			{
				...requirement("R1", "a"),
				owners: { a: "src/my dir/file.ts:1-2,2" },
				relies: { b: "src/my dir/file.ts:2 calls B:9" },
			},
		],
	};
	const file = saveJson(dir, grid);
	const assessment = parsedStdout(cli(["assess", file, "--repo", dir, "--format", "json"], env));
	assert.equal(assessment.evidenceChecked, true);
	assert.deepEqual(
		assessment.layers.map(({ nodes }: { nodes: string[] }) => nodes),
		[["b"], ["a"]],
	);
	const history = parsedStdout(cli(["history", file, "--repo", dir, "--format", "json"], env));
	assert.equal(history.mapping.mappedFiles, 2);
	assert.deepEqual(history.pairs[0].grid, { relies: [["a", "b"]], decisions: [] });
	const bad = { ...grid, requirements: [{ ...grid.requirements[0], owners: { a: "src/my dir/file.ts" } }] };
	for (const [repo, errors] of [
		[undefined, 1],
		[dir, 2],
	] as const) {
		const result = parse(bad, { repo });
		assert.equal(result.ok, false);
		if (result.ok) continue;
		assert.equal(result.errors.length, errors);
		for (const error of result.errors)
			assert.ok(error.message.endsWith('A path with a space needs a line number after it, as in "src/my dir/a.ts:1".'));
	}
});

test("real Git counts both sides of a rename, compares a named merge with its first parent, and excludes empty commits from mapping", (t) => {
	const dir = fixtureDirectory(t);
	const env = testGitEnvironment(dir);
	const git = (args: string[], day = 1) =>
		execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			timeout,
			env: {
				...env,
				GIT_AUTHOR_DATE: `2025-01-0${day}T15:00:00Z`,
				GIT_COMMITTER_DATE: `2025-01-0${day}T15:00:00Z`,
			},
		}).trim();
	git(["init", "-q", "-b", "main", "--template="]);
	for (const id of ["a", "b"]) mkdirSync(join(dir, id));
	writeFileSync(join(dir, "a/file.ts"), "first\nsecond\n");
	git(["add", "a"]);
	git(["commit", "-qm", "Initial | subject"]);
	git(["checkout", "-qb", "feature"]);
	writeFileSync(join(dir, "b/\nodd\tname"), "first\n");
	git(["add", "b"]);
	git(["commit", "-qm", "Feature"], 2);
	git(["checkout", "-q", "main"]);
	git(["commit", "--allow-empty", "--allow-empty-message", "-qm", ""], 3);
	git(["merge", "-q", "--no-ff", "-m", "Merge", "feature"], 4);
	const id = git(["rev-parse", "HEAD"]).slice(0, 12);
	const file = saveJson(dir, {
		...input(),
		parts: [part("a"), { ...part("b"), paths: ["b/\nodd\tname", "b/citations/"] }],
		requirements: [{ ...requirement("R1", "a", ["b"]), relies: { b: "a/file.ts:2 directly calls B" } }],
		changes: [{ ...change("C1", ["a"]), commits: [id] }],
	});
	const history = parsedStdout(cli(["history", file, "--repo", dir, "--format", "json", "--max-commits", "3"], env));
	assert.equal(history.window.commits, 3);
	assert.equal(Date.parse(history.window.oldest), Date.parse("2025-01-01T15:00:00Z"));
	assert.equal(Date.parse(history.window.newest), Date.parse("2025-01-03T15:00:00Z"));
	assert.deepEqual(history.spread, { one: 2, two: 0, three: 0, fourOrMore: 0 });
	assert.equal(history.mapping.commitsWithNoPart, 0);
	assert.equal(history.window.shallow, false);
	assert.equal(history.window.boundaryCommits, 0);
	assert.equal(history.mapping.unmappedFiles, 0);
	assert.deepEqual(history.widest, []);
	const filtered = parsedStdout(
		cli(
			["history", file, "--repo", dir, "--format", "json", "--since", "2025-01-02T00:00:00Z", "--max-commits", "1"],
			env,
		),
	);
	assert.equal(filtered.window.commits, 1);
	assert.equal(Date.parse(filtered.window.newest), Date.parse("2025-01-03T15:00:00Z"));
	const empty = parsedStdout(cli(["history", file, "--repo", dir, "--format", "json", "--max-commits", "0"], env));
	assert.equal(empty.window.commits, 0);
	assert.equal(empty.window.oldest, null);
	assert.equal(empty.window.newest, null);
	const assessment = parsedStdout(cli(["assess", file, "--repo", dir, "--format", "json"], env));
	assert.equal(assessment.evidenceChecked, true);
	assert.equal(assessment.order, "layered");
	assert.deepEqual(assessment.changes[0].observed, ["b"]);
	assert.deepEqual(assessment.changes[0].reasonedOnly, ["a"]);
	assert.deepEqual(assessment.changes[0].unmarked, ["b"]);
	assert.equal(assessment.changes[0].unmappedFiles, 0);
	git(["mv", "b/\nodd\tname", "a/moved.ts"]);
	git(["commit", "-qm", "Mechanical move"], 5);
	const moved = git(["rev-parse", "HEAD"]);
	const movedGrid = saveJson(dir, {
		...input(),
		parts: [part("a"), { ...part("b"), paths: ["b/\nodd\tname"] }],
		requirements: [requirement("R1", "a", ["b"])],
		changes: [{ ...change("C1", ["a"]), commits: [moved] }],
	});
	const moveHistory = parsedStdout(
		cli(["history", "--repo", dir, "--max-commits", "1", movedGrid, "--format", "json"], env),
	);
	assert.deepEqual(moveHistory.widest[0].parts, ["a", "b"]);
	assert.deepEqual(moveHistory.pairs[0].grid, { relies: [["a", "b"]], decisions: [] });
	const moveAssess = parsedStdout(cli(["assess", "--repo", dir, movedGrid, "--format", "json"], env));
	assert.deepEqual(moveAssess.changes[0].observed, ["a", "b"]);
	const skipped = parsedStdout(
		cli(
			[
				"history",
				"--skip",
				`${moved.slice(0, 9).toUpperCase()},1234567`,
				"--repo",
				dir,
				movedGrid,
				"--max-commits",
				"1",
				"--format",
				"json",
			],
			env,
		),
	);
	assert.deepEqual(
		skipped.skipped.commits.map(({ id }: { id: string }) => id),
		[moved],
	);
	assert.deepEqual(skipped.skipped.unmatched, ["1234567"]);
	assert.deepEqual(skipped.pairs, []);
	const incomplete = saveJson(dir, { subject: "Incomplete", parts: [part("a"), part("b")], requirements: "not yet" });
	const incompleteHistory = parsedStdout(cli(["history", incomplete, "--repo", dir, "--format", "json"], env));
	assert.equal(incompleteHistory.pairs[0].grid, null);
});

test("assess names a missing commit from the real Git reader and exits 1", (t) => {
	const { dir, env, git } = gitFixture(t);
	mkdirSync(join(dir, "a"));
	writeFileSync(join(dir, "a/file.ts"), "first\n");
	git(["add", "a"]);
	git(["commit", "-qm", "Initial"]);
	const missing = "0".repeat(40);
	const file = saveJson(dir, { ...input(), changes: [{ ...change("C1", ["a"]), commits: [missing] }] });
	const failure = parsedStdout(cli(["assess", file, "--repo", dir, "--format", "json"], env), 1);
	assert.equal(failure.errors.length, 1);
	assert.equal(failure.errors[0].location, "changes[0].commits[0]");
	assert.ok(failure.errors[0].message.includes(missing));
});

test("history JSON caps widest commits and pairs but retains totals", (t) => {
	const { dir, env, git } = gitFixture(t);
	const parts = Array.from({ length: 22 }, (_, i) => part(`p${String(i).padStart(2, "0")}`));
	const data = Array.from({ length: 202 }, (_, i) => {
		const paths = (i === 0 ? parts : parts.slice(0, 2)).map(
			({ id }) => `M 100644 inline ${id}/file\ndata 3\n${String(i).padStart(3, "0")}`,
		);
		return [
			"commit refs/heads/main",
			`committer Fixture Committer <committer@example.test> ${1738368000 + i} +0000`,
			"data 7",
			"Fixture",
			...paths,
			"",
		].join("\n");
	});
	git(["fast-import", "--quiet"], 1, `${data.join("\n")}\ndone\n`);
	const file = saveJson(dir, { subject: "Fixture", parts });
	const args = ["history", file, "--repo", dir];
	for (const [flags, size] of [
		[[], 200],
		[["--top", "201"], 201],
	] as const) {
		const result = parsedStdout(cli([...args, ...flags, "--format", "json"], env));
		assert.equal(result.widestTotal, 202);
		assert.equal(result.pairsTotal, 231);
		assert.equal(result.widest.length, size);
		assert.equal(result.pairs.length, size);
		assert.equal(result.widest[0].width, 22);
		assert.equal(result.pairs[0].count, 202);
	}
	const text = cli([...args, "--top", "201"], env);
	assert.equal(text.status, 0, text.stderr);
	assert.match(text.stdout, /191 more rows omitted/);
	assert.match(text.stdout, /162 more commits changed two or more parts/);
});

test("history --pair lists matching commits newest first and excludes skipped and bulk commits", (t) => {
	const dir = fixtureDirectory(t);
	const env = testGitEnvironment(dir);
	const git = (args: string[], day = 1) =>
		execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			timeout,
			env: { ...env, GIT_AUTHOR_DATE: `2025-02-0${day}T12:00:00Z`, GIT_COMMITTER_DATE: `2025-02-0${day}T12:00:00Z` },
		}).trim();
	git(["init", "-q", "-b", "main", "--template="]);
	for (const id of ["a", "b", "c"]) mkdirSync(join(dir, id));
	const commit = (day: number, subject: string, names: string[]) => {
		for (const path of names) writeFileSync(join(dir, path), String(day));
		git(["add", "--", ...names]);
		git(["commit", "-qm", subject], day);
		return git(["rev-parse", "HEAD"]);
	};
	const older = commit(1, "Earlier change", ["a/file.ts", "b/file.ts"]);
	const newer = commit(2, "N".repeat(102), ["a/file.ts", "b/file.ts", "c/file.ts"]);
	const gridSkip = commit(3, "Set aside by grid", ["a/file.ts", "b/file.ts"]);
	commit(4, "Bulk", ["a/file.ts", "b/file.ts", "c/file.ts", "README"]);
	commit(5, "Only A", ["a/file.ts"]);
	const cliSkip = commit(6, "Set aside by flag", ["a/file.ts", "b/file.ts"]);
	const grid = input();
	grid.parts[0].paths.push("misspelled/");
	const file = saveJson(dir, { ...grid, skip: [gridSkip.slice(0, 7).toUpperCase()] });
	const args = [
		"history",
		"--pair",
		"b,a",
		file,
		"--repo",
		dir,
		"--bulk",
		"3",
		"--skip",
		`${cliSkip.slice(0, 12)},${gridSkip.slice(0, 7)}`,
		"--top",
		"1",
	];
	const text = cli(args, env);
	assert.equal(text.status, 0, text.stderr);
	assert.match(
		text.stdout,
		/^Subject: Fixture\nWindow: 6 non-merge commits read .*skipped by request: 2; bulk: set aside 1 commits over 3 files;[^\n]*\nCommits that changed both b and a: 2\n/,
	);
	assert.ok(text.stdout.includes(`| ${newer.slice(0, 7)} | 2025-02-02 | c | ${"N".repeat(100)} |`));
	assert.doesNotMatch(
		text.stdout,
		/Per part:|Skipped by request:|Pairs:|Earlier change|Bulk|Only A|Top unmapped files:|Paths that matched no changed file:/,
	);
	assert.match(text.stdout, /… 1 more commit changed both b and a\./);
	const json = parsedStdout(cli([...args, "--format", "json"], env));
	assert.deepEqual(Object.keys(json).sort(), ["ok", "pair", "subject", "window"]);
	assert.deepEqual(Object.keys(json.window.mapping).sort(), ["commitsWithNoPart", "mappedFiles", "unmappedFiles"]);
	assert.deepEqual(json.pair.parts, ["b", "a"]);
	assert.equal(json.pair.total, 2);
	assert.deepEqual(
		json.pair.commits.map(({ id, otherParts, subject }: { id: string; otherParts: string[]; subject: string }) => [
			id,
			otherParts,
			subject,
		]),
		[
			[newer.slice(0, 7), ["c"], "N".repeat(100)],
			[older.slice(0, 7), [], "Earlier change"],
		],
	);
	assert.equal(Date.parse(json.pair.commits[0].date), Date.parse("2025-02-02T12:00:00Z"));
	for (const pair of ["a,a", "a,missing", "a", "a,b,c"]) {
		const bad = cli(["history", file, "--repo", dir, "--pair", pair], env);
		assert.equal(bad.status, 2);
		assert.equal(bad.stdout, "");
		assert.match(bad.stderr, /--pair/);
	}
	assert.equal(cli(["assess", file, "--pair", "a,b"], env).status, 2);
});

test("CLI help, exit status, and JSON diagnostics", (t) => {
	const dir = fixtureDirectory(t);
	for (const args of [["--help"], ["-h"], []]) {
		const result = cli(args);
		assert.equal(result.status, args.length ? 0 : 2);
		assert.match(result.stdout, /Usage:.*<command>/);
		assert.match(result.stdout, /--skip <ids>/);
		assert.match(result.stdout, /--pair <a>,<b>/);
		assert.match(result.stdout, /<path>\[:<lines>\]\[ <note>\]/);
		assert.match(result.stdout, /src\/store\/record\.ts:8-21,40 field list/);
	}
	assert.equal(cli(["unknown", "grid.json"]).status, 2);
	assert.equal(cli(["assess", join(dir, "absent.json")]).status, 2);
	assert.equal(cli(["assess", "grid.json", "--top", "1"]).status, 2);
	assert.equal(cli(["history", "grid.json", "--repo", dir, "--max-commits", "20001"]).status, 2);
	const invalidPath = saveJson(dir, { ...input(), subject: "", extra: true });
	const badText = cli(["assess", invalidPath]);
	assert.equal(badText.status, 1);
	assert.equal(badText.stdout, "");
	assert.match(badText.stderr, /^subject: Supply[^\n]+\nextra: Remove/m);
	const badJson = parsedStdout(cli(["assess", invalidPath, "--format", "json"]), 1);
	assert.equal(badJson.ok, false);
	assert.equal(badJson.errors.length, 2);
	const validPath = saveJson(dir, input());
	assert.equal(parsedStdout(cli(["assess", "--format", "json", validPath])).ok, true);
	assert.match(cli(["assess", validPath, "other.json"]).stderr, /Supply one grid file/);
	for (const skip of ["abcdef", "abcdefg", `${"f".repeat(41)}`, "abcdef0,"]) {
		const problem = cli(["history", "--skip", skip, validPath, "--repo", dir]);
		assert.equal(problem.status, 2);
		assert.match(problem.stderr, /Use comma-separated commit ids/);
	}
	const env = testGitEnvironment(dir);
	const gitFailure = cli(["history", validPath, "--repo", dir, "--format", "json"], env);
	assert.equal(gitFailure.status, 2);
	assert.equal(gitFailure.stdout, "");
	assert.match(gitFailure.stderr, /not a git repository/i);
});

test("code evidence accepts several inclusive ranges and checks every range against the file", (t) => {
	const repo = fixtureDirectory(t);
	mkdirSync(join(repo, "a"));
	writeFileSync(join(repo, "a/file.ts"), "one\ntwo\nthree\n");
	const withCitation = (citation: string) => ({
		...input(),
		requirements: [{ ...requirement("R1", "a"), owners: { a: citation } }],
	});
	for (const citation of [
		"a/file.ts:1-3 calls service",
		"a/file.ts:3-3",
		"a/file.ts:2",
		"a/file.ts",
		"a/file.ts:1-2,3,1 field list",
	]) {
		assert.equal(parse(withCitation(citation), { repo }).ok, true, citation);
	}
	for (const citation of [
		"a/file.ts:0-2",
		"a/file.ts:3-2",
		"a/file.ts:2-",
		"a/file.ts:2-3-4",
		"a/file.ts:2-end",
		"a/file.ts:1,,2",
		"a/file.ts:1, 2",
		"a/file.ts:3,2-1",
	]) {
		const result = parse(withCitation(citation), { repo });
		assert.equal(result.ok, false, citation);
		if (!result.ok) {
			assert.equal(result.errors[0]?.location, "requirements[0].owners.a");
			assert.ok(result.errors[0]?.message.includes(`Invalid citation ${JSON.stringify(citation)}.`));
			assert.match(
				result.errors[0].message,
				/<path>\[:<lines>\]\[ <note>\].*src\/store\/record\.ts:8-21,40 field list/,
			);
		}
	}
	invalid(withCitation("a/file.ts:2-4"), [["requirements[0].owners.a", /has 3 lines, not 4/]], { repo });
	invalid(withCitation("a/file.ts:4-5"), [["requirements[0].owners.a", /has 3 lines, not 5/]], { repo });
	invalid(withCitation("a/file.ts:2-4,1,3"), [["requirements[0].owners.a", /has 3 lines, not 4/]], { repo });
	invalid(withCitation("a/file.ts:1,2-4"), [["requirements[0].owners.a", /has 3 lines, not 4/]], { repo });
	const withUses = {
		...input(),
		requirements: [{ ...requirement("R1", "a"), relies: { b: ["a/file.ts:1-3", "a/file.ts:2-4"] } }],
	};
	invalid(withUses, [["requirements[0].relies.b[1]", /has 3 lines, not 4/]], { repo });
	assert.equal(parse(withCitation("a/file.ts:2-4")).ok, true);
});

test("wide-change candidates start at three parts without removing narrower change rows", async () => {
	const result = await assessed({
		...input(),
		parts: [...input().parts, part("d")],
		changes: [
			change("C2", ["a", "b"]),
			change("C1", ["c"]),
			change("C4", ["a", "b", "c", "d"]),
			change("C3", ["a", "b", "c"]),
		],
	});
	assert.deepEqual(
		result.changes.map(({ id, width }) => [id, width]),
		[
			["C4", 4],
			["C3", 3],
			["C2", 2],
			["C1", 1],
		],
	);
	assert.deepEqual(
		result.candidates.filter(({ kind }) => kind === "wide-change").map(({ ids }) => ids[0]),
		["C4", "C3"],
	);
});

test("history validates the grid skip list and applies both sources before bulk and mapping", async () => {
	const data = { ...input(), skip: ["abcdef0", "1".repeat(40)] };
	assert.deepEqual(valid(data).skip, data.skip);
	assert.deepEqual(valid({ ...data, skip: [] }).skip, []);
	assert.deepEqual(await assessed(data), await assessed(input()));
	const { requirements: _, ...partial } = data;
	assert.equal(parse(partial, { command: "history" }).ok, true);
	for (const [grid, command] of [
		[data, "assess"],
		[partial, "history"],
	] as const) {
		invalid({ ...grid, skip: null }, [["skip", /array of commit ids/]], { command });
		invalid(
			{ ...grid, skip: ["abcdef0", "ABCDEF0", "abcdef", "abcdefg", "1".repeat(41), 1234567] },
			[
				["skip[1]", /only once/],
				["skip[2]", /7 to 40 hexadecimal/],
				["skip[3]", /7 to 40 hexadecimal/],
				["skip[4]", /7 to 40 hexadecimal/],
				["skip[5]", /7 to 40 hexadecimal/],
			],
			{ command },
		);
	}
	const grid = valid({ ...input(), skip: ["ABCDEF0", "FFFFFFF"] });
	const date = "2025-02-01T12:00:00-05:00";
	const commits = [
		{ id: "abcdef001", date, subject: "Mechanical format", files: ["a/f", "b/f", "c/f", "unmapped/file"] },
		{ id: "abcdef002", date, subject: "Mechanical move", files: ["a/f", "unmapped/file"] },
		{ id: "f00ba0001", date, subject: "Kept", files: ["b/f", "c/f"] },
	];
	const summary = await summariseHistory(grid, commits, { bulk: 2, skip: ["abcdef001", "abcDEF0"] });
	assert.equal(summary.window.commits, 3);
	assert.equal(summary.window.oldest, date);
	assert.deepEqual(summary.skipped, {
		commits: commits.slice(0, 2).map(({ id, date, subject }) => ({ id, date, subject })),
		unmatched: ["FFFFFFF"],
	});
	assert.equal(summary.bulk.commits, 0);
	assert.equal(summary.mapping.mappedFiles, 2);
	assert.equal(summary.mapping.unmappedFiles, 0);
	assert.deepEqual(
		summary.parts.map(({ id }) => id),
		["b", "c", "a"],
	);
	assert.deepEqual(summary.spread, { one: 0, two: 1, three: 0, fourOrMore: 0 });
	const text = renderText(summary);
	assert.match(text, /Window: .*2025-02-01 to 2025-02-01; skipped by request: 2;/);
	assert.match(text, /\| abcdef0 \| 2025-02-01 \| Mechanical format \|/);
	assert.match(text, /Unmatched ids: FFFFFFF\./);
	assert.match(text, /Largest bulk commits:\nnone/);
	assert.match(text, /Top unmapped directories:\nnone\n\nTop unmapped files:\nnone$/);
	assert.doesNotMatch(text, /T12:00:00/);
});

test("history distinguishes direct reliance, shared knowledge and unexplained pairs", async () => {
	const grid = valid({
		...input(),
		parts: [...input().parts, part("d")],
		requirements: [requirement("R1", "a", ["b"]), requirement("R2", "b", ["a", "c"])],
		decisions: ["z-format", "a-format"].map((id) => ({ id, name: id, knownBy: { a: "a/file", b: "b/file" } })),
	});
	const commits = [{ id: "abcdef0", date: "2025-03-01", subject: "Wide", files: ["a/f", "b/f", "c/f", "d/f"] }];
	const summary = await summariseHistory(grid, commits);
	assert.deepEqual(summary.pairs[0].grid, {
		relies: [
			["a", "b"],
			["b", "a"],
		],
		decisions: ["a-format", "z-format"],
	});
	assert.deepEqual(summary.pairs.find(({ parts }) => parts.join() === "a,c")?.grid, { relies: [], decisions: [] });
	const text = renderText(summary);
	assert.match(text, /Share of B \| In the grid \|/);
	assert.match(text, /With other parts \| Leaned on by \|/);
	assert.deepEqual(
		summary.parts.map(({ id, leanedOnBy }) => [id, leanedOnBy]),
		[
			["a", 1],
			["b", 1],
			["c", 2],
			["d", 0],
		],
	);
	assert.match(text, /a relies on b; b relies on a; shared: a-format, z-format/);
	assert.match(text, /b relies on c/);
	assert.match(text, /not explained/);
	const partial = await summariseHistory({ parts: grid.parts, subject: grid.subject }, commits);
	assert.ok(partial.pairs.every(({ grid }) => grid === null));
	assert.ok(partial.parts.every(({ leanedOnBy }) => leanedOnBy === null));
	assert.doesNotMatch(renderText(partial), /Leaned on by/);
	assert.match(renderText(partial), /Pairs were not compared with the grid: the grid file does not pass assess yet\./);
	assert.doesNotMatch(renderText(partial), /In the grid/);
});

test("the two worked example grids expose coordination before and after", async () => {
	const text = readFileSync(example, "utf8");
	const blocks = [...text.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
	assert.equal(blocks.length, 2);
	const results = await Promise.all(
		blocks.map(async ([, source]) => {
			const result = parseGrid(source);
			if (!result.ok) assert.fail(JSON.stringify(result.errors));
			assert.equal(result.grid.mode, "plan");
			const assessment = await assess(result.grid);
			if (!assessment.ok) assert.fail(JSON.stringify(assessment.errors));
			assert.equal(assessment.order, "layered");
			return assessment;
		}),
	);
	const rendered = [...text.matchAll(/^```text[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
	assert.equal(rendered.length, 2);
	const trimTrailing = (value: string) =>
		value
			.replace(/[^\S\r\n]+(?=\r?$)/gm, "")
			.replaceAll("\r\n", "\n")
			.trimEnd();
	for (const [index, [, output]] of rendered.entries()) {
		assert.equal(trimTrailing(output), trimTrailing(renderText(results[index])));
	}
	const [before, after] = results;
	assert.ok(before.candidates.some(({ kind }) => kind === "shared-decision"));
	const widest = before.changes.find(({ kind }) => kind === "declared");
	assert.ok(widest);
	assert.equal(widest.width, widest.totalParts);
	assert.equal(after.nodes.filter(({ kind }) => kind === "decision").length, 0);
	assert.ok(after.changes.some(({ kind }) => kind === "declared"));
	assert.deepEqual(
		after.changes.filter(({ kind }) => kind === "declared").map(({ id, width }) => [id, width]),
		[
			["C6", 2],
			["C1", 1],
			["C2", 1],
			["C3", 1],
			["C4", 1],
			["C5", 1],
		],
	);
});

test("the grid file shown in the skill instructions passes validation", () => {
	const text = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
	const blocks = [...text.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
	assert.equal(blocks.length, 1);
	const result = parseGrid(blocks[0][1]);
	if (!result.ok) assert.fail(JSON.stringify(result.errors));
	assert.equal(result.grid.mode, "code");
});
