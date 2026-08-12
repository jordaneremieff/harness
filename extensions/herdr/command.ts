/**
 * The `/herdr` operator command: jump to a sibling pane or agent.
 *
 * The command lists the agents and panes herdr tracks and focuses the one the
 * operator picks. It is operator-only and never callable by the model; it adds
 * no tools and touches no destructive method.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { callHerdr, type ToolDeps } from "./tools.ts";

interface PickerPane {
	pane_id: string;
	workspace_id?: string;
	tab_id?: string;
	agent?: string | null;
	agent_status?: string;
	label?: string | null;
	title?: string | null;
	cwd?: string | null;
	focused?: boolean;
}

export interface PickerItem {
	/** Text shown in the selector. */
	label: string;
	/** Target pane id to focus when this item is chosen. */
	paneId: string;
}

/**
 * Build the picker list from live pane and agent records.
 *
 * Pure: the same records produce the same items, so the shape is testable
 * without a socket. The session's own pane is marked but still listed, because
 * the operator may want to confirm where they are.
 */
export function shapePickerItems(panes: PickerPane[], selfPaneId: string): PickerItem[] {
	return panes
		.slice()
		.sort((a, b) => (a.focused === b.focused ? 0 : a.focused ? -1 : 1))
		.map((pane) => {
			const name = pane.label ?? pane.title ?? pane.agent ?? pane.pane_id;
			const status = pane.agent_status ?? "unknown";
			const marker = pane.pane_id === selfPaneId ? " (this pane)" : pane.focused ? " (focused)" : "";
			return {
				label: `${name} — ${pane.pane_id} — ${status}${marker}`,
				paneId: pane.pane_id,
			};
		});
}

/** Completion labels for `/herdr <prefix>`, matching pane ids and agent names. */
export function completeHerdrTargets(panes: PickerPane[], prefix: string): PickerItem[] {
	const lower = prefix.toLowerCase();
	return shapePickerItems(panes, "").filter((item) => item.label.toLowerCase().includes(lower));
}

/** Register the `/herdr` command against a herdr client. Exported for tests. */
export function registerHerdrCommand(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerCommand("herdr", {
		description: "Jump to a herdr pane or agent by name.",
		async getArgumentCompletions(prefix: string) {
			const panes = await readPanes(deps);
			return completeHerdrTargets(panes, prefix).map((item) => ({ value: item.paneId, label: item.label }));
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/herdr is available in interactive mode only.", "warning");
				return;
			}
			const panes = await readPanes(deps);
			if (panes.length === 0) {
				ctx.ui.notify("herdr reports no panes.", "info");
				return;
			}

			const target = args.trim();
			if (target) {
				await focusTarget(deps, ctx, target, panes);
				return;
			}

			const items = shapePickerItems(panes, deps.paneId);
			const labels = items.map((item) => item.label);
			const choice = await ctx.ui.select("herdr — focus a pane", labels);
			if (choice === undefined) return;
			const index = labels.indexOf(choice);
			if (index === -1) return;
			await focusPane(deps, ctx, items[index].paneId);
		},
	});
}

async function readPanes(deps: ToolDeps): Promise<PickerPane[]> {
	try {
		const response = (await callHerdr(deps, "pane.list", deps.workspaceId ? { workspace_id: deps.workspaceId } : {}, {
			idempotent: true,
		})) as { panes?: PickerPane[] };
		return response.panes ?? [];
	} catch {
		return [];
	}
}

async function focusTarget(deps: ToolDeps, ctx: ExtensionCommandContext, target: string, panes: PickerPane[]): Promise<void> {
	const match = panes.find(
		(pane) => pane.pane_id === target || pane.agent === target || pane.label === target,
	);
	if (!match) {
		ctx.ui.notify(`no herdr pane or agent named ${target}.`, "warning");
		return;
	}
	await focusPane(deps, ctx, match.pane_id);
}

async function focusPane(deps: ToolDeps, ctx: ExtensionCommandContext, paneId: string): Promise<void> {
	try {
		await callHerdr(deps, "pane.focus", { pane_id: paneId });
		ctx.ui.setStatus("herdr", paneId);
	} catch (err) {
		ctx.ui.notify(`could not focus ${paneId}: ${err instanceof Error ? err.message : String(err)}`, "warning");
	}
}
