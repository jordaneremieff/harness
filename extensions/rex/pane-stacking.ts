import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PaneRect = [number, number, number, number];
export type PaneStackingReport = { version: 1; pane: null } | { version: 1; pane: PaneRect; above: PaneRect[] };

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function rect(value: unknown): PaneRect | undefined {
	if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === "number" && Number.isFinite(n)))
		return undefined;
	return value.map((n: number) => Math.min(1, Math.max(0, n))) as PaneRect;
}

function leafRect(layout: unknown, blockId: string): PaneRect | undefined {
	const pending = [layout];
	while (pending.length) {
		const node = object(pending.pop());
		if (node.block_id === blockId) return rect(node.rect);
		const split = object(node.split);
		if (split.before) pending.push(split.before);
		if (split.after) pending.push(split.after);
	}
	return undefined;
}

function intersects(a: PaneRect, b: PaneRect): boolean {
	return (
		a[2] > 0 &&
		a[3] > 0 &&
		b[2] > 0 &&
		b[3] > 0 &&
		a[0] < b[0] + b[2] &&
		b[0] < a[0] + a[2] &&
		a[1] < b[1] + b[3] &&
		b[1] < a[1] + a[3]
	);
}

const WHOLE: PaneRect = [0, 0, 1, 1];

/** Rex keeps the blocks of a minimized floating layer running but does not draw the layer. */
function drawn(layer: Record<string, unknown>): boolean {
	return layer.state !== "minimized";
}

function frontRects(layers: Record<string, unknown>[], index: number, pane: PaneRect): PaneRect[] {
	const above: PaneRect[] = [];
	for (let front = index + 1; front < layers.length && above.length < 64; front++) {
		if (!drawn(layers[front])) continue;
		const bounds = rect(layers[front].bounds);
		if (bounds && intersects(pane, bounds)) above.push(bounds);
	}
	return above;
}

/**
 * The zooms of a window. Rex draws a zoomed block over the whole window while every layout keeps its normal sizes. A
 * zoomed block of the tiled layer is drawn behind the floating layers and stays zoomed while a floating layer has
 * focus; `tiled_zoomed_block_id` names it. A zoomed block of a floating layer is drawn in front of everything and
 * keeps its zoom only while it has focus; `zoomed_block_id` names the focused block when it is zoomed. Both zooms can
 * be on at once. A server without `tiled_zoomed_block_id` has one zoom, which `zoomed_block_id` names in either layer.
 */
export function windowZooms(window: Record<string, unknown>): { tiled?: string; floating?: string } {
	const layers = Array.isArray(window.layers) ? window.layers.map(object) : [];
	const layerOf = (id: unknown) =>
		typeof id === "string" ? layers.find((layer) => leafRect(layer.layout, id)) : undefined;
	const zoomed = layerOf(window.zoomed_block_id);
	const tiledZoomed = layerOf(window.tiled_zoomed_block_id);
	const tiled =
		tiledZoomed?.kind === "tiled"
			? (window.tiled_zoomed_block_id as string)
			: zoomed?.kind === "tiled"
				? (window.zoomed_block_id as string)
				: undefined;
	const floating = zoomed && zoomed.kind !== "tiled" ? (window.zoomed_block_id as string) : undefined;
	return { ...(tiled === undefined ? {} : { tiled }), ...(floating === undefined ? {} : { floating }) };
}

function windowReport(value: unknown, blockId: string): PaneStackingReport | undefined {
	const window = object(value);
	if (!Array.isArray(window.layers)) return undefined;
	const layers = window.layers.map(object);
	const index = layers.findIndex((layer) => leafRect(layer.layout, blockId));
	if (index < 0) return undefined;
	const layer = layers[index];
	const zooms = windowZooms(window);
	const pane = zooms.tiled === blockId ? WHOLE : (leafRect(layer.layout, blockId) as PaneRect);
	if (zooms.floating !== undefined)
		return zooms.floating === blockId ? { version: 1, pane: WHOLE, above: [] } : { version: 1, pane, above: [WHOLE] };
	if (zooms.tiled !== undefined && zooms.tiled !== blockId && layer.kind === "tiled")
		return { version: 1, pane, above: [WHOLE] };
	return { version: 1, pane, above: frontRects(layers, index, pane) };
}

/** Window fractions and front-layer order come only from Rex's layout model. */
export function paneStacking(view: unknown, blockId: string): PaneStackingReport {
	const windows = object(view).windows;
	if (Array.isArray(windows)) {
		for (const window of windows) {
			const report = windowReport(window, blockId);
			if (report) return report;
		}
	}
	return { version: 1, pane: null };
}

/**
 * The command that reports a pane's stacking, offered to a pane program that Rex starts on this machine. A Unix
 * socket endpoint runs here; a network endpoint does not establish file access, so it gets no offer.
 */
export function paneStackingCommand(
	endpoint: string,
	env: Readonly<Record<string, string | undefined>>,
	runtime = process.execPath,
	helper = fileURLToPath(new URL("./pane-stacking.mts", import.meta.url)),
): string[] | undefined {
	if (!endpoint.startsWith("unix:///")) return undefined;
	const available = (path: string, mode: number) => {
		try {
			accessSync(path, mode);
			return statSync(path).isFile();
		} catch {
			return false;
		}
	};
	if (!isAbsolute(helper) || !available(helper, constants.R_OK)) return undefined;
	// Keep PATH entries unresolved so a package manager's stable launcher survives upgrades.
	const directories = (env.PATH ?? "").split(delimiter).slice(0, 256);
	const node =
		directories
			.filter(isAbsolute)
			.map((directory) => join(directory, "node"))
			.find((candidate) => available(candidate, constants.X_OK)) ?? runtime;
	return isAbsolute(node) && available(node, constants.X_OK) ? [node, helper] : undefined;
}

/** A pane program's argument vector with the stacking offer in its environment, when there is one. */
export function withPaneStacking(command: readonly string[], offer?: readonly string[]): string[] {
	return offer ? ["/usr/bin/env", `PI_PANE_STACKING=${JSON.stringify(offer)}`, ...command] : [...command];
}
