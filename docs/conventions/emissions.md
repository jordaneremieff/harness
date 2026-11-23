# Emission grammar

This repository-level convention defines how every harness extension presents
what it emits to a person: tool cards, message cards, notifications and the
transcript replays of those cards. Pi's built-in tool and message components
set the reference grammar; this document names the parts that every slice
follows, so a reader meets one visual language across Pi and the harness.

Each extension implements the grammar with its own code. No runtime module is
shared, no slice imports another, and no consumer parses a sibling's rendered
text. [Tool display](tool-display.md) owns how renderer references travel to
the agent dashboard and the attached terminal; this document owns what those
renderers draw. [Status keys](status-keys.md) own the footer, and
[operator views](operator-panels.md) own panels.

## Channels

An emission belongs to exactly one channel. The channel decides the shell, the
label form and the lifetime.

| Channel | Pi surface | Label | Lifetime |
|---|---|---|---|
| Tool card | `ToolExecutionComponent` draws a tool call and its result | The registered tool name | Retained in the session |
| Message card | `CustomMessageComponent` draws a custom message sent with `display: true` | `[<extension>]` and what happened | Retained in the session |
| Result note | Text that an extension appends to another tool's result for the model, such as `[registry] …` | `[<extension>]` inside the result text | Part of that result |
| Notification | `ctx.ui.notify(text, level)` | None; Pi adds `Warning:` or `Error:` | Info rows are replaced by the next info row; others stay |
| Status | `ctx.ui.setStatus(key, text)` | The status key | Until cleared |
| Panel | An operator view | Its heading | While open |

A bracket label marks content that is not a tool call, as in Pi's own
`[compaction]`, `[branch]` and `[skill]`. A tool card never carries a bracket
label, and a message card never carries a tool name as its title.

## Action classes

The action class decides what the collapsed card leads with. A card states
only what its evidence shows: a dispatch is not a completion, an admission is
not an effect, and a read is not a change.

| Class | Subject on the call line | Outcome line | Body preview |
|---|---|---|---|
| Read | What is read: path, URL, ID, query | What came back: size, count, coverage | The first lines of the content |
| Search | The pattern or query | The match count and coverage | The first matches |
| Change | What changes: path, ID, setting | The confirmed effect, in the past tense | The changed value or diff, when short |
| Run | The command or script | The exit or settle state | The last lines of output |
| Dispatch | The recipient | What was admitted: sent, queued, scheduled | None |
| Observe | What is observed | The state summary | Key facts, one per line |
| Show | What is shown | Whether a view shows it | None |
| Yield | None | The state note, as its own card | None |
| Event notice | Not a tool; message card | What happened, as the message title | The event's text |
| Model request | Not a tool; message card | `<Kind> requested`, as the message title | The operator's words, not the model instructions |

## Tool card

Every harness tool registers its own renderers. Pi's fallback card for a tool
without them shows raw `key=value` arguments and counts logical lines, so one
compact JSON result can fill the screen without a hint.

Pi draws the shell: one blank row above, then a box with Pi's horizontal
padding and one row of vertical padding on the pending, success or error
background. Renderers draw only the content inside it and keep the default
`renderShell`. The card has these parts, in this order:

1. **Call line.** The registered tool name in `toolTitle` bold, one space,
   then the subject in `accent`. A short range or limit that Pi's built-ins
   place on the call line, such as `:12-40` or `(limit 20)`, may follow the
   subject in `muted`. No ` · `, `→` or `:` joins the name to the subject.
2. **Facts line.** Optional. Secondary facts in `muted`, joined by ` · `,
   with only facts that are known. A self-identifying value has no label
   (`example/model · high`, not `Model: …`); an ambiguous number
   keeps a short label (`submission 2987`, `limit 20`).
3. **Call body.** Optional. When the main argument is prose or code, such as
   a message, a draft or a script, its first lines follow the facts line, at
   most five visual lines in `toolOutput`, as Pi's `write` and `codemode`
   cards show their content. Short arguments belong in the subject or the
   facts, not here.
4. **Outcome line.** After the result arrives: one blank row, then one plain
   sentence in `toolOutput` that says what happened, or the actual diagnostic
   in `error` when the result is an error.
5. **Body preview.** Optional. At most five visual lines in `toolOutput`, kept
   from the start, except Run output, which keeps the end. Visual lines count
   wrapped rows at the render width, so one long line cannot fill the screen.
6. **Limit line.** Optional. One `warning` line in brackets that names a
   bound on what the card or the result holds (see [Limits](#limits)).
7. **Timing line.** Optional, for Run cards: `Elapsed 4.2s` while the result
   is partial and `Took 4.2s` when it is final, in `muted`, after one blank
   row, in Pi's duration form.
8. **Hint.** At most one per card, always the last row, (see [Disclosure](#disclosure)).

Before the result arrives the card shows the call line, the facts line and,
for a Run card, the timing line. A partial result may replace the outcome line
with progress in `muted`; the outcome line appears when the result is final.

## Message card

A message card is a custom message with `display: true` and a renderer that
the owning extension registers with `pi.registerMessageRenderer`. A displayed
custom type without a renderer is a defect: Pi's default box would show the
raw model text.

The renderer returns a box with Pi's `outputPad` horizontally and one row
vertically on `customMessageBg`; Pi adds the blank row above. Inside it:

1. **Title line.** `[<extension>]` in bold `customMessageLabel`, one space,
   then what happened in bold `customMessageText`, as a short phrase that
   starts with a capital letter: `[jobs] Job 3 finished`,
   `[agent] Report received`. When the event belongs to a named thread or
   piece of work, ` · ` and its name follow: `[agent] Thread post · Parser
   contract`. The sender is never in the title.
2. **Facts line.** Optional, in `muted`, joined by ` · `, as on tool cards.
   It starts with `from <sender>` when the message has a sender, then the
   sender's `provider/model · level`, then other facts.
3. **Body.** One blank row, then at most three visual lines of the body in
   `customMessageText`; Markdown renders when the body is Markdown.
4. **Hint.** As on tool cards.

A left click on a content row toggles that card, as Pi's compaction card does;
a drag still selects text. Pi's global expansion rebuilds every card.

A message that asks the model to act, such as a check that a command starts,
uses the title `<Kind> requested` and shows the operator's own words as its
body. The model instructions appear only in the expanded view.

## Disclosure

The collapsed card shows the subject, the facts, the outcome and a short
preview. The expanded card adds what the collapse hid.

- **Hint form.** Pi's tool-card hint: `... (N more lines, ctrl+o to expand)`
  when N visual lines of the preview are hidden, and `... (ctrl+o to expand)`
  when expansion adds other content such as arguments, raw details or source
  facts. The words are `muted`; the key comes from the `keyHint` function
  that Pi passes in the render context or the message renderer options, so it
  shows the operator's binding in `dim`. Without a configured key the action
  reads `click to expand`. The hint carries no subject words. Pi toggles a
  tool card on a click only after a result exists, so before the result a
  call shows the key form only, and no hint when no key is configured.
  When preview lines are hidden, the counted form applies even if expansion
  also adds other content.
- **Expanded errors.** The expanded view does not repeat the outcome line;
  it adds what the collapse hid.
- **One hint per card.** Before execution the call part owns the hint; once
  the result arrives the result part owns it. A card whose expansion adds
  nothing shows no hint. An expanded card shows no hint.
- **The count is honest.** N counts hidden visual lines of the same text.
  Omitted records, clipped columns and content withheld for privacy are not
  lines; they use the uncounted form.
- **Expanded arguments.** When expansion reveals arguments, they follow the
  call line as Pi's fallback card shows them: one `muted` line per argument,
  `  key: value`, with nested values as indented JSON. An argument that the
  card withholds, such as clipboard content or a memory body, shows its size
  instead: `content: 1204 characters`.
- **Expanded result.** The complete safe text of the result, within the
  display limit. Raw structured details appear only when they add facts that
  the readable form lacks.

## Limits

A limit line names one bound in Pi's bracket form, in `warning`:

- A display bound, where the session keeps more than the card draws:
  `[Truncated: showing 32000 of 51210 characters]`.
- A retained bound, where the full text never reached this record:
  `[Excerpt: first 280 characters retained]`.
- A producer bound, where the tool returned a page of a larger source: the
  outcome line states the page scope and that a continuation exists, not a
  limit line. The expanded view gives the exact continuation call with its
  unshortened cursor; when the call exceeds the display bound, a limit line
  says so.

A card never cuts text without one of these.

## Values

- **Identifiers.** Show IDs, handles and paths in full. Only the render width
  clips a line; a clipped line ends in `…` in the line's own colour and keeps
  the card background.
- **Paths.** Shorten the home directory to `~`, as Pi does.
- **Absent facts.** Omit them. Never write placeholders such as `unknown`,
  `none`, `n/a`, `(empty)`, `pending` or `?`. When absence is itself the
  answer, say so in words: `No matches`, `Not established`.
- **Counts.** Digits with a noun that agrees in number: `1 match`,
  `3 matches`.
- **Times.** Local clock time in 12-hour form today (`2:32 PM`), date and
  time on other days (`23 Nov 2:32 PM`).
  Durations use Pi's form: `4.2s`, `1m 30s`.
- **Models.** `provider/model · level`.
- **Case.** Outcome lines and message titles start with a capital letter.
  Facts are lower case. Tool names and extension labels stay as registered.
- **Labels.** Facts carry no `Label:` prefixes. A number takes its noun after
  it (`3 timers`) or a short word before it (`submission 2987`); zero counts
  that change nothing are omitted. A colon label belongs only to expanded
  key-value evidence.
- **Text safety.** Remove terminal control and escape sequences. Keep
  newlines and tabs in bodies, with tabs drawn as three spaces as Pi does;
  fold whitespace in one-line fields.

## States and colour roles

The shell background shows pending, success and error. Text colour marks
roles, not success.

| Role | Theme colour |
|---|---|
| Tool name | `toolTitle`, bold |
| Subject | `accent` |
| Facts, qualifiers, hints, timing | `muted`; the key inside a hint is `dim` |
| Outcome and body | `toolOutput` |
| Error outcome and diagnostic | `error` |
| Limit line and partial coverage | `warning` |
| Nested call status glyphs | Pi's codemode glyphs and colours |
| Message label | `customMessageLabel`, bold |
| Message title and body | `customMessageText` (title bold) |

- **Error.** Renderers read `context.isError`, which Pi passes beside the
  result; the result object carries only `content` and `details`. An error
  card shows the actual diagnostic text. When the diagnostic can echo a value
  that the collapsed card withholds, such as clipboard content or a note
  body, the collapsed outcome states the structured failure and the expanded
  view holds the diagnostic.
- **Domain outcomes are not errors.** No match, a condition not observed, a
  refusal that the tool reports as its answer, or partial coverage is a normal
  result: the outcome says what happened, and partial coverage adds a
  `warning` limit line.
- **Cancelled.** When the result carries a structured cancelled state, the
  outcome line says `Cancelled`. A thrown cancellation is an error and shows
  its diagnostic; renderers do not infer state from English text.

## Notifications

A notification is one sentence that names its subject: `Markdown reader
updated`, not `Updated`. Pi adds `Warning: ` or `Error: `; the text carries no
severity word and no bracket label.

- `info` reports progress or a completed action. Pi replaces an info row with
  the next info row when nothing else was drawn between them.
- `warning` reports a refusal, a degraded result or a needed operator act.
- `error` reports a failed action and carries its cause.

A multi-line command report, such as a status listing or setup
instructions, opens in an operator view on demand rather than in a
notification. It does not become a message card: a custom message enters the
model's context, and a command report is for the operator. A message card is
for an event that the model also needs. Headless command output keeps its
machine form.

## Model text and display copy

The model reads a tool's content; a person reads its card. Renderers build the
card from the result's structured `details` and fall back to the first
meaningful line of the text content when details are absent or malformed.
When a slice's own model content is a JSON envelope that the slice produces,
the renderer may read that envelope when details are absent, so retained
records show the same human outcome. Renderers never parse English prose,
their own or a sibling's, and never show model guidance ("use the returned
cursor", "treat it as evidence") in the collapsed card; it stays in the
expanded view. Aligning a card never changes the content that the model
receives.

## Transcripts

The agent dashboard and the attached terminal draw each retained tool call
with the owning renderers, Pi's shell and the hint, as the main session does.
When an extension registers a tool under a built-in name, its published
renderers replace the built-in renderer field by field, as Pi does for that
registration (see [Tool display](tool-display.md#agent-dashboard-resolution)).

## Exceptions

Each exception names the platform fact that forces it.

- **State-note cards** (`agent_yield`, `jobs_yield`) use `renderShell: "self"`
  because the result replaces the call in one card.
- **Entry renderers** that Pi draws without `outputPad`, such as the Pillars
  view, supply `Box(1, 1)` themselves.
- **Pi's own built-ins** vary among themselves (`read` hides content when
  collapsed; `grep`, `find` and `ls` count logical lines). Harness cards follow
  the generic rule of Pi's newest renderers, codemode and MCP: five visual
  lines with a counted hint.
- **Panels and status keys** follow their own conventions.

## Verification

Each slice tests its own renderers through Pi's real components:
`ToolExecutionComponent` with a display-only tool definition, and
`CustomMessageComponent` with its message renderer. Tests pass `isError` in
the render context, not on the result. They assert the call line, the facts
line, the hint form and the absence of placeholders. No test asserts another
slice's text.
