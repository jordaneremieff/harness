/**
 * Stored-commit observation for wakeups and storage mirrors.
 *
 * `observeCommits()` publishes a commit once Storage stored it. Deferred progress
 * (streamed partials, running tool output) reaches it only with a later store, so
 * live progress belongs to conversation and document watches, not to this
 * listener. The observer ends at Session close or failure; callers that need the
 * reason read `Session.closed`.
 */
import type { CommitPublication, Session } from "@earendil-works/pi-durable";

/** Attach `listener` to stored commits; the returned function detaches it and is idempotent. */
export function onStoredCommit(session: Pick<Session, "observeCommits">, listener: (publication: CommitPublication) => void): () => void {
	const observation = session.observeCommits({ advance: (publication) => listener(publication), end: () => {} });
	return () => observation.detach();
}
