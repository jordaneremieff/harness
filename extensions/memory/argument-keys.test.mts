import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import type { MemoryDurableContribution, MemoryDurableContributionHost } from "./durable.ts";
import memory from "./index.ts";
import { historyMemory, MemoryRetrievalError, readMemory, searchMemory } from "./retrieval.ts";
import { isolateMachineSettings } from "./settings-fixture.mts";
import { editMemory, MemoryWriteError, retireMemory, reviewMemory, writeMemory } from "./store.ts";

isolateMachineSettings();

type PreparedTool = { name: string; prepareArguments?: (args: unknown) => unknown };
const slug = "editor-choice";
const digest = "a".repeat(64);
const value = `ghp_${"x".repeat(24)}`;
const cases = [
	["memory_search", { include_retired: value }, "include_retired", "includeRetired"],
	["memory_read", { slg: value }, "slg", "slug"],
	["memory_history", { slug, limt: value }, "limt", "limit"],
	[
		"memory_history",
		{ slug, plan: { keepNewest: 0, captured_before: value } },
		"plan.captured_before",
		"plan.capturedBefore",
	],
	["memory_write", { slug, titel: value }, "titel", "title"],
	[
		"memory_write",
		{ slug, supersedes: [{ slug: "old", digset: value }] },
		"supersedes[0].digset",
		"supersedes[0].digest",
	],
	["memory_edit", { slug, expected_digest: value, verified: true }, "expected_digest", "expectedDigest"],
	[
		"memory_edit",
		{ slug, expectedDigest: digest, edits: [{ old_text: value, newText: "new" }] },
		"edits[0].old_text",
		"edits[0].oldText",
	],
	["memory_review", { slug, expect_digest: value, outcome: "confirmed" }, "expect_digest", "expectedDigest"],
	["memory_retire", { slug, expected_digest: value }, "expected_digest", "expectedDigest"],
] as const;

function refused(error: unknown, key: string, suggestion: string, mutation: boolean): true {
	assert.ok(error instanceof Error);
	const diagnostic = error instanceof MemoryWriteError ? error.receipt.error : error.message;
	assert.ok(diagnostic);
	assert.ok(diagnostic.includes(JSON.stringify(key)), diagnostic);
	assert.ok(diagnostic.includes(`Did you mean ${JSON.stringify(suggestion)}?`), diagnostic);
	assert.ok(!error.message.includes(value));
	if (mutation) {
		assert.ok(error instanceof MemoryWriteError);
		assert.equal(error.receipt.ok, false);
		assert.equal(error.receipt.initialized, false);
		assert.deepEqual(error.receipt.written, []);
		assert.deepEqual(error.receipt.notWritten, []);
		assert.deepEqual(error.receipt.captured, []);
		assert.deepEqual(error.receipt.historyOmitted, []);
	} else {
		assert.ok(error instanceof MemoryRetrievalError);
		assert.equal(error.code, "input");
	}
	return true;
}

function isMutation(name: string): boolean {
	return ["memory_write", "memory_edit", "memory_review", "memory_retire"].includes(name);
}

test("ordinary and Durable tool preparation refuse unknown keys before schema validation", async () => {
	const ordinary = new Map<string, PreparedTool>();
	const contributions: MemoryDurableContribution[] = [];
	memory({
		registerTool: (tool: PreparedTool) => ordinary.set(tool.name, tool),
		on: () => () => {},
		events: {
			on: () => () => {},
			emit: (channel: string, data: MemoryDurableContribution) => {
				if (channel === "durable:contribution") contributions.push(data);
			},
		},
	} as unknown as ExtensionAPI);
	const contribution = contributions[0];
	assert.ok(contribution);
	const cwd = fileURLToPath(new URL(".", import.meta.url));
	const native = await contribution.create({
		durable: Durable,
		agentDir: process.env.PI_CODING_AGENT_DIR,
		cwd,
		onClose: () => {},
	} as unknown as MemoryDurableContributionHost);
	const durable = new Map((native.tools ?? []).map((tool) => [tool.name, tool]));
	for (const tools of [ordinary, durable]) {
		for (const [name, args, key, suggestion] of cases) {
			const prepare = tools.get(name)?.prepareArguments;
			assert.ok(prepare, name);
			assert.throws(
				() => prepare(args),
				(error) => refused(error, key, suggestion, isMutation(name)),
			);
		}
		const args = Object.freeze({ slug, expectedDigest: digest, title: "New title", verified: false });
		assert.equal(tools.get("memory_edit")?.prepareArguments?.(args), args);
	}
});

test("direct memory calls refuse unknown keys before corpus access", async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "memory-argument-keys-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "uninitialised");
	const calls: Record<string, (root: string, args: never) => unknown> = {
		memory_search: searchMemory,
		memory_read: readMemory,
		memory_history: historyMemory,
		memory_write: writeMemory,
		memory_edit: editMemory,
		memory_review: reviewMemory,
		memory_retire: retireMemory,
	};
	for (const [name, args, key, suggestion] of cases) {
		await assert.rejects(
			async () => calls[name](root, args as never),
			(error) => refused(error, key, suggestion, isMutation(name)),
		);
	}
	assert.throws(
		() => writeMemory(root, { slug: "unsafe/subject", [value]: "arbitrary argument value" } as never),
		(error) => {
			assert.ok(error instanceof MemoryWriteError);
			assert.equal(error.receipt.slug, "[invalid subject]");
			assert.match(error.message, /\[redacted\]/);
			assert.doesNotMatch(error.message, /unsafe\/subject|ghp_|arbitrary argument value/);
			return true;
		},
	);
	await assert.rejects(searchMemory(root, JSON.parse('{"__proto__":{}}')), /unknown option: "__proto__"/);
	assert.equal(existsSync(root), false);
});
