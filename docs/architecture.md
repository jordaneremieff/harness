# Architecture

This document owns package setup, the load model, resource anatomy, and routes
to repository conventions. Start with [Setup](#setup) to install the package.
The [repository instructions](../AGENTS.md) govern changes.

## Setup

Review the source before installation: Pi packages execute code and supply
instructions with access to the local system.

### Development checkout

Register the working clone as a local Pi package:

```bash
pi install /absolute/path/to/harness
```

Pi uses the local path directly, without copying it. Update that checkout
through Git. Install the lockfile's development dependencies with `npm ci` in
the checkout.

For extension development, disable the package's extension resources in
`pi config` and use the persistent worktree entrypoints. Follow the
[worktree convention](conventions/worktrees.md) for synchronization,
activation, checks, and publication.

### Other machines

Install the Git repository through SSH without a ref. Repository access is
required; replace `OWNER` with the repository owner:

```bash
pi install git:git@github.com:OWNER/harness
```

The default branch is the release channel. Run `pi update --extensions` to
update packages.
When the target commit changes, Pi resets and cleans the installed clone and
reinstalls its dependencies. Keep edits in the development checkout, not the
installed clone.

### Machine configuration

The Pi package manifest does not activate application configuration. Use the
working clone on a development machine. A global Git install places the clone
under `~/.pi/agent/git/github.com/OWNER/harness`.

To load the shared global Pi rules, point `~/.pi/agent/AGENTS.md` at
[`config/pi/agent/AGENTS.md`](../config/pi/agent/AGENTS.md). Check any existing
file before replacing it. Create a symbolic link only after the operator
explicitly approves that link. For an approved link with no existing destination:

```bash
ln -s /absolute/path/to/harness/config/pi/agent/AGENTS.md ~/.pi/agent/AGENTS.md
```

Keep machine-local rules outside the repository, in `~/AGENTS.md` or workspace
and project `AGENTS.md` files. Pi loads the global rules and the ancestor
context files for the session directory.

Point Herdr at the shared configuration through the shell environment:

```bash
export HERDR_CONFIG_PATH=/absolute/path/to/harness/config/herdr/config.toml
```

The [Herdr configuration reference](https://herdr.dev/docs/configuration/)
documents this path override and the available settings. Configuration edits
in a development checkout appear as Git diffs. Edits in a Pi-installed clone
are not durable across package updates; make baseline edits in the development
checkout.

## Load model

The harness is a Pi package. `package.json` declares the resources under the
`pi` key, matching the documented package format:

```json
{
  "pi": {
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "extensions": ["./extensions"]
  }
}
```

- `npm run warmup:jiti` loads the extension entrypoints named in the manifest's
  script through `pi --help --offline` to warm jiti's transpilation cache. It is
  an optional operator step, not a build or successful-load check. Use the
  [worktree entrypoint check](conventions/worktrees.md#entrypoint-load-checks)
  to detect extension load errors.
- Extensions are TypeScript sources that Pi loads through jiti. There is no
  build step. Pi requires Node 22.19 or newer; Node runs the direct TypeScript
  tests through `node --test` over the glob in the `test` script.
- [The manifest](../package.json) owns the dependency declarations. Its Pi
  peer ranges are wildcards; the lockfile records the versions used for
  repository checks.
- Pi's extension loader binds the core AI, agent, coding-agent, TUI,
  and TypeBox imports to its running installation. It does not bind Chord,
  Pi Client, Pi Server, Pi Durable, Codemode, or MCP. A peer declaration alone
  does not establish loader binding. The [session host roles](conventions/session-host-roles.md)
  distinguish the ordinary primary from independent Durable storage hosts;
  the [contribution convention](conventions/durable-contributions.md) defines
  native capabilities. See [the durable-harness track](pi-durable-harness.md)
  before selecting a runtime or remote integration surface.
- `package-lock.json` pins the development dependency snapshot for reproducible
  standalone checks. Refresh it with the Pi release used to validate the harness.
  Run `npm ci` in each affected checkout after a lockfile update. Worktree source
  synchronization does not install dependencies.
- Validate changes against the installed Pi declarations, not only the tests.

The manifest activates extensions, skills, and the prompt templates in
`prompts/`. Other tracked package content has explicit consumers:

- `pillars/` is the doctrine corpus served by the
  [Pillars extension](../extensions/pillars/README.md) and read by package-relative
  path through the [Troll skill's armory](../skills/troll/references/pillar-armory.md).
- `config/` mirrors application-owned config paths. Machines point Pi and Herdr
  at the files under their application directories; no package manifest entry
  activates them.
- `docs/` explains this repository and owns repository conventions.
- `scripts/` contains repository automation.

The [prompt ownership convention](conventions/prompts.md) documents the shared
prompt commands and their use. Maintained evaluations use the explicit,
approval-gated [evaluation application](../evals/README.md). Evaluation evidence
stays ignored under `.evals/`; no evaluation runs automatically in CI or normal
tests.

The root `AGENTS.md` governs work on this repository. The separate
`config/pi/agent/AGENTS.md` file is the machine-independent source for global
Pi rules. Its repository location does not establish how a particular machine
deploys or loads it.

## Repository verification

Repository checks include the [extension registration and tool-schema
check](../scripts/extension-load-check.test.mts). It loads the package with Pi's
resource loader and checks registered and built-in tool schemas for tuple
notation. It does not establish acceptance by a live provider or cover tools
registered later at runtime. Follow the [worktree convention](conventions/worktrees.md)
and repository instructions for completion checks.

## Native Pi controls

Use the installed Pi documentation for exact settings and API contracts. Keep
machine choices in Pi's own configuration rather than introducing harness
extensions that duplicate these controls:

- **Compaction:** `compaction.modelOverrides` sets `reserveTokens` and
  `keepRecentTokens` by exact, case-sensitive `provider/modelId`. Pi merges
  global and project settings before model lookup. A global model-specific
  value therefore wins over a project-wide fallback. `compaction.enabled`
  controls automatic compaction; manual `/compact` remains available when it
  is false. Preserve the operator's current toggle and token budgets unless
  a change is requested. See Pi's `docs/settings.md` and `docs/compaction.md`.
- **Prompt cache warming:** global `cacheWarming` selects `off`, `streaming`,
  or `idle`. Pi owns the refresh schedule and cost decision. Refresh requests
  incur provider usage; a model needs a known cache lifetime for its selected
  retention tier. `/session` exposes the decision and estimated cost. Do not
  add a second refresh timer or infer that an absent refresh is a fault.
  See Pi's `docs/settings.md` and `docs/models.md`.
- **Bug reports:** `/bug` offers upload or local zip export. Both include
  configuration and error diagnostics even without the optional transcript.
  The summary option sends transcript content to the current provider.
  Review the selected evidence and obtain the required disclosure authority;
  credential redaction is not proof that arbitrary diagnostic text is safe.
  See Pi's `docs/sessions.md`.

These controls are host capabilities, not package defaults. Installing this
harness does not select their values or authorize an evidence upload.

## Extension anatomy

Each extension is an independent slice under `extensions/<name>/`. A slice is
an independently developed repository area with its own behavior, state, and
presentation. The [repository instructions](../AGENTS.md) define slice isolation;
shared contracts live in the [conventions registry](#conventions-registry).

An extension contains:

- `index.ts` — the registration surface: a default-export factory receiving
  the Pi `ExtensionAPI`; it registers tools, commands, and event handlers and
  owns cleanup on `session_shutdown`.
- Colocated `*.test.mts` files — the focused tests run by the `test` glob.
- A `README.md` — the surface, configuration, boundaries, and verification
  for the slice.
- Its own state on disk under the Pi agent directory, with an environment
  variable override where a store location is configurable. Stateless
  extensions and slices whose lifecycle state lives in an external
  integration own no disk store here.
- Its own configuration: environment variables named `PI_*`, documented in
  the README (see `docs/conventions/extension-config.md`).
- Optional footer status keys through `ctx.ui.setStatus` (see
  `docs/conventions/status-keys.md`).

## Skill anatomy

Each skill lives under `skills/<name>/`:

- `SKILL.md` — the operating procedure, with YAML frontmatter. Pi includes
  available skill names and descriptions in its startup context; the agent
  reads the full procedure on demand. Activation knowledge belongs in the
  `description`, not in the body.
- One-level `references/` — conditional detail loaded on demand.
- `scripts/` — type-checked Node (`.mts`) automation when repeated work
  justifies it; scripts are non-interactive, documented with `--help`, safe
  by default, bounded in output, and directly tested with colocated test
  files.

The portable shape is checked mechanically by
`skills/harness/scripts/validate-skill.mts`, the same gate the `harness` skill
applies in its Agent Skill lane.

## Conventions registry

`docs/conventions/` owns repository-level cross-extension contracts. A
contract names its producer and its current consumers and lives outside
either extension, so no extension parses a sibling's format without a
documented surface:

- [Extension configuration](conventions/extension-config.md): configuration
  ownership and the environment-variable namespace.
- [Status keys](conventions/status-keys.md): footer publishers and consumers.
- [Durable contributions](conventions/durable-contributions.md): native
  capability bundles supplied by extension factories to agent hosts.
- [Session host roles](conventions/session-host-roles.md): ordinary primary
  and Durable execution responsibilities.
- [Policy recovery](conventions/policy-recovery.md): public tool evidence used
  by cross-extension recovery seeds.
- [Evaluation suites](conventions/evaluation-suites.md): package interfaces
  available to colocated suites and deterministic tests.
- [Prompts](conventions/prompts.md): shared template ownership and commands.
- [Worktrees](conventions/worktrees.md): development, routing, and promotion.

New cross-extension behavior belongs here before it ships: write the
contract, name the producer and consumers, and keep it stable.

## Adding an extension

Use the [Harness skill](../skills/harness/SKILL.md) for surface selection,
approval, implementation, and verification. The [worktree convention](conventions/worktrees.md)
owns the development and publication workflow. Implementation does not activate
an extension.

## Adding a skill

Use the [Harness skill](../skills/harness/SKILL.md) and its Agent Skill lane.
The skill validator checks structure; it does not prove useful behavior or
selective activation.
