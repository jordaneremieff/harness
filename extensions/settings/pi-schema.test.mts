import assert from "node:assert/strict";
import { test } from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { loadPiSchema, normalize, parseReference, schemaAt, validateValue } from "./pi-schema.ts";

test("the installed schema becomes form descriptors without dropping a property", () => {
	const schema = loadPiSchema(getPackageDir());
	const top = Object.keys(schema.root.properties as object);
	for (const key of top)
		assert.ok(
			schema.leaves.some((leaf) => leaf.path[0] === key),
			`${key} has an entry`,
		);
	const quiet = schema.leaves.find((leaf) => leaf.path.join(".") === "quietStartup");
	assert.deepEqual(quiet?.value, {
		type: "union",
		options: [{ type: "boolean" }, { type: "enum", choices: ["header"] }],
	});
	const skills = schema.leaves.find((leaf) => leaf.path.join(".") === "skills");
	assert.deepEqual(skills?.value, { type: "array", items: { type: "string" } });
	const mermaid = schema.leaves.find((leaf) => leaf.path.join(".") === "markdown.mermaid");
	assert.deepEqual(mermaid?.value, { type: "enum", choices: ["off", "final", "streaming"] });
	assert.equal(schema.leaves.find((leaf) => leaf.path.join(".") === "cacheWarming")?.globalOnly, true);
	assert.equal(schema.leaves.find((leaf) => leaf.path.join(".") === "httpProxy")?.globalOnly, true);
	assert.equal(schema.leaves.find((leaf) => leaf.path.join(".") === "extensions")?.combined, true);
	assert.equal(schema.leaves.find((leaf) => leaf.path.join(".") === "lastChangelogVersion")?.documented, false);
});

test("values are checked against the selected installation's schema", () => {
	const schema = loadPiSchema(getPackageDir());
	const node = (path: string[]) => schemaAt(schema.root, path) as Record<string, unknown>;
	assert.deepEqual(validateValue(schema.root, node(["httpIdleTimeoutMs"]), "disabled", "x"), []);
	assert.deepEqual(validateValue(schema.root, node(["httpIdleTimeoutMs"]), 1000, "x"), []);
	assert.equal(validateValue(schema.root, node(["httpIdleTimeoutMs"]), -1, "x").length > 0, true);
	assert.deepEqual(validateValue(schema.root, node(["modelThinkingLevels"]), { "anthropic/claude": "high" }, "x"), []);
	assert.match(validateValue(schema.root, node(["modelThinkingLevels"]), { "a/b": "loud" }, "x").join(" "), /one of/);
	assert.match(validateValue(schema.root, node(["packages"]), [{ autoload: false }], "x").join(" "), /does not match/);
	assert.deepEqual(
		validateValue(schema.root, node(["packages"]), ["npm:pkg", { source: "git:x", autoload: false }], "x"),
		[],
	);
	assert.deepEqual(schemaAt(schema.root, ["modelThinkingLevels", "openai/gpt"])?.enum, [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
});

test("unfamiliar constructs stay editable as JSON and are named", () => {
	const root = { properties: {} };
	assert.deepEqual(normalize(root, { oneOf: [{ type: "string" }, { type: "number" }] }), {
		type: "json",
		unsupported: ["oneOf"],
	});
});

test("the settings reference supplies sections, defaults and descriptions", () => {
	const rows = parseReference(
		[
			"## Model and thinking",
			"| Setting | Type | Default | Description |",
			"|---|---|---|---|",
			"| `defaultModel` | string | Automatic | Startup model ID. |",
			"### Compaction",
			"| `compaction.enabled` | boolean | `true` | Enable automatic compaction. Uses `a \\| b` forms. |",
		].join("\n"),
	);
	assert.deepEqual(rows.get("defaultModel"), {
		section: "Model and thinking",
		type: "string",
		defaultText: "Automatic",
		description: "Startup model ID.",
	});
	assert.equal(rows.get("compaction.enabled")?.section, "Compaction");
	assert.match(rows.get("compaction.enabled")?.description ?? "", /a \| b/);
});
