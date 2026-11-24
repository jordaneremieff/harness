import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	captureReferences,
	inspectReferences,
	fileSnapshotInput,
	createNativePublishTool,
	createPublishTool,
	invocationDigest,
	NATIVE_PUBLISH_GUIDANCE,
	publish,
	publishDescription,
	publicationText,
	type InspectionResult,
	type PublishOutcome,
	type PublishInput,
} from "./publish.ts";
import type { WritingBrief } from "./brief.ts";
import { createBriefTool, createNativeBriefTool } from "./brief-tool.ts";
import { LIMITS, MarkdownStore, type PublicationPlan, type WriteResult } from "./store.ts";
import type { PaneInventory } from "./pane-state.ts";
const scratch = tmpdir();
async function fixture(run: (root: string, store: MarkdownStore) => Promise<void>) {
	const root = await mkdtemp(join(scratch, "markdown-publish-"));
	try {
		await run(root, new MarkdownStore(join(root, "store")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
async function inspection(root: string, images: string[] = [], links: string[] = [], truncated = false) {
	const app = join(root, "Reader.app");
	await mkdir(join(app, "Contents/Resources"), { recursive: true });
	await writeFile(join(app, "Contents/Resources/build.json"), JSON.stringify({ contract: 1 }));
	return { app, runner: async () => JSON.stringify({ version: 1, images, links, truncated }) };
}
const images = (result: InspectionResult) => ("inspection" in result ? result.inspection.images : undefined);
function error(outcome: PublishOutcome, code: string) {
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.equal(outcome.error.code, code);
}
function success(outcome: PublishOutcome) {
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	if (!outcome.ok) throw new Error("Expected success");
	return outcome;
}
test("publication validates every outcome code and preserves exact Unicode source", () =>
	fixture(async (root, store) => {
		const options = { cwd: root, store };
		const first = success(await publish({ title: "文書 🦘", text: "# 你好\nCafé 🦘\n" }, options));
		assert.equal((await store.get(first.documentId)).source, "# 你好\nCafé 🦘\n");
		error(await publish({ title: "x" }, options), "invalid");
		for (const text of ["", " \n\t"]) error(await publish({ title: "Blank", text }, options), "invalid");
		success(await publish({ title: "Family 👩‍👩‍👧‍👦 Café", text: "exact" }, options));
		for (const title of ["bad\u202etitle", "bad\u2066title", "bad\u2028title"])
			error(await publish({ title, text: "exact" }, options), "invalid");
		error(await publish({ title: "x", text: "", file: "a" }, options), "invalid");
		error(await publish({ title: "bad\ntitle", text: "a" }, options), "invalid");
		error(await publish({ title: "x", text: "a", expectedRevision: 1 }, options), "invalid");
		error(
			await publish({ title: "x", text: "a", document: first.documentId, expectedRevision: 0 }, options),
			"invalid",
		);
		error(await publish({ title: "x", text: "a", reuseKey: "" }, options), "invalid");
		error(
			await publish({ title: "x", text: "a", document: "md-00000000000000000000", expectedRevision: 1 }, options),
			"not-found",
		);
		const update = success(
			await publish({ title: "new", text: "new", document: first.documentId, expectedRevision: 1 }, options),
		);
		assert.equal(update.revision, 2);
		const conflict = await publish(
			{ title: "stale", text: "stale", document: first.documentId, expectedRevision: 1 },
			options,
		);
		error(conflict, "conflict");
		if (!conflict.ok) assert.equal(conflict.error.currentRevision, 2);
		success(await publish({ title: "reuse", text: "same", reuseKey: "key" }, options));
		error(await publish({ title: "reuse", text: "different", reuseKey: "key" }, options), "replay-conflict");
		error(await publish({ title: "x", file: "absent.md" }, options), "file-unreadable");
		await writeFile(join(root, "blocked"), "regular file");
		error(
			await publish({ title: "x", text: "x" }, { ...options, store: new MarkdownStore(join(root, "blocked")) }),
			"store-failure",
		);
	}));
test("file capture accepts relative and absolute UTF-8 sources and never changes them", () =>
	fixture(async (root, store) => {
		const options = { cwd: root, store };
		const path = join(root, "source.md");
		const content = Buffer.from("# Exact\r\n文書 🦘\r\n");
		await writeFile(path, content);
		for (const file of ["source.md", path]) {
			const saved = success(await publish({ title: "File", file }, options));
			assert.deepEqual(Buffer.from((await store.get(saved.documentId)).source), content);
		}
		assert.deepEqual(await readFile(path), content);
		assert.equal((await fileSnapshotInput(path, { cwd: root })).title, "source.md");
		await writeFile(join(root, "invalid.md"), Buffer.from([0xff, 0xfe]));
		error(await publish({ title: "x", file: "invalid.md" }, options), "file-unreadable");
		error(await publish({ title: "x", file: root }, options), "file-unreadable");
		await writeFile(path, "a".repeat(LIMITS.sourceBytes));
		assert.equal(success(await publish({ title: "limit", file: path }, options)).bytes, LIMITS.sourceBytes);
		await truncate(path, LIMITS.sourceBytes + 1);
		error(await publish({ title: "limit", file: path }, options), "too-large");
		assert.equal(
			success(await publish({ title: "limit", text: "a".repeat(LIMITS.sourceBytes) }, options)).bytes,
			LIMITS.sourceBytes,
		);
		error(await publish({ title: "limit", text: "a".repeat(LIMITS.sourceBytes + 1) }, options), "too-large");
	}));
test("asset manifest captures retained, remote, missing, traversal, symlink, size and unsupported references", () =>
	fixture(async (root, store) => {
		const project = join(root, "project");
		await mkdir(project);
		await writeFile(join(project, "a.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		await writeFile(join(root, "outside.png"), "outside");
		await symlink(join(root, "outside.png"), join(project, "escape.png"));
		await writeFile(join(project, "large.png"), "");
		await truncate(join(project, "large.png"), LIMITS.assetBytes + 1);
		await writeFile(join(project, "script.js"), "alert(1)");
		const refs = [
			"a.png",
			"https://example.invalid/beacon.png",
			"missing.png",
			"../outside.png",
			"escape.png",
			"large.png",
			"script.js",
			"javascript:alert(1)",
		];
		const source = refs.map((ref) => `![x](${ref})`).join("\n");
		const path = join(project, "source.md");
		await writeFile(path, source);
		const parser = await inspection(root, refs);
		const outcome = success(await publish({ title: "Assets", file: path }, { cwd: root, store, ...parser }));
		const { unavailableItems, ...counts } = outcome.references;
		assert.equal(outcome.selfContained, false);
		assert.deepEqual(counts, {
			state: "inspected",
			truncated: false,
			omitted: 0,
			retained: 1,
			embedded: 0,
			external: 1,
			unavailable: 6,
			localLinks: 0,
		});
		assert.deepEqual(
			unavailableItems,
			[
				["missing.png", "missing"],
				["../outside.png", "outside-root"],
				["escape.png", "outside-root"],
				["large.png", "too-large"],
				["script.js", "unsupported-type"],
			].map(([reference, reason]) => ({ reference, reason })),
		);
		assert.match(
			publicationText(outcome),
			/References: 1 image retained; 1 external image; 6 unavailable \("missing\.png": missing, .*, …\)\./u,
		);
		const stored = await store.get(outcome.documentId);
		assert.deepEqual(
			stored.revision.references.items.slice(2, 7).map((asset) => asset.reason),
			["missing", "outside-root", "outside-root", "too-large", "unsupported-type"],
		);
		assert.equal(await readFile(path, "utf8"), source);
		assert.equal(
			(await captureReferences({ inspection: { version: 1, images: ["a.png"], links: [], truncated: false } }))
				.references.items[0]?.reason,
			"no-base",
		);
		await writeFile(path, "![x](a.png)");
		assert.equal(
			success(
				await publish({ title: "Contained", file: path }, { cwd: root, store, ...(await inspection(root, ["a.png"])) }),
			).selfContained,
			true,
		);
	}));
test("asset containment rejects a descriptor opened through a restored ancestor swap", () =>
	fixture(async (root) => {
		const project = join(root, "project");
		const images = join(project, "images");
		const held = join(project, "held");
		const outside = join(root, "outside");
		await mkdir(images, { recursive: true });
		await mkdir(outside);
		await writeFile(join(images, "a.png"), "inside");
		await writeFile(join(outside, "a.png"), "outside");
		let swaps = 0;
		const opener: typeof open = async (path, flags, mode) => {
			await rename(images, held);
			try {
				await symlink(outside, images);
				const handle = await open(path, flags, mode);
				swaps++;
				return handle;
			} finally {
				await rm(images, { force: true });
				await rename(held, images);
			}
		};
		const result = await captureReferences(
			{ inspection: { version: 1, images: ["images/a.png"], links: [], truncated: false } },
			project,
			opener,
		);
		assert.equal(swaps, 1);
		assert.equal(result.assets.length, 0);
		assert.equal(result.references.items[0]?.state, "unavailable");
		assert.equal(result.references.items[0]?.reason, "outside-root");
		assert.equal(await readFile(join(images, "a.png"), "utf8"), "inside");
	}));
test("parser inventory enforces item, retained count and total byte limits", () =>
	fixture(async (root) => {
		for (let i = 0; i < 5; i++) {
			const path = join(root, `${i}.png`);
			await writeFile(path, "");
			await truncate(path, LIMITS.assetBytes);
		}
		const captured = await captureReferences(
			{
				inspection: {
					version: 1,
					images: Array.from({ length: 5 }, (_, i) => `${i}.png`),
					links: [],
					truncated: false,
				},
			},
			root,
		);
		assert.equal(captured.assets.length, 4);
		assert.equal(captured.references.items[4]?.reason, "limit");
		const bounded = await captureReferences(
			{
				inspection: {
					version: 1,
					images: Array.from({ length: 300 }, (_, i) => `https://example.invalid/${i}.png`),
					links: [],
					truncated: true,
				},
			},
			root,
		);
		assert.equal(bounded.references.items.length, 256);
		assert.equal(bounded.references.omitted, 44);
		assert.equal(bounded.references.truncated, true);
		await writeFile(join(root, "small.png"), "image");
		const count = await captureReferences(
			{
				inspection: {
					version: 1,
					images: Array.from({ length: 65 }, (_, i) => `small.png?${i}`),
					links: [],
					truncated: false,
				},
			},
			root,
		);
		assert.equal(count.assets.length, 64);
		assert.equal(count.references.items[64]?.reason, "limit");
	}));
test("a publication with the maximum number of long external references stays within the reader's record limit", () =>
	fixture(async (root, store) => {
		const images = Array.from({ length: 300 }, (_, i) => `https://example.invalid/${i}/${"a".repeat(4000)}.png`);
		const text = images.map((reference) => `![x](${reference})`).join("\n\n");
		const outcome = success(
			await publish({ title: "Long references", text }, { cwd: root, store, ...(await inspection(root, images)) }),
		);
		const record = join(store.root, "documents", outcome.documentId, "revisions/1/revision.json");
		const { size } = await stat(record);
		assert.ok(size < LIMITS.recordBytes, `${size} bytes`);
		const stored = await store.get(outcome.documentId);
		assert.equal(stored.source, text);
		assert.equal(stored.revision.references.items.length, 256);
		assert.equal(stored.revision.references.omitted, 44);
		assert.equal(stored.revision.references.items[0]?.reference, images[0]?.slice(0, 512));
	}));
test("metadata keeps a retained image's whole reference and never lets a shortened reference name another image", () =>
	fixture(async (root) => {
		await writeFile(join(root, "a.png"), "image");
		const retained = `a.png?${"q".repeat(1000)}`;
		const prefix = "x".repeat(512);
		const long = `${prefix}${"y".repeat(100)}.png`;
		const link = `docs/${"l".repeat(1000)}.md`;
		const captured = await captureReferences(
			{
				inspection: {
					version: 1,
					images: [retained, long, prefix, `${"z".repeat(600)}.png`],
					links: [link],
					truncated: false,
				},
			},
			root,
		);
		assert.deepEqual(
			captured.references.items.map((item) => [item.reference.length, item.state]),
			[
				[retained.length, "retained"],
				[512, "unavailable"],
				[512, "unavailable"],
				[512, "local-only"],
			],
		);
		assert.equal(captured.references.items[0]?.reference, retained);
		assert.equal(captured.references.items[1]?.reference, prefix);
		assert.equal(captured.references.omitted, 1);
		assert.equal(captured.references.items.filter((item) => item.reference === prefix).length, 1);
	}));
test("reference inspection requires a compatible local build and records honest fallback", () =>
	fixture(async (root, store) => {
		const parser = await inspection(
			root,
			[
				"https://example.invalid/x.png",
				"//example.invalid/y",
				"data:image/png;base64,abcd",
				"custom:payload",
				"%xx.png",
				"a.png",
				"/etc/a.png",
			],
			[
				"#heading",
				"https://example.invalid/",
				"mailto:a@example.invalid",
				"file:other.md",
				"../spec.md",
				"custom:action",
			],
		);
		assert.equal(images(await inspectReferences("source", parser))?.length, 7);
		const captured = await captureReferences(await inspectReferences("source", parser));
		assert.deepEqual(
			captured.references.items.map((item) => item.state),
			[
				"external",
				"external",
				"embedded",
				"unavailable",
				"unavailable",
				"unavailable",
				"unavailable",
				"local-only",
				"local-only",
			],
		);
		assert.deepEqual(
			captured.references.items.slice(3, 7).map((item) => item.reason),
			["unsupported-scheme", "invalid", "no-base", "outside-root"],
		);
		assert.deepEqual(await inspectReferences("source", { ...parser, runner: async () => "not json" }), {
			failure: "output-invalid",
		});
		assert.deepEqual(
			await inspectReferences("source", {
				...parser,
				runner: async () =>
					JSON.stringify({ version: 1, images: ["duplicate", "duplicate"], links: [], truncated: false }),
			}),
			{ failure: "output-invalid" },
		);
		assert.deepEqual(
			await inspectReferences("source", {
				...parser,
				runner: async () => {
					throw new Error("refused");
				},
			}),
			{ failure: "tool-failed" },
		);
		assert.deepEqual(await inspectReferences("source", { app: join(root, "Absent.app"), runner: parser.runner }), {
			failure: "app-missing",
		});
		assert.deepEqual(await inspectReferences("source", {}), { failure: "app-missing" });
		await writeFile(join(parser.app, "Contents/Resources/build.json"), JSON.stringify({ contract: 2 }));
		assert.deepEqual(await inspectReferences("source", parser), { failure: "app-incompatible" });
		const outcome = success(
			await publish(
				{ title: "Uninspected", text: "![remote](https://example.invalid/x.png)" },
				{ cwd: root, store, app: parser.app },
			),
		);
		assert.equal(outcome.references.state, "uninspected");
		assert.equal(Object.hasOwn(outcome, "selfContained"), false);
		assert.deepEqual((await store.get(outcome.documentId)).revision.references, {
			state: "uninspected",
			truncated: false,
			omitted: 0,
			items: [],
			reason: "app-incompatible",
		});
		assert.equal(outcome.references.reason, "app-incompatible");
		assert.match(
			publicationText(outcome),
			/\nReferences not inspected: the installed reader app is incompatible or incomplete; rebuild it with node extensions\/markdown\/native\/build\.mts\.\n/u,
		);
	}));
test("the fixed headless executable receives exact stdin and failures remain uninspected", () =>
	fixture(async (root) => {
		const parser = await inspection(root);
		const tool = join(parser.app, "Contents/MacOS/markdown-core");
		await mkdir(join(parser.app, "Contents/MacOS"));
		const executable = async (body: string) => {
			await writeFile(tool, `#!${process.execPath}\n${body}`);
			await chmod(tool, 0o700);
		};
		await executable(
			"let source='';for await(const chunk of process.stdin)source+=chunk;process.stdout.write(JSON.stringify({version:1,images:[source],links:[],truncated:false}));",
		);
		const exact = "# Unicode 🦘\\nExact";
		assert.deepEqual(images(await inspectReferences(exact, { app: parser.app })), [exact]);
		await executable("process.stderr.write('refused');process.exit(1);");
		assert.deepEqual(await inspectReferences("source", { app: parser.app }), { failure: "tool-failed" });
		await executable("process.stdout.write('x'.repeat(4*1024*1024+1));");
		assert.deepEqual(await inspectReferences("source", { app: parser.app }), { failure: "output-invalid" });
		await rm(tool);
		assert.deepEqual(await inspectReferences("source", { app: parser.app }), { failure: "app-incompatible" });
	}));
test("a new file capture includes retained images, missing assets and reference coverage in its identity", () =>
	fixture(async (root, store) => {
		const path = join(root, "report.md");
		const image = join(root, "architecture.svg");
		await writeFile(path, "# Report\n\n![diagram](architecture.svg)\n");
		await writeFile(image, "<svg>first</svg>");
		const parser = await inspection(root, ["architecture.svg"]);
		const capture = async (options: { app?: string; runner?: typeof parser.runner } = parser) =>
			store.snapshot(`file\0${path}`, "file", await fileSnapshotInput(path, { cwd: root, ...options }));
		const asset = (result: WriteResult) =>
			readFile(
				join(
					store.root,
					"snapshots",
					result.document.id,
					"revisions",
					String(result.revision.revision),
					result.revision.references.items[0]?.file ?? "absent",
				),
				"utf8",
			);
		const first = await capture();
		assert.equal(first.revision.revision, 1);
		assert.equal(first.revision.references.items[0]?.state, "retained");
		const repeated = await capture();
		assert.equal(repeated.revision.revision, 1);
		assert.equal(repeated.replayed, true);
		await writeFile(image, "<svg>second</svg>");
		const imageOnly = await capture();
		assert.equal(imageOnly.document.id, first.document.id);
		assert.equal(imageOnly.revision.revision, 2);
		assert.equal(imageOnly.replayed, false);
		assert.equal(imageOnly.revision.digest, first.revision.digest);
		assert.notEqual(imageOnly.revision.references.items[0]?.digest, first.revision.references.items[0]?.digest);
		assert.equal(await asset((await store.get(first.document.id, 1)) as WriteResult), "<svg>first</svg>");
		assert.equal(await asset(imageOnly), "<svg>second</svg>");
		await rm(image);
		const missing = await capture();
		assert.equal(missing.revision.revision, 3);
		assert.equal(missing.revision.references.items[0]?.reason, "missing");
		assert.equal((await capture()).revision.revision, 3);
		await writeFile(image, "<svg>second</svg>");
		assert.equal((await capture()).revision.revision, 4);
		const uninspected = await capture({ app: join(root, "Absent.app"), runner: parser.runner });
		assert.equal(uninspected.revision.revision, 5);
		assert.equal(uninspected.revision.references.reason, "app-missing");
		assert.equal(uninspected.revision.digest, first.revision.digest);
		const incompatible = join(root, "Old.app");
		await mkdir(join(incompatible, "Contents/Resources"), { recursive: true });
		await writeFile(join(incompatible, "Contents/Resources/build.json"), JSON.stringify({ contract: 2 }));
		const otherCause = await capture({ app: incompatible, runner: parser.runner });
		assert.equal(otherCause.revision.revision, 5);
		assert.equal(otherCause.replayed, true);
		const inspectedAgain = await capture();
		assert.equal(inspectedAgain.revision.revision, 6);
		assert.equal(inspectedAgain.revision.references.state, "inspected");
		assert.equal(await asset(inspectedAgain), "<svg>second</svg>");
		assert.equal(
			(await store.get(first.document.id, 2)).revision.references.items[0]?.digest,
			imageOnly.revision.references.items[0]?.digest,
		);
	}));
test("a text update keeps the edited revision's retained image for an unchanged reference", () =>
	fixture(async (root, store) => {
		const path = join(root, "report.md");
		await writeFile(path, "# Report\n\n![diagram](architecture.svg)\n\nFirst.\n");
		await writeFile(join(root, "architecture.svg"), "<svg>first</svg>");
		const parser = await inspection(root, ["architecture.svg"]);
		const first = success(await publish({ title: "Report", file: path }, { cwd: root, store, ...parser }));
		const retained = (await store.get(first.documentId)).revision.references.items[0];
		assert.equal(retained?.state, "retained");
		await writeFile(join(root, "architecture.svg"), "<svg>changed in the project</svg>");
		const text = "# Report\n\n![diagram](architecture.svg)\n\nCorrected.\n";
		const corrected = success(
			await publish(
				{ title: "Report", text, document: first.documentId, expectedRevision: 1 },
				{ cwd: join(root, "elsewhere"), store, ...parser },
			),
		);
		assert.equal(corrected.revision, 2);
		assert.equal(corrected.selfContained, true);
		assert.deepEqual(corrected.references.kept, { revision: 1, images: 1 });
		const stored = await store.get(first.documentId, 2);
		assert.deepEqual(
			stored.revision.references.items[0],
			retained,
			"the kept image is the edited revision's bytes, not the project file",
		);
		assert.equal(
			Buffer.from(
				await store.retainedAsset(first.documentId, 2, stored.revision.references.items[0] ?? retained),
			).toString(),
			"<svg>first</svg>",
		);
		assert.match(
			publicationText(corrected),
			/\nReferences: 1 image retained \(1 kept from revision 1: a text publication reads no image files, so an unchanged reference keeps that revision's image; publish a file to change an image\)\.\n/u,
		);
		const created = success(await publish({ title: "New", text }, { cwd: root, store, ...parser }));
		assert.equal(created.references.retained, 0, "a new text publication keeps nothing");
		await writeFile(
			join(store.root, "documents", first.documentId, "revisions", "2", retained?.file ?? ""),
			"<svg>damaged</svg>",
		);
		await assert.rejects(
			store.retainedAsset(first.documentId, 2, retained ?? { kind: "image", reference: "", state: "retained" }),
			/does not match its record/u,
		);
		const damaged = success(
			await publish(
				{ title: "Report", text, document: first.documentId, expectedRevision: 2 },
				{ cwd: root, store, ...parser },
			),
		);
		assert.equal(damaged.references.retained, 0, "bytes that fail their check are not kept");
		assert.equal(damaged.references.unavailableItems?.[0]?.reason, "no-base");
		const other = success(
			await publish(
				{ title: "Report", text: "![other](other.svg)\n", document: first.documentId, expectedRevision: 3 },
				{ cwd: root, store, ...(await inspection(root, ["other.svg"])) },
			),
		);
		assert.equal(other.references.kept, undefined);
		assert.equal(other.references.unavailableItems?.[0]?.reason, "no-base");
	}));
test("explicit file reuse returns the original receipt after file and asset changes", () =>
	fixture(async (root, store) => {
		const path = join(root, "source.md");
		await writeFile(path, "![a](a.png)");
		await writeFile(join(root, "a.png"), "original");
		const parser = await inspection(root, ["a.png"]);
		const params = { title: "Reused", file: path, reuseKey: "file-reuse" };
		const first = success(await publish(params, { cwd: root, store, ...parser }));
		await writeFile(path, "changed");
		await writeFile(join(root, "a.png"), "changed asset");
		const second = success(await publish(params, { cwd: root, store }));
		assert.equal(second.documentId, first.documentId);
		assert.equal(second.digest, first.digest);
		assert.equal(second.references.retained, 1);
		assert.equal(second.replayed, true);
		await rm(path);
		assert.equal(success(await publish(params, { cwd: root, store })).digest, first.digest);
	}));
test("ordinary tool reports a saved document for its session and nothing for a refused publication", () =>
	fixture(async (root, store) => {
		const reports: unknown[] = [];
		const tool = createPublishTool({
			store,
			cwd: root,
			workReference: (sessionId, document) => reports.push([sessionId, document]),
		});
		const context = { cwd: root, sessionManager: { getSessionId: () => "session-a" } } as never;
		await tool.execute("call", { title: "Missing source" } as never, undefined, undefined, context);
		assert.deepEqual(reports, []);
		const result = await tool.execute("call", { title: "Shared plan", text: "# plan" }, undefined, undefined, context);
		const outcome = result.structuredContent as Extract<PublishOutcome, { ok: true }>;
		assert.deepEqual(reports, [["session-a", { id: outcome.documentId, title: "Shared plan" }]]);
	}));

test("ordinary tool supplies the same structured outcome and never opens a window", () =>
	fixture(async (root, store) => {
		const tool = createPublishTool({ store, cwd: root });
		let session = "first";
		const context = {
			cwd: root,
			sessionManager: { getSessionId: () => session },
			model: { provider: "faux", id: "faux-1" },
		} as never;
		const result = await tool.execute("call", { title: "Ordinary", text: "# exact" }, undefined, undefined, context);
		assert.equal((result.structuredContent as PublishOutcome).ok, true);
		assert.deepEqual(result.structuredContent, result.details);
		assert.match(
			result.content[0]?.type === "text" ? result.content[0].text : "",
			/^Saved new document md-[a-f0-9]{20} revision 1 \(7 bytes, sha256:[a-f0-9]{64}\)\. No window opened\.\n/u,
		);
		assert.ok(tool.outputSchema);
		const guideline = tool.promptGuidelines?.join("\n") ?? "";
		for (const guidance of [guideline, tool.description]) {
			assert.match(guidance, /a split on the right of your pane/u);
			assert.match(guidance, /use markdown_read with the reported document ID/u);
			assert.match(guidance, /Reuse your reader pane across reports/u);
			assert.match(guidance, /without an interactive conversation/u);
		}
		assert.match(publishDescription("float"), /a floating pane that stays in place/u);
		const floating = createPublishTool({ store, cwd: root, pane: "float" });
		const interactive = [
			guideline,
			tool.description,
			floating.description,
			floating.promptGuidelines?.join("\n") ?? "",
		];
		for (const guidance of interactive) {
			assert.match(
				guidance,
				/In the interactive session with the operator, show material that is hard to read in a terminal without waiting to be asked/u,
				"the coordinating session decides to show material, not only when asked",
			);
			assert.match(
				guidance,
				/a reply with headings, a table, three or more explained points, or more than about ten lines/u,
			);
			assert.match(guidance, /A plain answer of a few sentences stays in chat/u);
		}
		for (const guidance of [...interactive, NATIVE_PUBLISH_GUIDANCE]) {
			assert.match(guidance, /unless the operator explicitly asks you to show/u);
			assert.match(guidance, /complete report/u);
			assert.match(guidance, /include its ID and title/u);
			assert.match(guidance, /Ask card, give the substantive answer in your final message/u);
			assert.match(guidance, /Do not take focus unless the operator asked to see it now/u);
			assert.doesNotMatch(
				guidance,
				/operator's (?:focus|tab)|default|setting|agentPane/u,
				"the guidance names a pane, not a default or the setting behind it",
			);
			assert.doesNotMatch(guidance, /not every reply|do not publish every reply|explicitly requested document/u);
		}
		assert.doesNotMatch(
			NATIVE_PUBLISH_GUIDANCE,
			/without waiting to be asked|floating/u,
			"a native agent reports to its coordinator and shows nothing unprompted",
		);
		const first = success(result.details);
		assert.deepEqual(first.show, { op: "show", document: first.documentId });
		assert.deepEqual(first.paneState, { status: "unknown" });
		assert.equal(first.provenance.session, "first");
		assert.equal(first.provenance.model, "faux/faux-1");
		assert.ok(first.provenance.host);
		session = "second";
		const updated = await tool.execute(
			"next",
			{ title: "Updated", text: "other", document: first.documentId.slice(0, 12), expectedRevision: 1 },
			undefined,
			undefined,
			context,
		);
		assert.equal(success(updated.details).provenance.session, "second");
		assert.equal(success(updated.details).revision, 2);
	}));

function ready(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve, reject) => {
		let output = "";
		let errors = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Child did not reach publication: ${errors}`));
		}, 15000);
		child.stdout?.on("data", (chunk: Buffer) => {
			output = `${output}${chunk.toString()}`.slice(-4096);
			if (output.includes("READY\n")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			errors = `${errors}${chunk.toString()}`.slice(-4096);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Child exited ${code}: ${errors}`));
		});
	});
}
function death(child: ReturnType<typeof spawn>): Promise<void> {
	return child.exitCode !== null || child.signalCode !== null
		? Promise.resolve()
		: new Promise((resolve) => child.once("exit", () => resolve()));
}
async function crashNative(
	root: string,
	store: MarkdownStore,
	app: string,
	params: PublishInput,
	stage: "plan" | "receipt",
	resume = false,
): Promise<void> {
	const script = join(root, "crash-fixture.mts");
	const program = `
import * as D from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};
import { openNodeSqliteStorage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable/storage/sqlite/node"))};
import { BACKGROUND_CONTEXT as c } from ${JSON.stringify(import.meta.resolve("@earendil-works/chord/context"))};
import { createModels } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/models"))};
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
import { createNativePublishTool } from ${JSON.stringify(new URL("./publish.ts", import.meta.url).href)};
import { MarkdownStore } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
const faux=fauxProvider(); const models=createModels(); models.setProvider(faux.provider);
const store=new MarkdownStore(${JSON.stringify(store.root)});
const pause=()=>{process.stdout.write('READY\\n');process.stdin.resume();return new Promise(()=>{});};
const prepare=store.preparePlan.bind(store);store.preparePlan=async(...args)=>{const plan=await prepare(...args);if(${stage === "plan"})await pause();return plan;};
const tool=createNativePublishTool({durable:D,cwd:${JSON.stringify(root)}},{store,app:${JSON.stringify(app)},runner:async()=>JSON.stringify({version:1,images:['a.png'],links:[],truncated:false})});
const registry=D.createRegistry(); registry.install(D.defineExtension({name:'markdown',tools:[{...tool,async execute(args,api,ctx){const result=await tool.execute(args,api,ctx);if(result.isError)throw new Error(JSON.stringify(result));await pause();return result;}}]}));
const harness=await D.Harness.open(await openNodeSqliteStorage(${JSON.stringify(join(root, "harness.sqlite"))}),{models,registry},c);
if(${resume}){
 faux.setResponses([fauxAssistantMessage('Recovered.')]);harness.resume();const conversation=await harness.root(c);
 const admitted=await harness.commit(tx=>tx.submissionByRequest(conversation.id,'crash-publication'),c);if(!admitted)throw new Error('Missing submission');
 await (await harness.submission(admitted.id,c)).wait(c);
}else{
 const conversation=await harness.root(c,{agent:{model:{provider:'faux',modelId:'faux-1'}}});
 faux.setResponses([fauxAssistantMessage(fauxToolCall('markdown_publish',${JSON.stringify(params)}),{stopReason:'toolUse'})]);
 await (await conversation.submit({type:'input',content:'Publish.',requestId:'crash-publication'},c)).wait(c);
}
`;
	await writeFile(script, program);
	const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
	try {
		await ready(child);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = death(child);
			child.kill("SIGKILL");
			await exited;
		}
		child.stdin?.destroy();
	}
	assert.equal(child.signalCode, "SIGKILL");
}
async function recoverNative(
	root: string,
	store: MarkdownStore,
	app: string,
	repeat?: PublishInput,
): Promise<PublishOutcome[]> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage("Recovered.")]);
	const tool = createNativePublishTool({ durable: Durable, cwd: root }, { store, app });
	const registry = Durable.createRegistry();
	registry.install(Durable.defineExtension({ name: "markdown", tools: [tool] }));
	const harness = await Durable.Harness.open(
		await openNodeSqliteStorage(join(root, "harness.sqlite")),
		{ models, registry },
		context,
	);
	try {
		harness.resume();
		const conversation = await harness.root(context);
		const admitted = await harness.commit(
			(tx) => tx.submissionByRequest(conversation.id, "crash-publication"),
			context,
		);
		assert.ok(admitted);
		const submission = await harness.submission(admitted.id, context);
		assert.ok(submission);
		assert.equal((await submission.wait(context)).status, "done");
		if (repeat) {
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("markdown_publish", repeat), { stopReason: "toolUse" }),
				fauxAssistantMessage("Reused."),
			]);
			assert.equal(
				(await (await conversation.submit({ type: "input", content: "Reuse the publication." }, context)).wait(context))
					.status,
				"done",
			);
		}
		const page = await conversation.entries({}, 100, undefined, context);
		return page.items
			.filter((entry) => Durable.ToolResultEntry.is(entry))
			.map((entry) => {
				const message = entry.model?.[0];
				assert.ok(message && message.role === "toolResult");
				return message.details as PublishOutcome;
			});
	} finally {
		await harness.close(context);
	}
}
for (const keyed of [false, true])
	test(
		`a killed ${keyed ? "keyed" : "unkeyed"} native publication over SQLite returns its saved receipt without deleted files`,
		{ timeout: 30000 },
		() =>
			fixture(async (root, store) => {
				const source = join(root, "source.md");
				const asset = join(root, "a.png");
				const originalSource = "# Original\n![a](a.png)";
				await writeFile(source, originalSource);
				await writeFile(asset, "original asset");
				const parser = await inspection(root, ["a.png"]);
				const params = { title: "Crash receipt", file: source, ...(keyed ? { reuseKey: "keyed-crash" } : {}) };
				let plan: PublicationPlan | undefined;
				if (keyed) {
					await crashNative(root, store, parser.app, params, "plan");
					plan = await store.reusePlan("keyed-crash", invocationDigest(params, root));
					assert.ok(plan);
					assert.equal(plan.revision, 1);
					assert.equal((await store.list()).documents.length, 0);
				}
				await crashNative(root, store, parser.app, params, "receipt", keyed);
				const before = await store.list();
				assert.equal(before.documents.length, 1);
				const document = before.documents[0];
				assert.ok(document);
				if (plan) {
					assert.equal(document.id, plan.documentId);
					assert.equal(document.revision, plan.revision);
				}
				const original = await store.get(document.id);
				assert.equal(original.source, originalSource);
				assert.equal(original.revision.references.items[0]?.state, "retained");
				await rm(source);
				await rm(asset);
				await store.update(document.id, 1, {
					title: "Newer",
					source: "# Later revision",
					contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() },
				});
				const results = await recoverNative(root, store, parser.app, keyed ? params : undefined);
				assert.equal(results.length, keyed ? 2 : 1);
				for (const result of results) {
					assert.ok(result.ok);
					assert.equal(result.documentId, document.id);
					assert.equal(result.revision, 1);
					assert.equal(result.digest, original.revision.digest);
					assert.equal(result.replayed, true);
					assert.equal(result.references.retained, 1);
				}
				assert.equal((await store.list()).documents.length, 1);
				assert.equal((await store.get(document.id)).document.revision, 2);
				assert.equal((await store.get(document.id, 1)).source, originalSource);
				const retained = original.revision.references.items[0]?.file;
				assert.ok(retained);
				assert.equal(
					await readFile(join(store.root, "documents", document.id, "revisions/1", retained), "utf8"),
					"original asset",
				);
			}),
	);

test("native model and codemode calls share outcomes, prefixes and explicit reuse", { timeout: 30000 }, () =>
	fixture(async (root, store) => {
		const storage = new Durable.MemoryStorage();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const native = createNativePublishTool({ durable: Durable, cwd: root, storageId: "synthetic" }, { store });
		assert.equal(native.replay, "safe");
		assert.ok(native.structuredOutputSchema);
		const registry = Durable.createRegistry();
		const results: { outcome: PublishOutcome; text: string }[] = [];
		registry.install(
			Durable.defineExtension({
				name: "markdown",
				tools: [
					{
						...native,
						async execute(args, api, context) {
							const result = await native.execute(args as PublishInput, api, context);
							results.push({
								outcome: result.structuredOutput as PublishOutcome,
								text: (result.output ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
							});
							return result;
						},
					},
				],
			}),
		);
		const sandbox = new CodemodeSandbox();
		registry.install(createCodemodeExtension({ sandbox, models: false }));
		const first = await Durable.Harness.open(storage, { models, registry }, context);
		try {
			const conversation = await first.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("markdown_publish", { title: "Native", text: "# persisted" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Saved."),
			]);
			const submission = await conversation.submit({ type: "input", content: "Publish." }, context);
			assert.equal((await submission.wait(context)).status, "done");
			const firstOutcome = results[0]?.outcome;
			assert.ok(firstOutcome?.ok);
			assert.match(
				results[0]?.text ?? "",
				/^Saved new document md-[a-f0-9]{20} revision 1 \(\d+ bytes, sha256:[a-f0-9]{64}\)\. No window opened\.\nReferences not inspected: the reader app is not installed; build it with node extensions\/markdown\/native\/build\.mts\.\nReader pane state is unknown for this conversation\.\nOptional display request for markdown_live/u,
			);
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("markdown_publish", {
						title: "Prefix update",
						text: "updated by prefix",
						document: firstOutcome.documentId.slice(0, 12),
						expectedRevision: 1,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Updated."),
			]);
			assert.equal(
				(await (await conversation.submit({ type: "input", content: "Update by prefix." }, context)).wait(context))
					.status,
				"done",
			);
			assert.equal((await store.get(firstOutcome.documentId)).document.revision, 2);
			const code =
				'const a = await tools.markdown_publish({title:"Nested",text:"same"}); const b = await tools.markdown_publish({title:"Nested",text:"same"}); const c = await tools.markdown_publish({title:"Reused",text:"same",reuseKey:"nested-reuse"}); const d = await tools.markdown_publish({title:"Reused",text:"same",reuseKey:"nested-reuse"}); text({a,b,c,d});';
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Done."),
			]);
			assert.equal(
				(
					await (
						await conversation.submit({ type: "input", content: "Publish twice through code." }, context)
					).wait(context)
				).status,
				"done",
			);
			assert.equal((await store.list()).documents.length, 4);
			const page = await conversation.entries({}, 100, undefined, context);
			const message = page.items
				.flatMap((entry) => entry.model ?? [])
				.find((message) => message.role === "toolResult" && message.toolName === "codemode");
			assert.ok(message && message.role === "toolResult");
			const output = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\\n");
			const nested = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
			assert.equal(nested.a.ok, true);
			assert.equal(nested.b.ok, true);
			assert.notEqual(nested.a.documentId, nested.b.documentId);
			assert.equal(nested.c.documentId, nested.d.documentId);
			assert.equal(nested.c.replayed, false);
			assert.equal(nested.d.replayed, true);
			const keyed = { title: "Keyed native", text: "keyed", reuseKey: "native-reuse" };
			const before = results.length;
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("markdown_publish", keyed), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("markdown_publish", keyed), { stopReason: "toolUse" }),
				fauxAssistantMessage("Done."),
			]);
			assert.equal(
				(
					await (
						await conversation.submit({ type: "input", content: "Publish with a key twice." }, context)
					).wait(context)
				).status,
				"done",
			);
			const [created, returned] = results.slice(before).map((entry) => success(entry.outcome));
			assert.ok(created && returned);
			assert.equal(created.documentId, returned.documentId);
			assert.equal(created.created, true);
			assert.equal(created.replayed, false);
			assert.equal(returned.replayed, true);
		} finally {
			await first.close(context);
			sandbox.close();
		}
	}),
);

test("a silent publication returns a show request; replay targets the exact revision", () =>
	fixture(async (root, store) => {
		const options = { cwd: root, store };
		const input = { title: "Draft", text: "First.", reuseKey: "draft" };
		const first = success(await publish(input, options));
		assert.deepEqual(first.show, { op: "show", document: first.documentId });
		assert.deepEqual(first.paneState, { status: "unknown" });
		success(
			await publish(
				{ ...input, reuseKey: undefined, document: first.documentId, expectedRevision: 1, text: "Second." },
				options,
			),
		);
		const replay = success(await publish(input, options));
		assert.equal(replay.replayed, true);
		assert.deepEqual(replay.show, { op: "show", document: first.documentId, revision: 1 });
		assert.match(publicationText(replay), /Optional display request for markdown_live/u);
		assert.doesNotMatch(publicationText(replay), /--pane|:open|follows this revision/u);
	}));

test("a response snapshot saves the earlier answer exactly, once per response", () =>
	fixture(async (root, store) => {
		const assistant = (id: string, parentId: string | null, text: string) => ({
			type: "message",
			id,
			parentId,
			timestamp: "2026-01-01",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				provider: "faux",
				model: "faux-1",
				api: "faux",
				usage: {},
				stopReason: "stop",
				timestamp: 1760000000000,
			},
		});
		const entries = new Map<string, unknown>([
			["a", assistant("a", null, "## The long answer\n\nExact *text*.")],
			[
				"u",
				{
					type: "message",
					id: "u",
					parentId: "a",
					timestamp: "2026-01-01",
					message: { role: "user", content: "show it", timestamp: 1 },
				},
			],
			["b", assistant("b", "u", "Opening it")],
		]);
		const sessionManager = {
			getEntry: (id: string) => entries.get(id),
			getLeafId: () => "b",
			getSessionId: () => "session",
			getCwd: () => root,
		};
		const tool = createPublishTool({ store, cwd: root });
		const context = { cwd: root, sessionManager } as never;
		const first = success((await tool.execute("one", { response: "previous" }, undefined, undefined, context)).details);
		assert.equal(first.kind, "response");
		assert.equal(first.created, true);
		assert.match(first.title, /^Response · /u);
		assert.equal((await store.get(first.documentId)).source, "## The long answer\n\nExact *text*.");
		const again = success((await tool.execute("two", { response: "previous" }, undefined, undefined, context)).details);
		assert.equal(again.documentId, first.documentId);
		assert.equal(again.revision, 1);
		for (const params of [
			{ response: "previous", title: "Mine" },
			{ response: "previous", text: "other" },
			{ response: "previous", document: first.documentId, expectedRevision: 1 },
		]) {
			const refused = (await tool.execute("bad", params as never, undefined, undefined, context))
				.details as PublishOutcome;
			assert.equal(refused.ok, false);
			assert.equal(refused.ok ? "" : refused.error.code, "invalid");
		}
	}));

test("only a conversation that receives pane closure notices is told to expect them", () => {
	const store = new MarkdownStore(join(tmpdir(), "unused-markdown-store"));
	const ordinary = createPublishTool({ store, paneNotices: true });
	assert.match(ordinary.description, /a notice identifies the departed pane/u);
	const native = createNativePublishTool({ durable: Durable, cwd: tmpdir() }, { store });
	assert.match(native.description ?? "", /split on the right of the inherited pane/u);
	assert.doesNotMatch(native.description ?? "", /without waiting to be asked/u);
	for (const description of [
		publishDescription("float"),
		createPublishTool({ store }).description,
		native.description ?? "",
	]) {
		assert.doesNotMatch(description, /a notice identifies the departed pane/u);
		assert.match(description, /only panes that reported the saved revision/u);
		assert.match(description, /repair it rather than switching to live edits/u);
		assert.match(description, /Only status:launch offers a one-use command/u);
		assert.match(description, /Status:navigated confirms the document, revision and handle/u);
		assert.doesNotMatch(description, /:open|paneInput|follows this revision/u);
	}
});
type Pane = PaneInventory["panes"][number];
function reader(storeId: string, documentId: string, mode: "writing" | "reading" = "reading"): Pane {
	const workspace = "3710fd78-3b61-4e5a-852e-55dd0304f389",
		document = "53da365c-3374-41d1-b10b-fc785917f95b";
	return {
		workspace,
		document,
		handle: `${workspace}:${document}`,
		live: 3,
		origin: "operator",
		pid: 71,
		reportedAt: 17,
		view: {
			kind: "published",
			title: "Draft",
			mode,
			storeId,
			documentId,
			revision: 1,
			follows: true,
			dirty: false,
			conflict: false,
		},
	};
}
test("publication reports each last-observed view and pending launch, not an assumed follow", () =>
	fixture(async (cwd, store) => {
		const first = success(await publish({ title: "Draft", text: "First." }, { cwd, store }));
		const document = first.documentId,
			storeId = (await store.initialise()).storeId;
		const reading = reader(storeId, document);
		reading.view.follows = false;
		const elsewhere = reader(storeId, "md-ffffffffffffffffffff");
		elsewhere.handle = "other document";
		const other = reader("1".repeat(32), document);
		other.handle = "another pane";
		other.view.dirty = true;
		other.view.revision = 2;
		const input = { title: "Draft", text: "Second.", document, expectedRevision: 1, reuseKey: "second" };
		const inventory: PaneInventory = {
			panes: [reading, other, elsewhere],
			pending: [
				{ launchId: "offered", origin: "agent", status: "offered" },
				{ launchId: "started", documentId: document, origin: "operator", status: "launching" },
			],
		};
		const options = { cwd, store, observePanes: async () => inventory };
		const second = success(await publish(input, options));
		assert.deepEqual(second.paneState, { status: "observed", inventory, showing: [] });
		const text = publicationText(second);
		assert.ok(
			text.includes(
				`${document} revision 1, reading, follow latest off, store ${storeId}). It did not confirm the saved revision.`,
			),
		);
		assert.ok(
			text.includes(
				`${elsewhere.view.documentId} revision 1, reading, follow latest on, store ${storeId}). It did not confirm the saved revision.`,
			),
		);
		for (const match of [/another pane.*unsaved, follow latest on/u, /offered/u, /launching/u])
			assert.match(text, match);
		reading.view.revision = 2;
		reading.view.follows = true;
		const replay = success(await publish(input, options));
		assert.deepEqual(replay.paneState, { status: "observed", inventory, showing: [reading.handle] });
		assert.doesNotMatch(publicationText(replay), /Optional display request/u);
		assert.ok(
			publicationText(replay).includes(
				`${document} revision 2, reading, follow latest on, store ${storeId}). It reported the saved revision.`,
			),
		);
		reading.view.dirty = true;
		assert.deepEqual(
			success(await publish(input, options)).paneState,
			{ status: "observed", inventory, showing: [] },
			"replay preserves the dirty editor and never calls it exact",
		);
		assert.deepEqual(
			success(
				await publish(input, {
					...options,
					observePanes: async () => {
						throw Error("offline");
					},
				}),
			).paneState,
			{ status: "unknown" },
		);
		assert.deepEqual(
			success(await publish(input, { ...options, observePanes: async () => ({ panes: [], pending: [] }) })).paneState,
			{ status: "observed", inventory: { panes: [], pending: [] }, showing: [] },
		);
	}));

test("an ordinary update never uses a replacement conversation's pane inventory", () =>
	fixture(async (cwd, store) => {
		const first = success(await publish({ title: "Draft", text: "First." }, { cwd, store }));
		const request = { title: "Draft", text: "Second.", document: first.documentId, expectedRevision: 1 };
		const parser = await inspection(cwd);
		for (const change of ["before query", "during query"]) {
			let session = "invoking",
				queries = 0;
			const ctx = { cwd, sessionManager: { getSessionId: () => session } } as never;
			const tool = createPublishTool({
				store,
				...parser,
				runner: async () => {
					if (change === "before query") session = "replacement";
					return parser.runner();
				},
				panes: async () => {
					queries++;
					session = "replacement";
					return { panes: [], pending: [] };
				},
			});
			const outcome = (await tool.execute("update", request, undefined, undefined, ctx)).details;
			assert.ok(!outcome.ok && outcome.error.code === "live-state-unavailable");
			assert.deepEqual(outcome.error.paneState, { status: "unknown" });
			assert.equal(queries, change === "before query" ? 0 : 1);
			assert.equal((await store.get(first.documentId)).source, "First.");
		}
	}));

test("a new explicit update protects a dirty or conflicted exact publication, but not an independent copy", () =>
	fixture(async (cwd, store) => {
		const first = success(await publish({ title: "Draft", text: "First." }, { cwd, store }));
		const document = first.documentId;
		const pane = reader((await store.initialise()).storeId, document, "writing");
		const request = { title: "Draft", text: "Second.", document: document.slice(0, 12), expectedRevision: 1 };
		const options = { cwd, store, observePanes: async () => ({ panes: [pane], pending: [] }) };
		for (const state of [
			{ dirty: true, conflict: false },
			{ dirty: false, conflict: true },
		]) {
			Object.assign(pane.view, state);
			const refused = await publish(request, options);
			assert.ok(!refused.ok && refused.error.code === "live-editor");
			assert.deepEqual(refused.error.next, { op: "read", handle: pane.handle });
			assert.match(publicationText(refused), /Keep the live draft/u);
			assert.equal((await store.get(document)).source, "First.");
		}
		error(await publish(request, { ...options, observePanes: async () => undefined }), "live-state-unavailable");
		pane.view.kind = "loading";
		pane.view.dirty = pane.view.conflict = false;
		error(await publish(request, options), "live-editor");
		pane.view.kind = "copy";
		pane.view.dirty = true;
		assert.equal(success(await publish(request, options)).revision, 2);
	}));

test("clean editor autosave and stored publication alternate without duplicate revisions or a blind retry", () =>
	fixture(async (cwd, store) => {
		const first = success(await publish({ title: "Draft", text: "First." }, { cwd, store }));
		const document = first.documentId,
			pane = reader((await store.initialise()).storeId, document, "writing");
		const observePanes = async () => ({ panes: [pane], pending: [] });
		const options = { cwd, store, observePanes };
		const request = { title: "Draft", text: "Second.", document, expectedRevision: 1 };
		const second = success(await publish(request, options));
		assert.equal(second.revision, 2);
		const refs = (await store.get(document)).revision.references;
		const third = { ...request, text: "Third.", expectedRevision: 2 };
		let saved = false;
		const raced = await publish(third, {
			...options,
			observePanes: async () => {
				if (!saved) {
					await store.update(document, 2, {
						title: "Draft",
						source: "Third.",
						references: refs,
						contentOrigin: { kind: "editor", capturedAt: new Date().toISOString() },
					});
					saved = true;
					pane.view.revision = 3;
				}
				return observePanes();
			},
		});
		assert.ok(!raced.ok && raced.error.code === "conflict");
		assert.equal(raced.error.currentRevision, 3);
		assert.equal(raced.error.currentMatches, "source-title-references");
		assert.equal(raced.error.currentFromEditor, true);
		assert.deepEqual(raced.error.next, { document, revision: 3 });
		assert.match(publicationText(raced), /No duplicate revision is needed/u);
		const otherTitle = await publish({ ...third, title: "New title" }, options);
		assert.ok(!otherTitle.ok && otherTitle.error.currentMatches === "source");
		pane.view.dirty = true;
		const editedAgain = await publish(third, options);
		assert.ok(!editedAgain.ok && editedAgain.error.code === "conflict");
		assert.deepEqual(editedAgain.error.next, { op: "read", handle: pane.handle });
		assert.match(publicationText(editedAgain), /base revision 3, writing, unsaved/u);
		pane.view.dirty = false;
		assert.equal(success(await publish({ ...third, text: "Fourth.", expectedRevision: 3 }, options)).revision, 4);
		assert.equal((await store.get(document)).source, "Fourth.");
	}));

test("ordinary publication checks text and file updates before saving and leaves saved reuse intact", () =>
	fixture(async (root, store) => {
		const manager = {
			getSessionId: () => "session",
			getLeafId: () => "u",
			getEntry: () => ({
				type: "message",
				parentId: null,
				message: { role: "user", content: "Tell me whether the roof holds." },
			}),
		};
		const ctx = { cwd: root, sessionManager: manager } as never;
		const input = { title: "Roof", text: "The roof holds — the floor is dry.", reuseKey: "roof" };
		const brief = await createBriefTool({ mode: "block" }).execute(
			"brief",
			{ title: "Roof" },
			undefined,
			undefined,
			ctx,
		);
		assert.deepEqual((brief.structuredContent as WritingBrief)?.requests, ["Tell me whether the roof holds."]);
		const block = createPublishTool({ store });
		const refused = await block.execute("one", input, undefined, undefined, ctx);
		assert.equal(refused.isError, true);
		assert.ok(!refused.details?.ok);
		assert.equal(refused.details?.error.code, "checks");
		assert.deepEqual(refused.details?.error.brief, brief.structuredContent);
		assert.deepEqual(
			refused.details?.error.findings?.map((finding) => finding.rule),
			["dashes"],
		);
		assert.match(
			refused.content[0]?.type === "text" ? refused.content[0].text : "",
			/did not save[\s\S]+Line 1:[\s\S]+Fix the passages and publish again\./u,
		);
		assert.equal(await store.identity(), undefined);
		const warn = createPublishTool({ store, writing: { mode: "warn" } });
		const saved = success((await warn.execute("two", input, undefined, undefined, ctx)).details);
		assert.equal(saved.checks?.findings[0]?.rule, "dashes");
		assert.equal((await store.get(saved.documentId)).source, input.text);
		const replay = success((await block.execute("replay", input, undefined, undefined, ctx)).details);
		assert.equal(replay.replayed, true);
		assert.equal(replay.checks, undefined);
		const file = join(root, "draft.md");
		const source = "The roof holds\\nThe floor is dry.";
		await writeFile(file, source);
		const update = { title: "Roof", file, document: saved.documentId, expectedRevision: 1 };
		const blockedUpdate = (await block.execute("update", update, undefined, undefined, ctx)).details;
		assert.ok(!blockedUpdate?.ok);
		assert.equal(blockedUpdate?.error.findings?.[0]?.rule, "escapedBreaks");
		assert.equal((await store.get(saved.documentId)).document.revision, 1);
		const invalid = await publish(update, {
			store,
			cwd: root,
			writing: { mode: "warn", issue: "harness.json: markdown.checksRules.rules.labelLines.limit" },
		});
		assert.ok(!invalid.ok && invalid.error.code === "invalid");
		assert.match(invalid.error.message, /labelLines\.limit/u);
		const off = createPublishTool({ store, writing: { mode: "off", lexiconFile: join(root, "missing-words.txt") } });
		const updated = success((await off.execute("off", update, undefined, undefined, ctx)).details);
		assert.equal(updated.checks, undefined);
		assert.equal(updated.revision, 2);
		assert.equal(await readFile(file, "utf8"), source);
	}));

for (const mode of ["block", "warn", "off"] as const)
	test(`native publication applies ${mode} mode and supplies a branch brief`, { timeout: 30_000 }, () =>
		fixture(async (root, store) => {
			const models = createModels();
			const faux = fauxProvider();
			models.setProvider(faux.provider);
			const registry = Durable.createRegistry();
			let harness: Durable.Harness;
			const host = {
				durable: Durable,
				cwd: root,
				harness: { conversation: (id: Durable.ConversationId, ctx: typeof context) => harness.conversation(id, ctx) },
			};
			const brief = createNativeBriefTool(host, { mode });
			const publish = createNativePublishTool(host, { store, writing: { mode } });
			const results: unknown[] = [];
			registry.install(
				Durable.defineExtension({
					name: "markdown",
					tools: [
						{
							...brief,
							async execute(params, api, ctx) {
								const result = await brief.execute(params as { title?: string }, api, ctx);
								results.push(result.structuredOutput);
								return result;
							},
						},
						{
							...publish,
							async execute(params, api, ctx) {
								const result = await publish.execute(params as PublishInput, api, ctx);
								results.push(result.structuredOutput);
								return result;
							},
						},
					],
				}),
			);
			harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
			try {
				const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
				faux.setResponses([
					fauxAssistantMessage(fauxToolCall("markdown_brief", { title: "Roof" }), { stopReason: "toolUse" }),
					fauxAssistantMessage(
						fauxToolCall("markdown_publish", { title: "Roof", text: "The roof holds — the floor is dry." }),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("Done."),
				]);
				const task = await conversation.submit({ type: "input", content: "Tell me whether the roof holds." }, context);
				assert.equal((await task.wait(context)).status, "done");
				assert.deepEqual((results[0] as WritingBrief)?.requests, ["Tell me whether the roof holds."]);
				const outcome = results[1] as PublishOutcome;
				if (mode === "block") {
					assert.ok(!outcome.ok && outcome.error.code === "checks");
					assert.deepEqual(outcome.error.brief?.requests, ["Tell me whether the roof holds."]);
					assert.equal(await store.identity(), undefined);
				} else {
					assert.ok(outcome.ok);
					assert.equal(outcome.checks?.findings[0]?.rule, mode === "warn" ? "dashes" : undefined);
					assert.equal((await store.get(outcome.documentId)).document.revision, 1);
				}
			} finally {
				await harness.close(context);
			}
		}),
	);
