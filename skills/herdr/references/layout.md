# Arranging panes

Read this before you move, re-orient, resize, zoom, or relocate a pane that
already exists. These operations are CLI-only; the `herdr_*` agent tools do
not carry them.

## Read the arrangement first

```bash
herdr pane layout --current
```

`.result.layout.panes[]` gives each pane's `rect` (`x`, `y`, `width`,
`height`), `.result.layout.splits[]` gives each split's `direction` and
`ratio`, and `.result.layout.zoomed` reports zoom state. `pane edges --current`
reports which sides of a pane touch the tab edge, and `pane neighbor
--current --direction left` names the pane on a side. Decide from that
geometry, never from the sidebar or from how the screen looks.

## `pane move` is for leaving a tab, not for re-orienting inside one

```bash
herdr pane move <pane_id> --tab <tab_id> --split right|down [--target-pane <id>] [--ratio <f>] [--no-focus]
herdr pane move <pane_id> --new-tab [--workspace <id>] [--label <text>] [--no-focus]
herdr pane move <pane_id> --new-workspace [--label <text>] [--no-focus]
```

Two traps live here.

**`--split` requires `--tab`.** Omitting it exits 2 with a usage line.

**A move whose destination tab is the pane's current tab does nothing.** It
exits 0 and returns a success-shaped response carrying `"changed": false` and
a `reason` that names why: `same_tab`, or `zoomed_tab` when the tab is
zoomed. The layout is untouched. The request is not rejected and no error is
printed, so a response that looks like success is the signal to check
`changed` before believing it. This is the single most common reason an agent
concludes that moving a pane is unsupported and destroys the pane instead.
If the reason is `zoomed_tab`, turn the zoom off and reissue the move.

After a move, take the pane ID from `.result.move_result.pane.pane_id`. The
three `previous_*` fields are always present: `previous_pane_id`,
`previous_tab_id`, and `previous_workspace_id`. Moving between tabs of one
workspace keeps the ID. Moving to another workspace changes it — the old value
comes back as `previous_pane_id` and no longer resolves.

## Re-orient an existing pane

To turn a pane below into a pane beside, route it out of the tab and back in
with the split you want. The pane keeps its ID, its terminal, its running
process, and its scrollback; the temporary tab disappears once it is empty.

```bash
herdr pane move w1:p3 --new-tab --no-focus
herdr pane move w1:p3 --tab w1:t1 --split right --target-pane w1:p2 --no-focus
```

`--target-pane` names the pane the moved pane is placed against, and `--split`
is where it lands relative to that pane. Confirm the result with
`pane layout --current` and `.result.move_result.changed` in the second
response.

`--split` has no `left` or `up`. To put the pane on the left, land it `right`
and then swap the two:

```bash
herdr pane swap --source-pane w1:p2 --target-pane w1:p3
```

Between the two moves the pane sits in a temporary tab, so the tab bar gains a
tab and loses it again. With `--no-focus` the view does not follow it. Issue
the second move immediately; if it fails, fix the flags and reissue it, and
leave the pane where it is until it lands.

Use this instead of closing the pane and splitting again. Recreating loses the
process, the output history, and the ID, and the user sees the pane blink out.

## Swap, resize, zoom, focus

```bash
herdr pane swap --source-pane w1:p2 --target-pane w1:p3
herdr pane swap --current --direction down
herdr pane resize --pane w1:p3 --direction down --amount 0.15
herdr pane zoom w1:p3 --on          # --off, or --toggle
herdr pane focus --direction right
```

`swap` exchanges two panes' positions and leaves every split direction and
ratio alone; use it to reorder, not to re-orient.

`resize` shifts the ratio of the split the pane belongs to. `--direction` is
the direction the shared boundary moves, so the pane on the far side of that
boundary grows. `--amount` is a fraction of the containing area. Read
`pane layout` afterwards rather than predicting the result.

`zoom` is display state: the layout rects stay as they were and
`.result.layout.zoomed` flips. Turn it off before you reason about geometry
again.

`focus` moves the user's focus. Do not call it for background work.

## Move a pane to another tab or workspace

```bash
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label build --no-focus
herdr pane move w1:p3 --tab w1:t2 --split down --no-focus
```

`tab create` returns `.result.tab` and `.result.root_pane`; `workspace create`
also returns `.result.workspace`. A tab that loses its last pane is removed
automatically, so a move that empties a tab needs no cleanup. Close a tab or
workspace only when you created it and it still holds panes you created.

On `pane move`, `--label` names the tab or workspace the move creates, and
`--tab-label` names the tab inside a workspace created by `--new-workspace`.
A temporary tab you are about to empty needs neither.

## What the CLI cannot do

There is no CLI command that rewrites a whole tab's split tree, so an
arrangement that no sequence of `split`, `move`, `swap`, and `resize` can
reach is not reachable from the CLI. The socket carries layout-tree methods —
`layout.apply` rewrites a tree, `layout.export` reads one — but no CLI
subcommand exposes them and the agent tools refuse the rewrite.

If a requested arrangement is genuinely unreachable, say so and name what is
reachable. Do not close the user's panes to approximate it.
