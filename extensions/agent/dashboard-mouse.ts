import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { fitHints } from "./dashboard-layout.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

interface Region {
	x: number;
	y: number;
	width: number;
	height: number;
	click?: (event: TuiMouseEvent) => unknown;
	wheel?: (delta: number) => void;
}
/** Hit areas belong to the last rendered viewport, not to retained text or source data. */
export class DashboardMouse {
	private regions: Region[] = [];
	private width = 0;
	private height = 0;
	reset(width = 0, height = 0): void {
		this.regions = [];
		this.width = width;
		this.height = height;
	}
	shiftY(offset: number, from: number, to: number): void {
		this.regions = this.regions.flatMap((region) => {
			if (region.y < from) return [region];
			const y = region.y + offset;
			return y >= from && y < to ? [{ ...region, y }] : [];
		});
	}
	add(region: Region): void {
		if (region.width > 0 && region.height > 0) this.regions.push(region);
	}
	private within(event: TuiMouseEvent): boolean {
		return (
			!event.shift &&
			!event.alt &&
			!event.ctrl &&
			event.width === this.width &&
			event.height === this.height &&
			Number.isSafeInteger(event.x) &&
			Number.isSafeInteger(event.y) &&
			event.x >= 0 &&
			event.y >= 0 &&
			event.x < this.width &&
			event.y < this.height
		);
	}
	private hit(region: Region, event: TuiMouseEvent): boolean {
		return (
			event.x >= region.x &&
			event.x < region.x + region.width &&
			event.y >= region.y &&
			event.y < region.y + region.height
		);
	}
	private activate(
		region: Region,
		event: TuiMouseEvent,
		wheel: boolean,
		delta: number,
	): TuiMouseEventResult | undefined {
		if (wheel && region.wheel) {
			region.wheel(Math.max(-100, Math.min(100, Math.trunc(delta))));
			return { handled: true, render: true };
		}
		if (event.type !== "click" || !region.click) return;
		const result = region.click({
			...event,
			x: event.x - region.x,
			y: event.y - region.y,
			width: region.width,
			height: region.height,
		});
		if (result === false) return;
		return {
			handled: true,
			focus: true,
			render: true,
			...(typeof result === "object" && result !== null ? result : {}),
		};
	}
	private regionFor(event: TuiMouseEvent, wheel: boolean): Region | undefined {
		return this.regions
			.toReversed()
			.find((region) => this.hit(region, event) && (wheel ? !!region.wheel : !!region.click));
	}
	handle(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.within(event)) return;
		const click = event.type === "click" && event.button === "left" && (event.clickCount ?? 1) === 1;
		const delta = event.wheelDelta ?? 0;
		const wheel = event.type === "wheel" && Number.isFinite(delta) && delta !== 0;
		// Pi keeps unhandled press/drag/release and multiple clicks for text selection.
		if (!click && !wheel) return;
		const region = this.regionFor(event, wheel);
		return region ? this.activate(region, event, wheel, delta) : undefined;
	}
}
const inputs: Record<string, string> = {
	enter: "\r",
	tab: "\t",
	esc: "\x1b",
	space: " ",
	"ctrl+j": "\x1b[106;5u",
	"ctrl+o": "\x0f",
	"ctrl+t": "\x14",
	pgup: "\x1b[5~",
	pgdn: "\x1b[6~",
};
function addHint(
	mouse: DashboardMouse,
	y: number,
	hint: string,
	x: number,
	visible: number,
	input: (data: string) => void,
): void {
	const keys = hint.split(" ", 1)[0];
	if (keys === "↑↓") {
		mouse.add({
			x,
			y,
			width: 1,
			height: 1,
			click: () => {
				input("\x1b[A");
			},
		});
		mouse.add({
			x: x + 1,
			y,
			width: 1,
			height: 1,
			click: () => {
				input("\x1b[B");
			},
		});
		return;
	}
	if (keys.includes("/") && keys !== "/") {
		let start = x;
		for (const key of keys.split("/")) {
			const data = inputs[key];
			if (data)
				mouse.add({
					x: start,
					y,
					width: key.length,
					height: 1,
					click: () => {
						input(data);
					},
				});
			start += key.length + 1;
		}
		return;
	}
	const data = inputs[keys] ?? (keys.length === 1 ? keys : undefined);
	if (data)
		mouse.add({
			x,
			y,
			width: visible,
			height: 1,
			click: () => {
				input(data);
			},
		});
}
export function mouseHints(
	mouse: DashboardMouse,
	y: number,
	items: readonly string[],
	back: string,
	width: number,
	input: (data: string) => void,
	theme?: Theme,
): string {
	return fitHints(items, back, width, (hint, x, visible) => addHint(mouse, y, hint, x, visible, input), theme);
}
