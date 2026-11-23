export const checkUsage = "Use /slop check [hint].";

export function parseCheckHint(args: string): string | undefined {
	const match = /^check(?:\s([\s\S]*))?$/.exec(args.trimStart());
	if (match) return match[1]?.trim() ? match[1] : "";
}

export function checkPrompt(hint: string): string {
	return `The operator invoked /slop check. This message is task scaffolding from the slop extension.

Check the work of this conversation for slop: your recent replies, the documents and messages you wrote, and the code and commits you changed. If the operator's hint names a passage, a habit or a piece of work, start there.

Read the matching catalog entries with the slop tool. Run slop_check on documents, files, diffs and commit messages. Judge replies by reading them, because detectors find only fixed forms, and judge at density: one familiar word is rarely the failure.

Repair what you find in the work itself. If you repair a reply, give the corrected text once, in full. Then continue any task that was in progress.

Record each habit that the hint names with slop_record: update the entry that covers it, or save a new one.

Say in a few plain sentences what you found and changed.

Operator hint:
${hint || "(none)"}`;
}
