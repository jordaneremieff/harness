# Call-graph diffing with calldiff

Use this reference when verifying or reconstructing a TypeScript behavior change
across git refs in a harness change — most often after a refactor that
restructured who-calls-whom. calldiff diffs expanded call trees between two git
trees and prints an ASCII callstack diff.

Treat its output as one row in the [verification](verification.md) claim ledger:
evidence for "what the call graph did and now does," not for runtime behavior.

## What it reaches and what it does not

calldiff is syntactic. It parses TypeScript with oxc-parser, builds per-function
callee lists, expands them into call trees, and diffs the trees. It is not a
typechecker.

It resolves:

- direct calls and `new` expressions to named, in-tree functions and methods;
- conditional arms (`if` / `else`) as labelled branches.

It does not resolve:

- dynamic dispatch, or method calls on a receiver resolved only at runtime;
- calls into `node_modules` or across packages (in-tree analysis only);
- type-level, generic, or signature changes that leave the call graph the same;
- name collisions. Resolution is by name, so a call can bind to a same-named
  function in an unrelated slice and show a subtree that the caller never
  reaches. Confirm an unexpected subtree against the importing module's own
  imports before reading it as a dependency.

Handlers registered as closures through a host API are not expanded from the
registering function; their bodies need their own entrypoint or a source read.

Reach for it when the claim is about call structure: "session creation now goes
through getServices," "the init path no longer reads the config file." Do not
reach for it to prove runtime behavior, type correctness, or that a dynamic call
still resolves.

## Invocation

calldiff takes a subcommand. `diff` compares two trees, `tree` renders one tree
without a diff, and `reach` finds call paths to a target symbol. The `diff`
subcommand follows git-diff ref semantics:

| Command | From | To |
|---|---|---|
| `calldiff diff` | HEAD | working tree |
| `calldiff diff <from>` | `<from>` | working tree |
| `calldiff diff <from> <to>` | `<from>` | `<to>` |

Re-check `npx calldiff --help` and `npx calldiff diff --help` against the
installed version for the current interface. Typical flags:

- `--from <ref>`, `--to <ref>` — explicit left and right trees.
- `-e, --entry <name>` — force an entrypoint. A free function name or
  `ClassName.method`. Repeatable.
- `-F, --file <path>` — use every export in that file as an entrypoint.
- `--max-depth <n>` — cap call-tree depth.
- `--locs` — show call-site source locations.
- Trailing path arguments — limit analysis to those path prefixes.

For branch or worktree work, the base ref is the stable branch, or
`git merge-base <stable-branch> HEAD` to isolate only the branch commits.

Run it with `npx calldiff diff` (fetches the published package; no local install
needed). Pin the package version when reproducibility matters.

## Entry selection

With no `--entry`, calldiff infers exported functions whose expanded call trees
changed and may show several. Run this first to discover what moved.

Force an entry when:

- you already know the function or method at the center of the change;
- auto-infer is too noisy, or returns nothing for a change you can see;
- you want a focused tree for one public entrypoint.

Entry names use `functionName` for free functions and `ClassName.method` for
methods.

## Reading the output

`-` lines were present in **from** and gone in **to**. `+` lines are new in
**to**. Unprefixed lines are context present on both sides.

Labels:

- `functionName` — free function.
- `ClassName.method` — method.
- `new ClassName` — constructor or `new` call.
- `if (cond)` / `else` / `else if (cond)` — conditional arm. These do not draw
  a continuing rail; read each arm as its own branch.

A removed subtree means that callee no longer appears in the expanded tree from
the entrypoint — usually because the call was deleted, moved, or put behind a
new condition. Confirm the cause against the source before claiming intent.

## Presenting and recording the result

Show the native calldiff tree when the changed call relationship is part of the
operator's requested understanding or decision, or when omission would hide a
material structural risk. Do not show it only because TypeScript changed,
calldiff ran, or the tree has an available interpretation. Otherwise, keep it
as internal structural verification.

When shown, use calldiff's call-tree diff as the structural evidence. Render it
in a `diff`-labelled Markdown block; Pi maps `-` lines to its removal color and
`+` lines to its addition color. Narrow the command to the load-bearing
entrypoint, depth, and paths. Then show the shortest contiguous native region
that contains the entrypoint and changed relationship. Label an incomplete
region as an excerpt. Preserve the leading markers, tree rails, spacing, and
call order. Cut an unchanged tail at a line boundary; do not insert ellipses or
comments inside the tree. Do not flatten the tree into a table or redraw it as
another artifact.

Follow the tree with only the conclusion that it supports. A Mermaid diagram
may supplement it only when a wider lifecycle or component flow is outside the
call tree.

In the claim ledger, record:

- the refs compared and the entrypoint, explicit or inferred;
- the changed subtrees that bear on the claim;
- the source lines that explain each removal or addition.

calldiff output is structural evidence. Its highlighted tree explains that
evidence; it does not add evidence. Pair the result with a focused test or a
runtime check for any claim about behavior, not merely about call shape.
