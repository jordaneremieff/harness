/**
 * Pure naming and tab-label decisions for the herdr extension.
 *
 * No Pi or socket imports; every function is directly testable.
 */

/** Strip control characters, collapse whitespace, and trim. */
export function sanitizeName(raw: string): string {
	return raw
		.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Cap a display name, adding an ellipsis suffix when truncated. */
export function capName(name: string, max: number): string {
	const chars = [...name];
	if (chars.length <= max) return name;
	if (max <= 1) return chars.slice(0, Math.max(0, max)).join("");
	return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** The label herdr shows for an auto-named tab at display position `index`. */
export function autoTabLabel(index: number): string {
	return String(index + 1);
}

/**
 * Openers whose remainder still names the work. The prefix is removed and the
 * rest becomes the label.
 */
const STRIP_PREFIXES: RegExp[] = [
	/^#{1,6}\s+/,
	/^[-*\u2022]\s+/,
	/^(objective|goal|task|mission|request|question|summary|compute|context|subject)\s*[:\u2014-]\s*/i,
	/^lane\s+\d+\s*[:\u2014-]\s*/i,
	/^(please|kindly)\s+/i,
	/^(can|could|would)\s+you\s+(please\s+)?/i,
	/^i\s+(need|want)\s+you\s+to\s+/i,
	/^your\s+task\s+is\s+to\s+/i,
];

/**
 * Openers that are boilerplate all the way down. Their remainder describes the
 * harness rather than the work, so the tab keeps its numeric label.
 */
const REJECT_PREFIXES: RegExp[] = [
	/^</,
	/^\//,
	/^resume\s+the\s+stashed\s+effort/i,
	/^reply\s+with\s+exactly/i,
	/^you\s+are\s+/i,
	/^continue\s+from\s+(the\s+)?(handoff|stash|artifact)/i,
];

/** A one-word label shorter than this carries no information. */
const SINGLE_WORD_FLOOR = 12;
/** Below this length nothing is worth showing. */
const MIN_LABEL_LENGTH = 3;

export interface FallbackOptions {
	/** Cap for the produced label. */
	maxName: number;
	/** Labels already shown in the workspace; a collision rejects the candidate. */
	taken?: readonly string[];
}

/** Remove one round of template prefixes; returns the text unchanged when none match. */
function stripPrefixes(text: string): string {
	let current = text;
	for (let pass = 0; pass < STRIP_PREFIXES.length; pass += 1) {
		let changed = false;
		for (const pattern of STRIP_PREFIXES) {
			const next = current.replace(pattern, "");
			if (next !== current) {
				current = next.trimStart();
				changed = true;
			}
		}
		if (!changed) break;
	}
	return current;
}

/**
 * Turn a first user message into a tab label, or reject it.
 *
 * Three guards decide the outcome. Boilerplate openers are rejected outright.
 * An informative opener loses its template prefix. A label that repeats one
 * already shown in the workspace is rejected, so that tab keeps its number.
 */
export function classifyFallbackLabel(raw: string, options: FallbackOptions): string | undefined {
	const text = sanitizeName(raw);
	if (!text) return undefined;
	if (REJECT_PREFIXES.some((pattern) => pattern.test(text))) return undefined;

	const stripped = stripPrefixes(text);
	if (!stripped) return undefined;
	if (REJECT_PREFIXES.some((pattern) => pattern.test(stripped))) return undefined;
	if (!/\p{L}/u.test(stripped)) return undefined;
	if (stripped.length < MIN_LABEL_LENGTH) return undefined;

	const words = stripped.split(" ").filter(Boolean);
	if (words.length === 1 && stripped.length < SINGLE_WORD_FLOOR) return undefined;

	const label = capName(stripped, options.maxName);
	const taken = options.taken ?? [];
	if (taken.some((other) => other.toLowerCase() === label.toLowerCase())) return undefined;
	return label;
}

/** One session entry, reduced to the fields the label needs. */
export interface LabelEntry {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

/** Join the text blocks of a message, mirroring how Pi reads a first message. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => {
			const candidate = block as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map((block) => block.text)
		.join(" ");
}

/** The first textual user message of a session, in append order. */
export function firstUserMessage(entries: readonly LabelEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "user") continue;
		const text = messageText(entry.message.content);
		if (text.trim()) return text;
	}
	return undefined;
}

/** The guarded tab label for a session's first user message, when it earns one. */
export function firstMessageLabel(entries: readonly LabelEntry[], options: FallbackOptions): string | undefined {
	const first = firstUserMessage(entries);
	return first === undefined ? undefined : classifyFallbackLabel(first, options);
}

export interface ListedTab {
	tabId: string;
	label: string;
}

export type TabAction =
	| { type: "rename"; label: string; registry: string }
	| { type: "restore"; label: string; registry: undefined }
	| { type: "none"; registry: string | undefined };

export interface TabDecisionInput {
	/** Session name after normalization; undefined when cleared. */
	name: string | undefined;
	/** The tab this extension's pane belongs to. */
	tabId: string;
	/** Tabs of the workspace in display order, as returned by tab.list. */
	tabs: ListedTab[];
	/** The label this extension last wrote to the tab, when known. */
	registryLabel: string | undefined;
}

/**
 * Decide the tab-bar write for the current session name.
 *
 * Auto-named tabs may be taken over. Tabs this extension named follow the
 * session name and restore when it clears. Any other label is manual and is
 * never touched.
 */
export function decideTabAction(input: TabDecisionInput): TabAction {
	const { name, tabId, tabs, registryLabel } = input;
	const index = tabs.findIndex((tab) => tab.tabId === tabId);
	if (index === -1) return { type: "none", registry: registryLabel };
	const auto = autoTabLabel(index);
	const current = tabs[index].label;

	if (current === auto) {
		if (name) return { type: "rename", label: name, registry: name };
		return { type: "none", registry: undefined };
	}

	if (registryLabel !== undefined && current === registryLabel) {
		if (name && name !== current) return { type: "rename", label: name, registry: name };
		if (!name) return { type: "restore", label: auto, registry: undefined };
		return { type: "none", registry: name };
	}

	if (registryLabel === undefined && name && current === name) {
		return { type: "none", registry: name };
	}

	return { type: "none", registry: undefined };
}
