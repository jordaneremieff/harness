/**
 * Inventory rows for the read-only Pillars browser. Each row quotes the canonical title and index
 * statement from the inventory source rather than generating a summary. Shared by the ordinary
 * view and the native route that answers the attached terminal.
 */

import type { AccessError, AccessPage, AccessRequest } from "./access.ts";
import type { Catalog } from "./catalog.ts";

export type SourceReader = (request: AccessRequest, signal?: AbortSignal) => Promise<AccessPage | AccessError>;

export interface BrowserEntry {
	resource: string;
	title: string;
	type: string;
	index: string;
}

/** Inventory rows quote the source index statements rather than generate summaries. */
export async function browserEntries(catalog: Catalog, read: SourceReader, signal?: AbortSignal): Promise<BrowserEntry[]> {
	let page = await read({ resource: "inventory" }, signal);
	if (page.schema !== "pillars-source") throw new Error(page.code);
	let text = page.text;
	while (page.nextOffset !== undefined) {
		page = await read({ resource: "inventory", offset: page.nextOffset, referenceBodyDigest: page.referenceBodyDigest }, signal);
		if (page.schema !== "pillars-source") throw new Error(page.code);
		text += page.text;
	}
	const rows = new Map<string, { title: string; index: string }>();
	for (const match of text.matchAll(/^\|\s*\[([^\]]+)\]\(([a-z0-9-]+)\.md\)\s*\|\s*(.*?)\s*\|\s*$/gm)) {
		rows.set(match[2], { title: match[1], index: match[3] });
	}
	return catalog.resources.map(({ resourceId: resource, resourceClass }) => ({
		resource,
		title: rows.get(resource)?.title ?? defaultTitle(resource, resourceClass),
		type: resourceClass === "entry" ? resource.split("-")[0] : resourceClass,
		index: rows.get(resource)?.index ?? "",
	}));
}

function defaultTitle(resource: string, resourceClass: string): string {
	if (resourceClass === "inventory") return "Pillars";
	if (resourceClass === "governance") return "Pillars Governance";
	return resource;
}
