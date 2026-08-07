# Extension engineering

Read only the sections implicated by the requested capability. For a repair, read
its existing tests before host internals and implement after the bounded initial
grounding pass. Verify version-sensitive names/signatures through
`pi-grounding.md`; this is a design checklist, not a frozen API manual or a
request to inspect every listed mechanism.

## Contents

- [Registration and module boundaries](#registration-and-module-boundaries)
  - [Independent extensions and mediated composition](#independent-extensions-and-mediated-composition)
- [Lifecycle, state, and cancellation](#lifecycle-state-and-cancellation)
- [Tools, commands, providers, and model-facing output](#tools-commands-providers-and-model-facing-output)
- [TUI and non-UI modes; RPC and SDK drivers](#tui-and-non-ui-modes-rpc-and-sdk-drivers)
- [Package, discovery, and upgrades](#package-discovery-and-upgrades)
- [Harness integration](#harness-integration)
- [Trust boundaries and provenance](#trust-boundaries-and-provenance)

## Registration and module boundaries

- Keep module import passive. Register capabilities in the factory. The active
  Pi contract may allow a bounded awaited factory for one-time initialization
  such as configuration/model discovery; do not start long-lived processes,
  sockets, watchers, or timers there. Defer those resources to `session_start`
  or the invocation that owns them.
- Separate pure transformations/storage from Pi adapters so behavior can be
  tested without faking the whole host.
- Use supported exported types and registration surfaces. Do not import
  internal runtime modules as an extension contract.
- Keep one owner for each command, tool, event listener, provider, timer, and
  persistent resource. Make duplicate registration/reload behavior explicit.

### Independent extensions and mediated composition

- Give each extension directory its own adapter, helpers, tests, configuration
  boundary, resource ownership, and cleanup so it can load and be verified
  without importing another extension's implementation.
- When capabilities cooperate, depend on an explicit contract at the narrowest
  neutral boundary that can own it: a supported host registration/event
  surface, a stable message or data protocol, or a dedicated integration
  adapter. Participants depend on that contract, not on one another's internals.
- Specify discovery, version negotiation, absence, cancellation, and failure
  behavior at the mediation boundary. An unavailable collaborator must not
  prevent unrelated capability from loading or cleaning up.
- Do not exchange state through undeclared `globalThis` keys, shared mutable
  singletons, or load-order assumptions. Reconstruct predecessor coupling
  behind the mediation boundary or keep the behavior inside one extension.
- Introduce a shared abstraction when a real interaction establishes its
  semantics and it reduces total system complexity. Give it a narrow owner,
  direct tests, and lifecycle boundaries; never turn it into a general shared
  bucket.

## Lifecycle, state, and cancellation

Choose ownership before code:

| Resource | Typical owner question | Required end behavior |
|---|---|---|
| In-memory session state | Per extension load or per session? | Reset/preserve intentionally |
| Timer or watcher | Which session event starts it? | Clear future scheduling |
| In-flight request/poll | Which abort signal governs it? | Abort and settle/report safely |
| Child process | Which call/session owns it? | Terminate process tree and drain output |
| Listener/subscription | Who registered it? | Unsubscribe once, tolerate repeats |
| Persistent file | Which cwd/project/session owns it? | Atomic/bounded writes and clear recovery |

Do not use an agent-turn completion event as a substitute for session shutdown.
Check whether host event dispatch awaits handlers before claiming cleanup is
complete. Make stop/dispose idempotent and safe after partial startup. Abort
active work before or while clearing future scheduling, and avoid committing
partial state after cancellation.

Treat callback context as the source of invocation-owned cwd/model/session data
unless the current contract says otherwise. Resolving project state at module
load can bind the wrong session or directory.

## Tools, commands, providers, and model-facing output

- Give tools specific names, descriptions, bounded parameters, useful errors,
  and structured details where callers benefit.
- Honor the host abort signal and bound filesystem, network, process, and output
  work. Redact secrets and avoid reflecting credentials into model-visible
  text.
- Keep commands useful outside the one happy-path mode. Invalid arguments
  should produce actionable feedback rather than an uncaught stack or silence.
- For providers/model integrations, verify registration, credential sourcing,
  model discovery, reload behavior, streaming/cancellation, and error mapping
  separately.
- Keep user-visible semantics shared between command/tool/UI paths; adapt the
  transport or presentation at the edge.

## TUI and non-UI modes; RPC and SDK drivers

Branch only on mode values declared by the active Pi version; SDK is an
embedding/driver surface, not an extension mode. Mode and UI availability are
different predicates. Check the current command or event context declarations
and runners rather than assuming every `hasUI` context can construct a custom
component.

Choose a surface by interaction capacity, not by habit:

- notification for one-time feedback that needs no retained interaction;
- status or a small widget for passive ambient state;
- built-in dialog for one bounded selection, confirmation, or text input;
- full custom component for a focused workflow that may replace the editor;
- overlay for interactive detail that must coexist with the editor or another
  surface.

Do not force action-heavy work into passive status text, or build a custom
component for a bounded choice already served by an installed primitive. Check
current exports first and reuse maintained components for selection, settings,
loading, text, framing, and key hints where they fit.

For asynchronous overlays and components, keep requests and subscriptions
outside `render()`. Give state, cancellation, and unsubscribe/dispose one owner;
ignore stale completions after close; request repaint explicitly after state
changes; and create fresh component/handle state when reopening. Define visible
loading, empty, error, confirmation, success/cancel, and closed states rather
than exposing silence or raw exceptions.

Required actions must be reachable on the operator's actual keyboard. Do not
bind paging, confirmation, cancellation, or focus recovery solely to keys that
may be absent. Respect injected/configured keybindings where the active API
provides them, show the available controls, and restore focus predictably.

1. Derive one snapshot/action model independent of presentation.
2. Construct terminal components only in the actual interactive TUI branch.
3. Use the current protocol-backed notification/dialog surface where RPC
   supports it.
4. Provide a supported textual or message fallback where no UI exists; do not
   silently no-op or instantiate terminal state in print/headless mode.
5. Bound width, height, list size, wrapping, and updates. Define close/cancel
   keys and restore focus/state on exit.
6. Test the pure renderer/component contract, but require a real interactive or
   PTY check for claims about terminal rendering, input, focus, or resize.
7. Drive RPC/SDK or a non-interactive runner for claims about those modes.

Implement mode branching from the public context contract and focused adapter
tests first. Inspect a runner only for one still-load-bearing mechanism; do not
map every print/RPC/TUI delivery path before editing. A real drive, not broader
source reading, is the next evidence layer for runtime output claims.

Do not force every extension to have a TUI. Add one only when interaction is
part of the requested outcome.

## Package, discovery, and upgrades

- Treat source-checkout loading and installed-package discovery as separate
  claims. Verify manifest discovery fields and every referenced path.
- Keep runtime resources relative to the shipped module/package, not an
  operator's checkout. Include docs, templates, or assets only when runtime or
  operator behavior needs them.
- Inspect the archive before claiming files ship. For npm/git installation,
  install through Pi under an isolated HOME or project settings root, then
  launch without `-e` or a checkout override. For a local package, configure
  its local path and claim only local-package discovery; an arbitrary unpacked
  directory is not proof of managed package installation.
- Keep peer/runtime dependencies intentional and avoid relying accidentally on
  a parent repository's dependency tree.
- During upgrades, test discovery, registration, lifecycle, mode behavior,
  persistence compatibility, and migration/recovery paths affected by the API
  change. Record the old assumption and the supported replacement.

## Harness integration

When the repository/operator's harness distributes or drives an extension,
treat its contracts as repository-specific rather than Pi API. Inspect its
package manifest/resource filters, extension registry or loader, shared
utilities, test entrypoints, SDK/RPC settings, and release path. Verify that
new test files actually execute under the package test command rather than only
passing when invoked directly. Keep resource ownership explicit: a source
checkout, package archive, installed copy, and runtime-loaded
copy are distinct states. Verify the state named by the claim and avoid relying
on dependencies or settings inherited accidentally from the developer harness.
Harness-wide policy unrelated to extension delivery/integration remains out of
scope.

## Trust boundaries and provenance

Map model input, operator input, filesystem paths, environment variables,
credentials, network endpoints, subprocess arguments, and extension output.
Use allowlists or structured argument passing at command/process boundaries;
avoid shell interpolation. Put secrets only in host-approved credential
surfaces and never in prompts, logs, fixtures, provenance, or errors.

Before adding telemetry or preserving incident evidence, obtain the required
operator/repository approval and define purpose, minimum fields, anonymization,
access, retention, and deletion. Store audits and handoffs with the same data
minimization applied to shipped artifacts.

When code, fixtures, or prose are copied or adapted, record source, license,
version/date or commit, what changed, and compatibility in the owning
repository's provenance surface. If sources were only inspected to confirm API
shape, say so rather than implying copied lineage.

A test with synthetic data can establish handling logic. It does not prove that
a production credential, private incident, arbitrary host extension, or
telemetry deployment is safe.
