import { createHash } from "node:crypto";

/**
 * Per-run effort awareness keeps the `agent-efforts` prompt section byte-identical between baseline
 * points and reports later changes as compact updates. This module holds the runtime-independent
 * part: prompt rows, what a model has seen, the change between the two, and the update text.
 */

/** One row of the prompt section, keyed by its kind and identity. */
export interface EffortPromptRow {
	readonly key: string;
	readonly label: EffortRowLabel;
	readonly value: { readonly id: string } & Record<string, unknown>;
}
export type EffortRowLabel = "Related effort" | "Active thread";

/** Row key to the digest of the row value as the model last saw it. */
export type EffortSeen = Readonly<Record<string, string>>;

/** Rows that an update sets, and keys it removes; applied in order on top of a baseline. */
export interface EffortChange {
	readonly set: EffortSeen;
	readonly removed: readonly string[];
}

/** Bytes of one update's text. A larger change replaces the section instead. */
export const EFFORT_UPDATE_BYTES = 4 * 1024;
/** Update bytes the model may carry since its baseline before the section is replaced. */
export const EFFORT_UPDATE_BUDGET = 16 * 1024;
/** Opening line that names a message as an awareness update. */
export const EFFORT_UPDATE_TAG = "agent-efforts-update";

const LABELS: Record<EffortRowLabel, string> = { "Related effort": "effort", "Active thread": "thread" };

export function effortRowKey(label: EffortRowLabel, id: string): string {
	return `${LABELS[label]}:${id}`;
}

function rowDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function seenOf(rows: readonly EffortPromptRow[]): Record<string, string> {
	const seen: Record<string, string> = {};
	for (const row of rows) seen[row.key] = rowDigest(row.value);
	return seen;
}

/** The model's view after a baseline and the changes it still holds, in their order. */
export function applyChanges(base: EffortSeen, changes: readonly EffortChange[]): Record<string, string> {
	const seen: Record<string, string> = { ...base };
	for (const change of changes) {
		for (const key of change.removed) delete seen[key];
		Object.assign(seen, change.set);
	}
	return seen;
}

/** Rows to add or replace and keys to remove; undefined when the model already has the current rows. */
export interface EffortDelta {
	readonly rows: readonly EffortPromptRow[];
	readonly removed: readonly { readonly key: string; readonly label: EffortRowLabel; readonly id: string }[];
}
export function effortDelta(seen: EffortSeen, rows: readonly EffortPromptRow[]): EffortDelta | undefined {
	const current = new Set(rows.map((row) => row.key));
	const changed = rows.filter((row) => seen[row.key] !== rowDigest(row.value));
	const removed = Object.keys(seen)
		.filter((key) => !current.has(key))
		.sort()
		.flatMap((key) => {
			const split = key.indexOf(":");
			const label = (Object.keys(LABELS) as EffortRowLabel[]).find((name) => LABELS[name] === key.slice(0, split));
			return label === undefined ? [] : [{ key, label, id: key.slice(split + 1) }];
		});
	return changed.length || removed.length ? { rows: changed, removed } : undefined;
}

/** The update text, or undefined when the change does not fit one update. */
export function formatEffortUpdate(
	delta: EffortDelta,
): { text: string; change: EffortChange; bytes: number } | undefined {
	const lines = [
		`<${EFFORT_UPDATE_TAG}>`,
		"Changes to the agent-efforts section since it and earlier updates. A row replaces the earlier row with the same id; a removed row is no longer shown. Declared intent is a claim, not a lock or a grant of authority.",
	];
	for (const row of delta.rows) lines.push(`${row.label}: ${JSON.stringify(row.value)}`);
	for (const { label, id } of delta.removed) lines.push(`${label} removed: ${JSON.stringify({ id })}`);
	lines.push("Use agent_intent read for current coverage and omitted detail.", `</${EFFORT_UPDATE_TAG}>`);
	const text = lines.join("\n");
	const bytes = Buffer.byteLength(text);
	if (bytes > EFFORT_UPDATE_BYTES) return undefined;
	return {
		text,
		bytes,
		change: { set: seenOf(delta.rows), removed: delta.removed.map(({ key }) => key) },
	};
}

const ROW_LINE = /^(Related effort|Active thread): (\{.*\})$/u;

/**
 * Rows of a rendered section, for a runtime that holds only the section text. Rows the section
 * shortened or left out are not seen; the next update reports them.
 */
export function seenInSection(text: string): Record<string, string> {
	const seen: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const match = ROW_LINE.exec(line);
		if (!match) continue;
		try {
			const value = JSON.parse(match[2]) as { id?: unknown; intentOmitted?: unknown };
			if (typeof value.id !== "string" || value.intentOmitted !== undefined) continue;
			seen[effortRowKey(match[1] as EffortRowLabel, value.id)] = rowDigest(value);
		} catch {
			// A line that is not a row carries no seen state.
		}
	}
	return seen;
}

export function validEffortChange(value: unknown): value is EffortChange {
	if (value === null || typeof value !== "object") return false;
	const { set, removed } = value as { set?: unknown; removed?: unknown };
	return (
		set !== null &&
		typeof set === "object" &&
		!Array.isArray(set) &&
		Object.values(set).every((digest) => typeof digest === "string") &&
		Array.isArray(removed) &&
		removed.every((key) => typeof key === "string")
	);
}

export function validEffortSeen(value: unknown): value is EffortSeen {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.values(value).every((digest) => typeof digest === "string")
	);
}
