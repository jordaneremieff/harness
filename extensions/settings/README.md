# Settings

Settings is one place to find, understand, create and change the settings that Pi and the harness read. `/harness-settings` opens the native Settings app beside the conversation on macOS in Rex. The `settings_*` tools give agents the same operations without the app. Pi's own `/settings` command stays available.

- `/harness-settings [words]` opens Settings in a split to the right of the conversation, searching for the words. When this conversation already has a connected pane, that pane comes to the front instead.
- `/harness-settings update` builds and installs the app from the loaded checkout in the background. Interactive starts and reloads do the same when the installed app is missing or was built from other sources. A pane that is already open keeps the build it started with and says so when a newer build is installed.
- `/harness-settings help` lists these forms.

## What it manages

- **Pi settings.** Every property of the settings schema that the running Pi installation ships (`schemas/settings.schema.json` under `getPackageDir()`), in the agent-directory file (`global`) and the project file (`project`). The installed settings reference (`docs/settings.md`) supplies sections, descriptions, documented defaults and the agent-directory-only markers. Properties in the schema but not in the reference are Pi's internal records; deprecated properties stay visible with their migration note. Keys outside the schema are shown as unregistered entries.
- **Harness settings.** Every setting that a loaded extension declares under the [extension configuration contract](../../docs/conventions/extension-config.md). Settings learns each owner's declaration from its ordinary publication, lets the owner judge proposed values through that same publication, and writes the machine document (`<agentDir>/harness.json`, or `PI_HARNESS_FILE`). Owners carry no code for Settings: an extension that is added, removed or changed needs no Settings code, and removing Settings leaves the owners unchanged.
- **Custom settings.** User-created values in this extension's own section (`settings.custom`), keyed by any name, each with an optional description and type. They add no behaviour to Pi or another extension; the app and the tools read and change them.
- **Tools.** Pi's `defaultTools` setting, resolved with Pi's own rules, beside the current session's active tools and the configured tool inventory.

Credentials, project-trust records, models and provider configuration, MCP configuration and other extensions' private stores are not settings here.

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Applies | Constraints | Description |
|---|---|---|---|---|---|---|
| app | `PI_SETTINGS_APP` | path | &lt;agentDir&gt;/settings-app/Settings.app | next use | none | Installed native Settings application that /harness-settings opens. |
| custom | `PI_SETTINGS_CUSTOM` | json | {} | next use | none | User-created settings: an object keyed by setting name, each entry {value?, description?, type?}. type is string, number, integer, boolean, array, object or json. The Settings app and the settings tools read and change these entries; they add no behaviour to Pi or another extension. |
<!-- harness:settings:end -->

## Targets, scopes and sources

Every operation binds to one context: the machine, the agent directory, the working directory and its project directory, the host process and its project-trust state. The backend resolves the context from the invoking host. A native pane uses the context of the Pi session that opened it.

- `machine`: the harness machine document. There is no project-scoped harness configuration.
- `global`: Pi's `<agentDir>/settings.json`.
- `project`: Pi's `<cwd>/.pi/settings.json`. Settings writes it only when the host trusts the project; it never changes trust.

For each setting Settings reports the saved value in each scope, the value that configuration resolution selects and its source, an environment value that masks the saved one in this process, the value the running session uses where the host exposes it, and when a change applies.

Pi resolution uses Pi's public `SettingsManager` with the host's trust state. Project values override global ones and nested objects merge. Settings that the reference marks as agent-directory only ignore project values. Resource lists (the reference's Resources section) are combined from both files by Pi's resource loader. `defaultTools` follows Pi's `+name`/`-name` rules. A merged settings object is not proof of what a running consumer applied.

## Changes

A change names an entry, an action and, for Pi entries, a scope:

- `set` stores a value at the entry's path.
- `unset` removes the stored override so that normal resolution selects the value; it never writes a copied default. For a custom entry it keeps the entry's description and type.
- `create` adds a custom entry, or an explicit unregistered key where the Pi schema allows extra properties.
- `delete` removes a custom entry or an unregistered key.

Changes are desired values, not toggles, so a retry is safe. Each change carries the stored value its author saw (`base`), or the request carries the expected document revision. Under the document's lock the backend compares them with the current file. A different current value at the same path is a conflict and nothing in that document is written; a change to another path is kept. Settings never replaces a malformed or unreadable document.

Before a harness change is written, each affected owner judges the complete proposed document through its ordinary publication: Settings writes the proposal to a private file, names it in `PI_HARNESS_FILE` for one synchronous request with the environment names of that owner's fields removed, and restores the environment and every consumer's view at once (see [Writes](../../docs/conventions/extension-config.md#writes)). The owner therefore judges the stored value even where an environment value masks it in this process. A section that no loaded owner publishes is unmanaged: its values stay, and it accepts only explicit raw edits that report that no owner judged them. Unknown keys in an available owner's section stay unregistered; they can be removed but not set. Pi changes are checked against the installed schema and loaded through Pi's `SettingsManager` before they are written.

One request can change several documents. Settings validates all of them first and writes none when any change is invalid. It then writes each document atomically under that document's lock and reports exactly which documents it wrote; it does not promise atomicity across files.

### Locks and files

Pi settings files use Pi's own lock: `proper-lockfile` on the resolved file path with `realpath: false`. The machine document uses the same protocol under the [writer rules](../../docs/conventions/extension-config.md#writes). The backend reads the file again under the lock, patches only the requested paths, keeps the file's indentation, replaces it with a temporary file in the same directory, keeps its permission bits, replaces the target of a symbolic link rather than the link, writes in place when the file has more than one hard link, and reads it back to report the persisted revision.

### When a change applies

- Harness settings apply as their owner declares: at the next use, after a reload or new session, or after a restart of the reading process. An environment value masks a saved value in the processes where it is set.
- Pi reads its settings files at startup and at `/reload`. Settings compares the running session's settings with the saved result and reports a pending reload where they differ. Some Pi settings are read only at process start; Pi does not declare which, so Settings says that a new process may be needed.
- Custom settings apply when a reader reads them; nothing reads them automatically.
- The current session's active tools change at once through Pi's public tool controls. That change is not saved; `defaultTools` is.

A saved change in one host is not applied in other processes; each process applies it at its own reload or restart.

## Tools

- `settings_find` searches the catalogue and returns bounded rows.
- `settings_get` returns entries in full: scopes, saved values, resolution and source, masking, the session value, defaults, owner state and application timing, with document revisions.
- `settings_edit` previews or commits a batch of changes. A commit requires the document revision or each change's `base`.
- `settings_tools` shows the configured tools, the active ones and the resolved `defaultTools`, and changes the current session's active tools where the host allows it.

Tool results never include complete files or secret values. Ordinary sessions and Durable agents register the same tools over the same backend. Durable hosts expose no current-session tool controls, so `settings_tools` only reads there. Edits are not replayed after process loss: an interrupted edit may have been committed, so read the entry before you retry.

## Native app

The app is a thin native shell around one web page. It holds the operator's drafts and presentation; every read, validation and write goes through the backend of the Pi session that opened it.

### Live bridge

`/harness-settings` starts a loopback endpoint for the session (`http://127.0.0.1:<port>`) and passes the app a private one-use file, `--live <path>`, that holds `{version:1, endpoint, token}`. The app checks the file's owner, mode and identity and removes it before it connects. Each request is an HTTP POST with `Content-Type: application/json`, `Authorization: Bearer <token>`, the endpoint's Host and no Origin; the bridge refuses anything else. Request bodies are at most 1 MiB. Errors return `{ok:false,error}`. The shapes are in `protocol.ts`.

| Path | Request | Response |
|---|---|---|
| `/connect` | `version:1, client, build?` | `context`, `label`, `build` |
| `/poll` | `client, after` | `sequence`, `command` (`reveal` with an optional query) or `null`, `changed` |
| `/catalogue` | `client, generation` | `generation`, `catalogue` |
| `/edit` | `client, request` | `result` |
| `/tools` | `client` | `tools` |
| `/tools/apply` | `client, change` | `result` |
| `/close` | `client` | none |

A poll waits at most 25 seconds. It returns `changed: true` after a committed edit from any route in that session, and when another process has changed one of the settings files since the pane's last catalogue, so the app refreshes. The endpoint closes when the session ends, switches, forks or reloads; the app then keeps its drafts and asks for a new `/harness-settings`.

### Interface

Search by label, key or owner. The header identifies the Pi session, working directory and project trust. The Pi scope selector changes where new Pi edits go; it does not move drafts. Use **Details** to see saved and resolved values, defaults, overrides and when the change applies. Tools shows session activation above the saved Pi tool settings. Open Advanced for deprecated, internal, unregistered or unmanaged settings.

**Review** shows the destination and validation for each draft. **Save** reports what was written and what still needs attention. **Revert** discards unsaved changes across all scopes. If a pane closes or loses its connection, open `/harness-settings` from the same agent directory and working directory to recover its drafts. Check the stored value before you retry a save that did not return a result.

Press `⌘F` to search, `⌘S` to save and `⌘W` to close the pane. Use `↑` and `↓` to move between rows, `Return` to open Details, and `Esc` to close Details or a dialog. Use `Tab` to move between controls, including Revert, Review and Save.

### Offscreen checks

Run `node extensions/settings/native/build.mts check <output-directory>` to capture the bundled fixture in light and dark at two widths. For a real bridge in an isolated test session, run `Settings --check-live <capability> --script <file.js> --out <directory>` with absolute paths. The check consumes one launch capability and does not place a Rex pane. It uses a recovery directory under the output path. The script is a trusted async function body; return a JSON value for `result.json`. The check writes four PNGs of the final page state without a second connection.

In the script, `window.__settingsCheck` exposes `search(text)`, `open(id)`, `setDraft(id, scope, value)`, `setRaw(id, scope, text)`, `revert(id, scope?)`, `preview()`, `save()`, `state()`, `refresh()` and `snapshot(name)`. `preview()` and `save()` return the bridge edit result, or `undefined` when the page did not receive a result. `snapshot(name)` writes `capture-<name>.png`. These controls are not available in a normal pane.

## Checks

```bash
node --test extensions/settings/*.test.mts extensions/settings/native/web/app/*/*.test.mts
node extensions/settings/native/build.mts test
node scripts/extension-load-check.mts extensions/settings/index.ts
```

- `operations.test.mts` drives the backend over throwaway agent and project directories: every Pi schema entry, patching one path, reset without a copied default, schema refusals, project trust and agent-directory-only settings, conflicts and kept external changes, desired-value retries, revisions, malformed files, symbolic links and file modes, Pi's lock with a cooperating `SettingsManager` writer, session values, unregistered keys, a synthetic owner's refusals (including a value that an environment variable masks), cross-field conflicts, unmanaged sections, an owner that adds, changes and removes settings, the restored environment, custom settings, and tool activation.
- `settings.runtime.test.mts` loads the extension into a real ordinary Pi session: tool activation applies at once, and a Pi setting stays pending until `/reload` loads it.
- `index.test.mts` and `durable.test.mts` run the same tools through the ordinary registration and a real Durable Harness.
- `bridge.test.mts` checks the loopback bridge's authorisation, operations, wake-ups and capability files; `pi-schema.test.mts` checks the reading of the installed schema and reference.

These checks establish the backend's file, validation and resolution behaviour and the tool and bridge contracts. They do not establish how the native pane looks or feels in Rex; that needs the app's checks and use.
