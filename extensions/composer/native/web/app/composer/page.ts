(() => {
	type Delivery = "steer" | "queue";
	type SendKey = "return" | "command";
	type Behavior = "send" | "steer" | "queue";
	type EditKind = "replace" | "insert";
	interface ComposerStatus {
		connection: string;
		notice?: string;
		state?: string;
		command?: string;
	}
	interface StatusView {
		connectionLabel: string;
		stateLabel: string;
		waiting: boolean;
		working: boolean;
	}
	interface Action {
		kind: "send" | "stop";
		label: string;
		disabled: boolean;
	}
	interface ActionOptions {
		submitting?: boolean;
		hasDraft?: boolean;
		connection?: string;
	}
	interface KeyDecision {
		kind: "none" | "release" | "submit" | "abort" | "consume";
		behavior?: Behavior;
	}
	interface ComposerLogic {
		statusView(status?: ComposerStatus): StatusView;
		keyDecision(
			event: {
				key: string;
				metaKey?: boolean;
				ctrlKey?: boolean;
				altKey?: boolean;
				shiftKey?: boolean;
				isComposing?: boolean;
			},
			context: {
				sendKey: SendKey;
				delivery?: Delivery;
				state?: string;
				connection?: string;
				submitting?: boolean;
				readonly?: boolean;
				hasDraft?: boolean;
			},
		): KeyDecision;
		actionFor(state: string | undefined, options?: ActionOptions): Action;
		submitBehavior(state?: string, delivery?: Delivery): Behavior;
		showReturn(state?: string): boolean;
		editCommand(text: string): "insertText" | "delete";
		sendKeyNext(sendKey: SendKey): SendKey;
		draftIsSubmittable(text: string): boolean;
	}
	interface Change {
		start: number;
		end: number;
		text: string;
		cursor?: number;
	}
	interface Controls {
		viewport(menu: number): void;
		revealCaret(): void;
		prefetch(): void;
		key(event: KeyboardEvent): boolean;
		sync(state: Record<string, unknown>, connection: string): void;
		updated(person?: boolean): void;
		history(entries: string[]): void;
		recovery(label: string): void;
		paste(paths: unknown): void;
	}
	interface ComposerRoot {
		logic?: ComposerLogic;
		receive?: (envelope: unknown) => boolean;
	}
	interface SubmitReply {
		ok: boolean;
		outcome?: "accepted" | "refused";
		message?: string;
		error?: string;
		id?: string;
	}
	interface Ticket {
		id: string;
		focused: boolean;
	}
	interface Selection {
		start: number;
		end: number;
	}
	interface QueuedEdit {
		kind: EditKind;
		text: string;
		selection: Selection;
	}
	interface Transport {
		postMessage(message: Record<string, unknown>): unknown;
	}

	const root = globalThis as typeof globalThis & {
		composer?: ComposerRoot;
		composerLayout: {
			mount(
				input: HTMLTextAreaElement,
				report: (height: number) => Promise<Record<string, unknown>>,
				revealCaret: () => void,
			): { (): void; viewport(pane: number, growth: number): void };
		};
		webkit?: { messageHandlers?: { composer?: Transport } };
		mountComposerControls?: (host: {
			input: HTMLTextAreaElement;
			request: typeof request;
			edit: typeof edit;
			notice: (message: string) => void;
			icon: typeof icon;
			preferences: typeof preferences;
		}) => Controls;
	};
	root.composer ??= {};
	const api = root.composer;
	if (!api.logic) throw new Error("Composer logic did not load.");
	const logic: ComposerLogic = api.logic;
	if (api.receive) throw new Error("The composer page already has a receiver.");

	const connections = new Set(["connecting", "connected", "reconnecting", "ended"]);
	const icons: Record<string, string> = {
		info: "M12 7h.01 M12 11v6 M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0",
		send: "M12 19V5 M6 11l6-6 6 6",
		stop: "M7 7h10v10H7z",
		close: "M6 6l12 12 M18 6 6 18",
		terminal: "M3 5h18v14H3z M7 9l4 3-4 3 M13 15h4",

		plus: "M5 12h14 M12 5v14",
		chevron: "M6 9l6 6 6-6",
		edit: "M4 20l4-1 12-12-3-3L5 16z M14 7l3 3",
		larger: "M3 18l5-12 5 12 M5 14h6 M16 10h6 M19 7v6",
		smaller: "M3 18l5-12 5 12 M5 14h6 M16 10h6",
		reset: "M4 11a8 8 0 1 1 2 7 M4 5v6h6",
		steer: "M5 19v-8a5 5 0 0 1 5-5h9 M15 2l4 4-4 4",
		queue: "M4 6h12 M4 12h12 M4 18h8 M18 14v6 M15 17h6",
	};

	function icon(name: string): SVGSVGElement {
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		const path = document.createElementNS(ns, "path");
		svg.setAttribute("class", "i");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("aria-hidden", "true");
		path.setAttribute("d", icons[name] ?? icons.send);
		svg.append(path);
		return svg;
	}
	function get<T extends HTMLElement>(id: string): T {
		const node = document.getElementById(id);
		if (!node) throw new Error(`Missing composer element: ${id}`);
		return node as T;
	}
	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}
	function isThenable(value: unknown): value is PromiseLike<unknown> {
		if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
		return typeof (value as { then?: unknown }).then === "function";
	}
	function messageOf(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
	function replyOf(value: unknown): SubmitReply | null {
		if (!isRecord(value) || value.v !== 1 || typeof value.ok !== "boolean") return null;
		const outcome = value.outcome === "accepted" || value.outcome === "refused" ? value.outcome : undefined;
		return {
			ok: value.ok,
			outcome,
			message: typeof value.message === "string" ? value.message : undefined,
			error: typeof value.error === "string" ? value.error : undefined,
			id: typeof value.id === "string" ? value.id : undefined,
		};
	}

	const panel = get<HTMLElement>("composer");
	const statusText = get<HTMLElement>("status-text");
	const statusState = get<HTMLElement>("status-state");
	const context = get<HTMLElement>("context"),
		contextMeter = get<HTMLElement>("context-meter");
	const percent = get<HTMLElement>("context-percent"),
		tokens = get<HTMLElement>("context-tokens");
	const cost = get<HTMLElement>("session-cost"),
		folder = get<HTMLElement>("session-folder");
	const input = get<HTMLTextAreaElement>("input");
	const hint = get<HTMLElement>("hint");
	const modeButton = get<HTMLButtonElement>("mode");
	const elapsed = get("elapsed"),
		writer = get("writer");
	const returnButton = get<HTMLButtonElement>("return");
	const actionButton = get<HTMLButtonElement>("action");
	const notice = get<HTMLElement>("notice"),
		statusIcon = get("status-icon");
	const fitEditor = root.composerLayout.mount(
		input,
		(height) => request("layout", { height }),
		() => controls?.revealCaret(),
	);

	let status: ComposerStatus = { connection: "connecting" };
	let sendKey: SendKey = "return";
	let delivery: Delivery = "steer";
	const baseSize = 16;
	let textAdjust = 0,
		phaseSince: number | undefined;
	let submitting = false;
	let handshake = false;
	let applying = false;
	let composing = false;
	let sequence = 0;
	let savedStart = 0;
	let savedEnd = 0;
	let actionIcon = "";
	let geometry = { pane: 0, growth: 0, menu: 0 },
		initialised = false;
	function applyViewport() {
		fitEditor.viewport(geometry.pane, geometry.growth);
		controls?.viewport(geometry.menu);
	}
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	let ticket: Ticket | null = null;
	const queued: QueuedEdit[] = [];
	const pending = new Map<string, (reply: SubmitReply) => void>();

	function transport(): Transport | undefined {
		return root.webkit?.messageHandlers?.composer;
	}
	function post(fields: Record<string, unknown>): unknown {
		const handler = transport();
		if (!handler) return undefined;
		try {
			return handler.postMessage({ ...fields, v: 1 });
		} catch (error) {
			console.warn(`[composer] ${messageOf(error)}`);
			return undefined;
		}
	}
	function send(type: string, fields: Record<string, unknown> = {}): unknown {
		return post({ ...fields, type });
	}
	let lastDraft: string | undefined;
	function sendDraft(person = false): void {
		const text = input.value;
		if (handshake && lastDraft !== text) {
			lastDraft = text;
			send("draft", { text });
		}
		controls?.updated(person);
	}
	function sendFlush(): void {
		if (handshake) send("flush", { text: input.value });
	}
	function deliverReply(reply: SubmitReply): void {
		if (reply.id !== undefined) {
			const resolve = pending.get(reply.id);
			if (resolve) {
				pending.delete(reply.id);
				resolve(reply);
			}
			return;
		}
		if (pending.size !== 1) return;
		for (const [id, resolve] of pending) {
			pending.delete(id);
			resolve(reply);
			break;
		}
	}

	function currentSelection(): Selection {
		const start = input.selectionStart ?? savedStart;
		const end = input.selectionEnd ?? start;
		return clampSelection({ start, end });
	}
	function clampSelection(selection: Selection): Selection {
		const max = input.value.length;
		const start = Math.max(0, Math.min(selection.start, max));
		const end = Math.max(start, Math.min(selection.end, max));
		return { start, end };
	}
	function captureSelection(): void {
		const range = currentSelection();
		savedStart = range.start;
		savedEnd = range.end;
	}
	function focusInput(): void {
		input.focus({ preventScroll: true });
	}
	function insertText(text: string): boolean {
		const command = logic.editCommand(text);
		if (!document.queryCommandSupported(command) || !document.execCommand(command, false, text)) {
			showNotice("The editor could not apply this change.", "warn");
			return false;
		}
		return true;
	}
	function applyEdit(edit: QueuedEdit): void {
		if (edit.kind === "replace" && input.value === edit.text) return;
		const wasReadonly = input.readOnly;
		input.readOnly = false;
		focusInput();
		if (edit.kind === "replace") input.setSelectionRange(0, input.value.length);
		else {
			const range = clampSelection(edit.selection);
			input.setSelectionRange(range.start, range.end);
		}
		insertText(edit.text);
		captureSelection();
		input.readOnly = wasReadonly;
	}
	function clearUndoably(): void {
		focusInput();
		input.setSelectionRange(0, input.value.length);
		insertText("");
	}
	async function request(type: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const value = await send(type, fields);
		if (!isRecord(value) || value.v !== 1 || value.ok !== true)
			throw Error(
				isRecord(value) && typeof value.error === "string" ? value.error : "The composer did not confirm this action.",
			);
		return value;
	}
	function edit(change: Change): boolean {
		if (submitting || composing) return false;
		focusInput();
		input.setSelectionRange(change.start, change.end);
		applying = true;
		const applied = change.start === change.end && !change.text ? true : insertText(change.text);
		applying = false;
		if (applied && change.cursor !== undefined) input.setSelectionRange(change.cursor, change.cursor);
		captureSelection();
		render();
		sendDraft();
		return applied;
	}
	function hasDraft(): boolean {
		return logic.draftIsSubmittable(input.value);
	}

	function requestSubmit(id: string, text: string, behavior: Behavior): Promise<SubmitReply> {
		const handler = transport();
		if (!handler) return Promise.resolve({ ok: false, error: "Composer transport is unavailable." });
		let value: unknown;
		try {
			value = handler.postMessage({
				v: 1,
				type: "submit",
				id,
				text,
				behavior: behavior === "queue" ? "followUp" : "send",
			});
		} catch (error) {
			return Promise.resolve({ ok: false, error: messageOf(error) });
		}
		const direct = replyOf(value);
		if (direct) return Promise.resolve(direct);
		if (isThenable(value))
			return Promise.resolve(value).then((reply) => replyOf(reply) ?? { ok: false, error: "Invalid submit reply." });
		return new Promise((resolve) => pending.set(id, resolve));
	}
	function settleSubmit(reply: SubmitReply): void {
		if (!ticket) return;
		const current = ticket;
		ticket = null;
		const accepted = reply.ok && reply.outcome === "accepted";
		const failure = reply.message?.trim() || reply.error?.trim() || "Not sent. Your text is kept.";
		submitting = false;
		input.readOnly = false;
		panel.removeAttribute("aria-busy");
		applying = true;
		try {
			if (accepted) {
				hideNotice();
				clearUndoably();
			}
			for (const edit of queued.splice(0)) applyEdit(edit);
		} finally {
			applying = false;
		}
		if (current.focused) focusInput();
		render();
		sendDraft();
		if (!accepted) showNotice(failure, "failure");
	}
	function submit(behavior: Behavior): void {
		if (submitting || !hasDraft() || status.connection !== "connected" || status.state === "waiting") return;
		const id = `composer-submit-${++sequence}`;
		submitting = true;
		ticket = { id, focused: document.activeElement === input };
		input.readOnly = true;
		captureSelection();
		panel.setAttribute("aria-busy", "true");
		render();
		void requestSubmit(id, input.value, behavior).then(settleSubmit, (error) =>
			settleSubmit({ ok: false, error: messageOf(error) }),
		);
	}
	function takeInit(text: string, key: SendKey): void {
		sendKey = key;
		renderSendKey();
		if (submitting) queued.push({ kind: "replace", text, selection: currentSelection() });
		else {
			input.value = text;
			const end = text.length;
			input.setSelectionRange(end, end);
			savedStart = end;
			savedEnd = end;
		}
		render();
		if (!submitting) sendDraft();
	}
	function takeStatus(next: ComposerStatus): void {
		status = next;
		render();
	}
	function takeEdit(kind: EditKind, text: string): void {
		const edit: QueuedEdit = { kind, text, selection: currentSelection() };
		if (submitting) {
			queued.push(edit);
			return;
		}
		applying = true;
		try {
			applyEdit(edit);
		} finally {
			applying = false;
		}
		render();
		sendDraft();
	}
	function hideNotice() {
		clearTimeout(noticeTimer);
		notice.hidden = true;
		get("dismiss-notice").hidden = true;
		paintStatusIcon();
	}
	function showNotice(text: string, tone: string): void {
		if (!text) return;
		notice.textContent = text;
		notice.dataset.tone = tone;
		notice.hidden = false;
		paintStatusIcon();
		if (noticeTimer !== undefined) clearTimeout(noticeTimer);
		get("dismiss-notice").hidden = tone !== "failure";
		if (tone !== "failure") noticeTimer = setTimeout(hideNotice, 6000);
	}

	function paintAction(kind: string): void {
		if (actionIcon === kind) return;
		actionIcon = kind;
		actionButton.replaceChildren(icon(kind));
	}
	function renderSendKey(): void {
		hint.textContent =
			sendKey === "command"
				? "Press Command-Return to send, or Return for a new line."
				: "Press Return to send, or Shift-Return for a new line.";
	}
	function preferences() {
		return {
			sendKey,
			size: baseSize + textAdjust,
			toggleSendKey() {
				sendKey = logic.sendKeyNext(sendKey);
				renderSendKey();
				render();
				send("sendKey", { value: sendKey });
			},
			resize: changeTextSize,
		};
	}
	function applySize(delta: number) {
		textAdjust = Math.max(-4, Math.min(8, delta));
		for (const element of [panel, get("menu")]) {
			element.style.setProperty("--base-size", `${baseSize}px`);
			element.style.setProperty("--text-adjust", `${textAdjust}px`);
		}
		fitEditor();
	}
	function changeTextSize(step: number) {
		const previous = textAdjust;
		applySize(step === 0 ? 0 : textAdjust + step);
		if (previous !== textAdjust) send("textSize", { value: textAdjust });
	}
	function paintStatusIcon() {
		let kind = "info";
		if (notice.hidden) {
			if (panel.dataset.running === "true") kind = "working";
			else if (status.connection === "reconnecting") kind = "reset";
			else if (status.state === "waiting") kind = "terminal";
		}
		if (statusIcon.dataset.icon === kind) return;
		statusIcon.dataset.icon = kind;
		statusIcon.replaceChildren(...(kind === "working" ? [] : [icon(kind)]));
	}
	function renderDelivery(running: boolean) {
		const next = delivery === "steer" ? "queue" : "steer";
		modeButton.hidden = !running;
		modeButton.dataset.tip = next === "queue" ? "Switch to queue" : "Switch to steer";
		modeButton.setAttribute("aria-label", modeButton.dataset.tip);
		if (modeButton.dataset.mode !== delivery) {
			modeButton.dataset.mode = delivery;
			modeButton.replaceChildren(icon(delivery));
		}
		input.placeholder = !running
			? "Message"
			: `${sendKey === "command" ? "⌘⏎" : "Enter"} to ${delivery === "steer" ? "steer" : "queue a follow-up"}`;
	}
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep related surface states in a single render.
	function render(): void {
		const view = logic.statusView(status);
		const running = status.connection === "connected" && view.working;
		panel.dataset.connection = status.connection;
		panel.dataset.running = String(running);
		statusText.textContent = status.notice ?? view.connectionLabel;
		statusText.hidden = !statusText.textContent;
		paintStatusIcon();
		statusState.textContent = view.stateLabel;
		statusState.hidden = !view.stateLabel;
		elapsed.hidden = !running || phaseSince === undefined;
		returnButton.hidden = status.connection !== "connected" || !logic.showReturn(status.state);
		renderDelivery(running);
		const action = logic.actionFor(status.state, { submitting, hasDraft: hasDraft(), connection: status.connection });
		const kind = action.kind === "stop" ? "stop" : running ? delivery : "send";
		actionButton.dataset.kind = action.kind;
		actionButton.disabled = action.disabled;
		const key = sendKey === "command" ? "⌘⏎" : "⏎";
		actionButton.dataset.tip =
			kind === "stop" ? "Stop · esc" : (kind === "queue" ? "Queue " : kind === "steer" ? "Steer " : "Send ") + key;
		const labels = { stop: "Stop Pi", queue: "Queue follow-up", steer: "Send steer", send: "Send message" };
		actionButton.setAttribute("aria-label", labels[kind]);
		paintAction(kind === "stop" ? "stop" : "send");
		fitEditor();
	}

	for (let i = 0; i < 10; i++) contextMeter.append(document.createElement("i"));
	function tokenCount(value: number) {
		if (value >= 1_000_000) return `${String((value / 1_000_000).toFixed(1))}M`;
		return value >= 1000 ? `${String(Number((value / 1000).toFixed(1)))}k` : String(value);
	}
	function number(value: unknown): number | undefined {
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	}
	function paintCells(fraction: number | undefined) {
		contextMeter.hidden = fraction === undefined;
		const pct = Math.min(100, fraction ?? 0);
		contextMeter.setAttribute("aria-valuenow", String(pct));
		contextMeter.dataset.tone = pct >= 90 ? "error" : pct >= 75 ? "warning" : "ok";
		Array.from(contextMeter.children).forEach((cell, i) => {
			cell.toggleAttribute("data-used", i < Math.round(pct / 10));
		});
	}
	function paintContext(value: unknown) {
		const usage = isRecord(value) ? value : {};
		const used = number(usage.tokens),
			windowSize = number(usage.window),
			percentage = number(usage.percent);
		const fraction = percentage ?? (used !== undefined && windowSize ? (used / windowSize) * 100 : undefined);
		context.hidden = fraction === undefined && windowSize === undefined;
		paintCells(fraction);
		percent.textContent = fraction === undefined ? "" : `${Math.round(fraction)}%`;
		tokens.textContent =
			windowSize === undefined ? "" : `${used === undefined ? "–" : tokenCount(used)}/${tokenCount(windowSize)}`;
		tokens.hidden = !tokens.textContent;
	}
	function paintMetrics(state: Record<string, unknown>) {
		paintContext(state.context);
		const dollars = number(state.cost);
		cost.hidden = dollars === undefined;
		cost.textContent = dollars === undefined ? "" : `~$${dollars.toFixed(2)}`;
		cost.setAttribute(
			"aria-label",
			dollars === undefined ? "" : `Session cost: approximately ${dollars.toFixed(2)} US dollars`,
		);
		const cwd = typeof state.cwd === "string" ? state.cwd : "";
		folder.hidden = !cwd;
		folder.dataset.path = cwd;
		folder.title = cwd;
		fitFolder();
	}

	const measureFolder = document.createElement("canvas").getContext("2d");
	function fitFolder() {
		const path = folder.dataset.path;
		if (!path || !measureFolder) return;
		const style = getComputedStyle(folder);
		measureFolder.font = `${style.fontSize} ${style.fontFamily}`;
		let suffix = path;
		const parts = path.split("/").filter(Boolean);
		while (parts.length > 1 && measureFolder.measureText(suffix).width > folder.clientWidth) {
			parts.shift();
			suffix = `…/${parts.join("/")}`;
		}
		folder.textContent = measureFolder.measureText(suffix).width <= folder.clientWidth ? suffix : "…";
	}
	new ResizeObserver(fitFolder).observe(folder);
	function phaseOf(value: unknown): string | undefined {
		if (!isRecord(value)) return undefined;
		if (isRecord(value.waiting)) return "waiting";
		return typeof value.phase === "string" ? value.phase : undefined;
	}
	function waitingCommand(value: unknown): string | undefined {
		if (!isRecord(value) || !isRecord(value.waiting)) return undefined;
		const command = value.waiting.command;
		return typeof command === "string" && command && command.length <= 64 && !/[\p{Cc}\p{Cf}\s]/u.test(command)
			? command
			: undefined;
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The switch validates one envelope type per branch.
	function receive(value: unknown): boolean {
		const reply = replyOf(value);
		if (reply) {
			deliverReply(reply);
			return true;
		}
		if (!isRecord(value) || value.v !== 1 || typeof value.type !== "string") return false;
		switch (value.type) {
			case "init": {
				const key = value.sendKey;
				if (typeof value.text !== "string" || (key !== "return" && key !== "command")) return false;
				if (typeof value.textAdjust === "number" && Number.isFinite(value.textAdjust)) textAdjust = value.textAdjust;
				applySize(textAdjust);
				takeInit(value.text, key);
				initialised = true;
				applyViewport();
				controls?.prefetch();
				return true;
			}
			case "viewport": {
				const pane = number(value.pane),
					growth = number(value.growth),
					menu = number(value.menu);
				if (pane === undefined || growth === undefined || menu === undefined) return false;
				geometry = { pane, growth, menu };
				if (initialised) applyViewport();
				return true;
			}
			case "metrics":
				fitEditor();
				return true;
			case "status": {
				const connection = value.connection;
				if (typeof connection !== "string" || !connections.has(connection)) return false;
				const state = isRecord(value.state) ? value.state : {};
				phaseSince = typeof state.since === "number" ? state.since : undefined;
				takeStatus({
					connection,
					state: phaseOf(value.state),
					command: waitingCommand(value.state),
					notice: typeof value.notice === "string" ? value.notice : undefined,
				});
				controls?.sync(state, connection);
				paintMetrics(connection === "connected" ? state : {});
				paintElapsed();
				return true;
			}
			case "replace":
			case "insert": {
				if (typeof value.text !== "string") return false;
				takeEdit(value.type === "replace" ? "replace" : "insert", value.text);
				return true;
			}
			case "focus": {
				focusInput();
				const range = clampSelection({ start: savedStart, end: savedEnd });
				input.setSelectionRange(range.start, range.end);
				return true;
			}
			case "escape": {
				if (!controls?.key(new KeyboardEvent("keydown", { key: "Escape" }))) handleEscape();
				return true;
			}
			case "history": {
				if (!Array.isArray(value.entries)) return false;
				controls?.history(value.entries.filter((item): item is string => typeof item === "string"));
				return true;
			}
			case "recovery": {
				if (typeof value.label !== "string") return false;
				controls?.recovery(value.label);
				return true;
			}
			case "paths": {
				controls?.paste(value.paths);
				return true;
			}
			case "notice": {
				if (typeof value.text !== "string") return false;
				showNotice(value.text, typeof value.tone === "string" ? value.tone : "info");
				return true;
			}
			default:
				return false;
		}
	}

	input.addEventListener("input", () => {
		if (applying) return;
		captureSelection();
		sendDraft(true);
		const disabled = logic.actionFor(status.state, {
			submitting,
			hasDraft: hasDraft(),
			connection: status.connection,
		}).disabled;
		if (actionButton.disabled !== disabled) actionButton.disabled = disabled;
		fitEditor();
	});
	input.addEventListener("blur", () => {
		captureSelection();
		if (!submitting) sendFlush();
	});
	input.addEventListener("focus", captureSelection);
	input.addEventListener("select", captureSelection);
	input.addEventListener("keyup", captureSelection);
	input.addEventListener("mouseup", captureSelection);
	input.addEventListener("compositionstart", () => {
		composing = true;
	});
	input.addEventListener("compositionend", () => {
		composing = false;
		captureSelection();
		sendDraft();
	});
	input.addEventListener("keydown", (event) => {
		if (composing) return;
		if (controls?.key(event)) {
			event.preventDefault();
			return;
		}
		if (event.key !== "Escape" && event.key !== "Enter") return;
		const decision = logic.keyDecision(
			{
				key: event.key,
				metaKey: event.metaKey,
				ctrlKey: event.ctrlKey,
				altKey: event.altKey,
				shiftKey: event.shiftKey,
				isComposing: event.isComposing,
			},
			{
				sendKey,
				delivery,
				state: status.state,
				connection: status.connection,
				submitting,
				readonly: input.readOnly,
				hasDraft: hasDraft(),
			},
		);
		if (decision.kind === "none") return;
		event.preventDefault();
		if (decision.kind === "release" || decision.kind === "abort") {
			handleEscape();
			return;
		}
		if (decision.behavior) submit(decision.behavior);
	});

	function handleEscape(): void {
		if (status.connection === "connected" && ["working", "compacting"].includes(status.state ?? "")) send("abort");
		else {
			send("release");
			input.blur();
		}
	}
	actionButton.addEventListener("click", () => {
		const action = logic.actionFor(status.state, { submitting, hasDraft: hasDraft(), connection: status.connection });
		if (action.kind === "stop") {
			send("abort");
			return;
		}
		submit(logic.submitBehavior(status.state, delivery));
	});
	modeButton.addEventListener("click", () => {
		delivery = delivery === "steer" ? "queue" : "steer";
		render();
		focusInput();
	});
	returnButton.addEventListener("click", () => {
		send("release");
		input.blur();
	});
	for (const button of document.querySelectorAll("button"))
		button.addEventListener("pointerdown", captureSelection, true);
	get("dismiss-notice").append(icon("close"));
	get("dismiss-notice").addEventListener("click", () => {
		hideNotice();
		focusInput();
	});
	get("add").append(icon("plus"));
	const chevron = icon("chevron");
	chevron.classList.add("chevron");
	get("model").dataset.tip = "Choose model and thinking level";
	get("model").append(chevron);

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Distinguish Mac resize chords and the ordered Escape actions.
	document.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.isComposing || composing) return;
		if (event.metaKey && !event.altKey && !event.ctrlKey && ["+", "=", "-", "0"].includes(event.key)) {
			event.preventDefault();
			changeTextSize(event.key === "0" ? 0 : event.key === "-" ? -1 : 1);
		} else if (event.key === "Escape") {
			event.preventDefault();
			if (!controls?.key(event)) handleEscape();
		}
	});

	writer.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest("button, textarea")) return;
		event.preventDefault();
		const highlight = get("highlight"),
			rect = input.getBoundingClientRect();
		const x = Math.max(rect.left + 0.5, Math.min(rect.right - 0.5, event.clientX));
		const y = Math.max(rect.top + 0.5, Math.min(rect.bottom - 0.5, event.clientY));
		input.style.pointerEvents = "none";
		highlight.style.pointerEvents = "auto";
		const hit = document.caretRangeFromPoint(x, y);
		highlight.style.pointerEvents = "";
		input.style.pointerEvents = "";
		let offset = event.clientY < rect.top ? 0 : input.value.length;
		if (hit && highlight.contains(hit.startContainer)) {
			const prefix = document.createRange();
			prefix.selectNodeContents(highlight);
			prefix.setEnd(hit.startContainer, hit.startOffset);
			offset = Math.min(input.value.length, prefix.toString().length);
		}
		focusInput();
		input.setSelectionRange(offset, offset);
		captureSelection();
	});

	const tip = get("tooltip");
	let tipTimer: ReturnType<typeof setTimeout> | undefined;
	function hideTip() {
		clearTimeout(tipTimer);
		tip.hidden = true;
	}
	function queueTip(event: Event) {
		const button = event.target instanceof HTMLButtonElement ? event.target : null;
		if (!button?.dataset.tip || (event instanceof FocusEvent && !button.matches(":focus-visible"))) return;
		hideTip();
		tipTimer = setTimeout(() => {
			if (!button.isConnected || !button.getClientRects().length) return;
			tip.textContent = button.dataset.tip ?? "";
			tip.hidden = !tip.textContent;
			const rect = button.getBoundingClientRect();
			const top = rect.top - tip.offsetHeight - 5;
			const paper = panel.getBoundingClientRect();
			tip.style.top = `${top >= paper.top - geometry.menu + 4 ? top : Math.min(paper.bottom - tip.offsetHeight - 4, rect.bottom + 5)}px`;
			tip.style.left = `${Math.max(4, Math.min(innerWidth - tip.offsetWidth - 4, rect.left + (rect.width - tip.offsetWidth) / 2))}px`;
		}, 600);
	}
	document.addEventListener("pointerenter", queueTip, true);
	document.addEventListener("focusin", queueTip);
	document.addEventListener(
		"pointerdown",
		() => {
			requestAnimationFrame(() => {
				void request("focusTrace", { editor: document.activeElement === input }).catch(() => {});
			});
		},
		{ capture: true },
	);
	document.addEventListener(
		"pointerleave",
		(event) => {
			if (event.target instanceof HTMLButtonElement) hideTip();
		},
		true,
	);
	for (const type of ["focusout", "pointerdown", "keydown", "scroll"]) document.addEventListener(type, hideTip, true);

	function paintElapsed() {
		if (phaseSince === undefined || elapsed.hidden) return;
		const seconds = Math.max(0, Math.floor((Date.now() - phaseSince) / 1000));
		const time = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
		elapsed.textContent = time;
	}
	setInterval(paintElapsed, 1000);
	const controls = root.mountComposerControls?.({
		input,
		request,
		edit,
		icon,
		preferences,
		notice: (message) => showNotice(message, "warn"),
	});
	api.receive = receive;
	renderSendKey();
	render();
	handshake = true;
	send("ready");
	focusInput();
})();
