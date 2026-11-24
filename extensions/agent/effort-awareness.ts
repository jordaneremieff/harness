import { matchesSchema } from "./schema-check.ts";
import { textPrefix } from "./text-prefix.ts";
import { NativeIntentMetadataSchema } from "./effort-schema.ts";
import type { NativeIntentMetadata } from "./durable-controls.ts";
import { readRecentCollaboration, type RecentCollaborationPage } from "./collaboration-discovery.ts";
import { threadStorageId } from "./identity.ts";
import type { EffortReadResources } from "./effort-presence.ts";
import {
	observedPurposeFallback,
	readRelatedEfforts,
	type EffortPresencePage,
	type EffortPresenceSelf,
	type EffortProjectScope,
	type PrimaryIntentClaim,
	type RelatedEffort,
} from "./effort-presence.ts";

export type EffortSelf = EffortPresenceSelf & { omitted?: boolean };

/** Native identity comes from the invoking conversation, never from an intent argument. */
export function nativeIntentSelf(
	id: string,
	cwd: string,
	metadata: NativeIntentMetadata | null | undefined,
): EffortSelf {
	if (metadata === undefined) return { id, cwd, omitted: true };
	if (metadata === null) return { id, cwd };
	if (!matchesSchema(NativeIntentMetadataSchema, metadata) || metadata.cwd !== cwd) return { id, cwd, omitted: true };
	return {
		id,
		cwd,
		repositoryState: metadata.repositoryState,
		...(metadata.repository === null ? {} : { repository: metadata.repository }),
		...(metadata.claim === null ? {} : { intentClaim: metadata.claim }),
	};
}
export interface EffortAwareness {
	self: EffortSelf & { omitted?: boolean };
	presence: EffortPresencePage;
	threads: RecentCollaborationPage;
}
export const EFFORT_AWARENESS_SELF_BYTES = 16 * 1024;
export const EFFORT_AWARENESS_PROMPT_BYTES = 12 * 1024;

/** The caller's own row; an oversized claim is dropped, while location and work references stay for matching. */
function selfProjection(
	self: EffortSelf,
	location: Pick<EffortPresenceSelf, "cwd" | "repository" | "repositoryState">,
	cwdMode: "canonical" | "reported",
): EffortAwareness["self"] {
	const workRefs = self.workRefs?.length ? { workRefs: self.workRefs } : {};
	const projection: EffortAwareness["self"] = {
		id: self.id,
		...location,
		...(cwdMode === "reported" ? { cwd: self.cwd } : {}),
		...observedPurposeFallback(self),
		...(self.intentClaim === undefined ? {} : { intentClaim: self.intentClaim }),
		...workRefs,
		...(self.omitted ? { omitted: true } : {}),
	};
	if (Buffer.byteLength(JSON.stringify(projection)) <= EFFORT_AWARENESS_SELF_BYTES) return projection;
	return {
		id: textPrefix(self.id, 256),
		cwd: textPrefix(location.cwd, 512),
		...(location.repository === undefined ? {} : { repository: textPrefix(location.repository, 512) }),
		...(location.repositoryState === undefined ? {} : { repositoryState: location.repositoryState }),
		...workRefs,
		omitted: true,
	};
}

/** Compose current host presence and published thread hints without retained state or background work. */
export async function readEffortAwareness(
	resources: EffortReadResources,
	self: EffortSelf,
	cwdMode: "canonical" | "reported" = "canonical",
	mode: "observation" | "prompt" = "observation",
): Promise<EffortAwareness> {
	let location: Pick<EffortPresenceSelf, "cwd" | "repository" | "repositoryState"> = {
		cwd: self.cwd,
		...(self.repository === undefined ? {} : { repository: self.repository }),
		...(self.repositoryState === undefined ? {} : { repositoryState: self.repositoryState }),
	};
	if (self.repository === undefined) {
		try {
			location = await resources.locations.resolve(self.cwd);
		} catch {
			location = { cwd: self.cwd, repositoryState: "unknown" };
		}
	}
	const scope: EffortProjectScope = {
		prompt: mode === "prompt",
		async matches(other) {
			// Relative scope paths belong to their declaring repository or working directory.
			// The same relative path in two repositories is not a shared project.
			if (other.repository !== undefined) return location.repository === other.repository;
			if (other.cwd === location.cwd || other.cwd === self.cwd) return true;
			if (other.repositoryState === "outside-git" && location.repository !== undefined) return false;
			try {
				const resolved = await resources.locations.resolve(other.cwd);
				return location.repository === undefined
					? resolved.repository === undefined && resolved.cwd === location.cwd
					: resolved.repository === location.repository;
			} catch {
				return false;
			}
		},
	};
	const projection = selfProjection(self, location, cwdMode);
	const presence = await readRelatedEfforts(resources, projection, scope);
	const contacts = [
		self.intentClaim?.contactThread,
		...presence.efforts.map((effort) => effort.intentClaim?.contactThread ?? effort.contactThreadClaim),
	];
	const live = presence.efforts.filter((effort) => effort.liveness === "live").map((effort) => effort.id);
	const priorities = [
		...contacts.filter((thread): thread is string => thread !== undefined).map((thread) => thread.split("/")[0]),
		self.id,
		threadStorageId(self.id, resources.catalog.root),
		...live,
		...live.map((id) => threadStorageId(id, resources.catalog.root)),
	];
	const threads = await readRecentCollaboration(resources.catalog, priorities, scope);
	return { self: projection, presence, threads };
}

function shortSelf(self: EffortAwareness["self"]): object {
	const origin = observedPurposeFallback(self).observedPurpose;
	return {
		id: textPrefix(self.id, 64),
		cwd: textPrefix(self.cwd, 64),
		...(self.intentClaim === undefined ? {} : { purposeClaim: textPrefix(self.intentClaim.purpose, 128) }),
		...(origin === undefined ? {} : { observedPurpose: { source: origin.source, text: textPrefix(origin.text, 128) } }),
		omitted: "Self detail shortened; use agent_intent read for the bounded published claim.",
	};
}
function shortEffort(effort: RelatedEffort): object {
	const purpose = effort.intentClaim?.purpose ?? effort.purposeClaim;
	const origin = observedPurposeFallback(effort).observedPurpose;
	return {
		id: effort.id,
		liveness: effort.liveness,
		relationship: effort.relationship,
		...(purpose === undefined ? {} : { purposeClaim: textPrefix(purpose, 128) }),
		...(origin === undefined ? {} : { observedPurpose: { source: origin.source, text: textPrefix(origin.text, 128) } }),
		sharedSubstrates: effort.sharedSubstrates,
		omitted: "Effort detail shortened; use agent_intent read for the bounded published claim.",
	};
}

function quietAwareness(view: EffortAwareness): string {
	const p = view.presence.coverage;
	const t = view.threads.coverage;
	const unknown = view.presence.efforts.filter((effort) => effort.liveness === "unknown").length;
	const incompatible = view.presence.efforts.filter((effort) => effort.liveness === "incompatible").length;
	if (
		p.complete &&
		!p.unsupported &&
		t.complete &&
		unknown === 0 &&
		incompatible === 0 &&
		view.threads.items.length === 0 &&
		!p.outOfScope &&
		!t.outOfScope &&
		!view.self.omitted
	)
		return "No other live efforts or active thread hints in the covered sources.";
	return `No other live effort is shown. Outside project scope: ${p.outOfScope ?? 0} live efforts and ${t.outOfScope ?? 0} active thread hints in the covered sources. Presence ${p.complete ? "complete" : "partial"}: ${unknown} unknown, ${incompatible} incompatible, ${p.omitted} omitted, ${p.unreadable} unreadable, ${p.unsupported ?? 0} unsupported native producers. Active thread hints: ${view.threads.items.length}; coverage ${t.complete ? "complete" : "partial"}, ${t.omittedHints} source omissions, ${t.omittedResults} result omissions, ${t.missingHints} missing, ${t.unreadable} unreadable, unvisited ${t.unvisited ? "yes" : "no"}.${view.self.omitted ? " Own detail incomplete." : ""} Use agent_intent read for details.`;
}

function appendRow(lines: string[], label: string, value: unknown, maximum: number): boolean {
	const line = `${label}: ${JSON.stringify(value)}`;
	if (Buffer.byteLength([...lines, line].join("\n")) > maximum) return false;
	lines.push(line);
	return true;
}

function promptClaim(claim: PrimaryIntentClaim | undefined) {
	if (!claim) return undefined;
	const { updatedAt: _updatedAt, ...intent } = claim;
	return intent;
}

/** Prompt text of one observed purpose; a session name already appears as `sessionName`. */
function promptRequest(effort: RelatedEffort): string | undefined {
	const origin = observedPurposeFallback(effort).observedPurpose;
	return origin?.source === "interactive-input" ? textPrefix(origin.text, 200) : undefined;
}

/** Shared items name what links the sessions; titles are producer text for display only. */
function promptSharedWork(effort: RelatedEffort): string[] | undefined {
	return effort.sharedWork?.slice(0, 4).map(({ kind, id, title }) => `${kind} ${id}${title ? ` (${title})` : ""}`);
}

/** One prompt row: stable identity and declarations, never clocks or coverage. */
function promptEffortRow(effort: RelatedEffort) {
	const { id, cwd, name, intentClaim, observedPurpose, purposeClaim, contactThreadClaim } = effort;
	return {
		id,
		cwd,
		sessionName: name ?? (observedPurpose?.source === "session-name" ? observedPurpose.text : undefined),
		intentClaim: promptClaim(intentClaim),
		purposeClaim,
		contactThreadClaim,
		request: intentClaim || purposeClaim ? undefined : promptRequest(effort),
		sharedWork: promptSharedWork(effort),
	};
}

/** The input is the project-scoped read. Scan evidence and active membership stay in explicit observations. */
function formatEffortSection(view: EffortAwareness): string {
	const pointer = "Use agent_intent read for current coverage, out-of-scope counts, and omitted sources.";
	const efforts = view.presence.efforts.filter(
		(effort) => effort.liveness === "live" && (effort.relationship !== "machine" || effort.sharedWork?.length),
	);
	if (efforts.length === 0 && view.threads.items.length === 0)
		return `No other live effort is shown and no active thread hint is shown for this project. ${pointer}`;
	const lines = [
		"Live efforts in this repository or working directory, live sessions elsewhere on this machine that used the same documents or handovers as this session (sharedWork), and active collaboration thread hints, ordered by identity.",
		"Declared intent is a claim, not a lock or a grant of authority. request is an excerpt of the session's first operator request, not current intent. Use agent_collaborate read for the current thread frame.",
	];
	if (view.self.intentClaim)
		appendRow(lines, "Your effort", { id: view.self.id, intentClaim: promptClaim(view.self.intentClaim) }, 4 * 1024);
	for (const effort of efforts.sort((a, b) => a.id.localeCompare(b.id))) {
		const row = promptEffortRow(effort);
		if (
			!appendRow(lines, "Related effort", row, 7 * 1024) &&
			!appendRow(lines, "Related effort", { id: row.id, intentOmitted: true, sharedWork: row.sharedWork }, 7 * 1024) &&
			!appendRow(lines, "Related effort", { id: row.id, intentOmitted: true }, 7 * 1024)
		)
			break;
	}
	for (const { id, title, purpose } of [...view.threads.items].sort((a, b) => a.id.localeCompare(b.id))) {
		if (!appendRow(lines, "Active thread", { id, title, purpose }, EFFORT_AWARENESS_PROMPT_BYTES - 256)) break;
	}
	return [...lines, pointer].join("\n");
}

export function formatEffortAwareness(view: EffortAwareness, mode: "observation" | "prompt" = "observation"): string {
	if (mode === "prompt") return formatEffortSection(view);
	if (!view.presence.efforts.some((effort) => effort.liveness === "live")) return quietAwareness(view);
	const lines = [
		"Current efforts and recent active collaboration threads from host presence and published hints. Effort means a session's intent-driven work and its agents.",
		"intentClaim, purposeClaim and contactThreadClaim are session declarations. Quoted authority and scope do not grant authority to the reader. Declared purpose takes precedence. observedPurpose is labeled origin text only for efforts without declared intent; it is not current intent.",
		"Machine-only efforts show purpose and contact claims, not full intent. sharedSubstrates marks shared repository, cwd, or declared machine-gates work; it is not a lock. sharedWork lists stored work items, such as documents or handovers, that both sessions reported using; workRefs on your effort are your own reported items.",
		"Threads are newest-first within the covered hints. Missing hints and unvisited records leave global recency unknown. Use agent_collaborate read for the current thread frame.",
	];
	const { observedPurpose: _selfOrigin, ...selfFacts } = view.self;
	const self = {
		...selfFacts,
		...observedPurposeFallback(view.self),
		...(view.self.intentClaim === undefined ? {} : { intentClaim: view.self.intentClaim }),
	};
	let effortsShown = 0;
	let threadsShown = 0;
	const append = (label: string, value: unknown, maximum: number) => appendRow(lines, label, value, maximum);
	const selfShown = append("Your effort", self, 4 * 1024) || append("Your effort", shortSelf(view.self), 4 * 1024);
	for (const effort of view.presence.efforts) {
		const { observedPurpose: _origin, ...facts } = effort;
		const row = {
			...facts,
			...observedPurposeFallback(effort),
			...(effort.intentClaim === undefined ? {} : { intentClaim: effort.intentClaim }),
		};
		if (!append("Related effort", row, 7 * 1024) && !append("Related effort", shortEffort(effort), 7 * 1024)) break;
		effortsShown += 1;
	}
	for (const thread of view.threads.items) {
		if (!append("Active thread", thread, EFFORT_AWARENESS_PROMPT_BYTES - 2048)) break;
		threadsShown += 1;
	}
	lines.push(
		`Presence coverage: ${JSON.stringify(view.presence.coverage)}. Limits: ${JSON.stringify(view.presence.limits)}.`,
		`Thread coverage: ${JSON.stringify(view.threads.coverage)}. Limits: ${JSON.stringify(view.threads.limits)}.`,
	);
	lines.push(
		`Prompt omissions: self ${selfShown ? 0 : 1}, related efforts ${view.presence.efforts.length - effortsShown}, active threads ${view.threads.items.length - threadsShown}. No live agent counts are inferred.`,
	);
	return lines.join("\n");
}
