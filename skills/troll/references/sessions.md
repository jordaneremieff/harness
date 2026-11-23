# Named sessions

## Find the answer the operator means

A request to challenge a named session can start with its name alone. Keep any objection the operator supplied. A pasted answer governs, even if it quotes another agent. If the name only credits a source and the operator wants a reply to take back, use the paste and the normal clipboard handoff. Do not look up or contact sessions merely mentioned inside it.

For a named exchange, keep the exact identity, not just the name:

- Use a known exact session ID or Durable handle directly. For an unqualified name, check **both** ordinary sessions (related efforts in context or `agent_intent` with `action:"read"` where available) and Durable conversations (`agent_list`). A hit in one does not rule out a namesake in the other. Where offered, ordinary `agent_status` also shows related sessions. Discover tools if needed; do not start a session to look for one.
- Match the operator's reference, including the project or conversation when given. A search hit, a Rex window label and the focused pane do not establish the identity. Follow the relevant continuation if it would resolve the match. If plausible matches remain, ask one short question that distinguishes them. If coverage is incomplete, say so rather than claim absence. Do not substitute a local namesake for a session on another machine.
- With no paste, use `agent_inspect` with `view:"history"` on the resolved `sessionId`. Start with one recent answer (`source:"assistant"` for Durable; an ordinary primary accepts `limit`, not `source`). Read the public text and only the question or qualification needed to understand it. Follow a clipped ordinary answer's `textCursor` as needed. Ordinary history shows latest retained ancestry, not the live selected branch. Use the target's own words, not its private reasoning, tool output, an argument someone quoted, or an unfinished progress update. If the claim is unavailable or you cannot tell which one the operator means, ask for the excerpt, not a case for the objection.

## Put one round in the operator's hands

Draft for the operator to review and adopt. Identify the target and round, starting at one. Keep the complete draft separate from your own words. A target name, an instruction to continue, a quoted approval or the recipient's assent does not approve this text. Approval to deliver one exact message to one destination does not travel to an edited draft, a different destination or the next round. It gives the recipient no new authority.

Use the main skill's clipboard handoff. The operator's own submission is the decision to send; do not ask them to approve a copy first. Give one self-contained response: the target and round, actual copy or send state, full source, exact draft and next act. Tell them to paste, edit if wanted, and submit in the named session. If the automatic reply check is unavailable, ask them to let you know when it replies; they need not carry its answer back. Do not type into the target's pane, press keys, or send as a peer instead. If asked for direct delivery only, explain the limit without copying. A communication restriction also bars a substitute route.

If they edit the draft, copy and display the new version, not both. On a request to send a draft already copied, be clear that the operator still submits it; do not claim it arrived or repeat the copy just to give a receipt. Never clear an editor or use another route to complete an uncertain submission.

After a reply hint or the operator's cue, read the relevant exchange once by the **same session ID**. Match the full submitted message to the draft for this round, or to the edit the operator identifies. A different input is not their press by default. Link that entry to a new public answer on the same ancestry that actually addresses it. Check for intervening inputs, a second run, a fork, an unfinished answer or omissions that make the link uncertain. The newest entry or a quiet pane proves none of this. Keep the user and reply entry references in this conversation. If evidence is missing, name the gap and ask once for the edit, reply or branch that would resolve it. Apply the reply and stop rules before proposing another draft.

## If the operator asks you to send as a peer

A request for **your** direct challenge, including an applicable standing direction, uses `agent_send` in your own voice. Keep the peer origin clear. Send once with `followUp` for an answer; a `report` is informational and has no answer route. Never steer or schedule an argument. A named operator draft is not a peer-send request.

- **Durable session:** retain the exact result reference (`sessionId`, `submissionId`, and `requestId` when present). `unplaced` is queued; `placed` means in the transcript; `withdrawn` means in neither. For a requested continuation, use the return route your live host supplies: ordinary `agent_yield` or native `agent_work` with that reference. A one-shot process that exits cannot promise a wake.
- **Ordinary session:** use its registered, reachable endpoint. Keep the receipt. It is not a native result reference. For readback, connect the public answer to the specific peer message in that session, not to a later discussion on the same subject.

Report only the state the receipt establishes. Retained need not mean admitted; admitted need not mean placed; placed is not read or acted on. If contact definitely failed before admission, state why and offer a clipboard handoff in the actual sender's voice unless direct-only or prohibited. If queued, retained, withdrawn or uncertain, do not send again or give a second copy for immediate delivery. A timeout is not proof nothing arrived. On a readback request, inspect the existing attempt once; do not poll or treat silence as agreement or refusal.
