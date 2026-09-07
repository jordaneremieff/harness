/**
 * Resource record model for the session lookup.
 *
 * Records are projections of Pi-owned registration entries. This module builds
 * nothing that Pi does not already register: tools come from the tool registry,
 * commands/skills/prompts come from the slash-command registry, and skill
 * metadata that only the system-prompt inputs carry comes from a prior
 * observation. Every `sourceInfo` field survives the projection unchanged.
 */

import type { SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";

export const RESOURCE_KINDS = ["tool", "command", "skill", "prompt"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Where a field's value came from. Never inferred from an unrelated path. */
export type Evidence = "registration" | "observation" | "file_content";

export const SKILL_COMMAND_PREFIX = "skill:";

/** Selected system-prompt inputs copied by the observer, never the event object. */
export interface ObservedSkill {
	name: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation: boolean;
	sourceInfo: SourceInfo;
}

export interface ObservationSnapshot {
	observedAt: number;
	cwd: string;
	skills: ObservedSkill[];
	selectedTools: string[];
	contextFilePaths: string[];
	customPromptPresent: boolean;
	appendSystemPromptPresent: boolean;
	recordCount: number;
	bytes: number;
	overflowRecords: boolean;
	overflowBytes: boolean;
}

/** Tri-state for a fact the tool can only know from an observation or a file read. */
export interface Attested<T> {
	value: T;
	evidence: Evidence;
	at: number;
}

export interface ResourceRecord {
	kind: ResourceKind;
	/** Exact case-sensitive resource name. For a skill this is the bare name. */
	name: string;
	/** Pi's invocation form, for example `/skill:pillars`. Absent for tools. */
	invocation?: string;
	description?: string;
	sourceInfo: SourceInfo;
	/** How this record itself was learned. */
	evidence: Evidence;
	at: number;
	/** Set on tools: the tool is configured in this session. */
	configured?: boolean;
	parameters?: ToolInfo["parameters"];
	promptGuidelines?: string[];
	/** Set on tools: the tool is in the active set right now. */
	active?: boolean;
	/** Set on skills when a prior observation or a file read established it. */
	modelInvocable?: Attested<boolean>;
	/** Set on skills from a prior observation. */
	baseDir?: Attested<string>;
	/** Set when an observation carries this skill name from a different source. */
	observationIdentityMismatch?: boolean;
}

/**
 * Identity of a skill for joining a registration record to an observation.
 *
 * A bare name is not an identity: the same name can be re-registered from a
 * different file or scope, and applying the old record's hidden-invocation flag
 * to it would report stale evidence as current.
 */
export function skillIdentity(name: string, source: SourceInfo): string {
	return JSON.stringify([name, source.source, source.path, source.scope, source.origin, source.baseDir ?? null]);
}

/** A Pi surface the tool needs; absence is reported, never treated as emptiness. */
export interface SurfaceAvailability {
	tools: boolean;
	activeTools: boolean;
	commands: boolean;
}

export interface HostSnapshot {
	tools: Array<{ name: string; description?: string; sourceInfo: SourceInfo; parameters?: ToolInfo["parameters"]; promptGuidelines?: string[] }>; 
	activeTools: string[];
	commands: Array<{
		name: string;
		description?: string;
		source: "extension" | "prompt" | "skill";
		sourceInfo: SourceInfo;
	}>;
	observation: ObservationSnapshot | null;
	availability: SurfaceAvailability;
	at: number;
}

const KIND_RANK: Record<ResourceKind, number> = { tool: 0, command: 1, skill: 2, prompt: 3 };

/** Deterministic ordinal order: kind, then name, then source fields. */
export function compareRecords(a: ResourceRecord, b: ResourceRecord): number {
	if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
	if (a.name !== b.name) return a.name < b.name ? -1 : 1;
	if (a.sourceInfo.source !== b.sourceInfo.source) return a.sourceInfo.source < b.sourceInfo.source ? -1 : 1;
	if (a.sourceInfo.path !== b.sourceInfo.path) return a.sourceInfo.path < b.sourceInfo.path ? -1 : 1;
	if (a.sourceInfo.scope !== b.sourceInfo.scope) return a.sourceInfo.scope < b.sourceInfo.scope ? -1 : 1;
	if (a.sourceInfo.origin !== b.sourceInfo.origin) return a.sourceInfo.origin < b.sourceInfo.origin ? -1 : 1;
	const aBase = a.sourceInfo.baseDir ?? "";
	const bBase = b.sourceInfo.baseDir ?? "";
	if (aBase !== bBase) return aBase < bBase ? -1 : 1;
	return 0;
}

function kindOfCommand(source: "extension" | "prompt" | "skill"): ResourceKind {
	return source === "extension" ? "command" : source === "prompt" ? "prompt" : "skill";
}

/**
 * Project the host snapshot into ordered records.
 *
 * A tool record always states configured presence; `active` is only set when the
 * active-tool surface answered, so an unavailable surface cannot read as inactive.
 */
export function buildRecords(snapshot: HostSnapshot): ResourceRecord[] {
	const records: ResourceRecord[] = [];
	const activeSet = new Set(snapshot.activeTools);

	if (snapshot.availability.tools) {
		for (const tool of snapshot.tools) {
			const record: ResourceRecord = {
				kind: "tool",
				name: tool.name,
				sourceInfo: tool.sourceInfo,
				evidence: "registration",
				at: snapshot.at,
				configured: true,
			};
			if (tool.description !== undefined) record.description = tool.description;
			if (tool.parameters !== undefined) record.parameters = tool.parameters;
			if (tool.promptGuidelines !== undefined) record.promptGuidelines = [...tool.promptGuidelines];
			if (snapshot.availability.activeTools) record.active = activeSet.has(tool.name);
			records.push(record);
		}
	}

	const observedSkills = new Map<string, ObservedSkill>();
	const observedSkillNames = new Set<string>();
	for (const skill of snapshot.observation?.skills ?? []) {
		observedSkills.set(skillIdentity(skill.name, skill.sourceInfo), skill);
		observedSkillNames.add(skill.name);
	}
	const observedAt = snapshot.observation?.observedAt ?? 0;

	if (snapshot.availability.commands) {
		for (const command of snapshot.commands) {
			const kind = kindOfCommand(command.source);
			const name =
				kind === "skill" && command.name.startsWith(SKILL_COMMAND_PREFIX)
					? command.name.slice(SKILL_COMMAND_PREFIX.length)
					: command.name;
			const record: ResourceRecord = {
				kind,
				name,
				invocation: `/${command.name}`,
				sourceInfo: command.sourceInfo,
				evidence: "registration",
				at: snapshot.at,
			};
			if (command.description !== undefined) record.description = command.description;
			if (kind === "skill") {
				const observed = observedSkills.get(skillIdentity(name, command.sourceInfo));
				if (observed === undefined && observedSkillNames.has(name)) {
					record.observationIdentityMismatch = true;
				}
				if (observed) {
					record.modelInvocable = {
						value: !observed.disableModelInvocation,
						evidence: "observation",
						at: observedAt,
					};
					record.baseDir = { value: observed.baseDir, evidence: "observation", at: observedAt };
				}
			}
			records.push(record);
		}
	}

	return records.sort(compareRecords);
}

/** File-backed records are the only ones a content query can resolve. */
export function isFileBacked(record: ResourceRecord): boolean {
	return record.kind === "skill" || record.kind === "prompt";
}
