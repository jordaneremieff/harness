export {};

declare global {
	interface ReaderReviewDraft {
		comments: ReaderComment[];
		overall: string;
		overallRevision?: number;
		parked?: { comment?: ReaderComment; text: string; index: number; authoredRevision?: number }[];
	}
	interface ReaderAskRecovery<O> {
		/** Wait for all page-side draft operations; false leaves unsaved material to resolve before closing. Never retries. */
		flush(): Promise<boolean>;
		/** Call on every show, with the same owner for the same logical document. */
		open(owner: O): Promise<void>;
		/** Signal each mutation of active or parked batch material, including definitive refusal. */
		changed(owner: O): void;
		/** Upon confirmed consumption, synchronously remove local members and initiate the requested operation in commit. */
		prepare(
			owner: O,
			remaining: ReaderReviewDraft | undefined,
			current: () => boolean,
			commit: () => void,
		): Promise<boolean>;
	}
	interface ReaderAskRecoveryCallbacks<O> {
		/** Return a detached packet, or undefined for an empty batch. Never include unsubmitted single questions. */
		snapshot(owner: O): ReaderReviewDraft | undefined;
		/** Replace only pending material. Do not signal changed from this callback. */
		apply(owner: O, draft: ReaderReviewDraft | undefined): void;
		warn(owner: O, text: string, action: { label: string; run(): void }): void;
		/** Clear any recovery warning for this owner. */
		clear?(owner: O): void;
	}
	interface ReaderCoreAPI {
		createAskRecovery<O extends { documentKey: string }>(
			host: Pick<ReaderCoreHost, "request">,
			callbacks: ReaderAskRecoveryCallbacks<O>,
		): ReaderAskRecovery<O>;
	}
}
