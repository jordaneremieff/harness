# Named sessions

## Find the claim or destination

A session name identifies a source or audience. It does not authorise a send. Use a supplied excerpt without looking up the session unless you need a direct destination or the operator asked for readback.

Use the named session's exact identity if known. Otherwise use the available discovery tools (`agent_list`, or `agent_status` for related ordinary sessions). A display name or a first search hit is not a unique match. Follow the returned continuation if that would resolve the match. If several plausible sessions remain, ask once for the exact one. If discovery is incomplete, say that; do not report that no such session exists.

Without a paste, use `agent_inspect` on the resolved `sessionId`, in history view. Read only the recent words that establish the claim. Follow a clipped entry's text cursor when needed. For an ordinary primary, the latest retained history does not establish the live branch. If the tool is not visible, check available declarations or discovery before concluding it is absent. If you cannot obtain the position, ask for the excerpt. Use a session's tool or action record only for a requested outcome report, never to adjudicate the dispute.

## Send once

Use `agent_send` only for an explicit request to send, including an applicable standing instruction in this conversation. Send the complete challenge in your own voice. If the reader could mistake it for the operator's instruction, identify yourself as a peer in the message. Use `followUp` for a challenge that asks for an answer. A `report` is informational and has no answer route. Do not use steering, scheduling or editor input to deliver an argument. Keep the normal route and records.

- **Durable session:** retain the exact result reference the send returns (`sessionId`, `submissionId`, and `requestId` when present). Use it for a requested result readback. `unplaced` is queued; `placed` means in the transcript; `withdrawn` means in neither the queue nor the transcript.
- **Ordinary session:** use its registered, reachable endpoint. Keep the returned receipt. This is not a native result reference. Use bounded history for a requested readback; connect the answer to the actual message in that exchange. A later reply on the same topic is not enough on its own.

Report the state the receipt establishes. Retained for delivery is not necessarily admitted; admitted is not necessarily placed; placed is not read or acted on.

## If delivery is unavailable

- No match, no reachable endpoint, no send tool, or definite refusal *before* admission: state the exact limit. With a claim in hand, offer the operator the message on the clipboard or, if that is unavailable, in chat. Write for the actual sender on that route. Respect a direct-only request or a restriction on the communication itself; neither permits a substitute route.
- Queued, retained or uncertain after an attempt: do not send again or provide a second copy for immediate delivery. A timeout or empty history is not proof that nothing arrived. State the uncertainty. On a readback request, inspect the existing attempt once; do not poll.
- Withdrawn or unanswered: report that state. Do not replace a withdrawn message or treat a missing answer as agreement or refusal.
