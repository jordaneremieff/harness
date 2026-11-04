# Operator browser contract

This package-level contract lets an operator open an extension's existing
interactive browser from two hosts that cannot see the owning extension's
code: the ordinary Pi footer menu and the standalone attached Agent terminal.
Each owner keeps its panel component, its operations, and its store. Neither
host parses an owner's output, imports an owner's source, or executes an
owner's closures.

Two separate capabilities take part. Every participant copies the shape it
uses locally; no shared runtime module exists.

## Ordinary destinations

The statusline footer menu offers harmless browser destinations above command
search. Pi's command inventory (`pi.getCommands()`) does not say whether a
command opens a browser or performs an action, so an owner announces its
destinations as data on the public `pi.events` bus. The statusline resolves
each destination to its owner's current registration and dispatches it through
the existing guarded route (`dispatchExtensionCommand` in
`extensions/statusline/commands.ts`): the exact registration identity is
re-read before the send, and a changed or missing registration is refused.

```ts
type OperatorDestinationPublication = {
  version: 1;
  destinations: Array<{
    /** Stable identity inside the owner, for example `"stash"`. */
    id: string;
    /** Menu label, at most 24 characters, plain text. */
    label: string;
    /** The owner's registered extension command and the exact arguments that open the browser. */
    command: { name: string; args?: string };
    /** Resolved path of the announcing extension module (`fileURLToPath(import.meta.url)`). */
    owner: string;
  }>;
};
type OperatorDestinationRequest = { version: 1 };
```

- `harness:operator-destination:publish` carries `OperatorDestinationPublication`.
- `harness:operator-destination:request` carries `OperatorDestinationRequest`.

The handshake is the one `docs/conventions/tool-display.md` defines: the
publisher subscribes to the request and emits once at factory setup; the
consumer subscribes to publications, then emits one request. Pi's bus calls a
synchronous handler immediately, so both load orders meet. A publication
replaces that owner's earlier destinations as a unit; it never withdraws
another owner's entries. Only version `1` is defined.

`command.name` is the name the owner registered. When several extensions
register one name, Pi's command inventory lists them as `name:1`, `name:2`, …
The consumer keeps only the inventory entries whose `sourceInfo.path` is the
announced `owner` (the same file, also through a resolved real path) and whose
name without that suffix is `command.name`, and it dispatches Pi's actual
invocation name. No owner match, or more than one, leaves the destination
listed as unavailable with the reason; it never picks a suffix by position.
An entry without `owner` is dropped.

A destination is a harmless open: the command shows a browser and performs no
owner mutation on selection. Commands that start work, such as `/evo`, are not
destinations; they stay in command search with their own argument field. The
consumer never infers a destination from a command name or description.

Publishers: agent (`/agent`), clipboard (`/clipboard`), pillars
(`/pillars browse`), policy (`/policy`), stash (`/stash`). Consumer: statusline.

## Attached panels

The standalone Agent terminal is a separate process without ordinary command
UI. An owner that also wants its browser there advertises one presentation
module beside its tool-display descriptor and serves the browser's data through
its own contribution command. The two descriptors are separate roles: display
modules render tool cards; panel modules present an interactive browser.

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
contribution. The field is optional in `DurableInventorySchema`, so adding it
changed the status response identity; hosts and clients from different
releases refuse each other through the existing operation identity check.

### Module

```ts
// <slice>/<module>.ts
export function operatorPanel(): OperatorPanelModule;

interface OperatorPanelModule {
  readonly version: 1;
  /** Short menu title, plain text. */
  readonly title: string;
  open(host: OperatorPanelHost): OperatorPanelInstance;
}

interface OperatorPanelHost {
  /** The conversation this panel is bound to; every request reaches its host. */
  readonly target: { readonly id: string; readonly name?: string };
  readonly theme: Theme;              // Pi's Theme (fg, bg, bold, …)
  readonly tui: { requestRender(): void };
  /** Rows the client gives the panel on the next render; read it on every render. */
  rows(): number;
  /**
   * One owner request. Rejects after the panel closed or the attachment changed.
   * Aborting `signal`, closing or replacing the panel withdraws it at once.
   */
  request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }>;
  /** Modal prompts the client owns; each resolves undefined when the operator cancels. */
  readonly dialogs: {
    select(title: string, choices: readonly { value: string; label: string; description?: string }[]): Promise<string | undefined>;
    confirm(title: string, description: string, action: string): Promise<boolean>;
    input(title: string, options?: { initial?: string; placeholder?: string }): Promise<string | undefined>;
    /** The terminal's multiline editor, for owner input such as JSON. */
    editor(title: string, initial?: string): Promise<string | undefined>;
    read(title: string, text: string): Promise<void>;
    /** Shown on the client's notice row inside the open panel, and after it closes. */
    notify(text: string, type?: "info" | "warning" | "error"): void;
  };
  /** Return to the conversation. */
  close(): void;
}

interface OperatorPanelInstance {
  render(width: number): string[];
  handleInput(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  invalidate?(): void;
  dispose(): void;
}
```

The module imports only presentation code from its own slice and public Pi or
pi-tui types and components. Evaluating it registers nothing, starts no host,
opens no store, emits no event, and reads no settings or credentials. The
instance is an ordinary pi-tui component: it renders within `width` and
`host.rows()`, consumes keys and pointer events it owns, and reports hit
geometry only from its last render. It is trusted local code, not a sandbox.

### Client

After attach, the Agent terminal reads the live host's `status` inventory and
imports each admitted panel module through the managed Pi peer resolver, the
same way it imports display modules. It keeps the module when the export is a
function whose result has `version: 1`, a nonempty `title`, and an `open`
function. A module that is missing, throws, or has another shape costs only
its own browser: the menu still lists the contribution by name with
"browser unavailable here" and a bounded reason. Panel modules are replaced as
a unit when the attachment changes.

The client owns mounting over the conversation, focus, the footer with Back,
size, cancellation, and disposal:

- Opening a panel captures the attached host and conversation identity. Every
  `request` from that instance carries that identity and the descriptor's
  command, with a fresh `invocationId` per call and `origin: "operator"`.
- Closing or replacing the panel, or an attachment change, disposes the
  instance: outstanding requests settle at once with a refusal, later requests
  are refused, and late results are discarded. The withdrawal travels with the
  request through the controller and manager to the host connection, which
  stops waiting for that answer. A request the host already admitted still
  runs there; withdrawal is not a rollback, and the client never resends it.
- An owner notification appears on a notice row between the panel body and the
  footer; while it shows, `rows()` is one row smaller, so the owner's own
  controls stay on screen.
- The conversation editor's draft, mode, and reading position are untouched by
  opening or closing a panel.
- Opening a panel starts no model turn. Whether a request starts one is the
  owner's documented effect of that request.

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
| stash | recent and archive views, exact preview, lifecycle and coverage | pickup (optionally with a note) activates the record and submits one follow-up to the bound conversation, keyed by the invocation; close, release, reopen, rotate through the owner's lifecycle rules; copy is a client clipboard action |
| policy | registry, fire summary, recent activity, inspection views, exact review artifacts, data list and show | approve, reject, lifecycle, effect, reset; data set, set-file and remove answer first with the complete review and an exact approval that the panel sends only after the effect-labelled final action; revisions, file rereads and the panel audit are checked again on apply |
| pillars | inventory and source pages with resource identity, offset, continuation, and digest | none; browsing never starts a judgment run or corpus mutation |

## Verification

The Agent slice tests descriptor admission (refused entry, absent command,
unloaded source), the command result shape, origin propagation, module loading
through the real resolver (missing module, throwing export, wrong shape,
source replacement), and the client's binding of requests to the captured
target. Each owner tests its request union, its text route without data, and
that importing its panel module registers and emits nothing. No slice test
imports another slice's source.
