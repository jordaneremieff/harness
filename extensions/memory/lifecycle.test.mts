import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { reviewMetadataProblems, sourceFreshness } from "./lifecycle.ts";
import {
	editMemory,
	type MemoryWrite,
	MemoryWriteError,
	retireMemory,
	reviewMemory,
	sourceDigest,
	writeMemory,
} from "./store.ts";

function note(slug = "subject"): MemoryWrite {
	return {
		slug,
		title: "Subject",
		tags: [],
		summary: "Original choice.",
		details: "Qualified detail.",
		sources: "Operator statement.",
		verified: true,
	};
}
function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "memory-lifecycle-"));
	t.after(() => rmSync(root, { force: true, recursive: true }));
	writeMemory(root, note());
	const path = join(root, "subject.md");
	return { root, path, source: () => readFileSync(path, "utf8"), digest: () => sourceDigest(readFileSync(path)) };
}
function parsed(source: string) {
	const end = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(source)?.[0].length;
	assert.ok(end);
	return {
		meta: parseFrontmatter<Record<string, unknown>>(source.slice(0, end)).frontmatter,
		header: source.slice(0, end),
		body: source.slice(end),
	};
}
function failure(fn: () => unknown) {
	try {
		fn();
		assert.fail("Expected failure");
	} catch (error) {
		assert.ok(error instanceof MemoryWriteError);
		return error;
	}
}
function confirm(f: ReturnType<typeof fixture>) {
	return reviewMemory(f.root, {
		slug: "subject",
		expectedDigest: f.digest(),
		outcome: "confirmed",
		sources: "Current authoritative source.",
	});
}
function flag(f: ReturnType<typeof fixture>) {
	return reviewMemory(f.root, {
		slug: "subject",
		expectedDigest: f.digest(),
		outcome: "unresolved",
		reason: "Conflicting scoped evidence.",
		sources: "Two source statements.",
	});
}
function retire(f: ReturnType<typeof fixture>) {
	return retireMemory(f.root, {
		slug: "subject",
		expectedDigest: f.digest(),
		reason: "The operator withdrew the choice.",
		sources: "Current operator instruction.",
	});
}

test("metadata confirmation inserts optional keys and preserves every other byte", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T23:59:59.000Z") });
	const f = fixture(t);
	const before = `\uFEFF${f.source()}`
		.replace("tags: []", "# Keep this comment\ntags: []\nunknown: {owner: operator}")
		.replaceAll("\n", "\r\n")
		.concat("\n## Other\nExact tail.\n");
	writeFileSync(f.path, before);
	t.mock.timers.setTime(Date.parse("2026-01-02T00:00:01.000Z"));
	const result = reviewMemory(f.root, {
		slug: "subject",
		expectedDigest: f.digest(),
		outcome: "confirmed",
		sources: "Current source.",
		reviewPolicy: "before-use",
		reviewAfter: "2026-02-01",
	});
	const after = f.source();
	assert.equal(parsed(after).body, parsed(before).body);
	assert.equal(
		after,
		before
			.replace('updated: "2026-01-01"', 'updated: "2026-01-02"')
			.replace('verified_date: "2026-01-01"', 'verified_date: "2026-01-02"')
			.replace(
				"\r\n---\r\n",
				`\r\nreview_policy: "before-use"\r\nreview_after: "2026-02-01"\r\nlast_review: ${JSON.stringify({ date: "2026-01-02", digest: sourceDigest(before), sources: "Current source." })}\r\n---\r\n`,
			),
	);
	assert.equal(result.captured.length, 1);
	assert.equal(
		readFileSync(join(f.root, ".memory-history", "subject", `${result.captured[0].revision}.md`), "utf8"),
		before,
	);
	assert.equal(result.digest, f.digest());
});

test("optional insertion uses the closing delimiter newline and preserves an end-of-file delimiter", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00.000Z") });
	const f = fixture(t);
	const base = f.source();
	for (const [source, newline] of [
		[base.replace("superseded_by: null\n---\n", "superseded_by: null\r\n---\n"), "\n"],
		[base.replace("superseded_by: null\n---\n", "superseded_by: null\n---\r\n"), "\r\n"],
		[parsed(base).header.replace("\n---\n", "\r\n---"), "\r\n"],
	]) {
		writeFileSync(f.path, source);
		const record = { date: "2026-01-01", digest: f.digest(), sources: "Current authoritative source." };
		confirm(f);
		assert.equal(
			f.source(),
			source.replace(
				/(\r?\n)---(\r?\n|$)/,
				(_match, preceding, ending) => `${preceding}last_review: ${JSON.stringify(record)}${newline}---${ending}`,
			),
		);
	}
});

test("confirmation and unresolved reviews advance writer-touch time without advancing the deadline", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00.000Z") });
	const f = fixture(t);
	writeMemory(f.root, { ...note(), expectedDigest: f.digest(), reviewPolicy: "on-change", reviewAfter: "2026-01-03" });
	t.mock.timers.setTime(Date.parse("2026-01-04T00:00:00.000Z"));
	flag(f);
	let meta = parsed(f.source()).meta;
	assert.equal(meta.updated, "2026-01-04");
	assert.equal(meta.verified_date, "2026-01-01");
	assert.equal(meta.verified, true);
	assert.equal(meta.review_after, "2026-01-03");
	assert.deepEqual(meta.review_flag, {
		date: "2026-01-04",
		reason: "Conflicting scoped evidence.",
		sources: "Two source statements.",
	});
	t.mock.timers.setTime(Date.parse("2026-01-05T00:00:00.000Z"));
	const before = f.digest();
	confirm(f);
	meta = parsed(f.source()).meta;
	assert.equal(meta.updated, "2026-01-05");
	assert.equal(meta.verified_date, "2026-01-05");
	assert.equal(meta.review_after, "2026-01-03");
	assert.equal(meta.review_policy, "on-change");
	assert.ok(!Object.hasOwn(meta, "review_flag"));
	assert.deepEqual(meta.last_review, { date: "2026-01-05", digest: before, sources: "Current authoritative source." });
});

test("explicit review null removes optional fields without changing neighboring bytes", (t) => {
	const f = fixture(t);
	writeMemory(f.root, { ...note(), expectedDigest: f.digest(), reviewPolicy: "on-change", reviewAfter: "2026-12-01" });
	const before = f.source().replace('review_policy: "on-change"', '# Keep this comment\nreview_policy: "on-change"');
	writeFileSync(f.path, before);
	reviewMemory(f.root, {
		slug: "subject",
		expectedDigest: f.digest(),
		outcome: "unresolved",
		reason: "Source unavailable.",
		sources: "Defining source unavailable.",
		reviewPolicy: null,
		reviewAfter: null,
	});
	const after = parsed(f.source());
	assert.ok(!Object.hasOwn(after.meta, "review_policy"));
	assert.ok(!Object.hasOwn(after.meta, "review_after"));
	assert.match(after.header, /# Keep this comment\nreview_flag:/);
	assert.equal(after.body, parsed(before).body);
});

test("body edits preserve policy and prior review evidence, and only fresh attestation clears a concern", (t) => {
	const f = fixture(t);
	writeMemory(f.root, { ...note(), expectedDigest: f.digest(), reviewPolicy: "before-use", reviewAfter: "2026-12-01" });
	confirm(f);
	const review = parsed(f.source()).meta.last_review;
	flag(f);
	const concern = parsed(f.source()).meta.review_flag;
	editMemory(f.root, {
		slug: "subject",
		expectedDigest: f.digest(),
		verified: false,
		edits: [{ oldText: "Original choice.", newText: "Corrected choice." }],
	});
	let meta = parsed(f.source()).meta;
	assert.equal(meta.verified, false);
	assert.equal(meta.verified_date, null);
	assert.equal(meta.review_policy, "before-use");
	assert.equal(meta.review_after, "2026-12-01");
	assert.deepEqual(meta.last_review, review);
	assert.deepEqual(meta.review_flag, concern);
	editMemory(f.root, {
		slug: "subject",
		expectedDigest: f.digest(),
		verified: true,
		edits: [{ oldText: "Corrected choice.", newText: "Confirmed choice." }],
	});
	meta = parsed(f.source()).meta;
	assert.ok(!Object.hasOwn(meta, "review_flag"));
	assert.deepEqual(meta.last_review, review);
	assert.equal(meta.review_after, "2026-12-01");
});

test("whole rewrites require new policy selection and do not silently settle a prior concern", (t) => {
	const f = fixture(t);
	writeMemory(f.root, { ...note(), expectedDigest: f.digest(), reviewPolicy: "on-change", reviewAfter: "2026-12-01" });
	confirm(f);
	flag(f);
	const concern = parsed(f.source()).meta.review_flag;
	writeMemory(f.root, { ...note(), expectedDigest: f.digest(), verified: false });
	let meta = parsed(f.source()).meta;
	for (const key of ["review_policy", "review_after", "last_review"]) assert.ok(!Object.hasOwn(meta, key));
	assert.deepEqual(meta.review_flag, concern);
	writeMemory(f.root, { ...note(), expectedDigest: f.digest(), verified: true, reviewAfter: "2026-12-02" });
	meta = parsed(f.source()).meta;
	assert.ok(!Object.hasOwn(meta, "review_flag"));
	assert.ok(!Object.hasOwn(meta, "review_policy"));
	assert.equal(meta.review_after, "2026-12-02");
});

test("retirement preserves the body and verification; only explicit confirmed review reactivates", (t) => {
	const f = fixture(t);
	const before = parsed(f.source());
	retire(f);
	let after = parsed(f.source());
	assert.equal(after.body, before.body);
	assert.equal(after.meta.status, "retired");
	assert.equal(after.meta.superseded_by, null);
	assert.equal(after.meta.verified, before.meta.verified);
	assert.equal(after.meta.verified_date, before.meta.verified_date);
	assert.throws(() => writeMemory(f.root, { ...note(), expectedDigest: f.digest() }), /retired note/);
	assert.throws(
		() =>
			editMemory(f.root, {
				slug: "subject",
				expectedDigest: f.digest(),
				verified: false,
				edits: [{ oldText: "choice", newText: "statement" }],
			}),
		/retired note/,
	);
	assert.throws(() => confirm(f), /explicit confirmed reactivation/);
	assert.throws(() => flag(f), /explicit confirmed reactivation/);
	assert.throws(() => retire(f), /Only an active/);
	const result = reviewMemory(f.root, {
		slug: "subject",
		expectedDigest: f.digest(),
		outcome: "confirmed",
		sources: "Operator reversal and current source.",
		reactivate: true,
	});
	assert.equal(result.captured.length, 1);
	after = parsed(f.source());
	assert.equal(after.meta.status, "active");
	assert.ok(!Object.hasOwn(after.meta, "retirement"));
	assert.equal(after.body, before.body);
	assert.throws(
		() =>
			reviewMemory(f.root, {
				slug: "subject",
				expectedDigest: f.digest(),
				outcome: "confirmed",
				sources: "Source.",
				reactivate: true,
			}),
		/only to a retired/,
	);
});

test("retired targets accept explicit supersession and partial publication retries without predecessor revival", (t) => {
	const f = fixture(t);
	const a = writeMemory(f.root, note("a"));
	const b = writeMemory(f.root, { ...note("b"), supersedes: [{ slug: "a", digest: a.digest as string }] });
	retireMemory(f.root, {
		slug: "b",
		expectedDigest: b.digest as string,
		reason: "Withdrawn.",
		sources: "Operator instruction.",
	});
	const bPath = join(f.root, "b.md");
	const bBefore = readFileSync(bPath, "utf8");
	const old = writeMemory(f.root, note("other"));
	const result = failure(() =>
		writeMemory(
			f.root,
			{
				...note("replacement"),
				supersedes: [
					{ slug: "b", digest: sourceDigest(bBefore) },
					{ slug: "other", digest: old.digest as string },
				],
			},
			undefined,
			{
				beforePublish(file) {
					if (file === "other.md") throw new Error("Controlled final target failure");
				},
			},
		),
	);
	assert.deepEqual(result.receipt.written, ["replacement.md", "b.md"]);
	assert.deepEqual(result.receipt.notWritten, ["other.md"]);
	const bAfter = parsed(readFileSync(bPath, "utf8"));
	assert.equal(bAfter.meta.status, "superseded");
	assert.equal(bAfter.meta.superseded_by, "replacement");
	assert.ok(!Object.hasOwn(bAfter.meta, "retirement"));
	assert.equal(bAfter.body, parsed(bBefore).body);
	assert.equal(bAfter.meta.verified_date, parsed(bBefore).meta.verified_date);
	assert.deepEqual(bAfter.meta.supersedes, ["a"]);
	const prior = result.receipt.captured.find((capture) => capture.slug === "b");
	assert.ok(prior);
	assert.equal(readFileSync(join(f.root, ".memory-history", "b", `${prior.revision}.md`), "utf8"), bBefore);
	writeMemory(f.root, {
		...note("replacement"),
		expectedDigest: sourceDigest(readFileSync(join(f.root, "replacement.md"))),
		supersedes: [
			{ slug: "b", digest: sourceDigest(readFileSync(bPath)) },
			{ slug: "other", digest: old.digest as string },
		],
	});
	const aMeta = parsed(readFileSync(join(f.root, "a.md"), "utf8")).meta;
	assert.equal(aMeta.status, "superseded");
	assert.equal(aMeta.superseded_by, "b");
	assert.throws(
		() =>
			writeMemory(f.root, {
				...note("another"),
				supersedes: [{ slug: "b", digest: sourceDigest(readFileSync(bPath)) }],
			}),
		/another replacement/,
	);
	assert.throws(
		() =>
			reviewMemory(f.root, {
				slug: "b",
				expectedDigest: sourceDigest(readFileSync(bPath)),
				outcome: "confirmed",
				sources: "Source.",
				reactivate: true,
			}),
		/superseded note/,
	);
});

test("owned optional fields refuse aliases, duplicates, quoted keys, multiline values and invalid structures", (t) => {
	const f = fixture(t);
	const base = f.source();
	for (const field of [
		"review_policy: on-change\nreview_policy: before-use",
		'"review_policy": on-change',
		"review_policy: &policy on-change\nother: *policy",
		"other: &policy on-change\nreview_policy: *policy",
		'review_flag:\n  date: "2026-01-01"\n  reason: Concern\n  sources: Source',
		'review_after: "2026-02-30"',
		'review_flag: {date: "2026-01-01", reason: Concern, sources: Source, extra: true}',
	]) {
		const source = base.replace("\n---\n", `\n${field}\n---\n`);
		writeFileSync(f.path, source);
		assert.throws(() => confirm(f));
		assert.equal(f.source(), source);
	}
	assert.equal(existsSync(join(f.root, ".memory-history")), false);
});

test("metadata and header byte bounds refuse before capture", (t) => {
	const f = fixture(t);
	const base = f.source();
	const oversized = base.replace("\n---\n", `\nunknown: "${"x".repeat(8100)}"\n---\n`);
	writeFileSync(f.path, oversized);
	assert.throws(() => confirm(f), /8 KiB/);
	assert.equal(f.source(), oversized);
	assert.equal(existsSync(join(f.root, ".memory-history")), false);
	writeFileSync(f.path, base);
	reviewMemory(f.root, {
		slug: "subject",
		expectedDigest: f.digest(),
		outcome: "confirmed",
		sources: "界".repeat(1300),
	});
	const before = f.source();
	assert.throws(() => flag(f), /4 KiB/);
	assert.equal(f.source(), before);
});

test("new mutations reject stale digests, contention, cancellation and failed capture without live changes", (t) => {
	const f = fixture(t);
	const before = f.source();
	assert.throws(
		() =>
			reviewMemory(f.root, {
				slug: "subject",
				expectedDigest: "a".repeat(64),
				outcome: "confirmed",
				sources: "Source.",
			}),
		/digest changed/,
	);
	writeFileSync(join(f.root, ".memory-write.lock"), "Live writer");
	assert.throws(() => retire(f), /lock exists/);
	rmSync(join(f.root, ".memory-write.lock"));
	for (const operation of [reviewMemory, retireMemory]) {
		const input = {
			slug: "subject",
			expectedDigest: f.digest(),
			outcome: "unresolved" as const,
			reason: "Concern.",
			sources: "Source.",
		};
		const controller = new AbortController();
		const cancelled = failure(() =>
			operation(f.root, input, controller.signal, {
				beforeCapture() {
					controller.abort();
				},
			}),
		);
		assert.deepEqual(cancelled.receipt.written, []);
		assert.deepEqual(cancelled.receipt.captured, []);
		const refused = failure(() =>
			operation(f.root, input, undefined, {
				beforeCapture() {
					throw new Error("Controlled capture failure");
				},
			}),
		);
		assert.deepEqual(refused.receipt.written, []);
		assert.equal(f.source(), before);
		assert.equal(existsSync(join(f.root, ".memory-write.lock")), false);
	}
});

test("review and retirement preserve captures but refuse changed sources before publication", (t) => {
	const f = fixture(t);
	const original = f.source();
	for (const operation of [reviewMemory, retireMemory]) {
		writeFileSync(f.path, original);
		const result = failure(() =>
			operation(
				f.root,
				{
					slug: "subject",
					expectedDigest: f.digest(),
					outcome: "unresolved",
					reason: "Concern.",
					sources: "Source.",
				},
				undefined,
				{
					beforePublish() {
						writeFileSync(f.path, "External change");
					},
				},
			),
		);
		assert.deepEqual(result.receipt.written, []);
		assert.deepEqual(result.receipt.notWritten, ["subject.md"]);
		assert.equal(result.receipt.captured.length, 1);
		assert.equal(f.source(), "External change");
		assert.equal(
			readFileSync(join(f.root, ".memory-history", "subject", `${result.receipt.captured[0].revision}.md`), "utf8"),
			original,
		);
	}
});

test("metadata-only changes refuse credential content retained in the body before capture", (t) => {
	const f = fixture(t);
	const token = `ghp_${"x".repeat(24)}`;
	const source = f.source().replace("Qualified detail.", token);
	writeFileSync(f.path, source);
	for (const operation of [() => confirm(f), () => retire(f)]) {
		const refused = failure(operation);
		assert.match(refused.message, /Credential-like/);
		assert.ok(!refused.message.includes(token));
		assert.deepEqual(refused.receipt.captured, []);
		assert.equal(f.source(), source);
	}
	assert.equal(existsSync(join(f.root, ".memory-history")), false);
});

test("new mutation validation refuses malformed dates, outcomes and credential content without echo", (t) => {
	const f = fixture(t);
	const valid = { slug: "subject", expectedDigest: f.digest(), outcome: "confirmed" as const, sources: "Source." };
	for (const patch of [
		{ outcome: "other" },
		{ outcome: "unresolved" },
		{ reason: "Unused reason." },
		{ reviewPolicy: "daily" },
		{ reviewAfter: "2026-02-30" },
		{ reactivate: false },
		{ outcome: "unresolved", reactivate: true, reason: "Concern." },
		{ sources: " " },
		{ sources: "x".repeat(1501) },
	])
		assert.throws(() => reviewMemory(f.root, { ...valid, ...patch } as Parameters<typeof reviewMemory>[1]));
	const token = `ghp_${"x".repeat(24)}`;
	for (const field of ["reason", "sources"]) {
		assert.throws(
			() =>
				retireMemory(f.root, {
					slug: "subject",
					expectedDigest: f.digest(),
					reason: "Withdrawn.",
					sources: "Source.",
					[field]: token,
				}),
			(error) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Credential-like/);
				assert.ok(!error.message.includes(token));
				return true;
			},
		);
	}
	assert.deepEqual(readdirSync(f.root).sort(), ["README.md", "subject.md"]);
});

test("freshness exposes policy, deadline and declared verification without inferred renewal", (t) => {
	const f = fixture(t);
	const source = parsed(f.source());
	let view = sourceFreshness(source.meta, source.header, "2026-01-02");
	assert.equal(view.policy, "unclassified");
	assert.equal(view.deadline, "unscheduled");
	for (const [reviewAfter, expected] of [
		["2026-01-01", "due"],
		["2026-01-02", "due"],
		["2026-01-03", "not-due"],
	]) {
		const header = source.header.replace(
			"\n---\n",
			`\nreview_policy: before-use\nreview_after: "${reviewAfter}"\n---\n`,
		);
		view = sourceFreshness(parsed(header).meta, header, "2026-01-02");
		assert.equal(view.policy, "before-use");
		assert.equal(view.deadline, expected);
		assert.equal(view.evaluatedOn, "2026-01-02");
	}
	const bad = source.header
		.replace(/^verified_date: .*$/m, 'verified_date: "2099-01-01"')
		.replace("\n---\n", '\nreview_policy: daily\nreview_after: "2026-02-30"\n---\n');
	view = sourceFreshness(parsed(bad).meta, bad, "2026-01-02");
	assert.equal(view.policy, "unknown");
	assert.equal(view.deadline, "unknown");
	assert.ok(view.problems.includes("Verification date is in the future"));
	assert.equal(sourceFreshness(undefined, "").policy, "unknown");
	const cyclic: Record<string, unknown> = {};
	cyclic.review_flag = cyclic;
	assert.deepEqual(reviewMetadataProblems(cyclic), ["Invalid review_flag"]);
});
