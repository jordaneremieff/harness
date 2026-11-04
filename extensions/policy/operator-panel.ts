/**
 * The policy panel for the attached Agent terminal. The client imports this module locally and
 * gives it a request route to the `policy` contribution command; the panel, the approval reader,
 * and the effect-labelled final action are the ones the ordinary `/policy` overlay uses. Every
 * read and mutation runs in the host against the bound conversation's scope with a panel audit.
 * Evaluating this module registers nothing and opens no store.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { proposalRevision, targetIdentity, type RuleSnapshot } from "./local-rules.ts";
import { PolicyApprovalPanel, PolicyPanel, type PanelActionResult, type PolicyPanelControl, type PolicyPanelData } from "./panel.ts";
import { deserializeFireSummary, deserializeSnapshot, readPanelAnswer, type PolicyPanelRequest } from "./panel-protocol.ts";
import type { RuleEffect, RuleMatchContext } from "./rule.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The facilities the attached terminal passes to an owner panel (docs/conventions/operator-panels.md). */
export interface OperatorPanelHost {
	readonly target: { readonly id: string; readonly name?: string };
	readonly theme: Theme;
	readonly tui: { requestRender(): void };
	rows(): number;
	request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }>;
	readonly dialogs: {
		select(title: string, choices: readonly { value: string; label: string; description?: string }[]): Promise<string | undefined>;
		input(title: string, options?: { initial?: string; placeholder?: string }): Promise<string | undefined>;
		notify(text: string, type?: "info" | "warning" | "error"): void;
	};
	close(): void;
}

export interface OperatorPanelInstance {
	render(width: number): string[];
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	invalidate(): void;
	dispose(): void;
}

interface Mounted {
	render(width: number): string[];
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	invalidate(): void;
	dispose(): void;
}

/** Mutations and inspections over the host route; results carry the refreshed snapshot. */
function routedActions(host: OperatorPanelHost, ask: (request: PolicyPanelRequest) => Promise<ReturnType<typeof readPanelAnswer>>) {
	const settled = async (request: PolicyPanelRequest): Promise<PanelActionResult> => {
		const answer = await ask(request);
		if (!("outcome" in answer)) throw new Error("unexpected answer");
		return { snapshot: deserializeSnapshot(answer.snapshot), outcome: answer.outcome };
	};
	const inspected = async (view: "state" | "explain" | "data", id?: string): Promise<PanelActionResult> => {
		const answer = await ask({ op: "inspect", view, ...(id === undefined ? {} : { id }) });
		if (answer.op !== "inspect") throw new Error("unexpected answer");
		return { snapshot: deserializeSnapshot(answer.snapshot), outcome: answer.text };
	};
	const reasonFor = async (verb: string, id: string): Promise<string | undefined> => {
		const reason = (await host.dialogs.input(`Reason to ${verb} ${id}`))?.trim();
		return reason || undefined;
	};
	const cancelled = async (snapshot: RuleSnapshot): Promise<PanelActionResult> => ({ snapshot, outcome: "Policy control canceled. No rules changed." });
	const reset = async (id: string, snapshot: RuleSnapshot): Promise<PanelActionResult> => {
		const revision = await ask({ op: "reset-revision", id });
		if (revision.op !== "reset-revision") throw new Error("unexpected answer");
		const reason = await reasonFor("reset", id);
		return reason ? settled({ op: "reset", id, reason, revision: revision.revision }) : cancelled(snapshot);
	};
	const changeEffect = async (id: string, snapshot: RuleSnapshot, expectedIdentity: string | undefined): Promise<PanelActionResult> => {
		const effect = await host.dialogs.select(`Effect for ${id}`, [{ value: "steer", label: "steer" }, { value: "block", label: "block" }]);
		if (effect !== "steer" && effect !== "block") return cancelled(snapshot);
		const reason = await reasonFor("set the effect of", id);
		return reason ? settled({ op: "effect", id, effect, reason, ...(expectedIdentity === undefined ? {} : { expectedIdentity }) }) : cancelled(snapshot);
	};
	const readers: Partial<Record<PolicyPanelControl, () => Promise<PanelActionResult>>> = {
		state: () => inspected("state"),
		data: () => inspected("data"),
	};
	const lifecycle = async (verb: "disable" | "enable" | "retire", id: string, snapshot: RuleSnapshot): Promise<PanelActionResult> => {
		const expectedIdentity = targetIdentity(snapshot.records.get(id)) ?? undefined;
		const reason = await reasonFor(verb, id);
		return reason ? settled({ op: "lifecycle", verb, id, reason, ...(expectedIdentity === undefined ? {} : { expectedIdentity }) }) : cancelled(snapshot);
	};
	const targeted: Partial<Record<PolicyPanelControl, (id: string, snapshot: RuleSnapshot) => Promise<PanelActionResult>>> = {
		explain: (id) => inspected("explain", id),
		reset,
		effect: (id, snapshot) => changeEffect(id, snapshot, targetIdentity(snapshot.records.get(id)) ?? undefined),
		disable: (id, snapshot) => lifecycle("disable", id, snapshot),
		enable: (id, snapshot) => lifecycle("enable", id, snapshot),
		retire: (id, snapshot) => lifecycle("retire", id, snapshot),
	};
	const control = async (action: PolicyPanelControl, id: string | undefined, snapshot: RuleSnapshot): Promise<PanelActionResult> => {
		const reader = readers[action];
		if (reader) return reader();
		if (action === "data-actions") return { snapshot, outcome: "Data imports and bindings run through policy_control in the conversation; this browser lists them only." };
		const run = targeted[action];
		if (!run) throw new Error(`Unsupported panel control: ${action}`);
		if (!id) throw new Error("Select a rule or recorded call first.");
		return run(id, snapshot);
	};
	return {
		control,
		approve: (proposalId: string, effect?: RuleEffect, revision?: string) => settled({ op: "approve", proposalId, ...(effect === undefined ? {} : { effect }), ...(revision === undefined ? {} : { revision }) }),
		reject: (proposalId: string, revision?: string) => settled({ op: "reject", proposalId, ...(revision === undefined ? {} : { revision }) }),
		refresh: async () => {
			const answer = await ask({ op: "refresh" });
			if (answer.op !== "refresh") throw new Error("unexpected answer");
			return deserializeSnapshot(answer.snapshot);
		},
	};
}

function open(host: OperatorPanelHost): OperatorPanelInstance {
	const ask = async (request: PolicyPanelRequest, signal?: AbortSignal) => readPanelAnswer(request, (await host.request(request as JsonValue, signal)).data);
	let current: Mounted | undefined;
	let panel: PolicyPanel | undefined;
	let message = "Read policy registry\u2026";
	let disposed = false;
	const loading = new AbortController();
	const mount = (component: Mounted) => { current = component; host.tui.requestRender(); };
	/** The approval reader takes the whole panel area until the operator decides; the final action is labelled for its effect. */
	const confirm = (title: string, artifact: string, actionLabel?: string) => new Promise<boolean>((resolve) => {
		const previous = current;
		const reader = new PolicyApprovalPanel({ title, artifact, actionLabel, tui: host.tui, getMaxRows: () => host.rows(), done: (approved) => { current = previous; host.tui.requestRender(); resolve(approved); } });
		mount(reader);
	});
	const actions = routedActions(host, ask);
	void ask({ op: "load" }, loading.signal).then(
		(answer) => {
			if (disposed || answer.op !== "load") return;
			const data: PolicyPanelData = { snapshot: deserializeSnapshot(answer.snapshot), fireSummary: deserializeFireSummary(answer.fireSummary), activity: answer.activity };
			const scope: RuleMatchContext = answer.scope;
			panel = new PolicyPanel({
				data, scopeContext: scope, theme: host.theme, tui: host.tui, getMaxRows: () => host.rows(),
				done: () => { if (!disposed) host.close(); },
				actionHost: {
					confirm,
					select: (title, options) => host.dialogs.select(title, options.map((value) => ({ value, label: value }))),
					refresh: actions.refresh,
					control: actions.control,
					approve: (proposalId, effect, revision) => actions.approve(proposalId, effect, revision ?? proposalRevisionOf(data.snapshot, proposalId)),
					reject: (proposalId, revision) => actions.reject(proposalId, revision ?? proposalRevisionOf(data.snapshot, proposalId)),
				},
			});
			mount(panel);
		},
		(error) => {
			if (disposed) return;
			message = `Policy registry unavailable: ${error instanceof Error ? error.message : String(error)}. Esc returns.`;
			host.tui.requestRender();
		},
	);
	return {
		render: (width) => current ? current.render(width) : [truncateToWidth("Policy", width), truncateToWidth(message, width)],
		handleInput(data) {
			if (current) current.handleInput(data);
			else if (data === "\x1b") host.close();
		},
		handleMouse: (event) => current?.handleMouse(event),
		invalidate: () => current?.invalidate(),
		dispose() { disposed = true; loading.abort(); panel?.dispose(); current = undefined; },
	};
}

/** The revision of the proposal the panel shows, so an approval binds to the artifact the operator read. */
function proposalRevisionOf(snapshot: RuleSnapshot, proposalId: string): string | undefined {
	const proposal = snapshot.pending.find((entry) => entry.id === proposalId);
	return proposal ? proposalRevision(proposal) : undefined;
}

export function operatorPanel(): { readonly version: 1; readonly title: string; open(host: OperatorPanelHost): OperatorPanelInstance } {
	return { version: 1, title: "Policy", open };
}
