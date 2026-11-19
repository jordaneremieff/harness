import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
	digest,
	LIMITS,
	StoreError,
	type AssetRecord,
	type CapturedAsset,
	type InspectionFailure,
	type ReferenceInventory,
} from "./store.ts";

export type ReferenceRunner = (tool: string, source: string) => Promise<string>;
export type InspectionOptions = { app?: string; runner?: ReferenceRunner; toolPath?: string };
export type ReferenceInspection = { version: 1; images: string[]; links: string[]; truncated: boolean };
export type InspectionResult = { inspection: ReferenceInspection } | { failure: InspectionFailure };
class InspectionError extends Error {
	readonly reason: InspectionFailure;
	constructor(reason: InspectionFailure, message: string) {
		super(message);
		this.reason = reason;
	}
}

type FileIdentity = { ino: bigint; dev: bigint };
export async function boundedFile(
	path: string,
	max: number,
	noFollow = false,
	opener: typeof open = open,
): Promise<{ data: Buffer; identity: FileIdentity }> {
	const handle = await opener(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
	try {
		const info = await handle.stat({ bigint: true });
		if (!info.isFile()) throw new StoreError("file-unreadable", "Source must be a regular file.");
		if (info.size > max) throw new StoreError("too-large", "File exceeds the byte limit.");
		const data = Buffer.alloc(max + 1);
		let length = 0;
		while (length < data.length) {
			const { bytesRead } = await handle.read(data, length, data.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > max) throw new StoreError("too-large", "File exceeds the byte limit.");
		return { data: data.subarray(0, length), identity: { dev: info.dev, ino: info.ino } };
	} finally {
		await handle.close();
	}
}
const INSPECTION_OUTPUT_BYTES = 4 * 1024 * 1024;
function runReferences(tool: string, source: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(tool, ["references"], { stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let bytes = 0;
		let stderrBytes = 0;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new InspectionError("tool-timeout", "Reference tool timed out"));
		}, 10000);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > INSPECTION_OUTPUT_BYTES) {
				child.kill("SIGKILL");
				reject(new InspectionError("output-invalid", "Reference output exceeded limit"));
			} else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > 4096) {
				child.kill("SIGKILL");
				reject(new InspectionError("tool-failed", "Reference diagnostics exceeded limit"));
			}
		});
		child.stdin.on("error", () => {});
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(
				new InspectionError(
					error.code === "ENOENT" || error.code === "EACCES" ? "app-incompatible" : "tool-failed",
					"Reference tool did not start",
				),
			);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) reject(new InspectionError("tool-failed", "Reference tool failed"));
			else resolve(Buffer.concat(chunks).toString("utf8"));
		});
		child.stdin.end(source);
	});
}
function stringList(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 4096 &&
		value.every((item) => typeof item === "string" && !/[\ud800-\udfff]/u.test(item)) &&
		new Set(value).size === value.length
	);
}
/** Runs the installed app's headless reference tool; a failure names its cause instead of an inventory. */
export async function inspectReferences(source: string, options: InspectionOptions): Promise<InspectionResult> {
	if (Buffer.byteLength(source) > LIMITS.sourceBytes) throw new StoreError("too-large", "Source exceeds 2 MiB.");
	const tool = options.toolPath ?? (options.app ? join(options.app, "Contents/MacOS/markdown-core") : undefined);
	if (!tool) return { failure: "app-missing" };
	const failure = await buildFailure(options.app ?? resolve(dirname(tool), "../.."));
	if (failure) return { failure };
	try {
		return parseInventory(await (options.runner ?? runReferences)(tool, source));
	} catch (error) {
		return { failure: error instanceof InspectionError ? error.reason : "tool-failed" };
	}
}
async function buildFailure(app: string): Promise<InspectionFailure | undefined> {
	let build: { contract?: unknown } | null;
	try {
		build = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				(await boundedFile(join(app, "Contents/Resources/build.json"), 16384)).data,
			),
		);
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "app-missing" : "app-incompatible";
	}
	return build?.contract === 1 ? undefined : "app-incompatible";
}
function parseInventory(result: string): InspectionResult {
	try {
		if (Buffer.byteLength(result) > INSPECTION_OUTPUT_BYTES) return { failure: "output-invalid" };
		const value: unknown = JSON.parse(result);
		const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
		if (
			record.version !== 1 ||
			!stringList(record.images) ||
			!stringList(record.links) ||
			typeof record.truncated !== "boolean"
		)
			return { failure: "output-invalid" };
		return { inspection: { version: 1, images: record.images, links: record.links, truncated: record.truncated } };
	} catch {
		return { failure: "output-invalid" };
	}
}
const MEDIA: Record<string, [string, string]> = {
	".png": ["image/png", "png"],
	".jpg": ["image/jpeg", "jpg"],
	".jpeg": ["image/jpeg", "jpg"],
	".gif": ["image/gif", "gif"],
	".webp": ["image/webp", "webp"],
	".svg": ["image/svg+xml", "svg"],
};
function unavailable(reference: string, reason: AssetRecord["reason"]): CapturedAsset {
	return { record: { kind: "image", reference, state: "unavailable", reason } };
}
function inside(root: string, path: string): boolean {
	const part = relative(root, path);
	return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
}
function classifyImage(reference: string): CapturedAsset | undefined {
	if (/^(https?:|\/\/)/i.test(reference)) return { record: { kind: "image", reference, state: "external" } };
	if (/^data:/i.test(reference))
		return { record: { kind: "image", reference: [...reference].slice(0, 64).join(""), state: "embedded" } };
	if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) return unavailable(reference, "unsupported-scheme");
	if (isAbsolute(reference)) return unavailable(reference, "outside-root");
	return undefined;
}
function sameAsset(
	path: string,
	afterPath: string,
	root: string,
	before: FileIdentity,
	after: FileIdentity,
	opened: FileIdentity,
): boolean {
	return (
		path === afterPath &&
		inside(root, afterPath) &&
		before.ino === after.ino &&
		before.dev === after.dev &&
		opened.ino === before.ino &&
		opened.dev === before.dev
	);
}
async function captureImage(reference: string, root: string | undefined, opener: typeof open): Promise<CapturedAsset> {
	const classified = classifyImage(reference);
	if (classified) return classified;
	let decoded: string;
	try {
		decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0] ?? "");
	} catch {
		return unavailable(reference, "invalid");
	}
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
		const before = await stat(path, { bigint: true });
		const { data, identity } = await boundedFile(path, LIMITS.assetBytes, true, opener);
		const afterPath = await realpath(candidate);
		const after = await stat(afterPath, { bigint: true });
		if (!sameAsset(path, afterPath, root, before, after, identity)) return unavailable(reference, "outside-root");
		const assetDigest = digest(data);
		return {
			data,
			record: {
				kind: "image",
				reference,
				state: "retained",
				file: `assets/${assetDigest.slice(7)}.${media[1]}`,
				mediaType: media[0],
				bytes: data.length,
				digest: assetDigest,
			},
		};
	} catch (error) {
		return unavailable(reference, error instanceof StoreError && error.code === "too-large" ? "too-large" : "missing");
	}
}
/** Metadata keeps at most the first 512 characters of a reference; the exact source keeps the whole destination. */
const REFERENCE_CHARS = 512;
function shortReference(reference: string): string {
	const characters = [...reference];
	return characters.length > REFERENCE_CHARS ? characters.slice(0, REFERENCE_CHARS).join("") : reference;
}
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
/** Retained images of an earlier revision by whole reference, read on demand. */
export type KeptImages = (reference: string) => Promise<CapturedAsset | undefined>;
export async function captureReferences(
	result: InspectionResult,
	root?: string,
	opener: typeof open = open,
	kept?: KeptImages,
): Promise<{ references: ReferenceInventory; assets: CapturedAsset[] }> {
	if ("failure" in result)
		return {
			references: { state: "uninspected", truncated: false, omitted: 0, items: [], reason: result.failure },
			assets: [],
		};
	const { inspection } = result;
	const canonicalRoot = root === undefined ? undefined : await realpath(root);
	const destinations = [
		...inspection.images.map((reference) => ({ kind: "image" as const, reference })),
		...inspection.links.filter(localLink).map((reference) => ({ kind: "link" as const, reference })),
	];
	const references: ReferenceInventory = {
		state: "inspected",
		truncated: inspection.truncated,
		omitted: Math.max(0, destinations.length - 256),
		items: [],
	};
	const images = new Set(inspection.images);
	const assets: CapturedAsset[] = [];
	let total = 0;
	const image = async (reference: string) =>
		(canonicalRoot === undefined ? await kept?.(reference) : undefined) ??
		(await captureImage(reference, canonicalRoot, opener));
	for (const destination of destinations.slice(0, 256)) {
		if (destination.kind === "link") {
			references.items.push({ ...destination, reference: shortReference(destination.reference), state: "local-only" });
			continue;
		}
		let asset = await image(destination.reference);
		if (asset.data && (assets.length >= LIMITS.assetCount || total + asset.data.length > LIMITS.totalAssetBytes))
			asset = unavailable(destination.reference, "limit");
		if (asset.data) {
			total += asset.data.length;
			assets.push(asset);
		}
		const record = imageRecord(asset.record, destination.reference, images);
		if (record) references.items.push(record);
		else references.omitted++;
	}
	return { references, assets };
}
