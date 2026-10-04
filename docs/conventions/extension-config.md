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

Configuration references for extensions that read environment variables:

- [Agent](../../extensions/agent/README.md#configuration-and-storage)
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

## Operator-controlled application state

Policy definitions, proposals, approvals, and named tables/schemas are application
state in policy's existing private event log. The explicit policy surfaces manage
that state. Rules refer to approved binding names, not arbitrary files. This does
not introduce ambient configuration-file discovery or a general file loader.

## Contract

- An extension documents every configuration variable it reads in its README.
- This document is the only authority for the convention; a new mechanism
  amends it before it ships.
