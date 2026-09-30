---
name: choice-model
description: >
  Use for quantitative choices whose answer depends on costs, quantities,
  time, capacity, or uncertain assumptions: make versus buy, plan selection,
  resource allocation, and break-even or what-if decisions. Build or reuse an
  inspectable executable model, identify feasibility limits and inputs that
  change the choice, and answer follow-ups from the same model. Use also for
  changed-input questions about an existing decision model, including
  spreadsheets. Do not use for isolated arithmetic, conceptual explanation,
  formatting, descriptive reporting, forecasting alone, or purely qualitative
  comparisons.
---

# Choice model

Make the quantitative reasoning inspectable and reusable. Deliver the result
and the calculation that produces it, so a changed assumption leads to a
recalculation rather than a second, inconsistent analysis.

## Establish the decision

- Identify the choice, the objective, the time horizon, and the constraints.
  Separate hard requirements from preferences. Preserve the operator's stated
  priorities; do not invent weights or convert every consideration into money.
- Include the current approach when it is a real alternative. Test whether the
  option set is fixed or merely assumed: a permitted split, delay, or partial
  change may serve the objective better. Do not add an alternative that violates
  the supplied constraints.
- Inspect any supplied spreadsheet, script, or formula before designing another
  artifact. Reuse it when its inputs and logic are visible and it supports the
  requested changes. A working spreadsheet needs no duplicate code model.
- Resolve only missing facts that change the calculation or the decision. Use
  available sources first. If a decisive input remains unknown, expose it as an
  unknown, report conditional results, or ask the specific question. Do not
  replace an unknown with zero or a convenient estimate.

**Ready when:** the objective, allowed alternatives, horizon, material unknowns,
and rules for feasibility are explicit. If priorities remain undecided, model
separate outcomes rather than manufacture a single winner.

## Make inputs traceable

Keep editable inputs separate from formulas and calculated results. For each
material input, retain its value or range, unit, period, and provenance in the
model. Distinguish operator-supplied values, checked source values, estimates,
and agent assumptions. Identify a source by its file, sheet/cell, URL, or
supplied statement; retain the date or version when it affects applicability.
A supplied estimate is not a measured fact, and a computed value is not another
independent input.

Normalize compatible units and periods before comparison. Preserve the time
resolution of each constraint: annual capacity does not establish monthly
feasibility, and average demand does not establish peak feasibility. Distinguish
calendar time, working time, and active effort when the difference matters.

For cost choices, separate one-time, recurring, marginal, and already-incurred
costs. Charge each cost under the conditions that actually incur it. Include
setup for a partial option if that option still needs setup. Avoid double
counting common costs or treating an accounting allocation as a cash saving.
Keep cash changes separate from released time or capacity; unchanged salaries
do not become avoided cash expenditure. Include opportunity value only when
its basis is supplied or supported, and label it separately. Add financing,
resale, discounting, or other cost detail only when material to this choice.

**Ready when:** another agent can find the source and meaning of each material
input, and the alternatives use comparable units and horizons.

## Build the smallest sufficient executable model

Use the existing suitable model by default. Otherwise, create a small artifact
that the available tools can execute and the operator can inspect. For a new
code model in Pi, prefer dependency-free TypeScript with the available Node.js
runtime. Do not require a new package, spreadsheet application, or service just
to turn a short calculation into a framework. An existing recalculable formula
is sufficient when it already supports the decision and follow-ups.

Keep one calculation path for the baseline, alternative inputs, and boundary
checks. Retain the baseline inputs and label scenario overrides instead of
silently replacing assumptions. Use named inputs and explicit formulas, with
outputs that expose totals, relevant component values, and constraint results.
Reject invalid input types, incompatible periods, and values outside the
model's domain rather than producing plausible-looking output.

Evaluate feasibility before ranking:

- Apply each capacity, budget, timing, quality, or other hard limit at its actual
  resolution. Do not assume storage, advance work, overtime, substitutability,
  or fractional resources without a basis.
- Model whole units, batch sizes, minimum charges, and capacity steps explicitly
  where they apply. Round in the direction the constraint requires; do not
  compute a fractional plan and round only its displayed answer.
- Calculate permitted mixed alternatives with their own allocations and costs.
  Check that allocations reconcile to demand and respect each applicable limit.
- Keep infeasible and unresolved alternatives visible with their reasons. Do
  not rank an infeasible option as the winner because its unconstrained cost is
  lower. If feasibility depends on an unknown, make the recommendation conditional.

Rank feasible alternatives using the stated objective. If none is feasible,
identify the violated limits. If no priority resolves a real tradeoff, show the
separate outcomes and name the missing decision instead of inventing a score.
Keep analysis separate from procurement or changes to operational systems.

**Ready when:** the model recalculates from explicit inputs and explains both
its feasible choices and its exclusions. If the required execution tool is
unavailable, label the unexecuted calculation and its verification boundary.

## Find what changes the choice

Start with inputs whose uncertainty or plausible change could alter feasibility
or the preferred alternative. Use supplied ranges, observed variation, or
explicitly labeled exploratory scenarios. A range does not define a probability
distribution. Do not invent likelihoods, independence assumptions, or a simulation
to create confidence in a recommendation.

Use the same model to investigate:

- **Feasibility boundaries:** when a constraint starts or stops binding.
- **Choice boundaries:** when feasible alternatives exchange preference or tie.
- **Uncertainty:** whether the supported input range lies on one side of those
  boundaries or crosses them.

Solve simple continuous comparisons directly. For discrete or piecewise models,
inspect the relevant branches and attainable neighboring values. Test both
sides of a claimed boundary, including equality when it exists. A capacity step
may change the choice without an exact tie; multiple transitions or no transition
are valid results. Do not force a single continuous break-even point onto every
model. State the domain, fixed assumptions, and precision of each threshold.
A sampled grid establishes only its sampled results, not the absence of changes
between samples.

When uncertain inputs interact, examine meaningful joint cases or conditional
boundaries. Preserve known dependencies; do not combine incompatible extremes.
Distinguish a recommendation that survives the examined range from one that
needs a narrower estimate. If a boundary lies inside an uncertain range, name
the measurement or preference that would resolve the choice. Do not claim
robustness beyond the cases or domain actually examined.

**Ready when:** the result explains which inputs change the choice, which limits
cause that change, and where the evidence leaves it unresolved.

## Verify the calculation and its fitness separately

Run or recalculate the actual artifact with the baseline and at least one
meaningful changed-input case. Confirm that the reported values come from that
artifact. Check a material result by a separate simple calculation or known
case. Check applicable edge cases, especially constraint equality, whole-unit
steps, zero demand, and either side of a reported transition. Use the few checks
that reach the claims; do not create a separate test framework for the analysis.
For a spreadsheet, inspect formulas and recalculated values, not just cached
cell displays. Do not execute unfamiliar macros or external data refreshes merely
to inspect a workbook.

Then check model fitness: does the model represent this decision, its important
constraints, and the meaning of its inputs? Reconcile the answer with known
facts and material exclusions. Successful execution establishes calculation
behavior for the checked cases, not the truth of assumptions or the adequacy of
the model. State unverified source inputs and omitted effects that could change
the recommendation. Match numerical precision to the input evidence.

**Ready when:** the calculation checks and the decision-relevance checks have
separate, stated results, and remaining limits qualify the affected conclusion.

## Deliver a result that supports follow-ups

Lead with the recommendation and its conditions, or the exact unresolved
tradeoff. Keep the report short enough to use. Include:

- the compared outcomes, horizon, and feasibility reasons;
- the assumptions and input boundaries that determine the choice;
- the artifact path or workbook location, its baseline inputs, and the command
  or steps that reproduce the result;
- the calculation checks, material fitness limits, and a natural follow-up
  example using named inputs from this model.

Keep sufficient inputs, formulas, and provenance with the artifact for another
session to reopen it without reconstructing the analysis from chat. Follow the
current workspace's artifact rules; do not add a permanent model registry.

For a follow-up, reopen the identified artifact, inspect its current inputs and
logic, apply the requested changes, and recalculate through the same model.
State the changed assumptions and their effect. If the request changes the
model's structure, revise that structure explicitly and recheck affected results.
Do not reuse a threshold after its governing assumptions change. If the artifact
is unavailable, identify the missing source rather than pretend to reuse it.
