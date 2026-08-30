# Pi extension lane

Use this lane when the selected surface is a Pi extension or an extension-owned tool, command, provider, event hook, lifecycle behavior, TUI surface, resource-discovery hook, or package integration boundary.

## Boundaries

- Treat the operator's selected outcome, artifact, destination, and architecture as fixed.
- Use supported extension, package, SDK, RPC, and TUI surfaces. Do not patch the installed Pi package to make an extension work.
- Follow clean-room and provenance rules. Earlier artifacts can establish needs and failures but do not supply source, prose, tests, prompts, names, or identifiers when the repository forbids transfer.
- Keep extensions independently loadable and testable. Put cross-resource contracts in a supported host surface or an explicit package-level mediation layer.
- Keep module imports passive. Give every timer, request, process, listener, and store an owner. Propagate cancellation and make cleanup repeatable.
- Treat TUI, RPC, print, JSON, and no-UI modes as presentations of one semantic capability.
- Build the smallest coherent end-to-end capability, including required lifecycle, delivery, absence, and failure behavior.

## Select the lane

### Fixed repair

Use this lane when behavior and architecture are fixed and existing tests or a concrete failure define the boundary.

1. Read the target source, focused tests, package metadata, and required operator documentation.
2. Extract the fixed behavior and the failing boundary.
3. Implement the complete requested behavior before a broad source tour.
4. Run the smallest affected check required for a reviewable result.
5. Ground only the remaining version-sensitive claims that control correctness.
6. Adjust when current Pi evidence contradicts the implementation.
7. Update required documentation and run closure checks under repository sequencing rules.

Do not reopen passing code for optional research or provenance enrichment.

**Complete when:** the fixed contract works at the affected boundary and every material Pi claim has a current source or named gap.

### New build or open design

Use this lane for a new extension, open architecture, substantial redesign, package boundary, or broad hardening effort.

1. **Reconstruct the extension contract.** Name registration, invocation, lifecycle, state, cancellation, modes, delivery, and safety constraints.
2. **Research open choices.** Read [extension-research.md](extension-research.md) when architecture remains open. Inspect current public Pi examples and relevant non-Pi implementations without displacing fixed operator intent.
3. **Ground Pi questions.** Identify the active Pi package and version. Read [pi-grounding.md](pi-grounding.md) for load-bearing API, lifecycle, mode, discovery, package, SDK/RPC, or TUI claims.
4. **Design the complete capability.** Read the implicated sections of [extension-engineering.md](extension-engineering.md). Trace registration, state ownership, cancellation, errors, presentations, discovery, upgrades, tests, and documentation.
5. **Implement one reviewable slice.** Keep pure logic separate from Pi adapters where useful. Run a focused check after the complete behavior exists.
6. **Verify by claim.** Use [verification.md](verification.md). Escalate to discovery, SDK/RPC, shutdown, PTY, or live checks only when those layers own the claim.

**Complete when:** one coherent capability reaches the requested outcome and each release-blocking claim has an evidence layer.

## Extension-owned surface rules

### Tools and commands

A custom tool or command requires an extension host. Define who invokes it, parameter and output contracts, cancellation, rendering, failure behavior, and non-interactive behavior. Keep tool output bounded and treat protocol output channels as reserved.

### Providers

Ground model catalog, authentication, streaming, error mapping, cancellation, usage accounting, and refresh behavior against current provider documentation and active Pi source. A configuration entry alone does not implement a custom API.

### Lifecycle and state

Specify startup, reload, repeated registration, session changes, shutdown, and partial failure. Persist only state that must survive the relevant lifecycle. Reconstruct session-derived state from authoritative entries rather than hidden globals.

### TUI and headless modes

Keep semantic behavior independent of presentation. Verify renderer logic with focused tests, then use live or PTY evidence for terminal focus, resize, keys, and compositing claims. Define useful RPC, print, or no-UI behavior when those modes are in scope.

### Packages and discovery

Treat checkout loading, archive contents, installed discovery, package filtering, and upgrades as separate claims. Runtime dependencies belong in package dependencies; Pi-supplied core packages belong in peers under the current package contract.

## Causal discipline

Keep these links separate:

- the need exists;
- the implementation expresses the intended behavior;
- the package delivers and discovers it;
- users or agents invoke it under known conditions;
- the desired outcome occurs; and
- the benefit exceeds its operating and context cost.

A passing component test proves only its tested layer. Use or invocation count does not prove utility. A sparse trial does not prove absence of need.

## Audit and removal lanes

For usage, utility, retention, or incident disposition, including whether an extension should be removed, read [extension-audit.md](extension-audit.md). Add engineering sources only for causal claims that require code or API conclusions.

After the operator settles removal, read [removal.md](removal.md) and execute the exact managed-extension procedure.

## Closure record

Report the current outcome, files changed, fixed decisions, active Pi version, load-bearing repository-relative sources, checks and their evidence reach, unperformed live layers, blockers, and the next action. Omit credentials, personal identifiers, private incident detail, and unrelated absolute paths.
