# harness

My personal [Pi](https://github.com/earendil-works/pi) harness and surrounding
tool configuration. I use it to shape how the agent works across projects and
machines, with shared instructions, reusable procedures, and extensions where
code is needed.

## Pillars

The [Pillars](pillars/README.md) are the design doctrine behind this harness:
principles, patterns, and heuristics for agent judgment. They guide decisions
about evidence, structure, and communication. The [Pillars access
extension](extensions/pillars/README.md) provides the consultation tool and
operator commands; its README owns their use and boundaries.

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
- [Audit](skills/audit/SKILL.md) audits local Pi session and harness activity
  from ordinary intent or `/skill:audit`. It is read-only by default, chooses a
  bounded scope, separates evidence units, reconciles load-bearing figures, and
  reports unknowns without inferring repairs or publication.
- [Harness](skills/harness/SKILL.md) guides harness changes. Its causal
  extension audit reference supports the Audit skill when an extension scope
  needs disposition analysis; the Audit skill owns extension telemetry
  collection.
- [Prime](skills/prime/SKILL.md) prepares for a later task. Ask "Get up to speed
  on this topic, then wait", or use `/skill:prime <topic>`. It instructs the
  agent to return a short cited summary with source coverage and then wait;
  these are instructions, not guaranteed enforcement.
- [Agent](extensions/agent/README.md) owns Durable agent controls, the `/agent`
  dashboard, session-scoped footer figures, and sampled fleet model evidence.
- [Registry](extensions/registry/README.md) exposes session resources and the
  chat model catalog. Its README distinguishes model selection facts from
  non-chat discovery and remote health.
- [Memory](extensions/memory/README.md) owns retrieval and maintenance of prior
  operator knowledge, including its source and lifecycle boundaries.

`npm test` includes a serialized tool-schema check in
[scripts/extension-load-check.test.mts](scripts/extension-load-check.test.mts).
It loads every extension selected by the package manifest in an isolated Pi
resource loader and checks its factory-registered tools and Pi's built-in tools.
Registration runs in a bounded child
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
