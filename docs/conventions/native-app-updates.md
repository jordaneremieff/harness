# Native app updates

An extension that ships a native app builds it from its own sources and installs it outside the
harness checkout. A harness update therefore leaves the installed app as it was. The Markdown
reader and Explorer keep their apps in step with the loaded harness in the same way, each with its
own code.

## When an app is replaced

At each interactive Pi start and each `/reload` on macOS, the extension compares the installed
app's `build.json` with the build inputs that this Pi process loaded. Print, JSON and RPC modes
never check or build on their own. The check does not delay startup.

| Installed app | Result |
| --- | --- |
| Built from the same inputs (equal source digest) | Nothing happens. |
| Built from a later commit of the same history, with no uncommitted changes on either side | It stays installed without a notice, so an older Pi process never replaces a newer app. |
| Any other state: missing, unreadable, no source record, an earlier commit, a commit in unknown order, uncommitted changes on either side, or loaded sources outside Git | A detached background install starts without asking. |

A running install, found through the build's install lock, starts nothing and shows nothing. If
the last install for the same loaded source digest failed, the start does not retry it; it shows
one error that names the log and the update command. The explicit `/<name> update` command always
installs from the loaded sources unless an install is running, and a successful install removes
the failure record.

An install outlives the session that started it. Running app instances are never stopped; each
keeps its build until it closes.

## What the person sees

While an install runs, the footer shows `<App> update`. Notices use one form, with each app's own
name and command:

| Event | Notice |
| --- | --- |
| Start | `<App> app update started in the background; log: <log path>.` |
| Success | `<App> app is up to date; open a new pane to use it.` An app that can count its running instances adds how many still run the previous build. |
| Another install runs (explicit request only) | `<App> app update is already running; the installed app stays until it ends.` |
| Failure | `<App> app update failed: <reason>; the previous app stays installed. See <log path> and run /<name> update to try again.` |
| Earlier failure for these sources (start only) | `<App> app update failed earlier for these sources and was not retried; the previous app stays installed. See <log path> and run /<name> update to try again.` |

Here `<App>` is `Markdown reader` or `Explorer`, and `<name>` is `markdown` or `explorer`.

## Ownership

Each extension reads its own manifest, computes its own source digest and holds its own failure
record and log beside its app. No module is shared between them. See
[Keeping the reader app current](../../extensions/markdown/README.md#keeping-the-reader-app-current)
and the [Explorer README](../../extensions/explorer/README.md#keeping-the-app-current).

Pi has no hook that runs extension code after `pi update`, and a harness activation only changes
which snapshot new Pi processes load, so the first interactive start after a change is the point
where the apps update.
