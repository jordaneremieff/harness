# Operator views contract

This package-level contract gives an operator one interaction model for an
extension's browsing and forms in two hosts: ordinary Pi, below the native
transcript and editor, and the standalone attached Agent terminal. Each owner
keeps its operations, its store, its approvals, and its validation. A host never
parses an owner's output, imports an owner's source, or runs an owner's closures
outside the owner's own process.

The shared presentation lives in `operator-ui/`. Its one public entry is
`operator-ui/index.ts`; extensions import from that file only, and
`scripts/check-slices.mts` names the extensions that may. The package owns no
operation, store, approval, model catalogue, or trust decision.

## Interaction model

An owner builds its content as `OperatorView` objects mounted in a
`NavigationFrame`:

- **View.** A view renders exactly the rows it is given, consumes only the
  keys and pointer events it owns, and returns its labelled actions from
  `actions()`. The frame re-reads them at every render and every invocation,
  so a stale render cannot run a replaced action.
- **Host.** Each mounted view receives a `ViewHost`: the theme, the bound
  `target` (the session or conversation every effect of the view acts on;
  it never changes), an `AbortSignal` that aborts when the view is left,
  `notify`, `push` for a nested view with its own signal, `back`,
  `focusActions`, and `close(then)`. Late answers check the signal and are
  dropped.
- **Actions.** An `Action` label names its effect. Selection, focus, and
  hover never run it; a click on the control, Enter on the focused control,
  or the More menu runs it. A disabled action stays listed with its reason.
  Primary actions show in the action bar in order; the rest, and primaries
  that do not fit, move into More, never out of reach.
- **Frame.** Destinations sit in one tab row; each keeps its own views,
  query, selection, and reading position while the frame is open. Escape
  closes a local popup, then leaves a nested view, then leaves the frame.
  Tab moves through the view's regions, then the action bar, then the tabs.
  One destination's failure costs only its own view.
- **Building blocks.** `Browser` (search, scopes, list, and detail, with the
  detail as its own view below `SPLIT_MIN_WIDTH`), `ListView`, `ReaderView`,
  `Form` (staged fields with one owner call on the labelled submit; Cancel
  and Escape send nothing; a refusal keeps every staged field), `LoadingView`,
  `TextField`, `TextArea`, `ActionBar`, and `HitMap` (region-local click
  coordinates from the last render only).

Input rules hold everywhere: letters go to the focused text field, and no
letter is a shortcut for an effect. PageUp and PageDown read. A pointer event
reported for another terminal size acts on nothing. An owner that shows an
artifact for approval shows the complete artifact in the review view before
its effect-labelled final action.

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
draft returns when the frame closes. Every published destination is a tab.
If a frame is already open in the session, `OPERATOR_FRAME_OPEN`
(`harness:operator-frame:open`) navigates that frame instead of opening
another. `dispatchCommand` sends a command line only after it re-reads the
exact registration identity; the statusline Commands view runs commands
through it, and a changed or missing registration is refused.

Each owner's own command opens its destination directly through
`openOperatorFrame`, and the frame's tabs reach the other published
destinations. No footer control or menu is part of this contract.

Publishers: stash (Stashes), clipboard (Clipboard), policy (Policy), pillars
(Pillars), statusline (Commands, Model, Statuses). The frame collects the
publications each time it opens.

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
own slice, `operator-ui/index.ts`, and public Pi or pi-tui types. Evaluating it
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

The agent's **Owner views** control (in More) opens the loaded modules as
destinations of the work view's inspector frame, beside or in place of the
conversation:

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
| clipboard | recent entries, bounded archive search with continuation, exact preview | restore: rereads the exact `id` + `archiveDate` record, writes the host's clipboard, appends an archive record; success and archive warning stay distinct |
| stash | recent and archive views, exact preview, lifecycle and coverage | pickup (optionally with a note) activates the record and submits one follow-up to the bound conversation, keyed by the invocation; close, release, reopen, rotate through the owner's lifecycle rules |
| policy | registry, fire summary, recent activity, inspection views, exact review artifacts, data list and show | approve, reject, lifecycle, effect, reset; data set, set-file and remove answer first with the complete review and an exact approval that the view sends only after the effect-labelled final action; revisions, file rereads and the view audit are checked again on apply |
| pillars | inventory and source pages with resource identity, offset, continuation, and digest | none; browsing never starts a judgment run or corpus mutation |

## Verification

`operator-ui/*.test.mts` tests the frame, controls, list, reader, forms,
browser, loading view, publication handshake, owner resolution, guarded
dispatch, and module shape checks. The Agent slice tests descriptor admission
(refused entry, absent command, unloaded source), the command result shape,
origin propagation, module loading through the real resolver (missing module,
throwing export, wrong shape, source replacement), and the binding of requests
to the captured target. Each owner tests its request union, its text route
without data, and that importing its panel module registers and emits nothing.
No slice test imports another slice's source.
