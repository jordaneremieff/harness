import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveLoaderPath } from "./extension-load-check.mts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const schemaMaps = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"];
const schemaLists = ["allOf", "anyOf", "oneOf", "prefixItems"];
const schemaChildren = [
	"items",
	"additionalItems",
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"contains",
	"propertyNames",
	"not",
	"if",
	"then",
	"else",
	"contentSchema",
];

function schemaObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Inspect schema positions only. Annotation data and user property names are not schema keywords.
// Local definitions are visited directly, including referenced and unused definitions; no references are fetched.
function tupleSchemaIssues(name: string, parameters: unknown): string[] {
	const issues: string[] = [];
	function visit(schema: unknown, path: string) {
		if (!schemaObject(schema)) return;
		for (const keyword of ["additionalItems", "prefixItems"]) {
			if (Object.hasOwn(schema, keyword)) issues.push(`${name} ${path}[${JSON.stringify(keyword)}]: tuple keyword`);
		}
		if (Array.isArray(schema.items)) issues.push(`${name} ${path}["items"]: array-valued items`);
		for (const keyword of schemaMaps) {
			const map = schema[keyword];
			if (schemaObject(map)) {
				for (const [key, child] of Object.entries(map))
					visit(child, `${path}[${JSON.stringify(keyword)}][${JSON.stringify(key)}]`);
			}
		}
		for (const keyword of schemaLists) {
			const list = schema[keyword];
			if (Array.isArray(list)) {
				list.forEach((child, index) => {
					visit(child, `${path}[${JSON.stringify(keyword)}][${index}]`);
				});
			}
		}
		for (const keyword of schemaChildren) visit(schema[keyword], `${path}[${JSON.stringify(keyword)}]`);
	}
	visit(JSON.parse(JSON.stringify(parameters)), "$");
	return issues;
}

test("loader discovery supports the current bundled CLI layout", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-loader-layout-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dist = join(root, "installed", "dist");
	const binary = join(dist, "bundle", "cli.js");
	const loader = join(dist, "core", "extensions", "loader.js");
	await mkdir(join(dist, "bundle"), { recursive: true });
	await mkdir(join(dist, "core", "extensions"), { recursive: true });
	await writeFile(binary, "");
	await writeFile(loader, "");
	assert.equal(resolveLoaderPath(root, { binaryPath: binary }), await realpath(loader));

	const local = join(
		root,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"core",
		"extensions",
		"loader.js",
	);
	await mkdir(join(local, ".."), { recursive: true });
	await writeFile(local, "");
	assert.equal(resolveLoaderPath(root, { binaryPath: binary }), local);
});

test("the load CLI fails when no Pi loader is available", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-loader-unavailable-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const script = join(root, "scripts", "extension-load-check.mts");
	await mkdir(dirname(script));
	await copyFile(fileURLToPath(new URL("./extension-load-check.mts", import.meta.url)), script);
	const extension = join(root, "example.ts");
	await writeFile(extension, "export default function () {}\n");
	await assert.rejects(
		promisify(execFile)(process.execPath, [script, extension], {
			cwd: root,
			env: { ...process.env, PATH: join(root, "no-binaries") },
			timeout: 10_000,
		}),
		(error: unknown) => {
			const failure = error as { code: number; stderr: string };
			assert.equal(failure.code, 1);
			assert.match(failure.stderr, /Pi extension loader not found/);
			return true;
		},
	);
});

test("the load CLI reports factory and registration failures from Pi", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-loader-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const script = fileURLToPath(new URL("./extension-load-check.mts", import.meta.url));
	const extension = join(root, "example.ts");
	const options = {
		cwd: root,
		env: { ...process.env, NODE_V8_COVERAGE: join(root, "coverage") },
		timeout: 20_000,
		maxBuffer: 100_000,
	};
	await writeFile(extension, "export default function (pi) { pi.on('session_start', () => {}); }\n");
	const loaded = await promisify(execFile)(process.execPath, [script, extension], options);
	assert.match(loaded.stdout, /Loaded 1 extension/);
	for (const [source, message] of [
		["export const value = 1;", /does not export a valid factory function/],
		["export default function () { throw new Error('factory refused'); }", /factory refused/],
		[
			"export default function (pi) { pi.registerTool({ name: 'invalid', parameters: null }); }",
			/must define an object parameter schema/,
		],
	] as const) {
		await writeFile(extension, source);
		await assert.rejects(promisify(execFile)(process.execPath, [script, extension], options), (error: unknown) => {
			const failure = error as { code: number; stderr: string };
			assert.equal(failure.code, 1);
			assert.match(failure.stderr, message);
			return true;
		});
	}
});

test("serialized package registrations and built-in schemas exclude tuple notation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "package-tool-schemas-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	// Keep jiti's transformed modules out of the parent coverage merge: they share source URLs
	// with native imports but different line maps. The bounded child still performs the real load.
	const capture = `
		import assert from "node:assert/strict";
		import { dirname, join } from "node:path";
		import { fileURLToPath, pathToFileURL } from "node:url";
		const [repositoryRoot, root] = process.argv.slice(1);
		const entry = process.env.PI_POLICY_TEST_PI_ROOT
			? join(process.env.PI_POLICY_TEST_PI_ROOT, "dist/index.js")
			: fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(entry).href);
		const { createAllTools } = await import(pathToFileURL(join(dirname(entry), "core/tools/index.js")).href);
		const { submitResultTool } = await import(pathToFileURL(join(repositoryRoot, "extensions/subagent/index.ts")).href);
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory({
				packages: [{ source: repositoryRoot, skills: [], prompts: [], themes: [] }],
			}),
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const { extensions, errors } = loader.getExtensions();
		assert.deepEqual(errors, []);
		assert.ok(extensions.length > 0, "the package must load extensions");
		const metadata = ({ name, parameters }) => ({ name, parameters });
		const registered = extensions.flatMap(extension => [...extension.tools.values()].map(({ definition }) => metadata(definition)));
		assert.ok(registered.length > 0, "the package must register tools");
		const builtins = Object.values(createAllTools(root)).map(metadata);
		const runtime = [submitResultTool(join(root, "result.md"), () => {}, () => "schema-test")].map(metadata);
		console.log(JSON.stringify({ extensions: extensions.map(extension => extension.path), registered, builtins, runtime }));
	`;
	const { stdout } = await promisify(execFile)(
		process.execPath,
		["--input-type=module", "-e", capture, repositoryRoot, root],
		{
			cwd: repositoryRoot,
			timeout: 60_000,
			maxBuffer: 2_000_000,
			env: { ...process.env, NODE_V8_COVERAGE: join(root, "coverage") },
		},
	);
	type Schema = { name: string; parameters: unknown };
	const { extensions, registered, builtins, runtime } = JSON.parse(stdout) as {
		extensions: string[];
		registered: Schema[];
		builtins: Schema[];
		runtime: Schema[];
	};
	const tools = [...builtins, ...registered, ...runtime];
	t.diagnostic(
		`Checked ${tools.length} schemas: ${builtins.length} built-ins, ${registered.length} registrations from ${extensions.length} package extensions, and ${runtime.length} worker-only tool`,
	);
	assert.deepEqual(
		tools.flatMap((tool) => tupleSchemaIssues(tool.name, tool.parameters)),
		[],
	);
});

test("tuple inspection visits schema containers and reports the tool and exact path", () => {
	const tuple = { type: "array", items: [{ const: "only" }], additionalItems: false };
	for (const keyword of schemaMaps) {
		assert.deepEqual(tupleSchemaIssues("sample", { [keyword]: { "a.b": tuple } }), [
			`sample $["${keyword}"]["a.b"]["additionalItems"]: tuple keyword`,
			`sample $["${keyword}"]["a.b"]["items"]: array-valued items`,
		]);
	}
	for (const keyword of schemaLists.filter((key) => key !== "prefixItems")) {
		assert.equal(tupleSchemaIssues("sample", { [keyword]: [tuple] }).length, 2);
	}
	for (const keyword of schemaChildren.filter((key) => key !== "additionalItems")) {
		assert.equal(tupleSchemaIssues("sample", { [keyword]: tuple }).length, 2);
	}
	assert.deepEqual(tupleSchemaIssues("sample", { prefixItems: [true] }), ['sample $["prefixItems"]: tuple keyword']);
	assert.equal(tupleSchemaIssues("sample", { additionalItems: true }).length, 1);
	assert.equal(
		tupleSchemaIssues("sample", { $ref: "#/$defs/loop", $defs: { loop: { $ref: "#/$defs/loop", ...tuple } } }).length,
		2,
	);
	assert.equal(tupleSchemaIssues("sample", { toJSON: () => tuple }).length, 2, "inspection follows serialization");
});

test("tuple inspection preserves boolean schemas, data, and arbitrary property names", () => {
	const data = { items: [], additionalItems: false, prefixItems: [] };
	assert.deepEqual(
		tupleSchemaIssues("sample", {
			properties: { items: true, additionalItems: false, prefixItems: { type: "string" } },
			patternProperties: { "items|prefixItems": { type: "string" } },
			items: true,
			additionalProperties: false,
			allOf: [true, false],
			default: data,
			const: data,
			enum: [data],
			examples: [data],
			example: data,
			dependencies: { field: ["items", "additionalItems", "prefixItems"] },
			dependentRequired: { field: ["items"] },
		}),
		[],
	);
});
