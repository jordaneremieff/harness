import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

/**
 * What a click handler returns: `false` declines the click so Pi keeps it; a result object is
 * merged into the handled result; anything else marks the click handled.
 */
export type ClickResult = unknown;

export interface HitRegion {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	/** A completed left click inside the region. Coordinates are local to the region. */
	click?(event: TuiMouseEvent): ClickResult;
	/** A wheel turn inside the region, in logical lines; negative is up. */
	wheel?(delta: number): void;
}

/**
 * Pointer targets of the last render. Regions belong to one rendered size; an event reported
 * for another size, or with a modifier, is left to Pi. Only completed clicks and wheel turns are
 * consumed, so presses and drags over the same cells stay native text selection.
 */
export class HitMap {
	private regions: HitRegion[] = [];
	private width = 0;
	private height = 0;

	/** Start a new render of a component of the given size. */
	begin(width: number, height: number): void {
		this.regions = [];
		this.width = width;
		this.height = height;
	}

	/** Forget every region, for example after a resize or a view change. */
	clear(): void {
		this.regions = [];
	}

	add(region: HitRegion): void {
		if (region.width > 0 && region.height > 0) this.regions.push(region);
	}

	/** Add a child's regions, shifted by its origin inside this component. */
	include(child: HitMap, x: number, y: number): void {
		for (const region of child.regions) this.add({ ...region, x: region.x + x, y: region.y + y });
	}

	private accepts(event: TuiMouseEvent): boolean {
		return (
			!event.shift &&
			!event.alt &&
			!event.ctrl &&
			event.width === this.width &&
			event.height === this.height &&
			event.x >= 0 &&
			event.y >= 0 &&
			event.x < this.width &&
			event.y < this.height
		);
	}

	private find(event: TuiMouseEvent, kind: "click" | "wheel"): HitRegion | undefined {
		for (let index = this.regions.length - 1; index >= 0; index--) {
			const region = this.regions[index];
			const inside =
				event.x >= region.x && event.x < region.x + region.width && event.y >= region.y && event.y < region.y + region.height;
			if (inside && region[kind]) return region;
		}
		return undefined;
	}

	handle(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.accepts(event)) return undefined;
		const delta = event.wheelDelta ?? 0;
		if (event.type === "wheel" && Number.isFinite(delta) && delta !== 0) {
			const region = this.find(event, "wheel");
			if (!region?.wheel) return undefined;
			region.wheel(Math.max(-100, Math.min(100, Math.trunc(delta))));
			return { handled: true, render: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		const region = this.find(event, "click");
		if (!region?.click) return undefined;
		const result = region.click({ ...event, x: event.x - region.x, y: event.y - region.y, width: region.width, height: region.height });
		if (result === false) return undefined;
		return { handled: true, render: true, ...(typeof result === "object" && result !== null ? result : {}) };
	}
}
