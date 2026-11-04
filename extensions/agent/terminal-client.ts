import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DefaultResourceLoader, SettingsManager, getAgentDir, getPackageDir, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, KeybindingsManager, ProcessTerminal, TuiAltScreen, TUI_KEYBINDINGS, setKeybindings, matchesKey, type Component, type ProgramStatus, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { AgentManager, type AgentCaller } from "./manager.ts";
import { createAgentObservationSource, type AgentObservationSource } from "./agent-observation.ts";
import { AgentConsole } from "./agent-console.ts";
import { AgentDashboard, type DashboardOperations } from "./dashboard.ts";
import { agentState, createDashboardState, notifyAgentState, updateDraft, type DashboardState } from "./dashboard-state.ts";
import type { AgentModelInfo } from "./agent-footer.ts";
import { TerminalProgramStatus } from "./terminal-status.ts";
import { ModelChoicesSchema } from "./observation-schema.ts";
import { matchesSchema } from "./schema-check.ts";
import { loadDisplayModules, noDisplayModules, type DisplayModules } from "./display-modules.ts";
import { loadPanelModules, noPanelModules, type PanelModules } from "./panel-modules.ts";
import { PanelScreen } from "./terminal-panel.ts";
import type { JsonValue } from "@earendil-works/chord";
import { ConversationHistory } from "./conversation-view.ts";
import type { AgentConversationSummary, AgentConversationSnapshot } from "./dashboard-types.ts";
import { fitLine } from "./dashboard-layout.ts";
import { readAgentBranch, AgentBranchCache } from "./agent-git.ts";
import { terminalAction } from "./terminal-actions.ts";
import { terminalDialogs } from "./terminal-dialogs.ts";
import { ActionInventory, type ScreenAction } from "./action-inventory.ts";
import { DashboardMouse } from "./dashboard-mouse.ts";
import type { AgentDialogs } from "./dialog-adapter.ts";
import { admittedResult } from "./result-reference.ts";

export function terminalAdmission(receipt: unknown, id: string, mode: "steer" | "followUp"): string {
	const reference = admittedResult(id, receipt);
	const deduped = (receipt as { deduped?: boolean }).deduped === true;
	return `Input ${deduped ? "already admitted" : "admitted"} for ${reference.sessionId} (submission ${reference.submissionId}; requested ${mode === "followUp" ? "follow-up" : "steer"})`;
}

function observedUsageCost(usage: { models?: Record<string, { cost?: { total?: number } }>; tools?: Record<string, { cost?: { total?: number } }> } | undefined): { cost: number; partial: boolean } | undefined {
	if (!usage) return undefined;
	let cost = 0;
	for (const bucket of [usage.models, usage.tools]) {
		for (const item of Object.values(bucket ?? {})) {
			const total = item?.cost?.total;
			if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return { cost: Number.NaN, partial: true };
			cost += total;
		}
	}
	return { cost, partial: false };
}

export type TerminalManager = Pick<AgentManager, "resolveTarget" | "control" | "snapshot" | "dashboardPage" | "observeLive" | "subscribeRoster" | "close"> & Partial<Pick<AgentManager, "collaborate">>;
export interface UnconfirmedTerminalInput { readonly text: string; readonly mode: "steer" | "followUp" }
export interface TerminalControllerOptions {
	manager: TerminalManager;
	caller: AgentCaller;
	state?: DashboardState;
	remember?(id: string): void;
	/** Test seam for the local display-module import; the default imports the advertised file. */
	importModule?(url: string): Promise<Record<string, unknown>>;
}
/** Owns presentation links only. Native work and admission belong to the existing manager/host. */
export class TerminalController {
	readonly state: DashboardState;
	readonly source: AgentObservationSource;
	readonly manager: TerminalManager;
	readonly caller: AgentCaller;
	target?: string;
	previous?: string;
	row?: AgentConversationSummary;
	snapshot?: AgentConversationSnapshot & { nextBefore?: number | null };
	private closed = false;
	private closing?: Promise<void>;
	private generation = 0;
	private readonly histories = new Map<string, ConversationHistory>();
	private readonly failedInputs = new Map<string, UnconfirmedTerminalInput[]>();
	private readonly listeners = new Set<() => void>();
	private readonly off: () => void;
	private readonly remember?: (id: string) => void;
	private readonly importModule?: TerminalControllerOptions["importModule"];
	/** Owner renderers advertised by the attached host. Replaced as a unit when the source changes. */
	display: DisplayModules = noDisplayModules;
	/** Owner browsers advertised by the attached host. Replaced as a unit when the source changes. */
	panels: PanelModules = noPanelModules;
	private displayLoading?: Promise<void>;
	/** Identity changes with the attached source, so views holding an older lookup rebuild their cards. */
	get toolDisplay() { return this.display.lookup; }
	constructor(options: TerminalControllerOptions) {
		this.manager = options.manager;
		this.caller = options.caller;
		this.state = options.state ?? createDashboardState();
		this.remember = options.remember;
		this.importModule = options.importModule;
		this.source = createAgentObservationSource({
			list: (input) => this.manager.dashboardPage(input),
			snapshot: (id, params) => this.manager.snapshot(id, params),
			observeLive: (id, scope, listener, signal) => this.manager.observeLive(id, scope, listener, signal),
			subscribeRoster: (listener) => this.manager.subscribeRoster(listener),
		});
		this.off = this.source.subscribe(() => this.frameChanged());
	}
	get frame() { return this.target ? this.source.frame(this.target) : undefined; }
	get selectionRevision(): number { return this.generation; }
	get availability() { return this.target ? this.source.availability(this.target) : undefined; }
	get draftState() { return this.target ? agentState(this.state, this.target) : undefined; }
	/** Model facts the attached host's runtime reported once for this attachment. Unlisted models stay unknown. */
	private modelCatalog = new Map<string, AgentModelInfo>();
	/** Name, reasoning support and context window of the selected conversation's current model, when the host listed it. */
	currentModelInfo(): AgentModelInfo | undefined {
		const model = this.row?.model;
		return model ? this.modelCatalog.get(`${model.provider}/${model.modelId}`) : undefined;
	}
	private notify(): void { if (!this.closed) for (const listener of this.listeners) listener(); }
	subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private history(id: string): ConversationHistory {
		let history = this.histories.get(id);
		if (!history) { history = new ConversationHistory(); this.histories.set(id, history); }
		return history;
	}
	private frameChanged(): void {
		const frame = this.frame;
		const row = this.row;
		const live = this.availability?.state === "live";
		if (frame && row && this.target && live) {
			const observed = observedUsageCost(frame.status.usage);
			this.row = { ...row, name: frame.status.name, awaiting: frame.status.awaiting,
				state: frame.status.busy ? "working" : "idle",
				...(observed ? { cost: observed.cost, partial: observed.partial } : {}),
				model: frame.status.agent.model ? { ...frame.status.agent.model, thinkingLevel: frame.status.agent.thinkingLevel } : row.model };
			this.setSnapshot({ entries: frame.entries, partial: !frame.coverage.complete, revision: `r${frame.revision}`, nextBefore: frame.nextBefore });
		} else if (row && this.target && this.availability?.state === "unavailable") this.row = { ...row, partial: true };
		this.notify();
	}
	private setSnapshot(snapshot: AgentConversationSnapshot & { nextBefore?: number | null }): void {
		if (!this.target) return;
		const history = this.history(this.target);
		const anchor = this.draftState?.view.anchor?.id;
		history.tail(snapshot, anchor);
		this.snapshot = { ...snapshot, entries: history.entries(anchor), nextBefore: history.earlier() };
	}
	async attach(selector: string): Promise<void> {
		if (this.closed) throw new Error("Terminal is closed");
		const generation = ++this.generation;
		const id = await this.manager.resolveTarget(selector);
		if (this.closed || generation !== this.generation) return;
		const attached = await this.manager.control("attach", { sessionId: id }, this.caller) as { status: { name?: string; cwd?: string; busy: boolean; agent: { model?: { provider: string; modelId: string }; thinkingLevel: string } } };
		if (this.closed || generation !== this.generation) return;
		const page = await this.manager.dashboardPage();
		const status = attached.status;
		// Empty children and rows outside roster coverage remain directly addressable.
		const row: AgentConversationSummary = page.rows.find((candidate) => candidate.id === id) ?? {
			id, storageId: id.split(":")[0], name: status.name, cwd: status.cwd ?? this.caller.cwd,
			state: status.busy ? "working" : "idle", owner: "unknown", modifiedAt: Date.now(),
			cost: Number.NaN, partial: true,
			model: status.agent.model ? { ...status.agent.model, thinkingLevel: status.agent.thinkingLevel } : undefined,
		};
		const snapshot = await this.manager.snapshot(id);
		if (this.closed || generation !== this.generation) return;
		if (this.target !== id) this.previous = this.target;
		this.source.select(undefined);
		this.target = id;
		this.row = { ...row, name: status.name };
		this.state.selected = id;
		this.setSnapshot(snapshot);
		this.source.select(id);
		this.remember?.(id);
		this.display = noDisplayModules;
		this.panels = noPanelModules;
		this.modelCatalog = new Map();
		this.displayLoading = Promise.all([this.loadModules(id), this.loadModels(id)]).then(([modules, models]) => {
			if (this.closed || generation !== this.generation) return;
			this.display = modules.display;
			this.panels = modules.panels;
			this.modelCatalog = models;
			this.notify();
		});
		this.notify();
	}
	/**
	 * One owner request through the panel's bound command. The target is the attachment captured when
	 * the panel opened: a later attachment change refuses the request instead of redirecting it.
	 */
	async panelRequest(target: string, command: string, data: JsonValue): Promise<{ text: string; data?: JsonValue }> {
		if (this.closed) throw new Error("Terminal is closed");
		if (this.target !== target) throw new Error("The attached conversation changed; the browser request was not sent");
		const answer = await this.manager.control("command", { sessionId: target, name: command, data, origin: "operator", invocationId: randomUUID() }, this.caller) as { text?: unknown; data?: JsonValue };
		if (typeof answer?.text !== "string") throw new Error("The host answered without command text");
		return { text: answer.text, ...(answer.data === undefined ? {} : { data: answer.data }) };
	}
	/** Resolves when the current attachment's owner renderers are loaded or refused. */
	displaySettled(): Promise<void> { return this.displayLoading ?? Promise.resolve(); }
	private async loadModels(id: string): Promise<Map<string, AgentModelInfo>> {
		const catalog = new Map<string, AgentModelInfo>();
		try {
			const read = await this.manager.control("models", { sessionId: id }, this.caller);
			if (!matchesSchema(ModelChoicesSchema, read)) return catalog;
			for (const model of read.models) if (model.contextWindow !== undefined) catalog.set(`${model.provider}/${model.modelId}`, { name: model.name ?? model.modelId, reasoning: model.reasoning, contextWindow: model.contextWindow });
		} catch { /* The footer shows the model identifier without a context window. */ }
		return catalog;
	}
	/** The attached host is live here, so its status carries the admitted inventory. Failure leaves standard cards and no browsers. */
	private async loadModules(id: string): Promise<{ display: DisplayModules; panels: PanelModules }> {
		try {
			const status = await this.manager.control("status", { sessionId: id }, this.caller) as { inventory?: unknown };
			if (status?.inventory === undefined) return { display: { lookup: noDisplayModules.lookup, diagnostics: ["Host status carried no inventory; standard tool cards are used."] }, panels: noPanelModules };
			const [display, panels] = await Promise.all([loadDisplayModules(status.inventory, this.importModule), loadPanelModules(status.inventory, this.importModule)]);
			return { display, panels };
		} catch (error) {
			return { display: { lookup: noDisplayModules.lookup, diagnostics: [`Display modules unavailable (${String(error instanceof Error ? error.message : error).slice(0, 120)}); standard tool cards are used.`] }, panels: noPanelModules };
		}
	}
	setDraft(text: string): void { if (this.draftState) updateDraft(this.draftState, text); }
	setMode(mode: "steer" | "followUp"): void { if (this.draftState) { this.draftState.mode = mode; notifyAgentState(this.draftState); this.notify(); } }
	unconfirmed(id: string): readonly UnconfirmedTerminalInput[] { return this.failedInputs.get(id) ?? []; }
	failureReceipt(id: string, error: unknown): string { return `Delivery not confirmed for ${id}. Current draft and mode kept; submitted input retained. /agent recover. ${String(error)}`; }
	async admit(id: string, text: string, mode: "steer" | "followUp"): Promise<{ raw: unknown; text: string }> {
		if (this.closed) throw new Error("Terminal is closed");
		try {
			const raw = await this.manager.control("submit", { sessionId: id, message: text, whenBusy: mode, origin: "operator", replyTo: id }, this.caller);
			return { raw, text: terminalAdmission(raw, id, mode) };
		} catch (error) {
			const inputs = this.failedInputs.get(id) ?? [];
			inputs.push({ text, mode }); this.failedInputs.set(id, inputs);
			throw error;
		}
	}
	restoreUnconfirmed(id: string, input: UnconfirmedTerminalInput, revision: number, mode: "steer" | "followUp"): void {
		const state = agentState(this.state, id);
		if (this.closed || state.pending || state.draftRevision !== revision || state.mode !== mode || !this.unconfirmed(id).includes(input)) throw new Error("The target draft changed. Inspect again before restoring.");
		state.mode = input.mode; updateDraft(state, input.text); this.notify();
	}
	discardUnconfirmed(id: string, input: UnconfirmedTerminalInput): void {
		this.failedInputs.set(id, this.unconfirmed(id).filter((item) => item !== input));
	}
	async send(text = this.draftState?.draft ?? ""): Promise<unknown> {
		const id = this.target;
		const state = this.draftState;
		if (this.closed || !id || !state) throw new Error("No attached conversation");
		if (state.pending || !text.trim()) return undefined;
		const revision = state.draftRevision;
		const mode = state.mode;
		state.pending = { text, mode, revision };
		state.receipt = "Sending…";
		notifyAgentState(state);
		this.notify();
		try {
			const receipt = await this.admit(id, text, mode);
			state.receipt = receipt.text;
			state.history.push(text);
			if (state.draftRevision === revision && state.draft === text) { if (state.mode === mode) state.mode = "steer"; updateDraft(state, ""); }
			return receipt.raw;
		} catch (error) {
			state.receipt = this.failureReceipt(id, error);
			throw error;
		} finally { state.pending = undefined; notifyAgentState(state); this.notify(); }
	}
	async earlier(): Promise<void> {
		const id = this.target;
		const generation = this.generation;
		const before = this.snapshot?.nextBefore;
		if (!id || !before) return;
		const snapshot = await this.source.earlier(id, before);
		if (this.closed || generation !== this.generation) return;
		const history = this.history(id);
		const anchor = this.draftState?.view.anchor?.id;
		history.add(snapshot, before, anchor);
		this.snapshot = { ...snapshot, entries: history.entries(anchor), nextBefore: history.earlier() };
		this.notify();
	}
	async close(): Promise<void> {
		if (this.closed) return this.closing;
		this.closed = true;
		this.generation++;
		this.off();
		this.source.select(undefined);
		this.source.releaseTasks();
		this.listeners.clear();
		this.closing = this.manager.close();
		await this.closing;
	}
}

export function terminalTargetFile(root: string): { read(): string | undefined; write(id: string): void } {
	const file = join(root, "terminal-target.json");
	return {
		read() {
			try { const value: unknown = JSON.parse(readFileSync(file, "utf8")); return typeof value === "string" ? value : undefined; }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
		},
		write(id) { const temporary = `${file}.${randomUUID()}`; writeFileSync(temporary, JSON.stringify(id), { mode: 0o600 }); renameSync(temporary, file); },
	};
}

export function terminalKeys(): KeybindingsManager {
	return new KeybindingsManager({ ...TUI_KEYBINDINGS,
		"app.interrupt": { defaultKeys: "escape" }, "app.exit": { defaultKeys: "ctrl+d" },
		"app.clipboard.pasteImage": { defaultKeys: [] },
		// The focused screen owns paging, not the outer fullscreen viewport.
		"tui.altScreen.pageUp": { defaultKeys: [] }, "tui.altScreen.pageDown": { defaultKeys: [] },
		"app.tools.expand": { defaultKeys: "ctrl+o" }, "app.thinking.toggle": { defaultKeys: "ctrl+t" },
	});
}

/** One full-window console; dashboard/dialogs temporarily own the same viewport. */
export class TerminalScreen implements Component {
	private console?: AgentConsole;
	private dashboard?: AgentDashboard;
	private dashboardSource?: AgentObservationSource;
	/** One owner browser mounted over the conversation, bound to the attachment it opened on. */
	private panel?: { screen: PanelScreen; target: string };
	private notice = "";
	private displayNotice = "";
	private readonly navigationInput = new Input({ prompt: "Command: " });
	private dashboardHidden = false;
	private composerY = 0;
	private composerHeight = 0;
	private readonly programStatus?: TerminalProgramStatus;
	private readonly hits = new DashboardMouse();
	private readonly footer = new ActionInventory(() => this.footerActions(), (reason) => { this.notice = reason; });
	private transcript = { y: 0, height: 0, width: 0 };
	private readonly off: () => void;
	private readonly branches: AgentBranchCache;
	private readonly openDialogs = new Set<() => void>();
	private readonly dialogs: AgentDialogs;
	private disposed = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	readonly controller: TerminalController;
	private readonly done: () => void;
	constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, controller: TerminalController, done: () => void, publishStatus?: (status: ProgramStatus) => void) {
		this.tui = tui; this.theme = theme; this.keys = keys; this.controller = controller; this.done = done;
		if (publishStatus) this.programStatus = new TerminalProgramStatus(publishStatus);
		this.dialogs = terminalDialogs({ tui, theme, keys,
			track: (cancel) => { this.openDialogs.add(cancel); this.projectStatus(); return () => { this.openDialogs.delete(cancel); this.projectStatus(); }; },
			notify: (text) => { this.notice = text; this.tui.requestRender(); } });
		this.navigationInput.onSubmit = (text) => { this.navigationInput.setValue(""); void this.submit(text); };
		this.branches = new AgentBranchCache(readAgentBranch, () => this.tui.requestRender());
		this.off = controller.subscribe(() => this.changed());
		this.changed();
	}
	private changed(): void {
		if (this.disposed) return;
		const row = this.controller.row;
		if (this.panel && this.panel.target !== this.controller.target) this.closePanel("The attached conversation changed; the browser was closed.");
		if (row && this.console?.row.id !== row.id) {
			this.console?.save(); this.console?.dispose();
			this.console = new AgentConsole(row, agentState(this.controller.state, row.id), this.tui, this.theme, this.keys,
				(text) => { void this.submit(text); }, () => this.openDashboard());
		}
		if (this.console && row) this.syncConsole(this.console, row);
		this.projectStatus();
		this.tui.requestRender();
	}
	/** Bring the visible conversation in line with the controller's current observation. */
	private syncConsole(console: AgentConsole, row: AgentConversationSummary): void {
		console.conversation.setToolDisplay(this.controller.toolDisplay);
		const diagnostics = this.controller.display.diagnostics;
		this.displayNotice = diagnostics.length ? `Owner cards: ${diagnostics[0]}${diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : ""}` : "";
		console.row = row;
		console.warning = this.controller.availability?.state === "unavailable" ? "Connection unavailable; last observed data shown. /agent enter <target> retries." : undefined;
		console.setContent(this.controller.snapshot?.entries ?? [], this.controller.frame?.live ?? []);
		console.observeUsage(this.controller.snapshot?.entries ?? [], this.controller.frame?.status.usage);
		this.branches.refresh(row.cwd, `${row.id}:${this.controller.snapshot?.entries.at(-1)?.id ?? "empty"}`);
	}
	private projectStatus(): void {
		this.programStatus?.update({
			target: this.controller.target,
			revision: this.controller.selectionRevision,
			live: this.controller.availability?.state === "live",
			busy: this.controller.row?.state === "working",
			interaction: this.openDialogs.size > 0,
		});
	}
	private async submit(text: string): Promise<void> {
		const words = text.trim().split(/\s+/);
		if (words[0] === "/agent") { this.controller.setDraft(""); await this.agentCommand(words.slice(1)); }
		else if (text.trim() === "/quit") this.done();
		else {
			try { await this.controller.send(text); }
			catch { /* The captured target's receipt retains the error. */ }
		}
		this.tui.requestRender();
	}
	private async agentCommand(words: string[]): Promise<void> {
		const routes: Record<string, { arity: readonly number[]; run(argument?: string): void | Promise<void> }> = {
			enter: { arity: [2], run: (argument) => this.enter(argument ?? "") },
			back: { arity: [1], run: () => this.back() },
			latest: { arity: [1], run: () => this.latest() },
			browse: { arity: [1, 2], run: (argument) => argument ? this.openPanel(argument) : this.chooseBrowser() },
			recover: { arity: [1], run: async () => {
				const revision = this.controller.selectionRevision;
				try { await this.recover(); } catch (error) { if (revision === this.controller.selectionRevision) this.notice = String(error); }
			} },
		};
		if (words.length === 0) { this.openDashboard(); return; }
		const route = Object.hasOwn(routes, words[0]) ? routes[words[0]] : undefined;
		if (route?.arity.includes(words.length)) await route.run(words[1]);
		else this.notice = "Use /agent, /agent enter <identity|@handle>, /agent back, /agent latest, /agent browse [name], or /agent recover";
	}
	private async recover(): Promise<void> {
		const id = this.controller.target;
		if (!id) throw new Error("No attached conversation");
		const inputs = this.controller.unconfirmed(id);
		if (!inputs.length) throw new Error("No unconfirmed input for this target");
		const picked = await this.dialogs.select(`Unconfirmed inputs for ${id}\nInspect native history before any resend. Recovery never sends input.`, inputs.map((input, index) => ({ value: String(index), label: `requested ${input.mode} · ${input.text.replace(/\s+/g, " ").slice(0, 80)}` })));
		const input = picked === undefined ? undefined : inputs[Number(picked)];
		if (!input) return;
		const state = agentState(this.controller.state, id);
		const revision = state.draftRevision; const mode = state.mode;
		let action: string | undefined;
		do {
			action = await this.dialogs.select(`Recover input for ${id}\nRestore replaces the current target draft and mode with the full text; it does not send. The unconfirmed copy remains until explicit discard. Requested mode: ${input.mode}`, [
				{ value: "read", label: "Read full text" }, { value: "restore", label: "Restore to the draft" }, { value: "discard", label: "Discard this copy" }, { value: "cancel", label: "Cancel" }]);
			if (action === "read") await this.dialogs.read("Unconfirmed input", input.text);
		} while (action === "read");
		if (action === "restore") this.controller.restoreUnconfirmed(id, input, revision, mode);
		else if (action === "discard") this.controller.discardUnconfirmed(id, input);
	}
	private async enter(id: string): Promise<void> {
		this.console?.save();
		const entering = this.controller.attach(id);
		const revision = this.controller.selectionRevision;
		try { await entering; if (revision === this.controller.selectionRevision) { this.closeDashboard(); this.notice = ""; } }
		catch (error) { if (revision === this.controller.selectionRevision) this.notice = String(error); }
		this.tui.requestRender();
	}
	openDashboard(): void {
		if (this.dashboard || this.disposed) return;
		this.console?.save();
		const manager = this.controller.manager;
		const source = createAgentObservationSource({ list: (input) => manager.dashboardPage(input), snapshot: (id, params) => manager.snapshot(id, params), observeLive: (id, scope, listener, signal) => manager.observeLive(id, scope, listener, signal), subscribeRoster: (listener) => manager.subscribeRoster(listener) });
		this.dashboardSource = source;
		const collaborate = manager.collaborate?.bind(manager);
		const operations: DashboardOperations = {
			enter: (id) => { void this.enter(id); },
			branch: readAgentBranch,
			readLineage: (id) => manager.control("status", { sessionId: id }, this.controller.caller),
			collaborate: collaborate ? (input) => {
				const id = this.controller.target;
				if (!["list", "read"].includes(String(input.action)) && !id)
					return Promise.reject(new Error("Attach a conversation before posting to a thread."));
				return collaborate({ ...input, origin: "operator" }, { ...this.controller.caller, id: id ?? this.controller.caller.id });
			} : undefined,
			submit: async (input) => {
				const receipt = await this.controller.admit(input.id, input.text, input.mode);
				return { text: receipt.text, receipt: receipt.text };
			},
			submissionFailure: (input, error) => this.controller.failureReceipt(input.id, error),
			chooseConversation: async (labels) => {
				return this.dialogs.select("Choose a conversation", labels.map((label) => ({ value: label.identity, label: label.name || label.firstMessage || "Conversation", description: label.identity })));
			},
			toolDisplay: this.controller.toolDisplay,
			action: (name, target) => terminalAction(this.controller, this.dialogs, name, target),
		};
		this.dashboard = new AgentDashboard(this.tui, this.theme, this.keys, () => this.closeDashboard(), this.controller.state, source, operations, { hide: () => { this.dashboardHidden = true; this.tui.requestRender(); }, show: () => { this.dashboardHidden = false; this.tui.requestRender(); } }, this.controller.target);
		this.tui.requestRender();
	}
	closeDashboard(): void {
		this.dashboard?.dispose(); this.dashboard = undefined;
		this.dashboardSource?.select(undefined); this.dashboardSource?.releaseTasks(); this.dashboardSource = undefined;
		this.console?.conversation.invalidate();
		this.tui.requestRender();
	}
	/** Offer the attached host's browsers; an unavailable one explains itself instead of opening. */
	private async chooseBrowser(): Promise<void> {
		const panels = this.controller.panels.panels;
		if (!panels.length) { this.notice = "No browsers are advertised by this conversation's host."; this.tui.requestRender(); return; }
		const revision = this.controller.selectionRevision;
		const picked = await this.dialogs.select("Browsers", panels.map((panel) => ({ value: panel.contribution, label: panel.title, description: panel.unavailable ? `browser unavailable here: ${panel.unavailable}` : `${panel.contribution} browser` })));
		if (picked === undefined || revision !== this.controller.selectionRevision) return;
		this.openPanel(picked);
	}
	openPanel(contribution: string): void {
		const target = this.controller.target;
		const panel = this.controller.panels.panels.find((candidate) => candidate.contribution === contribution);
		if (!target || !panel) { this.notice = `No browser named ${contribution} is available here.`; this.tui.requestRender(); return; }
		if (!panel.module) { this.notice = `${panel.title}: browser unavailable here (${panel.unavailable ?? "module not loaded"})`; this.tui.requestRender(); return; }
		if (this.panel) this.closePanel();
		this.console?.save();
		const command = panel.command;
		const screen = new PanelScreen({
			module: panel.module, title: panel.title, target: { id: target, ...(this.controller.row?.name ? { name: this.controller.row.name } : {}) },
			tui: this.tui, theme: this.theme, dialogs: this.dialogs,
			request: (data) => this.controller.panelRequest(target, command, data),
			onClose: () => this.closePanel(),
			detach: () => this.done(),
		});
		this.panel = { screen, target };
		this.notice = "";
		this.tui.requestRender();
	}
	private closePanel(reason = ""): void {
		const panel = this.panel;
		if (!panel) return;
		this.panel = undefined;
		panel.screen.dispose();
		if (reason) this.notice = reason;
		this.console?.conversation.invalidate();
		this.resetHits();
		this.tui.requestRender();
	}
	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+d") && (!this.console || this.console.composer.isEmpty()) && !this.dashboard) { this.done(); return; }
		if (this.dashboard) { this.dashboard.handleInput(data); return; }
		if (this.panel) { this.panel.screen.handleInput(data); this.tui.requestRender(); return; }
		const console = this.console;
		if (!console) {
			if (matchesKey(data, "escape")) this.openDashboard();
			else this.navigationInput.handleInput(data);
			this.tui.requestRender();
			return;
		}
		this.consoleInput(console, data);
	}
	private consoleInput(console: AgentConsole, data: string): void {
		if (matchesKey(data, "tab")) { this.controller.setMode(console.state.mode === "steer" ? "followUp" : "steer"); return; }
		if (matchesKey(data, "ctrl+o") || matchesKey(data, "ctrl+t")) {
			if (matchesKey(data, "ctrl+o")) console.state.view.expanded = !console.state.view.expanded;
			else console.state.view.showThinking = !console.state.view.showThinking;
			console.conversation.invalidate(); this.changed(); return;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			if (matchesKey(data, "pageUp") && console.conversation.atTop()) {
				const revision = this.controller.selectionRevision;
				void this.controller.earlier().catch((error) => { if (revision === this.controller.selectionRevision) this.notice = String(error); this.tui.requestRender(); });
			}
			console.conversation.page(matchesKey(data, "pageUp") ? -10 : 10); this.tui.requestRender(); return;
		}
		console.composer.handleInput(data); this.tui.requestRender();
	}
	private resetHits(): void {
		this.hits.reset();
		this.transcript = { y: 0, height: 0, width: 0 };
	}
	private async back(): Promise<void> {
		if (this.controller.previous) await this.enter(this.controller.previous);
		else this.notice = "No previous conversation";
		this.tui.requestRender();
	}
	private latest(): void {
		const state = this.controller.draftState;
		if (!state) return;
		state.view.follow = true;
		state.view.anchor = undefined;
		this.console?.conversation.invalidate();
		this.tui.requestRender();
	}
	/** Dashboard, Browsers, Back and Latest are footer controls; Detach is the way out and always stays. */
	private footerActions(): ScreenAction[] {
		const panels = this.controller.panels.panels;
		return [
			{ id: "dashboard", label: "Dashboard", main: true, run: () => this.openDashboard() },
			{ id: "browsers", label: "Browsers", main: panels.length > 0, description: "Open an owner browser over this conversation", disabled: panels.length ? undefined : "No browsers are advertised by this conversation's host", run: () => { void this.chooseBrowser(); } },
			{ id: "back", label: "Back", main: true, disabled: this.controller.previous ? undefined : "No previous conversation", run: () => { void this.back(); } },
			{ id: "latest", label: "Latest", main: true, disabled: this.console ? undefined : "No conversation is attached", run: () => this.latest() },
		];
	}
	private footerLine(width: number, height: number): string {
		return this.footer.footer(this.hits, height - 1, width, { id: "detach", label: "Detach", run: () => this.done() }, this.theme, false);
	}
	private loadEarlier(): void {
		const revision = this.controller.selectionRevision;
		void this.controller.earlier().catch((error) => { if (revision === this.controller.selectionRevision) this.notice = String(error); this.tui.requestRender(); });
	}
	render(width: number): string[] {
		this.resetHits();
		if (this.dashboard && !this.dashboardHidden) return this.dashboard.render(width);
		if (this.panel) return this.panel.screen.render(width);
		const height = this.tui.terminal.rows;
		this.hits.reset(width, height);
		const footer = this.footerLine(width, height);
		const console = this.console;
		if (!console) {
			this.navigationInput.focused = true;
			return [fitLine("No conversation. /agent opens the dashboard; /agent enter <target> attaches.", width), ...Array<string>(Math.max(0, height - 3)).fill(""), ...this.navigationInput.render(width), footer].slice(0, height);
		}
		if (width < 60 || height < 20) {
			const lines = Array.from({ length: height }, (_, i) => fitLine(i === 0 ? "Resize to use this conversation. Esc opens Agents." : "", width));
			lines[height - 1] = footer;
			return lines;
		}
		return this.renderConversation(console, width, height, footer);
	}
	private renderConversation(console: AgentConsole, width: number, height: number, footer: string): string[] {
		console.composer.focused = true;
		console.composer.setViewportRows(Math.max(5, Math.min(10, Math.floor(height / 3))));
		const editor = console.composer.render(width, console.row.name?.trim() ? console.row.name : console.row.id, console.messageMode(), console.state.receipt);
		const status = console.statusLines(width, this.controller.currentModelInfo(), this.branches.get(console.row.cwd));
		const boundary = this.controller.snapshot?.nextBefore ? "Earlier history" : "";
		const notice = console.warning || this.notice || this.displayNotice;
		const reserved = editor.length + status.length + 1 + (notice ? 1 : 0) + (boundary ? 1 : 0);
		const body = console.conversation.render(width, Math.max(1, height - reserved));
		this.transcript = { y: boundary ? 1 : 0, height: body.length, width };
		if (boundary) this.hits.add({ x: 0, y: 0, width, height: 1, click: () => { this.loadEarlier(); } });
		this.composerY = (boundary ? 1 : 0) + body.length;
		this.composerHeight = editor.length;
		const lines = [
			...(boundary ? [fitLine(this.theme.fg("muted", boundary), width)] : []),
			...body, ...editor, ...status,
			...(notice ? [fitLine(notice, width)] : []),
			footer,
		];
		while (lines.length < height) lines.splice(lines.length - 1, 0, "");
		return lines.slice(0, height);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.dashboard && !this.dashboardHidden) return this.dashboard.handleMouse(event);
		if (this.panel) { const result = this.panel.screen.handleMouse(event); if (result?.handled) this.tui.requestRender(); return result; }
		const control = this.hits.handle(event);
		if (control) return control;
		return this.transcriptMouse(event) ?? this.composerMouse(event);
	}
	private transcriptMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const transcript = this.transcript;
		if (!this.console || transcript.height <= 0 || event.y < transcript.y || event.y >= transcript.y + transcript.height) return undefined;
		if (event.type !== "wheel") return this.console.conversation.handleMouse({ ...event, y: event.y - transcript.y, width: transcript.width, height: transcript.height });
		const delta = event.wheelDelta ?? 0;
		if (delta < 0 && this.console.conversation.atTop()) this.loadEarlier();
		else this.console.conversation.page(delta);
		return { handled: true };
	}
	private composerMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.console || event.y < this.composerY || event.y >= this.composerY + this.composerHeight) return undefined;
		return this.console.composer.handleMouse({ ...event, y: event.y - this.composerY, height: this.composerHeight });
	}
	invalidate(): void { this.resetHits(); this.footer.invalidate(); this.console?.conversation.invalidate(); this.console?.composer.invalidate(); this.dashboard?.invalidate(); this.panel?.screen.invalidate(); }
	dispose(): void { this.disposed = true; this.programStatus?.dispose(); for (const cancel of [...this.openDialogs]) cancel(); this.closePanel(); this.closeDashboard(); this.console?.save(); this.console?.dispose(); this.branches.dispose(); this.off(); }
}

export function parseTerminalArgs(args: string[]): { session?: string; selectedTheme: "dark" | "light" } {
	let session: string | undefined;
	let selectedTheme = "dark";
	for (let i = 0; i < args.length; i++) {
		const name = args[i];
		const value = args[++i];
		if (!value || !["--session", "--theme"].includes(name)) throw new Error(`Unknown or incomplete terminal argument: ${name}`);
		if (name === "--session") session = value;
		else selectedTheme = value;
	}
	if (selectedTheme !== "dark" && selectedTheme !== "light") throw new Error("Theme must be dark or light; automatic/system theme is not supported.");
	return { session, selectedTheme };
}

export async function runTerminal(args: string[]): Promise<void> {
	const { session, selectedTheme } = parseTerminalArgs(args);
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("This attachment requires an interactive terminal");
	const agentDir = process.env.PI_AGENT_DIR ?? getAgentDir();
	const root = resolve(process.env.PI_AGENT_SESSIONS_DIR ?? join(agentDir, "agent-sessions"));
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const remembered = terminalTargetFile(root);
	const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir, settingsManager: SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, additionalThemePaths: [join(getPackageDir(), "dist", "modes", "interactive", "theme", `${selectedTheme}.json`)] });
	await loader.reload();
	const theme = loader.getThemes().themes.find((item) => item.name === selectedTheme);
	if (!theme) throw new Error(`Shipped ${selectedTheme} theme did not load`);
	initTheme(selectedTheme, false);
	const keys = terminalKeys(); setKeybindings(keys);
	const manager = new AgentManager({ root: realpathSync(root), agentDir, packageDir: getPackageDir() });
	const controller = new TerminalController({ manager, caller: { id: `terminal:${randomUUID()}`, cwd: process.cwd() }, remember: (id) => remembered.write(id) });
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	let finish!: () => void;
	const finished = new Promise<void>((resolveDone) => { finish = resolveDone; });
	const screen = new TerminalScreen(tui, theme, keys, controller, finish, (status) => terminal.setProgramStatus(status));
	const close = () => finish();
	process.once("SIGINT", close); process.once("SIGTERM", close);
	try {
		const target = session ?? remembered.read();
		if (target) await controller.attach(target);
		else screen.openDashboard();
		tui.addChild(screen); tui.setFocus(screen); tui.start();
		await finished;
	} finally { process.off("SIGINT", close); process.off("SIGTERM", close); screen.dispose(); try { await controller.close(); } finally { tui.stop(); } }
}
