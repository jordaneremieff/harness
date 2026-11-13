export type PaneRect = [number, number, number, number];
export type PaneStackingReport =
	| { version: 1; pane: null }
	| { version: 1; pane: PaneRect; above: PaneRect[] };

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function rect(value: unknown): PaneRect | undefined {
	if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
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
	return a[2] > 0 && a[3] > 0 && b[2] > 0 && b[3] > 0 &&
		a[0] < b[0] + b[2] && b[0] < a[0] + a[2] &&
		a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

function frontRects(layers: unknown[], index: number, pane: PaneRect): PaneRect[] {
	const above: PaneRect[] = [];
	for (let front = index + 1; front < layers.length && above.length < 64; front++) {
		const bounds = rect(object(layers[front]).bounds);
		if (bounds && intersects(pane, bounds)) above.push(bounds);
	}
	return above;
}

function windowReport(value: unknown, blockId: string): PaneStackingReport | undefined {
	const window = object(value);
	if (!Array.isArray(window.layers)) return undefined;
	for (let index = 0; index < window.layers.length; index++) {
		const layer = object(window.layers[index]);
		let pane = leafRect(layer.layout, blockId);
		if (!pane) continue;
		if (layer.kind === "tiled") {
			const zoomed = window.zoomed_block_id;
			if (typeof zoomed === "string" && zoomed !== blockId && leafRect(layer.layout, zoomed)) {
				return { version: 1, pane, above: [[0, 0, 1, 1]] };
			}
			if (zoomed === blockId) pane = [0, 0, 1, 1];
		}
		return { version: 1, pane, above: frontRects(window.layers, index, pane) };
	}
	return undefined;
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
