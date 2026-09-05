# Architecture

Repo-level index for the harness: the load model, what an extension must
contain, what a skill must contain, and where cross-extension contracts live.
Detailed rules live in `AGENTS.md`; this document is the entry point.

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

- Install the package with `pi install /absolute/path/to/harness`; a
  standalone development checkout runs `npm install` and `npm test`.
- `npm run warmup:jiti` loads the extension entrypoints named in the manifest's
  script through `pi --help --offline` to warm jiti's transpilation cache. It is
  an optional operator step, not a build or successful-load check. Use the
  [worktree entrypoint check](conventions/worktrees.md#entrypoint-load-checks)
  to detect extension load errors.
- Extensions are TypeScript sources that Pi loads through jiti. There is no
  build step. Pi requires Node 22.19 or newer; Node runs the direct TypeScript
  tests through `node --test` over the glob in the `test` script.
- `package.json` declares wildcard peers for `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`, and
  `@earendil-works/pi-server`. It declares no direct dependencies.
- Pi 0.85.1's extension loader binds the core AI, agent, coding-agent, TUI,
  and typebox imports to its running installation. `pi-server` is not in that
  bound set. The manifest still declares it as a peer, but the subagent slice
  imports neither `pi-server` nor `pi-protocol` and exposes no worker socket.
  A peer declaration alone does not establish a runtime dependency or loader
  binding. See [the durable-harness track](pi-durable-harness.md) before
  selecting a remote integration surface.
- `package-lock.json` pins the development dependency snapshot for reproducible
  standalone checks. Refresh it with the Pi release used to validate the harness.
- Every change is validated against the installed Pi declarations, not only
  against the tests.

The manifest activates extensions, skills, and the prompt templates in
`prompts/`. Other tracked package content has explicit consumers:

- `pillars/` is the doctrine corpus that skills read by package-relative path.
- `config/` mirrors application-owned config paths. Machines point Pi and Herdr
  at the files under their application directories; no package manifest entry
  activates them.
- `docs/` explains this repository and owns repository conventions.
- `scripts/` contains repository automation.

The root `AGENTS.md` governs work on this repository. The separate
`config/pi/agent/AGENTS.md` file is the machine-independent source for global
Pi rules. Its repository location does not establish how a particular machine
deploys or loads it.

## Extension anatomy

Each extension is an independent vertical slice under `extensions/<name>/`.
A slice owns its structure, semantics, state, and presentation, and must not
import a sibling, parse sibling-formatted output, reproduce sibling-owned
types or lifecycle states, or establish an undocumented sibling protocol
(`AGENTS.md`). Cross-extension behavior uses public Pi surfaces or an
explicit repository-level contract (see the conventions registry below).

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
  the README (see `docs/conventions/extension-config.md`). Host-injected
  discovery variables form the documented exemption.
- Optional footer status keys through `ctx.ui.setStatus` (see
  `docs/conventions/status-keys.md`).

A new extension must not reuse an earlier harness generation's source,
comments, tests, names, or identifiers (`AGENTS.md`).

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

- `extension-config.md` — environment-variable configuration convention for
  all extensions.
- `status-keys.md` — the footer status-key registry (publisher, meaning,
  consumers).

New cross-extension behavior belongs here before it ships: write the
contract, name the producer and consumers, and keep it stable.

## Adding an extension

1. Load `skills/harness/SKILL.md`, classify the capability, and obtain the
   required approval for a new extension surface before any write.
2. Use the slice's persistent worktree and create
   `extensions/<name>/index.ts` with a default-export factory.
3. Add colocated tests and a README; document every configuration variable
   in the README.
4. Give the slice its own state and cleanup; no sibling imports. Use `PI_*`
   environment variables under the configuration convention.
5. Run all completion gates in `AGENTS.md` and update README claims to match
   the result. Keep activation separate from implementation.

## Adding a skill

1. Load `skills/harness/SKILL.md`, classify the requested capability, and use
   its Agent Skill lane when a skill is the lowest sufficient surface. Obtain
   the required approval for a new skill surface before any write.
2. Use the slice's persistent worktree. Create `skills/<name>/SKILL.md` with
   frontmatter and one-level references; add dependency-free, tested
   `scripts/` only when repeated work justifies them.
3. Validate the shape with `skills/harness/scripts/validate-skill.mts` and run
   the `AGENTS.md` gates before closing.
