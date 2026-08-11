/**
 * stash format — artifact record shape, markdown serialization, frontmatter parsing.
 *
 * A stash artifact is a markdown file with a strict frontmatter header. The
 * frontmatter carries one JSON value per line (`key: <json>`) so both directions
 * are trivially correct with no YAML dependency. The body is prose written by
 * the agent; the frontmatter is what listing and filtering read.
 */

export const STASH_STATES = ["open", "active", "closed"] as const;
export type StashState = (typeof STASH_STATES)[number];

export function isStashState(value: unknown): value is StashState {
	return typeof value === "string" && (STASH_STATES as readonly string[]).includes(value);
}

export interface StashRecord {
	/** Stable id, also the filename stem: <utcTimestamp>-<slug>[-<collision>]. */
	id: string;
	title: string;
	/** UTC timestamp, compact ISO basic form (e.g. 20260724T115030Z). */
	created: string;
	project?: string;
	branch?: string;
	sessionId?: string;
	tags: string[];
	state: StashState;
	activatedAt?: string;
	closedAt?: string;
	outcome?: string;
	summary: string;
	decisions: string[];
	openLoops: string[];
	nextActions: string[];
	files: string[];
}

export interface StashMeta {
	id: string;
	title: string;
	created: string;
	project?: string;
	branch?: string;
	sessionId?: string;
	tags: string[];
	state: StashState;
	/**
	 * A lifecycle value that is present but is not a real state. The artifact is
	 * still listed so it cannot hide, but its state is UNKNOWN: every lifecycle
	 * transition rejects it, so no action may be offered as if it would work.
	 */
	invalidState?: string;
	activatedAt?: string;
	closedAt?: string;
	outcome?: string;
}

/**
 * Human-readable lifecycle label for listings and previews: the verified state,
 * or a marker when the state is unknown. `unread` covers artifacts whose header
 * could not be read (listing failures, unclosed headers); `invalidState` covers
 * a present-but-unrecognized lifecycle value. Neither may be presented as the
 * defaulted "open" fallback.
 */
export function stateLabel(meta: { state: string; invalidState?: string }, unread = false): string {
	if (meta.invalidState !== undefined) return `unknown (${meta.invalidState})`;
	if (unread) return "unknown";
	return meta.state;
}

const FRONTMATTER_KEYS = [
	"id",
	"title",
	"created",
	"project",
	"branch",
	"sessionId",
	"tags",
	"state",
	"activatedAt",
	"closedAt",
	"outcome",
] as const;

/** Slugify a title for use in ids/filenames: lowercase, [a-z0-9-], max 60 chars. */
export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug || "untitled";
}

/** Current UTC time as compact basic-ISO timestamp (sorts lexicographically). */
export function utcTimestamp(now: Date = new Date()): string {
	return now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}

/** Copy-pasteable terminal shorthand; `/stash get` injects the artifact before the agent turn starts. */
export function resumeCommand(id: string): string {
	return `pi "/stash get ${id}"`;
}

function section(heading: string, items: string[]): string[] {
	if (items.length === 0) return [];
	const lines = [`## ${heading}`, ""];
	for (const item of items) lines.push(`- ${item}`);
	lines.push("");
	return lines;
}

/** Serialize a full record to markdown with frontmatter. */
export function serializeArtifact(rec: StashRecord): string {
	const lines: string[] = ["---"];
	const meta: StashMeta = {
		id: rec.id,
		title: rec.title,
		created: rec.created,
		project: rec.project,
		branch: rec.branch,
		sessionId: rec.sessionId,
		tags: rec.tags,
		state: rec.state,
		activatedAt: rec.activatedAt,
		closedAt: rec.closedAt,
		outcome: rec.outcome,
	};
	for (const key of FRONTMATTER_KEYS) {
		const value = meta[key];
		if (value === undefined) continue;
		lines.push(`${key}: ${JSON.stringify(value)}`);
	}
	lines.push("---", "", `# ${rec.title}`, "", rec.summary, "");
	lines.push(...section("Decisions", rec.decisions));
	lines.push(...section("Open loops", rec.openLoops));
	lines.push(...section("Next actions", rec.nextActions));
	lines.push(...section("Files", rec.files));
	return `${lines.join("\n").trimEnd()}\n`;
}

interface ParsedArtifact {
	meta: Partial<StashMeta> & Record<string, unknown>;
	body: string;
}

/** Rewrite selected JSON-valued frontmatter keys while retaining unknown fields and the body. */
export function updateFrontmatter(md: string, patch: Record<string, unknown | undefined>): string {
	const lines = md.split("\n");
	let end = -1;
	if (lines[0]?.trim() === "---") {
		for (let index = 1; index < lines.length; index++) {
			if (lines[index].trim() === "---") {
				end = index;
				break;
			}
		}
	}
	const entries = Object.entries(patch);
	if (end === -1) {
		const header = entries
			.filter((entry): entry is [string, unknown] => entry[1] !== undefined)
			.map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
		if (header.length === 0) return md;
		return ["---", ...header, "---", "", md].join("\n");
	}

	const targets = new Map(entries);
	const emitted = new Set<string>();
	const header: string[] = [];
	for (const line of lines.slice(1, end)) {
		const separator = line.indexOf(":");
		const key = separator >= 0 ? line.slice(0, separator).trim() : "";
		if (!targets.has(key)) {
			header.push(line);
			continue;
		}
		if (emitted.has(key)) continue;
		emitted.add(key);
		const value = targets.get(key);
		if (value !== undefined) header.push(`${key}: ${JSON.stringify(value)}`);
	}
	for (const [key, value] of entries) {
		if (!emitted.has(key) && value !== undefined) header.push(`${key}: ${JSON.stringify(value)}`);
	}
	return [lines[0], ...header, lines[end], ...lines.slice(end + 1)].join("\n");
}

/**
 * Split a markdown document into frontmatter metadata and body.
 * Tolerant: a missing or malformed closing fence yields empty meta and the
 * whole input as body; unparseable values are kept as raw strings.
 */
export function parseFrontmatter(md: string): ParsedArtifact {
	const lines = md.split("\n");
	if (lines[0]?.trim() !== "---") return { meta: {}, body: md };
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) return { meta: {}, body: md };
	const meta: Record<string, unknown> = {};
	for (const line of lines.slice(1, end)) {
		const sep = line.indexOf(":");
		if (sep === -1) continue;
		const key = line.slice(0, sep).trim();
		const raw = line.slice(sep + 1).trim();
		if (!key) continue;
		try {
			meta[key] = JSON.parse(raw);
		} catch {
			meta[key] = raw;
		}
	}
	return { meta: meta as Partial<StashMeta> & Record<string, unknown>, body: lines.slice(end + 1).join("\n").trim() };
}
