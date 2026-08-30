# evo: autonomous harness evolution and audit command

`evo` registers one invocation-driven command for the Pi harness. It asks the
active agent to inspect available evidence, select the most valuable warranted
harness outcome that fits one pass, complete it with ordinary tools, and report
the result.

The invocation is the intent. The command needs no prior record or populated
store.

## Command

```text
/evo
/evo <hint>
```

`/evo` supports TUI and RPC sessions. It dispatches one pass with no requested
topic. The standing instruction tells the agent to infer its scope from
accessible evidence instead of asking the operator to choose one.

`/evo <hint>` dispatches the same pass. The complete trailing input is one
optional, variable-length exploration hint. The hint can contain a word, a question,
several lines, or pasted source material. No word is a subcommand.

The parser applies two bounds:

- The raw hint is at most 80,000 UTF-8 bytes.
- The sanitized hint is at most 20,000 Unicode code points.

Before the visible bound, the parser replaces malformed UTF-16, removes terminal
controls and hidden formatting, normalizes CR, LF, Unicode NEXT LINE, and Unicode
line separators, and trims the result. It refuses an oversized hint instead of
truncating it. A supported session gets an error notification and dispatches no
turn.

Print and JSON modes report a command error and dispatch no kickoff. Pi's current
void extension API cannot let a single-shot host await the injected turn before
host disposal.

The kickoff encodes the sanitized hint as one JSON string on one line. The
standing instruction classifies the decoded string as data, not authority or a
harness rule. Its encoded newlines cannot add a prompt section.

## Evidence and outcome

The standing instruction directs the agent to use:

- accessible session history, including corrections, failed approaches, tool
  failures, and unresolved findings;
- harness instructions, source, documentation, tests, Git status, and Git
  history;
- relevant durable records that the harness exposes; and
- the optional hint as a search lens, never as proof.

The instruction requires a concrete failure, omission, or binding requirement
before a change. It directs the agent to choose by expected value, recurrence,
reach, and evidence strength. If several findings exist, the agent fixes the
highest-value coherent finding that fits one pass and gives the others the
disposition required by the repository.

The command does not treat audit as the default deliverable. When evidence
supports an authorized feasible change, the instruction requires a completed
local improvement or justified removal. It permits a no-change verdict when the
best candidate lacks a warrant, exceeds one pass, or needs unavailable authority.
That verdict names the strongest rejected candidate and the exact boundary.

The current chat is the result surface. The final response states what changed,
what the evidence establishes, and what remains unproved.

## Authority

Invoking `/evo` authorizes local reads in the harness package root, required
worktree checks, and required local edits in one existing dedicated harness
worktree. The agent must select that worktree under the repository slice rules
before any write. Normal harness instructions still govern every change.

The invocation is not approval for a new surface or any action that requires
separate operator approval. It does not authorize:

- a commit of the selected change or publication;
- resource activation or settings changes;
- credential use;
- an external change; or
- a write outside the selected worktree, except for local repository state
  changed by the required worktree procedure and ephemeral verification output.

The hint never expands authority.

## Runtime behavior

The package root that contains the loaded evo entrypoint is the evidence and
worktree-discovery root. The working directory where the operator invoked
`/evo` is context only. Before a write, the standing instruction requires slice
classification and the selected slice's existing dedicated worktree.

The kickoff identifies these boundaries, but the extension does not enforce tool
paths. The active agent remains responsible for compliance.

The extension sends the kickoff through Pi's `sendUserMessage()` extension
surface with `followUp` delivery in every supported state. Pi starts it
immediately when idle or queues it after active work. This removes an idle-state
snapshot race and never steers the active turn. Prompt-template and command
expansion remain disabled for the injected message.

The active session holds the invocation and its outcome. The extension owns no
store and starts no separate model session.

## Why this is an extension

A prompt template can supply static instructions, but it does not provide this
slice's raw-input sanitization, bounds, evidence-root resolution, mode guard, or
race-safe delivery choice. The command uses an extension only for those
deterministic duties. The active agent still owns discovery, judgment, tools, and
implementation.

## Model portability

Evo uses the active session model. It contains no provider roster, fixed model
name, ranking, or model-selection policy.

## Files

- `index.ts` registers `/evo`, resolves the evidence root, guards host modes, and
  dispatches the kickoff.
- `command.ts` sanitizes and bounds the optional hint.
- `kickoff.ts` owns the standing instruction and JSON hint framing.
- `evo.test.mts` verifies parsing, framing, worktree instructions, mode rejection,
  dispatch options, authority text, and empty-state behavior.
- `evo.runtime.test.mts` verifies Pi command and asynchronous send error paths.

## Verification

Run the focused regression:

```bash
node --test extensions/evo/*.test.mts
```

Run the repository and Pi boundary checks:

```bash
npm run lint
npm run typecheck
npm run check
node scripts/extension-load-check.mts extensions/evo/index.ts
npm test
```

These checks establish deterministic construction, registration, parsing,
framing, mode rejection, dispatch options, and Pi runtime error routing. They do not establish the quality
of an autonomous model outcome. A fresh live session with explicit credential authority must
establish that behavioral claim before promotion.
