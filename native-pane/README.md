# NativePane

`native-pane/` is the Swift package for native windows that cover the terminal pane that launched them. Markdown Reader and Composer use its `NativePane` product as a SwiftPM path dependency. Neither app depends on the other.

The package finds a pane by its concealed terminal marker through macOS Accessibility. It follows the pane, masks regions covered by other terminal content, orders its panel relative to the terminal window, and returns focus to the terminal. It also owns terminal size, raw input, signals and bounded terminal output. The caller chooses the panel's background and maps input and close events to app actions.

Document commands, draft input, WebKit pages, state, build manifests and Pi wire protocols belong to the apps, not this package. Both native app builders count this package's manifest and sources in their build digests. Run its Swift tests with `node extensions/composer/native/build.mts test`.
