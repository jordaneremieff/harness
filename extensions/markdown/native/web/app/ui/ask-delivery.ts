(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	function confirmed(state: ReaderAskState) {
		return ["sent", "admitted", "working", "answered", "unanswered"].includes(state);
	}
	function accepts(old: ReaderAskState, next: ReaderAskState) {
		// Only a local retry starts a new attempt. A late native 'sending' event does not.
		if (next === "sending" || old === "answered" || old === "unanswered") return false;
		if (next === "unknown" || next === "failed") return !confirmed(old) && !(old === "failed" && next === "unknown");
		if (old === "unknown" && confirmed(next)) return true;
		return api.uiLogic.promptTransition(old, next) === next;
	}
	function evidence(message: ReaderAskMessage, next: ReaderAskState, detail?: string) {
		const old = message.state;
		if (!accepts(old, next)) return;
		message.state = next;
		if (detail !== undefined || old !== next) message.detail = detail;
		if (next !== "unknown") message.retryable = false;
	}
	function receiveReceipt(message: ReaderAskMessage, receipt: ReaderPromptReceipt) {
		if (receipt.uncertain) {
			evidence(message, "unknown", receipt.detail);
			if (message.state === "unknown") message.retryable = receipt.retryable === true;
		} else evidence(message, receipt.accepted ? "sent" : "failed", receipt.detail);
	}
	function transportError(message: ReaderAskMessage, error: unknown) {
		if (message.state !== "sending" && message.state !== "unknown") return;
		evidence(message, "unknown", String(error));
		message.retryable ??= true;
	}
	function ready(message: ReaderAskMessage) {
		return (
			message.state === "sending" || message.state === "failed" || (message.state === "unknown" && message.retryable)
		);
	}
	api.createAskDelivery = (sessions, version, request) => {
		const inFlight = new WeakSet<ReaderAskMessage>();
		function current(owner: ReaderAskDocument) {
			if (owner !== sessions.shown) return undefined;
			const base = version();
			return base?.documentKey === owner.documentKey ? base : undefined;
		}
		async function attempt(
			delivery: ReaderAskDelivery,
			base: ReaderPromptVersion,
			allowRebase: boolean,
		): Promise<void> {
			const { owner, thread, message } = delivery;
			const packet = sessions.packet(thread, message, base);
			const receipt = await request(packet);
			// A fresh refusal proves native never registered these bytes. Every uncertain retry must replay them.
			if (receipt.accepted || receipt.fresh) sessions.releasePacket(message);
			if (receipt.fresh && allowRebase && ["sending", "unknown"].includes(message.state)) {
				const next = current(owner);
				if (next && (packet.presentation !== next.presentation || packet.generation !== next.generation))
					return attempt(delivery, next, false);
			}
			receiveReceipt(message, receipt);
		}
		async function submit(owner: ReaderAskDocument, thread: ReaderThread, message: ReaderAskMessage) {
			const registered = sessions.delivery(message.requestId, thread.threadId);
			if (registered?.owner !== owner || registered.thread !== thread || registered.message !== message) return;
			const base = current(owner);
			if (!base || !ready(message) || inFlight.has(message) || !owner.threads.includes(thread)) return;
			inFlight.add(message);
			message.state = "sending";
			message.retryable = undefined;
			try {
				await attempt(registered, base, true);
			} catch (error) {
				transportError(message, error);
			} finally {
				inFlight.delete(message);
			}
		}
		return {
			submit,
			update(event) {
				const delivery = sessions.delivery(event.requestId, event.threadId);
				if (!delivery || (event.documentKey !== undefined && delivery.owner.documentKey !== event.documentKey)) return;
				evidence(delivery.message, event.state, event.detail);
				return delivery;
			},
		};
	};
})();
