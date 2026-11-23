# slop: catalog and explicit checks

Slop records recurring problems in generated prose, code, and interfaces. A
catalog entry explains how to recognise a problem, what it costs, and how to
repair it. Some entries also have a detector. No part of the extension scans,
blocks, or rewrites ordinary chat replies automatically.

| Surface | Purpose |
|---|---|
| `slop` | List entries by domain, filter by scope or literal query, or read one entry by ID. |
| `slop_check` | Check supplied text, one file, or a Git diff. |
| `slop_record` | Save or replace a local entry, or disable or enable an entry by ID. |
| `/slop` | Browse and change entry state in the ordinary Pi terminal. |
| `/slop flag [note]` | Save the last assistant reply privately and ask the agent to address it. |

The tools are direct in ordinary and Durable Pi. Both use the same store and
checks. A system prompt section includes short repairs from active entries
marked `prompt: true`. It fits within 1,500 characters and considers newer
local entries before shipped entries. Local entries default to `prompt: true`,
so a tell that the operator flags reaches every later session on the machine.
Shipped entries default to `prompt: false`. A general line about a habit
changes more than wording: it can also shorten an answer past what the request
needs or turn a recommendation into a list of options. The prompt therefore
carries the operator's own corrections. A local entry with the same ID and
`prompt: true` puts a shipped entry in the prompt. The
Durable terminal has tool cards but no independent `/slop` panel.

## Check work

```json
{"diff":{"staged":true}}
{"diff":{"range":"main..HEAD","paths":["src"]}}
{"text":"A draft intended for someone else.","kind":"document"}
{"path":"src/example.ts","entries":["history-comments"]}
```

A diff with `{}` compares tracked worktree and index changes against `HEAD`.
A staged check compares the index against `HEAD`. A range compares the two
endpoint trees and also checks commit messages in the range, even when paths
narrow the diff. Only added lines in a diff count. An unchanged line supplies
context for Markdown and comments but cannot itself produce a finding.

The result names the detector, its count and allowance, examples of the
matches, and the entry's repair. `ok` means there are no findings. Look for a
skip notice before treating it as evidence of coverage. The check shows up to
20 locations per detector, within an 8 KiB text report. It does not judge
entries without detectors. Read those entries when reviewing the work.

Markdown prose checks leave out fences, inline code, URLs, link destinations,
HTML comments, blockquotes, and leading frontmatter. Files use their extension
to select a C-family, hash, or markup comment scanner where applicable. These
are lexical scans, not complete language or Markdown parsers. Only `.md`,
`.markdown`, `.mdx`, and `.txt` count as documents. Checks ignore other file
types in diffs and report them as skipped when requested directly.
Git processes one bounded patch per file. It skips files whose new text exceeds
8 MiB or whose patch exceeds 16 MiB, and continues with the other files.
Checks also skip binary files and files with unsupported encodings.

## Record a tell

The operator flags slop in ordinary words, such as calling a reply slop or
objecting to a habit. In an ordinary session, the `slop_record` rules in the
system prompt ask the agent to record the habit before it repairs the text.
Each flagged habit gets a local entry under a new ID, even when a shipped entry
covers it, because only local entries reach later prompts and a local entry
with a shipped ID replaces that entry and its detectors. A habit that comes back
updates its local entry with the new example. The ordinary tool list also gives
each slop tool one line. Durable sessions receive the same instruction through
the `slop_record` description.

`/slop flag` is the explicit form for the last reply.
With a note, the agent also acts on that note. The flag keeps a copy of the
reply, note, and session metadata under the private store's `flags/` directory.
The ordinary browser opens in the editor slot. Use **Enter** or **Right** to
read, **/** to search, **s** to change scope, and **e** in the detail to change
an entry's state. Disabling does not delete an entry.

Use `slop_record` with `action: "save"`, a kebab-case `id`, `title`, `domain`,
`applies`, `recognition`, `cost`, `repair`, and `operator` (the operator's words).
Include a Slop example and a Better example when the source supplies a usable
pair. A detector entry's Slop examples must match before allowance; its Better
examples must not match. An example supplies a kind but not a path, so this
test checks detector matching independently of any path glob. Runtime checks
still enforce path globs and never apply them to plain text or commit messages.
Detectors match without regard to case by default. Set `caseSensitive: true`
for case-sensitive matching. A `pattern` runs per scoped line with JavaScript
flags `giu` by default or `gu` with `caseSensitive`. Inline modifier groups
are not supported.

A judgment entry needs no detector. See [the shipped catalog](catalog/) for
entry files and detector examples. Only save regular expressions from sources
you trust: detectors use JavaScript regular expressions in the Pi process.

A local entry replaces a shipped entry with the same ID. Save adds creation
and update times plus session, model, and directory metadata. Entries live in
`entries/`; state and its reasons live in `state.json`. Files change via atomic
rename. A later write reclaims the store lock after it expires.

## Settings

The `slop` section of `<agentDir>/harness.json` uses the harness settings
contract. A present environment value takes precedence. Relative paths resolve
from the agent directory. Changes apply at the next use.

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Applies | Constraints | Description |
|---|---|---|---|---|---|---|
| dir | `PI_SLOP_DIR` | path | &lt;agentDir&gt;/slop | next use | none | Private store for local entries, entry state and reply flags. |
| prompt | `PI_SLOP_PROMPT` | enum | "on" | next use | on, off | Include active catalog cues in the system prompt. Off leaves the tools, command and CLI available. |
| lexicon | `PI_SLOP_LEXICON` | path | unset | next use | none | File of permitted UTF-8 matches for detectors that use the lexicon. |
<!-- harness:settings:end -->

`prompt` accepts `on` or `off`. The lexicon contains one permitted match per
line. Entries ignore case, and only detectors marked `lexicon: true` use it.

## CLI and opt-in Git hooks

Run the CLI from the repository you want to check:

```sh
node /path/to/harness/extensions/slop/cli.ts check --staged
node /path/to/harness/extensions/slop/cli.ts check --range main..HEAD
node /path/to/harness/extensions/slop/cli.ts check --text-file draft.md --kind document
node /path/to/harness/extensions/slop/cli.ts check src/example.ts README.md
```

The CLI uses the same settings, rules, and report as the tools. The exit
status is `0` for no findings, `1` for findings, and `2` for an error. To opt in,
call it from an existing Git hook (adjust the path to the harness):

```sh
# pre-commit
exec node /path/to/harness/extensions/slop/cli.ts check --staged
```

```sh
# commit-msg
exec node /path/to/harness/extensions/slop/cli.ts check --commit-file "$1"
```

The extension does not install hooks.
