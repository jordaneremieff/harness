# Return the reply

For an operator-submitted draft from one ordinary interactive Pi session to another on the same machine, start one finite, read-only check for the reply. Use this only when your own `bash` supports `background: true` with a completion message to this conversation, and the target runs in local Rex. Do not start it for a one-off clipboard handoff, a direct peer message, a stopped exchange or a request that excludes readback. If any required fact or tool is unavailable, use the reply-ready cue in [Named sessions](sessions.md). Do not ask the operator to supply technical details.

## Before you offer the draft

1. Retain the target's exact session ID and the current round. Use `rex_environment` to find the target window on the known local server. A matching label is a place to look, not proof. Use `rex_terminal` with `op:"inspect", view:"structure"` on that Rex session if you need the window's full block IDs. Inspect **process**, not screen contents, on plausible blocks in that window, with `target:{source:"explicit",server,session,window,block}`. Never use your inherited pane or the currently focused pane as a substitute.
2. Get one fresh `agent_inspect({sessionId,view:"history",limit:1})` **before** offering the draft. Call this observation `H`. Require `kind:"ordinary-primary"`, `source.latestKnown:true`, a head and file identity, and `presence.process.state:"live"`. Match `H.presence.process.pid` to the **foreground** PID from exactly one candidate block on this host. Call that process observation `R`. A direct child, a name, or an idle report is not the match. Use the structured tool results; if a field is missing, do not guess it or look for private state files.
3. Construct just this object from those observations:

   ```js
   const observation = {
     sessionId: H.sessionId,
     file: H.source.path,
     head: {id: H.source.head.id, offset: H.source.head.byteOffset},
     pin: {dev: H.source.pin.dev, ino: H.source.pin.ino, size: H.source.pin.size},
     rex: {server: R.target.server.endpoint, host: R.target.server.hostId,
           instance: R.target.server.instanceId, session: R.target.sessionId,
           block: R.target.blockId, pid: R.data.foreground.pid}
   };
   ```

4. Run the bundled [reply-hint.mjs](../scripts/reply-hint.mjs) **once**, in your own managed `bash` with `background:true`. Resolve the absolute script path from the skill you loaded. Use the command form below, substituting the path and a single JSON-encoded line (`JSON.stringify(observation)`). The quoted delimiter treats the line as data. Do not put the draft, reply, transcript or credentials in this command or any file. The helper uses Node.js and the installed `rex` CLI. Its default deadline is 15 minutes; `--timeout-ms` before the heredoc accepts up to one hour. Leave the outer job timeout unset or allow longer than the helper's deadline.

   ```sh
   node '<absolute skill directory>/scripts/reply-hint.mjs' <<'OBSERVATION'
   <one JSON line>
   OBSERVATION
   ```

Retain the returned job ID with the session ID, head ID, draft and round in this conversation. Copy the draft and give the **full review as your answer now**, including the next act: the operator pastes and submits it in the target. A job receipt means you started a check; it does not mean a message arrived. Do not wait in the foreground, poll, or replace the review with a short job card. If the operator changes the draft or target, stops, or starts another exchange, cancel your own superseded job by its exact ID.

## When the job returns

First match the job ID, session ID and original head to the **still-current** draft and round. Ignore an obsolete completion without reading the other session, copying a draft or restarting the exchange.

- A `hint` identifies the first new user entry and one possible assistant answer. Read their **public** text and intervening ancestry with `agent_inspect` on that session. Compare the *whole user text* to the offered draft before judging the answer. If it differs, do not paraphrase the unrelated reply as the outcome; ask which edit the operator submitted only if that would resolve the link. If it matches, check that the answer addresses this message, including any qualification or restriction. A custom entry can accompany a separate run. Status and ancestry alone prove neither attribution nor the selected live branch. Ask for the relevant excerpt if competing inputs or omitted text leave the link uncertain.
- For an attributable reply, use the main skill's reply rules now: report what changed, stop if answered or restricted, or offer one new exact draft for the operator to decide. A wake never authorises a send. For a warranted new draft, use a **new** pre-offer observation for its round.
- On `timeout`, say that you did not find a qualifying reply by the deadline, not that the target never answered. Offer the ordinary cue or, if the operator requests it, one more finite check of this same round using its **original** head and pin. On `incomplete`, `ambiguous`, `unavailable`, or a failed job, name the limit and use cued readback. Do not treat an interruption or silence as agreement, refusal or a reason to send again.
