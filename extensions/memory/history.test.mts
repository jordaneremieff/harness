import assert from "node:assert/strict";
import fs, {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { historyDirectory, newRevision, revisionIdentity } from "./history.ts";
import { type HistoryOptions, historyMemory, readMemory, searchMemory } from "./retrieval.ts";
import { editMemory, type MemoryWrite, MemoryWriteError, sourceDigest, writeMemory } from "./store.ts";

function corpus(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "memory-history-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
function note(slug = "subject"): MemoryWrite {
	return {
		slug,
		title: "Subject",
		tags: [],
		summary: "Original summary.",
		details: "Qualified original detail.",
		sources: "Synthetic evidence.",
		verified: true,
	};
}
function failure(fn: () => unknown): MemoryWriteError {
	try {
		fn();
		assert.fail("Expected refusal");
	} catch (error) {
		assert.ok(error instanceof MemoryWriteError);
		return error;
	}
}
function revisions(
	page: Record<string, unknown>,
): Array<{ revision: string; capturedAt: string; digest: string; bytes: number }> {
	assert.ok(Array.isArray(page.revisions));
	return page.revisions as Array<{ revision: string; capturedAt: string; digest: string; bytes: number }>;
}

test("history plans require explicit exact UTC cutoff and bounded retention floor", async (t) => {
	const root = corpus(t);
	writeFileSync(join(root, "README.md"), "Contract");
	const cutoff = "2026-09-29T00:00:00.000Z";
	for (const plan of [
		null,
		[],
		{},
		{ capturedBefore: cutoff },
		{ keepNewest: 0 },
		{ capturedBefore: cutoff, keepNewest: 0, remove: true },
		...[
			"2026-09-29",
			"2026-09-29T00:00:00Z",
			"2026-09-29T00:00:00.000+00:00",
			"2026-02-30T00:00:00.000Z",
			"2026-09-29T24:00:00.000Z",
			null,
			0,
		].map((capturedBefore) => ({ capturedBefore, keepNewest: 0 })),
		...[-1, 1.5, 16385, null, "1", Infinity].map((keepNewest) => ({ capturedBefore: cutoff, keepNewest })),
	]) {
		await assert.rejects(
			historyMemory(root, { slug: "subject", plan } as HistoryOptions),
			/options|unknown option|plan\./,
		);
	}
	for (const keepNewest of [0, 16384]) {
		const result = await historyMemory(root, { slug: "subject", plan: { capturedBefore: cutoff, keepNewest } });
		const plan = result.plan as Record<string, unknown>;
		assert.deepEqual(result.revisions, []);
		assert.equal(plan.availableBytes, 0);
		assert.equal(plan.keepBytes, 0);
		assert.equal(plan.candidateBytes, 0);
		assert.equal(plan.unavailable, 0);
		assert.equal(plan.keepNewest, keepNewest);
		assert.equal(result.nextCursor, null);
	}
	assert.equal(existsSync(join(root, ".memory-history")), false);
});

test("history plans bind both decisions to continuations and select exact names across metadata pages", async (t) => {
	const root = corpus(t);
	writeFileSync(join(root, "README.md"), "Contract");
	const directory = historyDirectory(root, "subject", true) as string;
	const records = [
		["20260930T000000000Z", "000000000001", "Newest source."],
		["20260929T000000000Z", "000000000001", "At the cutoff."],
		["20260928T000000000Z", "000000000003", "Retained older tie."],
		["20260928T000000000Z", "000000000002", "Candidate tie one."],
		["20260928T000000000Z", "000000000001", "Candidate tie two 😀."],
	].map(([stamp, suffix, source]) => {
		const digest = sourceDigest(source);
		const revision = `${stamp}-00000000-0000-0000-0000-${suffix}-${digest}`;
		writeFileSync(join(directory, `${revision}.md`), source);
		return { revision, digest, bytes: Buffer.byteLength(source) };
	});
	writeFileSync(join(directory, "unrecognized.md"), "Excluded entry.");
	const plan = { capturedBefore: "2026-09-29T00:00:00.000Z", keepNewest: 3 };
	const first = await historyMemory(root, { slug: "subject", limit: 1, plan });
	const cursor = first.nextCursor as string;
	for (const changed of [
		undefined,
		{ ...plan, keepNewest: 2 },
		{ ...plan, capturedBefore: "2026-09-28T00:00:00.000Z" },
	])
		await assert.rejects(historyMemory(root, { slug: "subject", cursor, plan: changed }), /request changed/);
	const plain = await historyMemory(root, { slug: "subject", limit: 1 });
	assert.equal(plain.plan, undefined);
	assert.equal((revisions(plain)[0] as Record<string, unknown>).selection, undefined);
	await assert.rejects(
		historyMemory(root, { slug: "subject", cursor: plain.nextCursor as string, plan }),
		/request changed/,
	);
	const pages = [first];
	let next = cursor;
	for (let guard = 0; guard < 5; guard++) {
		const page = await historyMemory(root, {
			slug: "subject",
			cursor: next,
			limit: 2,
			plan: { keepNewest: 3, capturedBefore: plan.capturedBefore },
		});
		pages.push(page);
		if (!page.nextCursor) break;
		next = page.nextCursor as string;
	}
	const selected = pages.flatMap((page) => page.revisions as Array<Record<string, unknown>>);
	assert.deepEqual(
		selected.map((item) => item.revision),
		records.map((item) => item.revision),
	);
	assert.deepEqual(
		selected.map((item) => item.selection),
		["keep", "keep", "keep", "candidate", "candidate"],
	);
	assert.deepEqual(
		selected.map((item) => item.reason),
		[
			"newest-retention-floor",
			"newest-retention-floor",
			"newest-retention-floor",
			"before-cutoff-outside-floor",
			"before-cutoff-outside-floor",
		],
	);
	for (const page of pages) {
		const items = page.revisions as Array<Record<string, unknown>>;
		const totals = page.plan as Record<string, unknown>;
		assert.equal(totals.scope, "metadata-page");
		assert.equal(totals.digestsVerified, false);
		assert.equal(
			totals.availableBytes,
			items.reduce((sum, item) => sum + (item.bytes as number), 0),
		);
		assert.equal(
			totals.keepBytes,
			items.reduce((sum, item) => sum + (item.selection === "keep" ? (item.bytes as number) : 0), 0),
		);
		assert.equal(
			totals.candidateBytes,
			items.reduce((sum, item) => sum + (item.selection === "candidate" ? (item.bytes as number) : 0), 0),
		);
		assert.equal((totals.kept as number) + (totals.candidates as number), items.length);
		assert.equal((page.coverage as Record<string, unknown>).excludedEntries, 1);
		assert.ok(Buffer.byteLength(JSON.stringify(page)) + 1 <= 48 * 1024);
	}
	const cutoff = await historyMemory(root, { slug: "subject", plan: { ...plan, keepNewest: 0 } });
	assert.deepEqual(
		(cutoff.revisions as Array<Record<string, unknown>>).map((item) => item.reason),
		[
			"at-or-after-cutoff",
			"at-or-after-cutoff",
			"before-cutoff-outside-floor",
			"before-cutoff-outside-floor",
			"before-cutoff-outside-floor",
		],
	);
	writeFileSync(join(directory, `${newRevision("b".repeat(64))}.md`), "New inventory name.");
	await assert.rejects(historyMemory(root, { slug: "subject", cursor, plan }), /inventory changed/);
});

test("history plans count unavailable names in the floor and report page gaps without source reads or writes", async (t) => {
	const root = corpus(t);
	writeFileSync(join(root, "README.md"), "Contract");
	const directory = historyDirectory(root, "subject", true) as string;
	const source = "Available older capture.";
	const digest = sourceDigest(source);
	const unavailable = `20260929T000000000Z-00000000-0000-0000-0000-000000000001-${digest}`;
	const available = `20260928T000000000Z-00000000-0000-0000-0000-000000000001-${digest}`;
	mkdirSync(join(directory, `${unavailable}.md`));
	writeFileSync(join(directory, `${available}.md`), source);
	const names = readdirSync(directory).sort();
	const plan = { capturedBefore: "2026-09-30T00:00:00.000Z", keepNewest: 1 };
	t.mock.method(fs, "readSync", () => {
		throw new Error("Plans must not open historical bodies");
	});
	t.mock.method(fs, "writeFileSync", () => {
		throw new Error("Plans must not write state");
	});
	syncBuiltinESMExports();
	try {
		const first = await historyMemory(root, { slug: "subject", plan, limit: 1 });
		assert.deepEqual(first.revisions, []);
		assert.equal((first.plan as Record<string, unknown>).unavailable, 1);
		assert.equal((first.plan as Record<string, unknown>).availableBytes, 0);
		assert.equal((first.coverage as Record<string, unknown>).bodiesRead, false);
		assert.match(
			(first.plan as Record<string, unknown>).meaning as string,
			/including unavailable revisions.*gaps remain unknown.*no recoverable copies.*no retained storage/,
		);
		const last = await historyMemory(root, { slug: "subject", plan, cursor: first.nextCursor as string });
		const item = (last.revisions as Array<Record<string, unknown>>)[0];
		assert.equal(item.revision, available);
		assert.equal(item.selection, "candidate");
		assert.equal((last.plan as Record<string, unknown>).candidateBytes, Buffer.byteLength(source));
		assert.equal((last.plan as Record<string, unknown>).keepBytes, 0);
		assert.equal((last.plan as Record<string, unknown>).unavailable, 0);
		assert.equal(last.nextCursor, null);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
	assert.deepEqual(readdirSync(directory).sort(), names);
	assert.equal(readFileSync(join(directory, `${available}.md`), "utf8"), source);
});

test("historical pages expose captured retirement and freshness without claiming current lifecycle", async (t) => {
	const root = corpus(t);
	writeFileSync(join(root, "README.md"), "Contract");
	const directory = historyDirectory(root, "subject", true) as string;
	const retirement = { date: "2026-09-01", reason: "Withdrawal", sources: "Synthetic instruction." };
	const prior = `---\nstatus: retired\nsuperseded_by: null\nverified: true\nverified_date: 2025-01-01\nreview_policy: on-change\nretirement: ${JSON.stringify(retirement)}\n---\n# Subject\n${"Historical source.\n".repeat(1500)}`;
	const digest = sourceDigest(prior);
	const revision = `20260902T000000000Z-00000000-0000-0000-0000-000000000001-${digest}`;
	writeFileSync(join(directory, `${revision}.md`), prior);
	writeFileSync(join(root, "subject.md"), "---\nstatus: active\nsuperseded_by: null\n---\n# Current subject");
	let offset = 0;
	let reconstructed = "";
	let pages = 0;
	for (let guard = 0; guard < 10; guard++) {
		const page = await readMemory(root, { slug: "subject", revision, digest, offset });
		assert.equal(page.source, "history");
		assert.equal((page.lifecycle as Record<string, unknown>).status, "retired");
		assert.deepEqual((page.freshness as Record<string, unknown>).retirement, retirement);
		assert.equal((page.freshness as Record<string, unknown>).verifiedDate, "2025-01-01");
		assert.match(page.authority as string, /Lifecycle describes this prior source, not the current note/);
		reconstructed += page.content as string;
		pages++;
		if (!page.hasMore) break;
		offset = page.nextOffset as number;
	}
	assert.ok(pages > 1);
	assert.equal(reconstructed, prior);
	assert.equal(((await readMemory(root, { slug: "subject" })).lifecycle as Record<string, unknown>).status, "active");
});

test("new notes and read-only history calls create no archives; overwrites capture separate exact prior inodes", async (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	assert.deepEqual(first.captured, []);
	assert.equal(existsSync(join(root, ".memory-history")), false);
	assert.deepEqual(revisions(await historyMemory(root, { slug: "subject" })), []);
	assert.equal(existsSync(join(root, ".memory-history")), false);
	const path = join(root, "subject.md");
	const prior = `\uFEFF${readFileSync(path, "utf8")}`;
	writeFileSync(path, prior);
	const receipt = writeMemory(root, { ...note(), summary: "New summary.", expectedDigest: sourceDigest(prior) });
	assert.equal(receipt.captured.length, 1);
	assert.deepEqual(receipt.historyOmitted, []);
	const capture = receipt.captured[0];
	const archive = join(root, ".memory-history", "subject", `${capture.revision}.md`);
	assert.equal(readFileSync(archive, "utf8"), prior);
	assert.equal(capture.digest, sourceDigest(Buffer.from(prior)));
	assert.equal(capture.bytes, Buffer.byteLength(prior));
	assert.equal(lstatSync(archive).nlink, 1);
	assert.notEqual(lstatSync(archive).ino, lstatSync(path).ino);
	const page = await readMemory(root, { slug: "subject", revision: capture.revision, digest: capture.digest });
	assert.equal(page.content, prior);
	assert.equal(page.source, "history");
	assert.equal(page.revision, capture.revision);
	assert.match(page.authority as string, /not current authority/);
	assert.equal(revisions(await historyMemory(root, { slug: "subject" }))[0].revision, capture.revision);
	assert.equal((await searchMemory(root, { query: '"Original summary"' })).totalMatches, 0);
	assert.equal((await searchMemory(root)).totalNotes, 1);
});

test("all reciprocal prior captures precede any live publication, and failed writes keep separate receipts", (t) => {
	const root = corpus(t);
	const destination = writeMemory(root, note("destination"));
	const a = writeMemory(root, note("a"));
	const b = writeMemory(root, note("b"));
	const originalA = readFileSync(join(root, "a.md"), "utf8");
	const originalB = readFileSync(join(root, "b.md"), "utf8");
	const result = failure(() =>
		writeMemory(
			root,
			{
				...note("destination"),
				expectedDigest: destination.digest,
				supersedes: [
					{ slug: "a", digest: a.digest as string },
					{ slug: "b", digest: b.digest as string },
				],
			},
			undefined,
			{
				beforePublish(file) {
					for (const slug of ["destination", "a", "b"])
						assert.equal(readdirSync(join(root, ".memory-history", slug)).length, 1);
					if (file === "b.md") throw new Error("Controlled live publication refusal");
				},
			},
		),
	);
	assert.deepEqual(
		result.receipt.captured.map((capture) => capture.slug),
		["destination", "a", "b"],
	);
	assert.deepEqual(result.receipt.written, ["destination.md", "a.md"]);
	assert.deepEqual(result.receipt.notWritten, ["b.md"]);
	assert.equal(readFileSync(join(root, "b.md"), "utf8"), originalB);
	assert.notEqual(readFileSync(join(root, "a.md"), "utf8"), originalA);
	assert.equal(existsSync(join(root, ".memory-write.lock")), false);
});

for (const phase of ["write", "sync", "close", "directory-sync", "directory-close", "publish"] as const) {
	test(`archive ${phase} failure refuses every live publication and retains truthful captures`, (t) => {
		const root = corpus(t);
		const created = writeMemory(root, note());
		const before = readFileSync(join(root, "subject.md"), "utf8");
		const descriptors = new Map<number, string>();
		const open = fs.openSync;
		const close = fs.closeSync;
		const sync = fs.fsyncSync;
		const write = fs.writeFileSync;
		const link = fs.linkSync;
		let failed = false;
		const refuse = () => {
			failed = true;
			throw Object.assign(new Error("Controlled archive failure"), { code: "EIO" });
		};
		t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
			const fd = open(...args);
			descriptors.set(fd, String(args[0]));
			return fd;
		});
		t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
			if (
				!failed &&
				phase === "write" &&
				typeof args[0] === "number" &&
				descriptors.get(args[0])?.includes(".memory-history")
			)
				refuse();
			return write(...args);
		});
		t.mock.method(fs, "fsyncSync", (fd: number) => {
			const path = descriptors.get(fd) ?? "";
			if (
				!failed &&
				path.includes(".memory-history") &&
				((phase === "sync" && path.endsWith(".tmp")) || (phase === "directory-sync" && !path.endsWith(".tmp")))
			)
				refuse();
			return sync(fd);
		});
		t.mock.method(fs, "closeSync", (fd: number) => {
			const path = descriptors.get(fd) ?? "";
			descriptors.delete(fd);
			close(fd);
			if (
				!failed &&
				path.includes(".memory-history") &&
				((phase === "close" && path.endsWith(".tmp")) || (phase === "directory-close" && !path.endsWith(".tmp")))
			)
				refuse();
		});
		t.mock.method(fs, "linkSync", (...args: Parameters<typeof fs.linkSync>) => {
			if (!failed && phase === "publish" && String(args[1]).includes(".memory-history")) refuse();
			return link(...args);
		});
		syncBuiltinESMExports();
		try {
			const result = failure(() =>
				writeMemory(root, { ...note(), summary: "Changed summary.", expectedDigest: created.digest }),
			);
			assert.equal(failed, true);
			assert.deepEqual(result.receipt.written, []);
			assert.deepEqual(result.receipt.notWritten, ["subject.md"]);
			assert.equal(result.receipt.captured.length, phase.startsWith("directory-") ? 1 : 0);
			assert.equal(readFileSync(join(root, "subject.md"), "utf8"), before);
			assert.equal(existsSync(join(root, ".memory-write.lock")), false);
			assert.ok(readdirSync(join(root, ".memory-history", "subject")).every((name) => !name.endsWith(".tmp")));
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		}
	});
}

test("cancellation and changed sources before capture leave live files untouched", (t) => {
	const root = corpus(t);
	const a = writeMemory(root, note("a"));
	const b = writeMemory(root, note("b"));
	const controller = new AbortController();
	const cancelled = failure(() =>
		writeMemory(
			root,
			{
				...note("new"),
				supersedes: [
					{ slug: "a", digest: a.digest as string },
					{ slug: "b", digest: b.digest as string },
				],
			},
			controller.signal,
			{
				beforeCapture(file) {
					if (file === "b.md") controller.abort();
				},
			},
		),
	);
	assert.deepEqual(cancelled.receipt.written, []);
	assert.deepEqual(
		cancelled.receipt.captured.map((capture) => capture.slug),
		["a"],
	);
	assert.equal(existsSync(join(root, "new.md")), false);
	const changed = failure(() =>
		writeMemory(root, { ...note("a"), expectedDigest: a.digest }, undefined, {
			beforeCapture() {
				writeFileSync(join(root, "a.md"), "External change");
			},
		}),
	);
	assert.match(changed.message, /changed before history capture/);
	assert.deepEqual(changed.receipt.captured, []);
	assert.deepEqual(changed.receipt.written, []);
});

test("credential removal succeeds without archiving or reporting forbidden prior bytes", async (t) => {
	const root = corpus(t);
	writeMemory(root, note());
	const path = join(root, "subject.md");
	const token = `ghp_${"x".repeat(24)}`;
	const source = readFileSync(path, "utf8").replace("Qualified original detail.", token);
	writeFileSync(path, source);
	const result = editMemory(root, {
		slug: "subject",
		expectedDigest: sourceDigest(source),
		verified: false,
		edits: [{ oldText: token, newText: "Credential removed." }],
	});
	assert.deepEqual(result.historyOmitted, [{ file: "subject.md", reason: "credential-policy" }]);
	assert.deepEqual(result.captured, []);
	assert.equal(JSON.stringify(result).includes(token), false);
	assert.equal(existsSync(join(root, ".memory-history")), false);
	assert.equal(readFileSync(path, "utf8").includes(token), false);
	assert.deepEqual(revisions(await historyMemory(root, { slug: "subject" })), []);
});

test("capture IDs retain distinct same-millisecond versions, and lists use capture time rather than source dates or mtime", async (t) => {
	const root = corpus(t);
	writeMemory(root, note());
	const source = readFileSync(join(root, "subject.md"), "utf8");
	const digest = sourceDigest(source);
	const directory = historyDirectory(root, "subject", true) as string;
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T12:00:00.000Z") });
	const ids = Array.from({ length: 3 }, () => newRevision(digest));
	assert.ok(ids.every((id) => id.startsWith("20260101T120000000Z-")));
	assert.equal(new Set(ids).size, 3);
	const earliest = `20200101T000000000Z-00000000-0000-0000-0000-000000000001-${digest}`;
	for (const id of [...ids, earliest]) writeFileSync(join(directory, `${id}.md`), source);
	writeFileSync(join(directory, "bad.md"), "Not a captured revision");
	const listed: string[] = [];
	let cursor: string | undefined;
	for (let guard = 0; guard < 6; guard++) {
		const page = await historyMemory(root, { slug: "subject", cursor, limit: 1 });
		listed.push(...revisions(page).map((item) => item.revision));
		if (!page.nextCursor) break;
		cursor = page.nextCursor as string;
	}
	assert.deepEqual(listed, [...ids, earliest].sort().reverse());
	assert.equal(revisionIdentity(earliest).capturedAt, "2020-01-01T00:00:00.000Z");
	const first = await historyMemory(root, { slug: "subject", limit: 1 });
	writeFileSync(join(directory, `${newRevision(digest)}.md`), source);
	await assert.rejects(
		historyMemory(root, { slug: "subject", cursor: first.nextCursor as string }),
		/inventory changed/,
	);
	await assert.rejects(readMemory(root, { slug: "README", revision: earliest }), /lowercase subject/);
	await assert.rejects(readMemory(root, { slug: "subject", revision: "bad" }), /revision ID/);
	writeFileSync(join(directory, `${earliest}.md`), "Corrupt capture");
	await assert.rejects(readMemory(root, { slug: "subject", revision: earliest }), /digest mismatch/);
});

test("historical digest and availability refusals recover through the exact revision, never current search", async (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	const changed = writeMemory(root, { ...note(), summary: "Changed summary.", expectedDigest: first.digest });
	const capture = changed.captured[0];
	await assert.rejects(
		readMemory(root, { slug: "subject", revision: capture.revision, digest: changed.digest }),
		(error: Error) => {
			assert.match(error.message, /memory_history.*same revision.*listed digest/);
			assert.doesNotMatch(error.message, /memory_search/);
			return true;
		},
	);
	const listed = revisions(await historyMemory(root, { slug: "subject" }))[0];
	const prior = await readMemory(root, { slug: "subject", revision: listed.revision, digest: listed.digest });
	assert.match(prior.content as string, /Original summary/);
	rmSync(join(root, ".memory-history", "subject", `${capture.revision}.md`));
	await assert.rejects(readMemory(root, { slug: "subject", revision: capture.revision }), (error: Error) => {
		assert.match(error.message, /Historical revision unavailable.*memory_history.*do not substitute the current note/);
		assert.doesNotMatch(error.message, /memory_search/);
		return true;
	});
	assert.match((await readMemory(root, { slug: "subject" })).content as string, /Changed summary/);
});

test("history listing reads only names and metadata, and reports unavailable revision entries", async (t) => {
	const root = corpus(t);
	writeMemory(root, note());
	const directory = historyDirectory(root, "subject", true) as string;
	const revision = newRevision("a".repeat(64));
	mkdirSync(join(directory, `${revision}.md`));
	t.mock.method(fs, "readSync", () => {
		throw new Error("Historical bodies must not be read by listing");
	});
	syncBuiltinESMExports();
	try {
		const result = await historyMemory(root, { slug: "subject" });
		assert.deepEqual(result.revisions, []);
		assert.equal((result.coverage as Record<string, unknown>).unavailable, 1);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("history directory obstruction blocks overwrites without blocking new-note creation", (t) => {
	const root = corpus(t);
	const first = writeMemory(root, note());
	writeFileSync(join(root, ".memory-history"), "Not a directory");
	const result = failure(() => writeMemory(root, { ...note(), expectedDigest: first.digest }));
	assert.deepEqual(result.receipt.written, []);
	assert.match(result.message, /real directories|ENOTDIR/);
	assert.equal(writeMemory(root, note("another")).ok, true);
});
