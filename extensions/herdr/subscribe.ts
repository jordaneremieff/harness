/**
 * Attention loop: tell the operator when a sibling agent needs them.
 *
 * herdr already draws agent state in its sidebar, but a pi session covering the
 * whole terminal hides it. This loop watches herdr's agent-status events and
 * raises the two transitions that end a wait: an agent that blocks on input and
 * an agent that finishes.
 *
 * herdr's `pane.agent_status_changed` subscription is per-pane, so the loop
 * subscribes to every sibling pane and widens or narrows that set when panes
 * come and go. It never polls: the pane list is read once to seed the set, then
 * `pane.created` and `pane.closed` events drive every later change.
 */

import type { HerdrClient } from "./socket.ts";
import { SubscriptionClient, type SubscriptionEvent } from "./socket.ts";

const STATUS_EVENT = "pane_agent_status_changed";
/** Subscription filter name for the per-pane status probe. */
const STATUS_SUBSCRIPTION = "pane.agent_status_changed";
const CREATED_EVENT = "pane_created";
const CLOSED_EVENT = "pane_closed";

/** States worth interrupting the operator for. */
const ATTENTION_STATES = new Set(["blocked", "done"]);
/** Minimum spacing between two notifications. */
const THROTTLE_MS = 5000;
/** Deadline for the one pane-list read that seeds the sibling set. */
const SEED_TIMEOUT_MS = 3000;

export interface AgentStatusChange {
	paneId: string;
	workspaceId: string;
	status: string;
	agent: string | undefined;
	label: string;
}

/** Read a herdr agent-status event, or undefined when the line is something else. */
export function parseAgentStatus(event: SubscriptionEvent): AgentStatusChange | undefined {
	if (event.event !== STATUS_EVENT) return undefined;
	const data = event.payload.data as
		| { pane_id?: unknown; workspace_id?: unknown; agent_status?: unknown; agent?: unknown; display_agent?: unknown; title?: unknown }
		| undefined;
	if (!data) return undefined;
	const { pane_id: paneId, workspace_id: workspaceId, agent_status: status } = data;
	if (typeof paneId !== "string" || typeof workspaceId !== "string" || typeof status !== "string") return undefined;
	const agent = typeof data.agent === "string" ? data.agent : undefined;
	const display = typeof data.display_agent === "string" ? data.display_agent : undefined;
	const title = typeof data.title === "string" ? data.title : undefined;
	return { paneId, workspaceId, status, agent, label: display ?? title ?? agent ?? paneId };
}

/** Whether a pane belongs to a workspace other than the session's own. */
export function isForeignWorkspace(eventWorkspace: string | undefined, ownWorkspace: string | undefined): boolean {
	if (!ownWorkspace) return false;
	return eventWorkspace !== ownWorkspace;
}

export interface AttentionDeps {
	/** The pane pi runs in; its own state changes are never announced. */
	paneId: string;
	/** Workspace to watch. Undefined watches every workspace. */
	workspaceId: string | undefined;
	notify: (message: string) => void;
	setStatus: (text: string | undefined) => void;
	now?: () => number;
}

/**
 * Decide which agent-status events reach the operator.
 *
 * State is one timestamp plus the last announced state per pane, so a pane that
 * flickers between working and blocked announces once.
 */
export class AttentionLoop {
	private readonly deps: AttentionDeps;
	private readonly now: () => number;
	private readonly announced = new Map<string, string>();
	private lastNotifiedAt = Number.NEGATIVE_INFINITY;

	constructor(deps: AttentionDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
	}

	/** Handle one subscription event. Returns true when it spoke. */
	handle(event: SubscriptionEvent): boolean {
		const change = parseAgentStatus(event);
		if (!change) return false;
		if (change.paneId === this.deps.paneId) return false;
		if (isForeignWorkspace(change.workspaceId, this.deps.workspaceId)) return false;

		if (!ATTENTION_STATES.has(change.status)) {
			this.announced.delete(change.paneId);
			return false;
		}
		if (this.announced.get(change.paneId) === change.status) return false;
		this.announced.set(change.paneId, change.status);

		const text = `${change.label} ${change.status}`;
		this.deps.setStatus(`herdr: ${text}`);
		const at = this.now();
		if (at - this.lastNotifiedAt < THROTTLE_MS) return false;
		this.lastNotifiedAt = at;
		this.deps.notify(text);
		return true;
	}

	/** Forget announced state; the next event speaks again. */
	reset(): void {
		this.announced.clear();
	}
}

interface PaneRecord {
	pane_id: string;
	workspace_id?: string;
}

export interface AttentionManagerDeps extends AttentionDeps {
	client: HerdrClient;
	endpoint: string;
	source: string;
	transport?: ConstructorParameters<typeof SubscriptionClient>[0]["transport"];
	setTimer?: ConstructorParameters<typeof SubscriptionClient>[0]["setTimer"];
	/** Coalescing window for pane create and close events, in milliseconds. */
	refreshDelayMs?: number;
}

/**
 * Owns the subscription connection and the sibling pane set.
 *
 * One `events.subscribe` connection carries a `pane.created` and `pane.closed`
 * watcher plus one `pane.agent_status_changed` probe per sibling pane. Herdr
 * replays recent history on every subscribe, so create and close events are
 * coalesced into a fresh `pane.list` read instead of being applied one by one;
 * the live list is the source of truth and the probe set converges to it.
 */
export class AttentionManager {
	private readonly deps: AttentionManagerDeps;
	private readonly loop: AttentionLoop;
	private readonly siblings = new Set<string>();
	private readonly subscription: SubscriptionClient;
	private readonly refreshDelayMs: number;
	private refreshTimer: (() => void) | undefined;

	constructor(deps: AttentionManagerDeps) {
		this.deps = deps;
		this.loop = new AttentionLoop(deps);
		this.refreshDelayMs = deps.refreshDelayMs ?? 250;
		this.subscription = new SubscriptionClient({
			endpoint: deps.endpoint,
			source: deps.source,
			params: () => this.buildParams(),
			onEvent: (event) => this.dispatch(event),
			onReady: () => this.loop.reset(),
			transport: deps.transport,
			setTimer: deps.setTimer,
		});
	}

	/** Read the current pane set and open the subscription. */
	async start(): Promise<void> {
		await this.refreshSiblings();
		this.subscription.start();
	}

	/** Tear down the subscription and cancel any pending refresh. */
	close(): void {
		this.refreshTimer?.();
		this.refreshTimer = undefined;
		this.subscription.close();
		this.siblings.clear();
	}

	/** The subscription parameters for the current sibling set, exposed for tests. */
	buildParams(): { subscriptions: Array<Record<string, unknown>> } {
		const subscriptions: Array<Record<string, unknown>> = [
			{ type: "pane.created" },
			{ type: "pane.closed" },
		];
		for (const paneId of this.siblings) {
			subscriptions.push({ type: STATUS_SUBSCRIPTION, pane_id: paneId });
		}
		return { subscriptions };
	}

	/** The sibling panes the loop currently watches, exposed for tests. */
	watchedPanes(): readonly string[] {
		return [...this.siblings];
	}

	/** Coalesce a burst of pane events into one fresh pane.list read. */
	private scheduleRefresh(): void {
		if (this.refreshTimer) return;
		const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms);
			timer.unref?.();
			return () => clearTimeout(timer);
		});
		this.refreshTimer = setTimer(() => {
			this.refreshTimer = undefined;
			void this.refreshSiblings();
		}, this.refreshDelayMs);
	}

	/**
	 * Re-read the live pane list and resubscribe only when the set changed.
	 *
	 * Every subscribe replays recent create and close history, so a
	 * create-or-close event only schedules this read; applying the events
	 * themselves would churn the connection over the replay.
	 */
	private async refreshSiblings(): Promise<void> {
		try {
			const response = (await this.deps.client.request(
				"pane.list",
				this.deps.workspaceId ? { workspace_id: this.deps.workspaceId } : {},
				{ timeoutMs: SEED_TIMEOUT_MS, idempotent: true },
			)) as { panes?: PaneRecord[] };
			const next = new Set<string>();
			for (const pane of response.panes ?? []) {
				if (pane.pane_id === this.deps.paneId) continue;
				if (this.deps.workspaceId && pane.workspace_id !== this.deps.workspaceId) continue;
				next.add(pane.pane_id);
			}
			const changed =
				next.size !== this.siblings.size || [...next].some((paneId) => !this.siblings.has(paneId));
			this.siblings.clear();
			for (const paneId of next) this.siblings.add(paneId);
			if (changed) this.subscription.resubscribe();
		} catch {
			// No fresh list; keep the current set and wait for the next event.
		}
	}

	private dispatch(event: SubscriptionEvent): void {
		if (event.event === CREATED_EVENT || event.event === CLOSED_EVENT) {
			this.scheduleRefresh();
			return;
		}
		this.loop.handle(event);
	}
}
