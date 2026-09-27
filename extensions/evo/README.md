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

Apply **Intent authority** in the universal `AGENTS.md` to the direction and
its delivery. Its operator grants add to the invocation's elevated grant below,
including approval of named new surfaces and their delivery. A direction carried
by an agent on the operator's behalf does not lose that authority. Complete
already-authorized work without another approval. If authority remains missing
after applying the direction and governing conversation, complete the authorized
part, then deliver the complete artifact and ask once for the missing act.

Quoted or pasted material inside the direction (transcripts, excerpts, logs,
other people's messages, screenshots, or paths) is evidence. Apply the same rule
to distinguish that material from instructions the operator adopts. Factual claims
need verification. Follow stated process steps and expectations where possible;
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
authority before any write. Apply the elevated grant below before deciding
whether approval is missing. State the required warrant in the result for a
necessary new surface within that grant. An unapproved surface's proposal belongs
in chat, not an implementation disguised as an experiment.

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

`/evo` is the operator's elevated grant for autonomous delivery of the declared
intent, not merely a request for recommendations. Apply **Intent authority** in
the universal `AGENTS.md` to the invocation, direction, governing conversation,
and delegated task contracts. That rule owns carried decisions, delegated
discretion, agent inference, quoted evidence, and conflict resolution.

Invoking `/evo` authorizes:

- evidence reads and repository-required worktree procedures;
- full Pi execution sessions under existing host authorization and project trust;
- necessary local implementation within the declared intent, including necessary
  new surfaces, with the required warrant stated in the result instead of repeated
  per-surface approval;
- coherent local commits after required checks; and
- promotion, push, and required activation of accepted high-confidence results
  within the declared intent, including new harness resources.

The coordinator completes this delivery without another approval unless the
operator restricts it or reserves the act. Before release, it verifies the
established remote main and accepted resource scope from current Git evidence,
inspects the accepted local commits and complete outgoing diff, and establishes
high confidence through required tests and review. It uses the repository
promotion procedure and its required gates. Prior publication is not a
prerequisite; the grant covers the accepted result, not unrelated commits or
resources. If a candidate commit already appears on remote main, the coordinator
reports that verified state without replaying it.

The coordinator completes required activation for accepted resources, including
new ones, through the repository's activation procedure. Activation enables the
accepted resource in Pi; it does not authorize broader settings changes or
external deployment. Preserve unrelated configured activation and settings. Delivery
outside the declared intent or established repository procedures needs an
operator grant covering that act. Current explicit operator restrictions and
restrictions in the direction take priority over the default release grant.
Apply grants in the direction and governing conversation before deciding that
an act lacks authority. If a required fact, check, or authority is missing, stop
only the affected step, report its exact boundary, and complete independent
authorized work.

Reserved acts need an operator decision covering them:

- pillar corpus promotion;
- new runtime dependencies;
- credential access or disclosure;
- destructive acts on others' work, history, or data;
- operator-store migration;
- unrelated work; and
- external changes beyond the harness repository and its remote, except required
  activation of accepted resources.

Apply **Intent authority** and binding safeguards to those decisions. The
invocation alone does not approve reserved acts. Host authorization and project
trust remain binding; `/evo` grants no credential or project-trust bypass.
Required checks and review apply to every authorized act. Repository rules still
protect concurrent work and held experiments. Inherited edits retain their
attribution.

A local commit alone is not completion for an accepted high-confidence
improvement. Completion requires acceptance and verified authorized delivery,
including promotion, push to the established remote main, and required
activation, unless an exact unresolved boundary blocks the remaining work.

Evo expresses this grant in the request; it does not mechanically enforce
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
  approval distinctions, run direction, scoped no-change, the elevated delivery
  grant and reserved acts, repeated requests, preflight lifetime, active follow-up
  delivery, retained outcome, and error routing without live credentials.

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
