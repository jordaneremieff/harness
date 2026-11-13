import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { arr, obj, str, opt, int, bool, lit, union, type Static } from "@earendil-works/pi-schema";
import { toolDisplay } from "./display.ts";
import { showCommand } from "./show.ts";
import { digest, LIMITS, type MarkdownStore, StoreError, validateInput, type AssetRecord, type CapturedAsset, type ContentOrigin, type ErrorCode, type PublicationPlan, type ReferenceInventory, type WriteInput, type WriteResult } from "./store.ts";

export const PublishParameters = obj({
	title: str({ minLength: 1, maxLength: 200, description: "One-line document title." }),
	text: opt(str({ description: "Exact Markdown source. Supply text or file, not both." })),
	file: opt(str({ minLength: 1, description: "Explicit local UTF-8 source path, relative to the working directory or absolute. The source file stays unchanged." })),
	document: opt(str({ description: "Stable ID of a published document to update." })),
	expectedRevision: opt(int({ minimum: 1 })),
	reuseKey: opt(str({ minLength: 1, maxLength: 256, description: "Explicit request identity. Equal input reuses the first publication; different input conflicts." })),
}, { open: false });
export type PublishInput = Static<typeof PublishParameters>;
export type PublishOutcome = { ok: true; documentId: string; revision: number; digest: string; bytes: number; title: string; kind: "published"; created: boolean; replayed: boolean; selfContained?: boolean; references: { state: "inspected" | "uninspected"; retained: number; embedded: number; external: number; unavailable: number; localLinks: number }; provenance: ContentOrigin; open: string; show: string[] } | { ok: false; error: { code: ErrorCode; message: string; currentRevision?: number; currentDigest?: string } };
const OriginSchema = obj({ kind: str(), capturedAt: str() }, { open: true });
export const PublishOutcomeSchema = union([
	obj({ ok: lit(true), documentId: str(), revision: int(), digest: str(), bytes: int(), title: str(), kind: lit("published"), created: bool(), replayed: bool(), selfContained: opt(bool()), references: obj({ state: union([lit("inspected"), lit("uninspected")]), retained: int(), embedded: int(), external: int(), unavailable: int(), localLinks: int() }), provenance: OriginSchema, open: str(), show: arr(str()) }),
	obj({ ok: lit(false), error: obj({ code: union(["invalid", "too-large", "not-found", "conflict", "replay-conflict", "file-unreadable", "store-failure"].map((code) => lit(code))), message: str(), currentRevision: opt(int()), currentDigest: opt(str()) }) }),
]);
const REMEDY = "Reference inspection unavailable. Build with node extensions/markdown/native/build.mts.";
const DESCRIPTION = "Save an exact Markdown document silently for the native reader. Supply a title and exactly one of text or an explicit local file. Updates require document and expectedRevision. No window opens. Publish requested documents or long deliverables, not every reply. The result's show command displays the document in a terminal: when the operator should read it now, run that command in one terminal pane beside the operator, such as a split or floating pane. Open one pane for each document, not one for each update.";
export type ReferenceRunner = (tool: string, source: string) => Promise<string>;
export type InspectionOptions = { app?: string; runner?: ReferenceRunner; toolPath?: string };
export type PublishOptions = InspectionOptions & { store: MarkdownStore; cwd: string; provenance?: Partial<ContentOrigin>; plan?: PublicationPlan };
export type ReferenceInspection = { version: 1; images: string[]; links: string[]; truncated: boolean };

function validateParameters(value: PublishInput): void {
	if (!value || typeof value !== "object" || typeof value.title !== "string") throw new StoreError("invalid", "A title and one source are required.");
	if ((typeof value.text === "string") === (typeof value.file === "string")) throw new StoreError("invalid", "Supply exactly one of text or file.");
	if ((value.document === undefined) !== (value.expectedRevision === undefined)) throw new StoreError("invalid", "Updates require document and expectedRevision together.");
	if (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)) throw new StoreError("invalid", "Expected revision must be a positive integer.");
	if (value.reuseKey !== undefined && (typeof value.reuseKey !== "string" || !value.reuseKey || value.reuseKey.length > 256 || /[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value.reuseKey))) throw new StoreError("invalid", "Reuse key must be nonempty text of at most 256 characters.");
}
export function invocationDigest(params: PublishInput, cwd: string): string {
	return digest(JSON.stringify({ title: params.title, ...(params.file === undefined ? { text: params.text } : { file: resolve(cwd, params.file) }), ...(params.document === undefined ? {} : { document: params.document, expectedRevision: params.expectedRevision }), ...(params.reuseKey === undefined ? {} : { reuseKey: params.reuseKey }) }));
}
type FileIdentity = { ino: bigint; dev: bigint };
async function boundedFile(path: string, max: number, noFollow = false, opener: typeof open = open): Promise<{ data: Buffer; identity: FileIdentity }> {
	const handle = await opener(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
	try {
		const info = await handle.stat({ bigint: true });
		if (!info.isFile()) throw new StoreError("file-unreadable", "Source must be a regular file.");
		if (info.size > max) throw new StoreError("too-large", "File exceeds the byte limit.");
		const data = Buffer.alloc(max + 1); let length = 0;
		while (length < data.length) { const { bytesRead } = await handle.read(data, length, data.length - length, length); if (!bytesRead) break; length += bytesRead; }
		if (length > max) throw new StoreError("too-large", "File exceeds the byte limit.");
		return { data: data.subarray(0, length), identity: { dev: info.dev, ino: info.ino } };
	} finally { await handle.close(); }
}
const INSPECTION_OUTPUT_BYTES = 4 * 1024 * 1024;
function runReferences(tool: string, source: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(tool, ["references"], { stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = []; let bytes = 0; let stderrBytes = 0;
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Reference tool timed out")); }, 10000);
		child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > INSPECTION_OUTPUT_BYTES) { child.kill("SIGKILL"); reject(new Error("Reference output exceeded limit")); } else chunks.push(chunk); });
		child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 4096) { child.kill("SIGKILL"); reject(new Error("Reference diagnostics exceeded limit")); } });
		child.stdin.on("error", () => {});
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error("Reference tool failed")); else resolve(Buffer.concat(chunks).toString("utf8")); });
		child.stdin.end(source);
	});
}
function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 4096 && value.every((item) => typeof item === "string" && !/[\ud800-\udfff]/u.test(item)) && new Set(value).size === value.length; }
export async function inspectReferences(source: string, options: InspectionOptions): Promise<ReferenceInspection | undefined> {
	if (Buffer.byteLength(source) > LIMITS.sourceBytes) throw new StoreError("too-large", "Source exceeds 2 MiB.");
	try {
		const tool = options.toolPath ?? (options.app ? join(options.app, "Contents/MacOS/markdown-core") : undefined);
		if (!tool) return undefined;
		const app = options.app ?? resolve(dirname(tool), "../..");
		const buildPath = join(app, "Contents/Resources/build.json");
		const build = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode((await boundedFile(buildPath, 16384)).data));
		if (build?.contract !== 1) return undefined;
		const result = await (options.runner ?? runReferences)(tool, source);
		if (Buffer.byteLength(result) > INSPECTION_OUTPUT_BYTES) return undefined;
		const value: unknown = JSON.parse(result);
		if (!value || typeof value !== "object") return undefined;
		const record = value as Record<string, unknown>;
		if (record.version !== 1 || !stringList(record.images) || !stringList(record.links) || typeof record.truncated !== "boolean") return undefined;
		return { version: 1, images: record.images, links: record.links, truncated: record.truncated };
	} catch { return undefined; }
}
const MEDIA: Record<string, [string, string]> = { ".png": ["image/png", "png"], ".jpg": ["image/jpeg", "jpg"], ".jpeg": ["image/jpeg", "jpg"], ".gif": ["image/gif", "gif"], ".webp": ["image/webp", "webp"], ".svg": ["image/svg+xml", "svg"] };
function unavailable(reference: string, reason: AssetRecord["reason"]): CapturedAsset { return { record: { kind: "image", reference, state: "unavailable", reason } }; }
function inside(root: string, path: string): boolean { const part = relative(root, path); return part !== ".." && !part.startsWith("../") && !isAbsolute(part); }
function classifyImage(reference: string): CapturedAsset | undefined {
	if (/^(https?:|\/\/)/i.test(reference)) return { record: { kind: "image", reference, state: "external" } };
	if (/^data:/i.test(reference)) return { record: { kind: "image", reference: [...reference].slice(0, 64).join(""), state: "embedded" } };
	if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) return unavailable(reference, "unsupported-scheme");
	if (isAbsolute(reference)) return unavailable(reference, "outside-root");
	return undefined;
}
function sameAsset(path: string, afterPath: string, root: string, before: FileIdentity, after: FileIdentity, opened: FileIdentity): boolean { return path === afterPath && inside(root, afterPath) && before.ino === after.ino && before.dev === after.dev && opened.ino === before.ino && opened.dev === before.dev; }
async function captureImage(reference: string, root: string | undefined, opener: typeof open): Promise<CapturedAsset> {
	const classified = classifyImage(reference); if (classified) return classified;
	let decoded: string;
	try { decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0] ?? ""); } catch { return unavailable(reference, "invalid"); }
	if (!decoded || /[\p{Cc}]/u.test(decoded)) return unavailable(reference, "invalid");
	if (isAbsolute(decoded)) return unavailable(reference, "outside-root");
	if (!root) return unavailable(reference, "no-base");
	const candidate = resolve(root, decoded);
	if (!inside(root, candidate)) return unavailable(reference, "outside-root");
	try {
		const path = await realpath(candidate);
		if (!inside(root, path)) return unavailable(reference, "outside-root");
		const media = MEDIA[extname(path).toLowerCase()];
		if (!media) return unavailable(reference, "unsupported-type");
		const before = await stat(path, { bigint: true }); const { data, identity } = await boundedFile(path, LIMITS.assetBytes, true, opener);
		const afterPath = await realpath(candidate); const after = await stat(afterPath, { bigint: true });
		if (!sameAsset(path, afterPath, root, before, after, identity)) return unavailable(reference, "outside-root");
		const assetDigest = digest(data);
		return { data, record: { kind: "image", reference, state: "retained", file: `assets/${assetDigest.slice(7)}.${media[1]}`, mediaType: media[0], bytes: data.length, digest: assetDigest } };
	} catch (error) { return unavailable(reference, error instanceof StoreError && error.code === "too-large" ? "too-large" : "missing"); }
}
/** Metadata keeps at most the first 512 characters of a reference; the exact source keeps the whole destination. */
const REFERENCE_CHARS = 512;
function shortReference(reference: string): string { const characters = [...reference]; return characters.length > REFERENCE_CHARS ? characters.slice(0, REFERENCE_CHARS).join("") : reference; }
/** The reader finds an image's item by its whole reference, so a retained image keeps it and a shortened reference never names another image. */
function imageRecord(record: AssetRecord, destination: string, images: Set<string>): AssetRecord | undefined {
	if (record.state === "retained") return record;
	const reference = shortReference(record.reference);
	return reference !== destination && images.has(reference) ? undefined : { ...record, reference };
}
function localLink(reference: string): boolean {
	if (reference.startsWith("#") || /^(https?:|mailto:|\/\/)/i.test(reference)) return false;
	return /^file:/i.test(reference) || !/^[a-z][a-z0-9+.-]*:/i.test(reference);
}
export async function captureReferences(inspection: ReferenceInspection | undefined, root?: string, opener: typeof open = open): Promise<{ references: ReferenceInventory; assets: CapturedAsset[] }> {
	if (!inspection) return { references: { state: "uninspected", truncated: false, omitted: 0, items: [] }, assets: [] };
	const canonicalRoot = root === undefined ? undefined : await realpath(root);
	const destinations = [...inspection.images.map((reference) => ({ kind: "image" as const, reference })), ...inspection.links.filter(localLink).map((reference) => ({ kind: "link" as const, reference }))];
	const references: ReferenceInventory = { state: "inspected", truncated: inspection.truncated, omitted: Math.max(0, destinations.length - 256), items: [] };
	const images = new Set(inspection.images);
	const assets: CapturedAsset[] = []; let total = 0;
	for (const destination of destinations.slice(0, 256)) {
		if (destination.kind === "link") { references.items.push({ ...destination, reference: shortReference(destination.reference), state: "local-only" }); continue; }
		let asset = await captureImage(destination.reference, canonicalRoot, opener);
		if (asset.data && (assets.length >= LIMITS.assetCount || total + asset.data.length > LIMITS.totalAssetBytes)) asset = unavailable(destination.reference, "limit");
		if (asset.data) { total += asset.data.length; assets.push(asset); }
		const record = imageRecord(asset.record, destination.reference, images);
		if (record) references.items.push(record); else references.omitted++;
	}
	return { references, assets };
}
export async function fileSnapshotInput(path: string, options: InspectionOptions & { cwd: string }): Promise<WriteInput> {
	let resolved: string; let source: string;
	try {
		if (!path || /[\p{Cc}\ud800-\udfff]/u.test(path)) throw new Error("Invalid path");
		resolved = await realpath(resolve(options.cwd, path));
		source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode((await boundedFile(resolved, LIMITS.sourceBytes)).data);
	} catch (error) { if (error instanceof StoreError && error.code === "too-large") throw error; throw new StoreError("file-unreadable", "Source file is unavailable, nonregular or not UTF-8."); }
	const captured = await captureReferences(await inspectReferences(source, options), dirname(resolved));
	return { title: basename(resolved), source, contentOrigin: { kind: "file", path: resolved, cwd: options.cwd, capturedAt: new Date().toISOString() }, ...captured };
}
export async function preparePublication(params: PublishInput, options: PublishOptions): Promise<WriteInput> {
	validateParameters(params);
	let input: WriteInput;
	if (params.file !== undefined) input = await fileSnapshotInput(params.file, options);
	else {
		input = { title: params.title, source: params.text ?? "", contentOrigin: { kind: "tool", capturedAt: new Date().toISOString(), cwd: options.cwd } };
		validateInput(input);
		if (!input.source.trim()) throw new StoreError("invalid", "Publication source must not be empty.");
		Object.assign(input, await captureReferences(await inspectReferences(input.source, options)));
	}
	if (!input.source.trim()) throw new StoreError("invalid", "Publication source must not be empty.");
	input.title = params.title;
	input.contentOrigin = { ...options.provenance, ...input.contentOrigin, host: hostname() };
	input.invocationDigest = invocationDigest(params, options.cwd);
	validateInput(input);
	return input;
}
export function publicationOutcome(result: WriteResult, root: string): PublishOutcome {
	const { revision } = result; const items = revision.references.items;
	return { ok: true, documentId: revision.document, revision: revision.revision, digest: revision.digest, bytes: revision.bytes, title: revision.title, kind: "published", created: result.created, replayed: result.replayed, ...(revision.selfContained === undefined ? {} : { selfContained: revision.selfContained }), references: { state: revision.references.state, retained: items.filter((item) => item.state === "retained").length, embedded: items.filter((item) => item.state === "embedded").length, external: items.filter((item) => item.state === "external").length, unavailable: items.filter((item) => item.state === "unavailable").length, localLinks: items.filter((item) => item.state === "local-only").length }, provenance: revision.contentOrigin, open: `/markdown ${revision.document}`, show: showCommand(root, revision.document) };
}
function failure(error: unknown): PublishOutcome {
	if (!(error instanceof StoreError)) return { ok: false, error: { code: "store-failure", message: "Private document store is unavailable." } };
	return { ok: false, error: { code: error.code, message: error.message.slice(0, 300), ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }), ...(error.currentDigest === undefined ? {} : { currentDigest: error.currentDigest }) } };
}
async function normaliseInvocation(params: PublishInput, store: MarkdownStore, remembered?: PublicationPlan): Promise<PublishInput> {
	validateParameters(params);
	if (!params.document) return params;
	const identity = remembered?.documentId.startsWith(params.document) ? remembered.documentId : params.document;
	const stored = await store.get(identity);
	if (stored.document.kind !== "published") throw new StoreError("invalid", "Only published documents accept explicit updates.");
	return { ...params, document: stored.document.id };
}
async function save(params: PublishInput, input: WriteInput, options: PublishOptions): Promise<PublishOutcome> {
	if (params.document) return publicationOutcome(await options.store.update(params.document, params.expectedRevision ?? 0, input, { plan: options.plan, reuseKey: params.reuseKey }), options.store.root);
	return publicationOutcome(await options.store.create(input, { plan: options.plan, reuseKey: params.reuseKey }), options.store.root);
}
async function savedPlan(store: MarkdownStore, plan: PublicationPlan): Promise<WriteResult | undefined> {
	try {
		const found = await store.get(plan.documentId, plan.revision);
		if (found.revision.publication === plan.publicationId) return { ...found, created: plan.revision === 1, replayed: true };
	} catch (error) { if (!(error instanceof StoreError) || error.code !== "not-found") throw error; }
	return undefined;
}
async function previousPlan(params: PublishInput, options: PublishOptions): Promise<PublicationPlan | undefined> {
	const inputDigest = invocationDigest(params, options.cwd);
	if (options.plan && options.plan.inputDigest !== inputDigest) throw new StoreError("replay-conflict", "Request identity already names different input.");
	return params.reuseKey === undefined ? options.plan : await options.store.reusePlan(params.reuseKey, inputDigest) ?? options.plan;
}
export async function publish(params: PublishInput, options: PublishOptions): Promise<PublishOutcome> {
	try {
		params = await normaliseInvocation(params, options.store);
		const plan = await previousPlan(params, options);
		const saved = plan ? await savedPlan(options.store, plan) : undefined;
		if (saved) return publicationOutcome(saved, options.store.root);
		return await save(params, await preparePublication(params, options), { ...options, plan });
	} catch (error) { return failure(error); }
}
/** An attached agent terminal sends slash text to the conversation, so the receipt names the view first. */
function openingRoute(documentId: string): string {
	return `The operator opens it from the Markdown view under Published (in the agent view, under Owner views). In an ordinary Pi session, /markdown ${documentId} also opens it.`;
}
export function publicationText(outcome: PublishOutcome): string {
	if (!outcome.ok) return `Markdown publication failed (${outcome.error.code}): ${outcome.error.message}`;
	return `Saved ${outcome.documentId}, revision ${outcome.revision}, ${outcome.bytes} bytes.\nNo window opened. ${openingRoute(outcome.documentId)}${outcome.references.state === "uninspected" ? ` ${REMEDY}` : ""}\nTo show it to the operator in a terminal pane, run this command there: ${JSON.stringify(outcome.show)}. In that pane, o opens the native reader.`;
}
export function createPublishTool(options: Omit<PublishOptions, "cwd"> & { cwd?: string }): ToolDefinition<typeof PublishParameters, PublishOutcome> {
	const presentation = toolDisplay().tools[0];
	return { ...presentation, name: "markdown_publish", label: "Markdown Publish", description: DESCRIPTION, promptSnippet: "Save an exact Markdown document for the native reader; its show command displays it in a terminal pane.", parameters: PublishParameters, outputSchema: PublishOutcomeSchema, async execute(_id, params, _signal, _update, context) {
		const outcome = await publish(params as PublishInput, { ...options, cwd: context.cwd, provenance: { ...options.provenance, session: context.sessionManager.getSessionId(), ...(context.model ? { model: `${context.model.provider}/${context.model.id}` } : {}) } });
		return { content: [{ type: "text", text: publicationText(outcome) }], details: outcome, structuredContent: outcome, isError: !outcome.ok };
	} };
}
export function createNativePublishTool(host: { durable: typeof Durable; cwd: string; storageId?: string }, options: Omit<PublishOptions, "cwd" | "plan">): Durable.ToolRegistration<typeof PublishParameters, Durable.JsonObject> {
	return host.durable.defineTool({ name: "markdown_publish", description: DESCRIPTION, parameters: PublishParameters, structuredOutputSchema: PublishOutcomeSchema, replay: "safe", async execute(params, api, context) {
		let outcome: PublishOutcome;
		try {
			const remembered = await api.memo<PublicationPlan>("markdown.publication", context);
			params = await normaliseInvocation(params, options.store, remembered);
			const cwd = api.env?.cwd ?? host.cwd;
			const previous = await previousPlan(params, { ...options, cwd, plan: remembered });
			if (previous) await api.memo("markdown.publication", previous, context);
			const saved = previous ? await savedPlan(options.store, previous) : undefined;
			if (saved) outcome = publicationOutcome(saved, options.store.root);
			else {
				const agent = await api.agent(context);
				const local = { ...options, cwd, provenance: { ...options.provenance, session: host.storageId, conversation: String(api.conversationId), ...(agent.model ? { model: `${agent.model.provider}/${agent.model.modelId}` } : {}) } };
				const input = await preparePublication(params, local);
				const candidate = await options.store.preparePlan(input, { document: params.document, expectedRevision: params.expectedRevision, reuseKey: params.reuseKey });
				const plan = await api.memo("markdown.publication", previous ?? candidate, context);
				outcome = await save(params, input, { ...local, plan });
			}
		} catch (error) { outcome = failure(error); }
		return { output: [{ type: "text", text: publicationText(outcome) }], structuredOutput: outcome, details: outcome, isError: !outcome.ok };
	} });
}
