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

/**
 * The pane-border label: the session name, or the agent kind when the session
 * is unnamed, plus the model when known.
 */
export function composeBorderLabel(name: string | undefined, model: string | undefined): string {
	const base = name && name.length > 0 ? name : "pi";
	return model && model.length > 0 ? `${base} · ${model}` : base;
}

/** The label herdr shows for an auto-named tab at display position `index`. */
export function autoTabLabel(index: number): string {
	return String(index + 1);
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
