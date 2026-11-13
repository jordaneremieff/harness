# Operator views contract

This package-level contract gives an operator one interaction model for an
extension's browsing and forms in two hosts: ordinary Pi, below the native
transcript and editor, and the standalone attached Agent terminal. Each owner
keeps its operations, its store, its approvals, and its validation. A host never
parses an owner's output, imports an owner's source, or runs an owner's closures
outside the owner's own process.

The shared presentation lives in `operator-ui/`. It has two public entries.
`operator-ui/registration.ts` carries the factory-time primitives: announcing
destinations, opening the frame, the loading view, and the view type
contracts. `operator-ui/index.ts` carries the presentation itself: the frame,
controls, building blocks and readers. Extensions import from those two files
only, and `scripts/check-slices.mts` names the extensions that may. The package
owns no operation, store, approval, model catalogue, or trust decision.

## Interaction model

An owner builds its content as `OperatorView` objects mounted in a
`NavigationFrame`:

- **View.** A view renders exactly the rows it is given, consumes only the
  keys and pointer events it owns, returns its actions from `actions()`, the
  keys it handles itself in its current focus from `keys()`, and whether a
  text field has focus from `editing()`. The frame re-reads all three at
  every render and every invocation, so a stale render cannot run a
  replaced action.
- **Host.** Each mounted view receives a `ViewHost`: the theme, the bound
  `target` (the session or conversation every effect of the view acts on;
  it never changes), an `AbortSignal` that aborts when the view is left,
  `notify`, `push` for a nested view with its own signal, `back`, and
  `close(then)`. Late answers check the signal and are dropped.
- **Actions.** An `Action` label names its effect; `key` is the key that
  runs it (a pi-tui key id such as `enter` or `ctrl+o`, or one printable
  character) and `short` is its footer wording when the label is long.
  Selection, focus, and hover never run an action; its key, a click on its
  footer control, or the More menu runs it, through the same function. A
  disabled action stays listed with its reason.
- **Footer.** The frame's last row is the key footer, the primary command
  surface: each control reads `<key> <label>`, key in the accent colour and
  label quieter. The view's own keys come first, then primary actions that
  have a key, then frame controls (Expand on Pi's `app.tools.expand` key in
  ordinary Pi), then `x more`, then the Escape control last, labelled with
  what Escape does now (`clear`, `list`, `cancel`, `back`, `close`). One key
  never means two things in one focus: an action whose key the view's current
  hints claim moves into More without that key, and the hint keeps the key.
  A click on a control runs what its key runs; a control with several keys
  (`↑↓ select`, `pgup/pgdn read`) has one target per key; gaps do nothing.
  When the row is short, controls leave by priority into More, which lists
  every control the row does not show, one entry per key of a multi-key
  control, and every action without a key, each with its key. Basic
  navigation, More and the way out stay on the row. While a text field has
  focus every plain key is text, so the row's More control shows the More
  chord (`ctrl+n`) instead of `x`: the chord opens and closes More from any
  focus whenever the row has hidden entries, and typing `x` stays text.
  Footer hosts that draw the row themselves pass the editing state to
  `Footer.render` and route the chord themselves.
- **Header.** The tab row (or the destination's title), the bound target,
  and in a nested view a muted trail. It holds no commands.
- **Frame.** Destinations sit in one tab row; each keeps its own views,
  query, selection, and reading position while the frame is open. Escape
  closes the More menu, then lets the view leave an edit, then runs the
  view's action whose key is `escape` (a Cancel), then leaves a nested
  view, then leaves the frame. Tab moves through the view's regions, then
  the tab row when the frame shows tabs. One destination's failure costs
  only its own view.
- **Building blocks.** `Browser` (search, scopes, list, and detail, with the
  detail as its own view below `SPLIT_MIN_WIDTH`; item actions push through
  `Browser.push`, which opens from the visible detail while one is open, and
  the detail re-resolves its record by key on every render and action, so a
  refreshed record shows its current state and a removed record explains
  itself instead of acting on another), `ListView`, `ReaderView`, `Form`
  (staged fields with one owner call on the labelled submit: Enter moves to
  the next field and submits from the last, the newline keys break lines in
  a multi-line field, Tab moves between fields, and Cancel and Escape run
  the same cancel and send nothing; the body scrolls to keep the focused
  field's caret or highlighted choice visible, with the heading fixed at
  the top and the hint, pending and error rows at the bottom; the wheel
  moves the body until the next key press reveals the caret again, and a
  choice list keeps its own scroll until a key that moves the highlight, a
  click or a filter change moves it), `LoadingView`, `TextField`,
  `TextArea`, `Footer` with its `Control` records, the key helpers
  (`keyText`, `keysText`, `keyMatches`, `keyInput`, which encodes the whole
  key syntax Pi accepts, including modified chords, so every displayed
  binding has a working click equivalent, or a notice naming the key when
  the terminal has no encoding for it), and `HitMap` (region-local click
  coordinates from the last render only).

Programmatic `TextField` values are single-line text, not terminal input.
Replacement removes terminal escape sequences and non-whitespace control
characters before insertion. Native Input removes line breaks and expands tabs.
Printable text and ordinary spaces remain unchanged, and the cursor follows the
replacement.

Input rules hold everywhere: while a text field has focus it takes every
printable key, and the footer then lists only the keys that work there.
Without a focused text field, the keys the focused view's current hints
claim are the view's binding and reach the view first; only unclaimed keys
run an owner's action, then `x` for More, then the view's own remaining
keys. `/` moves to a list's search field. PageUp and PageDown read. A
pointer event reported for another terminal size acts on nothing, and a
disallowed or modified gesture changes no focus. An owner that shows an
artifact for approval shows the complete artifact in the review view
before its effect-labelled final action.

## Ordinary destinations

An owner announces its ordinary destinations as data on the public `pi.events`
bus with `publishOperatorViews`:

```ts
interface OperatorViewPublication {
  version: 2;
  /** Resolved path of the announcing extension entrypoint (fileURLToPath(import.meta.url)). */
  owner: string;
  views: Array<{
    /** Stable identity inside the owner, for example "stash". */
    id: string;
    /** Plain label, at most 24 characters. */
    label: string;
    /** The owner's registered command that opens this destination, before any collision suffix. */
    command: { name: string; args?: string };
    /** Sort position among the frame's tabs; lower first. */
    order?: number;
    /** Trusted in-process content, bound to the current context when the view opens. */
    view: (ctx: ExtensionContext, host: ViewHost) => OperatorView;
  }>;
}
```

- `OPERATOR_VIEW_PUBLISH` (`harness:operator-view:publish`) carries the
  publication; `OPERATOR_VIEW_REQUEST` (`harness:operator-view:request`)
  carries `{ version: 2 }`.
- The publisher subscribes to requests and emits once at factory setup; a
  consumer (`collectOperatorViews`) subscribes to publications, then emits one
  request. Pi's bus calls a synchronous handler immediately, so both load
  orders meet. A publication replaces that owner's earlier views as a unit.
  A malformed entry, including one without a `view` function, is dropped,
  never adapted. Only version `2` is defined.
- `resolveOwner` binds a destination to its owner's current registration:
  the inventory entry whose `sourceInfo.path` is the announced `owner` (also
  through a resolved real path) and whose name without Pi's `:<n>` collision
  suffix is `command.name`. No owner match, or more than one, leaves the
  destination listed as unavailable with the reason; it never picks a suffix
  by position.
- A destination is a harmless open: opening shows content and performs no
  owner effect. Commands that start work, such as `/evo`, are not
  destinations; they stay in command search.

`openOperatorFrame(pi, ctx, { owner, id })` opens the ordinary frame at one
destination in the editor slot, below the native transcript; the editor's
draft returns when the frame closes. The frame shows the opened destination
alone, under its title; with `{ tabs: true }` and no start, it shows every
published destination as a tab, starting at the first (the statusline's
`/dashboard`). The frame resolves its destinations when it opens and again
when a publication changes, not on every paint. If a frame is already open in
the session, `OPERATOR_FRAME_OPEN`
(`harness:operator-frame:open`) navigates that frame instead of opening
another. `dispatchCommand` sends a command line only after it re-reads the
exact registration identity; the statusline Commands view runs commands
through it, and a changed or missing registration is refused.

Each owner's own command opens its destination directly through
`openOperatorFrame`. A destination without a command of its own names
another command of its owner that opens it, as the statusline's Model view
names `/dashboard`. Pi's status footer carries no control or menu for
these destinations.

Publishers: stash (Stashes), clipboard (Clipboard), markdown (Markdown), policy
(Policy), pillars (Pillars), statusline (Commands, Model, Statuses). The frame collects the
publications each time it opens.

### Loading a view

A published view returns at once: the factory's `view` function builds a
`LoadingView` and starts the owner's import and read inside its load callback.
The implementation module, not the factory, owns everything the view renders.

```ts
view: (ctx, host) =>
  new LoadingView("Stashes", host, async () => {
    const module = await import("./operator-view.ts");
    state ??= module.createStashViewState();
    return module.stashView(host, operations(ctx), state);
  })
```

- A published view is synchronous. The frame mounts the loading view and
  renders `Reading…` until the loaded view replaces it in place.
- State belongs to the extension instance, not the loading view, so a query
  and a selection survive closing and reopening the destination.
- The loading view drops a late result when its host signal aborted, and shows
  a load failure in place with the way to retry.
- No renderer or selection handler starts an import. Presentation imports run
  at open time or command time, never from a render path. The narrowly scoped
  [client-local reveal](#client-local-reveal) adapter is imported by its explicit
  action, not while the view opens.
- A factory that publishes a view imports only `operator-ui/registration.ts`,
  so evaluating its entrypoint does not evaluate the frame and its building
  blocks. A view implementation may import `operator-ui/index.ts` when it
  loads.

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
  open(host: PanelHost): OperatorView;
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

`readPanelModule` accepts a module export only in this shape; any other value
is refused, never adapted. The module imports only presentation code from its
own slice, `operator-ui/index.ts`, and public Pi or pi-tui types at evaluation.
An explicit action may lazily import the owner-local adapter specified under
[Client-local reveal](#client-local-reveal). Evaluating it
registers nothing, starts no host, opens no store, emits no event, and reads no
settings or credentials. It is trusted local code, not a sandbox.

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
modules as destinations of the work view's inspector frame, beside or in
place of the conversation. The work view draws the inspector's key footer on
its own last row while the inspector has focus:

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
| clipboard | recent entries, bounded archive search with continuation, exact preview | restore: rereads the exact `id` + `archiveDate` record and writes the host's clipboard; it adds no archive record |
| stash | recent and archive views, exact preview, lifecycle and coverage | pickup (optionally with a note) activates the record and submits one follow-up to the bound conversation, keyed by the invocation; close, release, reopen, rotate through the owner's lifecycle rules |
| policy | registry, fire summary, recent activity, inspection views, exact review artifacts, data list and show | approve, reject, lifecycle, effect, reset; data set, set-file and remove answer first with the complete review and an exact approval that the view sends only after the effect-labelled final action; revisions, file rereads and the view audit are checked again on apply |
| pillars | inventory and source pages with resource identity, offset, continuation, and digest | none; browsing never starts a judgment run or corpus mutation |
| markdown | recent assistant responses, exact response pages, published documents with host store identity | Read saves a response snapshot in the client store or opens a locally accessible published document, then requests the fixed native reader reveal; the host command starts no model work and launches no GUI |

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
settings when the action runs; host settings never select the client's store or
app. A store path from a remote producer is not
proof of local access: the adapter checks the returned store identity and refuses
an unavailable local store, rather than inventing a transfer path.

## Verification

`operator-ui/*.test.mts` tests the frame, controls, list, reader, forms,
browser, loading view, publication handshake, owner resolution, guarded
dispatch, and module shape checks. It also tests the registration entry's
module boundary and a destination that loads behind a loading view: a first
open, a repeated open, a close during the load, and a failed load. The Agent
slice tests descriptor admission
(refused entry, absent command, unloaded source), the command result shape,
origin propagation, module loading through the real resolver (missing module,
throwing export, wrong shape, source replacement), and the binding of requests
to the captured target. Each owner tests its request union, its text route
without data, and that importing its panel module registers and emits nothing.
No slice test imports another slice's source.
