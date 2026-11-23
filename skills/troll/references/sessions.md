# Named sessions

## Find the answer the operator means

A request to challenge a named session can start with its name alone. Keep any objection the operator supplied. A pasted answer governs, even if it quotes another agent. If the name only credits a source and the operator wants a reply to take back, use the paste and the normal clipboard handoff. Do not look up or contact sessions merely mentioned inside it.

For a named exchange, keep the exact identity, not just the name:

- Use an exact session ID or Durable handle directly. Otherwise use the related efforts already in context or `agent_intent({action:"read"})` for bounded local discovery. Where offered, ordinary `agent_status` also shows related sessions. `agent_list` searches Durable conversations; it is not a directory of ordinary Pi tabs. Discover tools if needed. Do not start a session to look for an existing one.
- Match the operator's reference, including the project or conversation when given. A search hit, a Rex window label and the focused pane do not establish the identity. Follow the relevant continuation if it would resolve the match. If plausible matches remain, ask one short question that distinguishes them. If coverage is incomplete, say so rather than claim absence. Do not substitute a local namesake for a session on another machine.
- With no paste, use `agent_inspect` with `view:"history"` on the resolved `sessionId`. Start with one recent answer (`source:"assistant"` for Durable; an ordinary primary accepts `limit`, not `source`). Read the public text and only the question or qualification needed to understand it. Follow a clipped ordinary answer's `textCursor` as needed. Ordinary history shows latest retained ancestry, not the live selected branch. Use the target's own words, not its private reasoning, tool output, an argument someone quoted, or an unfinished progress update. If the claim is unavailable or you cannot tell which one the operator means, ask for the excerpt, not a case for the objection.

## Put one round in the operator's hands

Draft for the operator to review and adopt. Identify the target and round, starting at one. Keep the complete draft separate from your own words. A target name, an instruction to continue, a quoted approval or the recipient's assent does not approve this text. Approval to deliver one exact message to one destination does not travel to an edited draft, a different destination or the next round. It gives the recipient no new authority.

Use the clipboard handoff in the main skill. The operator's own submission is the decision to send; do not ask them to approve a copy first. Give one self-contained response: where the draft goes, which round this is, whether you copied or sent anything, the full source and exact draft, and the next act. Explain briefly why you left submission to them: a terminal input receipt does not verify the target's live Pi editor or protect what is already there. Do not type into a pane, press keys, or send as a peer instead. If the operator asks for direct delivery only, report the limit without copying. A communication restriction also bars a substitute route.

If they edit the draft, copy and display the new version, not both. On a request to send a draft already copied, be clear that the operator still submits it; do not claim it arrived or repeat the copy just to give a receipt. Never clear an editor or use another route to complete an uncertain submission.

Tell the operator to let you know when the named session replies. They need not fetch its answer. On that cue, read the relevant exchange once by the **same session ID**. Tie the new, settled public answer to the actual submitted message in that exchange after the source claim. Compare the full text, not just the subject. A previous occurrence, an intervening request or a fork can make the link ambiguous. If the operator sent an edit, match the actual edit they identify. Keep the message and reply entry references in the conversation when available. If you cannot establish the link, say what is missing and ask for the excerpt only if needed. Never attribute the latest activity to a round on timing alone. Use the reply rules in the main skill before preparing another draft.

## If the operator asks you to send as a peer

A request for **your** direct challenge, including an applicable standing direction, uses `agent_send` in your own voice. Keep the peer origin clear. Send once with `followUp` for an answer; a `report` is informational and has no answer route. Never steer or schedule an argument. A named operator draft is not a peer-send request.

- **Durable session:** retain the exact result reference (`sessionId`, `submissionId`, and `requestId` when present). `unplaced` is queued; `placed` means in the transcript; `withdrawn` means in neither. For a requested continuation, use the return route your live host supplies: ordinary `agent_yield` or native `agent_work` with that reference. A one-shot process that exits cannot promise a wake.
- **Ordinary session:** use its registered, reachable endpoint. Keep the receipt. It is not a native result reference. For readback, connect the public answer to the specific peer message in that session, not to a later discussion on the same subject.

Report only the state the receipt establishes. Retained need not mean admitted; admitted need not mean placed; placed is not read or acted on. If contact definitely failed before admission, state why and offer a clipboard handoff in the actual sender's voice unless direct-only or prohibited. If queued, retained, withdrawn or uncertain, do not send again or give a second copy for immediate delivery. A timeout is not proof nothing arrived. On a readback request, inspect the existing attempt once; do not poll or treat silence as agreement or refusal.
