import { boundedIssue, type ParsedMemoryHeader } from "./source-cache.ts";

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_SLUG_CHARS = 120;
const MAX_REPLACEMENT_HOPS = 16;

// Only names that source reads reproduce exactly are addressable.
export function addressableSlug(name: string): string | undefined {
	if (!name.endsWith(".md")) return undefined;
	const slug = name.slice(0, -3);
	if (slug === "README" || /\.md$/i.test(slug)) return undefined;
	if (!SLUG_PATTERN.test(slug) || slug.length > MAX_SLUG_CHARS) return undefined;
	return slug;
}

export type Lifecycle = {
	status: "active" | "superseded" | "retired" | "unknown";
	supersededBy: string | null;
	problem?: string;
};

export type LinkedSubject = { slug: string; header: ParsedMemoryHeader; lifecycle: Lifecycle };

export function predecessorSlugs(note: Pick<LinkedSubject, "slug" | "header">): Set<string> {
	const parsed = note.header.parsed;
	const slugs =
		note.header.metadata === "ok" && parsed && Object.hasOwn(parsed, "supersedes") ? parsed.supersedes : null;
	if (!Array.isArray(slugs)) return new Set();
	const result = new Set<string>();
	for (const slug of slugs) {
		if (
			typeof slug !== "string" ||
			slug.length > MAX_SLUG_CHARS ||
			!SLUG.test(slug) ||
			slug === "readme" ||
			slug === note.slug ||
			result.has(slug)
		)
			return new Set();
		result.add(slug);
	}
	return result;
}

/** Every hop must be reciprocal in the source headers available to the caller. */
export function verifiedReplacement<T extends LinkedSubject>(
	start: T,
	bySlug: Pick<ReadonlyMap<string, T>, "get">,
	links: Map<string, Set<string>>,
	endpoint: (note: T) => boolean = (note) => note.lifecycle.status === "active",
): T | undefined {
	let current = start;
	const seen = new Set([current.slug]);
	for (let hops = 0; hops < MAX_REPLACEMENT_HOPS && current.lifecycle.status === "superseded"; hops++) {
		const next = bySlug.get(current.lifecycle.supersededBy ?? "");
		if (!next || seen.has(next.slug)) return undefined;
		let reciprocal = links.get(next.slug);
		if (!reciprocal) {
			reciprocal = predecessorSlugs(next);
			links.set(next.slug, reciprocal);
		}
		if (!reciprocal.has(current.slug)) return undefined;
		if (endpoint(next)) return next;
		seen.add(next.slug);
		current = next;
	}
	return undefined;
}

function unreplacedLifecycle(header: ParsedMemoryHeader, status: "active" | "retired"): Lifecycle {
	if (!header.lines.has("superseded_by") || header.unusable.has("superseded_by") || header.supersededBy !== null) {
		const label = status === "retired" ? "Retired" : "Active";
		return {
			status: status === "retired" ? "retired" : "unknown",
			supersededBy: null,
			problem: boundedIssue(
				[header.issue, `${label} status requires an unambiguous superseded_by: null`].filter(Boolean).join("; "),
			),
		};
	}
	return { status, supersededBy: null, ...(header.issue ? { problem: header.issue } : {}) };
}

/** Read-only interpretation of the same bounded header used for discovery. */
export function sourceLifecycle(header: ParsedMemoryHeader, slug: string): Lifecycle {
	const unknown: Lifecycle = { status: "unknown", supersededBy: null };
	const problem = (message: string) => boundedIssue([header.issue, message].filter(Boolean).join("; "));
	if (header.metadata !== "ok" || !header.lines.has("status") || header.unusable.has("status"))
		return { ...unknown, problem: problem("Lifecycle status requires an unambiguous plain status key") };
	if (header.status !== "active" && header.status !== "superseded" && header.status !== "retired")
		return { ...unknown, problem: problem("Lifecycle status must be active or superseded or retired") };
	if (header.status !== "superseded") return unreplacedLifecycle(header, header.status);
	const usableReplacement = header.lines.has("superseded_by") && !header.unusable.has("superseded_by");
	const replacement = header.supersededBy;
	if (
		!usableReplacement ||
		typeof replacement !== "string" ||
		replacement.length > MAX_SLUG_CHARS ||
		!SLUG.test(replacement) ||
		replacement === "readme" ||
		replacement === slug
	)
		return {
			status: "superseded",
			supersededBy: null,
			problem: problem("Superseded source requires a different lowercase subject slug in superseded_by"),
		};
	return { status: "superseded", supersededBy: replacement, ...(header.issue ? { problem: header.issue } : {}) };
}
