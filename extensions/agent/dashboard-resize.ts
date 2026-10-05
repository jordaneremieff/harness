import { matchesKey, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { clamp, dashboardGeometry } from "./dashboard-layout.ts";
import type { DashboardLayout } from "./dashboard-state.ts";

export type Divider = "roster" | "composer";
export interface ResizeHandle {
	kind: Divider;
	x: number;
	y: number;
	width: number;
	height: number;
	value: number;
	min: number;
	max: number;
}
interface Gesture {
	handles: ResizeHandle[];
	start: DashboardLayout;
	kind: Divider;
	pointer?: number;
	value: number;
}
/** Only committed preferences survive; capture and hover belong to one rendered screen. */
export class DashboardResize {
	private handles: ResizeHandle[] = [];
	private gesture?: Gesture;
	private width = 0;
	private height = 0;
	private screen = "";
	hover?: Divider;
	private readonly layout: DashboardLayout;
	private readonly save: () => void;
	constructor(layout: DashboardLayout, save: () => void) { this.layout = layout; this.save = save; }
	get keyboard(): boolean { return !!this.gesture && this.gesture.pointer === undefined; }
	get selected(): Divider | undefined { return this.gesture?.kind; }
	get available(): boolean { return this.handles.length > 0; }
	active(kind: Divider): boolean { return this.selected === kind; }
	begin(width: number, height: number, screen: string): void {
		if (width !== this.width || height !== this.height || screen !== this.screen) this.cancel();
		this.width = width;
		this.height = height;
		this.screen = screen;
		this.handles = [];
	}
	beginInputGeometry(width: number, height: number, screen: string): void {
		if (width !== this.width || height !== this.height || screen !== this.screen) this.begin(width, height, screen);
	}
	add(handle: ResizeHandle): void { this.handles.push(handle); }
	end(): void {
		if (this.selected && !this.handles.some((handle) => handle.kind === this.selected)) {
			const handles = this.handles;
			this.cancel();
			this.handles = handles;
		}
		if (this.hover && !this.handles.some((handle) => handle.kind === this.hover)) this.hover = undefined;
	}
	cancel(): boolean {
		const start = this.gesture?.start;
		if (start) {
			delete this.layout.rosterRatio;
			delete this.layout.composerRows;
			Object.assign(this.layout, start);
			this.handles = this.gesture?.handles ?? [];
		}
		const changed = !!this.gesture || !!this.hover;
		this.gesture = undefined;
		this.hover = undefined;
		return changed;
	}
	clear(): void { this.cancel(); this.handles = []; }
	private same(start: DashboardLayout): boolean {
		return start.rosterRatio === this.layout.rosterRatio && start.composerRows === this.layout.composerRows;
	}
	private commit(): void {
		const changed = this.gesture && !this.same(this.gesture.start);
		this.gesture = undefined;
		if (changed) this.save();
	}
	private change(handle: ResizeHandle, value: number): boolean {
		const next = clamp(value, handle.min, handle.max);
		if (next === handle.value) return false;
		if (handle.kind === "roster") this.layout.rosterRatio = next / (this.width - 1);
		else this.layout.composerRows = next;
		handle.value = next;
		return true;
	}
	private reset(kind: Divider): void {
		if (kind === "roster") delete this.layout.rosterRatio;
		else delete this.layout.composerRows;
		const handle = this.handles.find((h) => h.kind === kind);
		if (handle) handle.value = kind === "roster" ? dashboardGeometry(this.width, this.height, 0).rosterWidth : handle.min;
	}
	startKeyboard(): boolean {
		this.cancel();
		const handle = this.handles[0];
		if (!handle) return false;
		this.gesture = { kind: handle.kind, start: { ...this.layout }, value: handle.value, handles: this.handles.map((item) => ({ ...item })) };
		return true;
	}
	/** A key also ends a drag whose release was lost outside the terminal. */
	input(data: string): boolean {
		if (!this.gesture) return false;
		if (!this.keyboard) { this.cancel(); return matchesKey(data, "escape"); }
		if (matchesKey(data, "escape")) { this.cancel(); return true; }
		if (matchesKey(data, "enter")) { this.commit(); return true; }
		if (matchesKey(data, "tab")) {
			const index = this.handles.findIndex((h) => h.kind === this.selected);
			const handle = this.handles[(index + 1) % this.handles.length];
			if (handle) this.gesture.kind = handle.kind;
			return true;
		}
		this.adjustKeyboard(data);
		return true;
	}
	private adjustKeyboard(data: string): void {
		const handle = this.handles.find((h) => h.kind === this.selected);
		if (!handle) return;
		if (data === "0") this.reset(handle.kind);
		else if (handle.kind === "roster" && (matchesKey(data, "left") || matchesKey(data, "right")))
			this.change(handle, handle.value + (matchesKey(data, "left") ? -1 : 1));
		else if (handle.kind === "composer" && (matchesKey(data, "up") || matchesKey(data, "down")))
			this.change(handle, handle.value + (matchesKey(data, "up") ? 1 : -1));
	}
	private captured(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.gesture || this.keyboard) return;
		if (event.type === "release") { this.commit(); return { handled: true, render: true }; }
		if (event.type !== "drag") return;
		const handle = this.handles.find((h) => h.kind === this.selected);
		if (!handle || event.shift || event.alt || event.ctrl || event.button !== "left") {
			this.cancel(); return { handled: true, render: true };
		}
		const pointer = handle.kind === "roster" ? event.x : -event.y;
		return { handled: true, render: this.change(handle, this.gesture.value + pointer - (this.gesture.pointer ?? pointer)) };
	}
	private pointer(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.shift || event.alt || event.ctrl) return;
		const handle = this.handles.find((h) => event.x >= h.x && event.x < h.x + h.width && event.y >= h.y && event.y < h.y + h.height);
		if (event.type === "move") {
			const hover = handle?.kind;
			if (hover === this.hover) return;
			this.hover = hover;
			return { handled: true, render: true };
		}
		if (!handle || event.button !== "left") return;
		return this.activate(event, handle);
	}
	private activate(event: TuiMouseEvent, handle: ResizeHandle): TuiMouseEventResult | undefined {
		if (event.type === "press") {
			this.gesture = { kind: handle.kind, start: { ...this.layout }, value: handle.value, handles: this.handles.map((item) => ({ ...item })), pointer: handle.kind === "roster" ? event.x : -event.y };
			return { handled: true, capture: true, render: true };
		}
		if (event.type === "click" && (event.clickCount ?? 1) <= 2) {
			if (event.clickCount === 2) { this.reset(handle.kind); this.save(); }
			return { handled: true, render: event.clickCount === 2 };
		}
	}
	handle(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.width !== this.width || event.height !== this.height) {
			if (this.cancel()) return { handled: true, render: true };
			return;
		}
		if (!Number.isSafeInteger(event.x) || !Number.isSafeInteger(event.y)) return;
		if (this.gesture && !this.keyboard && (event.type === "move" || event.type === "press")) {
			this.cancel();
			// A new press is evaluated only after the committed layout is rendered again.
			return { handled: true, render: true };
		}
		return this.captured(event) ?? this.pointer(event);
	}
}
