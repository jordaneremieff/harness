/**
 * The policy view in the shared browsing frame. Ordinary Pi binds its operations to the local
 * registry; the attached terminal binds them to the `policy` command route of the selected
 * agent. Titles come first: a rule shows its purpose, a proposal its candidate purpose. Selecting
 * reads; every change is a labelled action with a staged form, and an approval or a data change
 * ends in a complete artifact review whose final action names its effect. Each request binds the
 * revision or target identity of the record the operator read; the owner refuses a changed one.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";
import { type Action, Browser, type Choice, clip, Form, HitMap, type KeyHint, LoadingView, type OperatorView, plainLine, Reader, ReaderView, type ViewHost } from "../../operator-ui/index.ts";
import { supplyDataRevision } from "./data-arguments.ts";
import { candidatePermitsEffectChoice, type PendingProposal, proposalRevision, type RuleSnapshot, ruleStoreHealthLine, targetIdentity } from "./local-rules.ts";
import { type ActivityReadResult, activityDetailLines, activityKey, filteredProposals, filteredRecords, type PolicyActivityRecord, proposalDetailLines, type RuleFireSummary, ruleDetailLines, terminalSafe } from "./panel.ts";
import type { DataReview } from "./panel-protocol.ts";
import { effectiveEffect, effectiveState, permitsEffectChoice, type RuleEffect, type RuleMatchContext, type RuleRecord, selectableForAction } from "./rule.ts";

/** What one completed change answers: the owner's outcome and the registry as it is now. */
export interface PolicyResult {
	readonly outcome: string;
	readonly snapshot: RuleSnapshot;
}

export interface PolicyLoad {
	readonly snapshot: RuleSnapshot;
	readonly fireSummary: RuleFireSummary;
	readonly activity: ActivityReadResult;
	readonly scope: RuleMatchContext;
}

/** The owner's reads and changes; each change binds the revision or identity the view read. */
export interface PolicyOperations {
	load(signal: AbortSignal): Promise<PolicyLoad>;
	refresh(): Promise<RuleSnapshot>;
	inspect(view: "state" | "explain", id: string | undefined): Promise<{ text: string; snapshot: RuleSnapshot }>;
	approve(proposalId: string, effect: RuleEffect | undefined, revision: string): Promise<PolicyResult>;
	reject(proposalId: string, revision: string): Promise<PolicyResult>;
	lifecycle(verb: "disable" | "enable" | "retire", id: string, reason: string, expectedIdentity: string | undefined): Promise<PolicyResult>;
	effect(id: string, effect: RuleEffect, reason: string, expectedIdentity: string | undefined): Promise<PolicyResult>;
	/** Persist the synced observation periods and answer the revision a reset must bind. */
	resetRevision(id: string): Promise<string>;
	reset(id: string, reason: string, revision: string): Promise<PolicyResult>;
	/** One data command: reads answer text; a change answers its review unless the arguments carry its approval. */
	data(args: string): Promise<PolicyResult | { readonly review: DataReview; readonly snapshot: RuleSnapshot }>;
}

type Scope = "rules" | "proposals" | "activity" | "data" | "state";

/** Browsing position that survives leaving and reopening the view. */
export interface PolicyViewState {
	scope: Scope;
	filter: string;
	selected: Partial<Record<Scope, string>>;
}

export function createPolicyViewState(): PolicyViewState {
	return { scope: "rules", filter: "", selected: {} };
}

type Item =
	| { readonly kind: "rule"; readonly key: string; readonly record: RuleRecord }
	| { readonly kind: "proposal"; readonly key: string; readonly proposal: PendingProposal }
	| { readonly kind: "activity"; readonly key: string; readonly record: PolicyActivityRecord }
	| { readonly kind: "data"; readonly key: string; readonly name: string; readonly revision: string }
	| { readonly kind: "state"; readonly key: string };

const SCOPES: ReadonlyArray<{ id: Scope; label: string }> = [
	{ id: "rules", label: "Rules" },
	{ id: "proposals", label: "Proposals" },
	{ id: "activity", label: "Activity" },
	{ id: "data", label: "Data" },
	{ id: "state", label: "State" },
];

const message = (error: unknown) => plainLine(terminalSafe(error instanceof Error ? error.message : String(error)));
const safeLine = (text: string) => plainLine(terminalSafe(text));

/** Keep whitespace and graphemes exactly: an artifact under review is never reflowed. */
export function artifactLines(artifact: string, width: number): string[] {
	const lines: string[] = [];
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	for (const source of terminalSafe(artifact).split("\n")) {
		let line = "";
		let columns = 0;
		for (const { segment } of segmenter.segment(source)) {
			const size = visibleWidth(segment);
			if (line && columns + size > width) {
				lines.push(line);
				line = "";
				columns = 0;
			}
			line += segment;
			columns += size;
		}
		lines.push(line);
	}
	return lines;
}

/**
 * A complete artifact review. The final action stays unavailable until every line has been on
 * screen; a width change starts the reading again because the lines change. Cancel decides nothing.
 */
export class ArtifactReview implements OperatorView {
	readonly title: string;
	focused = false;
	private readonly reader = new Reader();
	private readonly hits = new HitMap();
	private readonly host: ViewHost;
	private readonly artifact: string;
	private readonly label: string;
	private readonly tone: "accent" | "danger";
	private readonly decide: (approved: boolean) => void | Promise<void>;
	private seen: boolean[] = [];
	private width = -1;
	private deciding = false;

	constructor(options: { host: ViewHost; title: string; artifact: string; label: string; tone?: "accent" | "danger"; decide(approved: boolean): void | Promise<void> }) {
		this.host = options.host;
		this.title = options.title;
		this.artifact = options.artifact;
		this.label = options.label;
		this.tone = options.tone ?? "accent";
		this.decide = options.decide;
	}

	private get complete(): boolean {
		return this.seen.length > 0 && this.seen.every(Boolean);
	}

	render(width: number, height: number): string[] {
		const body = Math.max(1, height - 1);
		const columns = Math.max(8, width - 1);
		if (columns !== this.width) {
			this.width = columns;
			this.seen = [];
		}
		this.hits.begin(width, height);
		this.reader.focused = this.focused;
		// New line breaks start the reading again from the top.
		this.reader.setContent(artifactLines(this.artifact, columns), `${this.title}:${columns}`);
		const shown = this.reader.render(width, body, this.host.theme, this.hits, 0, 0);
		const { first, last, total } = this.reader.position;
		if (this.seen.length !== total) this.seen = Array.from({ length: total }, () => false);
		for (let line = first - 1; line < last; line++) this.seen[line] = true;
		const read = this.seen.filter(Boolean).length;
		const progress = this.complete ? `All ${total} lines read · ${this.label} is available` : `Read ${read} of ${total} lines · read every line before ${this.label}`;
		return [...shown, this.host.theme.fg(this.complete ? "success" : "muted", progress)];
	}

	handleInput(data: string): boolean {
		return this.reader.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.hits.handle(event);
	}

	keys(): readonly KeyHint[] {
		return [
			{ keys: ["up", "down"], label: "scroll" },
			{ keys: ["pageUp", "pageDown"], label: "page" },
		];
	}

	actions(): readonly Action[] {
		const label = this.deciding ? `${this.label}…` : this.label;
		return [
			{
				id: "decide",
				label,
				key: "enter",
				short: label.toLocaleLowerCase(),
				primary: true,
				tone: this.tone,
				disabled: this.deciding ? "The request is still running" : this.complete ? undefined : "Read every line of the artifact first",
				run: () => void this.finish(true),
			},
			{ id: "cancel", label: "Cancel", key: "escape", short: "cancel", primary: true, run: () => void this.finish(false) },
		];
	}

	private async finish(approved: boolean): Promise<void> {
		if (this.deciding || (approved && !this.complete)) return;
		this.deciding = true;
		try {
			await this.decide(approved);
		} finally {
			this.deciding = false;
		}
	}
}

function proposalTitle(proposal: PendingProposal): string {
	return safeLine(proposal.candidate?.purpose ?? proposal.reason);
}

/** The final action of an approval names its effect; an exact proposal names its operation. */
function approvalLabel(proposal: PendingProposal, effect: RuleEffect | undefined): string {
	return effect ? `Approve as ${effect}` : `Approve ${proposal.operation}`;
}

class PolicyView {
	readonly browser: Browser<Item>;
	private readonly host: ViewHost;
	private readonly ops: PolicyOperations;
	private readonly state: PolicyViewState;
	private loaded?: PolicyLoad;
	private failure?: string;
	private readonly reads = new Map<string, { text?: string; error?: string }>();
	private pending?: string;

	constructor(host: ViewHost, ops: PolicyOperations, state: PolicyViewState) {
		this.host = host;
		this.ops = ops;
		this.state = state;
		this.browser = new Browser<Item>({
			title: "Policy",
			host,
			key: (item) => item.key,
			line: (item, width, theme) => this.line(item, width, theme),
			detail: (item) => this.detail(item),
			detailKey: (item) => `${item.key}:${this.reads.has(item.key) ? "read" : "listed"}`,
			actions: (item) => this.actions(item),
			scopes: SCOPES,
			scope: () => this.state.scope,
			onScope: (scope) => this.switchScope(scope as Scope),
			search: { value: state.filter, placeholder: "filter by title, id, state or effect", change: (query) => this.filter(query) },
			status: () => this.status(),
			empty: () => this.empty(),
			onSelect: (item) => this.selected(item),
		});
		void this.load();
	}

	private async load(): Promise<void> {
		try {
			this.loaded = await this.ops.load(this.host.signal);
			if (this.host.signal.aborted) return;
			this.failure = undefined;
		} catch (error) {
			if (this.host.signal.aborted) return;
			this.failure = message(error);
		}
		this.refreshItems();
	}

	/** Replace the registry after a change, keep each scope's selection, and drop reads of changed records. */
	private settle(snapshot: RuleSnapshot): void {
		if (this.loaded) this.loaded = { ...this.loaded, snapshot };
		this.reads.clear();
		this.refreshItems();
	}

	private items(): Item[] {
		const loaded = this.loaded;
		if (!loaded) return [];
		const filter = this.state.filter.trim();
		switch (this.state.scope) {
			case "rules":
				return filteredRecords(loaded.snapshot, filter).map((record) => ({ kind: "rule", key: `rule:${record.id}`, record }));
			case "proposals":
				return filteredProposals(loaded.snapshot, filter).map((proposal) => ({ kind: "proposal", key: `proposal:${proposal.id}`, proposal }));
			case "activity":
				return loaded.activity.records
					.filter((record) => !filter || `${record.tool} ${record.classes.join(" ")} ${record.model ?? ""}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
					.map((record) => ({ kind: "activity", key: `activity:${activityKey(record)}`, record }));
			case "data":
				return [...loaded.snapshot.data.values()]
					.filter((binding) => !filter || binding.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
					.map((binding) => ({ kind: "data", key: `data:${binding.name}`, name: binding.name, revision: binding.revision }));
			case "state":
				return [{ kind: "state", key: "state" }];
		}
	}

	private refreshItems(): void {
		this.browser.setItems(this.items(), this.state.selected[this.state.scope]);
		// A kept selection whose read was dropped reads again.
		const selected = this.browser.selected;
		if (selected && !this.reads.has(selected.key)) this.selected(selected);
		this.host.requestRender();
	}

	private filter(query: string): void {
		this.state.filter = query;
		this.refreshItems();
	}

	private switchScope(scope: Scope): void {
		if (scope === this.state.scope) return;
		this.state.scope = scope;
		this.browser.setItems([]);
		this.refreshItems();
	}

	/** Title first; the identity stays visible when the title is shortened, because several rules can share a purpose. */
	private titled(mark: string, title: string, suffix: string, width: number, theme: Theme): string {
		const room = Math.max(12, width - 2 - visibleWidth(suffix) - 1);
		return `${mark} ${clip(title, room)} ${theme.fg("dim", suffix)}`;
	}

	private line(item: Item, width: number, theme: Theme): string {
		switch (item.kind) {
			case "rule": {
				const state = effectiveState(item.record);
				const mark = theme.fg(state === "active" ? (effectiveEffect(item.record) === "block" ? "error" : "accent") : "dim", state === "active" ? "●" : "○");
				const standing = state === "active" ? effectiveEffect(item.record) : state;
				return this.titled(mark, safeLine(item.record.definition.purpose), `· ${item.record.id} · ${standing}`, width, theme);
			}
			case "proposal":
				return this.titled(theme.fg("warning", "◆"), proposalTitle(item.proposal), `· ${item.proposal.operation} ${item.proposal.ruleId}`, width, theme);
			case "activity": {
				const record = item.record;
				const outcome = record.blocked ? theme.fg("error", "blocked") : record.error ? theme.fg("warning", "error") : theme.fg("dim", "allowed");
				return `${theme.fg("dim", record.at.slice(5, 16).replace("T", " "))} ${safeLine(record.tool)} ${outcome} ${theme.fg("dim", safeLine(record.classes.join(", ")))}`;
			}
			case "data":
				return `${safeLine(item.name)} ${theme.fg("dim", `· revision ${item.revision}`)}`;
			case "state":
				return "Observation state";
		}
	}

	/** Data and state details read once on selection; rules, proposals and activity come from the loaded registry. */
	private selected(item: Item | undefined): void {
		this.state.selected[this.state.scope] = item?.key;
		if (!item || this.reads.has(item.key)) return;
		if (item.kind === "data") this.read(item.key, async () => {
			const answer = await this.ops.data(`show ${item.name}`);
			return "outcome" in answer ? answer.outcome : answer.review.text;
		});
		else if (item.kind === "state") this.read(item.key, async () => (await this.ops.inspect("state", undefined)).text);
	}

	private read(key: string, run: () => Promise<string>): void {
		this.reads.set(key, {});
		run().then(
			(text) => {
				if (this.host.signal.aborted) return;
				this.reads.set(key, { text });
				this.host.requestRender();
			},
			(error: unknown) => {
				if (this.host.signal.aborted) return;
				this.reads.set(key, { error: message(error) });
				this.host.requestRender();
			},
		);
	}

	private detail(item: Item | undefined): string {
		const loaded = this.loaded;
		if (!loaded) return this.failure ? `The policy registry could not be read: ${this.failure}` : "Reading the policy registry…";
		const health = ruleStoreHealthLine(loaded.snapshot.health);
		if (!item) return `${health}\n\nSelect an entry to read it.`;
		const lines = this.detailLines(item, loaded);
		return [health, "", ...lines].map(terminalSafe).join("\n");
	}

	private detailLines(item: Item, loaded: PolicyLoad): string[] {
		switch (item.kind) {
			case "rule":
				return [safeLine(item.record.definition.purpose), "", ...ruleDetailLines(item.record, loaded.scope, loaded.fireSummary)];
			case "proposal":
				return [proposalTitle(item.proposal), "", ...proposalDetailLines(item.proposal)];
			case "activity":
				return activityDetailLines(item.record, loaded.activity);
			default: {
				const read = this.reads.get(item.key);
				if (read?.error) return [`The read failed: ${read.error}`, "Refresh reads it again."];
				return [read?.text ?? "Reading…"];
			}
		}
	}

	private actions(item: Item | undefined): Action[] {
		const actions = item ? this.itemActions(item) : [];
		if (this.state.scope === "data") actions.push(...this.dataActions());
		actions.push({ id: "refresh", label: "Refresh", key: "r", short: "refresh", primary: true, description: "Read the registry, fire counts and activity again", run: () => void this.reload() });
		return actions;
	}

	private async reload(): Promise<void> {
		this.reads.clear();
		this.loaded = undefined;
		this.host.requestRender();
		await this.load();
	}

	private itemActions(item: Item): Action[] {
		switch (item.kind) {
			case "rule":
				return this.ruleActions(item.record);
			case "proposal":
				return this.proposalActions(item.proposal);
			case "activity":
				return item.record.callId === undefined ? [] : [{ id: "explain", label: "Explain call", key: "e", short: "explain", primary: true, run: () => this.host.push((next) => this.explainView(next, `call:${item.record.callId}`)) }];
			case "data":
				return [{ id: "remove", label: "Remove…", tone: "danger", disabled: this.blocked(), description: "Review the removal of this binding", run: () => void this.dataChange(`remove ${item.name} ${item.revision}`) }];
			case "state":
				return [];
		}
	}

	private blocked(): string | undefined {
		return this.pending ? `${this.pending} is running` : undefined;
	}

	/** Why a lifecycle control cannot apply to this rule now, or undefined when it can. */
	private unavailable(record: RuleRecord, verb: "disable" | "enable" | "retire" | "effect"): string | undefined {
		if (this.pending) return `${this.pending} is running`;
		if (verb === "effect" && !permitsEffectChoice(record)) return "This rule permits an exact replacement proposal only";
		return selectableForAction(record, verb) ? undefined : `Not available while the rule is ${effectiveState(record)}`;
	}

	private ruleActions(record: RuleRecord): Action[] {
		const state = effectiveState(record);
		const resettable = state === "active" && record.matcherAvailable;
		return [
			state === "disabled"
				? { id: "enable", label: "Enable…", key: "d", short: "enable", primary: true, disabled: this.unavailable(record, "enable"), run: () => this.host.push((next) => this.lifecycleForm(next, record, "enable")) }
				: { id: "disable", label: "Disable…", key: "d", short: "disable", primary: true, disabled: this.unavailable(record, "disable"), run: () => this.host.push((next) => this.lifecycleForm(next, record, "disable")) },
			{ id: "effect", label: "Effect…", key: "f", short: "effect", primary: true, disabled: this.unavailable(record, "effect"), description: "Steer guides at the next tool boundary; block denies", run: () => this.host.push((next) => this.effectForm(next, record)) },
			{ id: "explain", label: "Explain", key: "e", short: "explain", primary: true, description: "Bounded decision evidence for this rule", run: () => this.host.push((next) => this.explainView(next, record.id)) },
			{ id: "reset", label: "Reset observation…", disabled: this.pending ? `${this.pending} is running` : resettable ? undefined : "No active available observation period", run: () => this.host.push((next) => this.resetView(next, record)) },
			{ id: "retire", label: "Retire…", tone: "danger", disabled: this.unavailable(record, "retire"), run: () => this.host.push((next) => this.lifecycleForm(next, record, "retire")) },
		];
	}

	private proposalActions(proposal: PendingProposal): Action[] {
		const revision = proposalRevision(proposal);
		const choice = candidatePermitsEffectChoice(proposal.candidate) && (proposal.operation === "add" || proposal.operation === "replace");
		return [
			{
				id: "approve",
				label: "Approve…",
				key: "a",
				short: "approve",
				primary: true,
				disabled: this.blocked(),
				description: choice ? "Choose steer or block, then read the complete artifact" : "Read the complete artifact, then approve it",
				run: () => this.host.push((next) => (choice ? this.effectChoice(next, proposal, revision) : this.approvalReview(next, proposal, undefined, revision, () => next.back()))),
			},
			{ id: "reject", label: "Reject…", tone: "danger", disabled: this.blocked(), description: "Read the complete artifact, then reject it", run: () => this.host.push((next) => this.rejectReview(next, proposal, revision)) },
		];
	}

	/** Run one change once, show its outcome, and replace the registry the view shows. */
	private async change(label: string, run: () => Promise<PolicyResult>): Promise<string> {
		this.pending = label;
		try {
			const result = await run();
			if (!this.host.signal.aborted) this.settle(result.snapshot);
			return result.outcome;
		} catch (error) {
			// A refusal reads the registry again so the next attempt starts from the current records.
			const fresh = await this.ops.refresh().catch(() => undefined);
			if (fresh && !this.host.signal.aborted) this.settle(fresh);
			throw error;
		} finally {
			this.pending = undefined;
		}
	}

	private lifecycleForm(host: ViewHost, record: RuleRecord, verb: "disable" | "enable" | "retire"): OperatorView {
		const identity = targetIdentity(record) ?? undefined;
		const label = { disable: "Disable rule", enable: "Enable rule", retire: "Retire rule" }[verb];
		return new Form({
			title: label,
			heading: `${label} ${record.id}`,
			intro: verb === "retire" ? "Retirement withdraws the rule permanently. The owner refuses a rule that changed since you read it." : "The owner refuses a rule that changed since you read it.",
			fields: [
				{ kind: "info", id: "purpose", label: "Purpose", value: safeLine(record.definition.purpose) },
				{ kind: "info", id: "state", label: "Now", value: `${effectiveState(record)} · ${effectiveEffect(record)}` },
				{ kind: "area", id: "reason", label: "Reason", rows: 3, hint: "Recorded with the change" },
			],
			action: { label, tone: verb === "retire" ? "danger" : "accent" },
			host,
			validate: (values) => ((values.reason ?? "").trim() ? undefined : "Write the reason first."),
			submit: async (values) => ({ close: true, notice: { text: await this.change(label, () => this.ops.lifecycle(verb, record.id, (values.reason ?? "").trim(), identity)), kind: "success" } }),
		});
	}

	private effectForm(host: ViewHost, record: RuleRecord): OperatorView {
		const identity = targetIdentity(record) ?? undefined;
		const choices: Choice[] = [
			{ value: "steer", label: "steer", description: "Guidance at the next tool boundary; never denies" },
			{ value: "block", label: "block", description: "Deny the matching call" },
		];
		return new Form({
			title: "Effect",
			heading: `Choose the effect of ${record.id}`,
			intro: "The rule's authority permits steer or block. Neither grants correction authority.",
			fields: [
				{ kind: "choice", id: "effect", label: "Effect", value: effectiveEffect(record), choices },
				{ kind: "area", id: "reason", label: "Reason", rows: 3 },
			],
			action: { label: "Set effect" },
			host,
			validate: (values) => ((values.reason ?? "").trim() ? undefined : "Write the reason first."),
			submit: async (values) => {
				const effect: RuleEffect = values.effect === "block" ? "block" : "steer";
				return { close: true, notice: { text: await this.change("Effect", () => this.ops.effect(record.id, effect, (values.reason ?? "").trim(), identity)), kind: "success" } };
			},
		});
	}

	private resetView(host: ViewHost, record: RuleRecord): OperatorView {
		return new LoadingView("Reset observation", host, async () => {
			const revision = await this.ops.resetRevision(record.id);
			return new Form({
				title: "Reset observation",
				heading: `Start a new observation period for ${record.id}`,
				intro: "Counts and windows of the current period end. The reset binds the revision read now; a later change refuses it.",
				fields: [
					{ kind: "info", id: "revision", label: "Revision", value: revision },
					{ kind: "area", id: "reason", label: "Reason", rows: 3 },
				],
				action: { label: "Start new period", tone: "danger" },
				host,
				validate: (values) => ((values.reason ?? "").trim() ? undefined : "Write the reason first."),
				submit: async (values) => ({ close: true, notice: { text: await this.change("Reset", () => this.ops.reset(record.id, (values.reason ?? "").trim(), revision)), kind: "success" } }),
			});
		});
	}

	private explainView(host: ViewHost, id: string): OperatorView {
		let text = "Reading the decision evidence…";
		this.ops.inspect("explain", id).then(
			(answer) => {
				if (host.signal.aborted) return;
				text = answer.text;
				host.requestRender();
			},
			(error: unknown) => {
				if (host.signal.aborted) return;
				text = `The explanation could not be read: ${message(error)}`;
				host.requestRender();
			},
		);
		return new ReaderView(`Explain ${id}`, host, () => terminalSafe(text));
	}

	private effectChoice(host: ViewHost, proposal: PendingProposal, revision: string): OperatorView {
		return new Form({
			title: "Approve",
			heading: `Approve ${proposal.ruleId}: choose its effect`,
			intro: "The candidate permits steer or block. Choose the effect the operator decision covers, then read the complete artifact.",
			fields: [
				{
					kind: "choice",
					id: "effect",
					label: "Effect",
					value: "steer",
					choices: [
						{ value: "steer", label: "steer", description: "Guidance at the next tool boundary; never denies" },
						{ value: "block", label: "block", description: "Deny the matching call" },
					],
				},
			],
			action: { label: "Read the artifact" },
			host,
			submit: async (values) => {
				// Leaving the review also leaves this choice, so the operator returns to the list.
				host.push((next) => this.approvalReview(next, proposal, values.effect === "block" ? "block" : "steer", revision, () => host.back()));
				return undefined;
			},
		});
	}

	private approvalReview(host: ViewHost, proposal: PendingProposal, effect: RuleEffect | undefined, revision: string, leave: () => void): OperatorView {
		const label = approvalLabel(proposal, effect);
		return new ArtifactReview({
			host,
			title: `${label} · ${proposal.ruleId}`,
			artifact: `Approve ${proposal.operation} proposal ${proposal.id} for ${proposal.ruleId}${effect ? ` with effect ${effect}` : ""} at revision ${revision}.\n\n${JSON.stringify(proposal, null, 2)}`,
			label,
			decide: (approved) => this.decideProposal(host, approved, () => this.ops.approve(proposal.id, effect, revision), label, leave),
		});
	}

	private rejectReview(host: ViewHost, proposal: PendingProposal, revision: string): OperatorView {
		return new ArtifactReview({
			host,
			title: `Reject · ${proposal.ruleId}`,
			artifact: `Reject ${proposal.operation} proposal ${proposal.id} for ${proposal.ruleId} at revision ${revision}.\n\n${JSON.stringify(proposal, null, 2)}`,
			label: "Reject",
			tone: "danger",
			decide: (approved) => this.decideProposal(host, approved, () => this.ops.reject(proposal.id, revision), "Reject", () => host.back()),
		});
	}

	/** Cancel changes nothing; the final action runs once, then the operator returns to the list with its outcome. */
	private async decideProposal(host: ViewHost, approved: boolean, run: () => Promise<PolicyResult>, label: string, leave: () => void): Promise<void> {
		if (!approved) {
			leave();
			this.host.notify("Cancelled. No rule changed.", "info");
			return;
		}
		try {
			const outcome = await this.change(label, run);
			leave();
			this.host.notify(outcome, "success");
		} catch (error) {
			host.notify(`Refused: ${message(error)}. The registry was read again.`, "error");
		}
	}

	private dataActions(): Action[] {
		const loaded = this.loaded;
		return [
			{ id: "set", label: "Set data…", key: "s", short: "set data", primary: true, disabled: this.blocked() ?? (loaded ? undefined : "The registry is not read yet"), description: "Write one named data object; review before it applies", run: () => this.host.push((next) => this.dataForm(next, "set")) },
			{ id: "set-file", label: "Set from file…", disabled: this.blocked() ?? (loaded ? undefined : "The registry is not read yet"), description: "Bind named data to a local file; review before it applies", run: () => this.host.push((next) => this.dataForm(next, "set-file")) },
		];
	}

	private dataForm(host: ViewHost, verb: "set" | "set-file"): OperatorView {
		return new Form({
			title: verb === "set" ? "Set data" : "Set from file",
			heading: verb === "set" ? "Set one named policy data object" : "Bind named policy data to a local file",
			intro: verb === "set" ? "JSON with the data object. The current binding revision is supplied when you omit expectedRevision. The owner checks it and shows the complete review." : "JSON with the file request, for example its path. The owner reads and checks the file and shows the complete review.",
			fields: [{ kind: "area", id: "json", label: "JSON", rows: 10 }],
			action: { label: "Review change" },
			host,
			validate: (values) => {
				try {
					JSON.parse(values.json ?? "");
					return undefined;
				} catch (error) {
					return `The JSON does not parse: ${message(error)}`;
				}
			},
			submit: async (values) => {
				const snapshot = this.loaded?.snapshot;
				const json = verb === "set" && snapshot ? supplyDataRevision(values.json ?? "", snapshot) : (values.json ?? "");
				// Leaving the review also leaves this form, so the operator returns to the data list.
				await this.dataChange(`${verb} ${json}`, host, () => host.back());
				return undefined;
			},
		});
	}

	/** Prepare one data change; a review opens before anything applies, and only its exact approval applies. */
	private async dataChange(args: string, host: ViewHost = this.host, leave?: () => void): Promise<void> {
		this.pending = "Data change";
		let answer: Awaited<ReturnType<PolicyOperations["data"]>>;
		try {
			answer = await this.ops.data(args);
		} catch (error) {
			host.notify(`Refused: ${message(error)}`, "error");
			return;
		} finally {
			this.pending = undefined;
		}
		if (this.host.signal.aborted) return;
		if ("outcome" in answer) {
			this.settle(answer.snapshot);
			host.notify(answer.outcome, "info");
			return;
		}
		const review = answer.review;
		host.push((next) =>
			new ArtifactReview({
				host: next,
				title: review.title,
				artifact: review.text,
				label: review.action,
				tone: review.action.startsWith("Remove") ? "danger" : "accent",
				decide: async (approved) => {
					const back = leave ?? (() => next.back());
					if (!approved) {
						back();
						this.host.notify("Cancelled. No data changed.", "info");
						return;
					}
					try {
						const outcome = await this.change(review.action, async () => {
							const applied = await this.ops.data(review.approval);
							if (!("outcome" in applied)) throw new Error("The owner did not apply the reviewed change; no data changed.");
							return applied;
						});
						back();
						this.host.notify(outcome, "success");
					} catch (error) {
						next.notify(`Refused: ${message(error)}`, "error");
					}
				},
			}),
		);
	}

	private status(): string {
		const loaded = this.loaded;
		if (!loaded) return this.failure ? `The policy registry could not be read; Refresh retries: ${this.failure}` : "Reading the policy registry…";
		const snapshot = loaded.snapshot;
		const degraded = snapshot.health.status === "degraded" ? " · rule store degraded" : "";
		const partial = loaded.fireSummary.partial ? " · fire counts partial" : "";
		const counts: Record<Scope, string> = {
			rules: `${snapshot.records.size} rules`,
			proposals: `${snapshot.pending.length} pending proposals`,
			activity: `${loaded.activity.records.length} recent matched calls${loaded.activity.partial ? " (partial)" : ""}`,
			data: `${snapshot.data.size} named data`,
			state: "Observation state of this session",
		};
		return `${counts[this.state.scope]}${degraded}${partial}`;
	}

	private empty(): string {
		if (!this.loaded) return this.failure ? "Unavailable: the registry could not be read." : "Reading…";
		const filtered = this.state.filter.trim() ? " match the filter" : "";
		const empty: Record<Scope, string> = {
			rules: `No rules${filtered}.`,
			proposals: `No pending proposals${filtered}.`,
			activity: `No matched policy activity${filtered}.`,
			data: `No named policy data${filtered}. Set data… adds one.`,
			state: "",
		};
		return empty[this.state.scope];
	}
}

/** Open the policy view inside a frame. */
export function policyView(host: ViewHost, ops: PolicyOperations, state: PolicyViewState = createPolicyViewState()): OperatorView {
	return new PolicyView(host, ops, state).browser;
}
