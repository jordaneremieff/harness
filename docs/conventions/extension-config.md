# Extension configuration conventions

Repository-level convention for how extensions receive configuration. Two
mechanisms exist: environment variables and the optional extension-local
`*.config.json` overlay used by `brave`. Both mechanisms keep secrets and local
paths out of committed content.

## Environment variables

An extension that needs configuration reads environment variables named
`PI_*`, or a pre-existing provider variable where one already exists
(`BRAVE_API_KEY`). Every variable an extension reads is documented in that
extension's README.

Current consumers:

| Variable | Extension | Purpose |
|---|---|---|
| `BRAVE_API_KEY` | brave | Brave Web Search subscription token. Precedence: explicit tool option, then this variable, then the overlay file. |
| `PI_STASH_DIR` | stash | Stash store directory override; default `<agentDir>/stash`. |
| `PI_CLIPBOARD_DIR` | clipboard | Clipboard archive directory override; default `<agentDir>/clipboard`. |
| `PI_SESSION_ID` | Pi-injected | Parent session id; the stash extension reads it only as a fallback when the session manager supplies no id. |

Rules:

- Prefer the `PI_*` namespace. A non-`PI_*` variable is acceptable only when
  it predates the convention (`BRAVE_API_KEY`) or is injected by the host.
- Document the variable in the extension README when the extension reads it.
- Keep defaults derivable from the Pi agent directory
  (`getAgentDir()`/`~/.pi/agent`) so tests and isolated deployments can
  override the location.

## Overlay files

A `*.config.json` overlay is git-ignored (`*.config.json` and `.pi/` appear in
both `.gitignore` and `.npmignore`) and never committed. A new overlay consumer
must follow the documented shape or amend this document first.

### Extension-local single file (brave)

- Path: `extensions/brave/brave.config.json`, beside the
  extension source (`DEFAULT_CONFIG_PATH`, client.ts).
- Content: one field, `apiKey`.
- Precedence: explicit tool option, then `BRAVE_API_KEY`, then the file.
- Reader invariants: regular non-symlink file, at most 64 KiB, opened with
  no-follow flags; no fields beyond `apiKey` are read.
- Failure: a missing file with no env key reports that Brave Search is not
  configured; a malformed file fails the call with the file named.

## Security invariants

The overlay reader enforces this security posture:

- The reader accepts only a regular, non-symlink file and enforces a size
  cap.
- Overlays never enter committed content or install artifacts.
- Credential-bearing overlays keep mode `0600`.
- Readers do not import unrelated settings files (dotenv or otherwise) and do
  not weaken Node's normal TLS verification.

## Contract

- An extension documents every configuration variable and overlay it reads in
  its README.
- An extension that reads an overlay implements the shape above.
- This document is amended before another overlay shape ships.
