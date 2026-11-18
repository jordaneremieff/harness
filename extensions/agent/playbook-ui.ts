import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import type { Choice } from "./view-form.ts";
import type { View, ViewHost, ViewTarget } from "./view-model.ts";
import { plainLine } from "./view-text.ts";
import { HANDLE_PATTERN } from "./identity.ts";
import { STORAGE_STATUS_ID_PATTERN } from "./storage-status.ts";
import { bundledPlaybooks, type PlaybookCatalog } from "./playbook-catalog.ts";
import { configurationPlaybook } from "./configuration.ts";
import type { PlaybookTargetState } from "./playbook-browser.ts";

export const PLAYBOOK_HELP = [
	"/agent playbook [name or off]",
	"/agent playbook <@handle or exact agent ID> [name or off]",
	"/agent playbook --import <bundled starter>",
	"Show, choose or import a playbook. A playbook sets defaults for how a session divides work.",
	"Off leaves that choice to each task.",
	"In an attached terminal, commands without an explicit target refer to the selected agent.",
].join("\n");

const handle = new RegExp(HANDLE_PATTERN, "u");
const identity = new RegExp(`${STORAGE_STATUS_ID_PATTERN.slice(0, -1)}(?::([1-9][0-9]*))?$`, "u");

export function isPlaybookTarget(value: string): boolean {
	if (value.startsWith("@")) return value.length <= 65 && handle.test(value.slice(1));
	const match = identity.exec(value);
	return match !== null && (match[1] === undefined || Number.isSafeInteger(Number(match[1])));
}

type PlaybookCommand = { kind: "show"; target?: string } | { kind: "set"; target?: string; name: string } | { kind: "import"; name: string };

export function parsePlaybookCommand(args: readonly string[]): PlaybookCommand {
	const [first, second] = args;
	if (args.length === 0) return { kind: "show" };
	if (first === "--import" && args.length === 2 && second !== "off") return { kind: "import", name: configurationPlaybook(second) };
	if (isPlaybookTarget(first) && args.length <= 2) {
		return second === undefined ? { kind: "show", target: first } : { kind: "set", target: first, name: configurationPlaybook(second) };
	}
	if (args.length === 1 && !first.startsWith("@")) return { kind: "set", name: configurationPlaybook(first) };
	throw new Error(`Use an exact @handle or agent ID for an agent target.\n${PLAYBOOK_HELP}`);
}

export function playbookCatalogText(catalog: PlaybookCatalog | undefined): string {
	if (!catalog) return "Playbook catalogue is unavailable here.";
	return [
		`Playbooks: ${catalog.state}`,
		`Directory: ${plainLine(catalog.dir)}`,
		...(catalog.entries.length ? catalog.entries.map(({ name, summary }) => `${name}: ${summary}`) : ["No installed playbooks found."]),
		...(catalog.state === "missing" ? ["Bundled starters (not installed):", ...bundledPlaybooks().map(({ name, summary }) => `${name}: ${summary}`)] : []),
		...(catalog.diagnostics.length ? ["Diagnostics:", ...catalog.diagnostics] : []),
	].join("\n");
}

/** Empty preserves an unknown, unsupported or unavailable selection until the operator picks an explicit value. */
export function playbookChoices(catalog: PlaybookCatalog | undefined, empty: Choice): Choice[] {
	return [empty, ...(catalog?.state === "ready" ? catalog.entries.map(({ name, summary }) => ({ value: name, label: name, description: summary }))
		: catalog?.state === "missing" ? bundledPlaybooks().map(({ name, summary }) => ({ value: name, label: name, description: `Bundled, not installed · ${summary}` })) : [])];
}

export async function playbookCompletions(rest: string, catalog: PlaybookCatalog | undefined, targets: () => Promise<readonly AutocompleteItem[]>): Promise<AutocompleteItem[] | null> {
	const [first, next = "", extra] = rest.split(/\s+/u);
	const secondSlot = /\s/u.test(rest);
	if (extra !== undefined || (secondSlot && first !== "--import" && !isPlaybookTarget(first))) return null;
	const choices = first === "--import" && secondSlot
		? bundledPlaybooks().map(({ name, summary }) => ({ value: name, label: name, description: summary }))
		: [
			{ value: "off", label: "off", description: "Clear the playbook" },
			...playbookChoices(catalog, { value: "", label: "" }).slice(1),
			...(!secondSlot ? [{ value: "--import ", label: "--import", description: "Review one bundled starter" }, ...await targets().catch(() => [])] : []),
		];
	const word = secondSlot ? next : first;
	// A complete name needs no menu, so Enter runs the command instead of accepting a completion.
	if (choices.some((item) => item.value === word) && !choices.some((item) => item.value !== word && item.value.startsWith(word))) return null;
	return fuzzyFilter(choices, word, (item) => `${item.value} ${item.label}`).map((item) => ({
		...item, value: `playbook ${secondSlot ? `${first} ` : ""}${item.value}`,
	}));
}

interface PlaybookSelection {
	name: string | null;
	origin: "operator" | "creator" | "unset";
	actor?: string;
}

export function playbookSelection(value: unknown): PlaybookSelection | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const { name, origin, actor } = value as Partial<PlaybookSelection>;
	if ((name !== null && typeof name !== "string") || (origin !== "operator" && origin !== "creator" && origin !== "unset")) return undefined;
	return { name, origin, ...(typeof actor === "string" ? { actor } : {}) };
}

export function playbookSelectionText(value: PlaybookSelection | undefined, catalog?: PlaybookCatalog): string {
	if (!value) return "Playbook: unknown (host selection unavailable)";
	const name = value.name === null ? (value.origin === "unset" ? "not selected" : "off") : plainLine(value.name);
	const summary = catalog?.state === "ready" ? catalog.entries.find((item) => item.name === value.name)?.summary : undefined;
	const local = catalog && value.name !== null ? ` · ${summary ?? "unavailable in the local catalogue; see Playbooks in Help"}` : "";
	return `Playbook: ${name} (${value.origin}${value.actor ? `: ${plainLine(value.actor)}` : ""})${local}`;
}

/** A native agent's choice in the terms of the playbook browser. */
export function nativeTargetState(value: PlaybookSelection | undefined): PlaybookTargetState {
	if (!value) return { saved: undefined, note: "The agent's host did not report its choice" };
	const origin = value.origin === "operator" ? "you chose it" : value.origin === "creator" ? "set by its creator" : undefined;
	return { saved: value.name, ...(origin ? { origin } : {}) };
}

export type PlaybookControl = (method: string, input: Record<string, unknown>) => Promise<unknown>;

export async function readNativePlaybook(control: PlaybookControl, target: string): Promise<PlaybookSelection | undefined> {
	return control("playbook-read", { sessionId: target }).then(playbookSelection, () => undefined);
}

export function requirePlaybookReceipt(response: unknown, name: string): PlaybookSelection {
	const result = response as { outcome?: unknown; playbook?: unknown; error?: unknown; reason?: unknown } | undefined;
	const saved = playbookSelection(result?.playbook);
	if (result?.outcome === "failed" || !saved || saved.name !== (name === "off" ? null : name)) {
		const reason = result?.error ?? result?.reason;
		throw new Error(typeof reason === "string" ? plainLine(reason).slice(0, 240) : "The host did not confirm the playbook change.");
	}
	return saved;
}

export async function configureNativePlaybook(control: PlaybookControl, target: string, name: string): Promise<string> {
	const response = await control("configure", { sessionId: target, playbook: name, origin: "operator" });
	return `${target}: ${playbookSelectionText(requirePlaybookReceipt(response, name))} · applies to the next model request`;
}

interface PlaybookPage {
	title: string;
	text: string;
	target?: ViewTarget;
	open?(host: ViewHost): View;
}

/** One editor-slot view per extension instance, including the time spent reading its target. */
export class PlaybookViews {
	private active?: AbortController;

	get showing(): boolean { return this.active !== undefined; }
	close(): void { this.active?.abort(); }

	async show(ctx: ExtensionContext, read: (signal: AbortSignal) => PlaybookPage | Promise<PlaybookPage>): Promise<void> {
		if (this.active) return;
		const controller = new AbortController();
		this.active = controller;
		try {
			const page = await read(controller.signal);
			if (controller.signal.aborted) return;
			if (ctx.mode !== "tui" || !ctx.hasUI) ctx.ui.notify(page.text, "info");
			else await openPage(ctx, page, controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) throw error;
		} finally {
			this.active = undefined;
		}
	}
}

async function openPage(ctx: ExtensionContext, page: PlaybookPage, signal: AbortSignal): Promise<void> {
	const [{ Inspector }, { ReaderView }] = await Promise.all([import("./inspector.ts"), import("./view-reader.ts")]);
	if (signal.aborted) return;
	const target = page.target ?? { id: ctx.sessionManager.getSessionId(), label: "This session" };
	let frame: InstanceType<typeof Inspector> | undefined;
	let after: (() => unknown) | undefined;
	const close = () => frame?.close();
	try {
		await ctx.ui.custom<void>((tui, theme, keys, done) => {
			frame = new Inspector({
				theme, target, title: page.title, expandKey: keys.getKeys("app.tools.expand")[0] ?? "ctrl+o",
				open: page.open ?? ((host) => new ReaderView(page.title, host, () => page.text)),
				rows: (expanded) => Math.max(4, expanded ? tui.terminal.rows - 4 : Math.round(tui.terminal.rows * 0.6)),
				requestRender: () => tui.requestRender(),
				close: (then) => { after = then; done(); },
			});
			if (signal.aborted) close();
			else signal.addEventListener("abort", close, { once: true });
			return frame;
		});
	} finally {
		signal.removeEventListener("abort", close);
		frame?.dispose();
	}
	if (!signal.aborted) await after?.();
}
