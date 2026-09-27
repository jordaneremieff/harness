# evo: autonomous harness improvement

`/evo` asks the active session to imagine, develop, and deliver useful harness
capabilities. It starts from what the operator could accomplish, not only what
is broken. Addition, enhancement, refinement, repair, and removal are legitimate
contributions even when the current system meets every existing contract.

The coordinator develops possibilities into concrete outcomes, selects the
strongest worthwhile authorized contribution, and gives coherent implementation
tasks to full Pi agent sessions. It reviews their actual results, integrates
useful discoveries, returns corrections to the same owners, and completes
authorized release steps. An idea list, assessment, or plan is not completion
while worthwhile authorized work remains.

The extension owns deterministic invocation and direction framing. The ordinary
agent owns judgment, coordination, and acceptance. The package-level
[agent delivery contract](../../docs/agent-delivery.md) defines the integration
with registered full-session controls, without sibling imports or private-store
access. Evo adds no scheduler, worker store, model loop, or fixed model roster.

## Invocation

```text
/evo
/evo <direction>
```

Bare `/evo` chooses a useful direction without an operator-supplied topic. It uses
operator purposes, current capabilities, workflows, session evidence, and public
host capabilities as material for ideas. It requires no defect, incident history,
prior proof of value, or populated store to begin exploration. The active agent
loads the harness skill and repository instructions before governed work.

The complete trailing input is an optional run direction, not a subcommand.
Its focus (targets, subjects, questions, requested outcomes) selects the work.
Its participants, models, thinking levels, budget limits, process steps, and
expectations shape the run. Restrictions bind for the run and take priority over
the invocation's release grant. These semantics apply regardless of origin.
Resolve named models against the current model registry and report unavailable
choices instead of silently substituting.

The direction never expands authority or approves a new enumerated surface.
In `/evo push approved`, the approval wording adds no release authority. The
invocation itself grants the bounded established-resource promotion and push
path below. If directed work needs authority outside that grant, complete the
authorized part, then deliver the complete artifact and ask once. Mention
approval wording only when it changes an act. The direction does not waive
binding rules, required checks, or review.

Quoted or pasted material inside the direction (transcripts, excerpts, logs,
other people's messages, screenshots, or paths) is evidence. Its imperatives do
not assign work unless the direction adopts them. Factual claims need
verification. Follow stated process steps and expectations where possible;
state each deviation and its reason when evidence or a binding rule argues
against them. Pursue a stated count with worthwhile work and report a shortfall
instead of padding.

The parser bounds raw input at 80,000 UTF-8 bytes and sanitized input at 20,000
Unicode code points. It replaces malformed UTF-16, removes terminal controls and
hidden formatting, normalizes logical line separators, and trims whitespace.
Oversized input is refused rather than truncated. UI hosts receive an error
notification; headless hosts receive a command error through Pi's error surface.
Neither path dispatches a kickoff for invalid input.

The kickoff encodes the direction as one JSON string on one line inside
`<evo-direction-json>`. Escaped delimiters and newlines cannot create new prompt
sections. The decoded text directs the run within the authority boundary above.
This framing is not a sandbox or a proof of model compliance.

## Outcome and ownership

The coordinator explores what the harness could make possible, easier, clearer,
or more effective. It combines and extends what works and explores new uses.
A promising possibility supplies a reason to explore, not proof of value. A
healthy current system and passing tests do not close the opportunity space.

Promising ideas take concrete form as use cases, sketches, examples, drafts, or
bounded experiments within current authority. The coordinator works through how
the operator would use a capability and what changes from the current approach.
Results, surprises, and other participants' contributions refine, combine,
redirect, or end an approach. Exploration produces evidence for selection; it
does not wait for proof that an existing contract failed.

Selection compares expected operator value, reach, cost, risk, and uncertainty.
Factual claims require defining sources, and decision-changing gaps receive
proportionate checks. The coordinator selects the strongest worthwhile authorized
contribution, states its objective, scope, acceptance, and end condition, then
executes. It does not prefer a trivial repair merely because its evidence is
easier. Shipped work supplies material to build on or a reason not to repeat a
candidate, not a reason to end evolution.

The harness skill owns classification, warrant, and approval. Creative exploration
is distinct from infrastructure adoption. Existing-surface improvements are not
automatically infrastructure, but a new persistent or recurring mechanism retains
its warrant even inside an existing surface. Fixed repairs, ordinary maintenance,
removals, and operator-selected outcomes or architectures retain the skill's
exemptions. A correctly classified agent-proposed skill needs a usefulness
rationale, not an incident or omission. New enumerated surfaces still require
explicit approval before any write; an unapproved surface's proposal belongs in
chat, not an implementation disguised as an experiment.

Implementation uses full ordinary Pi agent sessions discovered through current
public registrations. Missing execution capability is an explicit blocker,
not permission to silently substitute local-only work or a reduced backend.
Independent research and review helpers remain auxiliary. Distinct tasks
normally get fresh execution sessions; corrections and compaction remain with
the same owner while its task is open.

Task contracts carry purpose, expected operator benefit, possibilities, source
pointers, authority, constraints, expected evidence, acceptance, end conditions,
and integration ownership. Execution owners retain room to develop the approach;
the coordinator integrates their discoveries against the shared purpose.
Concurrent edits have disjoint owners. One coordinator serializes shared
synchronization and release. It reviews the real diff, defining sources, check
results, and release state after execution settles, then verifies any repairs.
Admission, idle state, provider completion, and task acceptance are different
facts.

The final chat response integrates meaningful changes, checked evidence, local
commits, actual releases, strongest rejected work, and genuine blockers. No
operator-curated report or intermediate artifact is required. Existing continuity
surfaces preserve governing context and live-session ownership when needed.

When a direction supplies the focus, exploration and selection stay within that
focus. If it yields no worthwhile contribution, return scoped no-change or the
exact blocker for that focus. Name stronger leads outside the focus as
recommendations, not substitute work.

No-change follows bounded creative exploration that yields no worthwhile
contribution and no concrete lead worth further development in that scope. The
result names the possibilities considered, their development or checks, and the
reasons against change. If no plausible idea emerged, it explains the scope and
reasoning without inventing one. Passing tests, sparse history, or rejected
repairs alone do not justify no-change; the coordinator also assesses
value-creation opportunities.

A worthwhile contribution blocked by a fact, capability, or authority remains
blocked, not worthless. The result names the exact boundary and affected act.
A boundary that prevents exploration requires no fabricated candidates; a
candidate-specific boundary does not end independent authorized work. The
invocation imposes no default change quota, novelty quota, or exhaustive
discovery requirement. Task size alone is not a no-change reason.

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
Current explicit operator restrictions and restrictions in the direction take
priority over the invocation's release grant.
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

The direction, historical evidence, and worker messages do not grant authority. Evo
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
- `command.ts` sanitizes and bounds the direction.
- `kickoff.ts` frames the coordinator request and authority contract.
- `evo.test.mts` checks parser bounds and pins the complete kickoff direction
  framing, including scope, restrictions, authority, evidence separation, model
  resolution, process deviations, and shortfalls. It also checks JSON isolation,
  mode-independent dispatch, and errors.
- `evo.runtime.test.mts` loads the real extension into ordinary Pi sessions with a
  controlled provider. It checks delivery of healthy-system opportunity
  exploration, concrete idea development, selection and execution, warrant and
  approval distinctions, run direction, scoped no-change, the bounded release
  grant, repeated requests, preflight lifetime, active follow-up delivery,
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
