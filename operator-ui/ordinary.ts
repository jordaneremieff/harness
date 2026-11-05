import { realpathSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { type Destination, NavigationFrame } from "./frame.ts";
import type { Action, OperatorView, ViewHost, ViewTarget } from "./view.ts";

export const OPERATOR_VIEW_PUBLISH = "harness:operator-view:publish";
export const OPERATOR_VIEW_REQUEST = "harness:operator-view:request";
export const OPERATOR_FRAME_OPEN = "harness:operator-frame:open";

/** One destination an owner offers in ordinary Pi. */
export interface OrdinaryView {
	/** Stable identity inside the owner, for example "stash". */
	readonly id: string;
	/** Plain label, at most 24 characters. */
	readonly label: string;
	/** The owner's registered command that opens this destination, before any collision suffix. */
	readonly command: { readonly name: string; readonly args?: string };
	/** Sort position among the frame's tabs; lower first. */
	readonly order?: number;
	/** Trusted in-process content, bound to the current context when the view opens. */
	readonly view: (ctx: ExtensionContext, host: ViewHost) => OperatorView;
}

export interface OperatorViewPublication {
	readonly version: 2;
	/** Resolved module path of the announcing extension entrypoint. */
	readonly owner: string;
	readonly views: readonly OrdinaryView[];
}

/** A published destination, keyed by owner plus identity. */
export interface PublishedView extends OrdinaryView {
	readonly owner: string;
	readonly key: string;
}

interface FrameOpenRequest {
	readonly version: 1;
	readonly key: string;
	handled: boolean;
}

type Bus = ExtensionAPI["events"];
/** What the ordinary frame needs from Pi: the event bus, the command registry and shutdown events. */
export type FrameApi = Pick<ExtensionAPI, "events" | "getCommands" | "on">;

const MAX_LABEL = 24;
const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function viewKey(owner: string, id: string): string {
	return `${owner}\u0000${id}`;
}

function readCommand(value: unknown): OrdinaryView["command"] | undefined {
	if (!isRecord(value) || typeof value.name !== "string" || !value.name) return undefined;
	if (value.args !== undefined && typeof value.args !== "string") return undefined;
	return { name: value.name, ...(typeof value.args === "string" ? { args: value.args } : {}) };
}

function readView(entry: unknown, owner: string): PublishedView | undefined {
	if (!isRecord(entry) || typeof entry.id !== "string" || !ID.test(entry.id)) return undefined;
	if (typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > MAX_LABEL) return undefined;
	const command = readCommand(entry.command);
	if (!command || typeof entry.view !== "function") return undefined;
	return {
		id: entry.id,
		label: entry.label.trim(),
		command,
		...(typeof entry.order === "number" && Number.isFinite(entry.order) ? { order: entry.order } : {}),
		view: entry.view as OrdinaryView["view"],
		owner,
		key: viewKey(owner, entry.id),
	};
}

/** Accept one version-2 publication; a malformed entry is dropped, never guessed. */
export function readPublication(value: unknown): { owner: string; views: PublishedView[] } | undefined {
	if (!isRecord(value) || value.version !== 2 || typeof value.owner !== "string" || !value.owner || !Array.isArray(value.views)) return undefined;
	const owner = value.owner;
	const views = value.views.flatMap((entry) => readView(entry, owner) ?? []);
	return { owner, views };
}

/**
 * Announce this owner's destinations: answer every request, and emit once now so a consumer that
 * loaded first sees them. Pi's bus calls synchronous handlers immediately, so both load orders meet.
 */
export function publishOperatorViews(pi: Pick<ExtensionAPI, "events">, publication: OperatorViewPublication): void {
	pi.events.on(OPERATOR_VIEW_REQUEST, (request) => {
		if (isRecord(request) && request.version === 2) pi.events.emit(OPERATOR_VIEW_PUBLISH, publication);
	});
	pi.events.emit(OPERATOR_VIEW_PUBLISH, publication);
}

/** A live registry of published destinations. A publication replaces that owner's entries only. */
export function collectOperatorViews(bus: Bus, changed?: () => void): { views(): readonly PublishedView[]; dispose(): void } {
	const byOwner = new Map<string, PublishedView[]>();
	const off = bus.on(OPERATOR_VIEW_PUBLISH, (value) => {
		const publication = readPublication(value);
		if (!publication) return;
		byOwner.set(publication.owner, publication.views);
		changed?.();
	});
	bus.emit(OPERATOR_VIEW_REQUEST, { version: 2 });
	return {
		views: () =>
			[...byOwner.values()]
				.flat()
				.sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.label.localeCompare(b.label)),
		dispose: off,
	};
}

/** Pi appends `:<n>` to the invocation name when several extensions register one command name. */
function registeredName(invocationName: string): string {
	return invocationName.replace(/:\d+$/u, "");
}

function samePath(left: string, right: string, real: Map<string, string>): boolean {
	if (left === right) return true;
	const resolve = (value: string) => {
		const known = real.get(value);
		if (known !== undefined) return known;
		let resolved = value;
		try {
			resolved = realpathSync(value);
		} catch {
			// An unresolvable path only matches itself.
		}
		real.set(value, resolved);
		return resolved;
	};
	return resolve(left) === resolve(right);
}

export type OwnerResolution = { readonly registration: SlashCommandInfo } | { readonly unavailable: string };

/**
 * Bind a destination to its owner's current registration of the named command. No registration
 * from the owner, or more than one, makes it unavailable with the reason.
 */
export function resolveOwner(view: Pick<PublishedView, "owner" | "command">, commands: readonly SlashCommandInfo[]): OwnerResolution {
	const real = new Map<string, string>();
	const owned = commands.filter(
		(command) => command.source === "extension" && registeredName(command.name) === view.command.name && samePath(command.sourceInfo.path, view.owner, real),
	);
	if (owned.length === 1 && owned[0]) return { registration: owned[0] };
	if (owned.length === 0) return { unavailable: `/${view.command.name} is not registered by its owner in this session` };
	return { unavailable: `/${view.command.name} is registered more than once by its owner` };
}

/** Exact registration identity: invocation name, kind, and every provenance field. */
export function commandIdentity(command: SlashCommandInfo): string {
	const info = command.sourceInfo;
	return JSON.stringify([command.name, command.source, info.path, info.source, info.scope, info.origin, info.baseDir ?? null, info.changelogPath ?? null]);
}

export function commandLine(name: string, args: string): string {
	const trimmed = args.trim();
	return trimmed ? `/${name} ${trimmed}` : `/${name}`;
}

export type DispatchOutcome = { kind: "sent"; line: string } | { kind: "changed" } | { kind: "not-extension" };

/** Send an extension command only if its exact registration is still current. */
export function dispatchCommand(
	host: Pick<ExtensionAPI, "getCommands" | "sendUserMessage">,
	command: SlashCommandInfo,
	args: string,
): DispatchOutcome {
	if (command.source !== "extension") return { kind: "not-extension" };
	const identity = commandIdentity(command);
	const current = host.getCommands().find((candidate) => commandIdentity(candidate) === identity);
	if (!current) return { kind: "changed" };
	const line = commandLine(current.name, args);
	host.sendUserMessage(line, { expandPromptTemplates: true });
	return { kind: "sent", line };
}

/** The ordinary session as a view target. */
export function ordinaryTarget(ctx: ExtensionContext): ViewTarget {
	const folder = basename(ctx.cwd || process.cwd()) || "/";
	return { id: ctx.sessionManager.getSessionId(), label: `This session · ${folder}` };
}

const closers = new WeakMap<object, Set<() => void>>();

function shutdownClosers(pi: Pick<ExtensionAPI, "on">): Set<() => void> {
	let set = closers.get(pi);
	if (!set) {
		const created = new Set<() => void>();
		set = created;
		closers.set(pi, created);
		pi.on("session_shutdown", () => {
			for (const close of [...created]) close();
			created.clear();
		});
	}
	return set;
}

/** Rows the inline frame takes: most of the window, with transcript rows kept above it. */
export function frameRows(terminalRows: number, expanded: boolean): number {
	const rows = Math.max(8, Math.floor(terminalRows));
	if (expanded) return Math.max(8, rows - 4);
	return Math.max(8, Math.min(rows - 6, Math.round(rows * 0.6)));
}

export interface OpenFrameOptions {
	/** Destinations this owner supplies directly, in addition to the published ones. */
	readonly local?: readonly PublishedView[];
	/** Show every published view as a tab (the dashboard). By default the frame shows only the opened view. */
	readonly tabs?: boolean;
}

/**
 * Open the ordinary browsing frame in the editor slot below the native transcript, at one
 * destination or, without `start`, at the first. If a frame is already open in this session, it
 * navigates there instead. Every destination is checked against its owner's current command
 * registration when the frame opens and when a publication changes.
 */
export async function openOperatorFrame(pi: FrameApi, ctx: ExtensionContext, start: { owner: string; id: string } | undefined, options: OpenFrameOptions = {}): Promise<void> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify("This view needs the interactive terminal.", "info");
		return;
	}
	const startKey = start ? viewKey(start.owner, start.id) : undefined;
	if (startKey) {
		const request: FrameOpenRequest = { version: 1, key: startKey, handled: false };
		pi.events.emit(OPERATOR_FRAME_OPEN, request);
		if (request.handled) return;
	}
	let cached: Destination[] | undefined;
	const registry = collectOperatorViews(pi.events, () => {
		cached = undefined;
	});
	const local = options.local ?? [];
	// Built once per open and per publication change, not on every paint: command inventory and
	// path resolution are too slow to repeat for each key press.
	const build = (): Destination[] => {
		const seen = new Set<string>();
		const commands = pi.getCommands();
		const all = [...local, ...registry.views()].filter((view) => {
			if (seen.has(view.key)) return false;
			seen.add(view.key);
			return true;
		});
		return all
			.sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.label.localeCompare(b.label))
			.map((view) => {
				const resolution = resolveOwner(view, commands);
				return {
					key: view.key,
					label: view.label,
					...("unavailable" in resolution ? { unavailable: resolution.unavailable } : {}),
					open: (host: ViewHost) => view.view(ctx, host),
				};
			});
	};
	const destinations = (): Destination[] => {
		cached ??= build();
		return cached;
	};
	let expanded = false;
	let frame: NavigationFrame | undefined;
	let after: (() => unknown) | undefined;
	const closing = shutdownClosers(pi);
	let closeFrame = () => {};
	const offOpen = pi.events.on(OPERATOR_FRAME_OPEN, (value) => {
		if (!isRecord(value) || value.version !== 1 || typeof value.key !== "string" || !frame) return;
		frame.navigate(value.key);
		(value as unknown as FrameOpenRequest).handled = frame.activeKey === value.key;
	});
	try {
		await ctx.ui.custom<void>((tui, theme, keys, done) => {
			// Expand uses Pi's own expand binding, as configured.
			const expandKey = keys.getKeys("app.tools.expand")[0] ?? "ctrl+o";
			const controls = (): Action[] => [
				{
					id: "expand",
					label: expanded ? "Shrink" : "Expand",
					key: expandKey,
					primary: true,
					description: expanded ? "Give rows back to the conversation" : "Use most of the window",
					run: () => {
						expanded = !expanded;
						tui.requestRender();
					},
				},
			];
			frame = new NavigationFrame({
				theme,
				target: ordinaryTarget(ctx),
				destinations,
				initial: startKey,
				rows: () => frameRows(tui.terminal.rows, expanded),
				requestRender: () => tui.requestRender(),
				close: (then) => {
					after = then;
					done(undefined);
				},
				controls,
				tabs: options.tabs === true,
			});
			closeFrame = () => frame?.close();
			closing.add(closeFrame);
			return frame;
		});
	} finally {
		closing.delete(closeFrame);
		offOpen();
		registry.dispose();
		frame?.dispose();
		frame = undefined;
	}
	// Pi has restored the editor and its draft by now, so a continuation sees the real editor.
	// The caller waits for an asynchronous continuation, as it waited for the frame.
	await after?.();
}
