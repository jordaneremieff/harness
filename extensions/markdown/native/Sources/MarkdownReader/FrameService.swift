import AppKit
import Darwin
import ImageIO
import MarkdownCore
import ReaderFeature
import SwiftUI
import WebKit

/// A serial pipe service owns one offscreen page and at most one transferable viewport file.
@MainActor
final class FrameService {
    private var model: ReaderModel?
    private var window: NSWindow?
    private var viewport: FrameRequest.Viewport?
    private var directory: URL?
    private var previousFrame: URL?

    static func isPipe(_ descriptor: Int32) -> Bool {
        var info = stat()
        guard fstat(descriptor, &info) == 0 else { return false }
        let type = info.st_mode & S_IFMT
        return type == S_IFIFO || type == S_IFSOCK
    }

    func run() async -> Int32 {
        guard Self.isPipe(STDIN_FILENO), Self.isPipe(STDOUT_FILENO) else {
            FileHandle.standardError.write(Data("--frames requires pipe stdin and stdout\n".utf8))
            return 2
        }
        signal(SIGPIPE, SIG_IGN)
        var status: Int32 = 0
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-frames-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            self.directory = directory
            try emit([
                "event": "ready", "scale": NSScreen.main?.backingScaleFactor ?? 1,
                "activationPolicy": NSApp.activationPolicy() == .prohibited ? "prohibited" : "accessory",
                "visibleWindows": NSApp.windows.filter(\.isVisible).count,
                "directory": directory.path, "pid": Int(getpid()),
            ])
            let reader = FrameLineReader(input: .standardInput)
            while let line = try await Task.detached(priority: .userInitiated, operation: { try reader.next() }).value {
                removePreviousFrame()
                var id = 0
                let started = ContinuousClock.now
                do {
                    guard case .data(let data) = line else { throw FrameProtocolError("input exceeds 16384 bytes") }
                    id = FrameRequest.errorID(data)
                    let request = try FrameRequest.decode(data)
                    try await apply(request)
                    var result = try await frame(id: request.id)
                    let duration = started.duration(to: .now).components
                    result["milliseconds"] = Double(duration.seconds) * 1000 + Double(duration.attoseconds) / 1e15
                    try emit(result)
                } catch {
                    removePreviousFrame()
                    try emit(["id": id, "ok": false, "error": String(describing: error)])
                }
            }
        } catch {
            FileHandle.standardError.write(Data("frame service: \(error.localizedDescription)\n".utf8))
            status = 1
        }
        if let model { await model.close() }
        window?.contentView = nil
        window?.close()
        model = nil
        window = nil
        removePreviousFrame()
        if let directory { try? FileManager.default.removeItem(at: directory) }
        return status
    }

    private func emit(_ value: [String: Any]) throws {
        var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        data.append(10)
        try FileHandle.standardOutput.write(contentsOf: data)
    }

    private func removePreviousFrame() {
        if let previousFrame { try? FileManager.default.removeItem(at: previousFrame) }
        previousFrame = nil
    }

    private func apply(_ request: FrameRequest) async throws {
        switch request.op {
        case .open:
            guard let root = request.root, let document = request.document, let viewport = request.viewport else { throw FrameProtocolError("incomplete open") }
            let store = try DirectoryStore(root: URL(fileURLWithPath: root))
            let reference = DocumentReference.stored(root: FileAccess.canonicalPath(root), storeId: store.storeId, document: document)
            if let model, model.reference != reference { throw FrameProtocolError("service already owns another document") }
            if model == nil {
                let state = ReadingStateStore(directory: nil)
                state.settings = PageSettings(textSize: viewport.textSize)
                model = ReaderModel(reference: reference, platform: Self.platform, state: state)
            }
            try await resize(viewport)
            guard let model else { throw FrameProtocolError("no open document") }
            try await openRevision(request, model: model)
        case .viewport:
            guard model?.snapshot != nil, let viewport = request.viewport else { throw FrameProtocolError("open a document first") }
            try await resize(viewport)
        case .revision:
            guard let model, model.snapshot != nil else { throw FrameProtocolError("open a document first") }
            try await openRevision(request, model: model)
        case .scroll:
            guard let model, model.snapshot != nil, let viewport else { throw FrameProtocolError("open a document first") }
            let metrics = try await model.viewportMetrics()
            let y: Double
            if let to = request.to { y = to / viewport.scale }
            else if let by = request.by { y = metrics.scrollY + by / viewport.scale }
            else { y = request.edge == "end" ? metrics.documentHeight : 0 }
            try await model.scrollViewport(to: y)
        case .frame:
            guard model?.snapshot != nil else { throw FrameProtocolError("open a document first") }
        }
    }

    private func openRevision(_ request: FrameRequest, model: ReaderModel) async throws {
        let wasAtStart = model.snapshot == nil ? true : (try await model.viewportMetrics()).scrollY == 0
        await model.open(revision: request.revision, digest: request.digest, origin: nil)
        try requireRevision(request, model: model)
        if let viewport { try await model.configureViewport(textSize: viewport.textSize, background: viewport.background) }
        // A block position omits the page padding before the first block.
        if wasAtStart { try await model.scrollViewport(to: 0) }
    }

    private func requireRevision(_ request: FrameRequest, model: ReaderModel) throws {
        if case .failed(let error) = model.phase { throw FrameProtocolError(error) }
        guard model.snapshot?.revision == request.revision, model.snapshot?.digest == request.digest else {
            throw FrameProtocolError(model.failure ?? "the requested pinned revision did not display")
        }
    }

    /// This platform value has no external effects. The service never handles navigation input.
    private static var platform: ReaderPlatform {
        ReaderPlatform(copyText: { _ in }, openExternal: { _ in false }, reveal: { _ in }, returnToTerminal: { _ in
            TerminalReturnResult(pane: .unavailable("pipe service"), application: .failed("pipe service"))
        })
    }

    private func resize(_ viewport: FrameRequest.Viewport) async throws {
        guard let model else { throw FrameProtocolError("no open document") }
        let wasAtStart = model.snapshot == nil ? true : (try await model.viewportMetrics()).scrollY == 0
        let position = await model.capturePosition()
        NSApp.appearance = NSAppearance(named: viewport.appearance == "dark" ? .darkAqua : .aqua)
        let width = Double(viewport.width) / viewport.scale
        let height = Double(viewport.height) / viewport.scale
        if window == nil {
            let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: width, height: height), styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.isExcludedFromWindowsMenu = true
            window.ignoresMouseEvents = true
            window.contentView = NSHostingView(rootView: AnyView(WebView(model.page).frame(width: width, height: height)))
            self.window = window
        } else {
            window?.setContentSize(NSSize(width: width, height: height))
            (window?.contentView as? NSHostingView<AnyView>)?.rootView = AnyView(WebView(model.page).frame(width: width, height: height))
        }
        window?.appearance = NSApp.appearance
        window?.contentView?.layoutSubtreeIfNeeded()
        self.viewport = viewport
        if model.snapshot != nil {
            try await model.configureViewport(textSize: viewport.textSize, background: viewport.background)
            if wasAtStart { try await model.scrollViewport(to: 0) }
            else if let position { _ = await model.restorePosition(position) }
        }
    }

    private func frame(id: Int) async throws -> [String: Any] {
        guard let model, let snapshot = model.snapshot, let revision = snapshot.revision, let viewport, let directory, let window else { throw FrameProtocolError("open a document first") }
        guard !window.isVisible else { throw FrameProtocolError("offscreen window became visible") }
        let width = Double(viewport.width) / viewport.scale
        let height = Double(viewport.height) / viewport.scale
        let metrics = try await model.viewportMetrics()
        let encoded = try await model.page.exported(as: .image(
            region: .rect(CGRect(x: 0, y: 0, width: width, height: height)),
            snapshotWidth: Double(viewport.width)
        ))
        guard let source = CGImageSourceCreateWithData(encoded as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw FrameProtocolError("snapshot image unavailable") }
        guard image.width == viewport.width, image.height == viewport.height else {
            throw FrameProtocolError("snapshot dimensions \(image.width)x\(image.height) differ from viewport \(viewport.width)x\(viewport.height)")
        }
        var rgba = Data(count: viewport.width * viewport.height * 4)
        try rgba.withUnsafeMutableBytes { bytes in
            guard let context = CGContext(data: bytes.baseAddress, width: viewport.width, height: viewport.height, bitsPerComponent: 8, bytesPerRow: viewport.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue) else { throw FrameProtocolError("RGBA context unavailable") }
            context.draw(image, in: CGRect(x: 0, y: 0, width: viewport.width, height: viewport.height))
        }
        if let background = viewport.background { FramePixels.clearBackground(&rgba, background: background) }
        let file = directory.appendingPathComponent("tty-graphics-protocol-\(UUID().uuidString).rgba")
        let descriptor = Darwin.open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw FrameProtocolError("private frame file unavailable") }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        previousFrame = file
        try handle.write(contentsOf: rgba)
        try handle.close()
        return ["id": id, "ok": true, "path": file.path, "width": viewport.width, "height": viewport.height,
                "scrollY": metrics.scrollY * viewport.scale, "documentHeight": metrics.documentHeight * viewport.scale,
                "scale": viewport.scale, "revision": revision, "digest": snapshot.digest]
    }
}
