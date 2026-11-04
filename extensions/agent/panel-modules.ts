import { pathToFileURL } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { DurableInventorySchema } from "./observation-schema.ts";
import { matchesSchema } from "./schema-check.ts";
import { resolvePanelEntry } from "./display-descriptor.ts";

/** Package contract: docs/conventions/operator-panels.md. The client supplies these facilities to an owner panel. */
export interface OperatorPanelHost {
	readonly target: { readonly id: string; readonly name?: string };
	readonly theme: Theme;
	readonly tui: { requestRender(): void };
	/** Rows the panel receives on the next render. */
	rows(): number;
	/** One owner request through the bound command. Rejects after the panel closed or the attachment changed. */
	request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }>;
	readonly dialogs: {
		select(title: string, choices: readonly { value: string; label: string; description?: string }[]): Promise<string | undefined>;
		confirm(title: string, description: string, action: string): Promise<boolean>;
		input(title: string, options?: { initial?: string; placeholder?: string }): Promise<string | undefined>;
		read(title: string, text: string): Promise<void>;
		notify(text: string, type?: "info" | "warning" | "error"): void;
	};
	/** Return to the conversation. */
	close(): void;
}

export interface OperatorPanelInstance {
	render(width: number): string[];
	handleInput(data: string): void;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	invalidate?(): void;
	dispose(): void;
}

export interface OperatorPanelModule {
	readonly version: 1;
	readonly title: string;
	open(host: OperatorPanelHost): OperatorPanelInstance;
}

/** One advertised panel: usable when `module` is present, otherwise listed with its reason. */
export interface LoadedPanel {
	readonly contribution: string;
	readonly command: string;
	readonly title: string;
	readonly module?: OperatorPanelModule;
	readonly unavailable?: string;
}

export interface PanelModules {
	readonly panels: readonly LoadedPanel[];
	/** One bounded line per contribution whose panel module could not be used. */
	readonly diagnostics: readonly string[];
}

export const noPanelModules: PanelModules = Object.freeze({ panels: [], diagnostics: [] });

const bounded = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 160);
const title = (text: string) => bounded(text).slice(0, 32);

type Importer = (url: string) => Promise<Record<string, unknown>>;
type Contribution = { name: string; source: string; panel?: { version: 1; entry: string; export: "operatorPanel"; command: string } };

function readModule(exported: unknown): OperatorPanelModule {
	if (typeof exported !== "function") throw new Error("export operatorPanel is not a function");
	const value = exported() as Partial<OperatorPanelModule> | null;
	if (typeof value !== "object" || value === null || value.version !== 1 || typeof value.title !== "string" || !title(value.title) || typeof value.open !== "function") {
		throw new Error("operatorPanel() did not return a version 1 panel with a title and an open function");
	}
	return { version: 1, title: title(value.title), open: (host) => value.open!(host) };
}

/**
 * Import each advertised panel module and keep the checked module. A failure stays with its
 * contribution: the panel is listed as unavailable with a bounded reason and nothing else changes.
 * The caller scopes the result to one attached source; nothing here is cached across sources.
 */
export async function loadPanelModules(inventory: unknown, importModule: Importer = (url) => import(url)): Promise<PanelModules> {
	if (!matchesSchema(DurableInventorySchema, inventory)) return { panels: [], diagnostics: ["Host inventory is not readable; no browsers are available here."] };
	const panels: LoadedPanel[] = [];
	const diagnostics: string[] = [];
	for (const contribution of inventory.contributions as readonly Contribution[]) {
		const descriptor = contribution.panel;
		if (!descriptor) continue;
		try {
			const entry = resolvePanelEntry(contribution.source, descriptor);
			const module = readModule((await importModule(pathToFileURL(entry).href))[descriptor.export]);
			panels.push({ contribution: contribution.name, command: descriptor.command, title: module.title, module });
		} catch (error) {
			const reason = bounded(error instanceof Error ? error.message : String(error));
			panels.push({ contribution: contribution.name, command: descriptor.command, title: contribution.name, unavailable: reason });
			diagnostics.push(bounded(`${contribution.name}: browser unavailable here (${reason})`));
		}
	}
	return { panels, diagnostics };
}
