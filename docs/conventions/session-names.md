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

A consumer calls the module only when the session has no name. An existing name,
a resumed name, and a later explicit name always win. RPC input does not name a
session in either consumer; an RPC client names a session with Pi's
`set_session_name` RPC command.

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
