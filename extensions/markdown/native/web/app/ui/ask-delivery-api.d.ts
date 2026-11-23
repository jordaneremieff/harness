export {};

declare global {
	interface ReaderPromptReceipt {
		accepted: boolean;
		uncertain?: true;
		retryable?: boolean;
		fresh?: true;
		detail?: string;
	}
	interface ReaderPromptEvent {
		documentKey?: string;
		requestId: string;
		threadId: string;
		state: ReaderAskState;
		detail?: string;
	}
	interface ReaderCoreAPI {
		createAskDelivery(
			sessions: ReaderAskSessions,
			version: () => ReaderPromptVersion | undefined,
			request: (packet: Record<string, unknown>) => Promise<ReaderPromptReceipt>,
		): {
			submit(owner: ReaderAskDocument, thread: ReaderThread, message: ReaderAskMessage): Promise<void>;
			update(event: ReaderPromptEvent): ReaderAskDelivery | undefined;
		};
	}
}
