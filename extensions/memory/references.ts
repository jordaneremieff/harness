import { opendirSync } from "node:fs";
import { join } from "node:path";
import { addressableSlug, type Lifecycle, sourceLifecycle } from "./note-identity.ts";
import { completeBodyStart, memorySourceCache } from "./source-cache.ts";

const ENTRY_LIMIT = 4096;
const PREFIX_LIMIT = 128;
const SOURCE_LIMIT = 512;
const RESULT_LIMIT = 25;
const TIME_LIMIT_MS = 100;

const STALE_REFERENCE_GUIDANCE =
	"Before applying a claim about a superseded reference, read its replacement if named. Do not rely on a retired reference as current evidence.";

type ReferenceCoverage = { complete: boolean; entriesVisited: number; notesChecked: number };
type StaleReference = {
	slug: string;
	status: "retired" | "superseded";
	supersededBy: string | null;
};
export type AffectedReferences = {
	slugs: string[];
	notes: string[];
	count: number;
	coverage: ReferenceCoverage;
	guidance?: string;
};

function* mentionedSlugs(body: string): Iterable<string> {
	// A whole token may be a bare slug or a Markdown filename. Never resolve paths from source text.
	for (const match of body.matchAll(/[\p{L}\p{N}\p{M}_.-]+/gu)) {
		const token = match[0].replace(/\.+$/, "");
		const slug = addressableSlug(token.endsWith(".md") ? token : `${token}.md`);
		if (slug !== undefined) yield slug;
	}
}

/** Match exact directory spellings even when pathname lookup is case-insensitive. */
function* referenceEntries(root: string, coverage: ReferenceCoverage, signal?: AbortSignal) {
	if (signal?.aborted) {
		coverage.complete = false;
		return;
	}
	const deadline = performance.now() + TIME_LIMIT_MS;
	const stopped = () => signal?.aborted || performance.now() >= deadline;
	const directory = opendirSync(root);
	try {
		while (!stopped()) {
			const entry = directory.readSync();
			if (entry === null) return;
			if (stopped() || coverage.entriesVisited === ENTRY_LIMIT) break;
			coverage.entriesVisited++;
			if (entry.name.toLowerCase() === "readme.md") continue;
			const slug = addressableSlug(entry.name);
			if (slug !== undefined) yield { entry, slug };
		}
		coverage.complete = false;
	} finally {
		directory.closeSync();
	}
}

function probeReference<T>(probe: () => T): T | undefined {
	try {
		return probe();
	} catch {
		return undefined;
	}
}

function scanReferenceNotes<T>(
	root: string,
	select: (slug: string) => boolean,
	inspect: (file: string, slug: string) => T | null | undefined,
	noteLimit: number,
	signal?: AbortSignal,
): { coverage: ReferenceCoverage; count: number; matches: T[] } {
	const coverage = { complete: true, entriesVisited: 0, notesChecked: 0 };
	const matches: T[] = [];
	let count = 0;
	let attempts = 0;
	try {
		for (const { entry, slug } of referenceEntries(root, coverage, signal)) {
			if (!select(slug)) continue;
			if (!entry.isFile()) {
				coverage.complete = false;
				continue;
			}
			if (attempts === noteLimit) {
				coverage.complete = false;
				break;
			}
			attempts++;
			const match = probeReference(() => inspect(entry.name, slug));
			if (match === undefined) {
				coverage.complete = false;
				continue;
			}
			coverage.notesChecked++;
			if (match === null) continue;
			count++;
			if (matches.length < RESULT_LIMIT) matches.push(match);
		}
	} catch {
		coverage.complete = false;
	}
	return { coverage, count, matches };
}

export function scanStaleReferences(
	root: string,
	subject: string,
	body: string,
	readLifecycle: (file: string, slug: string) => Lifecycle | null | undefined,
	signal?: AbortSignal,
) {
	const mentioned = new Set(mentionedSlugs(body));
	mentioned.delete(subject);
	if (mentioned.size === 0) return {};
	const { matches, coverage, count } = scanReferenceNotes<StaleReference>(
		root,
		(slug) => mentioned.has(slug),
		(file, slug) => {
			const lifecycle = readLifecycle(file, slug);
			if (lifecycle === null) return null;
			if (lifecycle === undefined || lifecycle.status === "unknown") return undefined;
			if (lifecycle.status === "active") return null;
			return { slug, status: lifecycle.status, supersededBy: lifecycle.supersededBy };
		},
		PREFIX_LIMIT,
		signal,
	);
	matches.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
	return {
		...(matches.length > 0 ? { staleReferences: matches, staleReferenceGuidance: STALE_REFERENCE_GUIDANCE } : {}),
		...(!coverage.complete || count > matches.length ? { staleReferenceCoverage: { ...coverage, count } } : {}),
	};
}

function mentionsTarget(text: string, targets: ReadonlySet<string>): boolean {
	for (const mentioned of mentionedSlugs(text)) {
		if (targets.has(mentioned)) return true;
	}
	return false;
}

function affectedNote(root: string, file: string, slug: string, source: string, targets: ReadonlySet<string>) {
	const bodyStart = completeBodyStart(source);
	if (bodyStart === undefined) return mentionsTarget(source, targets) ? undefined : null;
	if (!mentionsTarget(source.slice(bodyStart), targets)) return null;
	const header = memorySourceCache.read(root, file, { text: source, truncated: false });
	const { status } = sourceLifecycle(header, slug);
	if (status === "unknown") return undefined;
	return status === "active" ? slug : null;
}

export function scanAffectedReferences(
	root: string,
	published: string[],
	readSource: (path: string) => string,
	signal?: AbortSignal,
): AffectedReferences {
	const targets = new Set(published);
	const { coverage, matches, count } = scanReferenceNotes<string>(
		root,
		(slug) => !targets.has(slug),
		(file, slug) => {
			const source = readSource(join(root, file));
			if (!published.some((target) => source.includes(target))) return null;
			return affectedNote(root, file, slug, source, targets);
		},
		SOURCE_LIMIT,
		signal,
	);
	return {
		slugs: [...targets].sort(),
		notes: matches.sort(),
		count,
		coverage,
		...(count > 0 || !coverage.complete
			? {
					guidance:
						"Review affected statements in this pass. If coverage is incomplete or the list is capped, check for other affected notes before assuming none remain.",
				}
			: {}),
	};
}
