import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DefaultResourceLoader, SettingsManager, getAgentDir, getPackageDir, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, KeybindingsManager, ProcessTerminal, TuiAltScreen, TUI_KEYBINDINGS, setKeybindings, matchesKey, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { AgentManager, type AgentCaller } from "./manager.ts";
import { createAgentObservationSource, type AgentObservationSource } from "./agent-observation.ts";
import { AgentConsole } from "./agent-console.ts";
import { AgentDashboard, type DashboardOperations } from "./dashboard.ts";
import { agentState, createDashboardState, notifyAgentState, updateDraft, type DashboardState } from "./dashboard-state.ts";
import { ConversationHistory } from "./conversation-view.ts";
import type { AgentConversationSummary, AgentConversationSnapshot } from "./dashboard-types.ts";
import { fitLine } from "./dashboard-layout.ts";
import { readAgentBranch, AgentBranchCache } from "./agent-git.ts";
import { terminalAction } from "./terminal-actions.ts";
import { admittedResult } from "./result-reference.ts";

export function terminalAdmission(receipt: unknown, id: string, mode: "steer" | "followUp"): string {
	const reference = admittedResult(id, receipt);
	const deduped = (receipt as { deduped?: boolean }).deduped === true;
	return `Input ${deduped ? "already admitted" : "admitted"} for ${reference.sessionId} (submission ${reference.submissionId}; requested ${mode === "followUp" ? "follow-up" : "steer"})`;
}

export type TerminalManager = Pick<AgentManager, "resolveTarget" | "control" | "snapshot" | "dashboardPage" | "observeLive" | "subscribeRoster" | "close">;
export interface UnconfirmedTerminalInput { readonly text: string; readonly mode: "steer" | "followUp" }
export interface TerminalControllerOptions {
	manager: TerminalManager;
	caller: AgentCaller;
	state?: DashboardState;
	remember?(id: string): void;
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
	private generation = 0;
	private readonly histories = new Map<string, ConversationHistory>();
	private readonly failedInputs = new Map<string, UnconfirmedTerminalInput[]>();
	private readonly listeners = new Set<() => void>();
	private readonly off: () => void;
	private readonly remember?: (id: string) => void;
	constructor(options: TerminalControllerOptions) {
		this.manager = options.manager;
		this.caller = options.caller;
		this.state = options.state ?? createDashboardState();
		this.remember = options.remember;
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
		if (frame && row && this.target && this.availability?.state === "live") {
			this.row = { ...row, name: frame.status.name ?? row.name, awaiting: frame.status.awaiting,
				state: frame.status.busy ? "working" : "idle",
				model: frame.status.agent.model ? { ...frame.status.agent.model, thinkingLevel: frame.status.agent.thinkingLevel } : row.model };
			this.setSnapshot({ entries: frame.entries, partial: !frame.coverage.complete, revision: `r${frame.revision}`, nextBefore: frame.nextBefore });
		}
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
		this.row = row;
		this.state.selected = id;
		this.setSnapshot(snapshot);
		this.source.select(id);
		this.remember?.(id);
		this.notify();
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
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.generation++;
		this.off();
		this.source.select(undefined);
		this.source.releaseTasks();
		this.listeners.clear();
		this.manager.close();
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
		"app.tools.expand": { defaultKeys: "ctrl+o" }, "app.thinking.toggle": { defaultKeys: "ctrl+t" },
	});
}

/** One full-window console; dashboard/dialogs temporarily own the same viewport. */
export class TerminalScreen implements Component {
	private console?: AgentConsole;
	private dashboard?: AgentDashboard;
	private dashboardSource?: AgentObservationSource;
	private notice = "";
	private readonly navigationInput = new Input({ prompt: "Command: " });
	private dashboardHidden = false;
	private composerY = 0;
	private composerHeight = 0;
	private readonly off: () => void;
	private readonly branches: AgentBranchCache;
	private readonly dialogs = new Set<() => void>();
	private disposed = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	readonly controller: TerminalController;
	private readonly done: () => void;
	constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, controller: TerminalController, done: () => void) {
		this.tui = tui; this.theme = theme; this.keys = keys; this.controller = controller; this.done = done;
		this.navigationInput.onSubmit = (text) => { this.navigationInput.setValue(""); void this.submit(text); };
		this.branches = new AgentBranchCache(readAgentBranch, () => this.tui.requestRender());
		this.off = controller.subscribe(() => this.changed());
		this.changed();
	}
	private changed(): void {
		if (this.disposed) return;
		const row = this.controller.row;
		if (row && this.console?.row.id !== row.id) {
			this.console?.save(); this.console?.dispose();
			this.console = new AgentConsole(row, agentState(this.controller.state, row.id), this.tui, this.theme, this.keys,
				(text) => { void this.submit(text); }, () => this.openDashboard());
		}
		if (this.console && row) {
			this.console.row = row;
			this.console.warning = this.controller.availability?.state === "unavailable" ? "Connection unavailable; last observed data shown. /agent enter <target> retries." : undefined;
			this.console.setContent(this.controller.snapshot?.entries ?? [], this.controller.frame?.live ?? []);
			this.console.observeUsage(this.controller.snapshot?.entries ?? [], this.controller.frame?.status.usage);
			this.branches.refresh(row.cwd, `${row.id}:${this.controller.snapshot?.entries.at(-1)?.id ?? "empty"}`);
		}
		this.tui.requestRender();
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
		if (words.length === 0) this.openDashboard();
		else if (words[0] === "enter" && words.length === 2) await this.enter(words[1]);
		else if (words[0] === "back" && words.length === 1 && this.controller.previous) await this.enter(this.controller.previous);
		else if (words[0] === "recover" && words.length === 1) {
			const revision = this.controller.selectionRevision;
			try { await this.recover(); } catch (error) { if (revision === this.controller.selectionRevision) this.notice = String(error); }
		} else this.notice = "Use /agent, /agent enter <identity|@handle>, /agent back, or /agent recover";
	}
	private async recover(): Promise<void> {
		const id = this.controller.target;
		if (!id) throw new Error("No attached conversation");
		const inputs = this.controller.unconfirmed(id);
		if (!inputs.length) throw new Error("No unconfirmed input for this target");
		const choice = await this.ask(`Unconfirmed inputs for ${id}`, ["Inspect native history before any resend. Recovery never sends input.", ...inputs.map((input, i) => `${i + 1}: requested ${input.mode} · ${JSON.stringify(input.text)}`)], `Input number (1-${inputs.length}): `);
		if (!choice) return;
		const input = /^[1-9]\d*$/.test(choice) ? inputs[Number(choice) - 1] : undefined;
		if (!input) throw new Error("Choose a listed input number");
		const state = agentState(this.controller.state, id);
		const revision = state.draftRevision; const mode = state.mode;
		const action = await this.ask(`Recover input for ${id}`, ["restore replaces the current target draft and mode with the full text; it does not send.", "The unconfirmed copy remains until explicit discard. discard removes only that copy.", `Requested mode: ${input.mode}`, ...input.text.split("\n")], "Type restore or discard: ");
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
		const operations: DashboardOperations = {
			enter: (id) => { void this.enter(id); },
			branch: readAgentBranch,
			submit: async (input) => {
				const receipt = await this.controller.admit(input.id, input.text, input.mode);
				return { text: receipt.text, receipt: receipt.text };
			},
			submissionFailure: (input, error) => this.controller.failureReceipt(input.id, error),
			chooseConversation: async (labels) => {
				const id = await this.ask("Choose conversation", labels.map((label) => `${label.identity} ${label.name ?? ""}`), "Identity: ");
				if (id === undefined) return undefined;
				if (!labels.some((label) => label.identity === id)) throw new Error("Choose a listed identity");
				return id;
			},
			action: (name, target) => terminalAction(this.controller, (title, lines, prompt, initial) => this.ask(title, lines, prompt, initial), name, target),
		};
		this.dashboard = new AgentDashboard(this.tui, this.theme, this.keys, () => this.closeDashboard(), this.controller.state, source, operations, { hide: () => { this.dashboardHidden = true; this.tui.requestRender(); }, show: () => { this.dashboardHidden = false; this.tui.requestRender(); } });
		this.tui.requestRender();
	}
	private ask(title: string, lines: string[], prompt: string, initial = ""): Promise<string | undefined> {
		if (this.disposed) return Promise.resolve(undefined);
		return new Promise((resolveAnswer) => {
			const input = new Input({ prompt });
			input.setValue(initial);
			let handle: { hide(): void } | undefined;
			let settled = false;
			const finish = (answer?: string) => { if (settled) return; settled = true; this.dialogs.delete(cancel); handle?.hide(); resolveAnswer(answer); this.tui.requestRender(); };
			const cancel = () => finish();
			this.dialogs.add(cancel);
			input.onSubmit = (value) => finish(value);
			const component: Component & Focusable = {
				get focused() { return input.focused; },
				set focused(value: boolean) { input.focused = value; },
				render: (width) => {
					const field = input.render(width);
					const bodyRows = Math.max(0, Math.floor(this.tui.terminal.rows * 0.9) - field.length - 2);
					const body = lines.slice(0, bodyRows);
					if (lines.length > bodyRows && bodyRows > 0) body[bodyRows - 1] = `${lines.length - bodyRows + 1} text lines omitted.`;
					return [fitLine(title, width), ...body.map((line) => fitLine(line, width)), ...field, fitLine("Enter applies · Esc cancels", width)];
				},
				handleInput: (data) => { if (matchesKey(data, "escape")) finish(); else input.handleInput(data); this.tui.requestRender(); },
				invalidate: () => input.invalidate(),
			};
			handle = this.tui.showOverlay(component, { width: "90%", maxHeight: "90%", anchor: "center" });
		});
	}
	closeDashboard(): void {
		this.dashboard?.dispose(); this.dashboard = undefined;
		this.dashboardSource?.select(undefined); this.dashboardSource?.releaseTasks(); this.dashboardSource = undefined;
		this.console?.conversation.invalidate();
		this.tui.requestRender();
	}
	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+d") && (!this.console || this.console.composer.isEmpty()) && !this.dashboard) { this.done(); return; }
		if (this.dashboard) { this.dashboard.handleInput(data); return; }
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
	render(width: number): string[] {
		if (this.dashboard && !this.dashboardHidden) return this.dashboard.render(width);
		const height = this.tui.terminal.rows;
		const console = this.console;
		if (!console) {
			this.navigationInput.focused = true;
			return [fitLine("No conversation. /agent opens the dashboard; /agent enter <target> attaches.", width), ...Array<string>(Math.max(0, height - 3)).fill(""), ...this.navigationInput.render(width), fitLine(this.notice || "Ctrl+D detaches", width)].slice(0, height);
		}
		if (width < 60 || height < 20) return Array.from({ length: height }, (_, i) => fitLine(i === 0 ? "Resize to use this conversation. Esc opens Agents." : "", width));
		console.composer.focused = true;
		console.composer.setViewportRows(Math.max(5, Math.min(10, Math.floor(height / 3))));
		const editor = console.composer.render(width, "Message", console.messageMode(), console.state.receipt);
		const status = console.statusLines(width, undefined, this.branches.get(console.row.cwd));
		const body = console.conversation.render(width, Math.max(1, height - editor.length - status.length - 1));
		this.composerY = body.length; this.composerHeight = editor.length;
		return [...body, ...editor, ...status, fitLine(console.warning || this.notice || "Shared input · /agent dashboard · /agent enter <target> · /agent back · Ctrl+D detaches", width)].slice(0, height);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.dashboard) return this.dashboard.handleMouse(event);
		if (event.type === "wheel" && this.console) { this.console.conversation.page(event.wheelDelta ?? 0); return { handled: true }; }
		if (this.console && event.y >= this.composerY && event.y < this.composerY + this.composerHeight)
			return this.console.composer.handleMouse({ ...event, y: event.y - this.composerY, height: this.composerHeight });
		return undefined;
	}
	invalidate(): void { this.console?.conversation.invalidate(); this.console?.composer.invalidate(); this.dashboard?.invalidate(); }
	dispose(): void { this.disposed = true; for (const cancel of this.dialogs) cancel(); this.closeDashboard(); this.console?.save(); this.console?.dispose(); this.branches.dispose(); this.off(); }
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
	const screen = new TerminalScreen(tui, theme, keys, controller, finish);
	const close = () => finish();
	process.once("SIGINT", close); process.once("SIGTERM", close);
	try {
		const target = session ?? remembered.read();
		if (target) await controller.attach(target);
		else screen.openDashboard();
		tui.addChild(screen); tui.setFocus(screen); tui.start();
		await finished;
	} finally { process.off("SIGINT", close); process.off("SIGTERM", close); screen.dispose(); controller.close(); tui.stop(); }
}
