# Pane appearance

Native pane apps that show a Catppuccin page share one theme choice per machine. One machine file
holds the choice. Each app that follows this convention reads and writes the file with its own
code; no runtime module is shared, and no app knows which other apps follow it.

The colours come from the shared palette in [`assets/themes/`](../../assets/README.md). Each app
copies the palette into its bundle at build time; this convention covers only the choice of
appearance and flavour.

## The choice

- **Appearance**: `system` follows the macOS appearance; `light` and `dark` fix it.
- **Dark theme**: the Catppuccin flavour of the dark appearance: `frappe`, `macchiato` or `mocha`.
  The light appearance always uses Latte.

Each app offers both choices in its own chrome. A choice made in one app applies to every app that
follows the convention, including windows and panes that are already open.

## The file

The file is `<agentDir>/pane-appearance.json`:

```json
{ "version": 1, "appearance": "dark", "darkTheme": "mocha" }
```

- `version` is `1`. A file with another version, or one that does not parse, counts as absent.
- An absent file, or an absent or unknown value, means `system` and `frappe`.
- Other keys are ignored and need not survive a write.

The agent directory is `PI_CODING_AGENT_DIR` (with a leading `~` expanded), else `~/.pi/agent`.
Each app's install resolves that directory when it builds the bundle and records the absolute
file path as `paneAppearance` in the bundle's `build.json`. The app reads that field at launch,
so its file does not depend on the environment that launches it. A bundle without the field
keeps the choice in memory only.

## Writing

A writer replaces the whole file atomically: it writes a temporary file in the same folder with
mode `0600`, then renames it over `pane-appearance.json`. A writer that changes one value keeps the
other value as it last read it. Writers never edit the file in place.

## Following changes

Each app reads the file at launch and watches its folder. When the folder changes, the app reads
the file again; if the choice differs, it applies the new choice to every open window and pane
and to its native paper and application appearance. A page selects the flavour with `data-dark` on
its root element, as the shared palette expects. A change reaches the open panes of every app that
follows the convention within about a second.

## Checks

Check modes (verification runs, image exports and presentations) never read or write the live
file. They keep the choice in memory, set from their own options, or use an explicit scratch file
that the check itself creates.
