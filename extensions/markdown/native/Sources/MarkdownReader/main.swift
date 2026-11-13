import AppKit

// Entry point. Without a flag the reader runs as a normal Mac application and receives documents
// through the operating system's open events. `--pane` shows one document over the terminal pane
// that runs the program. The check flags render, verify or measure without user interaction and
// exit with a machine-readable result.
let mode = LaunchMode.parse(Array(CommandLine.arguments.dropFirst()))
let application = NSApplication.shared
let delegate = AppDelegate(mode: mode)
application.delegate = delegate
application.setActivationPolicy(mode.isAccessory ? .accessory : .regular)
application.run()
