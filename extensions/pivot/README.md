# Pivot

Use `/pivot` or `Ctrl+Alt+N` in an ordinary interactive Pi session to copy a launch command. Paste it into a new terminal with the Pivot extension loaded. The command returns to the current working directory and forks the saved session into the same session directory. It does not open a terminal or interrupt the original session. If Pi has not saved the session yet, there is nothing to copy.

The first interactive message in the new session tells the model to use the inherited conversation as background and to work on the new request. The framing becomes part of that message, not a system prompt or a separate turn. Slash commands, headless inputs and inputs sent by extensions do not use up the framing.

The copied command sets `--pivot` to declare intent. Pi records that intent against the new session's ID, so reopening the session preserves it and copying its history into another fork does not transfer it. A plain `--fork`, `/fork`, `/clone`, or extension-created child adds no framing.

Pivot uses Pi's clipboard and session APIs. It has no separate store or settings.
