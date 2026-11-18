# Composer

Use `/composer` in an ordinary interactive Pi session in Rex on macOS. It opens Composer.app below Pi or focuses the open composer. `/composer close` returns the draft to Pi's editor. `/composer update` builds the app from the loaded checkout.

## Configuration

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|
| app | `PI_COMPOSER_APP` | path | &lt;agentDir&gt;/composer/Composer.app | none | Installed native composer application. |
| mode | `PI_COMPOSER_MODE` | enum | "manual" | manual, auto | Composer mode. manual opens only through /composer; auto opens at startup in an ordinary interactive Pi session in Rex on macOS. No mode disables /composer. |
<!-- harness:settings:end -->

Pi checks the app's build manifest in interactive macOS sessions. If the app is missing, its manifest is unreadable or incompatible, or the app was built from an earlier commit, Pi starts a background build. Open the composer after the install completes. A build failure puts a failure record and log beside the app; Pi does not automatically retry that source digest. Use `/composer update` to retry. Print, JSON and RPC sessions never build the app.

## Terminal and draft

Pi requests a 20% split and includes that share in the launch file. Once visible, Composer requests the share that fits the draft, from 10% to 40%. Pi passes the share unchanged with the [split receipt](../../docs/conventions/terminal-pane.md). A manual divider move stops automatic resize. Menus extend the native overlay without moving the Rex divider.

The terminal keeps the transcript. While the composer is present and visible, Pi hides its editor and working row, and the harness statusline hides its footer through the [composer presence contract](../../docs/conventions/composer-presence.md). Type or paste in the focused Pi terminal to insert text in the composer. Press Enter in the terminal to focus the composer. If the composer hides or goes more than three seconds between event polls, Pi's editor becomes usable again with the latest draft Pi received. The connection stays open across a poll gap. Once the composer is present and visible again, Pi hands back any terminal edit, including an empty draft. Pi does not forward its own clear after a submission while the composer is present and visible.

Send uses Pi's Enter handler; Follow-up uses Pi's Alt+Enter action. Stop uses Pi's interrupt action. Completion uses Pi's installed autocomplete provider. Model and thinking choices use Pi's session controls. The composer receives the current branch's recorded assistant cost in USD. The queue display tracks composer submissions made while Pi is busy, not a complete inventory of Pi's queue. Edit queued restores all queues through Pi's own action; its reported count covers only composer-tracked rows. History recalls up to 100 entries and 256 KiB of text from the current branch and input in this composer session.

`/composer close` returns the mirrored draft to Pi's editor. Reload, new, resume and fork attempt to reconnect the same composer and preserve terminal edits made during the handoff. Pi closes the connection and restores its editor if the composer fails to attach in ten seconds or its process exits. Pi mirrors drafts up to 1 MiB of UTF-8; the native app owns recovery for text not delivered to Pi. A pane creation result whose effect is uncertain never triggers an automatic retry.

## Terminal views

Pi shows its dialogs, selectors and extension views, such as `/stash` or `/model`, in the terminal above the composer. While anything other than Pi's editor holds the terminal input, the composer shows what holds it, keeps the draft editable, and disables Send. The composer learns this from Pi's editor focus, so every dialog, selector and extension view counts, and no extension needs to know the composer.

When a view opens within five seconds of a command sent from the composer, and the composer still has the keyboard, the composer names the command (`/stash is open in the terminal`) and hands the keyboard to the view. Typing a new draft before the view opens cancels that claim. Prompt templates, skills and messages to the model never take the keyboard: a question that a running tool asks waits until you press Go to terminal or Esc in the composer. When a view that the composer handed the keyboard to closes, or one you went to with Go to terminal or Esc closes, the composer takes the keyboard back while Rex is the active application. When it hands Pi the keyboard, the composer asks Pi to give Rex focus to Pi's own pane through the split receipt, so the keys reach Pi even when Rex last focused another pane.
