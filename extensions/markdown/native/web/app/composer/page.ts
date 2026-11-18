(() => {
	type SendKey = "return" | "command";
	type Behavior = "send" | "steer" | "queue";
	type EditKind = "replace" | "insert";
	interface ComposerStatus {
		connection: string;
		notice?: string;
		state?: string;
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
				state?: string;
				connection?: string;
				submitting?: boolean;
				readonly?: boolean;
				hasDraft?: boolean;
			},
		): KeyDecision;
		actionFor(state: string | undefined, options?: ActionOptions): Action;
		showChoices(state: string | undefined, options?: ActionOptions): boolean;
		showReturn(state?: string): boolean;
		editCommand(text: string): "insertText" | "delete";
		sendKeyLabel(sendKey: SendKey): string;
		sendKeyNext(sendKey: SendKey): SendKey;
		draftIsSubmittable(text: string): boolean;
	}
	interface Change { start: number; end: number; text: string; cursor?: number }
	interface Controls {
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
		webkit?: { messageHandlers?: { composer?: Transport } };
		mountComposerControls?: (host: { input: HTMLTextAreaElement; request: typeof request; edit: typeof edit; notice: (message: string) => void }) => Controls;
	};
	root.composer ??= {};
	const api = root.composer;
	if (!api.logic) throw new Error("Composer logic did not load.");
	const logic: ComposerLogic = api.logic;
	if (api.receive) throw new Error("The composer page already has a receiver.");

	const connections = new Set(["connecting", "connected", "reconnecting", "ended"]);
	const icons: Record<string, string> = {
		send: "M12 19V5 M6 11l6-6 6 6",
		stop: "M7 7h10v10H7z",
		close: "M6 6l12 12 M18 6 6 18",
		terminal: "M3 5h18v14H3z M7 9l4 3-4 3 M13 15h4",
		model: "M5 5h14v14H5z M9 9h6v6H9z M9 2v3 M15 2v3 M9 19v3 M15 19v3 M2 9h3 M2 15h3 M19 9h3 M19 15h3",
		thinking: "M12 3c.6 5 2 6.4 7 7-5 .6-6.4 2-7 7-.6-5-2-6.4-7-7 5-.6 6.4-2 7-7 M19 16v5 M16.5 18.5h5",
		steer: "M4 12h12 M12 6l6 6-6 6 M20 5v14",
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
	const context = get<HTMLElement>("context"), contextMeter = get<HTMLMeterElement>("context-meter");
	const percent = get<HTMLElement>("context-percent"), tokens = get<HTMLElement>("context-tokens");
	const cost = get<HTMLElement>("session-cost"), folder = get<HTMLElement>("session-folder");
	const closeButton = get<HTMLButtonElement>("close");
	const input = get<HTMLTextAreaElement>("input");
	const hint = get<HTMLElement>("hint");
	const sendKeyButton = get<HTMLButtonElement>("sendkey");
	const sendKeyLabel = get<HTMLElement>("sendkey-label");
	const choices = get<HTMLElement>("choices");
	const queueButton = get<HTMLButtonElement>("queue");
	const returnButton = get<HTMLButtonElement>("return");
	const actionButton = get<HTMLButtonElement>("action");
	const actionLabel = get<HTMLElement>("action-label");
	const notice = get<HTMLElement>("notice");

	let status: ComposerStatus = { connection: "connecting" };
	let sendKey: SendKey = "return";
	let submitting = false;
	let handshake = false;
	let applying = false;
	let composing = false;
	let sequence = 0;
	let savedStart = 0;
	let savedEnd = 0;
	let actionIcon = "";
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
	function sendDraft(): void {
		if (handshake) send("draft", { text: input.value });
		controls?.updated();
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
		if (!isRecord(value) || value.v !== 1 || value.ok !== true) throw Error(isRecord(value) && typeof value.error === "string" ? value.error : "The composer did not confirm this action.");
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
			value = handler.postMessage({ v: 1, type: "submit", id, text, behavior: behavior === "queue" ? "followUp" : "send" });
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
		const message = reply.message ?? reply.error ?? (accepted ? "Sent" : "Not sent. Your text is kept.");
		submitting = false;
		input.readOnly = false;
		panel.removeAttribute("aria-busy");
		applying = true;
		try {
			if (accepted) clearUndoably();
			for (const edit of queued.splice(0)) applyEdit(edit);
		} finally {
			applying = false;
		}
		if (current.focused) focusInput();
		render();
		sendDraft();
		if (!accepted) showNotice(message, "warn");
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
		void requestSubmit(id, input.value, behavior).then(settleSubmit, (error) => settleSubmit({ ok: false, error: messageOf(error) }));
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
	function showNotice(text: string, tone: string): void {
		if (!text) return;
		notice.textContent = text;
		notice.dataset.tone = tone;
		notice.hidden = false;
		if (noticeTimer !== undefined) clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => {
			notice.hidden = true;
			noticeTimer = undefined;
		}, 6000);
	}

	function paintAction(kind: "send" | "stop"): void {
		if (actionIcon === kind) return;
		actionIcon = kind;
		actionButton.replaceChildren(icon(kind === "stop" ? "stop" : "send"), actionLabel);
	}
	function renderSendKey(): void {
		sendKeyLabel.textContent = logic.sendKeyLabel(sendKey);
		sendKeyButton.setAttribute(
			"aria-label",
			sendKey === "command" ? "Send key: Command-Return. Activate to use Return." : "Send key: Return. Activate to use Command-Return.",
		);
		hint.textContent =
			sendKey === "command"
				? "Press Command-Return to send, or Return for a new line."
				: "Press Return to send, or Shift-Return for a new line.";
	}
	function render(): void {
		const view = logic.statusView(status);
		const draft = hasDraft();
		panel.dataset.connection = status.connection;
		if (status.state) panel.dataset.state = status.state;
		else delete panel.dataset.state;
		statusText.textContent = status.notice ?? view.connectionLabel;
		statusState.textContent = view.stateLabel;
		statusState.hidden = !view.stateLabel;
		returnButton.hidden = !logic.showReturn(status.state);
		choices.hidden = !logic.showChoices(status.state, {
			submitting,
			hasDraft: draft,
			connection: status.connection,
		});
		const action = logic.actionFor(status.state, { submitting, hasDraft: draft, connection: status.connection });
		actionButton.dataset.kind = action.kind;
		actionButton.disabled = action.disabled;
		actionButton.setAttribute("aria-label", action.kind === "stop" ? "Stop Pi" : "Send message");
		actionLabel.textContent = action.label;
		paintAction(action.kind);
	}

	const tokenFormat = new Intl.NumberFormat("en-AU", { notation: "compact", maximumFractionDigits: 1 });
	function number(value: unknown): number | undefined {
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	}
	function paintContext(value: unknown) {
		const usage = isRecord(value) ? value : {};
		const used = number(usage.tokens), windowSize = number(usage.window), percentage = number(usage.percent);
		const fraction = percentage ?? (used !== undefined && windowSize ? used / windowSize * 100 : undefined);
		context.hidden = fraction === undefined && windowSize === undefined;
		contextMeter.hidden = fraction === undefined;
		contextMeter.value = Math.min(100, fraction ?? 0);
		percent.textContent = fraction === undefined ? "" : `${Math.round(fraction)}%`;
		tokens.textContent = windowSize === undefined ? "" : `${used === undefined ? "–" : tokenFormat.format(used)}/${tokenFormat.format(windowSize)}`;
		tokens.hidden = !tokens.textContent;
	}
	function paintMetrics(state: Record<string, unknown>) {
		paintContext(state.context);
		const dollars = number(state.cost);
		cost.hidden = dollars === undefined;
		cost.textContent = dollars === undefined ? "" : `~$${dollars.toFixed(2)}`;
		cost.setAttribute("aria-label", dollars === undefined ? "" : `Session cost: approximately ${dollars.toFixed(2)} US dollars`);
		const cwd = typeof state.cwd === "string" ? state.cwd : "";
		folder.hidden = !cwd;
		folder.textContent = cwd.split("/").filter(Boolean).at(-1) ?? cwd;
	}

	function phaseOf(value: unknown): string | undefined {
		if (!isRecord(value)) return undefined;
		if (isRecord(value.waiting)) return "waiting";
		return typeof value.phase === "string" ? value.phase : undefined;
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
				takeInit(value.text, key);
				return true;
			}
			case "status": {
				const connection = value.connection;
				if (typeof connection !== "string" || !connections.has(connection)) return false;
				takeStatus({ connection, state: phaseOf(value.state), notice: typeof value.notice === "string" ? value.notice : undefined });
				const state = isRecord(value.state) ? value.state : {};
				controls?.sync(state, connection);
				paintMetrics(connection === "connected" ? state : {});
				phaseSince = typeof state.since === "number" ? state.since : undefined;
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
				handleEscape();
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
		captureSelection();
		if (!applying) { sendDraft(); controls?.updated(true); }
		render();
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
		if (controls?.key(event)) { event.preventDefault(); return; }
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
		else { send("release"); input.blur(); }
	}
	actionButton.addEventListener("click", () => {
		const action = logic.actionFor(status.state, { submitting, hasDraft: hasDraft(), connection: status.connection });
		if (action.kind === "stop") {
			send("abort");
			return;
		}
		submit("send");
	});
	queueButton.addEventListener("click", () => submit("queue"));
	closeButton.addEventListener("click", () => {
		send("close");
		input.blur();
	});
	returnButton.addEventListener("click", () => {
		send("release");
		input.blur();
	});
	sendKeyButton.addEventListener("click", () => {
		sendKey = logic.sendKeyNext(sendKey);
		renderSendKey();
		send("sendKey", { value: sendKey });
	});
	for (const button of document.querySelectorAll("button"))
		button.addEventListener("pointerdown", captureSelection, true);

	closeButton.append(icon("close"));
	queueButton.prepend(icon("queue"));
	returnButton.prepend(icon("terminal"));
	// Stage 2 owns model and thinking selection, history and completion menus; these controls stay
	// fixed, labelled placeholders until that surface exists.
	get<HTMLButtonElement>("model").prepend(icon("model"));
	get<HTMLButtonElement>("thinking").prepend(icon("thinking"));
	actionButton.replaceChildren(icon("send"), actionLabel);
	actionIcon = "send";

	let phaseSince: number | undefined;
	function paintElapsed() {
		const label = logic.statusView(status).stateLabel;
		if (phaseSince === undefined || !["working", "compacting"].includes(status.state ?? "") || !label) return;
		const seconds = Math.max(0, Math.floor((Date.now() - phaseSince) / 1000));
		const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
		statusState.textContent = `${label} · ${elapsed}`;
	}
	setInterval(paintElapsed, 1000);
	const controls = root.mountComposerControls?.({ input, request, edit, notice: (message) => showNotice(message, "warn") });
	api.receive = receive;
	renderSendKey();
	render();
	handshake = true;
	send("ready");
	focusInput();
})();
