import AppKit
import Darwin
import Foundation
import WebKit

/// Finds web content processes and reads memory footprints. Used only by the verification and
/// measurement modes.
enum ProcessProbe {
    /// The content process of the web view inside a window, read through WebKit's private
    /// `_webProcessIdentifier` key. Check modes use it to act on exactly their own page.
    @MainActor
    static func webContentProcess(of window: NSWindow) -> pid_t? {
        func find(_ view: NSView) -> WKWebView? {
            if let web = view as? WKWebView { return web }
            for child in view.subviews { if let web = find(child) { return web } }
            return nil
        }
        guard let content = window.contentView, let web = find(content),
              let pid = web.value(forKey: "_webProcessIdentifier") as? Int32, pid > 0 else { return nil }
        return pid
    }

    /// Physical footprint in bytes, as Activity Monitor's Memory column reports it.
    static func footprint(_ pid: pid_t) -> UInt64? {
        var info = rusage_info_v4()
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
        }
        return result == 0 ? info.ri_phys_footprint : nil
    }
}
