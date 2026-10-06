# harness

My personal [Pi](https://github.com/earendil-works/pi) harness: a Pi package of
extensions, skills, prompt templates, design doctrine, and shared configuration.
I use it to shape how the agent works across projects and machines. It builds on
Pi's own capabilities instead of maintaining a parallel agent core; the
[durable-harness track](docs/pi-durable-harness.md) records the upstream
contracts and when this repository adopts them.

Start with [Architecture](docs/architecture.md) for installation, how Pi loads
the package, and machine configuration.

## Contents

- [Extensions](extensions/): executable tools, commands, and interface changes.
  Each extension directory has its own README.
- [Skills](skills/): task procedures, each defined in a `SKILL.md` file.
- [Prompt templates](prompts/): operator-invoked shortcuts, including
  [`/tldr [hint]`](prompts/tldr.md) for a short, plain-language summary.
  See the [prompt convention](docs/conventions/prompts.md) for use and ownership.
- [Pillars](pillars/README.md): principles, patterns, and heuristics that guide
  agent judgment.
- [Documentation](docs/): [architecture](docs/architecture.md) and [repository conventions](docs/conventions/).
- [Configuration](config/): shared application configuration, with setup in
  [Architecture](docs/architecture.md).
- [Evaluations](evals/README.md): maintained evaluations and their execution
  requirements.
- [Scripts](scripts/): repository checks and development automation.

## Development

Follow the [worktree convention](docs/conventions/worktrees.md) and the
[repository instructions](AGENTS.md) before changing the harness.

Released under the [MIT license](LICENSE). Feel free to copy anything useful or
fork it for your own setup. I do not provide support or accept unsolicited
contributions.
