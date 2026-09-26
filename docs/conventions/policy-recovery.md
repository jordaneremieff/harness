# Policy recovery seeds for registered tool contracts

Some bundled policy seeds reference tools that other extensions register. This
document is the package-level contract for those references. It sits outside
both extensions: the policy extension owns the seeds, and the tool-owning
extension owns its own schema, execution, and results. Neither slice imports
the other or depends on this document's implementation details.

## Seed data selects public evidence only

A seed rule that references a registered tool uses only its public contract:

- the registered physical tool name, as Pi's public tool catalog reports it;
- the tool's public argument names, as its registered schema declares them;
- public completion facts Pi already exposes: the outcome classification and
  the final argument object;
- public availability facts from Pi's tool catalog
  (`context.tools.<name>.active`, `.configured`, `context.catalogAvailable`).

Seeds import nothing from another extension, read no sibling store, decode no
sibling-formatted output, and contain no sibling-private markers or
identifiers. A seed that names a tool keeps working when that tool is absent:
the public catalog reports availability, and the rule projects nothing while
evidence is unknown.

## Tool guard responsibilities

Each side owns its own layer:

- The tool-owning extension validates its schema, executes its tool, and owns
  its result text and errors. These recovery seeds never repair, reclassify,
  or re-run another extension's tool results, and never claim that
  extension's authority. (Approved result-correction rules remain an ordinary
  policy capability; this seed family simply uses none.)
- `arguments.schema` and `recovery.repeated-errors` remain the mechanical
  guards: schema-invalid final arguments and consecutive execution failures.
  The application-recovery seed adds no denial, correction, or tool invocation.

## Source-versus-draft evidence

The pillars seed reads three public evidence facts that policy derives from
Pi's public completion events for each completed pillars call:

- A successful call whose `resource` argument is present, is not `inventory`
  or `governance`, and carries no `draft` records a draftless source read.
- A successful call with a `draft` present resets the observation period,
  regardless of `resource`. A failed or unexecuted call neither observes nor
  resets.
- Inventory and governance reads, default calls without a `resource`, and
  calls from other tools never enter the period.

The guidance text is deliberately conditional. An absent draft does not prove
a missed application, a draft submission does not prove application quality,
and a source read does not prove the entries governed the work.

## Bounds and lifecycle

The seed is a context-phase rule, so its condition evaluates the completed
observations at the next context projection. No batch-order promise is made:

- Guidance projects at most once per observation period and only when the
  pillars tool is active in the public catalog at projection time.
- A successful draft before projection clears the prompt; reversed completion
  order inside one batch can leave a draftless read outstanding after a draft
  reset. The conditional text covers that case; the seed claims no
  batch-order certainty and detects no semantic error.
- Periods expire naturally after the package period and reset on session
  lifecycle events, disablement, replacement, and explicit operator reset.
- Observe and notice modes project no model guidance; annotate and enforce
  do. No path forces another model turn.

## No consultation or correctness guarantee

The seed observes completed calls only. It cannot detect a consultation that
never happened, cannot assess whether an applied assessment is correct, and
cannot stop a model from ignoring projected guidance. It is recovery
guidance, not enforcement of doctrine compliance.

## Catalog and approval boundary

The seed enters only a missing registry's initial publication, like every
bundled definition. An existing store never receives it automatically, even
when the store is intentionally empty. Updates travel through the exact
operator import or an approved proposal, and the operator can replace,
disable, retire, or reset the rule like any seeded rule. See the
[policy README](../../extensions/policy/README.md) for the complete controls.

## Evaluation fixture

The policy product suite's synthetic pillars tool mirrors the public argument
shape (`resource`, optional `draft`) and serves the repository's actual corpus
text for its listed resources. It imports no sibling module and labels nothing
invented as corpus doctrine. Deterministic tests drive production hooks for
the lifecycle bounds above; model-backed runs remain a separately approved,
human-adjudicated concern.
