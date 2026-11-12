# google: Gmail, Drive, Sheets and Calendar through gws

The extension gives agents bounded tools for one configured Google account. It
runs the Google Workspace CLI (`gws`, release 0.22.5) as a subprocess. `gws`
owns Google sign-in, encrypted token storage and Google API requests. The
extension owns the tool contracts, result limits, provenance marking of Google
content, local file handling, MIME composition and duplicate-send protection.

Approval of consequential acts belongs to policy rules, not to this extension.
Each act that changes Google state or reaches other people is a separate tool,
so a rule can target it by name.

## Tools

All tools are deferred: `tool_search` or codemode reaches them.

| Area | Read tools | Write tools |
|---|---|---|
| Status | `google_status` | |
| Gmail | `gmail_search`, `gmail_message_get`, `gmail_thread_get`, `gmail_attachment_download`, `gmail_labels_list`, `gmail_drafts_list`, `gmail_draft_get`, `gmail_operation_status` | `gmail_draft_create`, `gmail_draft_update`, `gmail_draft_delete`, `gmail_send`, `gmail_draft_send`, `gmail_labels_modify`, `gmail_trash`, `gmail_untrash` |
| Drive | `drive_files_list`, `drive_file_get`, `drive_file_download`, `drive_file_export`, `drive_permissions_list` | `drive_file_upload`, `drive_file_rename`, `drive_file_move`, `drive_file_trash`, `drive_file_untrash`, `drive_share`, `drive_unshare` |
| Sheets | `sheets_get`, `sheets_values_get` | `sheets_values_update`, `sheets_values_append` |
| Calendar | `calendar_calendars_list`, `calendar_events_list`, `calendar_event_get`, `calendar_acl_list` | `calendar_event_create`, `calendar_event_update`, `calendar_event_cancel`, `calendar_share`, `calendar_unshare` |

No tool deletes a message, file, event or calendar permanently, and no tool
passes an arbitrary command to `gws`.

Downloads, exports and attachments are written to an explicit absolute path
whose parent exists. The tools never overwrite an existing file, never follow a
symlink at the destination, and never take a file name from Google content.
Uploads and attachments read explicit absolute local paths once.

## Results

Every tool returns one JSON envelope (`schemaVersion`, `status`, `data`,
`error`, `warnings`) of at most 64 KiB. The envelope is one line of compact
JSON, so a consumer that bounds tool output by line count never receives a
cut envelope. A result that cannot fit the envelope is returned as one
outcome: a retryable `RESULT_TOO_LARGE` error, with text, details and error
status derived from it. Lists and bodies are paged with
cursors and offsets; truncation is explicit.

Content that comes from Google (email headers, snippets and bodies, file names,
cell values, event titles, descriptions and attendee names, label names) sits
inside an `externalData` object with a fixed notice that it is untrusted data.
Terminal control characters in that content are neutralised. The marking
records provenance; it does not detect or prevent prompt injection.

## Scopes and capabilities

The extension never starts a sign-in and never asks for more scope. Before a
tool calls Google, it reads the granted scopes from `gws auth status`. A tool
whose scopes are absent returns `SCOPE_REQUIRED` with the scopes that would
satisfy it. The observed identity is cached briefly per credentials file and
expected account; a changed `expectedAccount` is checked against the observed
identity again before the next call that depends on it.

| Capability | Accepted scopes (`https://www.googleapis.com/auth/` prefix) |
|---|---|
| Gmail read | `gmail.readonly` or `gmail.modify` |
| Gmail send | `gmail.send`, `gmail.compose` or `gmail.modify` |
| Gmail drafts | `gmail.compose` or `gmail.modify` |
| Gmail labels and trash | `gmail.modify` |
| Drive read | `drive.readonly`, `drive.file` or `drive` |
| Drive write and share | `drive.file` or `drive` |
| Sheets read | `spreadsheets.readonly`, `spreadsheets`, `drive.readonly`, `drive.file` or `drive` |
| Sheets write | `spreadsheets`, `drive.file` or `drive` |
| Calendar list | `calendar.calendarlist.readonly` or `calendar` |
| Calendar events read | `calendar.events.readonly`, `calendar.events` or `calendar` |
| Calendar events write | `calendar.events.owned`, `calendar.events` or `calendar` |
| Calendar sharing read | `calendar.acls.readonly`, `calendar.acls` or `calendar` |
| Calendar sharing write | `calendar.acls` or `calendar` |

`gmail.compose` and `gmail.modify` also permit sending; no Gmail scope grants
draft editing or label changes without send. `drive.file` reaches only files the
app created or the user opened with it. Use policy rules to separate acts that a
scope does not separate.

`gws` adds `openid`, `userinfo.email` and `userinfo.profile` to every sign-in.
Unverified apps in testing mode are limited in the number of scopes they may
request; request the services you need rather than every scope.

## Duplicate-send protection

`gmail_send` and `gmail_draft_send` require a caller `operationId`. The
extension records each send in a private ledger before it starts `gws`, then
records the outcome: `accepted` (Gmail returned a message), `rejected` (Gmail
refused the request) or `unknown` (timeout, cancellation, a lost process or an
unparseable response).

- An operation is dispatched at most once. Repeating an `operationId` returns
  its record; repeating it with different arguments returns
  `OPERATION_CONFLICT`.
- While an identical request is `unknown`, a new `operationId` with the same
  recipients, subject, body, reply context and attachment bytes does not send.
- `gmail_operation_status` with `reconcile: true` searches Sent for the
  generated `Message-ID`. One exact match marks the operation `accepted`; no
  match leaves it `unknown`. Reconciliation never sends.
- The ledger belongs to the account and survives sign-out, expired credentials
  and sign-in again.

`accepted` means Gmail accepted the message, not that a recipient received it.
The protection covers sends made through these tools only; a `gws` command run
another way bypasses it.

## Setup

The extension installs and signs in to `gws` itself. Run the `/google`
command in Pi, or the same verbs from a shell with
`node extensions/google/cli.ts <verb>`:

| Verb | Effect |
|---|---|
| `setup [--client <file>] [--account <email>] [--services gmail,drive,sheets,calendar] [--access read\|write]` | Installs the pinned `gws` release when the managed copy is in use, imports a Google Cloud Desktop app OAuth client JSON into the configuration directory, signs out locally, signs in with the scopes for the chosen services, and records the signed-in account. Services default to all four and access to `read`. |
| `update` | Installs the pinned `gws` release again if the managed copy is missing or reports another version, and names the newest upstream release. |
| `status` | Shows the backend, account, granted scopes and capabilities. |
| `logout` | Removes local `gws` credentials and the recorded account. The grant at Google stays until you remove the app's access in your Google Account. |

The managed copy lives at `<agentDir>/google/bin/<version>/gws`. Setup
downloads the macOS archive for the running architecture from the
`googleworkspace/cli` GitHub release and refuses it unless its SHA-256 matches
the digest pinned in `release.ts`. A new `gws` version therefore arrives with
a change to `release.ts`, followed by `/google update`.

Before the first setup, create the OAuth client in a Google Cloud project:
an External consent screen with your account as a test user, a Desktop app
client, and the Gmail, Drive, Sheets and Calendar APIs enabled for the services
you use. In testing mode Google expires refresh tokens after seven days; run
setup again when that happens, or publish the consent screen to production.

Setup signs in through Google's consent page in the browser. To change
services or access later, run setup again with the complete set you want; it
signs out locally first. `/google logout` and setup do not revoke an earlier
broader grant at Google.

The extension runs `gws` with a fixed environment: the configured directory,
the Keychain backend, a nonexistent `GOOGLE_APPLICATION_CREDENTIALS` path (so
`gws` never falls back to Application Default Credentials) and a private
working directory with an empty `.env`. It refuses a plaintext
`credentials.json` in the configuration directory. One file lock per
configuration directory serialises tool operations across Pi sessions; `gws`
commands run outside the extension do not take it.

## Durable agents

The factory emits a `durable:contribution` named `google` with the same tools,
each declared `deferred` and `replay: "unsafe"`: an interrupted call is never
rerun by the host. Each tool declares `outputLimits` of the envelope's 64 KiB
byte cap, 2000 lines and head retention, so the host's output bound and the
envelope cap agree. The `google-guidance` section renders guidance for the
offered tools only.

## Configuration

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|
| executable | `PI_GOOGLE_EXECUTABLE` | path | &lt;agentDir&gt;/google/bin/&lt;pinned version&gt;/gws | absolute input | Absolute path to the gws executable. The default is the copy that /google setup installs. |
| configDir | `PI_GOOGLE_CONFIG_DIR` | path | &lt;agentDir&gt;/google/gws | none | Dedicated gws configuration directory for the personal Google account. |
| expectedAccount | `PI_GOOGLE_EXPECTED_ACCOUNT` | string | unset | minLength 3; maxLength 320 | Google account address that every operation must use. When unset, the account that /google setup signed in applies. |
<!-- harness:settings:end -->

## Files and checks

- `index.ts` registers the tools, publishes settings and emits the Durable
  contribution; `durable.ts` is the native form; `tools.ts` holds the shared
  tool shape and guidance.
- `setup.ts` installs `gws`, imports the OAuth client, signs in and records
  the account; `release.ts` pins the version and archive digests;
  `command.ts` implements the `/google` verbs for the command and `cli.ts`.
- `gws.ts` runs `gws` (environment, limits, exit-code mapping, version and
  account checks, the account lock).
- `gmail.ts`, `drive.ts`, `sheets.ts` and `calendar.ts` define the tools.
- `mime.ts` builds outgoing messages and reply headers; `send-ledger.ts` keeps
  send records; `files.ts` handles private directories and safe file writes;
  `result.ts` builds bounded results; `settings.ts` reads the `google` section.

```bash
node --test extensions/google/*.test.mts
node scripts/extension-load-check.mts extensions/google/index.ts
npm run typecheck && npm run lint && npm run check
```
