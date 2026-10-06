# Extension configuration conventions

Repository-level convention for how extensions receive configuration. The
standard mechanism is `PI_*` environment variables, documented in the owning
extension README. Extension-specific defaults, validation, and precedence live
there, not in a second variable registry. Keep secrets and local paths out of
committed content.

## Environment variables

Every environment variable an extension reads is named `PI_*` and documented in
that extension's README. A variable this harness reads is harness
configuration, whatever external service it authenticates to; provider naming
conventions from outside this repository do not apply.

Configuration references for extensions that read environment variables, plus
the agent extension's optional machine document:

- [Agent environment variables](../../extensions/agent/README.md#configuration-and-storage)
  and [execution presets and delegation preferences](../../extensions/agent/README.md#execution-presets-and-delegation-preferences)
- [Brave](../../extensions/brave/README.md)
- [Clipboard](../../extensions/clipboard/README.md)
- [Memory](../../extensions/memory/README.md)
- [Pillars](../../extensions/pillars/README.md)
- [Policy](../../extensions/policy/README.md)
- [Stash](../../extensions/stash/README.md)

## Rules

- Name every extension-read variable in the `PI_*` namespace. No exceptions.
- Document the variable in the extension README when the extension reads it.
- Keep defaults derivable from the Pi agent directory
  (`getAgentDir()`/`~/.pi/agent`) so tests and isolated deployments can
  override the location.
- Introduce no extension-owned configuration-file mechanism without amending
  this convention first. Public Pi settings, provider configuration, project
  trust, and MCP configuration remain host-owned surfaces; consuming them does
  not create a harness configuration format.
- The agent extension owns one optional strict JSON machine configuration
  document for named execution presets and delegation preferences. Its default
  path derives from the effective Pi agent directory with a documented
  `PI_AGENT_*` override, `PI_AGENT_PREFERENCES_FILE`. The agent README defines its schema,
  precedence, refresh, and error behavior. The repository carries the mechanism
  and portable examples, never a machine roster. This mechanism has no
  project-file discovery or include chain and does not replace host-owned Pi
  settings, provider configuration, credentials, or trust.

## Operator-controlled application state

Policy definitions, proposals, approvals, and named tables/schemas are application
state in policy's existing private event log. The explicit policy surfaces manage
that state. Rules refer to approved binding names, not arbitrary files. This does
not introduce ambient configuration-file discovery or a general file loader.

## Contract

- An extension documents every configuration variable it reads in its README.
- This document is the only authority for the convention; a new mechanism
  amends it before it ships.
