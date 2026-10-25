# Runtime management

The runtime is an independent management process. Its recovery page works without the main browser application, a conversation, or a model provider. Pi services own settings, trust, credentials, resource resolution and packages. Agent owns native conversations and their recovery. Existing release and worktree commands own release and maintenance effects.

## Start and discover

Run the CLI from a selected source closure:

```sh
node "$runtime_source/runtime/cli.mts" serve \
  --source-root "$runtime_source" --cwd "$development_checkout" \
  --agent-dir "$agent_dir" --state-dir "$runtime_state" \
  --ui-state-dir "$ui_state" --restore-ui
```

Use absolute paths without symbolic links. `runtime_source` is the checked, retained release with its dependencies, not the mutable development checkout. `development_checkout` selects the repository for maintenance and release staging. Keep both paths explicit during deployment. `--pi` optionally selects the existing UI launcher's Pi executable; it does not replace managed namespaces' dependency bindings.

The default agent directory follows `PI_CODING_AGENT_DIR`, then Pi's user agent directory. Runtime state defaults to `<agentDir>/runtime`. UI state defaults to `<agentDir>/ui`. The local listener defaults to `http://127.0.0.1:4320`. The runtime prints its process descriptor and writes `<stateDir>/service.json`. A kernel process lock prevents another owner of the same state directory.

Open `/runtime/` on the local listener for recovery. The public TypeScript interface is `discoverRuntime()` and `callRuntime()` in [client.mts](client.mts), with request types in [contract.mts](contract.mts). Local clients discover the private Unix socket and send the process incarnation. A replaced process requires fresh discovery. The client never retries a lost request.

The CLI also accepts `call --request-file path`. The file contains the complete protocol envelope:

```json
{"protocol":"harness.runtime/1","request":{"operation":"health"}}
```

Requests and configuration documents have a byte bound. Responses have a separate byte bound. Oversized or incomplete results are errors, not evidence that a mutation rolled back. There is no shell-command endpoint.

## Public operations

| Area | Operations and ownership |
| --- | --- |
| Recovery | `health`, `diagnostics`; no provider initialisation |
| Configuration | `config.inspect`, `config.validate`, `config.apply`, `config.repair`; `target` is `runtime` or `pi` |
| Credentials | `auth.status`, `auth.login`, `auth.poll`, `auth.respond`, `auth.cancel`, `auth.logout`; Pi's model runtime owns credential storage |
| Project trust | `trust.inspect`, `trust.set`; Pi's project trust store owns decisions |
| Resources | `resources.inspect`; bounded resolved resource paths, no extension execution or missing-package installation |
| Packages | `packages.list`, `packages.install`, `packages.remove`, `packages.update`; Pi's package manager owns persistence |
| Native placement | `sessions.create`, `sessions.list`, `sessions.source`; runtime owns source placement, Agent owns the conversation |
| UI lifecycle | `lifecycle.status`, `lifecycle.start`, `lifecycle.stop`; existing UI supervisor and owner protocol |
| Releases | `release.status`, `release.stage`, `release.switch`, `release.rollback`; existing release CLI |
| Maintenance | `evolution.status`, `evolution.sync`, `evolution.promotion-plan`, `evolution.promote-local`, `upstream.status`, `upstream.update`; fixed existing commands |

Successful responses are `{ok:true,value}`. Errors contain `code`, `message` and `uncertain`. When `uncertain` is true, inspect the owning domain before another mutation. A command timeout or a lost receipt does not authorise replay. Different resource domains remain available during long maintenance. A conflicting mutation receives `busy`.

Login uses the upstream prompt/notification interaction. Poll the returned flow identity and submit its exact current prompt identity. Secrets go only to that invocation. The runtime does not return the resulting credential. Pending login state expires and does not survive management replacement. Saved credentials remain Pi-owned.

Resource inspection reports resolved paths, not contributions produced by executing extensions. Missing packages remain skipped. Package changes are explicit operations. Trust, resource and package requests require an absolute working directory. Maintenance and staging use the server-selected development checkout, not a directory supplied by the browser.

## Configuration

The `runtime` section of `<agentDir>/harness.json` uses the machine document envelope:

```json
{
  "version": 1,
  "runtime": {
    "port": 4320,
    "privatePort": 4321,
    "privateOrigin": "https://machine.example.ts.net",
    "privateOwnerLogin": "owner@example.com"
  }
}
```

| Field | Environment override | Default |
| --- | --- | --- |
| `port` | `PI_RUNTIME_PORT` | `4320` |
| `privatePort` | `PI_RUNTIME_PRIVATE_PORT` | `4321` when private access is configured |
| `privateOrigin` | `PI_RUNTIME_PRIVATE_ORIGIN` | No private listener |
| `privateOwnerLogin` | `PI_RUNTIME_PRIVATE_OWNER_LOGIN` | No private listener |

`PI_HARNESS_FILE` selects another machine document. CLI network options override the selected network configuration. Private origin and owner login are required together. The origin must be an exact HTTPS `ts.net` origin. Invalid configuration remains visible through health and inspection. It does not prevent independent local recovery. Explicit CLI private-origin/owner options also preserve the private route when the document is malformed.

`config.inspect` returns supported values and a digest, not credentials or a raw document. `config.apply` requires that digest. Runtime changes replace only the runtime section and preserve unrelated valid machine sections. They take effect at the next runtime start. Pi changes use its public preference setters and take effect in new owning services. Supported Pi fields are the default provider/model/thinking level, enabled models, extension/skill/prompt/theme paths, and automatic compaction/retry flags. Existing live sessions are not silently reconfigured.

`config.repair` is a separate, explicitly confirmed replacement of a bounded invalid document. It requires `confirm:true`, its current digest and validated supported values. The complete original bytes remain in a private `<agentDir>/runtime/config-backups/` file. Other original settings are not copied into the replacement. The recovery page states this before confirmation. Valid documents use normal field changes instead. Repair does not bypass file-type or size checks.

## Private recovery through Tailscale

Use the same private HTTPS origin as the main browser application, with a separate path to the independent runtime listener. Preserve the application's existing root route. Start the runtime with explicit `--private-origin`, `--private-owner-login` and `--private-port` values. At the authorised deployment boundary, configure only the recovery path:

```sh
tailscale serve --bg --https=443 --set-path=/runtime http://127.0.0.1:4321
```

Do not enable Funnel. The private listener requires the exact configured Host, forwarded Host, HTTPS protocol and Tailscale owner login. It rejects duplicate security headers, forwarding ambiguity, Funnel indicators, foreign origins and cross-site requests before serving assets or admitting operations. Mutations require an exact same-origin header. The local listener rejects proxy identity headers. The Unix socket uses the same user's filesystem permissions and process-incarnation check.

Both the preserved `/runtime/` path and the proxy's stripped mount form reach the same recovery handler. The recovery page has its own HTML, script and styles. It does not depend on the main application's backend or asset build. Main-application links and proxies are conveniences, not the private recovery route.

## Managed source and recovery

A managed namespace binds its native root, Agent source and Pi dependency installation. The runtime resolves dependencies from the selected source closure when it first creates the placement. Later releases retain each placement's exact `sourceRoot` and `packageDir`; they do not substitute the new runtime's global Pi installation. Source and dependency directories must remain intact while a namespace uses them.

The runtime stores placement and creation receipts under its state directory. It does not copy native input, task, conversation or profile state. Managed roots stay separate from the existing ordinary root so an unchanged older manager does not acquire them. Browser consumers compose root-specific public Agent services.

For the ordinary-root transition, setup optionally supplies the exact original `--existing-root`, `--existing-source-root` and `--existing-package-dir` triplet. Supply all fields or none. The runtime retains that route and combines it with the bounded retained managed placements. Agent creation and recovery receive this trusted source-specific route inventory for standing-handle resolution. Browser input never selects a runner or dependency installation. Conflicting or unavailable ownership does not permit a guessed route.

`sessions.create` requires a stable `requestId`. A reused identity with different content is refused. The runtime records its reservation before Agent admission and confirms the selected route before exposing the receipt. A completed duplicate returns that receipt. An uncertain reservation does not automatically create another conversation. `sessions.source` distinguishes a known binding from authoritative absence. Runtime unavailability is not permission to fall back to another source.

After its listeners become available, the runtime supervises Agent's `namespace-recovery.ts` through Chord, once per retained managed root. Agent's existing catalogue and native scheduler recover unfinished work without a dummy primary or a second task index. A failed recovery owner does not prevent configuration, authentication or independent namespace recovery. Diagnostics distinguish process readiness from Agent's per-session recovery results. Recovery-owner restarts do not replay runtime management mutations.

`--restore-ui` also starts the main application through its existing launcher when stopped. Release controls delegate to the retained sealed CLI. `release.stage` selects the development checkout's physical path as its source. Switch and rollback retain the existing release owner's last-good and session-preservation rules. Maintenance uses the current [worktree procedure](../docs/conventions/worktrees.md); local promotion does not grant remote publication authority.

## macOS restoration

`service-plan` accepts the same setup paths and network options and returns a LaunchAgent plan. Its fixed source, selected Node executable, original source triplet, private origin/owner options, `RunAtLoad` and `KeepAlive` survive management replacement. Installing and bootstrapping that plan is a separate deployment action. The command does neither.

The plan declares an explicit `EnvironmentVariables.PATH`. By default it freezes the setup process's PATH with the selected Node executable's directory first. `service-plan --path /selected/bin:/usr/bin:/bin` selects a different bounded directory list. Each entry must be absolute and non-empty. The plan removes duplicates and copies no other ambient environment values. Review the returned `environment.PATH` before installation.

This PATH selects management subprocesses such as `pi`, `npm` and `git`, including Node lookup by executable scripts. It does not change the fixed native namespace `packageDir` or source bindings. Check lookup under this declared environment rather than assuming the interactive shell's environment. A successful lookup does not establish that an upgrade or maintenance action completed.

Use a retained checked source for the service. Keep its Node and dependency installation available. A user LaunchAgent restores management at login and after process exit, then restores managed recovery owners and the optional main UI. It does not make a logged-out or powered-off Mac reachable, guarantee external effects exactly once, or bypass native recovery checks after uncertain work.

## Checks

Run the focused runtime suite with `node --test runtime/*.test.mts`, plus the repository's lint, type and slice checks. Tests cover configuration and invalid-document repair, independent HTTP recovery, proxy boundaries, credential interaction, resource inspection, concurrent operations on separate resources, source/dependency placement, uncertain creation, Chord process restoration and failure isolation. Actual provider login, launchd activation, private routing and device access require their own deployment evidence. Unit tests do not establish those outcomes.
