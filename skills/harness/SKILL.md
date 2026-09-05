---
name: harness
description: >
  Use when adding, changing, removing, testing, packaging, or evaluating any
  surface of the Pi agent harness — Agent Skill, extension-owned tool or
  command, provider, lifecycle hook, TUI, prompt template, theme, package,
  SDK/RPC integration, standalone CLI — when a requested capability needs
  classification among them, or when changing harness rules and shared
  contracts. Also use when a request opens harness inspection or improvement
  without naming the change, or when harness work is delegated across workers
  or sessions. New enumerated surfaces require a proposal and explicit operator
  approval before any write; reclassifying them as part of the requested
  outcome does not exempt them. Do not use for invoking or installing an unchanged
  resource, ordinary application code, unrelated uses of "tool", "skill", or
  "extension", or Pi core development.
compatibility: Pi-specific workflow. The bundled skill validator is dependency-free Node.js and supports Node.js 18 or newer; verify Pi-sensitive behavior against the active Pi installation.
---

# Harness

Select, design, change, and verify Pi harness surfaces through one entry point. The requested capability is the subject; skills, extensions, prompts, packages, and external integration modes are implementation lanes selected after the outcome is understood.

## Core contract

- Preserve the operator's fixed outcome, artifact, destination, and explicit architecture. Research only genuinely open choices.
- Read [collaborative-work.md](references/collaborative-work.md) when the request opens inspection or improvement without naming the change, or when work spans workers or sessions. Use it to select the source scope and work method, not to require delegation.
- Classify the capability before drafting when the implementation surface is open. A user word such as “tool,” “command,” or “plugin” does not settle the Pi building block.
- Use the lowest sufficient surface, but build a coherent end-to-end capability rather than minimizing line count.
- Treat current Pi documentation, declarations, installed source, and shipped examples as the authority for version-sensitive claims.
- Follow the owning repository's provenance, privacy, worktree, testing, and release rules.
- Keep common decisions here and lane-specific detail in one-level references. Read only the references that the selected lane requires.
- **New surfaces require a proposal and explicit operator approval before any write.** The enumeration below decides what counts — not the agent's framing of the request. Reclassifying an addition as "part of the requested outcome," "the sharing mechanism," or "just making it work" does not exempt it.

## New surfaces require approval

A change adds a **new surface** when it introduces any of the following that do not already exist in the repository:

1. A new top-level directory (other than ignored tooling such as `node_modules` / `.git`).
2. A new extension slice directory under `extensions/`.
3. A new skill directory under `skills/`.
4. A new prompt template file under `prompts/`.
5. A new theme file under `themes/`.
6. A new application directory under `config/`.
7. A new non-test script under `scripts/`.
8. A new `package.json` `scripts` entry.
9. A new key under `package.json` `pi` (for example `pi.prompts`).

Edits, tests, docs, and refactors **inside** an already-registered surface are ordinary work. They still need surface classification and proportionate verification, but they do not need a new-surface proposal.

### Hard stop before implementation

When the intended change adds a new surface:

1. **Stop.** Do not create the directory, file, or package field.
2. **Propose in chat:** name each new surface against the enumeration; state the warrant (step 3); name the nearest existing surface and why it cannot absorb the change; state the lowest sufficient layer; list out-of-scope items you will not add.
3. **Wait for explicit operator approval** of that proposal. An operator request that already names the surface supplies the approval; do not ask again. When the agent chooses a new surface as the means to an operator outcome, the operator must approve the surface itself, not only the outcome. Gate-clearing analysis is not permission to ship. Self-approval is a violation.
4. **Implement only the approved scope.**

If an unapproved new surface is already present in the tree when you notice it, stop, report what is present, and hold for operator disposition. Do not silently keep expanding it or silently revert concurrent work you did not author.


## No backward compatibility

This harness is built and operated by one party with no external consumers, so every surface implements only the current contract. Do not carry predecessor behavior: no compatibility shims, schema migrations, dual read/write paths, deprecated field aliases, legacy-record normalizers, or fallback readers for retired shapes. Delete superseded machinery across code, tests, current docs, prompts, and review checklists rather than renaming "legacy" while keeping the mechanism.

Contracts that remain valid are current, not historical:

- Honor the current Pi API and version-declared behavior, and the current public contracts a surface ships.
- Data the harness produced under an older shape has no standing guarantee of readability. If a change breaks existing artifacts, the operator decides at that point whether to migrate, discard, or leave them unreadable.
- Tolerant validation of malformed current data is corruption containment, not predecessor-schema support; keep it without interpreting retired field names or reconstructing old behavior.
- Historical design records may describe superseded systems as history; they do not authorize compatibility code.

A genuine one-time migration requires explicit operator direction from concrete data and consequence. Do not infer one from files merely existing on disk.

## Operator-facing diagrams

Use Pi's native Mermaid rendering without an operator prompt when relationships are easier to understand visually: component or call flow, lifecycle sequence, state transition, ownership boundary, or before/after structure. Emit a compact top-level Mermaid block and pair it with the short conclusion it supports. Use the installed renderer's flowchart, sequence, state, class, or ER forms. Prefer top-to-bottom layouts and short labels so Pi renders within terminal width; simplify or split a diagram before it falls back to source.

Do not paste a long tool transcript into chat. When a tool returns a purpose-built structural view, preserve its native shape and trim it to the load-bearing region; do not flatten it into a table or redraw it in Mermaid. Otherwise, preserve the raw result in the tool record and translate only the load-bearing structure. Use prose or a table when sequence or relationships are not the point. A diagram explains evidence; it does not replace source, tests, traces, or the verification ledger.

## TypeScript call-graph checks

When a harness change touches TypeScript, run calldiff against the change's base ref. Use it early to read the call graph you are changing, and again before you report to confirm what moved; a no-change result confirms the call structure held. Read [calldiff.md](references/calldiff.md) for invocation, how to read the output, and its limits, then record the result as structural evidence in the verification ledger.

calldiff is syntactic, not a typechecker: it proves call shape, not runtime behavior. Pair it with a focused test for any behavior claim.

## Workflow

### 1. Reconstruct the contract

Derive the requested outcome, acceptance, and granted permissions from the request and established sources. Separate operator directions and binding rules from agent interpretations, including inherited plans. Record only the fixed decisions, open choices, target, and release constraints that affect execution. A handover preserves evidence and decisions; its proposed design is not an operator decision unless its source establishes that authority.

Use the Pillars consultation procedure for corrections: Corrected-Assumption Leakage governs a corrected factual premise; Frame Abandonment governs a rejected interpretation. Carry the resulting changes into affected work rather than asking the operator to specify the outcome again.

**Complete when:** named sources support the outcome and permissions, interpretations remain revisable, and no open question asks the operator to repeat a settled decision.

### 2. Select the surface

Read [surface-selection.md](references/surface-selection.md) when the artifact type is open, ambiguous, cross-resource, or disputed. Name both the primary capability surface and any separate distribution surface. Do not flatten extension-owned tools, commands, providers, events, and UI into peers of extensions.

**Complete when:** the selected surface follows from the outcome and current Pi contracts, not from the first noun in the request.

### 3. Establish the warrant when required

A suggestion is not a surface. Naming a useful tool, skill, or integration in chat is always free — no warrant, no approval.

Warrant and approval are separate. The warrant is the content of a proposal; it does not grant write authority. New-surface approval is governed by the approval section above.

#### Evidence warrant

Correct capability classification decides which case applies; authority exemptions remain separate. Choose one case.

- **Correctly classified agent-proposed skill.** A usefulness rationale — the capability it provides and why it is worth having — is sufficient. No observed failure, measured omission, structural evidence, or binding requirement is needed.
- **Any other agent-proposed new persistent surface, recurring mechanism, guard, high-frequency context producer, or shared service.** A grounded basis is required: an observed failure with meaningful cost; a reproducible local omission or measured opportunity; direct structural evidence of a missing capability or inaccessible information; or a binding security, privacy, current-host compatibility, or platform requirement.

#### Caliber for repeated or hard-to-remove mechanisms

Applies in addition to whichever evidence case governs, for any agent-proposed mechanism paid repeatedly or hard to remove, regardless of the surface it is implemented through. A recurring skill carries both the skill evidence case and this overlay.

The proposal also carries the caliber fields: estimate its normal fire rate and operating or context cost, state the observable behavior it changes, name an owner and evaluation point, define removal conditions, and explain why the expected cost is proportionate and how the intervention is bounded or reversible.

Every required warrant states its capability, the nearest existing surface and why it cannot absorb the change, and the lowest sufficient layer. Caliber facts inform the operator when approval is required and guide proportional design in all cases; they do not recreate an evidence prerequisite or create a separate approval gate. Caliber alone is not an independent refusal gate. The agent recommends the lowest-cost coherent design.

Classification cannot be changed to obtain the skill rule. A capability that requires scheduling, event interception, or deterministic enforcement is not a skill and takes the non-skill rule regardless of what it is called.

No warrant is needed for a fixed repair, an operator-selected outcome or architecture, ordinary maintenance, a removal, or a documentation/test correction that preserves an established contract; those still require surface classification and proportionate verification.

*Rationale (auditability, not operative):* the skill rule is a bounded, operator-approved exception to the general rule that new infrastructure is grounded in an observed failure, measured omission, or binding requirement (the Harness Over Architecture pillar). The exception is evidentiary only; the retained requirements above implement the pillar's nearest-surface, reversibility, and skill-sprawl guidance, against which the exception remains auditable.

**Complete when** (warrant classification/content only; approval is gated by the approval section, not retested here):
- no suggestion was mistaken for a surface;
- no agent-proposed skill was withheld for lack of an incident, measured omission, structural evidence, or binding requirement;
- every warrant-required non-skill surface or mechanism carries a grounded basis;
- every agent-proposed mechanism paid repeatedly or hard to remove carries the caliber fields;
- every required warrant states its capability, nearest existing surface, and lowest sufficient layer.

### 4. Load one implementation lane

- **Agent Skill:** read [the Agent Skill lane](references/skills.md). For a new skill or substantial redesign, also read [skill-research.md](references/skill-research.md), [skill-design.md](references/skill-design.md), and [skill-evaluation.md](references/skill-evaluation.md) only as their gates require.
- **Extension or extension-owned surface:** read [extensions.md](references/extensions.md). Pull [extension-engineering.md](references/extension-engineering.md), [pi-grounding.md](references/pi-grounding.md), and [extension-research.md](references/extension-research.md) only for the implicated design questions.
- **Prompt template, theme, package, settings, SDK/RPC/JSON integration, or standalone CLI:** use [surface selection](references/surface-selection.md), then read the current installed Pi document for the selected surface. Use [extensions.md](references/extensions.md) when extension code or an extension boundary participates.
- **Managed extension removal after the disposition is settled:** read [removal.md](references/removal.md).
- **Usage, utility, retention, removal, or incident disposition for an extension:** read [extension-audit.md](references/extension-audit.md).

**Complete when:** every loaded reference serves a live decision or verification claim.

### 5. Implement at the selected boundary

Use the selected lane's procedure. Change only owned files. Keep temporary probes and evaluation artifacts outside tracked repository paths. Preserve supported public contracts and make lifecycle, cancellation, state, absence, failure, and delivery behavior explicit where they apply.

Choose local work or collaboration according to the task's dependencies and uncertainty. Use [collaborative-work.md](references/collaborative-work.md) for work across workers or sessions. Assign integration and acceptance explicitly when work is split; a fixed worker topology is not a prerequisite for delivery.

**Complete when:** one reviewable capability reaches the requested outcome without unrelated governance layers or compatibility machinery.

### 6. Verify by claim

Read [verification.md](references/verification.md) before completion. Build a compact claim ledger as working state: each consequential claim, the lowest evidence layer that reaches it, the check run, the result, and any material unperformed stronger check. Do not reproduce the ledger in the completion response by default. Use it to form a bounded conclusion and select only evidence that helps the operator assess that conclusion. Skill activation and output quality require behavior evidence; extension discovery and live UI require their own layers.

Follow repository sequencing rules for manual review and broad suites. Do not substitute many cheap checks for the one layer that owns the claim.

**Complete when:** each release-blocking claim is established, explicitly preliminary, or blocked by one named next check.

### 7. Apply authority once

Confirm execution stays within granted authority and does not transfer a settled decision back to the operator. Treat new surfaces, destructive state changes, publication, and credential use under their separate authority rules; those boundaries hold regardless of how the intent was derived.

Stop only the actions that depend on a disputed fact or on authority you were not granted. Name that exact boundary and complete the rest of the authorized work.

**Complete when:** execution neither exceeds granted authority nor transfers a settled decision back to the operator.

## Closure

Lead with the resulting operator-visible state and its consequence. Name the selected surface and load-bearing files when they help the operator locate or review the result. Explain a change or relationship only when it helps the operator use, review, or decide about the result. Summarize the evidence that supports the conclusion; do not dump the claim ledger or a check transcript.

Report any discovery that changes the operator's available choices: evidence against the request's premise, a cheaper or safer route, an unanticipated cost, or an authority the next step will need. Report a limitation only when it blocks the requested conclusion, materially reduces confidence in it, or requires operator action. State the affected conclusion, the impact, and the narrowest next check or action. Omit irrelevant unperformed layers and optional stronger checks that would not change the conclusion. A binding repository completion or release gate remains material until satisfied or explicitly waived. Follow the owning repository's state-report requirements; otherwise, report repository state when it changes how the operator must handle the result.

Keep durable documentation about the current system; keep task chronology, transcripts, evaluation output, and private provenance outside the package.
