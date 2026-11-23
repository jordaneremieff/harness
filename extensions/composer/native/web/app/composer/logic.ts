(() => {
	type SendKey = "return" | "command";
	type Behavior = "send" | "steer" | "queue";
	type KeyDecision =
		| { kind: "none" }
		| { kind: "release" }
		| { kind: "abort" }
		| { kind: "consume" }
		| { kind: "submit"; behavior: Behavior };
	interface ComposerStatus {
		connection: string;
		state?: string;
		/** The composer's command whose view holds Pi's terminal, when Pi reports one. */
		command?: string;
	}
	interface StatusView {
		connectionLabel: string;
		stateLabel: string;
		waiting: boolean;
		working: boolean;
	}
	interface ComposerKey {
		key: string;
		metaKey?: boolean;
		ctrlKey?: boolean;
		altKey?: boolean;
		shiftKey?: boolean;
		isComposing?: boolean;
	}
	interface KeyContext {
		sendKey: SendKey;
		delivery?: "steer" | "queue";
		state?: string;
		connection?: string;
		submitting?: boolean;
		readonly?: boolean;
		hasDraft?: boolean;
	}
	interface ActionOptions {
		submitting?: boolean;
		hasDraft?: boolean;
		connection?: string;
	}
	interface Action {
		kind: "send" | "stop";
		label: string;
		disabled: boolean;
	}
	interface ComposerLogic {
		contextDisplay(percent: number): {
			percent: number;
			clamped: number;
			cells: number;
			tone: "ok" | "warning" | "error";
		};
		statusView(status?: ComposerStatus): StatusView;
		keyDecision(event: ComposerKey, context: KeyContext): KeyDecision;
		submitBehavior(state?: string, delivery?: "steer" | "queue"): Behavior;
		actionFor(state: string | undefined, options?: ActionOptions): Action;
		showReturn(state?: string): boolean;
		editCommand(text: string): "insertText" | "delete";
		sendKeyNext(sendKey: SendKey): SendKey;
		draftIsSubmittable(text: string): boolean;
	}
	interface ComposerRoot {
		logic?: ComposerLogic;
		receive?: (envelope: unknown) => boolean;
	}

	const connectionLabels: Record<string, string> = {
		connecting: "Connecting…",
		reconnecting: "Reconnecting to Pi…",
		ended: "Pi ended",
	};
	const stateLabels: Record<string, string> = {
		waiting: "Pi needs an answer in the terminal",
		compacting: "Compacting",
		working: "Working",
	};
	function isWorking(state?: string): boolean {
		return state === "working" || state === "compacting";
	}
	function stateLabel(status: ComposerStatus): string {
		if (status.state === "waiting" && status.command) return `/${status.command} is open in the terminal`;
		return stateLabels[status.state ?? ""] ?? "";
	}
	function statusView(status?: ComposerStatus): StatusView {
		return {
			connectionLabel: connectionLabels[status?.connection ?? "connecting"] ?? "",
			stateLabel: status?.connection === "connected" ? stateLabel(status) : "",
			waiting: status?.state === "waiting",
			working: isWorking(status?.state),
		};
	}
	function submitBehavior(state?: string, delivery: "steer" | "queue" = "steer"): Behavior {
		return isWorking(state) ? delivery : "send";
	}
	function actionFor(state: string | undefined, options: ActionOptions = {}): Action {
		const disabled = options.connection !== "connected" || options.submitting === true || state === "waiting";
		if (isWorking(state)) return { kind: "stop", label: "Stop", disabled };
		return { kind: "send", label: "Send", disabled: disabled || !options.hasDraft };
	}
	function showReturn(state?: string): boolean {
		return state === "waiting";
	}
	function isSendKey(event: ComposerKey, key: SendKey) {
		return (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.ctrlKey &&
			(event.altKey || Boolean(event.metaKey) === (key === "command"))
		);
	}
	function unavailable(context: KeyContext) {
		return (
			context.submitting ||
			context.readonly ||
			!context.hasDraft ||
			context.connection !== "connected" ||
			context.state === "waiting"
		);
	}
	function chosenDelivery(event: ComposerKey, context: KeyContext): "steer" | "queue" {
		const mode = context.delivery ?? "steer";
		if (!event.altKey) return mode;
		return mode === "queue" ? "steer" : "queue";
	}
	function keyDecision(event: ComposerKey, context: KeyContext): KeyDecision {
		if (event.isComposing) return { kind: "none" };
		if (event.key === "Escape")
			return { kind: context.connection === "connected" && isWorking(context.state) ? "abort" : "release" };
		if (!isSendKey(event, context.sendKey)) return { kind: "none" };
		if (unavailable(context)) return { kind: "consume" };
		return { kind: "submit", behavior: submitBehavior(context.state, chosenDelivery(event, context)) };
	}
	function editCommand(text: string): "insertText" | "delete" {
		return text.length > 0 ? "insertText" : "delete";
	}
	function sendKeyNext(sendKey: SendKey): SendKey {
		return sendKey === "command" ? "return" : "command";
	}
	function draftIsSubmittable(text: string): boolean {
		return /\S/u.test(text);
	}

	// Match the terminal statusline: round before assigning the display band and fill.
	function contextDisplay(percent: number) {
		const rounded = Math.max(0, Math.round(percent));
		const clamped = Math.min(100, rounded);
		const tone = clamped > 80 ? "error" : clamped > 60 ? "warning" : "ok";
		return { percent: rounded, clamped, cells: Math.round(clamped / 10), tone } as const;
	}

	const root = globalThis as typeof globalThis & { composer?: ComposerRoot };
	root.composer ??= {};
	const composer = root.composer;
	composer.logic = {
		contextDisplay,
		statusView,
		keyDecision,
		submitBehavior,
		actionFor,
		showReturn,
		editCommand,
		sendKeyNext,
		draftIsSubmittable,
	};
})();
