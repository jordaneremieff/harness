import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runToolCall, type AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { publish, publicationText, type PublishOutcome } from "./publish.ts";
import {
	createReadTool,
	READ_PAGE_BYTES,
	readStored,
	readText,
	SEARCH_LIMITS,
	sourcePage,
	type ReadOutcome,
} from "./read.ts";
import { LIMITS, MarkdownStore } from "./store.ts";

async function fixture(run: (root: string, store: MarkdownStore) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "markdown-read-"));
	try {
		await run(root, new MarkdownStore(join(root, "store")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
function saved(outcome: PublishOutcome) {
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	if (!outcome.ok) throw new Error("Expected success");
	return outcome;
}
function found(outcome: ReadOutcome) {
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	if (!outcome.ok || outcome.op !== "find") throw new Error("Expected a listing");
	return outcome;
}
function read(outcome: ReadOutcome) {
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	if (!outcome.ok || outcome.op !== "read") throw new Error("Expected a page");
	return outcome;
}
function failed(outcome: ReadOutcome, code: string) {
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.equal(outcome.error.code, code);
}

test("finding lists the newest matching documents with honest coverage", () =>
	fixture(async (root, store) => {
		assert.deepEqual(found(await readStored(store, {})), {
			ok: true,
			op: "find",
			kind: "published",
			rows: [],
			matched: 0,
			scanned: 0,
			unreadable: 0,
			bounded: false,
			nextCursor: null,
		});
		const options = { cwd: root, store };
		const report = saved(await publish({ title: "Quarterly Report", text: "# Report" }, options));
		const notes = saved(await publish({ title: "Meeting notes", text: "# Notes" }, options));
		saved(await publish({ title: "Report appendix", text: "# Appendix" }, options));
		const all = found(await readStored(store, {}));
		assert.equal(all.matched, 3);
		assert.equal(all.rows.length, 3);
		assert.equal(all.rows[0]?.title, "Report appendix");
		const matching = found(await readStored(store, { query: "REPORT" }));
		assert.deepEqual(
			matching.rows.map((row) => row.title),
			["Report appendix", "Quarterly Report"],
		);
		assert.deepEqual(
			found(await readStored(store, { query: notes.documentId.slice(0, 10) })).rows.map((row) => row.id),
			[notes.documentId],
		);
		assert.equal(found(await readStored(store, { kind: "response" })).rows.length, 0);
		await mkdir(join(store.root, "documents", "md-ffffffffffffffffffff"));
		await writeFile(join(store.root, "documents", report.documentId, "document.json"), "{");
		const damaged = found(await readStored(store, {}));
		assert.equal(damaged.unreadable, 2);
		assert.equal(damaged.matched, 2);
		assert.equal(damaged.scanned, 4);
		assert.match(readText(damaged).header, /2 document directories are unreadable and not listed\./u);
		failed(await readStored(store, { revision: 1 }), "invalid");
		failed(await readStored(store, { document: notes.documentId, query: "x" }), "invalid");
	}));

test("snapshot listings skip healthy snapshots of the other kind", () =>
	fixture(async (_root, store) => {
		const input = {
			title: "Snapshot",
			source: "Exact source",
			contentOrigin: { kind: "tool" as const, capturedAt: new Date().toISOString() },
		};
		const response = await store.snapshot("response", "response", input);
		const file = await store.snapshot("file", "file", input);
		await mkdir(join(store.root, "snapshots", "md-ffffffffffffffffffff"));
		for (const snapshot of [response, file]) {
			const listing = found(await readStored(store, { kind: snapshot.document.kind }));
			assert.deepEqual(
				listing.rows.map((row) => row.id),
				[snapshot.document.id],
			);
			assert.equal(listing.unreadable, 1, "only the missing pointer is unreadable");
			assert.equal(listing.scanned, 3);
		}
	}));

test("literal title and source search preserve significant spaces and source line numbers", () =>
	fixture(async (_root, store) => {
		const input = {
			title: "A CAT publication",
			source: "first\ronly catfish here\r\nnow a CAT sleeps",
			contentOrigin: { kind: "tool" as const, capturedAt: new Date().toISOString() },
		};
		const yes = await store.create(input);
		await store.create({ ...input, title: "A catfish publication", source: "only catfish here" });
		assert.deepEqual(
			found(await readStored(store, { query: " Cat " })).rows.map((row) => row.id),
			[yes.document.id],
		);
		const matches = found(await readStored(store, { contains: " cAt " }));
		assert.deepEqual(
			matches.rows.map((row) => [row.id, row.excerpt]),
			[[yes.document.id, { line: 3, text: "now a CAT sleeps" }]],
		);
		assert.deepEqual(
			found(await readStored(store, { contains: "catfish" })).rows.find((row) => row.id === yes.document.id)?.excerpt,
			{ line: 2, text: "only catfish here" },
		);
	}));

test("a source search finds text in current revisions within stated bounds", () =>
	fixture(async (root, store) => {
		const options = { cwd: root, store };
		const alpha = saved(
			await publish({ title: "Alpha", text: "# Alpha\n\nThe migration plan uses ÄRGER as a code word.\n" }, options),
		);
		saved(await publish({ title: "Beta", text: "# Beta\n\nNothing relevant.\n" }, options));
		const gamma = saved(await publish({ title: "Gamma report", text: "# Gamma\n\nFirst.\n" }, options));
		saved(
			await publish(
				{
					title: "Gamma report",
					text: "# Gamma\n\nNow the migration is done.\n",
					document: gamma.documentId,
					expectedRevision: 1,
				},
				options,
			),
		);
		const hits = found(await readStored(store, { contains: "MIGRATION" }));
		assert.deepEqual(
			hits.rows.map((row) => [row.id, row.excerpt]),
			[
				[gamma.documentId, { line: 3, text: "Now the migration is done." }],
				[alpha.documentId, { line: 3, text: "The migration plan uses ÄRGER as a code word." }],
			],
		);
		assert.deepEqual(hits.search, {
			contains: "MIGRATION",
			candidates: 3,
			searched: 3,
			bytes: hits.search?.bytes ?? -1,
			complete: true,
			unreadable: 0,
		});
		assert.equal(hits.matched, 2);
		assert.deepEqual(
			found(await readStored(store, { contains: "ärger" })).rows.map((row) => row.id),
			[alpha.documentId],
		);
		assert.deepEqual(
			found(await readStored(store, { contains: "migration", query: "gamma" })).rows.map((row) => row.id),
			[gamma.documentId],
		);
		assert.equal(
			found(await readStored(store, { contains: "First." })).rows.length,
			0,
			"only the current revision is searched",
		);
		assert.match(
			readText(hits).header,
			/^2 published documents contain "MIGRATION" among 3 searched of 3 candidates in 3 scanned entries\.\n/u,
		);
		assert.match(
			readText(hits).header,
			/\nmd-[a-f0-9]{20} · revision 2 · .* · Gamma report\n {2}line 3: Now the migration is done\.\n/u,
		);
		await writeFile(join(store.root, "documents", alpha.documentId, "revisions", "1", "source.md"), "changed bytes");
		const damaged = found(await readStored(store, { contains: "migration" }));
		assert.equal(damaged.search?.unreadable, 1);
		assert.deepEqual(
			damaged.rows.map((row) => row.id),
			[gamma.documentId],
		);
		assert.match(readText(damaged).header, /1 document could not be read and was not searched\./u);
		failed(await readStored(store, { document: alpha.documentId, contains: "x" }), "invalid");
		failed(await readStored(store, { contains: " " }), "invalid");
		assert.equal(SEARCH_LIMITS.documents, 200);
	}));

test("source search pins candidate revisions across a concurrent publication", (t) =>
	fixture(async (root, store) => {
		const options = { cwd: root, store };
		const first = saved(await publish({ title: "Search document", text: "# Original\n\nneedle original.\n" }, options));
		const list = store.list.bind(store);
		t.mock.method(store, "list", async (params: Parameters<MarkdownStore["list"]>[0]) => {
			const candidates = await list(params);
			saved(
				await publish(
					{
						title: "Replacement title",
						text: `# Replacement\n\nneedle replacement.\n${"x".repeat(READ_PAGE_BYTES)}`,
						document: first.documentId,
						expectedRevision: 1,
					},
					options,
				),
			);
			return candidates;
		});
		const outcome = found(await readStored(store, { contains: "needle" }));
		assert.equal(outcome.matched, 1);
		assert.equal(outcome.search?.bytes, first.bytes);
		assert.deepEqual(
			outcome.rows.map(({ id, title, revision, bytes, digest, excerpt }) => ({
				id,
				title,
				revision,
				bytes,
				digest,
				excerpt,
			})),
			[
				{
					id: first.documentId,
					title: first.title,
					revision: 1,
					bytes: first.bytes,
					digest: first.digest,
					excerpt: { line: 3, text: "needle original." },
				},
			],
		);
		assert.equal(outcome.search?.complete, true);
		assert.equal(outcome.search?.unreadable, 0);
		assert.equal((await store.get(first.documentId)).document.revision, 2);
	}));

test("continued searches cover each matching document once across draft revisions", (t) =>
	fixture(async (_root, store) => {
		const input = {
			title: "Note",
			source: "shared phrase",
			contentOrigin: { kind: "tool" as const, capturedAt: new Date().toISOString() },
		};
		const ids: string[] = [];
		for (let index = 0; index < 23; index++)
			ids.push((await store.create({ ...input, title: `Note ${index}` })).document.id);

		await t.test("a title search continues in recent-update order even when an unseen draft moves", async () => {
			const params = { query: "Note" };
			const first = found(await readStored(store, params));
			assert.equal(first.rows.length, 20);
			assert.ok(first.nextCursor);
			const visited = first.rows.map(({ id }) => id);
			const pending = ids.find((id) => !visited.includes(id));
			assert.ok(pending);
			await store.update(visited[0], 1, { ...input, title: "Changed title" });
			await store.update(pending, 1, { ...input, title: "Revised note" });
			const args = { ...params, cursor: first.nextCursor };
			assert.ok(readText(first).header.includes(JSON.stringify(args)));
			const next = found(await readStored(store, args));
			assert.equal(next.nextCursor, null);
			assert.equal(next.earlierRevisionsChanged, true);
			assert.match(readText(next).header, /already examined.*changed/iu);
			assert.deepEqual(
				next.rows
					.map(({ id }) => id)
					.concat(visited)
					.sort(),
				[...ids].sort(),
			);
			assert.equal(next.rows[0]?.id, pending);
			assert.equal(next.rows[0]?.revision, 2);
		});

		await t.test("source matches continue past the row limit with the same literal filters", async () => {
			const params = { contains: "shared phrase" };
			const first = found(await readStored(store, params));
			assert.equal(first.rows.length, 20);
			assert.ok(first.nextCursor);
			for (const other of [
				{},
				{ ...params, query: "shared" },
				{ contains: "other" },
				{ ...params, kind: "file" as const },
				{ document: ids[0] },
			]) {
				failed(await readStored(store, { ...other, cursor: first.nextCursor }), "invalid");
			}
			const pending = ids.find((id) => first.rows.every((doc) => doc.id !== id));
			assert.ok(pending);
			const { document } = await store.get(pending);
			const updated = await store.update(pending, document.revision, { ...input, source: "A new shared phrase." });
			const next = found(await readStored(store, { ...params, cursor: first.nextCursor }));
			assert.equal(next.nextCursor, null);
			assert.equal(next.search?.searched, 3);
			assert.equal(next.rows[0]?.id, pending);
			assert.equal(next.rows[0]?.revision, updated.document.revision);
			assert.deepEqual(next.rows[0]?.excerpt, { line: 1, text: "A new shared phrase." });
			assert.deepEqual(
				first.rows
					.concat(next.rows)
					.map(({ id }) => id)
					.sort(),
				[...ids].sort(),
			);
		});

		await t.test("an equal-size inventory replacement invalidates the continuation", async () => {
			const params = { query: "Note" };
			const first = found(await readStored(store, params));
			assert.ok(first.nextCursor);
			await rm(join(store.root, "documents", ids[0]), { recursive: true });
			await store.create({ ...input, title: "Replacement note" });
			const changed = await readStored(store, { ...params, cursor: first.nextCursor });
			failed(changed, "inventory-changed");
			assert.match(readText(changed).header, /restart.*without.*cursor/iu);
		});
	}));

for (const [bound, count, size] of [
	["document", SEARCH_LIMITS.documents, 1],
	["byte", SEARCH_LIMITS.bytes / LIMITS.sourceBytes, LIMITS.sourceBytes],
] as const) {
	test(`an empty source page continues past its ${bound} limit`, (t) =>
		fixture(async (_root, store) => {
			const input = { title: "Note", contentOrigin: { kind: "tool" as const, capturedAt: new Date().toISOString() } };
			const miss = await store.create({ ...input, source: "x".repeat(size) });
			const hit = await store.create({ ...input, source: "needle" });
			const listing = await store.list();
			const documents = Array.from({ length: count }, (_, i) => ({
				...miss.document,
				id: `md-${i.toString(16).padStart(20, "0")}`,
			})).concat(hit.document);
			t.mock.method(store, "list", async () => ({
				...listing,
				documents,
				scanned: documents.length,
				matched: documents.length,
			}));
			const reads: string[] = [];
			t.mock.method(store, "get", async (id: string) => {
				reads.push(id);
				return id === hit.document.id
					? hit
					: { ...miss, document: { ...miss.document, id }, revision: { ...miss.revision, document: id } };
			});
			const first = found(await readStored(store, { contains: "needle" }));
			assert.deepEqual(first.rows, []);
			assert.equal(first.search?.searched, count);
			assert.equal(first.search?.bytes, count * size);
			assert.equal(first.search?.complete, false);
			assert.ok(first.nextCursor);
			const next = found(await readStored(store, { contains: "needle", cursor: first.nextCursor }));
			assert.deepEqual(
				next.rows.map(({ id }) => id),
				[hit.document.id],
			);
			assert.equal(next.search?.complete, true);
			assert.equal(next.nextCursor, null);
			assert.deepEqual(
				reads,
				documents.map(({ id }) => id),
			);
		}));
}

test("historical read guidance requires the current source before a correction", () =>
	fixture(async (root, store) => {
		const options = { cwd: root, store };
		const first = saved(await publish({ title: "Plan", text: "# Plan\n\nOriginal.\n" }, options));
		const newer = "# Plan\n\nOriginal.\nNewer work.\n";
		saved(await publish({ title: "Plan", text: newer, document: first.documentId, expectedRevision: 1 }, options));
		const historical = read(await readStored(store, { document: first.documentId, revision: 1 }));
		assert.equal(historical.status, "complete");
		const header = readText(historical).header;
		assert.doesNotMatch(header, /expectedRevision/u);
		assert.ok(
			header.includes(
				`read the current revision with markdown_read ${JSON.stringify({ document: first.documentId, revision: 2 })}`,
			),
		);
		assert.match(header, /This historical text is not the update base/u);
		const current = read(await readStored(store, { document: first.documentId, revision: historical.currentRevision }));
		assert.equal(current.status, "complete");
		assert.match(readText(current).header, /expectedRevision 2/u);
		saved(
			await publish(
				{
					title: "Plan",
					text: `${current.text}Correction.\n`,
					document: first.documentId,
					expectedRevision: current.revision,
				},
				options,
			),
		);
		assert.equal((await store.get(first.documentId)).source, `${newer}Correction.\n`);
		assert.equal((await store.get(first.documentId, 1)).source, historical.text);
	}));

test("first-page show requests resolve the full identity and preserve explicit revisions without a launch", () =>
	fixture(async (root, store) => {
		const options = { cwd: root, store };
		const first = saved(await publish({ title: "Plan", text: "# First\n" }, options));
		saved(
			await publish({ title: "Plan", text: "# Second\n", document: first.documentId, expectedRevision: 1 }, options),
		);
		const before = await readdir(store.root);
		for (const revision of [undefined, 1, 2]) {
			const exact = read(await readStored(store, { document: first.documentId.slice(0, 9), revision }));
			assert.deepEqual(exact.show, {
				op: "show",
				document: first.documentId,
				...(revision === undefined ? {} : { revision }),
			});
			assert.ok(readText(exact).header.includes(`call markdown_live ${JSON.stringify(exact.show)}`));
		}
		assert.deepEqual(await readdir(store.root), before);
	}));

test("reading returns exact pages of a named revision and the steps to correct it", () =>
	fixture(async (root, store) => {
		const options = { cwd: root, store };
		const emoji = "\u{1F998}";
		const long = `# Long\n\n${"a".repeat(READ_PAGE_BYTES - 10)}${emoji}${"b".repeat(READ_PAGE_BYTES)}\r\nend`;
		const first = saved(await publish({ title: "Long document", text: long }, options));
		const page = read(await readStored(store, { document: first.documentId.slice(0, 9) }));
		assert.equal(page.documentId, first.documentId);
		assert.equal(page.revision, 1);
		assert.equal(page.currentRevision, 1);
		assert.equal(page.digest, first.digest);
		assert.equal(page.status, "page");
		assert.ok(!("text" in page));
		assert.doesNotMatch(readText(page).header, /expectedRevision/u);
		assert.ok(Buffer.byteLength(page.fragment) <= READ_PAGE_BYTES);
		assert.ok(page.nextOffset);
		assert.equal(page.fragment.length, READ_PAGE_BYTES - 2);
		assert.equal(page.nextOffset, READ_PAGE_BYTES - 2, "a page never splits a surrogate pair");
		let text = page.fragment;
		let offset: number | null = page.nextOffset;
		while (offset !== null) {
			const next = read(await readStored(store, { document: first.documentId, revision: 1, offset }));
			assert.equal(next.status, "page");
			assert.ok(!("text" in next));
			assert.equal(next.show, undefined);
			assert.equal(next.digest, page.digest);
			assert.equal(readText(next).source, next.fragment);
			assert.match(readText(next).header, /join all its fragments in order/u);
			if (next.nextOffset === null) assert.match(readText(next).header, /final fragment/u);
			text += next.fragment;
			offset = next.nextOffset;
		}
		assert.equal(text, long);
		failed(
			await readStored(store, { document: first.documentId, revision: 1, offset: page.fragment.length + 1 }),
			"invalid",
		);
		failed(await readStored(store, { document: first.documentId, offset: page.fragment.length }), "invalid");
		assert.match(readText(page).header, /Continue with \{"document":"md-[a-f0-9]{20}","revision":1,"offset":\d+\}\./u);

		const update = saved(
			await publish(
				{ title: "Long document", text: "# Short\n", document: first.documentId, expectedRevision: 1 },
				options,
			),
		);
		const stale = await publish(
			{ title: "Long document", text: "# Stale\n", document: first.documentId, expectedRevision: 1 },
			options,
		);
		assert.equal(stale.ok, false);
		assert.match(
			publicationText(stale),
			/Revision 2 \(sha256:[a-f0-9]{64}\) is current\. Read it with markdown_read \(this document, revision 2\), apply your change to that text, and publish again with expectedRevision 2\./u,
		);
		const current = read(await readStored(store, { document: first.documentId, revision: 2 }));
		assert.equal(current.status, "complete");
		assert.ok(!("fragment" in current));
		assert.equal(current.text, "# Short\n");
		assert.equal(current.nextOffset, null);
		assert.equal(current.digest, update.digest);
		assert.match(
			readText(current).header,
			/^md-[a-f0-9]{20} revision 2 of 2 · published · "Long document" · 8 bytes · sha256:[a-f0-9]{64}\. To correct it, publish with document md-[a-f0-9]{20} and expectedRevision 2\.\nReferences not inspected: the reader app is not installed; build it with node extensions\/markdown\/native\/build\.mts\.\nTo show it, call markdown_live .*\nComplete stored source follows\.$/u,
		);
		const old = read(await readStored(store, { document: first.documentId, revision: 1, offset: 0 }));
		assert.equal(old.currentRevision, 2);
		assert.match(readText(old).header, /Revision 2 is current\./u);
		saved(
			await publish(
				{
					title: "Long document",
					text: `${current.text}More.\n`,
					document: first.documentId,
					expectedRevision: current.currentRevision,
				},
				options,
			),
		);
		failed(await readStored(store, { document: first.documentId, revision: 9 }), "not-found");
		failed(await readStored(store, { document: "md-000000" }), "not-found");
	}));

test("a read lists retained and unavailable images on its first page", () =>
	fixture(async (root, store) => {
		await writeFile(join(root, "diagram.svg"), "<svg/>");
		const path = join(root, "report.md");
		await writeFile(path, "![diagram](diagram.svg)\n![gone](gone.png)\n");
		const app = join(root, "Reader.app");
		await mkdir(join(app, "Contents/Resources"), { recursive: true });
		await writeFile(join(app, "Contents/Resources/build.json"), JSON.stringify({ contract: 1 }));
		const runner = async () =>
			JSON.stringify({ version: 1, images: ["diagram.svg", "gone.png"], links: [], truncated: false });
		const outcome = saved(await publish({ title: "Diagram", file: path }, { cwd: root, store, app, runner }));
		const page = read(await readStored(store, { document: outcome.documentId }));
		assert.deepEqual(
			page.images?.map((image) => [image.reference, image.state, image.reason ?? image.mediaType]),
			[
				["diagram.svg", "retained", "image/svg+xml"],
				["gone.png", "unavailable", "missing"],
			],
		);
		assert.equal(page.imagesOmitted, 0);
		assert.match(readText(page).header, /References: 1 image retained; 1 unavailable \("gone\.png": missing\)\./u);
		assert.deepEqual(page.show, { op: "show", document: outcome.documentId });
		const tool = createReadTool({ store });
		const result = await tool.execute("call", { document: outcome.documentId }, undefined, undefined, {} as never);
		assert.equal(result.content.length, 2);
		assert.equal(
			result.content[1]?.type === "text" ? result.content[1].text : "",
			"![diagram](diagram.svg)\n![gone](gone.png)\n",
		);
		assert.deepEqual(result.structuredContent, result.details);
	}));

test("the ordinary tool pipeline retains long lines and paged source exactly", () =>
	fixture(async (_root, store) => {
		const source = `${"x".repeat(60000)}\n${"y\n".repeat(5000)}🦘end`;
		const saved = await store.create({
			title: "Exact source",
			source,
			contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() },
		});
		const tool = createReadTool({ store });
		const adapted: AgentTool<typeof tool.parameters, ReadOutcome> = {
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			outputSchema: tool.outputSchema,
			execute: (id, params, signal, update) => tool.execute(id, params, signal, update, {} as never),
		};
		let offset: number | null = 0;
		let acquired = "";
		do {
			const args = { document: saved.document.id, revision: 1, offset };
			const call = fauxToolCall("markdown_read", args);
			const assistantMessage = fauxAssistantMessage(call, { stopReason: "toolUse" });
			const outcome = await runToolCall(call, {
				tools: [adapted],
				assistantMessage,
				context: { messages: [assistantMessage], tools: [adapted] },
			});
			assert.equal(outcome.isError, false);
			const page = read(outcome.result.details);
			const text = readText(page);
			assert.deepEqual(outcome.result.content, [
				{ type: "text", text: text.header },
				{ type: "text", text: text.source },
			]);
			assert.equal(page.status, "page");
			assert.ok(!("text" in page));
			acquired += page.fragment;
			offset = page.nextOffset;
		} while (offset !== null);
		assert.ok(acquired === source, "the ordinary pipeline retains every source code unit");
	}));

test("a complete stored source does not imply that the original response finished", () =>
	fixture(async (_root, store) => {
		const origin = { kind: "native-response" as const, capturedAt: new Date().toISOString() };
		const snapshot = await store.snapshot("interrupted", "response", {
			title: "Interrupted response",
			source: "Partial response.",
			completeness: { state: "partial", reason: "length" },
			contentOrigin: origin,
		});
		const result = read(await readStored(store, { document: snapshot.document.id }));
		assert.equal(result.status, "complete");
		assert.deepEqual(result.provenance, origin);
		assert.deepEqual(result.completeness, { state: "partial", reason: "length" });
		assert.match(readText(result).header, /captured response is partial \(length\)/u);
		assert.equal(readText(result).source, "Partial response.");
	}));

test("source pages count UTF-16 offsets and refuse a split pair", () => {
	const source = `x${"\u{1F998}"}y`;
	assert.deepEqual(sourcePage(source, 0, 1), { text: "x", nextOffset: 1 });
	assert.deepEqual(sourcePage(source, 1, 4), { text: "\u{1F998}", nextOffset: 3 });
	assert.throws(() => sourcePage(source, 2), /character boundary/u);
	assert.deepEqual(sourcePage(source, 4), { text: "", nextOffset: null });
});
