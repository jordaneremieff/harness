# Apps in panes

A terminal pane can hold a real macOS application window: a browser, Slack, an editor or any other app. The window fills the pane, follows it when the layout changes and stays usable directly. Ask an agent to open an app in a pane, or choose **Pi: Show an App in a Pane…** in the Rex command palette.

The pane runs App Pane, a small native program. It finds its own pane on screen, moves the app's window onto it through Accessibility, and keeps it there.

## Using an app pane

Click the window in the pane to work in it. The app becomes the active application and takes the keyboard; its menus, shortcuts and text fields behave as they always do. Click another pane to go back to the terminal. While the terminal is in front, the pane keeps showing the app through a live image of its window, so a page, a chat or a build log stays visible beside the conversation. A click on that image, or a key typed in the pane, hands the keyboard back to the app.

When the pane's tab is hidden, the window waits just outside the bottom right corner of the screen, so it never shows over another tab. It returns when the tab comes back.

- A browser (Brave, Chrome, Edge, Vivaldi, Chromium or Safari) gets a new window for the pane, at an address when one is given. Closing the pane closes that window.
- Another app shows its main window, or the window whose title contains the requested text. Closing the pane puts the window back where it was.
- Closing the window, or quitting the app, closes the pane.
- `q` in the pane closes it.

A window that another pane already shows stays in that pane. An app that is not running starts without taking the keyboard. A window with a minimum size larger than the pane keeps its size, and the pane says so.

## Agents

`apps_show` takes `app` (a name such as `brave`, `slack` or `sublime`, a bundle identifier, or an absolute `.app` path) and optionally `url` for a new browser window or `window` for text in an existing window's title. It checks the app and returns `show`, the program and arguments of the pane. The agent runs `show` as the program of a new split on the right of its own pane, without taking focus, and with the pane set to close when its program ends. The tool opens no pane itself.

The pane's first lines name the app, its window-server window number, the browser window ID when the pane opened a browser window, and the window title. An agent reads them from the pane. To read or act on a page in a browser pane, it uses the browser tools on the tab in that window, within the browser access that the operator configured.

## Setup and permissions

Pi builds App Pane from this checkout into `<agentDir>/apps/AppPane.app` when an interactive session starts and the installed build is missing or older. `/apps update` rebuilds it. A build log sits beside the app.

App Pane uses the Accessibility and Screen Recording access of the terminal application that runs the pane, so the terminal needs both. Opening a browser window uses Apple Events, so macOS asks once whether the terminal may control that browser. The pane opens a window in the browser that the operator already uses, with its profile and sign-ins. While a pane shows an app behind the terminal, macOS shows its screen recording indicator. Without Screen Recording access the pane cannot show the app's image while the terminal is in front: it shows its own text instead, asks macOS for the access once, and names the setting to turn on. After you turn it on, quit and reopen Rex.

## Limits

The window is the app's own window placed over the pane; the terminal does not embed it. Content that the terminal draws over the pane, such as a floating pane, is visible only while the terminal is in front. The first click on the live image activates the app and does not reach the page. An app in full screen, or a minimised window, stays as it is until it returns. Windows live on one desktop: a window on another desktop does not move to the pane.

## Files and checks

- `index.ts` registers `apps_show`, `/apps` and the palette command.
- `show.ts` checks requests and builds the pane program's arguments; `palette-command.ts` answers the palette.
- `app-update.ts` and `native/build.mts` build and install App Pane.
- `native/` holds App Pane. `AppPaneCore` holds request parsing, app matching, browser scripts and geometry; `AppPane` holds the pane program. It uses the shared `native-pane` package to find and follow its pane.

Run `node --test extensions/apps/*.test.mts` and `node extensions/apps/native/build.mts test`.
