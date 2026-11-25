import assert from "node:assert/strict";
import test from "node:test";
import {
	changes,
	compareVersions,
	parseSurface,
	releasesAfter,
	sourceNames,
	terminalFindings,
} from "./upgrade-review.mts";

test("orders server builds by version, not directory name or string order", () => {
	const versions = ["0.1.0", "0.1.0-preview.9", "0.1.0-preview.10", "0.2.0-preview.1"];
	assert.deepEqual(versions.sort(compareVersions), ["0.1.0-preview.9", "0.1.0-preview.10", "0.1.0", "0.2.0-preview.1"]);
});

test("selects Mac and server releases after each platform's reviewed release", () => {
	const item = (platform: string, version: string, day: number, path = `${platform}/${version}.json`) => ({
		platform,
		version,
		path,
		releasedAt: `2026-11-${day}T00:00:00.000Z`,
	});
	const baseline = { server: "0.1.0-preview.21", mac: "0.1.0-preview.33" };
	const releases = [
		item("server", "0.1.0-preview.22", 21),
		item("mac", "0.1.0-preview.34", 24),
		item("server", "0.1.0-preview.23", 23),
		item("mac", "0.1.0-preview.33", 22),
		item("mac", "0.1.0-preview.32", 19),
		item("server", "0.1.0-preview.21", 18),
		item("server", "0.1.0-01d6c4f", 16),
		item("windows", "0.1.1-preview.38", 25),
	];
	assert.deepEqual(
		releasesAfter({ schemaVersion: 1, releases }, baseline).map(({ platform, version }) => `${platform} ${version}`),
		["mac 0.1.0-preview.34", "server 0.1.0-preview.23", "server 0.1.0-preview.22"],
	);
	assert.throws(
		() => releasesAfter({ schemaVersion: 1, releases }, { ...baseline, server: "0.1.0-preview.20" }),
		/does not identify one server release/,
	);
	assert.throws(
		() =>
			releasesAfter(
				{ schemaVersion: 1, releases: [...releases, item("server", "0.1.0-preview.24", 25, "../other.json")] },
				baseline,
			),
		/Invalid server changelog entry/,
	);
});

test("diffs help.all by method name and block creator, ignoring JSON object key order", () => {
	const before = parseSurface({
		methods: [
			{ name: "target.resolve", input_schema: { type: "object", description: "Accept session ID." } },
			{ name: "help.all", output_schema: { type: "object", properties: {} } },
			{ name: "example.removed" },
		],
		block_types: [{ creator: "com.superlogical.terminal", flavors: ["shell"], methods: [] }],
	});
	const after = parseSurface({
		methods: [
			{ name: "focus_history.reverse", description: "Step back through focus changes." },
			{ name: "target.resolve", input_schema: { description: "Accept block ID.", type: "object" } },
			{ name: "help.all", output_schema: { properties: {}, type: "object" } },
		],
		block_types: [{ creator: "com.superlogical.terminal", flavors: ["shell", "example"], methods: [] }],
	});
	assert.deepEqual(changes(before.methods, after.methods), [
		{ name: "example.removed", kind: "Removed", fields: [] },
		{ name: "focus_history.reverse", kind: "Added", fields: [] },
		{ name: "target.resolve", kind: "Changed", fields: ["input_schema"] },
	]);
	assert.deepEqual(changes(before.blocks, after.blocks), [
		{ name: "com.superlogical.terminal", kind: "Changed", fields: ["flavors"] },
	]);
	assert.throws(
		() => parseSurface({ methods: [{ name: "help.all" }, { name: "help.all" }], block_types: [] }),
		/Invalid help.all name/,
	);
});

test("reports a lost environment variable even when source only names it during cleanup", () => {
	const names = sourceNames(
		[
			'delete env.REX_SESSION; const pane = process.env["REX_BLOCK"]; const route = "REX_SERVER";',
			'const lua = `return rex.call("target.resolve", args)`; const another = "prefix.server.version";',
		],
		new Set(["target.resolve", "server.version"]),
	);
	assert.deepEqual([...names.api], ["target.resolve"]);
	assert.deepEqual(terminalFindings(names.env, ["REX_SESSION", "REX_BLOCK"], ["REX_BLOCK"]), [
		"- `REX_SERVER` appears in harness source but is absent from the candidate terminal.",
		"- `REX_SESSION` appears in harness source but is absent from the candidate terminal; the baseline terminal set it.",
	]);
});
