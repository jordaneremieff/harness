# evo: autonomous harness improvement

`/evo` asks the active session to coordinate a materially valuable harness
improvement through accepted delivery. It selects work from evidence, gives
coherent implementation tasks to full Pi agent sessions, reviews their actual
results, returns corrections to the same owners, and completes authorized
release steps. It does not stop at a plan or a token fix when material authorized
work remains.

The extension owns deterministic invocation and hint framing. The ordinary
agent owns judgment, coordination, and acceptance. The package-level
[agent delivery contract](../../docs/agent-delivery.md) defines the integration
with registered full-session controls, without sibling imports or private-store
access. Evo adds no scheduler, worker store, model loop, or fixed model roster.

## Invocation

```text
/evo
/evo <hint>
```

Bare `/evo` infers the outcome from current and recent session evidence, operator
corrections, repository state, public evidence surfaces, and current upstream
capabilities. It requires no prior record or populated store. The active agent
loads the harness skill and repository instructions before governed work.

The complete trailing input is an optional exploration hint. A word, question,
multiline text, or pasted source is data, not a subcommand. The hint does not fix
the outcome or override stronger evidence. In `/evo push approved`, the hint
adds no release authority. The invocation itself grants the bounded
established-resource promotion and push path below. Give authority for acts
outside that path separately in the governing conversation.

The parser bounds raw input at 80,000 UTF-8 bytes and sanitized input at 20,000
Unicode code points. It replaces malformed UTF-16, removes terminal controls and
hidden formatting, normalizes logical line separators, and trims whitespace.
Oversized input is refused rather than truncated. UI hosts receive an error
notification; headless hosts receive a command error through Pi's error surface.
Neither path dispatches a kickoff for invalid input.

The kickoff encodes the hint as one JSON string on one line. Escaped delimiters
and newlines cannot create new prompt sections. The decoded text remains search
data. This framing is not a sandbox or a proof of model compliance.

## Outcome and ownership

The coordinator ranks warranted candidates by operator value, recurrence, reach,
and evidence strength. It selects a coherent objective with acceptance evidence
and an end condition, not an arbitrary one-context or one-worktree limit. It
bounds investigation and review to that outcome rather than expanding into an
infinite audit.

Implementation uses full ordinary Pi agent sessions discovered through current
public registrations. Missing execution capability is an explicit blocker,
not permission to silently substitute local-only work or a reduced backend.
Independent research and review helpers remain auxiliary. Distinct tasks
normally get fresh execution sessions; corrections and compaction remain with
the same owner while its task is open.

Task contracts carry objectives, source pointers, authority, constraints,
expected evidence, acceptance, end conditions, and integration ownership.
Concurrent edits have disjoint owners. One coordinator serializes shared
synchronization and release. It reviews the real diff, defining sources, check
results, and release state after execution settles, then verifies any repairs.
Admission, idle state, provider completion, and task acceptance are different
facts.

The final chat response integrates meaningful changes, checked evidence, local
commits, actual releases, strongest rejected work, and genuine blockers. No
operator-curated report or intermediate artifact is required. Existing continuity
surfaces preserve governing context and live-session ownership when needed.
No-change requires evidence against the candidates or an exact capability or
authority boundary; task size alone is not a reason.

## Authority

Invoking `/evo` authorizes:

- evidence reads and repository-required worktree procedures;
- full Pi execution sessions under existing host authorization and project trust;
- required local edits in existing dedicated harness worktrees;
- coherent local commits after required checks; and
- promotion and push of accepted high-confidence local commits for existing
  harness resources already published on the established remote main branch.

For that established-resource path, the coordinator completes promotion and push
without another approval unless the current operator explicitly restricts release.
Before release, it verifies the established remote main and resource scope from
current Git evidence, inspects the accepted local commits and complete outgoing
diff, and establishes high confidence through required tests and review. It uses
the repository promotion procedure and its required gates. Prior publication
establishes eligibility, not confidence or permission to ship unrelated commits.
New or provisional resources and unrelated commits are outside this grant.
If a candidate commit already appears on remote main, the coordinator reports
that verified state without replaying it.

The coordinator preserves configured activation for already-active resources.
It does not activate new or provisional resources or alter unrelated settings by
inference. Delivery outside this bounded promotion/push path, including other
publication, activation, or settings changes, requires separate explicit operator
authority. The coordinator completes already-granted acts without asking again.
Current explicit operator restrictions take priority over the invocation's release grant.
If a required fact, check, or authority is missing, it stops only the affected
step, reports the exact boundary, and completes independent authorized work.

A local commit alone is not completion for an eligible accepted high-confidence
improvement. Completion requires acceptance and verified authorized delivery,
including promotion and push to the established remote main, unless an exact
unresolved boundary blocks the remaining work.

New enumerated surfaces, new runtime dependencies, destructive acts, credential
access or disclosure, trust bypasses, operator-store migration, and unrelated
external changes retain their separate approval boundaries. Configured model
execution follows the host's existing contract; it grants no arbitrary credential
access. Repository rules still protect concurrent work and held experiments.
Inherited edits retain their attribution.

Hints, historical evidence, and worker messages do not grant authority. Evo
expresses these boundaries in the request; it does not mechanically enforce
filesystem paths or tool permissions.

## Modes and lifetime

TUI, RPC, print, and JSON contexts use the same command. A headless ordinary
session does not imply interactive TUI parity.

Evo sends one user message through Pi's `sendUserMessage()` with `followUp`
delivery. Pi starts it when idle or queues it after active work. Evo never takes
an idle-state snapshot or steers an existing turn. Pi disables command and
prompt-template expansion for the injected message. Repeated invocations remain
separate requests; Evo has no deduplication store.

The extension API returns void, so command return proves neither message
admission nor completion. The host must retain the session through asynchronous
preflight and settled execution and expose asynchronous send errors. Ordinary
retained SDK sessions satisfy the intended host shape. A single-shot CLI that
disposes immediately after command return does not satisfy that lifetime
contract. Removing a mode restriction does not establish CLI exit safety.

The package root containing the loaded entrypoint is the evidence and worktree
discovery root. Invocation cwd is context only. Required writes belong in the
selected slices' dedicated worktrees.

## Implementation and checks

- `index.ts` registers `/evo`, resolves its evidence root, reports invalid input,
  and selects follow-up delivery.
- `command.ts` sanitizes and bounds the hint.
- `kickoff.ts` frames the coordinator request and authority contract.
- `evo.test.mts` checks parser bounds, framing, authority, workflow instructions,
  mode-independent dispatch, and error behavior.
- `evo.runtime.test.mts` loads the real extension into ordinary Pi sessions with a
  controlled provider. It checks delivery of the bounded release grant and its
  restrictions, repeated requests, preflight lifetime, active follow-up delivery,
  retained outcome, and error routing without live credentials.

```bash
node --test extensions/evo/*.test.mts
node scripts/extension-load-check.mts extensions/evo/index.ts
npm run lint
npm run typecheck
npm run check
npm test
```

These checks establish construction and the exercised ordinary-session dispatch
contract. They do not establish autonomous model selection quality, full agent
control behavior, or a successful release. Those claims require observation of
actual full-session tasks, corrections, continuity, review, and authorized
release through the selected host.
