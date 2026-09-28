# harness

My personal [Pi](https://github.com/earendil-works/pi) harness and surrounding
tool configuration. I use it to shape how the agent works across projects and
machines, with shared instructions, reusable procedures, and extensions where
code is needed.

## Pillars

The [Pillars](pillars/README.md) are the design doctrine behind this harness:
principles, patterns, and heuristics for agent judgment. They guide decisions
about evidence, structure, and communication. The [Pillars access
extension](extensions/pillars/README.md) is the single consultation surface:
its `pillars` tool carries the judgment-moment triggers and reads the corpus;
the operator browses with `/pillars`, checks alignment and resumes the corrected
work with `/pillars check`,
explores candidates with `/pillars derive`, and reviews existing guidance with
`/pillars review`. The judgment actions accept an optional free-text hint and
otherwise use conversation context.

## Structure and use

Pi loads the resources declared in [package.json](package.json). Instructions
and skills guide the agent; extensions supply executable behavior. Application
configuration has separate setup. Each resource owns its detailed usage and
boundaries, rather than a central feature catalog.

- [Setup and load model](docs/architecture.md#setup) covers installation,
  updates, and machine configuration.
- [Architecture](docs/architecture.md) explains the resource boundaries and
  repository conventions. [Native Pi controls](docs/architecture.md#native-pi-controls)
  covers model-specific compaction, cache warming, and bug-report privacy without
  adding parallel harness mechanisms.
- [Prompt templates](docs/conventions/prompts.md) supply the operator's `/`
  commands, including `/seed [hint]`, which puts a quick brief for another session
  on the clipboard labeled `seed: <topic>`; its chat confirmation follows
  the clipboard tool's actual outcome, including the history archive result.
  `/recap` explains selected work and practical consequences in chat. A comparison
  such as `/recap export work since the last recap` separates material changes
  from corrections to earlier reports and keeps relevant unchanged constraints
  visible. It states missing evidence, preserves release limits, and does not
  continue the work.
- [Worktrees](docs/conventions/worktrees.md) defines the development and
  publication workflow.
- [Memory](skills/memory/SKILL.md) retrieves prior operator knowledge before
  dependent choices. Its read-only script derives a compact cue index from
  `PI_MEMORY_DIR` and reads selected notes in bounded pages; curation stays
  with the skill, without a separate stored index.

`npm test` includes a serialized tool-schema check in
[scripts/extension-load-check.test.mts](scripts/extension-load-check.test.mts).
It loads every extension selected by the package manifest in an isolated Pi
resource loader and checks its factory-registered tools, Pi's built-in tools,
and the subagent's worker-only result tool. Registration runs in a bounded child
with separate coverage output because jiti and native imports share source URLs
but have different line maps. The schema assertions run in the normal test suite.
The check rejects array-valued `items`, `additionalItems`, and `prefixItems` in
schema positions, including local definitions, without treating annotation data
or property names as schema keywords. It does not fetch external references,
discover arbitrary future runtime registrations, validate the complete OpenAPI dialect, or
establish acceptance by a live provider. No runtime sanitizer changes schemas.

The harness follows Pi's own capabilities rather than maintaining a parallel
agent core. The [durable-harness track](docs/pi-durable-harness.md) records the
upstream contracts and the conditions for adopting them here. The lockfile records
the dependency versions used for repository checks; the Pi peer ranges remain
wildcards. Run `npm ci` in each affected checkout after a lockfile update.
Worktree source synchronization does not install dependencies.

Released under the [MIT license](LICENSE). Feel free to copy anything useful or
fork it for your own setup. I do not provide support or accept unsolicited
contributions.
