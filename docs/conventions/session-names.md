# Session names

An unnamed Pi session can receive a useful name before its first turn. The
[session name module](../../session-name/index.ts) owns the deterministic
derivation; the surfaces below invoke it. Naming uses Pi's public session name
API (`pi.getSessionName()` and `pi.setSessionName()`), so a terminal projection
does not own the rule.

## Consumers

- The [agent extension](../../extensions/agent/README.md) names an unnamed
  session from its first genuine interactive input.
- The [evo extension](../../extensions/evo/README.md) names an unnamed session
  from the direction of a registered `/evo` invocation, outside RPC mode.

The [naming lifecycle](../../session-name/lifecycle.ts) owns automatic writes.
Consumers offer their source text rather than call the name setter directly.
An immediate fallback is complete without a generator and costs no model request.
If useful source text has no parser result, the fallback is `Work in <cwd basename>`
within the same title bounds. Blank input and bare commands supply no name.

Every unmarked session-info entry stays protected, including a repeated name or
a deliberate clear. The module's internal custom receipt binds an automatic write
to its exact entry ID and phase, `fallback` or `semantic`. It uses the latest
session-info entry from the whole-file `sessionManager.getEntries()` view, the
same entry set Pi scans for the canonical name, not only the current branch.
Receipt or setter failure preserves protection; the module never repairs by
removing entries. Existing and resumed names remain readable without migration.

Receipts are module-internal. Other extensions must not read them or depend on
receipt availability during `session_info_changed`. Pi starts that extension event
without awaiting it, before the module appends its receipt. Use the public events
below or the canonical Pi name instead. Rex projects only that canonical name.
RPC input does not supply an automatic name; RPC clients retain Pi's
`set_session_name` command.

## Optional refinement

The module emits `session-name:provisional` once through `pi.events` at the first
`before_agent_start` after its fallback, unless a newer observed input discarded
the retained source first. A discard preserves the fallback and never attaches
a newer prompt to its entry ID. The payload is:

```ts
type ProvisionalName = {
  sessionId: string;
  nameEntryId: string;
  text: string;
  fallback: string;
  signal: AbortSignal;
};
```

The source excerpt is at most 4096 Unicode code points. The module releases its
copy after emission. A generator answers `session-name:refined` with exactly
`{ sessionId, nameEntryId, title }`. The module accepts a usable title only when
its runtime is active, that session is current, and the exact latest name entry
has its automatic fallback receipt. It compares, writes, and appends a semantic
receipt without an await. The first valid answer wins by creating a new entry ID;
invalid answers do not consume permission. The title uses the same 48-code-point
and eight-word derivation limits below.

Turn completion takes no naming action. A late answer for the unchanged fallback
remains valid; no answer replaces a semantic receipt or a superseded entry.
An unmarked write, including identical text or a clear, aborts the signal.
Shutdown and runtime replacement also abort it and remove listeners. An entry-ID
check protects the interval before a name observer runs. Resumed names never
replay a provisional event.

A generator must use these events instead of an absent-name guard and a direct
setter. It must check the cancellation signal before emission and own its model
choice, resource deadline, retries, and cleanup. The naming module makes no model
request, awaits no generator, and sets no eligibility timer. A failed or absent
generator leaves the useful fallback without a chat notice. The event bus is
in-process only; it supplies no durable replay or cross-process delivery.

This complete synthetic example demonstrates asynchronous integration without a
model, timer, dependency, or external effect. It is documentation, not a shipped
generator or a title-quality claim.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProvisionalName } from "../../session-name/lifecycle.ts";

async function syntheticTitle(text: string): Promise<string> {
  return text.includes("parser") ? "Repair parser" : "Review requested work";
}

export default function register(pi: ExtensionAPI): void {
  const stop = pi.events.on("session-name:provisional", (value) => {
    const event = value as ProvisionalName;
    void (async () => {
      if (event.signal.aborted) return;
      const title = await syntheticTitle(event.text);
      if (event.signal.aborted) return;
      pi.events.emit("session-name:refined", {
        sessionId: event.sessionId,
        nameEntryId: event.nameEntryId,
        title,
      });
    })().catch(() => {});
  });
  pi.on("session_shutdown", () => { stop(); });
}
```

## Derivation

The derivation is deterministic and makes no model request. Fenced code blocks,
inline code spans and URLs do not contribute.

- Remove control and format characters, then collapse whitespace.
- Use the first nonempty line that is not a Markdown ATX heading. A heading is
  one to six `#` characters followed by a space, a tab, or the end of the line.
  When every nonempty line is a heading, use the first heading. Remove leading
  block markers for headings, quotes, list items and emphasis.
- Keep the first sentence of that line: text before a `.`, `!`, `?` or `…` that
  whitespace follows.
- For input that starts with a slash command token, use the remaining arguments.
  Arguments with no usable word do not name the session.
- Reject text with fewer than three letters or digits.
- Cap the name at 48 code points and eight words at a word boundary. A single
  word longer than the cap yields no name.
- Remove trailing punctuation.
