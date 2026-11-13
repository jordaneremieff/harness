import AppKit

// Entry point. Without a check flag the reader runs as a normal Mac application and receives
// documents through the operating system's open events. The check flags render, verify or
// measure without user interaction and exit with a machine-readable result.
let mode = LaunchMode.parse(Array(CommandLine.arguments.dropFirst()))
let application = NSApplication.shared
let delegate = AppDelegate(mode: mode)
application.delegate = delegate
if case .frames = mode {
    if !application.setActivationPolicy(.prohibited) { application.setActivationPolicy(.accessory) }
} else {
    application.setActivationPolicy(mode.isAccessory ? .accessory : .regular)
}
application.run()
