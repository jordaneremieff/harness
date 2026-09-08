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
the operator browses with `/pillars`, checks alignment with `/pillars check`,
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
  repository conventions.
- [Worktrees](docs/conventions/worktrees.md) defines the development and
  publication workflow.

The harness follows Pi's own capabilities rather than maintaining a parallel
agent core. The [durable-harness track](docs/pi-durable-harness.md) records the
upstream contracts and the conditions for adopting them here.

Released under the [MIT license](LICENSE). Feel free to copy anything useful or
fork it for your own setup. I do not provide support or accept unsolicited
contributions.
