/** Model-facing stash guidance shared by the ordinary and Durable entrypoints. */

export const STASH_WRITE_DESCRIPTION =
	"Distill the current effort into a durable handover artifact (markdown) stored on disk outside the session. Use when handing work to a future session, before major context loss, or when the operator asks to stash. Set checkpoint: true for a working synthesis instead of a discoverable handover.";

export const STASH_LIST_DESCRIPTION =
	"List recent handovers or find remembered content with query across metadata and full supported-size bodies. Optional tag/state filters. Query pages bound directory visits, files, bytes, and output; repeat query/filters with nextCursor even after empty pages. Search reports skips and per-read consistency. Without query, recent-list behavior remains unchanged (50 KiB/2000 lines). Query returns at most 10 matches and 16 KiB of JSON; offsets use UTF-16 in redacted, terminal-escaped fields.";

export const STASH_READ_DESCRIPTION =
	"Read one stashed handover artifact by id or unique id prefix without changing its lifecycle state. Returns the complete artifact's SHA-256 digest for stash_edit. Output is capped at 50 KiB or 2000 lines; a truncated result includes the artifact path for continued reading.";

export const STASH_EDIT_DESCRIPTION =
	"Edit a saved handover's body with exact nonoverlapping replacements against the original, not incrementally. Requires the latest stash_read digest. Preserves the title heading, frontmatter, and lifecycle. Active stashes require allowActive:true; closed stashes require deliberate /stash reopen and another read. A stale digest or ambiguous match refuses every edit.";

export const STASH_COMPLETE_DESCRIPTION =
	"Close an open or active stashed effort with a concrete terminal outcome, including work resumed through stash_read without pickup. Use its id or unique prefix. The artifact is retained; an existing closed outcome is never overwritten. Deliberate reopening uses /stash reopen <id>.";

export const STASH_ROTATE_DESCRIPTION =
	"Archive a stale stashed effort (open or closed) so it no longer appears in listings or pickup. The artifact moves to the stash store's dot-hidden .trash directory and remains recoverable; active stashes cannot be rotated. Use when a handover is superseded or no longer needed.";

export const STASH_WRITE_GUIDANCE =
	"Use stash_write when the operator asks to stash, when an effort reaches a resumable state, or before a session ends with open loops. Make the summary self-contained for a fresh session.";

export const STASH_LIST_GUIDANCE =
	"Use stash_list when the operator references earlier or stashed work. For remembered content, supply query and follow nextCursor with the same query and filters, including after empty pages. Read the selected id with stash_read before resuming; search results are evidence, not fresh authority.";

export const STASH_READ_GUIDANCE =
	"Use stash_read with the selected id to read one handover without changing its lifecycle state before resuming its work.";

export const STASH_EDIT_GUIDANCE =
	"Use stash_edit to correct or amend an existing handover with new information. Read the complete artifact first; continue truncated or control-escaped content through its file path. Use its latest digest and exact original-body anchors. Include an anchor plus new text to append an amendment. Set allowActive only when the requested edit covers that active effort; it acknowledges intent, not exclusive ownership or new permission. Do not reopen a closed effort without operator authority. On a conflict, read again and reassess rather than merely replace the digest.";

export const STASH_COMPLETE_GUIDANCE =
	"Use stash_complete with the stash id when its effort reaches a terminal outcome, whether loaded through stash_read or pickup; state what completed, failed, or was deliberately abandoned.";

export const STASH_ROTATE_GUIDANCE =
	"Use stash_rotate for superseded or obsolete handovers. Rotation is operator-initiated and recoverable (the file moves to .trash); do not rotate without an explicit reason.";

/** The `stash` prompt section shown to Durable agents. */
export const STASH_SECTION_TEXT = [
	"Stash handovers persist work across sessions as durable Markdown artifacts outside the conversation.",
	`stash_write: ${STASH_WRITE_GUIDANCE}`,
	`stash_list: ${STASH_LIST_GUIDANCE}`,
	`stash_read: ${STASH_READ_GUIDANCE}`,
	`stash_edit: ${STASH_EDIT_GUIDANCE}`,
	`stash_complete: ${STASH_COMPLETE_GUIDANCE}`,
	`stash_rotate: ${STASH_ROTATE_GUIDANCE}`,
].join("\n");
