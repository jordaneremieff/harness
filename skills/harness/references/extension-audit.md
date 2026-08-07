# Causal extension audit

Use this reference when deciding whether to repair, retain, reposition,
instrument, supersede, or remove an extension or harness integration.

## Trace six links separately

For each link, write **established**, **not established**, and **causal
alternative**. Cite each established item to the most precise available
repository-relative artifact, check/trace, release/version, date/window, or
anonymized observation record.

1. **Underlying need** — What task, friction, or desired capability exists
   independently of this implementation? Who observed it, under what scope?
2. **Implementation capability and quality** — What does source, testing, and
   controlled execution establish about correctness, usability, completeness,
   reliability, and mode support?
3. **Delivery and discoverability** — Did the intended package actually ship
   and load? Could operators and agents find, understand, invoke, and recover
   from the capability?
4. **Use under available conditions** — What was invoked, in which release,
   mode, exposure state, population, and time window? Are events linked to
   eligible opportunities or only aggregate counts?
5. **Outcomes** — Is there evidence connecting exposure and successful use to
   the intended later result? What comparisons or operator judgments exist?
6. **Costs and risks** — What is measured about context, latency, maintenance,
   failures, security, upgrade burden, and interference? Do not use line count
   or recent fixes as an unlabelled proxy for all cost.

A useful chain is:

> need → capable implementation → delivered/discoverable access → use under an
> available mode → successful intermediate result → intended outcome

A break upstream makes downstream non-use ambiguous. Low invocation of a
missing, obscure, or mode-incompatible capability describes that implementation
under those conditions; it does not establish absent need. Likewise, a single
successful use does not establish prevalence or outcome value.

## Choose one disposition

Recommend one primary action, not an unranked menu:

- **retain unchanged** when the relevant chain and proportional costs are
  sufficiently supported;
- **repair** when need has support and a bounded implementation/delivery break
  is demonstrated;
- **reposition** when capability exists but naming, workflow placement, or mode
  fit blocks access;
- **instrument or run a named follow-up** when one small observation can decide
  between live causal alternatives;
- **supersede/remove** when the need is satisfied elsewhere, the relevant need
  lacks support after fair exposure, harm/cost dominates, or repair is not
  proportionate.

State why the recommendation is proportionate. Name the smallest evidence that
could reverse it, the setup needed to collect that evidence, and the reversal
condition. Do not build telemetry or infrastructure before identifying the
specific unresolved link it must distinguish. Any proposed collection must be
operator/repository-approved and define purpose, minimum fields, anonymization,
access, retention, and deletion before collection.

## Evidence hygiene

- Keep aggregate ratios attached to their denominator, release, exposure, mode,
  and window; do not reify them into a property of the extension or need.
- Distinguish reports, source state, tests, package state, runtime traces, and
  outcomes.
- Do not invent consent, telemetry, identities, installation checks, or task
  results absent from the record.
- Use synthetic fixtures for evaluation. Data-minimize repository audits and
  handoffs as well as shipped artifacts: omit credentials and private incident
  detail, anonymize people, and retain no identifier not needed by the decision.
- Preserve useful mechanisms and demonstrated jobs when replacing an
  implementation; do not carry architecture forward merely because it exists.

Finish with the direct disposition, bounded next action, evidence limits, and
what observation would change the decision.
