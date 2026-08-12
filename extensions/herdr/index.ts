/**
 * herdr: report the pi session identity to herdr's tab bar and sidebar.
 *
 * The session name becomes the herdr tab-bar label; the model is reported as a
 * `$model` sidebar token. The name lives on the tab (herdr's default sidebar
 * line already carries the tab name there), and the model earns the sidebar's
 * second row as the one fact the tab cannot show. Manual herdr labels stay
 * authoritative: an auto-named tab may be taken over, a tab this extension
 * named follows the session, and any other tab label is never touched.
 *
 * Lifecycle state and native session references stay with herdr's own pi
 * integration; this extension reports presentation only. All socket traffic
 * is best-effort: the next event re-synchronizes after any drop.
 *
 * Configuration: PI_HERDR_MAX_NAME_LENGTH caps the tab label (default 60).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	capName,
	classifyFallbackLabel,
	decideTabAction,
	firstUserMessage,
	type LabelEntry,
	type ListedTab,
	sanitizeName,
} from "./naming.ts";
import { registerHerdrCommand } from "./command.ts";
import { HerdrClient, socketEndpoint } from "./socket.ts";
import { AttentionManager } from "./subscribe.ts";
import { createHerdrTools, type ToolDeps } from "./tools.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE = "custom:pi-identity";
const AGENT = "pi";
const DEFAULT_MAX_NAME = 60;

export interface SyncState {
	/** Tab label this extension last wrote; undefined when the tab is not ours. */
	registryLabel: string | undefined;
}

export interface SyncDeps {
	client: HerdrClient;
	paneId: string;
	tabId: string | undefined;
	workspaceId: string | undefined;
	maxName: number;
}

/** Resolve the skill directory packaged beside this module. */
function skillDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "skill", "herdr");
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
 * Report the session identity to herdr: the model as a `$model` sidebar token
 * and the session name as the tab-bar label. Manual tab labels always win.
 */
export async function syncIdentity(
	deps: SyncDeps,
	state: SyncState,
	input: { name?: string; model?: string; firstMessage?: string },
): Promise<void> {
	const name = capName(sanitizeName(input.name ?? ""), deps.maxName) || undefined;
	const model = sanitizeName(input.model ?? "") || undefined;

	await deps.client.send("pane.report_metadata", {
		pane_id: deps.paneId,
		source: SOURCE,
		agent: AGENT,
		seq: deps.client.nextSeq(),
		tokens: { model: model ?? null },
	});

	if (deps.tabId) {
		const tabs = await readTabs(deps);
		if (tabs) {
			const label = name ?? fallbackLabel(deps, tabs, input.firstMessage);
			const action = decideTabAction({
				name: label,
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

/**
 * The guarded first-message label, when the session has no explicit name.
 *
 * Labels of the other tabs in the workspace decide the collision guard, so two
 * sessions that open with the same words keep their numbers instead.
 */
function fallbackLabel(deps: SyncDeps, tabs: ListedTab[], firstMessage: string | undefined): string | undefined {
	if (!firstMessage) return undefined;
	const taken = tabs.filter((tab) => tab.tabId !== deps.tabId).map((tab) => tab.label);
	return classifyFallbackLabel(firstMessage, { maxName: deps.maxName, taken });
}

/** Withdraw the model token and restore a tab this extension named. */
export async function clearIdentity(deps: SyncDeps, state: SyncState): Promise<void> {
	await deps.client.send("pane.report_metadata", {
		pane_id: deps.paneId,
		source: SOURCE,
		agent: AGENT,
		seq: deps.client.nextSeq(),
		tokens: { model: null },
	});

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

/** Rebuild the first user message from the session entries after a resume or reload. */
function readFirstMessage(ctx: ExtensionContext): string | undefined {
	try {
		return firstUserMessage(ctx.sessionManager.getEntries() as unknown as LabelEntry[]);
	} catch {
		return undefined;
	}
}

/** Wire the pi events to the identity sync. Exported for tests. */
export function registerHerdrWithDeps(pi: ExtensionAPI, deps: SyncDeps): SyncState {
	const state: SyncState = { registryLabel: undefined };

	let rootSession = false;
	let firstMessage: string | undefined;
	let chain: Promise<void> = Promise.resolve();
	/** Serialize reports so herdr never receives them out of order. */
	const enqueue = (job: () => Promise<void>): Promise<void> => {
		chain = chain.then(job, () => {});
		return chain;
	};

	/** Label inputs are captured here, so a late job cannot overwrite a newer name. */
	const sync = (ctx: ExtensionContext, eventName?: string): Promise<void> => {
		const name = eventName ?? pi.getSessionName();
		const model = ctx.model?.name;
		const captured = firstMessage;
		return enqueue(() => syncIdentity(deps, state, { name, model, firstMessage: captured }));
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		rootSession = true;
		state.registryLabel = undefined;
		firstMessage = readFirstMessage(ctx);
		return sync(ctx);
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (!rootSession || firstMessage !== undefined) return;
		firstMessage = event.prompt;
		// The tab label must never delay the agent request.
		void sync(ctx);
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
	const deps: SyncDeps = {
		client,
		paneId,
		tabId: process.env.HERDR_TAB_ID || undefined,
		workspaceId: process.env.HERDR_WORKSPACE_ID || undefined,
		maxName: readMaxName(),
	};
	const toolDeps: ToolDeps = {
		client,
		paneId,
		tabId: deps.tabId,
		workspaceId: deps.workspaceId,
	};

	registerHerdrWithDeps(pi, deps);

	// Skill assets ship beside this module; the host discovers them on load.
	pi.on("resources_discover", () => ({ skillPaths: [skillDir()] }));

	// Agent-facing tools and the operator command register once per process.
	for (const tool of createHerdrTools(toolDeps)) pi.registerTool(tool);
	registerHerdrCommand(pi, toolDeps);

	// The attention loop runs only for the TUI session that owns this pane.
	let attention: AttentionManager | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		attention = new AttentionManager({
			client,
			endpoint: socketEndpoint(socketPath),
			source: SOURCE,
			paneId,
			workspaceId: deps.workspaceId,
			notify: (message) => ctx.ui.notify(message),
			setStatus: (text) => ctx.ui.setStatus("herdr", text),
		});
		void attention.start();
	});
	pi.on("session_shutdown", () => {
		attention?.close();
		attention = undefined;
	});
}
