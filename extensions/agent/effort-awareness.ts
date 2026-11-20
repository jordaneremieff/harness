import { matchesSchema } from "./schema-check.ts";
import { NativeIntentMetadataSchema } from "./effort-schema.ts";
import type { NativeIntentMetadata } from "./durable-controls.ts";
import { readRecentCollaboration, type RecentCollaborationPage } from "./collaboration-discovery.ts";
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
	let projection: EffortAwareness["self"] = {
		id: self.id,
		...location,
		...(cwdMode === "reported" ? { cwd: self.cwd } : {}),
		...observedPurposeFallback(self),
		...(self.intentClaim === undefined ? {} : { intentClaim: self.intentClaim }),
		...(self.omitted ? { omitted: true } : {}),
	};
	if (Buffer.byteLength(JSON.stringify(projection)) > EFFORT_AWARENESS_SELF_BYTES) {
		projection = {
			id: self.id.slice(0, 256),
			cwd: location.cwd.slice(0, 512),
			...(location.repository === undefined ? {} : { repository: location.repository.slice(0, 512) }),
			...(location.repositoryState === undefined ? {} : { repositoryState: location.repositoryState }),
			omitted: true,
		};
	}
	const presence = await readRelatedEfforts(resources, projection, scope);
	const contacts = [
		self.intentClaim?.contactThread,
		...presence.efforts.map((effort) => effort.intentClaim?.contactThread ?? effort.contactThreadClaim),
	];
	const priorities = [
		...contacts.filter((thread): thread is string => thread !== undefined).map((thread) => thread.split("/")[0]),
		self.id,
		...presence.efforts.filter((effort) => effort.liveness === "live").map((effort) => effort.id),
	];
	const threads = await readRecentCollaboration(resources.catalog, priorities, scope);
	return { self: projection, presence, threads };
}

function shortSelf(self: EffortAwareness["self"]): object {
	const origin = observedPurposeFallback(self).observedPurpose;
	return {
		id: self.id.slice(0, 64),
		cwd: self.cwd.slice(0, 64),
		...(self.intentClaim === undefined ? {} : { purposeClaim: self.intentClaim.purpose.slice(0, 128) }),
		...(origin === undefined ? {} : { observedPurpose: { source: origin.source, text: origin.text.slice(0, 128) } }),
		omitted: "Self detail shortened; read agent_status for the bounded published claim.",
	};
}
function shortEffort(effort: RelatedEffort): object {
	const purpose = effort.intentClaim?.purpose ?? effort.purposeClaim;
	const origin = observedPurposeFallback(effort).observedPurpose;
	return {
		id: effort.id,
		liveness: effort.liveness,
		relationship: effort.relationship,
		...(purpose === undefined ? {} : { purposeClaim: purpose.slice(0, 128) }),
		...(origin === undefined ? {} : { observedPurpose: { source: origin.source, text: origin.text.slice(0, 128) } }),
		sharedSubstrates: effort.sharedSubstrates,
		omitted: "Effort detail shortened; read agent_status for the bounded published claim.",
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
	return `No other live effort is shown. Outside project scope: ${p.outOfScope ?? 0} live efforts and ${t.outOfScope ?? 0} active thread hints in the covered sources. Presence ${p.complete ? "complete" : "partial"}: ${unknown} unknown, ${incompatible} incompatible, ${p.omitted} omitted, ${p.unreadable} unreadable, ${p.unsupported ?? 0} unsupported native producers. Active thread hints: ${view.threads.items.length}; coverage ${t.complete ? "complete" : "partial"}, ${t.omittedHints} source omissions, ${t.omittedResults} result omissions, ${t.missingHints} missing, ${t.unreadable} unreadable, unvisited ${t.unvisited ? "yes" : "no"}.${view.self.omitted ? " Own detail incomplete." : ""} Read agent_status for details.`;
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

/** The input is the project-scoped read. Scan evidence and active membership stay in explicit observations. */
function formatEffortSection(view: EffortAwareness): string {
	const pointer = "Read agent_status for current coverage, out-of-scope counts, and omitted sources.";
	const efforts = view.presence.efforts.filter(
		(effort) => effort.liveness === "live" && effort.relationship !== "machine",
	);
	if (efforts.length === 0 && view.threads.items.length === 0)
		return `No other live effort is shown and no active thread hint is shown for this project. ${pointer}`;
	const lines = [
		"Live efforts and active collaboration thread hints for this repository or working directory, ordered by identity.",
		"Declared intent is a claim, not a lock or a grant of authority. Use agent_collaborate read for the current thread frame.",
	];
	if (view.self.intentClaim)
		appendRow(lines, "Your effort", { id: view.self.id, intentClaim: promptClaim(view.self.intentClaim) }, 4 * 1024);
	for (const { id, cwd, name, intentClaim, observedPurpose } of efforts.sort((a, b) => a.id.localeCompare(b.id))) {
		const sessionName = name ?? (observedPurpose?.source === "session-name" ? observedPurpose.text : undefined);
		if (
			!appendRow(lines, "Related effort", { id, cwd, sessionName, intentClaim: promptClaim(intentClaim) }, 7 * 1024) &&
			!appendRow(lines, "Related effort", { id, intentOmitted: true }, 7 * 1024)
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
		"Machine-only efforts show purpose and contact claims, not full intent. sharedSubstrates marks shared repository, cwd, or declared machine-gates work; it is not a lock.",
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
