import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
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
import { captureReferences, inspectReferences, fileSnapshotInput, createNativePublishTool, createPublishTool, invocationDigest, publish, type PublishOutcome, type PublishInput } from "./publish.ts";
import { LIMITS, MarkdownStore, type PublicationPlan } from "./store.ts";
const scratch = tmpdir();
async function fixture(run: (root: string, store: MarkdownStore) => Promise<void>) { const root = await mkdtemp(join(scratch, "markdown-publish-")); try { await run(root, new MarkdownStore(join(root, "store"))); } finally { await rm(root, { recursive: true, force: true }); } }
async function inspection(root: string, images: string[] = [], links: string[] = [], truncated = false) {
	const app = join(root, "Reader.app"); await mkdir(join(app, "Contents/Resources"), { recursive: true }); await writeFile(join(app, "Contents/Resources/build.json"), JSON.stringify({ contract: 1 }));
	return { app, runner: async () => JSON.stringify({ version: 1, images, links, truncated }) };
}
function error(outcome: PublishOutcome, code: string) { assert.equal(outcome.ok, false); if (!outcome.ok) assert.equal(outcome.error.code, code); }
function success(outcome: PublishOutcome) { assert.equal(outcome.ok, true, JSON.stringify(outcome)); if (!outcome.ok) throw new Error("Expected success"); return outcome; }
test("publication validates every outcome code and preserves exact Unicode source", () => fixture(async (root, store) => {
	const options = { cwd: root, store };
	const first = success(await publish({ title: "文書 🦘", text: "# 你好\nCafé 🦘\n" }, options));
	assert.equal((await store.get(first.documentId)).source, "# 你好\nCafé 🦘\n");
	error(await publish({ title: "x" }, options), "invalid");
	for (const text of ["", " \n\t"]) error(await publish({ title: "Blank", text }, options), "invalid");
	success(await publish({ title: "Family 👩‍👩‍👧‍👦 Café", text: "exact" }, options));
	for (const title of ["bad\u202etitle", "bad\u2066title", "bad\u2028title"]) error(await publish({ title, text: "exact" }, options), "invalid");
	error(await publish({ title: "x", text: "", file: "a" }, options), "invalid");
	error(await publish({ title: "bad\ntitle", text: "a" }, options), "invalid");
	error(await publish({ title: "x", text: "a", expectedRevision: 1 }, options), "invalid");
	error(await publish({ title: "x", text: "a", document: first.documentId, expectedRevision: 0 }, options), "invalid");
	error(await publish({ title: "x", text: "a", reuseKey: "" }, options), "invalid");
	error(await publish({ title: "x", text: "a", document: "md-00000000000000000000", expectedRevision: 1 }, options), "not-found");
	const update = success(await publish({ title: "new", text: "new", document: first.documentId, expectedRevision: 1 }, options));
	assert.equal(update.revision, 2);
	const conflict = await publish({ title: "stale", text: "stale", document: first.documentId, expectedRevision: 1 }, options);
	error(conflict, "conflict"); if (!conflict.ok) assert.equal(conflict.error.currentRevision, 2);
	success(await publish({ title: "reuse", text: "same", reuseKey: "key" }, options));
	error(await publish({ title: "reuse", text: "different", reuseKey: "key" }, options), "replay-conflict");
	error(await publish({ title: "x", file: "absent.md" }, options), "file-unreadable");
	await writeFile(join(root, "blocked"), "regular file");
	error(await publish({ title: "x", text: "x" }, { ...options, store: new MarkdownStore(join(root, "blocked")) }), "store-failure");
}));
test("file capture accepts relative and absolute UTF-8 sources and never changes them", () => fixture(async (root, store) => {
	const options = { cwd: root, store }; const path = join(root, "source.md"); const content = Buffer.from("# Exact\r\n文書 🦘\r\n");
	await writeFile(path, content);
	for (const file of ["source.md", path]) { const saved = success(await publish({ title: "File", file }, options)); assert.deepEqual(Buffer.from((await store.get(saved.documentId)).source), content); }
	assert.deepEqual(await readFile(path), content);
	assert.equal((await fileSnapshotInput(path, { cwd: root })).title, "source.md");
	await writeFile(join(root, "invalid.md"), Buffer.from([0xff, 0xfe]));
	error(await publish({ title: "x", file: "invalid.md" }, options), "file-unreadable");
	error(await publish({ title: "x", file: root }, options), "file-unreadable");
	await writeFile(path, "a".repeat(LIMITS.sourceBytes));
	assert.equal(success(await publish({ title: "limit", file: path }, options)).bytes, LIMITS.sourceBytes);
	await truncate(path, LIMITS.sourceBytes + 1);
	error(await publish({ title: "limit", file: path }, options), "too-large");
	assert.equal(success(await publish({ title: "limit", text: "a".repeat(LIMITS.sourceBytes) }, options)).bytes, LIMITS.sourceBytes);
	error(await publish({ title: "limit", text: "a".repeat(LIMITS.sourceBytes + 1) }, options), "too-large");
}));
test("asset manifest captures retained, remote, missing, traversal, symlink, size and unsupported references", () => fixture(async (root, store) => {
	const project = join(root, "project"); await mkdir(project); await writeFile(join(project, "a.png"), Buffer.from([137,80,78,71,13,10,26,10]));
	await writeFile(join(root, "outside.png"), "outside"); await symlink(join(root, "outside.png"), join(project, "escape.png"));
	await writeFile(join(project, "large.png"), ""); await truncate(join(project, "large.png"), LIMITS.assetBytes + 1);
	await writeFile(join(project, "script.js"), "alert(1)");
	const refs = ["a.png", "https://example.invalid/beacon.png", "missing.png", "../outside.png", "escape.png", "large.png", "script.js", "javascript:alert(1)"];
	const source = refs.map((ref) => `![x](${ref})`).join("\n"); const path = join(project, "source.md"); await writeFile(path, source);
	const parser = await inspection(root, refs);
	const outcome = success(await publish({ title: "Assets", file: path }, { cwd: root, store, ...parser }));
	assert.equal(outcome.selfContained, false); assert.deepEqual(outcome.references, { state: "inspected", retained: 1, embedded: 0, external: 1, unavailable: 6, localLinks: 0 });
	const stored = await store.get(outcome.documentId);
	assert.deepEqual(stored.revision.references.items.slice(2, 7).map((asset) => asset.reason), ["missing", "outside-root", "outside-root", "too-large", "unsupported-type"]);
	assert.equal(await readFile(path, "utf8"), source);
	assert.equal((await captureReferences({ version: 1, images: ["a.png"], links: [], truncated: false })).references.items[0]?.reason, "no-base");
	await writeFile(path, "![x](a.png)"); assert.equal(success(await publish({ title: "Contained", file: path }, { cwd: root, store, ...await inspection(root, ["a.png"]) })).selfContained, true);
}));
test("asset containment rejects a descriptor opened through a restored ancestor swap", () => fixture(async (root) => {
	const project = join(root, "project"); const images = join(project, "images"); const held = join(project, "held"); const outside = join(root, "outside");
	await mkdir(images, { recursive: true }); await mkdir(outside);
	await writeFile(join(images, "a.png"), "inside"); await writeFile(join(outside, "a.png"), "outside");
	let swaps = 0;
	const opener: typeof open = async (path, flags, mode) => {
		await rename(images, held);
		try { await symlink(outside, images); const handle = await open(path, flags, mode); swaps++; return handle; }
		finally { await rm(images, { force: true }); await rename(held, images); }
	};
	const result = await captureReferences({ version: 1, images: ["images/a.png"], links: [], truncated: false }, project, opener);
	assert.equal(swaps, 1); assert.equal(result.assets.length, 0);
	assert.equal(result.references.items[0]?.state, "unavailable"); assert.equal(result.references.items[0]?.reason, "outside-root");
	assert.equal(await readFile(join(images, "a.png"), "utf8"), "inside");
}));
test("parser inventory enforces item, retained count and total byte limits", () => fixture(async (root) => {
	for (let i = 0; i < 5; i++) { const path = join(root, `${i}.png`); await writeFile(path, ""); await truncate(path, LIMITS.assetBytes); }
	const captured = await captureReferences({ version: 1, images: Array.from({ length: 5 }, (_, i) => `${i}.png`), links: [], truncated: false }, root);
	assert.equal(captured.assets.length, 4); assert.equal(captured.references.items[4]?.reason, "limit");
	const bounded = await captureReferences({ version: 1, images: Array.from({ length: 300 }, (_, i) => `https://example.invalid/${i}.png`), links: [], truncated: true }, root);
	assert.equal(bounded.references.items.length, 256); assert.equal(bounded.references.omitted, 44); assert.equal(bounded.references.truncated, true);
	await writeFile(join(root, "small.png"), "image");
	const count = await captureReferences({ version: 1, images: Array.from({ length: 65 }, (_, i) => `small.png?${i}`), links: [], truncated: false }, root);
	assert.equal(count.assets.length, 64); assert.equal(count.references.items[64]?.reason, "limit");
}));
test("reference inspection requires a compatible local build and records honest fallback", () => fixture(async (root, store) => {
	const parser = await inspection(root, ["https://example.invalid/x.png", "//example.invalid/y", "data:image/png;base64,abcd", "custom:payload", "%xx.png", "a.png", "/etc/a.png"], ["#heading", "https://example.invalid/", "mailto:a@example.invalid", "file:other.md", "../spec.md", "custom:action"]);
	assert.equal((await inspectReferences("source", parser))?.images.length, 7);
	const captured = await captureReferences(await inspectReferences("source", parser));
	assert.deepEqual(captured.references.items.map((item) => item.state), ["external", "external", "embedded", "unavailable", "unavailable", "unavailable", "unavailable", "local-only", "local-only"]);
	assert.deepEqual(captured.references.items.slice(3, 7).map((item) => item.reason), ["unsupported-scheme", "invalid", "no-base", "outside-root"]);
	assert.equal(await inspectReferences("source", { ...parser, runner: async () => "not json" }), undefined);
	assert.equal(await inspectReferences("source", { ...parser, runner: async () => JSON.stringify({ version: 1, images: ["duplicate", "duplicate"], links: [], truncated: false }) }), undefined);
	await writeFile(join(parser.app, "Contents/Resources/build.json"), JSON.stringify({ contract: 2 }));
	assert.equal(await inspectReferences("source", parser), undefined);
	const outcome = success(await publish({ title: "Uninspected", text: "![remote](https://example.invalid/x.png)" }, { cwd: root, store, app: parser.app }));
	assert.equal(outcome.references.state, "uninspected"); assert.equal(Object.hasOwn(outcome, "selfContained"), false);
	assert.deepEqual((await store.get(outcome.documentId)).revision.references, { state: "uninspected", truncated: false, omitted: 0, items: [] });
}));
test("the fixed headless executable receives exact stdin and failures remain uninspected", () => fixture(async (root) => {
	const parser = await inspection(root); const tool = join(parser.app, "Contents/MacOS/markdown-core"); await mkdir(join(parser.app, "Contents/MacOS"));
	const executable = async (body: string) => { await writeFile(tool, `#!${process.execPath}\n${body}`); await chmod(tool, 0o700); };
	await executable("let source='';for await(const chunk of process.stdin)source+=chunk;process.stdout.write(JSON.stringify({version:1,images:[source],links:[],truncated:false}));");
	const exact = "# Unicode 🦘\\nExact"; assert.deepEqual((await inspectReferences(exact, { app: parser.app }))?.images, [exact]);
	await executable("process.stderr.write('refused');process.exit(1);"); assert.equal(await inspectReferences("source", { app: parser.app }), undefined);
	await executable("process.stdout.write('x'.repeat(4*1024*1024+1));"); assert.equal(await inspectReferences("source", { app: parser.app }), undefined);
}));
test("explicit file reuse returns the original receipt after file and asset changes", () => fixture(async (root, store) => {
	const path = join(root, "source.md"); await writeFile(path, "![a](a.png)"); await writeFile(join(root, "a.png"), "original"); const parser = await inspection(root, ["a.png"]);
	const params = { title: "Reused", file: path, reuseKey: "file-reuse" };
	const first = success(await publish(params, { cwd: root, store, ...parser }));
	await writeFile(path, "changed"); await writeFile(join(root, "a.png"), "changed asset");
	const second = success(await publish(params, { cwd: root, store }));
	assert.equal(second.documentId, first.documentId); assert.equal(second.digest, first.digest); assert.equal(second.references.retained, 1); assert.equal(second.replayed, true);
	await rm(path); assert.equal(success(await publish(params, { cwd: root, store })).digest, first.digest);
}));
test("ordinary tool supplies the same structured outcome and never opens a window", () => fixture(async (root, store) => {
	const tool = createPublishTool({ store, cwd: root });
	let session = "first";
	const context = { cwd: root, sessionManager: { getSessionId: () => session }, model: { provider: "faux", id: "faux-1" } } as never;
	const result = await tool.execute("call", { title: "Ordinary", text: "# exact" }, undefined, undefined, context);
	assert.equal((result.structuredContent as PublishOutcome).ok, true);
	assert.deepEqual(result.structuredContent, result.details);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /No window opened\. The operator opens it from the Markdown view under Published \(in the agent view, under Owner views\)\. In an ordinary Pi session, \/markdown md-[a-f0-9]{20} also opens it\./u);
	assert.ok(tool.outputSchema);
	const first = success(result.details); assert.equal(first.provenance.session, "first"); assert.equal(first.provenance.model, "faux/faux-1"); assert.ok(first.provenance.host);
	session = "second";
	const updated = await tool.execute("next", { title: "Updated", text: "other", document: first.documentId.slice(0, 12), expectedRevision: 1 }, undefined, undefined, context);
	assert.equal(success(updated.details).provenance.session, "second"); assert.equal(success(updated.details).revision, 2);
}));

function ready(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve, reject) => {
		let output = ""; let errors = "";
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Child did not reach publication: ${errors}`)); }, 15000);
		child.stdout?.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-4096); if (output.includes("READY\n")) { clearTimeout(timer); resolve(); } });
		child.stderr?.on("data", (chunk: Buffer) => { errors = `${errors}${chunk.toString()}`.slice(-4096); });
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${errors}`)); });
	});
}
function death(child: ReturnType<typeof spawn>): Promise<void> { return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", () => resolve())); }
async function crashNative(root: string, store: MarkdownStore, app: string, params: PublishInput, stage: "plan" | "receipt", resume = false): Promise<void> {
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
	try { await ready(child); }
	finally { if (child.exitCode === null && child.signalCode === null) { const exited = death(child); child.kill("SIGKILL"); await exited; } child.stdin?.destroy(); }
	assert.equal(child.signalCode, "SIGKILL");
}
async function recoverNative(root: string, store: MarkdownStore, app: string, repeat?: PublishInput): Promise<PublishOutcome[]> {
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider); faux.setResponses([fauxAssistantMessage("Recovered.")]);
	const tool = createNativePublishTool({ durable: Durable, cwd: root }, { store, app }); const registry = Durable.createRegistry(); registry.install(Durable.defineExtension({ name: "markdown", tools: [tool] }));
	const harness = await Durable.Harness.open(await openNodeSqliteStorage(join(root, "harness.sqlite")), { models, registry }, context);
	try {
		harness.resume(); const conversation = await harness.root(context);
		const admitted = await harness.commit((tx) => tx.submissionByRequest(conversation.id, "crash-publication"), context); assert.ok(admitted);
		const submission = await harness.submission(admitted.id, context); assert.ok(submission); assert.equal((await submission.wait(context)).status, "done");
		if (repeat) {
			faux.setResponses([fauxAssistantMessage(fauxToolCall("markdown_publish", repeat), { stopReason: "toolUse" }), fauxAssistantMessage("Reused.")]);
			assert.equal((await (await conversation.submit({ type: "input", content: "Reuse the publication." }, context)).wait(context)).status, "done");
		}
		const page = await conversation.entries({}, 100, undefined, context);
		return page.items.filter((entry) => Durable.ToolResultEntry.is(entry)).map((entry) => {
			const message = entry.model?.[0]; assert.ok(message && message.role === "toolResult"); return message.details as PublishOutcome;
		});
	} finally { await harness.close(context); }
}
for (const keyed of [false, true]) test(`a killed ${keyed ? "keyed" : "unkeyed"} native publication over SQLite returns its saved receipt without deleted files`, { timeout: 30000 }, () => fixture(async (root, store) => {
	const source = join(root, "source.md"); const asset = join(root, "a.png"); const originalSource = "# Original\n![a](a.png)";
	await writeFile(source, originalSource); await writeFile(asset, "original asset"); const parser = await inspection(root, ["a.png"]);
	const params = { title: "Crash receipt", file: source, ...(keyed ? { reuseKey: "keyed-crash" } : {}) }; let plan: PublicationPlan | undefined;
	if (keyed) {
		await crashNative(root, store, parser.app, params, "plan");
		plan = await store.reusePlan("keyed-crash", invocationDigest(params, root)); assert.ok(plan); assert.equal(plan.revision, 1);
		assert.equal((await store.list()).documents.length, 0);
	}
	await crashNative(root, store, parser.app, params, "receipt", keyed);
	const before = await store.list(); assert.equal(before.documents.length, 1); const document = before.documents[0]; assert.ok(document);
	if (plan) { assert.equal(document.id, plan.documentId); assert.equal(document.revision, plan.revision); }
	const original = await store.get(document.id); assert.equal(original.source, originalSource); assert.equal(original.revision.references.items[0]?.state, "retained");
	await rm(source); await rm(asset);
	await store.update(document.id, 1, { title: "Newer", source: "# Later revision", contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() } });
	const results = await recoverNative(root, store, parser.app, keyed ? params : undefined); assert.equal(results.length, keyed ? 2 : 1);
	for (const result of results) { assert.ok(result.ok); assert.equal(result.documentId, document.id); assert.equal(result.revision, 1); assert.equal(result.digest, original.revision.digest); assert.equal(result.replayed, true); assert.equal(result.references.retained, 1); }
	assert.equal((await store.list()).documents.length, 1); assert.equal((await store.get(document.id)).document.revision, 2); assert.equal((await store.get(document.id, 1)).source, originalSource);
	const retained = original.revision.references.items[0]?.file; assert.ok(retained); assert.equal(await readFile(join(store.root, "documents", document.id, "revisions/1", retained), "utf8"), "original asset");
}));

test("native model and codemode calls share outcomes, prefixes and explicit reuse", { timeout: 30000 }, () => fixture(async (root, store) => {
	const storage = new Durable.MemoryStorage(); const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const native = createNativePublishTool({ durable: Durable, cwd: root, storageId: "synthetic" }, { store });
	assert.equal(native.replay, "safe"); assert.ok(native.structuredOutputSchema);
	const registry = Durable.createRegistry(); const results: { outcome: PublishOutcome; text: string }[] = [];
	registry.install(Durable.defineExtension({ name: "markdown", tools: [{ ...native, async execute(args, api, context) { const result = await native.execute(args as PublishInput, api, context); results.push({ outcome: result.structuredOutput as PublishOutcome, text: (result.output ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("") }); return result; } }] }));
	const sandbox = new CodemodeSandbox(); registry.install(createCodemodeExtension({ sandbox, models: false }));
	const first = await Durable.Harness.open(storage, { models, registry }, context);
	try {
		const conversation = await first.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		faux.setResponses([fauxAssistantMessage(fauxToolCall("markdown_publish", { title: "Native", text: "# persisted" }), { stopReason: "toolUse" }), fauxAssistantMessage("Saved.")]);
		const submission = await conversation.submit({ type: "input", content: "Publish." }, context);
		assert.equal((await submission.wait(context)).status, "done"); const firstOutcome = results[0]?.outcome; assert.ok(firstOutcome?.ok);
		assert.match(results[0]?.text ?? "", /^Saved md-[a-f0-9]{20}, revision 1, \d+ bytes\.\nNo window opened\. The operator opens it from the Markdown view under Published \(in the agent view, under Owner views\)\. In an ordinary Pi session, \/markdown md-[a-f0-9]{20} also opens it\./u);
		faux.setResponses([fauxAssistantMessage(fauxToolCall("markdown_publish", { title: "Prefix update", text: "updated by prefix", document: firstOutcome.documentId.slice(0, 12), expectedRevision: 1 }), { stopReason: "toolUse" }), fauxAssistantMessage("Updated.")]);
		assert.equal((await (await conversation.submit({ type: "input", content: "Update by prefix." }, context)).wait(context)).status, "done");
		assert.equal((await store.get(firstOutcome.documentId)).document.revision, 2);
		const code = 'const a = await tools.markdown_publish({title:"Nested",text:"same"}); const b = await tools.markdown_publish({title:"Nested",text:"same"}); const c = await tools.markdown_publish({title:"Reused",text:"same",reuseKey:"nested-reuse"}); const d = await tools.markdown_publish({title:"Reused",text:"same",reuseKey:"nested-reuse"}); text({a,b,c,d});';
		faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
		assert.equal((await (await conversation.submit({ type: "input", content: "Publish twice through code." }, context)).wait(context)).status, "done");
		assert.equal((await store.list()).documents.length, 4);
		const page = await conversation.entries({}, 100, undefined, context);
		const message = page.items.flatMap((entry) => entry.model ?? []).find((message) => message.role === "toolResult" && message.toolName === "codemode"); assert.ok(message && message.role === "toolResult");
		const output = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\\n");
		const nested = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
		assert.equal(nested.a.ok, true); assert.equal(nested.b.ok, true); assert.notEqual(nested.a.documentId, nested.b.documentId); assert.equal(nested.c.documentId, nested.d.documentId); assert.equal(nested.d.replayed, true);
	} finally { await first.close(context); sandbox.close(); }
}));
