import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { Catalog } from "./catalog.ts";

const actions = [
	{ value: "check", label: "check [hint]", description: "Ask the agent to check Pillars alignment" },
	{ value: "derive", label: "derive [hint]", description: "Ask the agent to identify a Pillar candidate" },
	{ value: "review", label: "review [hint]", description: "Review existing guidance and its use" },
	{ value: "help", label: "help", description: "Show command help and examples" },
	{ value: "browse", label: "browse", description: "Show the live corpus inventory" },
	{ value: "read", label: "read <resource>", description: "Read a corpus entry or governance" },
	{ value: "usage", label: "usage [--days N]", description: "Show retained access counts, not alignment" },
	{ value: "revisions", label: "revisions [--days N]", description: "Show access counts by source revision" },
	{ value: "next", label: "next <cursor>", description: "Continue an access-evidence page" },
	{
		value: "export",
		label: 'export "/absolute/file.json" [--days N]',
		description: "Export access evidence to a new local file",
	},
];

export const COMMAND_HELP = `# Pillars commands

- \`/pillars check [hint]\`: Ask the agent to check a decision, artifact, or approach for Pillars alignment.
- \`/pillars derive [hint]\`: Ask the agent to identify a useful Pillar candidate or an adjustment to an existing entry.
- \`/pillars review [hint]\`: Ask the agent to review existing guidance or investigate unexpected agent behavior.

The hint is one optional free-text message. Quotes and flags are not required.
Without a hint, the agent infers the subject from this conversation.
These actions start an agent turn, or steer the active turn. Proposals stay in chat; these actions do not approve corpus changes.
Review supports maintenance without an incident. It recommends changes only when the evidence warrants them; no change is a valid result.

Examples:

\`/pillars check the proposed error handling\`
\`/pillars derive what we learned from this design change\`
\`/pillars review agents keep asking permission despite Committed Contribution\`

## Browse and inspect

- \`/pillars\`: Show this guide and the live inventory.
- \`/pillars help\`: Show this guide.
- \`/pillars browse\`: Show the live inventory.
- \`/pillars read <resource>\`: Read an entry; use \`governance\` for the corpus rules.
- \`/pillars read <resource> <nextOffset> <referenceBodyDigest>\`: Continue a long source body with its returned values.
- \`/pillars usage [--days N]\`: Show retained access counts.
- \`/pillars revisions [--days N]\`: Show access counts by source revision.
- \`/pillars next <cursor>\`: Continue with the returned cursor.
- \`/pillars export "/absolute/file.json" [--days N]\`: Export access evidence to a new local file.

The day window is 1–30; the default is 30. Access counts do not measure alignment or effectiveness.
Browse, help, read, and access-evidence output stay outside model context.
Autocomplete offers actions and read resource identifiers; it leaves hints as free text.`;

export function commandCompletions(prefix: string, catalog?: Catalog): AutocompleteItem[] | null {
	const read = /^read\s+([^\s]*)$/.exec(prefix);
	const items = read
		? (catalog?.resources ?? [])
				.map((resource) => ({
					value: `read ${resource.resourceId}`,
					label: resource.resourceId,
					description: resource.resourceClass === "entry" ? "Read this Pillar" : `Read the ${resource.resourceId}`,
				}))
				.filter((item) => item.label.startsWith(read[1]))
		: /\s/.test(prefix)
			? []
			: actions.filter((item) => item.value.startsWith(prefix));
	return items.length ? items.map((item) => ({ ...item })) : null;
}

export type JudgmentRequest = { action: "check" | "derive" | "review"; hint: string };

export function parseJudgmentRequest(args: string): JudgmentRequest | undefined {
	const match = /^\s*(check|derive|review)(?:\s+([\s\S]*))?$/.exec(args);
	if (!match) return undefined;
	return { action: match[1] as JudgmentRequest["action"], hint: match[2]?.trim() ?? "" };
}

export function judgmentPrompt({ action, hint }: JudgmentRequest): string {
	return [
		`The operator invoked /pillars ${action}. This message contains extension-provided task scaffolding, not new doctrine.`,
		hint
			? "Use the operator hint below to focus the task within the conversation."
			: "Infer the subject from the current conversation and state it briefly. Ask only if the context does not identify a useful subject.",
		'Use the pillars tool to read the live inventory and resource:"governance", then consult the relevant entries under that governance. If source access is unavailable, state the gap rather than invent doctrine.',
		action === "check"
			? "Check the subject for Pillars alignment. Explain the consequential matches or tensions with evidence and recommend any needed change. Use judgment about depth and form; do not turn this into a recital or scorecard. This request asks for an assessment, not automatic edits."
			: action === "review"
				? 'Review whether the existing Pillars guidance expresses the intended behavior and supports its use. For an observed-behavior concern, compare expected and observed behavior with the actual source and delivery evidence; test applicability, valid exceptions, and competing constraints. Consider delivery, recognition, interpretation, application, and the doctrine itself as possible causes for that concern, not a mandatory checklist. Do not infer recurrence or a cause beyond the available examples. Repeated misses do not by themselves justify stronger wording or a corpus rewrite. Missing examples limit causal claims, not all source review. For maintenance, examine useful dimensions such as clarity, scope, overlap, and consistency without inventing failures or imposing a fixed checklist. Distinguish established findings from hypotheses and name the evidence needed for unresolved conclusions. Recommend the correction at the layer that owns the problem, or explain why no change is warranted. Follow governance for evidence attribution and corpus proposals, including its "Mutation Rules". Use "Contradiction Handling" when the concern is an apparent violation or falsifying application. Keep proposals in chat; this invocation does not authorize edits or corpus changes.'
				: 'Explore whether the subject contains a transferable candidate for the corpus. Use governance\'s "Document Types" and "Mutation Rules" to choose its type and treatment. Let the evidence guide the reasoning; no fixed derivation procedure or quota is required. Offer useful candidate wording, why it matters, where it applies or does not, and its relationship to the nearest existing entries. An adjustment to an existing entry or no candidate is a valid result. Keep the proposal provisional in chat; this invocation does not authorize corpus changes.',
		...(hint ? ["Operator hint (free text):", hint] : []),
	].join("\n\n");
}
