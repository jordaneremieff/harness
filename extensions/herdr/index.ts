/**
 * herdr: report the pi session identity to herdr's UI surfaces.
 *
 * Reports the session name as pane metadata (title, display agent) and as the
 * tab-bar label, plus the model as a sidebar token. The pane-border title
 * composes as "<name> · <model>" and falls back to "pi · <model>" while the
 * session is unnamed. Manual herdr labels stay authoritative: an auto-named
 * tab may be taken over, a tab this extension named follows the session, and
 * any other tab or pane label is never touched.
 *
 * Lifecycle state and native session references stay with herdr's own pi
 * integration; this extension reports presentation only. All socket traffic
 * is best-effort: the next event re-synchronizes after any drop.
 *
 * Configuration: PI_HERDR_MAX_NAME_LENGTH caps reported names (default 60).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { capName, composeBorderLabel, decideTabAction, sanitizeName, type ListedTab } from "./naming.ts";
import { HerdrClient, socketEndpoint } from "./socket.ts";

const SOURCE = "custom:pi-identity";
const AGENT = "pi";
const DEFAULT_MAX_NAME = 60;

export interface SyncState {
	/** Tab label this extension last wrote; undefined when the tab is not ours. */
	registryLabel: string | undefined;
	/** Whether a display_agent report is currently in effect. */
	displayAgentSet: boolean;
	/** Whether a title report is currently in effect. */
	titleSent: boolean;
}

export interface SyncDeps {
	client: HerdrClient;
	paneId: string;
	tabId: string | undefined;
	workspaceId: string | undefined;
	maxName: number;
}

interface PaneListResult {
	panes?: { pane_id?: string; label?: string | null }[];
}

interface TabListResult {
	tabs?: { tab_id?: string; label?: string }[];
}

function readMaxName(): number {
	const raw = process.env.PI_HERDR_MAX_NAME_LENGTH;
	if (!raw) return DEFAULT_MAX_NAME;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_NAME;
	return Math.min(parsed, 80);
}

function workspaceOf(deps: SyncDeps): string | undefined {
	return deps.workspaceId ?? deps.tabId?.split(":")[0];
}

type PaneLabelRead = { known: true; label: string | undefined } | { known: false };

/** Read the pane's manual label. Failure stays distinct from a known empty label. */
async function readManualPaneLabel(deps: SyncDeps): Promise<PaneLabelRead> {
	try {
		const workspaceId = workspaceOf(deps);
		const result = (await deps.client.request("pane.list", workspaceId ? { workspace_id: workspaceId } : {})) as PaneListResult;
		const pane = result.panes?.find((candidate) => candidate.pane_id === deps.paneId);
		if (!pane) return { known: false };
		const trimmed = pane.label?.trim();
		return { known: true, label: trimmed || undefined };
	} catch {
		return { known: false };
	}
}

/** Read the workspace's tabs in display order; undefined on failure. */
async function readTabs(deps: SyncDeps): Promise<ListedTab[] | undefined> {
	if (!deps.tabId) return undefined;
	try {
		const workspaceId = workspaceOf(deps);
		const result = (await deps.client.request("tab.list", workspaceId ? { workspace_id: workspaceId } : {})) as TabListResult;
		const tabs = result.tabs
			?.filter((tab): tab is { tab_id: string; label: string } => Boolean(tab.tab_id && tab.label))
			.map((tab) => ({ tabId: tab.tab_id, label: tab.label }));
		return tabs && tabs.length > 0 ? tabs : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Report the session identity to herdr. Reads the pane's manual label and the
 * tab list first so manual names always win over this extension's labels.
 */
export async function syncIdentity(
	deps: SyncDeps,
	state: SyncState,
	input: { name?: string; model?: string },
): Promise<void> {
	const name = capName(sanitizeName(input.name ?? ""), deps.maxName) || undefined;
	const model = sanitizeName(input.model ?? "") || undefined;
	const border = capName(composeBorderLabel(name, model), deps.maxName);

	const paneLabel = await readManualPaneLabel(deps);

	const params: Record<string, unknown> = {
		pane_id: deps.paneId,
		source: SOURCE,
		agent: AGENT,
		seq: deps.client.nextSeq(),
		tokens: { model: model ?? null },
	};
	if (!paneLabel.known || paneLabel.label) {
		// A manual label, or an unreadable pane state, cannot safely be overwritten.
		params.clear_title = true;
		state.titleSent = false;
	} else {
		params.title = border;
		state.titleSent = true;
	}
	if (name) {
		params.display_agent = name;
		state.displayAgentSet = true;
	} else if (state.displayAgentSet) {
		params.clear_display_agent = true;
		state.displayAgentSet = false;
	}
	await deps.client.send("pane.report_metadata", params);

	if (deps.tabId) {
		const tabs = await readTabs(deps);
		if (tabs) {
			const action = decideTabAction({
				name,
				tabId: deps.tabId,
				tabs,
				registryLabel: state.registryLabel,
			});
			if (action.type !== "none") {
				await deps.client.send("tab.rename", { tab_id: deps.tabId, label: action.label });
			}
			state.registryLabel = action.registry;
		}
	}
}

/** Withdraw every presentation label this extension may have set. */
export async function clearIdentity(deps: SyncDeps, state: SyncState): Promise<void> {
	await deps.client.send("pane.report_metadata", {
		pane_id: deps.paneId,
		source: SOURCE,
		agent: AGENT,
		seq: deps.client.nextSeq(),
		clear_title: true,
		clear_display_agent: true,
		tokens: { model: null },
	});
	state.titleSent = false;
	state.displayAgentSet = false;

	if (deps.tabId && state.registryLabel !== undefined) {
		const tabs = await readTabs(deps);
		if (tabs) {
			const action = decideTabAction({
				name: undefined,
				tabId: deps.tabId,
				tabs,
				registryLabel: state.registryLabel,
			});
			if (action.type === "restore") {
				await deps.client.send("tab.rename", { tab_id: deps.tabId, label: action.label });
			}
			state.registryLabel = action.registry;
		}
	}
}

/** Wire the pi events to the identity sync. Exported for tests. */
export function registerHerdrWithDeps(pi: ExtensionAPI, deps: SyncDeps): SyncState {
	const state: SyncState = { registryLabel: undefined, displayAgentSet: false, titleSent: false };

	let rootSession = false;
	let chain: Promise<void> = Promise.resolve();
	/** Serialize reports so herdr never receives them out of order. */
	const enqueue = (job: () => Promise<void>): Promise<void> => {
		chain = chain.then(job, () => {});
		return chain;
	};

	const sync = (ctx: ExtensionContext, eventName?: string): Promise<void> => {
		const name = eventName ?? pi.getSessionName();
		const model = ctx.model?.name;
		return enqueue(() => syncIdentity(deps, state, { name, model }));
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		rootSession = true;
		state.registryLabel = undefined;
		return sync(ctx);
	});
	pi.on("session_info_changed", (event, ctx) => {
		if (!rootSession) return;
		return sync(ctx, event.name);
	});
	pi.on("model_select", (_event, ctx) => {
		if (!rootSession) return;
		return sync(ctx);
	});
	pi.on("session_shutdown", (event) => {
		if (!rootSession || event.reason !== "quit") return;
		rootSession = false;
		return enqueue(() => clearIdentity(deps, state));
	});

	return state;
}

export default function registerHerdr(pi: ExtensionAPI): void {
	if (process.env.HERDR_ENV !== "1") return;
	const socketPath = process.env.HERDR_SOCKET_PATH;
	const paneId = process.env.HERDR_PANE_ID;
	if (!socketPath || !paneId) return;

	const client = new HerdrClient({ endpoint: socketEndpoint(socketPath), source: SOURCE });
	registerHerdrWithDeps(pi, {
		client,
		paneId,
		tabId: process.env.HERDR_TAB_ID || undefined,
		workspaceId: process.env.HERDR_WORKSPACE_ID || undefined,
		maxName: readMaxName(),
	});
}
