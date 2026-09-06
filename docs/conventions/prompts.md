# Prompt ownership

Prompt templates are operator-invoked shortcuts. They expand text in the current
session; they do not grant tools, change a model, or create a worker profile.
The package exposes shared templates through `pi.prompts` in `package.json`.

## Shared and local content

Keep a template in this repository when its job remains useful across machines
and its instructions work without private paths, private context, a fixed model
roster, or an operator's local installation. Personal authorship alone does not
make a portable prompt machine-local.

Keep machine-specific shortcuts and resource routing in the operator's Pi
configuration. Pi discovers global templates in its agent directory's
`prompts/`, trusted project templates in `.pi/prompts/`, and explicit paths from
settings or `--prompt-template`. A local template is not automatically a shared
candidate. Remove private assumptions and establish a reusable job before
proposing one for the package.

Use these ownership boundaries:

| Content | Owner |
| --- | --- |
| Portable, explicitly invoked text transformation | Shared prompt template |
| Machine paths, local destinations, resource selection, model selection | Local Pi configuration or local shortcut |
| Behavior required before every task | The applicable instruction file |
| Reusable procedure selected by task | An Agent Skill and its references |
| Tool parameters, resource inheritance, lifecycle and delivery semantics | The current tool contract and owning implementation |
| Task history, transcripts, provisional results | Session context or private working material |

A prompt must not duplicate a tool schema, freeze a provider roster, simulate
credentials or expertise, or infer permissions from a named destination. Refer
to the current capability rather than maintaining a second contract in prose.
Doctrine stays in the Pillars corpus; a template encodes its own job, not a copy
of the corpus.

## Maintained commands

- `/drift` reconstructs the opening intent in exactly two sentences without
  advancing the task. Operator clarification informs that reconstruction;
  a later goal change does not replace the opening intent. Missing opening
  context produces an explicit evidence boundary, not an invented intent.
- `/wtf [account]` replaces a hard-to-use assistant reply without continuing
  its task. The optional account identifies the fault or target and supplies
  corrections. Without an explicit target, a mere administrative notice points
  back to the nearest visible answer for the same task. Short genuine answers
  remain targets. The replacement preserves meaning, later same-task limits,
  permissions, exact copy spans, and successful earlier repairs. Missing target text produces an
  explicit boundary, not a rewrite of the command or a tool result.

These jobs remain separate: `/drift` restores intent; `/wtf` repairs a reply.
Neither executes the underlying work or changes persistent configuration.

## Discovery and changes

Keep documentation outside `prompts/`. Pi discovers every immediate `.md` file
there as a template, including a file named `README.md`. Tests and evaluations
use their existing non-Markdown suffixes.

Keep each command name unique across loaded resources. Pi reports prompt-name
collisions and retains the first loaded match; a duplicate local file is not a
reliable override contract. Select the intended resource explicitly rather
than depending on load order.

Edit shared templates in the persistent prompts worktree. In the managed
worktree layout, the configured package continues to load the main checkout
until promotion. Other installations load their configured package source.
A direct worktree load verifies a candidate, not activation. See [worktrees.md](worktrees.md) for the
promotion and routing contract.

Before a template change:

1. Establish its job from operator intent and current source. Configuration
   proves availability, not invocation frequency or utility.
2. Repair the existing template when it owns the job. A new template needs the
   [Harness skill's surface approval](../../skills/harness/SKILL.md#new-surfaces-require-approval).
3. Check discovery and argument expansion with Pi. Exercise the changed behavior
   with visible-context cases, including missing evidence and task boundaries.
4. Keep behavioral evidence separate from discovery results. Lexical checks do
   not establish meaning preservation or usefulness. Maintained model evaluations
   use the [evaluation application](../../evals/README.md) and its approval gate.
5. Run the repository gates and review portability before promotion. Keep
   evaluation outputs and local configuration outside the package.
