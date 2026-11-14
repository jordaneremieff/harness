import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { arr, obj, str, opt, int, bool, lit, union, type Static } from "@earendil-works/pi-schema";
import { toolDisplay } from "./display.ts";
import type { Context } from "@earendil-works/chord/context";
import { previousNative } from "./native-responses.ts";
import { paneCommand } from "./pane-command.ts";
import { previousOrdinary, responseSnapshotWrite, type ResponseSnapshot } from "./responses.ts";
import { digest, LIMITS, type MarkdownStore, StoreError, validateInput, type AssetRecord, type CapturedAsset, type ContentOrigin, type ErrorCode, type PublicationPlan, type ReferenceInventory, type WriteInput, type WriteResult } from "./store.ts";

export const PublishParameters = obj({
	title: opt(str({ minLength: 1, maxLength: 200, description: "One-line document title. Required with text or file." })),
	text: opt(str({ description: "Exact Markdown source. Supply one of text, file or response." })),
	file: opt(str({ minLength: 1, description: "Explicit local UTF-8 source path, relative to the working directory or absolute. The source file stays unchanged." })),
	response: opt(lit("previous", { description: "Save the exact earlier answer instead of new text: the newest assistant response with text before the newest user message. Takes no title, document, expectedRevision or reuseKey." })),
	document: opt(str({ description: "Stable ID of a published document to update." })),
	expectedRevision: opt(int({ minimum: 1 })),
	reuseKey: opt(str({ minLength: 1, maxLength: 256, description: "Explicit request identity. Equal input reuses the first publication; different input conflicts." })),
}, { open: false });
export type PublishInput = Static<typeof PublishParameters>;
export type PublishOutcome = { ok: true; documentId: string; revision: number; digest: string; bytes: number; title: string; kind: "published" | "response"; created: boolean; replayed: boolean; selfContained?: boolean; references: { state: "inspected" | "uninspected"; retained: number; embedded: number; external: number; unavailable: number; localLinks: number }; provenance: ContentOrigin; open: string; show?: string[]; showUnavailable?: string } | { ok: false; error: { code: ErrorCode; message: string; currentRevision?: number; currentDigest?: string } };
const OriginSchema = obj({ kind: str(), capturedAt: str() }, { open: true });
export const PublishOutcomeSchema = union([
	obj({ ok: lit(true), documentId: str(), revision: int(), digest: str(), bytes: int(), title: str(), kind: union([lit("published"), lit("response")]), created: bool(), replayed: bool(), selfContained: opt(bool()), references: obj({ state: union([lit("inspected"), lit("uninspected")]), retained: int(), embedded: int(), external: int(), unavailable: int(), localLinks: int() }), provenance: OriginSchema, open: str(), show: opt(arr(str())), showUnavailable: opt(str()) }),
	obj({ ok: lit(false), error: obj({ code: union(["invalid", "too-large", "not-found", "conflict", "replay-conflict", "file-unreadable", "store-failure"].map((code) => lit(code))), message: str(), currentRevision: opt(int()), currentDigest: opt(str()) }) }),
]);
const REMEDY = "Reference inspection unavailable. Build with node extensions/markdown/native/build.mts.";
const DESCRIPTION = "Save an exact Markdown document silently for the native reader. Supply a title and exactly one of text or an explicit local file. Updates require document and expectedRevision. No window opens. Publish requested documents or long deliverables, not every reply. When the operator should read a document now, run the result's show command as the program of one new split pane beside your own conversation pane, in the terminal window where you yourself run, not in whichever window has focus, in a pane that closes when its program ends: the native reader window then sits over that pane, with real selection, copying, find, links and scrolling, and your conversation stays visible beside it. Do not float the reader over your conversation. An open reader follows new revisions of its document, so publish a correction as an update to the same document instead of opening another pane; to show a different document while a reader pane that you opened is still open, open the new pane in that pane's place and close the earlier one. To show a stored document again later, run the same command with that document's ID: the reader returns to the saved reading position. To show an earlier answer exactly, use response \"previous\" instead of retyping it. To explain something visually, write an SVG or PNG diagram beside a Markdown file, reference it with a relative image link, and publish the file: the revision keeps the image.";
export type ReferenceRunner = (tool: string, source: string) => Promise<string>;
export type InspectionOptions = { app?: string; runner?: ReferenceRunner; toolPath?: string };
export type PublishOptions = InspectionOptions & { store: MarkdownStore; cwd: string; provenance?: Partial<ContentOrigin>; plan?: PublicationPlan; previousResponse?: () => Promise<ResponseSnapshot> };
export type ReferenceInspection = { version: 1; images: string[]; links: string[]; truncated: boolean };

/** Checks a publication's parameters and returns its title. */
function validateParameters(value: PublishInput): string {
	if (!value || typeof value !== "object" || typeof value.title !== "string") throw new StoreError("invalid", "A title and one source are required.");
	if (value.response !== undefined) throw new StoreError("invalid", "Supply exactly one of text, file or response.");
	if ((typeof value.text === "string") === (typeof value.file === "string")) throw new StoreError("invalid", "Supply exactly one of text or file.");
	if ((value.document === undefined) !== (value.expectedRevision === undefined)) throw new StoreError("invalid", "Updates require document and expectedRevision together.");
	if (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)) throw new StoreError("invalid", "Expected revision must be a positive integer.");
	if (value.reuseKey !== undefined && (typeof value.reuseKey !== "string" || !value.reuseKey || value.reuseKey.length > 256 || /[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value.reuseKey))) throw new StoreError("invalid", "Reuse key must be nonempty text of at most 256 characters.");
	return value.title;
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
	const title = validateParameters(params);
	let input: WriteInput;
	if (params.file !== undefined) input = await fileSnapshotInput(params.file, options);
	else {
		input = { title, source: params.text ?? "", contentOrigin: { kind: "tool", capturedAt: new Date().toISOString(), cwd: options.cwd } };
		validateInput(input);
		if (!input.source.trim()) throw new StoreError("invalid", "Publication source must not be empty.");
		Object.assign(input, await captureReferences(await inspectReferences(input.source, options)));
	}
	if (!input.source.trim()) throw new StoreError("invalid", "Publication source must not be empty.");
	input.title = title;
	input.contentOrigin = { ...options.provenance, ...input.contentOrigin, host: hostname() };
	input.invocationDigest = invocationDigest(params, options.cwd);
	validateInput(input);
	return input;
}
/** Saves the earlier answer exactly as a response snapshot; the same response always names the same snapshot. */
async function snapshotPrevious(params: PublishInput, options: PublishOptions): Promise<PublishOutcome> {
	if (params.text !== undefined || params.file !== undefined) throw new StoreError("invalid", "Supply exactly one of text, file or response.");
	if (params.title !== undefined || params.document !== undefined || params.expectedRevision !== undefined || params.reuseKey !== undefined) throw new StoreError("invalid", "A response snapshot takes no title, document, expectedRevision or reuseKey.");
	if (!options.previousResponse) throw new StoreError("invalid", "This host cannot read earlier responses.");
	let response: ResponseSnapshot;
	try { response = await options.previousResponse(); } catch (error) { throw new StoreError("not-found", error instanceof Error ? error.message : String(error)); }
	const { sourceKey, input } = responseSnapshotWrite(response);
	return publicationOutcome(await options.store.snapshot(sourceKey, "response", input), options.store.root, options.app);
}
export function publicationOutcome(result: WriteResult, root: string, app: string | undefined): PublishOutcome {
	const { revision } = result; const items = revision.references.items;
	return { ok: true, documentId: revision.document, revision: revision.revision, digest: revision.digest, bytes: revision.bytes, title: revision.title, kind: result.document.kind === "response" ? "response" : "published", created: result.created, replayed: result.replayed, ...(revision.selfContained === undefined ? {} : { selfContained: revision.selfContained }), references: { state: revision.references.state, retained: items.filter((item) => item.state === "retained").length, embedded: items.filter((item) => item.state === "embedded").length, external: items.filter((item) => item.state === "external").length, unavailable: items.filter((item) => item.state === "unavailable").length, localLinks: items.filter((item) => item.state === "local-only").length }, provenance: revision.contentOrigin, open: `/markdown ${revision.document}`, ...paneCommand(app, root, revision.document) };
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
	if (params.document) return publicationOutcome(await options.store.update(params.document, params.expectedRevision ?? 0, input, { plan: options.plan, reuseKey: params.reuseKey }), options.store.root, options.app);
	return publicationOutcome(await options.store.create(input, { plan: options.plan, reuseKey: params.reuseKey }), options.store.root, options.app);
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
		if (params?.response !== undefined) return await snapshotPrevious(params, options);
		params = await normaliseInvocation(params, options.store);
		const plan = await previousPlan(params, options);
		const saved = plan ? await savedPlan(options.store, plan) : undefined;
		if (saved) return publicationOutcome(saved, options.store.root, options.app);
		return await save(params, await preparePublication(params, options), { ...options, plan });
	} catch (error) { return failure(error); }
}
/** An attached agent terminal sends slash text to the conversation, so the receipt names the view first. */
function openingRoute(outcome: Extract<PublishOutcome, { ok: true }>): string {
	if (outcome.kind === "response") return `In an ordinary Pi session, /markdown ${outcome.documentId} opens it.`;
	return `The operator opens it from the Markdown view under Published (in the agent view, under Owner views). In an ordinary Pi session, /markdown ${outcome.documentId} also opens it.`;
}
export function publicationText(outcome: PublishOutcome): string {
	if (!outcome.ok) return `Markdown publication failed (${outcome.error.code}): ${outcome.error.message}`;
	return `Saved ${outcome.documentId}, revision ${outcome.revision}, ${outcome.bytes} bytes.\nNo window opened. ${openingRoute(outcome)}${outcome.references.state === "uninspected" ? ` ${REMEDY}` : ""}\n${showText(outcome)}`;
}
function showText(outcome: Extract<PublishOutcome, { ok: true }>): string {
	if (!outcome.show) return `It cannot be shown in a terminal pane: ${outcome.showUnavailable ?? "no reader command is available."}`;
	return `To show it to the operator now, run this command as the program of a new split pane beside your own conversation pane that closes when its program ends: ${JSON.stringify(outcome.show)}. The reader window sits over that pane and follows new revisions of this document; q in the pane or the reader's close button ends it.`;
}
export function createPublishTool(options: Omit<PublishOptions, "cwd"> & { cwd?: string }): ToolDefinition<typeof PublishParameters, PublishOutcome> {
	const presentation = toolDisplay().tools[0];
	return { ...presentation, name: "markdown_publish", label: "Markdown Publish", description: DESCRIPTION, promptSnippet: "Save an exact Markdown document for the native reader; its show command puts the reader over a terminal pane.", parameters: PublishParameters, outputSchema: PublishOutcomeSchema, async execute(_id, params, _signal, _update, context) {
		const outcome = await publish(params as PublishInput, { ...options, cwd: context.cwd, provenance: { ...options.provenance, session: context.sessionManager.getSessionId(), ...(context.model ? { model: `${context.model.provider}/${context.model.id}` } : {}) }, previousResponse: async () => previousOrdinary(context.sessionManager) });
		return { content: [{ type: "text", text: publicationText(outcome) }], details: outcome, structuredContent: outcome, isError: !outcome.ok };
	} };
}
type NativeHost = { durable: typeof Durable; cwd: string; storageId?: string; harness?: Pick<Durable.Harness, "conversation"> };
export function createNativePublishTool(host: NativeHost, options: Omit<PublishOptions, "cwd" | "plan">): Durable.ToolRegistration<typeof PublishParameters, Durable.JsonObject> {
	return host.durable.defineTool({ name: "markdown_publish", description: DESCRIPTION, parameters: PublishParameters, structuredOutputSchema: PublishOutcomeSchema, replay: "safe", async execute(params, api, context) {
		try {
			if (params?.response !== undefined) return nativeResult(await snapshotPrevious(params, { ...options, cwd: api.env?.cwd ?? host.cwd, previousResponse: () => nativePrevious(host, api, context) }));
			return nativeResult(await nativePublication(params, api, context, host, options));
		} catch (error) { return nativeResult(failure(error)); }
	} });
}
/** A native publication memoises its random plan in the tool task before the document write. */
async function nativePublication(params: PublishInput, api: Durable.ToolExecutionApi, context: Context, host: NativeHost, options: Omit<PublishOptions, "cwd" | "plan">): Promise<PublishOutcome> {
	const remembered = await api.memo<PublicationPlan>("markdown.publication", context);
	params = await normaliseInvocation(params, options.store, remembered);
	const cwd = api.env?.cwd ?? host.cwd;
	const previous = await previousPlan(params, { ...options, cwd, plan: remembered });
	if (previous) await api.memo("markdown.publication", previous, context);
	const saved = previous ? await savedPlan(options.store, previous) : undefined;
	if (saved) return publicationOutcome(saved, options.store.root, options.app);
	const agent = await api.agent(context);
	const local = { ...options, cwd, provenance: { ...options.provenance, session: host.storageId, conversation: String(api.conversationId), ...(agent.model ? { model: `${agent.model.provider}/${agent.model.modelId}` } : {}) } };
	const input = await preparePublication(params, local);
	const candidate = await options.store.preparePlan(input, { document: params.document, expectedRevision: params.expectedRevision, reuseKey: params.reuseKey });
	const plan = await api.memo("markdown.publication", previous ?? candidate, context);
	return await save(params, input, { ...local, plan });
}
function nativeResult(outcome: PublishOutcome) {
	return { output: [{ type: "text" as const, text: publicationText(outcome) }], structuredOutput: outcome, details: outcome, isError: !outcome.ok };
}
/** The earlier answer in the calling native conversation. */
async function nativePrevious(host: NativeHost, api: Pick<Durable.ToolExecutionApi, "conversationId" | "env">, context: Context): Promise<ResponseSnapshot> {
	const conversation = await host.harness?.conversation(api.conversationId, context);
	if (!conversation) throw new Error("The calling conversation is not readable.");
	return previousNative({ conversation, durable: host.durable, storageId: host.storageId ?? "", cwd: api.env?.cwd ?? host.cwd }, context);
}
