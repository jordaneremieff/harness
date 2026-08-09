---
name: harness
description: >
  Use when adding, changing, removing, testing, packaging, or evaluating any surface of the Pi agent harness; when a requested capability needs classification among an Agent Skill, extension-owned tool or command, provider, lifecycle hook, TUI, prompt template, theme, package, SDK/RPC integration, or standalone CLI; or when changing harness rules and shared contracts. Select the lowest sufficient surface, preserve fixed operator intent, load only the matching reference, and verify claims at the layer that owns them. Do not use for invoking or installing an unchanged resource, ordinary application code, unrelated uses of "tool", "skill", or "extension", or Pi core development.
compatibility: Pi-specific workflow. The bundled skill validator is dependency-free Node.js and supports Node.js 18 or newer; verify Pi-sensitive behavior against the active Pi installation.
---

# Harness

Select, design, change, and verify Pi harness surfaces through one entry point. The requested capability is the subject; skills, extensions, prompts, packages, and external integration modes are implementation lanes selected after the outcome is understood.

## Core contract

- Preserve the operator's fixed outcome, artifact, destination, and explicit architecture. Research only genuinely open choices.
- Classify the capability before drafting when the implementation surface is open. A user word such as “tool,” “command,” or “plugin” does not settle the Pi building block.
- Use the lowest sufficient surface, but build a coherent end-to-end capability rather than minimizing line count.
- Treat current Pi documentation, declarations, installed source, and shipped examples as the authority for version-sensitive claims.
- Follow the owning repository's provenance, privacy, worktree, testing, and release rules.
- Keep common decisions here and lane-specific detail in one-level references. Read only the references that the selected lane requires.

## Operator-facing diagrams

Use Pi's native Mermaid rendering without an operator prompt when relationships are easier to understand visually: component or call flow, lifecycle sequence, state transition, ownership boundary, or before/after structure. Emit a compact top-level Mermaid block and pair it with the short conclusion it supports. Use the installed renderer's flowchart, sequence, state, class, or ER forms. Prefer top-to-bottom layouts and short labels so Pi renders within terminal width; simplify or split a diagram before it falls back to source.

Do not paste a long tool transcript into chat. When a tool returns a purpose-built structural view, preserve its native shape and trim it to the load-bearing region; do not flatten it into a table or redraw it in Mermaid. Otherwise, preserve the raw result in the tool record and translate only the load-bearing structure. Use prose or a table when sequence or relationships are not the point. A diagram explains evidence; it does not replace source, tests, traces, or the verification ledger.

## TypeScript call-graph checks

When a harness change touches TypeScript, run calldiff against the change's base ref. Use it early to read the call graph you are changing, and again before you report to confirm what moved; a no-change result confirms the call structure held. Read [calldiff.md](references/calldiff.md) for invocation, how to read the output, and its limits, then record the result as structural evidence in the verification ledger.

calldiff is syntactic, not a typechecker: it proves call shape, not runtime behavior. Pair it with a focused test for any behavior claim.

## Workflow

### 1. Reconstruct the contract

Record the requested outcome, fixed decisions, open choices, target repository, affected users, destination modes, and release constraints. Carry operator corrections into the full working model instead of patching one sentence.

**Complete when:** no later research can silently replace a fixed operator choice.

### 2. Select the surface

Read [surface-selection.md](references/surface-selection.md) when the artifact type is open, ambiguous, cross-resource, or disputed. Name both the primary capability surface and any separate distribution surface. Do not flatten extension-owned tools, commands, providers, events, and UI into peers of extensions.

**Complete when:** the selected surface follows from the outcome and current Pi contracts, not from the first noun in the request.

### 3. Establish the warrant when required

Apply this warrant to an agent-proposed new persistent surface, recurring mechanism, guard, or high-frequency context producer. Establish at least one admissible basis:

- an observed failure with meaningful cost;
- a reproducible local omission or measured opportunity;
- direct structural evidence of a missing capability or inaccessible information; or
- a binding security, privacy, compatibility, or platform requirement.

Then identify the nearest existing surface, explain why it cannot absorb the change, and state the lowest sufficient layer. For a recurring mechanism, estimate its normal fire rate and operating or context cost, state the observable behavior it changes, name an owner and evaluation point, and define removal conditions.

Do not require this warrant for a fixed repair, an operator-selected outcome or architecture, ordinary maintenance, a removal, or a documentation/test correction that preserves an established contract. Those changes still require surface classification and proportionate verification.

**Complete when:** discretionary infrastructure has independent evidence and an exit, or the task has a named reason the warrant does not apply.

### 4. Load one implementation lane

- **Agent Skill:** read [skills.md](references/skills.md). For a new skill or substantial redesign, also read [skill-research.md](references/skill-research.md), [skill-design.md](references/skill-design.md), and [skill-evaluation.md](references/skill-evaluation.md) only as their gates require.
- **Extension or extension-owned surface:** read [extensions.md](references/extensions.md). Pull [extension-engineering.md](references/extension-engineering.md), [pi-grounding.md](references/pi-grounding.md), and [extension-research.md](references/extension-research.md) only for the implicated design questions.
- **Prompt template, theme, package, settings, SDK/RPC/JSON integration, or standalone CLI:** use [surface-selection.md](references/surface-selection.md), then read the current installed Pi document for the selected surface. Use [extensions.md](references/extensions.md) when extension code or an extension boundary participates.
- **Usage, utility, retention, removal, or incident decision for an extension:** read [extension-audit.md](references/extension-audit.md).

**Complete when:** every loaded reference serves a live decision or verification claim.

### 5. Implement at the selected boundary

Use the selected lane's procedure. Change only owned files. Keep temporary probes and evaluation artifacts outside tracked repository paths. Preserve supported public contracts and make lifecycle, cancellation, state, absence, failure, and delivery behavior explicit where they apply.

**Complete when:** one reviewable capability reaches the requested outcome without unrelated governance or compatibility layers.

### 6. Verify by claim

Read [verification.md](references/verification.md) before completion. Build a compact claim ledger as working state: each consequential claim, the lowest evidence layer that reaches it, the check run, the result, and any material unperformed stronger check. Do not reproduce the ledger in the completion response by default. Use it to form a bounded conclusion and select only evidence that helps the operator assess that conclusion. Skill activation and output quality require behavior evidence; extension discovery and live UI require their own layers.

Follow repository sequencing rules for manual review and broad suites. Do not substitute many cheap checks for the one layer that owns the claim.

**Complete when:** each release-blocking claim is established, explicitly preliminary, or blocked by one named next check.

### 7. Apply authority once

An explicit operator request authorizes work inside its stated scope. Do not ask again for approval already supplied. Obtain explicit approval before placing an agent-proposed new shared or global surface when the operator has not selected that outcome or destination. Treat destructive state changes, publication, and credential use under their separate authority rules.

**Complete when:** execution neither exceeds authority nor transfers an already-settled decision back to the operator.

## Closure

Lead with the resulting operator-visible state and its consequence. Name the selected surface and load-bearing files when they help the operator locate or review the result. Explain a change or relationship only when it helps the operator use, review, or decide about the result. Summarize the evidence that supports the conclusion; do not dump the claim ledger or a check transcript.

Report a limitation only when it blocks the requested conclusion, materially reduces confidence in it, or requires operator action. State the affected conclusion, the impact, and the narrowest next check or action. Omit irrelevant unperformed layers and optional stronger checks that would not change the conclusion. A binding repository completion or release gate remains material until satisfied or explicitly waived. Follow the owning repository's state-report requirements; otherwise, report repository state when it changes how the operator must handle the result.

Keep durable documentation about the current system; keep task chronology, transcripts, evaluation output, and private provenance outside the package.
