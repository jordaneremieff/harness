import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseFrontmatter,
	resumeCommand,
	serializeArtifact,
	slugify,
	updateFrontmatter,
	utcTimestamp,
	type StashRecord,
} from "./format.ts";

function rec(overrides: Partial<StashRecord> = {}): StashRecord {
	return {
		id: "20260724T115030Z-test-stash",
		title: "Test stash",
		created: "20260724T115030Z",
		project: "/tmp/project",
		tags: ["continuity", "stash"],
		state: "open",
		summary: "What is true now.",
		decisions: ["Use files, not session entries"],
		openLoops: ["Is TUI needed?"],
		nextActions: ["Write tests"],
		files: ["extensions/stash/store.ts"],
		...overrides,
	};
}

describe("slugify", () => {
	it("normalizes to lowercase hyphenated slugs", () => {
		assert.equal(slugify("Session Continuity Design!"), "session-continuity-design");
	});
	it("falls back to untitled for empty slugs", () => {
		assert.equal(slugify("!!!"), "untitled");
	});
	it("caps at 60 chars without trailing hyphens", () => {
		const slug = slugify(`a ${"b".repeat(80)}`);
		assert.ok(slug.length <= 60);
		assert.ok(!slug.endsWith("-"));
	});
});

describe("utcTimestamp", () => {
	it("produces compact sortable UTC", () => {
		assert.equal(utcTimestamp(new Date("2026-07-24T11:50:30.123Z")), "20260724T115030Z");
	});
});

describe("resumeCommand", () => {
	it("routes a fresh pi session through deterministic /stash get", () => {
		assert.equal(resumeCommand("20260724T115030Z-test-stash"), 'pi "/stash get 20260724T115030Z-test-stash"');
	});
});

describe("serializeArtifact → parseFrontmatter roundtrip", () => {
	it("preserves all metadata fields", () => {
		const { meta, body } = parseFrontmatter(serializeArtifact(rec()));
		assert.equal(meta.id, "20260724T115030Z-test-stash");
		assert.equal(meta.title, "Test stash");
		assert.equal(meta.created, "20260724T115030Z");
		assert.equal(meta.project, "/tmp/project");
		assert.deepEqual(meta.tags, ["continuity", "stash"]);
		assert.equal(meta.state, "open");
		assert.match(body, /# Test stash/);
		assert.match(body, /## Decisions\n\n- Use files, not session entries/);
		assert.match(body, /## Open loops/);
		assert.match(body, /## Next actions/);
		assert.match(body, /## Files\n\n- extensions\/stash\/store\.ts/);
	});

	it("omits empty sections and undefined optionals", () => {
		const md = serializeArtifact(rec({ decisions: [], openLoops: [], nextActions: [], files: [], branch: undefined }));
		assert.doesNotMatch(md, /## Decisions/);
		assert.doesNotMatch(md, /^branch:/m);
	});

	it("handles titles and summaries containing colons and quotes", () => {
		const { meta, body } = parseFrontmatter(
			serializeArtifact(rec({ title: 'fix: the "parser" bug', summary: "line one\nline two" })),
		);
		assert.equal(meta.title, 'fix: the "parser" bug');
		assert.match(body, /line one\nline two/);
	});
});

describe("updateFrontmatter", () => {
	it("updates lifecycle keys while preserving unknown metadata and body bytes", () => {
		const source = '---\nid: "safe-id"\ncustom: {"keep":true}\nstate: "open"\n---\n\n# Body\nunchanged\n';
		const updated = updateFrontmatter(source, {
			state: "closed",
			closedAt: "20260726T120000Z",
			outcome: "landed",
		});
		assert.match(updated, /^custom: \{"keep":true\}$/m);
		assert.match(updated, /^state: "closed"$/m);
		assert.match(updated, /^closedAt: "20260726T120000Z"$/m);
		assert.ok(updated.endsWith("\n# Body\nunchanged\n"));
	});

	it("can remove closure keys and add frontmatter to legacy markdown", () => {
		const reopened = updateFrontmatter('---\nstate: "closed"\noutcome: "old"\n---\nbody\n', {
			state: "open",
			outcome: undefined,
		});
		assert.doesNotMatch(reopened, /^outcome:/m);
		assert.equal(parseFrontmatter(reopened).meta.state, "open");
		assert.equal(parseFrontmatter(updateFrontmatter("# Legacy\n", { state: "active" })).meta.state, "active");
	});
});

describe("parseFrontmatter tolerance", () => {
	it("returns the whole input as body when no frontmatter exists", () => {
		const { meta, body } = parseFrontmatter("# Just markdown\n");
		assert.deepEqual(meta, {});
		assert.equal(body, "# Just markdown\n");
	});
	it("tolerates a missing closing fence", () => {
		const { meta, body } = parseFrontmatter('---\ntitle: "broken"\n# no end\n');
		assert.deepEqual(meta, {});
		assert.match(body, /no end/);
	});
	it("keeps unparseable values as raw strings", () => {
		const { meta } = parseFrontmatter("---\ntitle: not-json\n---\nbody\n");
		assert.equal(meta.title, "not-json");
	});
});
