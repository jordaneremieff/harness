import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	captureReferences,
	inspectReferences,
	type InspectionOptions,
	type InspectionResult,
	type KeptImages,
} from "./reference-capture.ts";
import {
	digest,
	LIMITS,
	MarkdownStore,
	StoreError,
	validateInput,
	type CapturedAsset,
	type ErrorCode,
	type ReferenceInventory,
	type StoredDocument,
	type WriteInput,
	type WriteResult,
} from "./store.ts";

export const EDITOR_WRITE_VERSION = 1;
export const EDITOR_REQUEST_BYTES = LIMITS.sourceBytes * 6 + LIMITS.recordBytes;
export type EditorBase = { document: string; revision: number; digest: string };
export type StagedImage = { reference: string; relativePath: string; digest: string; bytes: number };
export type EditorSave = {
	version: 1;
	operation: "save" | "reconcile";
	storeRoot: string;
	storeId: string;
	invocationId: string;
	generation: number;
	title: string;
	source: string;
	base?: EditorBase;
	derivation?: EditorBase;
	assetRoot?: string;
	stagedAssets?: StagedImage[];
};
export type EditorRequest = EditorSave | { version: 1; operation: "identity"; storeRoot: string };
export type EditorOutcome =
	| { version: 1; ok: true; status: "identity"; storeId: string }
	| {
			version: 1;
			ok: true;
			status: "saved";
			invocationId: string;
			generation: number;
			storeId: string;
			document: string;
			revision: number;
			digest: string;
			bytes: number;
			title: string;
			created: boolean;
			replayed: boolean;
			references: ReferenceInventory;
	  }
	| {
			version: 1;
			ok: true;
			status: "unconfirmed";
			invocationId: string;
			generation: number;
			storeId: string;
			recorded: boolean;
	  }
	| {
			version: 1;
			ok: false;
			invocationId?: string;
			generation?: number;
			storeId?: string;
			outcome: "not-committed" | "unknown";
			error: { code: ErrorCode; message: string; currentRevision?: number; currentDigest?: string };
	  };
export type EditorWriteOptions = InspectionOptions & {
	inspect?: (source: string) => Promise<InspectionResult>;
	store?: MarkdownStore;
};

function invalid(message: string): never {
	throw new StoreError("invalid", message);
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected an object.");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !fields.includes(key))) invalid("Unsupported request field.");
	return record;
}
function text(value: unknown, max: number, label: string): string {
	if (typeof value !== "string" || value.length > max || /[\ud800-\udfff]/u.test(value)) invalid(`Invalid ${label}.`);
	return value;
}
function absolutePath(value: unknown, label: string): string {
	const result = text(value, 4096, label);
	if (!isAbsolute(result) || /[\p{Cc}]/u.test(result)) invalid(`Use an absolute ${label} without control characters.`);
	return result;
}
function sha(value: unknown): string {
	if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) invalid("Invalid source or asset digest.");
	return value;
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
		invalid("Invalid integer field.");
	return value;
}
function base(value: unknown): EditorBase {
	const record = object(value, ["document", "revision", "digest"]);
	if (typeof record.document !== "string" || !/^md-[0-9a-f]{20}$/.test(record.document))
		invalid("Use an exact document identity.");
	return { document: record.document, revision: integer(record.revision, 1), digest: sha(record.digest) };
}
function image(value: unknown): StagedImage {
	const record = object(value, ["reference", "relativePath", "digest", "bytes"]);
	const reference = text(record.reference, 8192, "image reference");
	const relativePath = text(record.relativePath, 100, "staged image path");
	const imageDigest = sha(record.digest);
	if (
		!reference ||
		/[\p{Cc}]/u.test(reference) ||
		!/^assets\/[0-9a-f]{64}\.(png|jpg|gif|webp|svg)$/.test(relativePath) ||
		!relativePath.startsWith(`assets/${imageDigest.slice(7)}.`)
	)
		invalid("Invalid staged image identity.");
	return { reference, relativePath, digest: imageDigest, bytes: integer(record.bytes, 0, LIMITS.assetBytes) };
}
function assetInputs(request: Record<string, unknown>): Pick<EditorSave, "assetRoot" | "stagedAssets"> {
	const result: Pick<EditorSave, "assetRoot" | "stagedAssets"> = {};
	if (request.assetRoot !== undefined) result.assetRoot = absolutePath(request.assetRoot, "draft asset path");
	if (request.stagedAssets === undefined) return result;
	if (!Array.isArray(request.stagedAssets) || request.stagedAssets.length > LIMITS.assetCount)
		invalid("Too many staged images.");
	result.stagedAssets = request.stagedAssets.map(image);
	if (new Set(result.stagedAssets.map((item) => item.reference)).size !== result.stagedAssets.length)
		invalid("Duplicate staged image reference.");
	if (result.stagedAssets.reduce((sum, item) => sum + item.bytes, 0) > LIMITS.totalAssetBytes)
		invalid("Staged images exceed the total byte limit.");
	if (result.stagedAssets.length && !result.assetRoot) invalid("Staged images require the draft asset path.");
	return result;
}
/** An editor request contains data only. Executables, source roots and parser paths come from the installed helper. */
export function parseEditorRequest(value: unknown): EditorRequest {
	const request = object(value, [
		"version",
		"operation",
		"storeRoot",
		"storeId",
		"invocationId",
		"generation",
		"title",
		"source",
		"base",
		"derivation",
		"assetRoot",
		"stagedAssets",
	]);
	if (request.version !== EDITOR_WRITE_VERSION) invalid("Unsupported editor writer version.");
	const storeRoot = absolutePath(request.storeRoot, "store path");
	if (request.operation === "identity") {
		object(value, ["version", "operation", "storeRoot"]);
		return { version: 1, operation: "identity", storeRoot };
	}
	if (request.operation !== "save" && request.operation !== "reconcile") invalid("Unsupported editor operation.");
	if (typeof request.storeId !== "string" || !/^[0-9a-f]{32}$/.test(request.storeId))
		invalid("Use the exact selected store identity.");
	if (typeof request.invocationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.invocationId))
		invalid("Invalid save invocation identity.");
	const result: EditorSave = {
		version: 1,
		operation: request.operation,
		storeRoot,
		storeId: request.storeId,
		invocationId: request.invocationId,
		generation: integer(request.generation, 0),
		title: text(request.title, 400, "title"),
		source: text(request.source, LIMITS.sourceBytes, "source"),
	};
	validateInput({ title: result.title, source: result.source, contentOrigin: { kind: "editor", capturedAt: "" } });
	if (request.base !== undefined) result.base = base(request.base);
	if (request.derivation !== undefined) result.derivation = base(request.derivation);
	if (result.base && result.derivation) invalid("A save updates a base or derives a new copy, not both.");
	return Object.assign(result, assetInputs(request));
}
/** Fixed field order makes replay independent of JSON object ordering. Reconciliation names the same immutable save input. */
export function editorInvocationDigest(request: EditorSave): string {
	return digest(JSON.stringify({ ...request, operation: "save" }));
}
function outcome(request: EditorSave, result: WriteResult): EditorOutcome {
	const revision = result.revision;
	return {
		version: 1,
		ok: true,
		status: "saved",
		invocationId: request.invocationId,
		generation: request.generation,
		storeId: request.storeId,
		document: revision.document,
		revision: revision.revision,
		digest: revision.digest,
		bytes: revision.bytes,
		title: revision.title,
		created: result.created,
		replayed: result.replayed,
		references: revision.references,
	};
}
async function saved(
	store: MarkdownStore,
	request: EditorSave,
	inputDigest: string,
): Promise<EditorOutcome | undefined> {
	const plan = await store.reusePlan(`editor:${request.invocationId}`, inputDigest);
	if (plan) {
		try {
			const found = await store.get(plan.documentId, plan.revision);
			if (found.revision.publication === plan.publicationId)
				return outcome(request, { ...found, created: plan.revision === 1, replayed: true });
		} catch (error) {
			if (!(error instanceof StoreError) || error.code !== "not-found") throw error;
		}
	}
	return request.operation === "reconcile"
		? {
				version: 1,
				ok: true,
				status: "unconfirmed",
				invocationId: request.invocationId,
				generation: request.generation,
				storeId: request.storeId,
				recorded: plan !== undefined,
			}
		: undefined;
}
async function selectedBase(store: MarkdownStore, request: EditorSave): Promise<StoredDocument | undefined> {
	const selected = request.base ?? request.derivation;
	if (!selected) return undefined;
	const found = await store.get(selected.document, selected.revision);
	if (found.revision.digest !== selected.digest)
		throw new StoreError(
			"conflict",
			"The base digest does not match its revision.",
			found.document.revision,
			found.document.digest,
		);
	if (request.base && found.document.kind !== "published") invalid("Captured responses and files require Edit a Copy.");
	return found;
}
async function admittedImage(request: EditorSave, item: StagedImage): Promise<CapturedAsset> {
	const captured = await captureReferences(
		{ inspection: { version: 1, images: [item.relativePath], links: [], truncated: false } },
		request.assetRoot,
	);
	const asset = captured.assets[0];
	if (!asset?.data || asset.record.digest !== item.digest || asset.record.bytes !== item.bytes)
		throw new StoreError(
			"file-unreadable",
			"A staged image changed or is unavailable. Keep the draft and insert the image again.",
		);
	return { data: asset.data, record: { ...asset.record, reference: item.reference } };
}
function keptImages(store: MarkdownStore, request: EditorSave, previous?: StoredDocument): KeptImages {
	const staged = new Map((request.stagedAssets ?? []).map((item) => [item.reference, item]));
	const retained = new Map(
		(previous?.revision.references.items ?? [])
			.filter((item) => item.kind === "image" && item.state === "retained")
			.map((item) => [item.reference, item]),
	);
	return async (reference) => {
		const admitted = staged.get(reference);
		if (admitted) return admittedImage(request, admitted);
		const record = retained.get(reference);
		if (!record || !previous) return undefined;
		const data = await store.retainedAsset(previous.document.id, previous.revision.revision, record);
		return { record: { ...record }, data, keptFrom: previous.revision.revision };
	};
}
function failed(error: unknown, request?: EditorSave, commitStarted = false): EditorOutcome {
	const known = error instanceof StoreError;
	const noCommit =
		!request ||
		(known &&
			(["invalid", "too-large", "conflict", "replay-conflict", "file-unreadable"].includes(error.code) ||
				(!commitStarted && error.code === "not-found")));
	return {
		version: 1,
		ok: false,
		...(request
			? { invocationId: request.invocationId, generation: request.generation, storeId: request.storeId }
			: {}),
		outcome: noCommit ? "not-committed" : "unknown",
		error: known
			? {
					code: error.code,
					message: error.message.slice(0, 300),
					...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
					...(error.currentDigest === undefined ? {} : { currentDigest: error.currentDigest }),
				}
			: {
					code: "store-failure",
					message: "The editor store operation failed. Keep the draft and reconcile this save before a new save.",
				},
	};
}
/** One explicit commit or read-only reconciliation. It never reads private draft source files or starts a model host. */
export async function editorWrite(value: unknown, options: EditorWriteOptions = {}): Promise<EditorOutcome> {
	let saveRequest: EditorSave | undefined;
	let commitStarted = false;
	try {
		const request = parseEditorRequest(value);
		if (request.operation !== "identity") saveRequest = request;
		const store = options.store ?? new MarkdownStore(request.storeRoot);
		if (store.root !== request.storeRoot) invalid("The writer store differs from the selected store.");
		if (request.operation === "identity")
			return { version: 1, ok: true, status: "identity", storeId: (await store.initialise()).storeId };
		if ((await store.identity())?.storeId !== request.storeId)
			throw new StoreError(
				"store-failure",
				"The selected store identity changed or is unavailable. Keep the draft and select the store again.",
			);
		const inputDigest = editorInvocationDigest(request);
		const replay = await saved(store, request, inputDigest);
		if (replay) return replay;
		const previous = await selectedBase(store, request);
		const inspection = await (options.inspect
			? options.inspect(request.source)
			: inspectReferences(request.source, options));
		if ("failure" in inspection)
			throw new StoreError(
				"store-failure",
				`The reference parser is unavailable (${inspection.failure}). Keep the draft and repair the installed app.`,
			);
		const captured = await captureReferences(inspection, undefined, open, keptImages(store, request, previous));
		const derivedFrom = request.derivation
			? { storeId: request.storeId, ...request.derivation }
			: previous?.revision.contentOrigin.derivedFrom;
		const input: WriteInput = {
			title: request.title,
			source: request.source,
			contentOrigin: { kind: "editor", capturedAt: new Date().toISOString(), ...(derivedFrom ? { derivedFrom } : {}) },
			invocationDigest: inputDigest,
			...captured,
		};
		const writeOptions = { reuseKey: `editor:${request.invocationId}`, expectedStoreId: request.storeId };
		commitStarted = true;
		const result = request.base
			? await store.update(request.base.document, request.base.revision, input, writeOptions)
			: await store.create(input, writeOptions);
		return outcome(request, result);
	} catch (error) {
		return failed(error, saveRequest, commitStarted);
	}
}
