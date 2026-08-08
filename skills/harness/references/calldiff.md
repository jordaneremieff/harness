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
- type-level, generic, or signature changes that leave the call graph the same.

Reach for it when the claim is about call structure: "session creation now goes
through getServices," "the init path no longer reads the config file." Do not
reach for it to prove runtime behavior, type correctness, or that a dynamic call
still resolves.

## Invocation

calldiff follows git-diff ref semantics:

| Command | From | To |
|---|---|---|
| `calldiff` | HEAD | working tree |
| `calldiff <from>` | `<from>` | working tree |
| `calldiff <from> <to>` | `<from>` | `<to>` |

Re-check `npx calldiff --help` against the installed version for the current
flag set. Typical flags:

- `--from <ref>`, `--to <ref>` — explicit left and right trees.
- `-e, --entry <name>` — force an entrypoint. A free function name or
  `ClassName.method`. Repeatable.
- `--max-depth <n>` — cap call-tree depth.
- Trailing `-- <paths>` — limit analysis to paths.

For branch or worktree work, the base ref is the stable branch, or
`git merge-base <stable-branch> HEAD` to isolate only the branch commits.

Run it with `npx calldiff` (fetches the published package; no local install
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

Use calldiff's call-tree diff as the primary operator view. The rails show
nesting, context lines orient the change, and the leading `-` and `+` markers
identify structural removals and additions. Do not flatten this view into a
table or redraw it in Mermaid.

Render the selected output in a `diff`-labelled Markdown block. Pi maps `-`
lines to its removal color and `+` lines to its addition color. Preserve the
leading markers, tree rails, spacing, and call order. Narrow the command first
with `--entry`, `--max-depth`, and path filters. If an excerpt remains
necessary, label it and preserve one contiguous subtree; do not inject
commentary into the tree.

Follow the tree with one short interpretation of the structural change. A
Mermaid diagram may supplement it only when a wider lifecycle or component flow
is outside the call tree. Before delivery, confirm that the call-tree shape
remains the main view and the prose does not restate every line.

In the claim ledger, record:

- the refs compared and the entrypoint, explicit or inferred;
- the changed subtrees that bear on the claim;
- the source lines that explain each removal or addition.

calldiff output is structural evidence. Its highlighted tree explains that
evidence; it does not add evidence. Pair the result with a focused test or a
runtime check for any claim about behavior, not merely about call shape.
