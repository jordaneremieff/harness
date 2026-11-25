export {};

declare global {
	interface ReaderPromptReceipt {
		accepted: boolean;
		uncertain?: true;
		retryable?: boolean;
		fresh?: boolean;
		detail?: string;
	}
	interface ReaderPromptEvent {
		documentKey?: string;
		requestId: string;
		threadId: string;
		state: ReaderAskState;
		detail?: string;
	}
	/**
	 * The outcome of one submit call. Only "attempted" reached native; the others name why the
	 * message stayed in the page.
	 */
	type ReaderAskSubmission = "attempted" | "unregistered" | "stale" | "inFlight" | "settled";
	interface ReaderCoreAPI {
		createAskDelivery(
			sessions: ReaderAskSessions,
			version: () => ReaderPromptVersion | undefined,
			request: (packet: Record<string, unknown>) => Promise<ReaderPromptReceipt>,
		): {
			submit(owner: ReaderAskDocument, thread: ReaderThread, message: ReaderAskMessage): Promise<ReaderAskSubmission>;
			update(event: ReaderPromptEvent): ReaderAskDelivery | undefined;
		};
	}
}
