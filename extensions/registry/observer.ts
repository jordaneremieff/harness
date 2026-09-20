/**
 * Bounded observer over the system-prompt inputs Pi passes to before_agent_start.
 *
 * It copies paths, names, selected tool names, and prompt-presence flags. It
 * retains neither the mutable event object nor prompt or context-file contents.
 *
 * The byte bound is measured on the retained snapshot itself — its serialized
 * form, including structural overhead and the observed cwd — not on the sum of
 * field values, so what the store holds is what the bound covers. Retention also
 * stops at MAX_OBSERVED_RECORDS records. The snapshot reports which bound
 * stopped it.
 */

import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import type { ObservationSnapshot, ObservedSkill } from "./records.ts";

export const MAX_OBSERVED_RECORDS = 1000;
export const MAX_OBSERVED_BYTES = 256 * 1024;

/** The subset of BuildSystemPromptOptions this observer is allowed to read. */
export interface ObservableOptions {
	cwd?: string;
	customPrompt?: string;
	forceSystemPrompt?: string;
	appendSystemPrompt?: string;
	selectedTools?: string[];
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Array<{
		name: string;
		filePath: string;
		baseDir: string;
		disableModelInvocation?: boolean;
		sourceInfo: SourceInfo;
	}>;
}

/** Serialized size of the value as this store would retain it. */
export function retainedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

interface ObserveState {
	options: ObservableOptions;
	at: number;
	cwd: string;
	skills: ObservedSkill[];
	selectedTools: string[];
	contextFilePaths: string[];
	overflowRecords: boolean;
	overflowBytes: boolean;
}

function observeRecordCount(state: ObserveState): number {
	return state.skills.length + state.selectedTools.length + state.contextFilePaths.length;
}

function buildObservation(state: ObserveState): ObservationSnapshot {
	return {
		observedAt: state.at,
		cwd: state.cwd,
		skills: state.skills,
		selectedTools: state.selectedTools,
		contextFilePaths: state.contextFilePaths,
		customPromptPresent: typeof state.options.customPrompt === "string" && state.options.customPrompt.length > 0,
		forcedSystemPromptPresent: typeof state.options.forceSystemPrompt === "string",
		appendSystemPromptPresent:
			typeof state.options.appendSystemPrompt === "string" && state.options.appendSystemPrompt.length > 0,
		recordCount: observeRecordCount(state),
		bytes: 0,
		overflowRecords: state.overflowRecords,
		overflowBytes: state.overflowBytes,
	};
}

function admitRecord<T>(state: ObserveState, list: T[], item: T): boolean {
	if (observeRecordCount(state) >= MAX_OBSERVED_RECORDS) {
		state.overflowRecords = true;
		return false;
	}
	list.push(item);
	if (retainedBytes(buildObservation(state)) > MAX_OBSERVED_BYTES) {
		list.pop();
		state.overflowBytes = true;
		return false;
	}
	return true;
}

function admitObservedSkills(state: ObserveState): void {
	for (const skill of state.options.skills ?? []) {
		const copy: ObservedSkill = {
			name: skill.name,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
			disableModelInvocation: skill.disableModelInvocation === true,
			sourceInfo: { ...skill.sourceInfo },
		};
		if (!admitRecord(state, state.skills, copy)) return;
	}
}

function admitSelectedTools(state: ObserveState): void {
	for (const name of state.options.selectedTools ?? []) {
		if (!admitRecord(state, state.selectedTools, name)) return;
	}
}

function admitContextFiles(state: ObserveState): void {
	// Only the path is copied. Context-file content never enters this store.
	for (const file of state.options.contextFiles ?? []) {
		if (!admitRecord(state, state.contextFilePaths, file.path)) return;
	}
}

/** Measure to a fixed point because recording the size grows the snapshot. */
function settleObservation(state: ObserveState): ObservationSnapshot {
	const value = buildObservation(state);
	for (let pass = 0; pass < 4; pass += 1) {
		const measured = retainedBytes(value);
		if (measured === value.bytes) break;
		value.bytes = measured;
	}
	return value;
}

/**
 * Session-scoped observation state.
 *
 * One instance per extension load. `clear()` is called on session_start and
 * session_shutdown so observations never cross a session boundary.
 */
export class ObservationStore {
	private current: ObservationSnapshot | null = null;

	/** Replace the retained observation with a bounded copy of the current inputs. */
	observe(options: ObservableOptions, at: number): void {
		const state: ObserveState = {
			options,
			at,
			cwd: typeof options.cwd === "string" ? options.cwd : "",
			skills: [],
			selectedTools: [],
			contextFilePaths: [],
			overflowRecords: false,
			overflowBytes: false,
		};
		// The observed cwd is unbounded input, so it is charged to the same budget
		// as every other retained field before any record is admitted.
		if (retainedBytes(buildObservation(state)) > MAX_OBSERVED_BYTES) {
			state.cwd = "";
			state.overflowBytes = true;
		}
		admitObservedSkills(state);
		admitSelectedTools(state);
		admitContextFiles(state);
		let snapshot = settleObservation(state);
		while (retainedBytes(snapshot) > MAX_OBSERVED_BYTES) {
			const source =
				state.contextFilePaths.length > 0
					? state.contextFilePaths
					: state.selectedTools.length > 0
						? state.selectedTools
						: state.skills;
			if (source.length === 0) state.cwd = "";
			else source.pop();
			state.overflowBytes = true;
			snapshot = settleObservation(state);
		}
		this.current = snapshot;
	}

	/** Null means not yet observed, which is distinct from an empty observation. */
	snapshot(): ObservationSnapshot | null {
		return this.current;
	}

	clear(): void {
		this.current = null;
	}
}
