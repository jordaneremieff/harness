# Extension configuration conventions

The package-level [settings contract](../../settings/README.md) owns machine
configuration reading, validation, source evidence, and redacted publication.
Extensions declare their fields once in a passive `settings.ts` module, export
`settings`, and import only `settings/index.ts` across the slice boundary.

## One machine document

The optional strict UTF-8 JSON document is `<agentDir>/harness.json`, with
`version: 1` and one section per slice. The host supplies the absolute agent
directory. `PI_HARNESS_FILE` selects a different document: relative paths resolve
against that directory. There is no project discovery, include chain, second
configuration registry, watcher, migration, or retired-document reader.

Per-field precedence is present `PI_*` environment input, document field, then
safe default. Invalid selected input returns the safe default and names its
rejected source in a diagnostic. It never uses the file value beneath an invalid
environment override. Secrets are environment-only and appear as set/unset in
public records. Do not put secrets, credentials, machine rosters, or personal
paths in committed examples or declarations.

## Declaration and documentation

- Use `defineSettings` and the scalar or structured declaration helpers.
- Name environment inputs `PI_*`; preserve existing names with explicit `env`
  declarations where needed. Otherwise use the derived `PI_<SLICE>_<KEY>` name.
- Derive runtime defaults with `derivedDefault` and the supplied agent directory
  or declared nonsecret dependencies. Do not reproduce path-resolution policy.
- Keep declaration modules and validators passive. They must not import extension
  entrypoints, read files/environment, register tools, or start runtime work.
- Runtime consumers call `readSettings(settings, { agentDir, env })` and use its
  typed values. Ordinary and Durable entrypoints use the same declaration.
- Generate README configuration tables with `settingsReadme(settings)` between
  the checked markers. `npm run check` compares the projection, requires a shared
  reader, and rejects raw configuration reads for slices with declarations.
- Undeclared consumers retain owning README environment-name checks. This is not
  a claim that every consumer uses the settings contract.
- Extension-owned pure validators define structured settings such as execution
  presets. Shared settings code must not import extension types or lifecycle
  state. Runtime semantic checks such as model catalog validation remain owned
  by that extension.

The lexical gate checks direct process environment access and ordinary injected
`env` dot/literal-bracket access, not arbitrary aliases. Context inputs
`PI_AGENT_DIR`, `PI_AGENT_SESSIONS_DIR`, `PI_MANAGED_INSTALL_ROOT`, `PI_SESSION_ID`,
and `PI_*_TEST_*` are not document settings. Tests and explicitly named fixture
sources are excluded from configuration read checks, not from slice isolation.
See the settings README for precise scope and publication limits.

Configuration references remain owned by each slice:

- [Agent](../../extensions/agent/README.md#configuration-and-storage)
- [Brave](../../extensions/brave/README.md)
- [Clipboard](../../extensions/clipboard/README.md)
- [Memory](../../extensions/memory/README.md)
- [Pillars](../../extensions/pillars/README.md)
- [Policy](../../extensions/policy/README.md)
- [Stash](../../extensions/stash/README.md)

## Inspection and refresh

Owners publish redacted snapshots through the versioned public
`harness:settings:publish` / `harness:settings:request` handshake. Publications
contain settings records and diagnostics, never execution capabilities. Both
ordinary factory load orders work through subscribe-before-emit. Owners clean up
subscriptions on shutdown/reload. A fresh request reads current configuration,
notifies no runtime to apply it, and proves no already-running runtime change.
The shared module performs no writes or live reload.

## Host and application state

Public Pi settings, provider configuration, project trust, and MCP configuration
remain host-owned. This document is the authority for harness configuration;
introduce no extension-owned configuration-file mechanism.

Policy definitions, proposals, approvals, and named tables/schemas are application
state in policy's private event log. Explicit policy surfaces manage that state.
Rules refer to approved binding names, not arbitrary files. The machine document
neither contains that state nor creates ambient file discovery.
