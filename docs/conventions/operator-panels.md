# Operator views convention

This written convention gives the operator one interaction model for an
extension's browsing views and forms in two hosts: ordinary Pi, in the editor
slot below the native transcript, and the standalone attached Agent terminal.
It is not shared code. Each extension implements the views it owns with its own
code, on Pi's public `@earendil-works/pi-tui` components, and no runtime module
is shared across extensions. Each owner keeps its operations, its store, its
approvals, and its validation. A host imports only an owner's advertised
presentation module; it never parses an owner's output or runs an owner's
operations outside the owner's own process.

## Building blocks

An extension builds its views from Pi's components where they fit:

- `SelectList` for lists and for the More menu;
- `Input` and `Editor` for text fields;
- `Markdown` for Markdown;
- `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`, and `sliceByColumn`
  for width;
- `matchesKey` and `Key` for keys.

A view inside `ctx.ui.custom` renders a bounded number of rows itself. Pi's
`ScrollView` scrolls only inside Pi's root layout, so a reader in a view keeps
its own offset. The rest of a view (its title row, key row, More menu, Escape
order, and pointer routing) is the extension's own small code, written to the
rules below.

## View shape

Each side declares these types in its own code. The Agent terminal hosts
owner views through this shape, so it changes only together with every owner
that advertises a panel.

```ts
type NoticeKind = "info" | "success" | "warning" | "error" | "pending";

/** The session or conversation a view acts on, as the operator recognises it. */
interface ViewTarget {
  readonly id: string;
  readonly label: string;
}

interface Action {
  readonly id: string;
  /** Names the effect. */
  readonly label: string;
  readonly description?: string;
  /** Why the action cannot run now. It stays listed and explains itself. */
  readonly disabled?: string;
  /** A pi-tui key id such as "enter" or "ctrl+o", or one printable character. */
  readonly key?: string;
  /** Key-row wording when the label is long. */
  readonly short?: string;
  /** On the key row while it fits; other actions are listed in More. */
  readonly primary?: boolean;
  readonly tone?: "accent" | "danger";
  run(): void;
}

/** Keys the view handles itself in its current focus, shown before its actions. */
interface KeyHint {
  readonly keys: readonly string[];
  readonly label: string;
  /** Lower numbers stay on a short row longer; 0 never leaves it. */
  readonly priority?: number;
}

interface ViewHost {
  readonly theme: Theme;
  /** Every effect of the view acts on this target; it never changes. */
  readonly target: ViewTarget;
  /** Aborted when the view is left. */
  readonly signal: AbortSignal;
  requestRender(): void;
  notify(text: string, kind?: NoticeKind): void;
  /** Open a nested view with its own host and signal. */
  push(open: (host: ViewHost) => View): void;
  /** Leave this view; the first view leaves the host. */
  back(): void;
  /** Return to the conversation, then run `then`. */
  close(then?: () => unknown): void;
}

interface View {
  readonly title: string;
  focused?: boolean;
  render(width: number, height: number): string[];
  /** True when the key was consumed. */
  handleInput(data: string): boolean;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  actions?(): readonly Action[];
  keys?(): readonly KeyHint[];
  /** True while a text field has focus. */
  editing?(): boolean;
  /** Leave an edit or a region; false lets the host continue the Escape order. */
  escape?(): boolean;
  /** Move focus to the next or previous region; false at the edge. */
  focusNext?(backward: boolean): boolean;
  focusEdge?(backward: boolean): void;
  invalidate?(): void;
  dispose?(): void;
}
```

- **View.** A view renders exactly the rows it is given and consumes only the
  keys and pointer events it owns. The host reads `actions()`, `keys()`, and
  `editing()` again at every render and every invocation, so a stale render
  cannot run a replaced action.
- **Host.** Late answers check the view's signal and are dropped. A nested view
  gets its own signal, so its late answers cannot reach the view beneath it.
- **Actions.** Selection, focus, and hover never run an action. Its key, a
  click on its key-row control, or its More entry runs it, through the same
  function. A disabled action stays listed with its reason.

## Interaction rules

- **One view per command.** A command opens its own view alone under its
  title, with no tabs for other owners' views.
- **Title row.** The view's title and the bound target. A nested view adds a
  muted trail row. Neither row holds commands.
- **Key row.** The last row is the primary command surface. Each control reads
  `<key> <label>`, the key in the accent colour and the label quieter. The
  view's own keys come first, then primary actions that have a key, then host
  controls such as Expand on Pi's `app.tools.expand` key, then `x more`, then
  the Escape control last, labelled with what Escape does now (`clear`,
  `list`, `cancel`, `back`, `close`).
- **One key, one meaning.** One key never means two things in one focus: an
  action whose key the view's current hints claim moves into More without that
  key, and the hint keeps the key.
- **Clicks.** A click on a control runs what its key runs. A control with
  several keys (`↑↓ select`, `pgup/pgdn read`) has one target per key; gaps do
  nothing. Only completed left clicks and wheel turns without modifiers act,
  and only at the size last drawn; presses and drags stay native text
  selection.
- **More.** When the row is short, controls leave it by priority into More,
  which lists every control the row does not show, one entry per key of a
  multi-key control, and every action without a key, each with its key. Basic
  navigation, More, and the way out stay on the row. `x` opens More. While a
  text field has focus every printable key is text, so the row shows `ctrl+n`
  for More, and `ctrl+n` opens and closes it from any focus.
- **Escape order.** Escape closes More, then lets the view leave an edit, then
  runs the view's action whose key is `escape` (a Cancel), then leaves a nested
  view, then leaves the view.
- **Focus and reading.** Tab moves through the view's regions. `/` moves to a
  list's search field. PageUp and PageDown read. In fullscreen mode a view in
  the editor slot sets `capturesViewportInput`, so Pi gives these keys to the
  view instead of the transcript; a focused overlay receives them already.
- **Text input.** While a text field has focus it takes every printable key,
  and the row lists only the keys that work there. Without a focused text
  field, keys of the view's current hints reach the view first; only unclaimed
  keys run an action, then `x` opens More, then the view's remaining keys.
- **Failure.** A view that fails while drawing or answering costs only itself:
  its host shows the reason in its place.
- **Approval.** An owner that shows an artifact for approval shows the complete
  artifact in the review view before its effect-labelled final action.

### Browsers and forms

- **Browser.** Search, scopes, a list, and the selected item's detail. The
  detail sits beside the list at 90 columns or more and opens as its own nested
  view below that, from Right or Enter when no action takes Enter. Item actions
  open nested views from the visible detail, so Cancel returns to the same
  record. The detail re-resolves its record by key on every render and action,
  so a refreshed record shows its current state and a removed record explains
  itself instead of acting on another.
- **Form.** Staged fields with one owner call on the effect-labelled submit.
  Enter moves to the next field and submits from the last; the newline keys
  break lines in a multi-line field; Tab moves between fields. Cancel and
  Escape run the same cancel and send nothing. A validation problem or an owner
  refusal keeps every staged field and shows the reason.
- **Programmatic text.** A value set into a text field by code is single-line
  text, not terminal input: terminal escape sequences and non-whitespace
  control characters are removed before insertion, and the cursor follows the
  inserted text.

## Ordinary Pi

Each owner's command opens its own view with `ctx.ui.custom` in the editor slot
below the native transcript. The editor's draft returns when the view closes,
and a close continuation runs after Pi restores the editor, so a command whose
own UI opens next, or text placed in the editor, sees the real editor.

- Opening is a harmless read: it shows content and performs no owner effect.
  Commands that start work, such as `/evo`, are not views.
- A view does not need a command of its own. The statusline's Model view opens
  from the footer's model and level segments. Pi's footer carries no other
  navigation.
- A second open request while the owner's view opens or shows changes nothing.
  A session shutdown closes an open view.
- Presentation code loads when the view opens, not when the extension factory
  runs. No render path or selection handler starts an import.
- State that should survive closing and reopening, such as a query and a
  selection, belongs to the extension instance, not to the view.

Owners: jobs (`/jobs`), stash (`/stash`), clipboard (`/clipboard`), markdown
(`/markdown recent` and `/markdown published`), pillars (`/pillars browse`),
policy (`/policy`), and statusline (`/commands`, `/statuses`, and the Model
view). The agent extension draws its own work view, which `/agent` opens in
the same editor slot, and hosts owner views in the attached terminal.

## Attached panels

The attached Agent terminal is a separate process without ordinary command UI.
An owner that also wants its views there advertises one presentation module
beside its tool-display descriptor and serves the view's data through its own
contribution command.

### Descriptor

```ts
panel: { version: 1, entry: "./<module>.ts", export: "operatorPanel", command: "<own command>" }
```

- `version` is `1` and `export` is `"operatorPanel"`. Other values and extra
  fields are refused.
- `entry` follows the display-entry rules: a bare relative path that starts
  with `./`, resolved under the directory of the contribution's `source`; a
  symbolic link that leaves that directory is refused.
- `command` names a command of the same contribution. The host refuses a
  descriptor whose command is absent from that contribution.

The host admits the descriptor only for a contribution whose `source` matches a
loaded extension entrypoint. A refused descriptor removes only the panel; the
contribution still installs, and the host reports the refusal as a bootstrap
issue. The admitted descriptor rides the `status` inventory beside the
contribution.

### Module

```ts
// <slice>/<module>.ts
export function operatorPanel(): OperatorPanelModule;

interface OperatorPanelModule {
  readonly version: 2;
  /** Short destination label, plain text. */
  readonly title: string;
  open(host: PanelHost): View;
}

interface PanelHost extends ViewHost {
  /**
   * One owner request through the panel's bound command, to the conversation captured when the
   * view opened. Rejects after the view closed or the target changed; aborting `signal`, or
   * leaving the view, withdraws the wait. An admitted request is never resent.
   */
  request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }>;
}
```

The host accepts a module export only in this shape: a function that returns
version `2`, a non-empty title, and an `open` function. Any other value is
refused, never adapted. The module imports only presentation code from its own
slice and public Pi or pi-tui packages at evaluation. An explicit action may
lazily import the owner-local adapter specified under
[Client-local reveal](#client-local-reveal). Evaluating the module registers
nothing, starts no host, opens no store, emits no event, and reads no settings
or credentials. It is trusted local code, not a sandbox.

### Client

When the operator selects a conversation, the attached terminal reads the live
host's `status` inventory and imports each admitted panel module through the
managed Pi peer resolver, the same way it imports display modules. A stored or
stopped host advertises none; selection never starts a host. A module that is
missing, throws, or has another shape costs only its own view: the destination
stays listed as unavailable with a bounded reason. Modules are replaced as a
unit when the selection changes, and a late answer for an earlier selection is
dropped.

The agent's **Owner views** action (key `o`, listed in More) opens the loaded
modules as destinations of the work view's inspector, beside or in place of
the conversation. The work view draws the inspector's key row on its own last
row while the inspector has focus:

- Each view's requests carry the conversation captured when it opened and the
  descriptor's command, with a fresh `invocationId` and `origin: "operator"`.
- Leaving the view, closing the inspector, or selecting another conversation
  withdraws outstanding requests at once and refuses later ones. The
  withdrawal travels to the host connection, which stops waiting. A request the
  host already admitted still runs there; withdrawal is not a rollback, and the
  client never resends it.
- The conversation's draft, delivery effect, and reading position are
  untouched by opening or closing an owner view.
- Opening an owner view starts no model turn. Whether a request starts one is
  the owner's documented effect of that request.

### Owner command route

The owner's contribution command serves both callers:

- `call.data` absent: the existing text behaviour for `agent_command` and the
  `/agent command` route is unchanged.
- `call.data` present: the owner validates it against its finite request union
  and returns `{ text, data }`, where `text` is a bounded human summary and
  `data` is the owner's JSON response. Malformed data is an error, never a
  guess.

`DurableCommandCall` carries `origin` (`"operator"` or `"model"`) when the
caller stated it; the attached terminal and `/agent command` state
`"operator"`, the model tools state `"model"`. An origin is audit context, not
approval: owners keep their own validation, revision checks, and effect labels
on the final action. Browsing, searching, reading, and paging start no model
work; only an explicitly labelled action (for example Stash pickup) submits
input to the bound conversation.

Each owner documents its request union and effects in its README:

| Owner | Reads | Effects |
|---|---|---|
| jobs | active and finished managed commands for the selected conversation, with bounded pages and manual refresh | none |
| clipboard | recent entries, bounded archive search with continuation, exact preview | restore: rereads the exact `id` + `archiveDate` record and writes the host's clipboard; it adds no archive record |
| stash | recent and archive views, exact preview, lifecycle and coverage | pickup (optionally with a note) activates the record and submits one follow-up to the bound conversation, keyed by the invocation; close, release, reopen, rotate through the owner's lifecycle rules |
| policy | registry, fire summary, recent activity, inspection views, exact review artifacts, data list and show | approve, reject, lifecycle, effect, reset; data set, set-file and remove answer first with the complete review and an exact approval that the view sends only after the effect-labelled final action; revisions, file rereads and the view audit are checked again on apply |
| pillars | inventory and source pages with resource identity, offset, continuation, and digest | none; browsing never starts a judgment run or corpus mutation |
| markdown | recent assistant responses, exact response pages, published documents with host store identity | Read saves a response snapshot in the client store or opens a locally accessible published document. Explicit New, Edit and Edit a Copy actions launch the fixed native editor in the client. The host command stays read-only, starts no model work and launches no GUI |

## Client-local reveal

An explicit operator action in a panel view may invoke an owner-local document
reveal adapter, imported lazily by that action from the owner's slice. Import,
render, selection and focus never materialize a document or reveal an app. Every
module remains free of import-time effects.

The adapter materializes bounded, validated source already acquired through the
bound owner command into the owner's private client-side store, or opens an
existing local document from the store identity returned by that command. It
uses one fixed owner-defined OS invocation, with no caller-supplied executable,
helper path or generic command bridge. The owner documents the invocation and
its locality checks in its README.

The action captures the target and entry or document identity before asynchronous
work. It checks the view signal after each awaited acquisition, before
materialization, and immediately before reveal. A changed selection or closed
view withdraws the action. A save that already completed remains saved; it does
not grant permission for a stale reveal. The adapter distinguishes saved,
accepted, not confirmed and reveal failed. It never claims rendering, focus or human
acceptance from a launch receipt.

The adapter runs only in the local operator client. It starts no model turn,
sends no conversation input, and cannot control producer work. A headless host,
publication tool, print process or RPC process never invokes it to launch a GUI.
The owner command supplies data only. The adapter reads the client's own owner
settings when the action runs, and the app path always comes from those
settings. For a document that the host lists from its own store, the host names
that store root and its identity; the adapter opens that root only when a store
with that identity is readable there. A store path from a remote producer is not
proof of local access: the adapter refuses an unavailable local store, rather
than inventing a transfer path.

## Verification

Each owner tests its own views against these rules: its key row and More, the
Escape order, its browser and forms, its request union, its text route without
data, and that importing its panel module registers and emits nothing. The
Agent slice tests descriptor admission (refused entry, absent command, unloaded
source), the command result shape, origin propagation, module loading through
the real resolver (missing module, throwing export, wrong shape, source
replacement), and the binding of requests to the captured target. No slice
test imports another slice's source. `scripts/check-slices.mts` refuses a
slice import that reaches another slice or leaves the slice for a repository
module, apart from the exceptions it names.
