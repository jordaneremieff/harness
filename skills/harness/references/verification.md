# Verification by claim

Use this reference before completion or when deciding what evidence to obtain,
keep, repeat, repair or remove. Verification receives its scope and lifetime from
the useful evidence or meaningful protection it supplies, against total lifecycle
cost. Binding repository and operator requirements remain binding until authorised
change; this reference does not waive them.

## Use the evidence already available

Use existing context, source reads and tool results. Check what each consequential
claim actually concerns and what the evidence directly establishes. Add a concise
summary when complex claims, a dispute or a handoff needs it: claim, evidence and
setup, result, applicability, material gap. No compulsory ledger, per-test record
or new evidence service is required. Keep failures visible and distinct.

## Evidence reach

| Claim | Evidence that reaches it | Common overclaim |
|---|---|---|
| Pure storage/transformation works | Applicable focused cases at that boundary | Unit results establish a live surface |
| Skill structure is portable | Structural validation and resolved resource links | Valid frontmatter proves activation |
| Skill discovery works | Discovery from the intended source | The file exists, so Pi loaded it |
| Skill activation is selective | Selected realistic positive and near-miss cases; deliberate sampling where consequential variation matters | One prompt establishes general reliability |
| Skill output improves a task | Meaningful comparison for the claimed benefit, using applicable existing evidence or selected new runs | The skill was read, so it helped |
| Prompt or theme data is valid | Format checks and discovery/readback as required by the claim | A file proves host acceptance |
| Registration matches a public contract | Current defining docs/declarations and compile or load evidence for the claimed facet | A declaration proves live registration |
| Event ordering, cancellation or cleanup works | Applicable source and execution evidence at the relevant lifecycle boundary | A mock proves real shutdown |
| Renderer logic works | Applicable component evidence | A snapshot proves terminal focus or input |
| Interactive UI works | Relevant live or PTY interaction | A unit pass proves resize and compositing |
| RPC/headless works | Relevant protocol/output observation | No thrown error proves useful output |
| Required files ship | Archive inspection | The installed copy is discovered |
| Installed discovery works | Isolated installed discovery without checkout override | Manifest text proves loading |
| Runtime outcome occurred | Direct observation tied to setup and identifiers | Source or invocation count proves the outcome |
| Capability is useful | Outcome evidence under known conditions and operator judgment | Test count or usage proves utility |

These rows identify evidence layers, not universal new-run or paired-check
requirements. Existing applicable results can satisfy them. Read
[skill-evaluation.md](skill-evaluation.md) for evaluation selection.

## Select creation, execution and retention separately

1. Identify the changed or repaired contract, material uncertainty and consequence
   of a miss. Inspect existing checks and defining sources first.
2. Select a check whose possible results change the decision. Use a disposable
   reproduction for present investigation when that is enough. Do not automatically
   create tests for every changed logic function or adapter.
3. Add or retain permanent protection when its future value warrants creation,
   execution, maintenance, fixtures, mocks and coupling. Preserve valuable coverage;
   consolidate duplicate protection and remove obsolete scaffolding. No per-test
   cost calculation or written justification is required.
4. Before reuse, check the candidate and relevant dependencies, configuration,
   setup, environment, instrumentation and variable conditions. Recheck evidence
   invalidated by the change and interactions not previously covered. A new agent,
   commit or milestone alone is not invalidation. Identical source alone does not
   prove unchanged execution conditions.
5. For consequential nondeterminism, deliberately sample the relevant variation.
   Choose sample depth for the reliability claim and cost of a miss; report limits.
   Do not confuse repeated same-condition samples with independent evidence.
6. Apply the repository's one final-acceptance policy. Stop when sufficient evidence
   reaches the actual claim and further optional inquiry has no material decision
   value. Keep necessary unresolved facts explicit; narrow or block their dependent
   conclusion rather than guess or transfer obtainable work to the operator.

## Assertions, fixtures and mocks are fallible

When a check fails, determine whether the implementation, expected contract,
assertion, fixture, mock or execution setup is wrong. Verify the expected behaviour
against its governing source, not solely the existing test or implementation.
Repair the defective part and verify the repaired contract. Correct, replace,
consolidate or remove mistaken or obsolete verification. If a real contract change
retires protection, preserve protection for contracts that remain valid.

Do not distort correct behaviour to satisfy a mistaken assertion. Do not delete,
skip or weaken a genuine failure merely to obtain a pass. An unresolved genuine
failure remains visible under the repository's finding-disposition rules. A
failure on the unchanged baseline remains subject to the repository's existing
baseline-defect boundary; this reference does not create unrelated repair work.

## Boundary and delivery cases

Select applicable cases by the changed contract and material risk: invalid or
empty input, malformed current records, missing resources, partial startup,
duplicate stop, active cancellation, timeout, failure, no UI, transport, terminal
size, relocation and upgrade under the current contract. This is not a checklist
to run in full. Use controlled promises and appropriate mocks for asynchronous
logic, then reach real boundaries where the claim requires them. Add no retired
shape readers or migrations without authority.

For network, credentials, filesystem or subprocesses, use synthetic data and
isolated roots; bound output and time. Inspect package contents and installed
behaviour when delivery claims require them. Apply the
publication content review in repository-root path `docs/conventions/worktrees.md`,
section "Publication content review", to outgoing material; signature scans alone do not establish semantic hygiene.
Update required documentation in the same change. Keep disposable reproductions
and evaluation outputs outside tracked paths.

## Completion report

State the strongest bounded conclusion that applicable evidence supports. Separate
source inspection, passing tests, archive contents, controlled observation and
operator experience. Give exact results where they affect acceptance or an
operator decision; group routine supporting checks.

Name a missing layer only when it blocks the requested conclusion, materially
limits confidence or scope, or changes the next action. Do not list unrelated
unrun layers or send optional confirmation work to the operator. A required gate
remains material under the repository's completion policy, including its assigned
final owner; it is not an optional stronger check. Keep the required Git-state
report separate from evidence limitations.
