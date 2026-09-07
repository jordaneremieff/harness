import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BODY_BYTES = 1024 * 1024;
export const CATALOG_TARGETS = 128;
export type ResourceClass = "inventory" | "governance" | "entry";
export interface Resource {
	resourceClass: ResourceClass;
	resourceId: string;
	path: string;
}
export interface Catalog {
	resources: readonly Resource[];
}

/** Read a bounded regular file through one descriptor, without a body cache. */
export async function readBody(path: string, signal?: AbortSignal): Promise<Buffer> {
	signal?.throwIfAborted();
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > BODY_BYTES) throw new Error("source_unavailable");
		const buffer = Buffer.alloc(Math.min(BODY_BYTES + 1, stat.size + 1));
		let used = 0;
		while (used < buffer.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
			if (!bytesRead) break;
			used += bytesRead;
		}
		if (used > stat.size || used > BODY_BYTES) throw new Error("source_unavailable");
		return buffer.subarray(0, used);
	} finally {
		await file.close();
	}
}

export function decodeBody(body: Buffer): string {
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
}

/** The corpus ships beside the extension in one package, at ../../pillars from this module. */
export function defaultCorpusRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../pillars");
}

/** PI_PILLARS_CORPUS overrides the package-relative corpus root with an absolute path. */
export function corpusRoot(): string {
	const override = process.env.PI_PILLARS_CORPUS?.trim();
	if (override === undefined || override === "") return defaultCorpusRoot();
	if (!isAbsolute(override)) throw new Error("source_unavailable");
	return override;
}

export async function loadCatalog(signal?: AbortSignal): Promise<Catalog> {
	const root = await realpath(corpusRoot());
	const inventoryPath = await realpath(resolve(root, "README.md"));
	const governancePath = await realpath(resolve(root, "GOVERNANCE.md"));
	const inventory = await readBody(inventoryPath, signal);
	const governance = await readBody(governancePath, signal);
	if (inventory.length + governance.length > BODY_BYTES) throw new Error("source_unavailable");
	decodeBody(governance);
	const resources: Resource[] = [
		{ resourceClass: "inventory", resourceId: "inventory", path: inventoryPath },
		{ resourceClass: "governance", resourceId: "governance", path: governancePath },
	];
	const paths = new Set(resources.map((resource) => resource.path));
	const ids = new Set(resources.map((resource) => resource.resourceId));
	if (paths.size !== resources.length) throw new Error("source_unavailable");
	let visits = 0;
	for (const match of decodeBody(inventory).matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
		if (++visits > 256) throw new Error("source_unavailable");
		const target = match[1];
		if (target === "GOVERNANCE.md" || target.startsWith("#")) continue;
		if (!/^(?:principle|pattern|heuristic)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(target)) {
			throw new Error("source_unavailable");
		}
		const id = basename(target, ".md");
		if (id.length > 64 || ids.has(id) || resources.length === CATALOG_TARGETS) throw new Error("source_unavailable");
		const path = await realpath(resolve(root, target));
		if (dirname(path) !== root || paths.has(path)) throw new Error("source_unavailable");
		paths.add(path);
		ids.add(id);
		resources.push({ resourceClass: "entry", resourceId: id, path });
	}
	if (resources.length === 2) throw new Error("source_unavailable");
	return { resources: Object.freeze(resources.map((resource) => Object.freeze(resource))) };
}

export function resourceById(catalog: Catalog, id: unknown): Resource | undefined {
	return typeof id === "string" ? catalog.resources.find((resource) => resource.resourceId === id) : undefined;
}

export async function resourceByPath(catalog: Catalog, input: unknown, cwd: string): Promise<Resource | undefined> {
	if (typeof input !== "string" || Buffer.byteLength(input) > 4096 || input.includes("\0")) return undefined;
	let value = input.startsWith("@") ? input.slice(1) : input;
	if (value === "~" || value.startsWith("~/")) value = homedir() + value.slice(1);
	const path = resolve(cwd, value);
	const exact = catalog.resources.find((resource) => resource.path === path);
	if (exact) return exact;
	try {
		const canonical = await realpath(path);
		return catalog.resources.find((resource) => resource.path === canonical);
	} catch {
		return undefined;
	}
}
