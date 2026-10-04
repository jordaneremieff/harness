# Autonomous delivery through full Pi sessions

This package-level workflow connects an invocation such as `/evo` to registered
full Pi sessions. It owns outcome development and coordination, not a runtime
adapter. The invoking session owns selection, synthesis, acceptance, and the
integrated operator result. Participating extensions remain independently
loadable; use their public controls, never sibling imports, private stores, or
parsers for sibling-formatted output.

Read the invocation's direction and grant before orientation. The
[evo invocation contract](../extensions/evo/README.md#invocation) defines directed
focus; its [authority contract](../extensions/evo/README.md#authority) defines the
elevated grant and reserved acts. Apply **Intent authority** in the universal
`AGENTS.md` throughout. Historical records inform judgment, not fresh authority.

## Orient to the operator's work

Reconstruct what the operator accomplishes with agents, the current purposes and
corrections, and the capabilities actually available for that work. Start from
the governing conversation and bounded public resource and evidence reads. Use
retained sessions, operator preferences, current workflows, and public host
capabilities where they answer a selection question. Distinguish shipped,
active, provisional, and merely proposed capabilities; a source file or resource
listing does not establish usable behavior.

When a bounded history question informs orientation, use the standing
[session-history expert](session-history.md). Resolve it with `agent_spawn` and
`handle: "session-history"`, without a prompt. Check that its stored role covers
the question, its selected model meets the request, and its current operation
permits the work. Then task `@session-history` with `agent_send` and
`mode: "followUp"`. Supply the question, source window, and task-specific
restrictions instead of another corpus brief. Creation supplies a short role
and a reachable corpus-reference pointer, not a fixed team. An existing handle
does not establish suitability, availability, or compliance with a requested
model. Follow the reference for creation defaults and any required independent
work, not a fresh-miner default.

The expert does the current research; historical subjects supply its evidence.
The reference owns that distinction, public source access, expected profile
updates, and corrections. A read-only source task does not by itself forbid
tasking the expert or retaining its sourced expertise. Preserve any explicit
restriction on those acts. History is a source for the current purpose, not a
mandatory phase of every run. The coordinator retains judgment and integration
ownership.

Read only enough to form a useful purpose and identify the uncertainty that
decides the next act. Broaden a read for a named gap, not an exhaustive inventory.
Preserve each source's scope, freshness, coverage, and unavailable boundaries.
Batch independent reads through available public composition tools when useful,
without losing those qualifications. Do not read another extension's private
records or infer complete history from a bounded search.

Bare `/evo` infers a useful purpose and acts without asking for a topic. Current
capabilities and plausible uses suffice to start; populated stores, incident
history, and proof of a defect are not prerequisites. Directed runs keep the
supplied focus. Stronger leads outside it are recommendations, not substitute
work. Keep an inferred purpose provisional; it never expands authority or
replaces an operator's request.

When the kickoff reports unaccounted Pi releases, a bare run treats the release
intake as its purpose; a directed run keeps its focus and reports intake as a
pending lead. Unknown coverage makes autonomous baseline recovery the bare run's
first priority, followed by cumulative changelog review if no prior complete
review is established. Dependency installation does not establish release
coverage. Follow the [review coverage procedure](pi-durable-harness.md#release-review-coverage)
before advancing its declaration.

Use history to learn from delivered outcomes and corrections, not to create a
fixed roadmap or work quota. Maintenance-heavy recent sessions are activity
samples, not complete operator priorities. Recent harness development volume is
not evidence of operator value. Distinguish capabilities for ordinary agent-assisted work
from improvements to harness development itself; the latter can serve an
explicit maintenance purpose but do not stand in for the former.

## Develop a useful outcome

Imagine what the harness could make possible, easier, clearer, or more effective.
Addition, enhancement, refinement, repair, and removal are legitimate
contributions. Combine or extend what works and explore new uses. Passing tests
and healthy contracts describe the current system, not the limit of useful work.
A plausible possibility supplies a reason to explore, not proof of value.

Develop a promising possibility into a concrete before/after use path: what the
operator supplies, what agents do, what usable result improves, and what work the
operator must still do. Choose an ordinary task that exposes the intended
difference, then consider variations that reveal its useful reach. This is a way
to reason about the outcome, not a required form, separate artifact, or invented
user story. Keep known facts, inferred needs, and conjectured benefits distinct.

Give the possibility enough form to learn from it through a use case, sketch,
example, draft, or bounded experiment within authority. Investigate the
uncertainty that changes selection. Let results, surprises, disagreement, and
other participants' contributions refine, combine, redirect, or end the approach.
Do not freeze an implementation recipe before this development. Exploration
produces selection evidence; it does not wait for a proven failure to begin.

Compare the developed outcome with the current approach and plausible
alternatives. The current approach is a session on the current harness given
the plain request the operator makes for such work. Record that request in the
use path before the candidate takes shape, from the governing conversation or
retained sessions rather than from the candidate's intended output; acceptance
runs it as the before arm, the run without the candidate. Weigh expected
operator value, reach across a coherent class of tasks, repeated user effort,
implementation and operating cost, risk, and remaining uncertainty. Include
context cost, setup, maintenance, and manual handoffs where they matter. Specialization is not automatically low value;
generic infrastructure is not automatically ambitious. Combining patches counts
only when their composition improves the selected use path, not merely when
all patches are individually valid. Do not prefer a trivial repair because its
evidence is easier to obtain, or inflate scope to look substantive.

A skill or prompt candidate also needs its one-component name before
implementation; the harness skill's design reference
(`skills/harness/references/skill-design.md`) owns the skill naming rule and
its scope test. A candidate that fails the test returns to scope development.

Select the strongest worthwhile authorized contribution and carry its use path
into acceptance: what observable difference will show that this operator task
is better served? State scope, decisive evidence, and an end condition. Stop
exploration when it supports that decision, then deliver. No fixed candidate
count, novelty quota, or one-context or one-worktree cap applies. Already-delivered
work is material to build on or a reason not to repeat a candidate, not a reason
to stop evolution. An idea list, assessment, or plan is not completion while
worthwhile authorized work remains.

## Apply capability and authority rules

The harness skill owns classification, warrant, and new-surface approval. Apply
those rules to the actual capability and mechanism, not to imagination itself.
Existing-surface improvements are not automatically infrastructure, but a new
persistent or recurring mechanism retains its required warrant even there.
Fixed repairs, ordinary maintenance, removals, and operator-selected outcomes or
architectures retain the skill's exemptions. A correctly classified
agent-proposed skill needs a usefulness rationale, not an incident or omission.
Do not reclassify a capability to obtain an exemption.

Before writing a new enumerated surface, apply the operator grant and the skill's
approval rule. The elevated `/evo` grant covers necessary new surfaces within
declared intent; state the required warrant in the result rather than ask again.
A promising idea, reversibility, or sufficient warrant does not itself grant
authority. Develop an unapproved surface's proposal in chat, not an implementation
disguised as an experiment. Complete independent authorized work while holding
only the act that requires a missing decision.

## Coordinate with related efforts

At kickoff and before each promotion, publish the ordinary primary's purpose,
integration intent, declared scope, carried operator direction, and contact
thread through `agent_intent`. Read the related efforts in its result or in
`agent_status`. Update or clear intent when integration completes; a completed
plan must not remain the declared next action. Host facts and session intent
claims are different evidence; unknown liveness and incomplete coverage do not
prove absence. Awareness appears in per-run context, explicit tool reads, and
`/agent`'s Related efforts view only. Registration and intent changes do not
create unsolicited transcript messages. Endpoint records and local roster
refresh still expose the current view. This excludes automatic effort notices,
not direct messages, check-ins, or peer-thread notices.

Use `agent_send` for direct contact with a live effort primary. The operator
also sends direct messages from `/agent`'s Related efforts view. A delivery receipt
proves admission, not action or agreement. Model-origin direct contact can start
a full model turn. Coordinate with one concise proposal that states the order
and its conditions, and one answer that accepts or corrects it. Avoid repeated
acknowledgments; send another message only for a changed condition or a handoff
the agreement requires.

When a participant storage exists, put an agreement that others must see in one
peer thread for the real overlap. Record the governing frame and the order of
shared mutations there. Ordinary primaries alone have no thread storage; use
direct agreement rather than start an unnecessary agent just to hold a thread.
A contact-thread claim links the effort to that retained exchange.

Declare full-gate runs in integration intent with `scope.fullGate` set to `true`.
Check related efforts before a full suite and run one full gate per machine at a time.

Each coordinator controls only its own workers, checkouts, and branches. Never
control another coordinator's resources or promote its unpublished commits.
Keep unpublished commits off live slice branches. Share advice, evidence, and
review requests without treating discovery as permission. Resolve technical
order in the thread; escalate only conflicting operator directions.

## Collaborate from the shared purpose

Discover the current registered full-session controls and read their schemas and
descriptions before use. Establish creation, observation of real transcript
content and operation outcomes, correction delivery, and native context/session
control. Check active availability, not just configured presence; use no frozen
tool list or private lifecycle vocabulary.

Use full Pi sessions for implementation, with the selected workspace's
resources, instructions, tools, extensions, trust decisions, and model
configuration. A headless host is not a TUI-parity claim. A missing capability,
failed bootstrap, or rejected trust decision is explicit. Do not silently
substitute a reduced worker loop, separate implementation backend, or local-only
implementation and call it full-session delivery.

Where collaboration helps, invite a full-session collaborator to develop or
challenge the use path or its decisive uncertainty while the approach remains
open, not only review a prescribed patch. Share discoveries that change
selection or another task's question while they still affect the work. The
coordinator owns the integrated outcome; peers revise their own arrangement
against the shared purpose without a message relay through the coordinator.
No mandatory council, fork, roster, or candidate count applies. Parallelize
independent investigation and review where useful. Auxiliary helpers remain
distinct from full-session implementation.

Use the current [peer thread surface](../extensions/agent/README.md#peer-threads)
to discover related work and keep purpose, authority source, restrictions,
acceptance, and integration attached to the exchange. Participants choose and
revise their contributions. A frame remains an attributed claim; challenge it
against the original source rather than treat peer agreement as verification.
A revised frame or carried decision preserves the operator's restrictions.

Joining opts into passive notices at existing conversation boundaries. Request
a peer's attention explicitly when the task needs a timely response; do not
mistake a retained post or delivery acknowledgment for understanding. End a
contribution with a useful finding or clear boundary instead of polling for
replies. Leave or close an arrangement that no longer serves the work. The
operator observes the exchange through the dashboard and retains the ordinary
primary as the main conversation.

Each execution contract carries:

- the purpose, selected use path, expected benefit, known facts, uncertainties,
  and alternatives needed to judge the approach;
- source pointers, relevant instructions, permitted edits and acts, explicit
  exclusions, and inherited-work attribution;
- acceptance evidence, required checks, and the terminal end condition; and
- integration ownership, dependencies on other units, and the result consumer.

Separate binding operator decisions from revisable agent-authored recipes.
Execution owners retain room to develop the approach within scope. A normal
self-contained terminal response is a valid full-session result; do not impose
an auxiliary worker's submission protocol. Keep concurrent edit ownership
disjoint. One coordinator serializes shared worktree synchronization,
integration, promotion, push, and activation.

Reuse a session when its retained expertise, context, and ownership serve the
current task. Check its current operation and preserve the current requester and
reply route before admission. For recurring concerns such as session history,
resolve an existing expert before creating another. Use a fresh session for
unrelated work, necessary independent judgment, conflicting ownership, or context
that no longer serves the task. State the reason for the choice, not a ritual
justification for reuse. Keep corrections, review repairs, and native compaction
in that session while its task is open.

## Accept the outcome, not just the changes

Answer-bearing agent dispatch returns `result: { sessionId, submissionId,
requestId? }` only after native input admission. Keep that exact reference,
including a known request ID. Creation ancestry, names, reports, timer IDs,
thread posts, and ordinary-primary messages do not identify native results.
The reference identifies work, not its completion or acceptance. Local dispatch
and its background Reporter share the admitted native request; an ordinary
primary still receives normal asynchronous results.

Prompt admission, idle state, provider completion, and task acceptance are
different facts. After an execution unit settles, inspect its real changes and
the defining sources for consequential claims. Reconcile checks and release
state with the task contract. Read public transcript/result content when a
summary omits evidence; a stash lifecycle or task label does not prove completion.

Return to the selected operator task. Check whether the result actually makes
that task easier or more capable and what burden remains. When that difference
decides acceptance, exercise a realistic use path at the layer that owns the
claim. For example, a capability meant to reduce manual handoffs needs evidence
of the resulting task flow, not only valid generated instructions. A hypothetical
example develops an idea; a controlled dispatch test establishes delivered input;
an observed use establishes what happened under its stated conditions. None
alone proves general model quality or operator value.

When the claim is that the operator's task is better served, compare against
the plain request recorded in the use path. A repair, removal, or maintenance
change is accepted on its required checks. The before arm runs that plain
request and its follow-ups on the current harness with the same facts and
authorization. It carries an artifact form only when the operator's own request
in the governing conversation or retained sessions names that form; a form the
candidate introduces stays out, with its method and checklist. A before arm
that asks for an output only the candidate introduces measures what the
candidate adds beyond that output, not whether the candidate is needed, and
cannot support the use path. If the before arm reaches the selected outcome,
the candidate fails acceptance, unless its use path claimed lower cost or
higher reliability on that task before the comparison and repeated matched
runs show that difference. When the operator selected the outcome or waived
the comparison, report the comparison result without treating it as a veto. A
benefit noticed only after the comparison starts a new use path with its own
comparison; do not deliver the original candidate on it or rewrite the
acceptance rationale around it. Count context, output, time, and cost on the
same task: a candidate that costs more without a difference in the operator's
result is a burden, not an improvement, and an artifact the request did not
ask for is cost, not a difference. For a single-run claim, one matched pair
does not prove general equivalence, but it removes the candidate's
demonstrated benefit, and showing one stays the candidate's burden.

Required source, focused, load, and repository-wide checks still bind. Passing
tests, test counts, source existence, generated text, and worker summaries do not
replace outcome evidence. Use obtainable, proportionate checks that decide the
claim, not a new evaluation framework, recurring journal, or operator ceremony.
If a required use check needs unavailable access or authority, name the exact
boundary and narrow the affected acceptance claim; do not invent evidence.

Return applicable findings to the same execution owner and verify the correction.
Each finding gets the repository-required disposition: fixed with a regression
where feasible, shown false with source evidence, or blocked with the exact
unavailable layer. Bound review to the selected outcome and required safety and
completion gates; reject unrelated expansion rather than grow recursive audits.

## Preserve continuity and ownership

Use native compaction and session controls, not another scheduler, worker store,
model loop, telemetry stream, or permanent task journal. Before capacity limits,
preserve purpose, selected use path, authority, source qualifications, acceptance,
open findings, owned sessions, and the next action through an existing continuity
surface when session context alone does not suffice.

Inspect the registered continuity contract. The self-compaction path accepts a
bounded agent-authored summary, applies it at the completed tool boundary, and
continues the same native run. Preserve the governing frame; compaction neither
reconstructs omitted decisions nor certifies completion. Do not type a slash
command into the operator's editor. Other owner-wait controls still refuse
self-targets; do not retry a refused self-control through another name.
Compaction through another session's controller uses native summarization,
stops active work, and needs explicit resumption.

Before coordinator exit, resolve every live worker: await useful work, redirect
changed work, or stop superseded work with its public control. A saved handover
does not transfer process ownership. Use durable execution only when its public
contract covers the needed lifetime and the operator's authority permits it.

A result addressed to an ordinary primary with a dead endpoint remains pending
for that session ID. Other live primaries receive only labeled informational
copies, not ownership of the result. The source records each accepted copy so
host reopens do not repeat it. A live owner that shares the answer still receives
its normal notice and wake intent. Delivery is at-least-once: a crash after
receiver acceptance but before the retained checkpoint can repeat a notice, and
receiver deduplication is process-local.

Rows for proven-dead owners wait in durable storage, not a permanently live
host. The host retires with its recovery marker set, and the recovery link
closes. Primary registration runs the existing bounded recovery scan; the same
owner ID receives its pending result when its endpoint returns. A row whose
owner never returns has no new expiry. Catalog scan limits still bound automatic
recovery reach, not retained-row lifetime. Live or unknown owners retain their
existing retry behavior. See [Agent recovery and delivery](../extensions/agent/README.md#recovery-and-delivery)
for route distinctions, stale check-in pruning, and current process contracts.

## Deliver and report

The invocation owns its grant and reservations. Apply its direction and governing
conversation before deciding that an act lacks authority; carried grants do not
require the operator to repeat a settled decision. Host authorization, project
trust, required checks, and review still bind.

Before release, verify the established remote main and accepted resource scope
from current Git evidence. Inspect accepted local commits and the complete
outgoing diff; establish high confidence through required tests and review. Use
the repository promotion procedure and its gates. Prior publication is not a
prerequisite. Exclude unrelated commits and resources. If a candidate commit
already appears on remote main, report that state without replaying it. Complete
required activation through the repository procedure and preserve unrelated
configured activation and settings.

A local commit alone is not completion for an accepted high-confidence
improvement. End when acceptance and all authorized delivery, including
promotion, push to the established remote main, and required activation, are
verified complete, or an exact unresolved boundary blocks the remaining work.
Verify actual branch, commit, publication, and activation state for each granted
step. Stop only the affected step at a missing fact, check, or authority, and
finish independent authorized work.

Return one integrated chat result under the [chat reporting rule](../AGENTS.md).
Compare the actual result with the promised operator benefit on the same selected
use path; name benefits that remain unsupported rather than infer them from
delivered code. State material limits and blocked decisions that affect
acceptance, use, or the next action. No operator-curated report or intermediate
artifact is required.

### No-change and blocked work

Before no-change, assess value-creation opportunities as well as defects. Return
scoped no-change only when bounded creative development yields no worthwhile
contribution and no concrete lead merits further development in that scope.
Name possibilities considered, how they were developed or checked, and why they
do not justify change. If no plausible possibility emerged, explain the explored
scope and reasoning without inventing one. Passing checks, sparse history,
rejected repairs, and task size alone do not justify no-change. Do not claim the
whole harness has no useful work.

A worthwhile contribution that needs an unavailable fact, capability, or
authority is blocked, not worthless. Name the boundary and affected act. A
boundary that prevents exploration permits a blocked result without fabricated
candidates; a candidate-specific boundary does not end independent authorized
work.

## Host lifetime

Evo dispatches one user message through Pi's extension API with `followUp`
delivery. The host starts an idle turn or queues the message after active work;
Evo does not inspect idle state first or steer existing work. Pi disables command
and prompt-template expansion for that injected message.

The extension API returns void. Command return therefore does not establish
completion of the injected turn. An ordinary SDK host must retain the session
through message admission and settled execution, and expose asynchronous errors.
The mode flag alone does not decide that lifetime. TUI, RPC, and retained
headless ordinary sessions use the same invocation. A single-shot CLI that exits
on command return does not satisfy the lifetime contract merely because its mode
is `print` or `json`.

Pi caches extension factories by path within a process's current cwd and cache
generation. A fresh SDK session in an existing process therefore does not ensure
refreshed extension code. Before live candidate verification, use the intended
idle session's native reload: an already-loaded resource loader clears the
factory cache on reload. This refreshes factories and registration, not objects
that extensions deliberately retain at process scope. Compatible agent managers
and existing workers retain their class methods and closures from creation.

Read back actual candidate behavior through the registered public surface after
reload. Updated descriptions or schemas do not establish changed execution. If
retained owners still execute methods from creation, verify the candidate in a
fresh native host process that loads its code. Another session in the same
process does not establish that boundary. Do not reload or interrupt unrelated
owned sessions.

See [Evo](../extensions/evo/README.md), [worktrees](conventions/worktrees.md), and
[Pi host contracts](pi-durable-harness.md) for invocation, delivery, and runtime
boundaries.
