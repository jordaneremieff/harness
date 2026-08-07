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
    "extensions": ["./extensions"]
  }
}
```

- Install the package with `pi install /absolute/path/to/harness`; a
  standalone development checkout runs `npm install` and `npm test`.
- `npm run warmup:jiti` pre-transpiles every extension into jiti's on-disk
  cache in `$TMPDIR/jiti` by loading each extension once with
  `pi --help --offline`. It is an operator step after a reboot or fresh
  install, not a build step; the cache is content-keyed, so jiti invalidates
  stale entries automatically.
- Extensions are TypeScript sources loaded directly by the host (Pi requires
  Node 22.19 or newer, which strips types natively). There is no build step;
  tests run with `node --test` over the glob in the `test` script.
- Runtime dependencies on the Pi core packages
  (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, `typebox`) are declared as peers; Pi supplies
  them at runtime.
- Every change is validated against the installed Pi declarations, not only
  against the tests.

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
  variable override where a store location is configurable.
- Its own configuration: environment variables named `PI_*` (or
  `BRAVE_API_KEY`) documented in the README, or the documented
  `*.config.json` overlay shape (see `docs/conventions/extension-config.md`).
- Optional footer status keys through `ctx.ui.setStatus` (see
  `docs/conventions/status-keys.md`).

A new extension must not reuse an earlier harness generation's source,
comments, tests, names, or identifiers (`AGENTS.md`).

## Skill anatomy

Each skill lives under `skills/<name>/`:

- `SKILL.md` — the always-loaded operating procedure, with YAML frontmatter;
  activation knowledge lives in the `description`, not in the body.
- One-level `references/` — conditional detail loaded on demand.
- `scripts/` — dependency-free Node (`.mjs`) automation when repeated work
  justifies it; scripts are non-interactive, documented with `--help`, safe
  by default, bounded in output, and directly tested with colocated test
  files.

The portable shape is checked mechanically by
`skills/harness/scripts/validate-skill.mjs`, the same gate the `harness` skill
applies in its Agent Skill lane.

## Conventions registry

`docs/conventions/` owns repository-level cross-extension contracts. A
contract names its producer and its current consumers and lives outside
either extension, so no extension parses a sibling's format without a
documented surface:

- `extension-config.md` — environment-variable and overlay configuration
  conventions for all extensions.
- `status-keys.md` — the footer status-key registry (publisher, meaning,
  consumers).

New cross-extension behavior belongs here before it ships: write the
contract, name the producer and consumers, and keep it stable.

## Adding an extension

1. Create `extensions/<name>/index.ts` with a default-export factory.
2. Add colocated tests and a README; document every configuration variable
   in the README.
3. Give the slice its own state and cleanup; no sibling imports.
4. Use environment variables for configuration, or the documented overlay
   shape; never commit `*.config.json` overlays (both `.gitignore` and
   `.npmignore` exclude them).
5. Run the `AGENTS.md` gates before closing: focused tests, `npm test`, a
   TypeScript check against the installed Pi declarations, and README claims
   that match reality in the same change.

## Adding a skill

1. Load `skills/harness/SKILL.md`, classify the requested capability, and use
   its Agent Skill lane when a skill is the lowest sufficient surface.
2. Create `skills/<name>/SKILL.md` with frontmatter and one-level references;
   add dependency-free, tested `scripts/` only when repeated work justifies
   them.
3. Validate the shape with `skills/harness/scripts/validate-skill.mjs` and run
   the `AGENTS.md` gates before closing.
