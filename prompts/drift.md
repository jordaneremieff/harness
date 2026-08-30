---
description: When the session has drifted, state a reconstruction of the operator’s original intent that the operator can confirm or reject
---

# drift

Use the visible session context as your only source. Do not use tools or ask the
operator questions.

This command is an alignment check when the session has drifted. Its two
sentences reconstruct the operator’s original intent so the operator can
confirm or reject it. They must not advance the session’s later activity.

Return exactly two plain-English sentences:

1. State the operator’s original intent as the kind of thing it is.
2. State concrete details from the visible session context that let the
   operator confirm or reject whether that reconstruction matches what they
   want.

“Original” means the intent that brought the operator into the session, not an
intent inferred from the session’s later activity.

Later activity is not the intent and is not a restatement of it. Use later
activity only to distinguish the current pursuit from the original intent. Do
not treat a detail from later work as evidence of the original intent unless
the original context supports that reading.

Let the intent’s kind select the details. If the intent is a question, state
the question sought. If it is a decision, state the decision sought. For every
kind, describe what the operator wants the work to address; do not do that work.

State the intent itself, not a summary of the message that expressed it.
Preserve its kind instead of forcing it into a fixed frame. Write a direct
statement the operator can confirm or reject, not a hedge about the statement.
Do not act on or advance the intent. Do not offer advice, caveats, or text
outside the two sentences.
