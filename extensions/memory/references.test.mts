import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readMemory } from "./retrieval.ts";
import { type MemoryWrite, MemoryWriteError, retireMemory, writeMemory } from "./store.ts";

function corpus(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "memory-references-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "README.md"), "See `past-rule`.\n");
	return root;
}

function fixture(root: string, slug: string, body = "", status = "active", supersededBy: string | null = null) {
	writeFileSync(
		join(root, `${slug}.md`),
		`---\ntitle: ${slug}\nstatus: ${status}\nsuperseded_by: ${supersededBy ?? "null"}\nsupersedes: [header-only]\n---\n# ${slug}\n\n${body}\n`,
	);
}

function note(slug: string, details = "The durable scope is documented here."): MemoryWrite {
	return {
		slug,
		title: `Subject ${slug}`,
		tags: ["reference"],
		summary: "A synthetic test note.",
		details,
		sources: "A test source.",
		verified: false,
	};
}

function retire(root: string, slug: string, expectedDigest: string) {
	return retireMemory(root, { slug, expectedDigest, reason: "It no longer applies.", sources: "A test source." });
}

test("a first current page reports exact stale body references even beyond the page", async (t) => {
	const root = corpus(t);
	const details = `${"Padding. ".repeat(1600)}\nSee [old](./past-rule.md), \`withdrawn-rule\`, PAST-CASE, prefix-short-rule and symlink-rule. See oversized-rule and origin-rule.`;
	const initial = writeMemory(root, note("origin-rule", details));
	const retired = retire(root, "origin-rule", initial.digest as string);
	fixture(root, "past-rule", "", "superseded", "new-rule");
	fixture(root, "new-rule");
	for (const slug of ["withdrawn-rule", "past-case", "short-rule", "header-only"]) fixture(root, slug, "", "retired");
	fixture(root, "header-check");
	writeFileSync(
		join(root, "oversized-rule.md"),
		`---\nstatus: retired\nsuperseded_by: null\n---\n${"x".repeat(65536)}`,
	);
	mkdirSync(join(root, "subdir"));
	fixture(join(root, "subdir"), "symlink-rule", "", "retired");
	symlinkSync(join(root, "subdir", "symlink-rule.md"), join(root, "symlink-rule.md"));

	const first = await readMemory(root, { slug: "origin-rule" });
	assert.doesNotMatch(first.content as string, /past-rule/);
	assert.deepEqual(first.staleReferences, [
		{ slug: "past-rule", status: "superseded", supersededBy: "new-rule" },
		{ slug: "withdrawn-rule", status: "retired", supersededBy: null },
	]);
	assert.match(first.staleReferenceGuidance as string, /read its replacement/);
	assert.equal((first.staleReferenceCoverage as { complete: boolean }).complete, false);
	const continuation = await readMemory(root, {
		slug: "origin-rule",
		digest: first.digest as string,
		offset: first.nextOffset as number,
	});
	assert.match(continuation.content as string, /past-rule/);
	const historical = await readMemory(root, { slug: "origin-rule", revision: retired.captured[0].revision });
	for (const page of [
		continuation,
		historical,
		await readMemory(root, { slug: "README" }),
		await readMemory(root, { slug: "header-check" }),
	]) {
		for (const field of ["staleReferences", "staleReferenceGuidance", "staleReferenceCoverage"])
			assert.equal(Object.hasOwn(page, field), false);
	}
});

test("post-publication advice counts only committed transitions and active references", (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note("first-rule"));
	const second = writeMemory(root, note("second-rule"));
	const active = writeMemory(root, note("affected-note", "Review `first-rule`. Review first-rule again."));
	assert.equal(active.affectedReferences, undefined);
	fixture(root, "other-note", "See second-rule.");
	fixture(root, "word-boundaries", "See not-first-rule and FIRST-RULE.");
	fixture(root, "withdrawn-note", "See first-rule.", "retired");
	fixture(root, "unavailable-note", "See first-rule.", "broken");
	let error: MemoryWriteError | undefined;
	assert.throws(
		() =>
			writeMemory(
				root,
				{
					...note("next-rule"),
					supersedes: [
						{ slug: "first-rule", digest: first.digest as string },
						{ slug: "second-rule", digest: second.digest as string },
					],
				},
				undefined,
				{
					beforePublish: (file) => {
						if (file === "second-rule.md") throw new Error("Fixture refusal");
					},
				},
			),
		(value) => {
			assert.ok(value instanceof MemoryWriteError);
			error = value;
			return true;
		},
	);
	assert.deepEqual(error?.receipt.written, ["next-rule.md", "first-rule.md"]);
	assert.deepEqual(error?.receipt.notWritten, ["second-rule.md"]);
	const advice = error?.receipt.affectedReferences;
	assert.deepEqual(advice?.slugs, ["first-rule"]);
	assert.deepEqual(advice?.notes, ["affected-note"]);
	assert.equal(advice?.count, 1);
	assert.equal(advice?.coverage.complete, false);
	assert.match(error?.message ?? "", /Review affected statements in this pass/);
	assert.doesNotMatch(error?.message ?? "", /Review first-rule again/);
	fixture(root, "malformed-boundaries", "See ésecond-rule, second-rule\u0301 and not-second-rule.", "broken");
	fixture(root, "malformed-header-only", "", "[second-rule");
	const completed = writeMemory(root, {
		...note("next-rule"),
		expectedDigest: error?.receipt.digest,
		supersedes: [{ slug: "second-rule", digest: second.digest as string }],
	});
	assert.deepEqual(completed.affectedReferences?.slugs, ["second-rule"]);
	assert.deepEqual(completed.affectedReferences?.notes, ["other-note"]);
	assert.equal(completed.affectedReferences?.coverage.complete, true);
});

test("reference lists are bounded separately from the observed count", async (t) => {
	const root = corpus(t);
	const slugs = Array.from({ length: 27 }, (_, index) => `past-${index}`);
	const origin = writeMemory(root, note("origin-rule", slugs.join(" ")));
	for (const slug of slugs) fixture(root, slug, "", "retired");
	const first = await readMemory(root, { slug: "origin-rule" });
	assert.equal((first.staleReferences as unknown[]).length, 25);
	const coverage = first.staleReferenceCoverage as { complete: boolean; count: number; notesChecked: number };
	assert.equal(coverage.complete, true);
	assert.equal(coverage.count, 27);
	assert.equal(coverage.notesChecked, 27);

	for (const slug of slugs) fixture(root, slug, "See origin-rule.");
	const affected = retire(root, "origin-rule", origin.digest as string).affectedReferences;
	assert.equal(affected?.coverage.complete, true);
	assert.equal(affected?.count, 27);
	assert.equal(affected?.notes.length, 25);
});
