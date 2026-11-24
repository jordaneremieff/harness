# NativePane

`native-pane/` is the Swift package for native windows that cover the terminal pane that launched them. Markdown Reader, Composer and App Pane use its `NativePane` product as a SwiftPM path dependency. No app depends on another.

The package finds a pane by its concealed terminal marker through macOS Accessibility. It follows the pane, masks regions covered by other terminal content, orders its panel relative to the terminal window, and returns focus to the terminal. It places the panel on the whole points nearest to the pane's edges, so the pane bottom stays fixed when the terminal moves an edge by a fraction of a point, and it shows and hides the panel without animation. It also owns terminal size, raw input, signals and bounded terminal output. The caller chooses the panel's background and maps input and close events to app actions.

Document commands, draft input, WebKit pages, state, build manifests and Pi wire protocols belong to the apps, not this package. Each of these apps' builders counts this package's manifest and sources in its build digest. Run its Swift tests with `node extensions/composer/native/build.mts test`.
