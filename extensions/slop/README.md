# slop: catalog and explicit checks

Slop records recurring problems in generated prose, code, and interfaces. A
catalog entry explains how to recognise a problem, what it costs, and how to
repair it. Some entries also have a detector. No part of the extension scans,
blocks, or rewrites ordinary chat replies automatically.

| Surface | Purpose |
|---|---|
| `slop` | List or read catalog entries, or compare the starter set. |
| `slop_check` | Check supplied text, one file, or a Git diff. |
| `slop_record` | Save, remove, disable, enable, or import catalog entries. |
| `/slop` | Browse the catalog in the ordinary Pi terminal. |
| `/slop check [hint]` | Ask the agent to review and repair this conversation's work. |

The tools are direct in ordinary and Durable Pi. Both use the same store and
checks. The first catalog use copies the bundled [starter set](starter/) to a
private machine catalog. The catalog is thereafter independent: edits, removals,
and disablement survive package updates. An empty catalog does not seed again.

An entry without a `prompt` field defaults to `true`. Starter entries set it
explicitly. A system prompt section includes short repairs from active entries
marked `prompt: true`, within 1,500 characters. It considers entries with a
Record section newest first, then the other entries in ID order.

## Browse and compare

In the ordinary terminal, use **Enter** or **Right** to read, **/** to search,
**s** to change scope, and **e** in the detail to change an entry's state.
Rows mark entries set to reach the prompt and entries that are off.
`/slop check [hint]` directs the agent to review recent replies and changed work.
The hint is optional and the command passes it through as text. For a Durable
conversation, select `slop` in the dashboard command form and enter `check`
with an optional hint as the arguments. In the ordinary transcript, the request
card previews only your hint. Expand it to read the instructions sent to the
agent. Durable submits those instructions as input and returns a submission ID.

The `slop` tool accepts `scope` and `query` filters or reads one `entry` by ID.
To compare with the starter set, use `{"starter":true}`. Add `entry` to read a
starter file. The comparison reports:

- `new`: not yet present in the machine catalog.
- `removed`: explicitly removed from the machine catalog.
- `current`: the starter file still matches the digest from seed or import.
- `updated`: the starter file changed since seed or import.
- `replaced`: the catalog has an entry for the ID, but has no import digest.

Local edits to an imported entry do not change its status. Read both versions
before you decide whether to import an updated entry.

The [emission convention](../../docs/conventions/emissions.md) defines the cards.
Slop shows the operation and target, such as an entry ID, path, or diff range.
It does not show supplied prose, search text, or catalog edit bodies as call
arguments. Expand a check to read the retained report. The compact result
separates findings and skipped inputs from tool errors. If a diagnostic can quote
arguments omitted from the call, expand the error to read its full diagnostic.

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

## Change the machine catalog

The operator asks for changes in chat. When the operator objects to a habit,
record it with `slop_record` before repair. Update the existing entry if it
covers the habit. Add the flagged passage and your repair as examples when
available, and set `prompt: true` so the repair is eligible for later prompts.
If no entry covers the habit, save a new one.

- `save` takes a kebab-case `id` and the `operator`'s words. A new entry also
  needs `title`, `domain`, `applies`, `recognition`, `cost`, and `repair`. An
  update keeps fields you omit, appends distinct examples, and replaces the
  detector list only if you supply it. Use `detectors: []` to clear the list.
  Each save adds a Record item with the time, session, model and operator's
  words, plus any `excerpt` and `note`. The oldest items drop out if the file
  reaches its size limit.
- `remove` deletes the entry with that `id` and clears its disabled state.
  For a starter ID, it also marks the entry as removed so a later import skips
  it unless the import names it explicitly. It accepts a `reason`.
- `disable` keeps the entry with that `id` but excludes it from checks and
  prompts. It accepts a `reason`.
- `enable` clears the disabled state for that `id`.
- `import` without `ids` copies only `new` starter entries. With `ids`, it
  copies the named starter files over the catalog files, discards their local
  edits, and clears their removal marks. An unknown ID refuses the entire call.

Every detector must match at least one Slop example before allowance, and no
Better example may match any detector. A Slop example without a match is valid:
read it as a variant that needs judgment. The save result names such examples.
An example supplies a kind but not a path, so these tests ignore path globs.
Runtime checks still enforce path globs and never apply them to plain text or
commit messages.

Detectors match without regard to case by default. Set `caseSensitive: true`
for case-sensitive matching. A `pattern` runs per scoped line with JavaScript
flags `giu` by default or `gu` with `caseSensitive`. Inline modifier groups
are not supported. A judgment entry needs no detector. Only save regular
expressions from sources you trust: detectors run in the Pi process.

The store keeps one entry per `catalog/<id>.md`. `catalog.json` tracks the
starter digests in `imported`, disabled entries in `disabled`, and starter
entries removed from the catalog in `removed`. A store lock serialises writes,
and files publish by atomic rename. A later write reclaims an expired lock.

## Settings

The `slop` section of `<agentDir>/harness.json` uses the harness settings
contract. A present environment value takes precedence. Relative paths resolve
from the agent directory. Changes apply at the next use.

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Applies | Constraints | Description |
|---|---|---|---|---|---|---|
| dir | `PI_SLOP_DIR` | path | &lt;agentDir&gt;/slop | next use | none | Private store for the machine catalog and its state. |
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
