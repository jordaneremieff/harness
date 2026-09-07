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
		const skills: ObservedSkill[] = [];
		const selectedTools: string[] = [];
		const contextFilePaths: string[] = [];
		let overflowRecords = false;
		let overflowBytes = false;

		const build = (cwd: string): ObservationSnapshot => ({
			observedAt: at,
			cwd,
			skills,
			selectedTools,
			contextFilePaths,
			customPromptPresent: typeof options.customPrompt === "string" && options.customPrompt.length > 0,
			appendSystemPromptPresent:
				typeof options.appendSystemPrompt === "string" && options.appendSystemPrompt.length > 0,
			recordCount: skills.length + selectedTools.length + contextFilePaths.length,
			bytes: 0,
			overflowRecords,
			overflowBytes,
		});

		// The observed cwd is unbounded input, so it is charged to the same budget
		// as every other retained field before any record is admitted.
		let cwd = typeof options.cwd === "string" ? options.cwd : "";
		if (retainedBytes(build(cwd)) > MAX_OBSERVED_BYTES) {
			cwd = "";
			overflowBytes = true;
		}

		const admit = <T>(list: T[], item: T): boolean => {
			const count = skills.length + selectedTools.length + contextFilePaths.length;
			if (count >= MAX_OBSERVED_RECORDS) {
				overflowRecords = true;
				return false;
			}
			list.push(item);
			if (retainedBytes(build(cwd)) > MAX_OBSERVED_BYTES) {
				list.pop();
				overflowBytes = true;
				return false;
			}
			return true;
		};

		for (const skill of options.skills ?? []) {
			const copy: ObservedSkill = {
				name: skill.name,
				filePath: skill.filePath,
				baseDir: skill.baseDir,
				disableModelInvocation: skill.disableModelInvocation === true,
				sourceInfo: { ...skill.sourceInfo },
			};
			if (!admit(skills, copy)) break;
		}
		for (const name of options.selectedTools ?? []) {
			if (!admit(selectedTools, name)) break;
		}
		// Only the path is copied. Context-file content never enters this store.
		for (const file of options.contextFiles ?? []) {
			if (!admit(contextFilePaths, file.path)) break;
		}

		// Recording the measured size grows the snapshot, so the count is taken to
		// a fixed point and the bound is then settled against the final object.
		const settle = (value: ObservationSnapshot): ObservationSnapshot => {
			for (let pass = 0; pass < 4; pass += 1) {
				const measured = retainedBytes(value);
				if (measured === value.bytes) break;
				value.bytes = measured;
			}
			return value;
		};
		let snapshot = settle(build(cwd));
		while (retainedBytes(snapshot) > MAX_OBSERVED_BYTES) {
			const source = contextFilePaths.length > 0 ? contextFilePaths : selectedTools.length > 0 ? selectedTools : skills;
			if (source.length === 0) cwd = "";
			else source.pop();
			overflowBytes = true;
			snapshot = settle(build(cwd));
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
