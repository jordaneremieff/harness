import AppKit
import AVFoundation
import CoreMedia
import OSLog
import ScreenCaptureKit

let mirrorLog = Logger(subsystem: "local.harness.app-pane", category: "mirror")

/// Shows a live image of the docked window while the terminal lies in front of the real window,
/// and hands the window the keyboard on a click. ScreenCaptureKit captures the single window
/// whatever covers it. The image keeps the window's own size and starts at the pane's top left
/// corner, so it lines up with the real window behind it.
///
/// Captured frames go to a sample-buffer display layer as they arrive. The capture reuses a few
/// surfaces for its frames, so a layer that shows a surface as plain content would keep showing
/// its first images.
@MainActor
final class MirrorView: NSView {
    var onClick: (() -> Void)?
    private(set) var failure: String?
    /** Whether the current capture delivered an image, so the view shows the window and not an empty area. */
    private(set) var live = false
    var onState: (() -> Void)?
    /** macOS shows its Screen Recording request once per process at most. */
    private static var requested = false
    static let permissionText = "Rex needs Screen Recording access to show it here while you use the terminal. Turn on Rex in System Settings, Privacy & Security, Screen & System Audio Recording, then quit and reopen Rex."
    private var stream: SCStream?
    private var streamWindow: CGWindowID?
    private var streamSize: CGSize = .zero
    private var imageSize: CGSize = .zero
    private var starting = false
    private let display = AVSampleBufferDisplayLayer()
    private let output: MirrorOutput
    private let queue = DispatchQueue(label: "local.harness.app-pane.mirror", qos: .userInteractive)
    private var generation = 0

    override init(frame: NSRect) {
        output = MirrorOutput(renderer: display.sampleBufferRenderer)
        super.init(frame: frame)
        output.onFirstFrame = { [weak self] generation in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, generation == self.generation, !self.live else { return }
                    self.live = true
                    self.onState?()
                }
            }
        }
        wantsLayer = true
        layer?.masksToBounds = true
        display.videoGravity = .resize
        layer?.addSublayer(display)
    }

    required init?(coder: NSCoder) { nil }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { onClick?() }
    override func rightMouseDown(with event: NSEvent) { onClick?() }

    override func layout() {
        super.layout()
        placeImage()
    }

    private func placeImage() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        display.frame = CGRect(x: 0, y: bounds.height - imageSize.height, width: imageSize.width, height: imageSize.height)
        CATransaction.commit()
    }

    /// Captures `window` at `size` points. A running capture of the same window changes only its
    /// size.
    func show(window: CGWindowID, size: CGSize, scale: CGFloat) {
        let pixels = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        guard pixels.width >= 2, pixels.height >= 2 else { return }
        if imageSize != size {
            imageSize = size
            placeImage()
        }
        if let stream, streamWindow == window {
            guard pixels != streamSize else { return }
            streamSize = pixels
            stream.updateConfiguration(Self.configuration(pixels)) { error in
                if let error { mirrorLog.error("resize failed: \(error.localizedDescription, privacy: .public)") }
            }
            return
        }
        guard !starting || streamWindow != window else { return }
        stop()
        // Screen capture runs under the terminal's Screen Recording access. Without it the view stays empty, so
        // the pane says what to turn on instead.
        guard CGPreflightScreenCaptureAccess() else {
            if !Self.requested {
                Self.requested = true
                CGRequestScreenCaptureAccess()
            }
            if failure != Self.permissionText {
                failure = Self.permissionText
                onState?()
            }
            return
        }
        streamWindow = window
        streamSize = pixels
        starting = true
        generation += 1
        let current = generation
        output.begin(generation: current)
        Task { @MainActor in
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                guard current == generation else { return }
                guard let target = content.windows.first(where: { $0.windowID == window }) else {
                    throw MirrorError(text: "The window is not available to screen capture.")
                }
                let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: target), configuration: Self.configuration(streamSize), delegate: output)
                try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
                try await stream.startCapture()
                guard current == generation else {
                    try? await stream.stopCapture()
                    return
                }
                self.stream = stream
                failure = nil
            } catch {
                guard current == generation else { return }
                failure = (error as? MirrorError)?.text ?? "Screen capture is unavailable: \(error.localizedDescription)"
                mirrorLog.error("capture failed: \(error.localizedDescription, privacy: .public)")
                streamWindow = nil
            }
            starting = false
            onState?()
        }
    }

    /// Ends the capture. The last image stays until the next capture replaces it.
    func stop() {
        generation += 1
        starting = false
        live = false
        streamWindow = nil
        if let stream {
            self.stream = nil
            stream.stopCapture { _ in }
        }
    }

    private static func configuration(_ pixels: CGSize) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = Int(pixels.width)
        configuration.height = Int(pixels.height)
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        configuration.queueDepth = 4
        configuration.showsCursor = false
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.capturesAudio = false
        return configuration
    }
}

struct MirrorError: Error {
    var text: String
}

/// Receives frames on the capture queue and gives each complete one to the display layer's
/// renderer at once.
final class MirrorOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let renderer: AVSampleBufferVideoRenderer
    /// Called once per capture, with its generation, when the first complete image arrives.
    var onFirstFrame: (@Sendable (Int) -> Void)?
    private let state = NSLock()
    private var generation = 0
    private var delivered = true

    func begin(generation: Int) {
        state.withLock {
            self.generation = generation
            delivered = false
        }
    }

    init(renderer: AVSampleBufferVideoRenderer) {
        self.renderer = renderer
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        mirrorLog.error("capture stopped: \(error.localizedDescription, privacy: .public)")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, buffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              CMSampleBufferGetImageBuffer(buffer) != nil else { return }
        if let writable = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: true), CFArrayGetCount(writable) > 0 {
            let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(writable, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(dictionary, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                                 Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        if renderer.status == .failed { renderer.flush() }
        renderer.enqueue(buffer)
        let first: Int? = state.withLock {
            guard !delivered else { return nil }
            delivered = true
            return generation
        }
        if let first { onFirstFrame?(first) }
    }
}
