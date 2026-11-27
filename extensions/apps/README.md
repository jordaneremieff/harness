# Apps in panes

A terminal pane can hold a real macOS application window: a browser, Slack, an editor or any other app. The window fills the pane, follows it when the layout changes and stays usable directly. Ask an agent to open an app in a pane, or choose **Pi: Show an App in a Pane…** in the Rex command palette.

The pane runs App Pane, a small native program. It finds its own pane on screen, moves the app's window onto it through Accessibility, and keeps it there.

## Using an app pane

Click the window in the pane to work in it. The app becomes the active application and takes the keyboard; its menus, shortcuts and text fields behave as they always do. Click another pane to go back to the terminal. While the terminal is in front, the pane keeps showing the app through a live image of its window, so a page, a chat or a build log stays visible beside the conversation. A click on that image, or a key typed in the pane, hands the keyboard back to the app.

When the pane's tab is hidden, the window waits just outside a bottom corner of the screen, on the side away from any other display, so it never shows over another tab. It returns when the tab comes back. When a layout change makes Rex rebuild the pane, the window stays where it is until the pane is found again, instead of leaving for the corner and coming back.

The window follows the pane as Rex moves and resizes it. If the app does not take the pane's size at once, the pane asks again. While the app does not answer, the pane waits for it without holding up the terminal.

- A browser (Brave, Chrome, Edge, Vivaldi, Chromium or Safari) gets a new window for the pane, at an address when one is given. `:tab` followed by Enter in the pane's terminal opens a tab in that window; `:tab https://example.com` opens it at an address. Neither command targets the front window. When the browser opens the window or a tab, it does not keep the keyboard. Closing the pane closes the window it created, even when the pane's tab is hidden. Before it asks a parked window to close, the pane returns it to its original position so you can answer any browser prompt.
- A link that another app sends to that browser, such as a link you click in Slack or in a terminal, opens in the browser pane of the tab where you work: the tab under the pointer, or in Rex's front window. In a tab without a browser pane, the link opens in a browser window outside the panes, as it would without them, and never in a window that waits for a hidden tab. With two browser panes in one tab, the one you used last takes the links. While the browser itself is the active app, you choose its windows as usual.
- Another app shows its main window, or the window whose title contains the requested text. Closing the pane puts the window back where it was.
- Closing the window, or quitting the app, closes the pane.
- `q` in the pane closes it.

A window that another pane already shows stays in that pane. An app that is not running starts without taking the keyboard. A window with a minimum size larger than the pane keeps its size, and the pane says so.

## Agents

`apps_show` takes `app` (a name such as `brave`, `slack` or `notes`, a bundle identifier, or an absolute `.app` path) and optionally `url` for a new browser window or `window` for text in an existing window's title. It checks the app and returns `show`, the program and arguments of the pane. The agent runs `show` as the program of a new split on the right of its own pane, without taking focus, and with the pane set to close when its program ends. The tool opens no pane itself.

Keep the block ID returned when the app pane opens. To open a new browser tab, send the text `:tab https://example.com` and the Enter key to **that block**, not to the focused pane or the browser application. The pane accepts one HTTP or HTTPS address, or no address for a blank tab. Read its reply before sending another request. If the pane or its window is gone, do not retry in the front window. A system URL opener sends an address to the browser pane of the tab where the operator works, which need not be yours, and global keyboard shortcuts follow system focus.

The pane's first lines identify the browser process and scripting window when the pane created one. To inspect a page or act on it, use the browser tools on a tab in that process and window, within the browser access that the operator configured. Attaching an existing window by title does not give the pane ownership of it or a `:tab` target.

## Setup and permissions

Pi builds App Pane from this checkout into `<agentDir>/apps/AppPane.app` when an interactive session starts and the installed build is missing or older. `/apps update` rebuilds it. A build log sits beside the app.

App Pane uses the Accessibility and Screen Recording access of the terminal application that runs the pane, so the terminal needs both. Opening a browser window uses Apple Events, so macOS asks once whether the terminal may control that browser. The pane opens a window in the browser that the operator already uses, with its profile and sign-ins. While a pane shows an app behind the terminal, macOS shows its screen recording indicator. Without Screen Recording access the pane cannot show the app's image while the terminal is in front: it shows its own text instead, asks macOS for the access once, and names the setting to turn on. After you turn it on, quit and reopen Rex.

## Limits

The window is the app's own window placed over the pane; the terminal does not embed it. Content that the terminal draws over the pane, such as a floating pane, is visible only while the terminal is in front. The first click on the live image activates the app and does not reach the page. An app in full screen, or a minimised window, stays as it is until it returns. Windows live on one desktop: a window on another desktop does not move to the pane.

Links follow the tab where you work in Chromium browsers, which open a link from another app in the window they used last. Safari's choice of window is unconfirmed. A window attached by title takes no part. If every window of the browser is in a pane, a link from a tab without a browser pane opens in one of them; keep one browser window outside the panes for such links.

## Files and checks

- `index.ts` registers `apps_show`, `/apps` and the palette command.
- `show.ts` checks requests and builds the pane program's arguments; `palette-command.ts` answers the palette.
- `app-update.ts` and `native/build.mts` build and install App Pane.
- `native/` holds App Pane. `AppPaneCore` parses requests and pane input, matches apps, calculates geometry and decides which browser window takes links (`LinkPolicy`). `AppPane` owns the window and sends Apple Events to its browser process; `LinkTarget` reads and changes the browser's window order for links. It uses the shared `native-pane` package to find and follow its pane.

Run `node --test extensions/apps/*.test.mts` and `node extensions/apps/native/build.mts test`.
