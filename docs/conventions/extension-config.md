# Extension configuration conventions

Repository-level convention for how extensions receive configuration. The
standard mechanism is one `PI_*` environment variable per extension, documented
in that extension's README. The repository ships no configuration-file
mechanism; secrets and local paths stay out of committed content by staying in
the operator's process environment.

## Environment variables

Every environment variable an extension reads is named `PI_*` and documented in
that extension's README. A variable this harness reads is harness
configuration, whatever external service it authenticates to; provider naming
conventions from outside this repository do not apply.

Current consumers:

| Variable | Extension | Purpose |
|---|---|---|
| `PI_BRAVE_API_KEY` | brave | Brave Web Search subscription token. Precedence: explicit client option, then this variable. |
| `PI_STASH_DIR` | stash | Stash store directory override; default `<agentDir>/stash`. |
| `PI_CLIPBOARD_DIR` | clipboard | Clipboard archive directory override; default `<agentDir>/clipboard`. |
| `PI_SESSION_ID` | Pi-injected | Parent session id; the stash extension reads it only as a fallback when the session manager supplies no id. |

## Rules

- Name every extension-read variable in the `PI_*` namespace. No exceptions.
- Document the variable in the extension README when the extension reads it.
- Keep defaults derivable from the Pi agent directory
  (`getAgentDir()`/`~/.pi/agent`) so tests and isolated deployments can
  override the location.
- Introduce no configuration-file mechanism. A new mechanism enters this
  convention only by amending this document first.

## Contract

- An extension documents every configuration variable it reads in its README.
- This document is the only authority for the convention; a new mechanism
  amends it before it ships.
