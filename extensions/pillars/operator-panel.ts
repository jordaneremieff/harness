/**
 * The read-only Pillars reader for the attached Agent terminal. The client imports this
 * module locally and gives it a request route to the `pillars` contribution command; the
 * reader is the same component the ordinary `/pillars browse` route uses. Evaluating this
 * module registers nothing and reads no corpus.
 */

import { truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { PillarsBrowser } from "./browser.ts";
import { readPanelAnswer, type PillarsPanelRequest } from "./panel-protocol.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The facilities the attached terminal passes to an owner panel (docs/conventions/operator-panels.md). */
export interface OperatorPanelHost {
	readonly target: { readonly id: string; readonly name?: string };
	readonly tui: { requestRender(): void };
	rows(): number;
	request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }>;
	close(): void;
}

export interface OperatorPanelInstance {
	render(width: number): string[];
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	invalidate(): void;
	dispose(): void;
}

function open(host: OperatorPanelHost): OperatorPanelInstance {
	const ask = async (request: PillarsPanelRequest, signal?: AbortSignal) => readPanelAnswer(request, (await host.request(request as JsonValue, signal)).data);
	let width = 80;
	let browser: PillarsBrowser | undefined;
	let message = "Read Pillars inventory…";
	let disposed = false;
	const loading = new AbortController();
	void ask({ op: "inventory" }, loading.signal).then(
		(answer) => {
			if (disposed || answer.op !== "inventory") return;
			browser = new PillarsBrowser({
				entries: answer.entries,
				read: async (request, signal) => {
					const page = await ask({ op: "read", resource: request.resource ?? "inventory", ...(request.offset === undefined ? {} : { offset: request.offset }), ...(request.referenceBodyDigest === undefined ? {} : { referenceBodyDigest: request.referenceBodyDigest }) }, signal);
					if (page.op !== "read") throw new Error("unexpected answer");
					return page.page;
				},
				size: () => ({ columns: width, rows: host.rows() }),
				requestRender: () => host.tui.requestRender(),
				close: () => host.close(),
			});
			host.tui.requestRender();
		},
		(error) => {
			if (disposed) return;
			message = `Pillars inventory unavailable: ${error instanceof Error ? error.message : String(error)}. Esc returns.`;
			host.tui.requestRender();
		},
	);
	return {
		render(columns) {
			width = columns;
			return browser ? browser.render(columns) : [truncateToWidth("Pillars · read-only inventory", columns), truncateToWidth(message, columns)];
		},
		handleInput(data) {
			if (browser) browser.handleInput(data);
			else if (data === "\x1b") host.close();
		},
		handleMouse: (event) => browser?.handleMouse(event),
		invalidate: () => browser?.invalidate(),
		dispose() { disposed = true; loading.abort(); browser?.dispose(); },
	};
}

export function operatorPanel(): { readonly version: 1; readonly title: string; open(host: OperatorPanelHost): OperatorPanelInstance } {
	return { version: 1, title: "Pillars", open };
}
