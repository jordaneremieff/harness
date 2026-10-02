# evo: autonomous harness improvement

`/evo` develops and delivers useful capabilities for what the operator accomplishes
with agents. It starts from operator purposes and plausible uses, not only broken
contracts. Addition, enhancement, refinement, repair, and removal are legitimate
contributions.

The active session coordinates an integrated outcome through full ordinary Pi
sessions. The extension supplies invocation and direction framing, not a
scheduler, worker store, model loop, or fixed roster. The required package-level
[delivery workflow](../../docs/agent-delivery.md) owns orientation, outcome
development, collaboration, acceptance, continuity, and release checks.

## Invocation

```text
/evo
/evo <direction>
```

Bare `/evo` prioritizes pending Pi release intake or unresolved release coverage.
When review coverage matches the running host, it infers a useful purpose without
asking the operator for a topic. Current capabilities and plausible uses suffice to start; incident history,
populated stores, and proof of a defect are not prerequisites. The coordinator
loads the harness skill, repository instructions, and delivery workflow before
selection or governed work.

The complete trailing input is an optional run direction, not a subcommand. It
appears before orientation in the request. Its focus (targets, subjects,
questions, requested outcomes) selects the work. Its participants, models,
thinking levels, budget limits, process steps, and expectations shape the run.
Restrictions bind and take priority over the default grant. Resolve named models
against the current model registry and report unavailable choices instead of
silently substituting.

Apply **Intent authority** in the universal `AGENTS.md` to the direction and its
delivery. Operator grants add to the invocation's grant, including approval of
named new surfaces and their delivery. An agent-carried decision keeps its
operator authority. If authority remains missing after applying the direction
and governing conversation, complete the authorized part, then deliver the
complete artifact and ask once for the missing act. Do not ask again for
already-granted acts.

Quoted or pasted material inside the direction, such as transcripts, logs,
excerpts, screenshots, or paths, is evidence. Distinguish that material from
instructions the operator adopts and verify factual claims. Follow stated
process steps and expectations where possible; state each deviation and its
reason when evidence or a binding rule argues against them. Pursue a stated count
with worthwhile work and report a shortfall instead of padding. If the focus
yields no worthwhile contribution, return scoped no-change or its exact blocker.
Stronger outside leads are recommendations, not substitute work.

The parser bounds raw input at 80,000 UTF-8 bytes and sanitized input at 20,000
Unicode code points. It replaces malformed UTF-16, removes terminal controls and
hidden formatting, normalizes logical line separators, and trims whitespace.
Oversized input is refused, not truncated. UI hosts receive an error notification;
headless hosts receive a command error through Pi. Invalid input dispatches no
kickoff.

The kickoff encodes the direction as one JSON string on one line inside
`<evo-direction-json>`. Escaped delimiters and newlines cannot create new prompt
sections. The decoded text directs the run within the authority boundary above.
Framing is not a sandbox or proof of model compliance.

## Release intake

After an upgrade, start a new Pi process and run bare `/evo`. The command reads
`VERSION` and `getPackageDir()` from the running Pi host and its cumulative
`CHANGELOG.md`. A new session inside an old process does not reload Pi core.
The package directory follows Pi's own environment override and binary-install
rules; evo does not poll another installation or perform a hot upgrade.

The baseline is the explicit `pi-release-reviewed-through` declaration in
[the host contract document](../../docs/pi-durable-harness.md#release-review-coverage).
It describes completed release review, not dependency installation. The command
does not use the lockfile or a checkout-version row as review evidence. It reads
the document by immutable commit at the common ancestor of local `main` and
its configured upstream. Dirty files, provisional branches, and an unpublished
marker on local main do not suppress pending intake. Local upstream tracking is
conservative evidence, not a fresh network check; evo does not fetch.

The declaration starts as `unknown` because targeted contract checks do not
establish exhaustive release coverage. A bare run first recovers a defensible
published baseline from repository evidence. If none exists, it reads the
available cumulative changelog through the running version in bounded pages and
reviews its effects on the current harness. Superseded changes are assessed
against the current host, not implemented again. The operator does not need to
paste notes or select a topic.

The kickoff distinguishes:

- **Aligned:** published review coverage matches the running version and the
  changelog boundary exists. The command does not repeat completed intake.
- **Behind:** the running host has later changelog entries. Every entry in the
  interval appears oldest first, with its source path and inclusive line range.
  Bare runs select harness-wide intake; directed runs retain their focus and
  report intake as a pending lead.
- **Ahead:** published coverage exceeds the running host. Report the host
  mismatch without lowering coverage.
- **Unavailable:** Git evidence, the declaration, version syntax, or changelog
  validation failed. Bare runs prioritize autonomous baseline/source recovery,
  not an unrelated topic or an automatic stop. Directed runs report the pending
  coverage question without replacing their focus.

Both version endpoints must occur in the cumulative changelog before the command
claims interval coverage. It rejects malformed, duplicate, and out-of-order
release headings. Numeric version gaps do not imply missing publications. Coverage
means every entry in the installed file, not proof that upstream omitted none.

Each Git operation has a five-second timeout and a 128,000-byte output cap.
Changelog reads stop at 2,000,000 bytes; the parser accepts at most 512 release
headings. Exceeding either input limit produces actionable unavailable evidence.
Embedded notes have a 40,000-byte UTF-8 cap, measured after JSON escaping.
Every selected release retains its path and line range if its text does not fit.
The kickoff requires direct bounded reads of omitted text. Note lines are JSON
strings, separate from trusted instructions.

A bare intake aligns dependencies while retaining wildcard peers, runs
`npm ci` in affected worktrees, repairs consumers, refreshes the host contract
document, and audits extensions, skills, prompts, and scripts for every release
in scope. It adopts new capabilities where they serve the operator's work.
The coordinator advances coverage only after complete review, resolved applicable
findings, required checks, and accepted adoption. Promotion includes the marker
only with completed adoption; publication must succeed before completion is
claimed. Partial, failed, and unrelated directed runs leave coverage unchanged.
The command itself never writes the marker.

## Outcome and ownership

The [outcome development procedure](../../docs/agent-delivery.md#develop-a-useful-outcome)
turns a plausible possibility into a concrete before/after use path: operator
input, agent work, improved result, and remaining user effort. That path guides
selection, collaborator contracts, and acceptance. Collaborators develop and
challenge the approach where useful; the coordinator owns synthesis rather than
merely collecting valid patches.

The [acceptance procedure](../../docs/agent-delivery.md#accept-the-outcome-not-just-the-changes)
checks whether the selected task is actually easier or more capable, using
realistic use evidence when it decides acceptance. Source, test, and dispatch
checks have narrower reach. The workflow also owns
[session and edit ownership](../../docs/agent-delivery.md#collaborate-from-the-shared-purpose),
[continuity](../../docs/agent-delivery.md#preserve-continuity-and-ownership), and
[no-change versus blocked results](../../docs/agent-delivery.md#no-change-and-blocked-work).
An idea list, assessment, plan, or worker summary is not completion while
worthwhile authorized delivery remains. No recurring operator report is required.

## Authority

`/evo` is the operator's elevated grant for autonomous delivery within declared
intent, not merely recommendations. Apply **Intent authority** in the universal
`AGENTS.md` to the invocation, direction, governing conversation, and delegated
task contracts. That rule owns carried decisions, delegated discretion, agent
inference, quoted evidence, and conflict resolution.

Invoking `/evo` authorizes:

- evidence reads and repository-required worktree procedures;
- full Pi execution sessions under existing host authorization and project trust;
- necessary local implementation within declared intent, including necessary new
  surfaces, with the required warrant stated in the result instead of repeated
  per-surface approval;
- coherent local commits after required checks; and
- promotion, push to the established remote main, and required activation of
  accepted high-confidence results within declared intent, including new harness
  resources.

The coordinator completes those acts without another approval unless the operator
restricts them or reserves the act. The grant covers accepted results, not
unrelated commits or resources. Prior publication is not a prerequisite. Use
established repository procedures and their gates, following the
[release checks](../../docs/agent-delivery.md#deliver-and-report).

Activation enables accepted resources in Pi. It does not authorize broader
settings changes or external deployment. Preserve unrelated configured activation
and settings. Delivery outside declared intent or established repository
procedures needs an operator grant covering that act. Current explicit operator
restrictions and restrictions in the direction take priority over the default
grant. Apply direction and conversation grants before deciding authority is
missing; stop only the affected act and complete independent authorized work.

Reserved acts need an operator decision covering them:

- pillar corpus promotion;
- new runtime dependencies;
- credential access or disclosure;
- destructive acts on others' work, history, or data;
- operator-store migration;
- unrelated work; and
- external changes beyond the harness repository and its remote, except required
  activation of accepted resources.

The invocation alone does not approve reserved acts. Ordinary configured model
execution follows the host's existing authorization and trust contract; `/evo`
grants no credential or project-trust bypass. Apply binding safeguards, required
checks, and review to every authorized act. Repository rules protect concurrent
work and held experiments; inherited edits retain attribution.

Completion requires acceptance and verified authorized delivery, including
promotion, push, and required activation, unless an exact unresolved boundary
blocks the remaining work. A local commit alone is not completion. Evo expresses
this grant in the request; it does not mechanically enforce filesystem paths or
tool permissions.

## Modes and lifetime

TUI, RPC, print, and JSON contexts use the same command. Evo sends one user message
through Pi's `sendUserMessage()` with `followUp` delivery. Pi starts it when idle
or queues it after active work. Evo never snapshots idle state or steers an
existing turn. Pi disables command and prompt-template expansion for the injected
message. Repeated invocations remain separate requests without a deduplication
store.

The extension API returns void. Command return proves neither admission nor
completion; the host must retain the session through asynchronous preflight and
settled execution and expose asynchronous errors. A single-shot CLI that disposes
on command return does not satisfy this contract. A headless ordinary session is
not a TUI-parity claim. See [host lifetime](../../docs/agent-delivery.md#host-lifetime)
for candidate reload and retained-process boundaries.

The package root containing the loaded entrypoint is the evidence and worktree
discovery root. Invocation cwd is context only. Required writes belong in the
selected slices' dedicated worktrees.

## Durable agents

Agent sessions that run on Pi Durable receive `/evo` through the native
contribution contract. The ordinary factory emits one contribution on the
`durable:contribution` channel before it registers the command. A Durable
session host collects that contribution and installs its extension; an ordinary
Pi session has no listener, so the emission has no effect.

The native form is a contribution command named `evo`. It uses the same
direction parser, release intake, and kickoff builder as the ordinary command.
The host's cwd supplies the invocation workspace line. The kickoff is submitted
as follow-up input, so a busy conversation queues it after the active turn.

The command offers no model tools, so it declares no replay classes. Durability
belongs to the submission instead. The command derives the request ID from the
host-supplied invocation ID. A retry of the same invocation reuses its
submission; two identical invocations stay two separate requests, the same as
the ordinary command.

`durable.ts` holds the contribution and the shared command description.
`durable.test.mts` runs the contribution in a real Harness over `MemoryStorage`
with the pi-ai faux provider. It checks kickoff admission, separate submissions
for identical invocations, reuse for a retried invocation, the host-cwd
binding, direction refusal, and the absence of model tools.

## Implementation and checks

- `index.ts` registers `/evo`, emits the Durable contribution, resolves its
  evidence root, reads release intake, reports invalid input, and selects
  follow-up delivery.
- `release.ts` reads published review coverage and bounds cumulative release notes.
- `release.test.mts` checks source validation, publication boundaries, context
  limits, recovery priority, and directed focus with isolated Git fixtures.
- `command.ts` sanitizes and bounds the direction.
- `kickoff.ts` frames intent, direction, authority, and the required workflow read.
- `durable.ts` builds the Durable contribution command: the same parser,
  release intake, and kickoff, submitted with a request ID from the invocation ID.
- `durable.test.mts` runs the contribution in a real Durable Harness: admission,
  separate identical invocations, retry reuse, the host-cwd binding, and
  direction refusal.
- `evo.test.mts` checks parser boundaries, JSON isolation, direction precedence,
  the complete grant and reservations, and semantic requirements across the
  kickoff and its owning workflow. It also checks mode-independent dispatch,
  errors, and the emitted contribution.
- `evo.runtime.test.mts` loads the real extension into ordinary Pi sessions with a
  controlled provider. It checks exact delivered requests in all modes, repeated
  requests, preflight lifetime, active follow-up delivery, retained outcome, and
  error routing without live credentials. An isolated harness fixture verifies
  pending release delivery even when its lockfile matches the running host, and
  verifies that dispatch does not write coverage.

```bash
node --test extensions/evo/*.test.mts
node scripts/extension-load-check.mts extensions/evo/index.ts
npm run lint
npm run typecheck
npm run check
npm test
```

These checks establish instruction construction and the exercised ordinary-session
and Durable-command dispatch contracts, not improved autonomous model selection
or a successful release.
Those claims need observed full-session outcomes and their use, review, and
authorized delivery through the selected host.
