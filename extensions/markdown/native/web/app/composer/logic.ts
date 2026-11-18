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
		statusView(status?: ComposerStatus): StatusView;
		keyDecision(event: ComposerKey, context: KeyContext): KeyDecision;
		submitBehavior(state?: string): Behavior;
		actionFor(state: string | undefined, options?: ActionOptions): Action;
		showChoices(state: string | undefined, options?: ActionOptions): boolean;
		showReturn(state?: string): boolean;
		editCommand(text: string): "insertText" | "delete";
		sendKeyLabel(sendKey: SendKey): string;
		sendKeyNext(sendKey: SendKey): SendKey;
		draftIsSubmittable(text: string): boolean;
	}
	interface ComposerRoot {
		logic?: ComposerLogic;
		receive?: (envelope: unknown) => boolean;
	}

  const connectionLabels: Record<string, string> = { connecting: "Connecting…", reconnecting: "Reconnecting to Pi…", ended: "Pi ended" };
  const stateLabels: Record<string, string> = { waiting: "Pi needs an answer in the terminal", compacting: "Compacting", working: "Working" };
  function isWorking(state?: string): boolean { return state === "working" || state === "compacting"; }
  function statusView(status?: ComposerStatus): StatusView {
    return {
      connectionLabel: connectionLabels[status?.connection ?? "connecting"] ?? "",
      stateLabel: status?.connection === "connected" ? stateLabels[status.state ?? ""] ?? "" : "",
      waiting: status?.state === "waiting",
      working: isWorking(status?.state),
    };
  }
  function submitBehavior(state?: string): Behavior { return isWorking(state) ? "steer" : "send"; }
  function actionFor(state: string | undefined, options: ActionOptions = {}): Action {
    const disabled = options.connection !== "connected" || options.submitting === true || state === "waiting";
    if (isWorking(state) && !options.hasDraft) return { kind: "stop", label: "Stop", disabled };
    return { kind: "send", label: isWorking(state) ? "Steer" : "Send", disabled: disabled || !options.hasDraft };
  }
  function showChoices(state: string | undefined, options: ActionOptions = {}): boolean {
    return isWorking(state) && options.hasDraft === true && options.submitting !== true && options.connection === "connected";
  }
  function showReturn(state?: string): boolean { return state === "waiting"; }
  function isSendKey(event: ComposerKey, key: SendKey) {
    return event.key === "Enter" && !event.shiftKey && !event.ctrlKey && (event.altKey || Boolean(event.metaKey) === (key === "command"));
  }
  function unavailable(context: KeyContext) {
    return context.submitting || context.readonly || !context.hasDraft || context.connection !== "connected" || context.state === "waiting";
  }
  function keyDecision(event: ComposerKey, context: KeyContext): KeyDecision {
    if (event.isComposing) return { kind: "none" };
    if (event.key === "Escape") return { kind: context.connection === "connected" && isWorking(context.state) ? "abort" : "release" };
    if (!isSendKey(event, context.sendKey)) return { kind: "none" };
    if (unavailable(context)) return { kind: "consume" };
    return { kind: "submit", behavior: event.altKey && isWorking(context.state) ? "queue" : submitBehavior(context.state) };
  }
	function editCommand(text: string): "insertText" | "delete" {
		return text.length > 0 ? "insertText" : "delete";
	}
	function sendKeyLabel(sendKey: SendKey): string {
		return sendKey === "command" ? "⌘⏎ send" : "⏎ send";
	}
	function sendKeyNext(sendKey: SendKey): SendKey {
		return sendKey === "command" ? "return" : "command";
	}
	function draftIsSubmittable(text: string): boolean {
		return /\S/u.test(text);
	}

	const root = globalThis as typeof globalThis & { composer?: ComposerRoot };
	root.composer ??= {};
	const composer = root.composer;
	composer.logic = {
		statusView,
		keyDecision,
		submitBehavior,
		actionFor,
		showChoices,
		showReturn,
		editCommand,
		sendKeyLabel,
		sendKeyNext,
		draftIsSubmittable,
	};
})();
