import { pathToFileURL } from "node:url";
import { type Destination, type JsonValue, type OperatorPanelModule, plainLine, readPanelModule, type ViewHost } from "../../operator-ui/index.ts";
import { DurableInventorySchema } from "./observation-schema.ts";
import { matchesSchema } from "./schema-check.ts";
import { resolvePanelEntry } from "./display-descriptor.ts";

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

/**
 * Import each advertised panel module and keep the checked module. A failure stays with its
 * contribution: the panel is listed as unavailable with a bounded reason and nothing else changes.
 * The caller scopes the result to one source; nothing here is cached across sources.
 */
export async function loadPanelModules(inventory: unknown, importModule: Importer = (url) => import(url)): Promise<PanelModules> {
	if (!matchesSchema(DurableInventorySchema, inventory)) return { panels: [], diagnostics: ["Host inventory is not readable; no owner views are available here."] };
	const panels: LoadedPanel[] = [];
	const diagnostics: string[] = [];
	for (const contribution of inventory.contributions as readonly Contribution[]) {
		const descriptor = contribution.panel;
		if (!descriptor) continue;
		try {
			const entry = resolvePanelEntry(contribution.source, descriptor);
			const module = readPanelModule((await importModule(pathToFileURL(entry).href))[descriptor.export]);
			panels.push({ contribution: contribution.name, command: descriptor.command, title: title(module.title), module });
		} catch (error) {
			const reason = bounded(error instanceof Error ? error.message : String(error));
			panels.push({ contribution: contribution.name, command: descriptor.command, title: contribution.name, unavailable: reason });
			diagnostics.push(bounded(`${contribution.name}: owner view unavailable here (${reason})`));
		}
	}
	return { panels, diagnostics };
}

/** The owner route of one captured target: one request through the panel's bound command. */
export type PanelRequest = (command: string, data: JsonValue, signal: AbortSignal) => Promise<{ text: string; data?: JsonValue }>;

/** Settle at once when the view is left; a late answer is dropped, never applied. */
function withdrawable<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("The view closed; the request was withdrawn"));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new Error("The view closed; the request was withdrawn"));
		signal.addEventListener("abort", abort, { once: true });
		request.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

/**
 * Frame destinations for the loaded panels of one target. Each view's requests carry the target
 * captured here and its own command; leaving the view withdraws its unanswered requests through
 * `request`'s signal, and nothing is resent.
 */
export function panelDestinations(panels: PanelModules, targetKey: string, request: PanelRequest): Destination[] {
	return panels.panels.map((panel) => ({
		key: `${targetKey}\u0000${panel.contribution}`,
		label: plainLine(panel.title),
		...(panel.module ? {} : { unavailable: panel.unavailable ?? "module not loaded" }),
		open: (host: ViewHost) => {
			const module = panel.module;
			if (!module) throw new Error(panel.unavailable ?? "module not loaded");
			return module.open({
				...host,
				request: (data, signal) => {
					const combined = signal ? AbortSignal.any([signal, host.signal]) : host.signal;
					return withdrawable(request(panel.command, data, combined), combined);
				},
			});
		},
	}));
}
