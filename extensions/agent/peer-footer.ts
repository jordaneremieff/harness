/**
 * Compact peer footer. All values come from public observation data; unknown
 * usage stays unknown instead of becoming a zero that looks like a reading.
 */
import type { PeerDescriptor, PeerState } from "./peer-contract.ts";

const appearance: Record<PeerState, string> = {
	primary: "● live",
	working: "● working",
	idle: "○ idle",
	done: "✓ done",
	failed: "! failed",
	stopped: "■ stopped",
	interrupted: "↯ interrupted",
	new: "· new",
	unavailable: "? unavailable",
};

/** State glyph plus a short label. */
export function stateText(state: PeerState): string {
	return appearance[state];
}

/**
 * Retained cost text. `undefined` is unknown, not free; a partial reading is a
 * lower bound, and a zero cost is a real zero.
 */
export function formatCost(cost: number | undefined, partial?: boolean): string {
	if (cost === undefined || !Number.isFinite(cost)) return "$?";
	return `${partial ? "≥" : ""}$${cost.toFixed(2)}`;
}

/** Exact model and reasoning level in one short field. */
export function modelText(descriptor: PeerDescriptor): string {
	const model = descriptor.model ?? "model unknown";
	return descriptor.thinkingLevel ? `${model} ${descriptor.thinkingLevel}` : model;
}

export interface PeerFooterOptions {
	/** Composer mode for this peer, when the pane has one. */
	mode?: string;
	/** True when a native draft is held for explicit restore. */
	nativeDraft?: boolean;
	/** Current notice text, when any. */
	notice?: string;
}

/**
 * One footer line. The caller truncates to the pane width; segments are ordered
 * so state and model survive the narrowest pane.
 */
export function footerText(descriptor: PeerDescriptor, options: PeerFooterOptions = {}): string {
	const segments = [modelText(descriptor), formatCost(descriptor.cost, descriptor.partialCost), stateText(descriptor.state)];
	if (options.mode) segments.push(`mode ${options.mode}`);
	if (options.nativeDraft) segments.push("native draft saved");
	if (descriptor.detail) segments.push(descriptor.detail);
	if (options.notice) segments.push(options.notice);
	return segments.join(" · ");
}
