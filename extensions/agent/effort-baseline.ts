import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EffortPrompt } from "./effort-awareness.ts";
import {
	applyChanges,
	EFFORT_UPDATE_BUDGET,
	type EffortChange,
	type EffortSeen,
	effortDelta,
	formatEffortUpdate,
	seenOf,
	validEffortChange,
	validEffortSeen,
} from "./effort-update.ts";

/**
 * Ordinary sessions keep the `agent-efforts` section byte-identical between baseline points. A
 * baseline entry on the branch holds the section text and the rows it stands for; each later
 * change arrives as a hidden persistent update message whose details hold the change. What the
 * model has seen is the branch's newest baseline plus the updates that its context still holds.
 */
export const EFFORT_BASELINE_ENTRY = "agent.effort-baseline";
export const EFFORT_UPDATE_MESSAGE = "agent.effort-update";

interface BaselineData {
	readonly version: 1;
	readonly text: string;
	readonly seen: EffortSeen;
}
interface UpdateDetails extends EffortChange {
	readonly version: 1;
	readonly bytes: number;
}

type Session = Pick<SessionManager, "getLeafId" | "getEntry">;
type Entry = NonNullable<ReturnType<Session["getEntry"]>>;

function baselineData(entry: Entry): BaselineData | undefined {
	if (entry.type !== "custom" || entry.customType !== EFFORT_BASELINE_ENTRY) return undefined;
	const data = entry.data as Partial<BaselineData> | undefined;
	return data?.version === 1 && typeof data.text === "string" && validEffortSeen(data.seen)
		? (data as BaselineData)
		: undefined;
}
function updateDetails(entry: Entry): UpdateDetails | undefined {
	if (entry.type !== "custom_message" || entry.customType !== EFFORT_UPDATE_MESSAGE) return undefined;
	const details = entry.details as Partial<UpdateDetails> | undefined;
	return details?.version === 1 && typeof details.bytes === "number" && validEffortChange(details)
		? (details as UpdateDetails)
		: undefined;
}

/** What the model on the current branch has: the section text and the rows behind it. */
export interface BranchAwareness {
	readonly text: string;
	readonly seen: EffortSeen;
	/** Update bytes in the current context since the baseline. */
	readonly bytes: number;
}

/**
 * Walk from the leaf to the newest baseline. A compaction keeps the system section and the entries
 * from its first kept entry; updates before that entry left the context, so their changes are
 * not seen and the next update reports them again.
 */
export function branchAwareness(session: Session): BranchAwareness | undefined {
	const kept: UpdateDetails[] = [];
	let firstKept: string | undefined;
	let compacted = false;
	let inContext = true;
	for (let id = session.getLeafId(); id !== null; ) {
		const entry = session.getEntry(id);
		if (!entry) return undefined;
		const baseline = baselineData(entry);
		if (baseline) {
			const changes = kept.reverse();
			return {
				text: baseline.text,
				seen: applyChanges(baseline.seen, changes),
				bytes: changes.reduce((total, change) => total + change.bytes, 0),
			};
		}
		if (entry.type === "compaction" && !compacted) {
			compacted = true;
			firstKept = entry.firstKeptEntryId;
		}
		const update = inContext ? updateDetails(entry) : undefined;
		if (update) kept.push(update);
		if (compacted && entry.id === firstKept) inContext = false;
		id = entry.parentId;
	}
	return undefined;
}

export interface OrdinaryEffortRun {
	/** The section text for this run. */
	readonly section: string;
	/** A new baseline entry to append before the run, when the section changed. */
	readonly baseline?: BaselineData;
	/** A hidden persistent message for this run, when only rows changed. */
	readonly update?: {
		readonly customType: typeof EFFORT_UPDATE_MESSAGE;
		readonly content: string;
		readonly display: false;
		readonly details: UpdateDetails;
	};
}

/**
 * One run start. A branch without a baseline, a change too large for one update, or updates past
 * the budget replace the section; otherwise the section keeps its bytes and the rows that changed
 * become one update.
 */
export function ordinaryEffortRun(current: BranchAwareness | undefined, prompt: EffortPrompt): OrdinaryEffortRun {
	const rebaseline = (): OrdinaryEffortRun => {
		const baseline: BaselineData = { version: 1, text: prompt.text, seen: seenOf(prompt.rows) };
		return { section: prompt.text, baseline };
	};
	if (current === undefined) return rebaseline();
	const delta = effortDelta(current.seen, prompt.rows);
	if (delta === undefined) return { section: current.text };
	const update = formatEffortUpdate(delta);
	if (update === undefined || current.bytes + update.bytes > EFFORT_UPDATE_BUDGET) return rebaseline();
	return {
		section: current.text,
		update: {
			customType: EFFORT_UPDATE_MESSAGE,
			content: update.text,
			display: false,
			details: { version: 1, ...update.change, bytes: update.bytes },
		},
	};
}
