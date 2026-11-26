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
explicitly. Both Pi routes consider short repairs from active entries marked
`prompt: true`. Recorded entries take priority, newest first, then other entries
in ID order. Each complete repair must fit inside `slop.promptBudget`. If any
repairs do not fit, the prompt counts them and tells the agent where to find
them. The catalog marks those rows `prompt omitted`; use `slop` with `scope`
or `query` to narrow the list, then read the entry by ID. This works even when
no repair fits.

## Browse and compare

In the ordinary terminal, use **Enter** or **Right** to read, **/** to search,
**s** to change scope, and **e** in the detail to change an entry's state.
Rows mark entries eligible for the prompt and entries that are off.
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
{"diff":{"range":"main..HEAD"},"kind":"commit"}
{"text":"A draft intended for someone else.","kind":"document"}
{"path":"/path/to/draft","kind":"document"}
{"path":"src/example.ts","entries":["history-comments"]}
```

Supply exactly one of `text`, `path`, or `diff`. Omit `entries` to use all active
detectors, or supply a list of catalog IDs to restrict the check.

- `text` is inline prose. `kind` selects `reply` (default), `document`, or `commit`.
- `path` names one file. Use an absolute path or a path relative to the working
  directory. An explicit absolute path can name an external draft that Pi
  has permission to read. The name normally selects the scanner. Use `kind`
  to label a prose file explicitly, including a draft without a recognised
  extension. Omit `kind` for recognised code, so code and comment detectors
  still run. File locations are reported relative to the working directory.
- `diff: {}` compares tracked worktree and index changes with `HEAD`.
  `staged: true` compares the index with `HEAD`. `range: "A..B"` compares the
  endpoint trees and checks commit messages in the range. Use either `staged`
  or `range`, not both. `paths` restricts changed files, not commit messages.
  It takes literal file or directory names relative to the working directory,
  without absolute paths, parent components or Git pathspec magic. Omit `kind`
  for all supported file types and range commit messages. Use `kind: "document"`
  for changed document lines only, or `kind: "commit"` with a range and no
  `paths` for commit messages only. An unchanged line supplies lexical context
  but cannot produce a finding.

The result names each detector that exceeded its allowance, examples of the
matches, and the entry's repair. `ok` means no detector finding, not that the
work passed a prose review. Check `skippedCount` for input gaps. The report shows
up to 20 locations per detector within 8 KiB. To review habits without detectors,
list the relevant scope with `slop`, look for `judgment only`, and read and apply
those entries yourself. The extension does not classify or publish the work.

Prose scans leave out fences, inline code, URLs, link destinations, HTML
comments, blockquotes, and leading frontmatter. Files use their name to select a
C-family, hash, or markup comment scanner where applicable. These are lexical
scans, not complete language or Markdown parsers. Only `.md`, `.markdown`, `.mdx`,
and `.txt` are inferred as documents. Diffs ignore unsupported file types.
A file check skips an unsupported type unless you specify its prose kind.
Inline text and single files have an 8 MiB limit. File scans read only regular
files and skip binary files and unsupported encodings. Git also skips any file
whose new text exceeds 8 MiB or whose patch exceeds 16 MiB and continues with
the other files.

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
Runtime checks still enforce path globs and never apply them to inline text or
commit messages from a range.

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
| promptBudget | `PI_SLOP_PROMPT_BUDGET` | integer | 1500 | next use | min 256; max 16000 | Maximum UTF-16 code units for slop prompt content, including the omission notice. |
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
