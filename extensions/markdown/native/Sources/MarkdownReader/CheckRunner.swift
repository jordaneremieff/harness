import AppKit
import MacPlatform
import MarkdownCore
import ReaderFeature
import SwiftUI
import WebKit

/// Runs the non-interactive modes: image export, the fixed WebKit verification and measurements.
@MainActor
struct CheckRunner {
    let mode: LaunchMode
    let windows: WindowManager

    /// Check modes copy to a private pasteboard so that they never replace the user's clipboard.
    static let checkPasteboard = NSPasteboard(name: NSPasteboard.Name("local.harness.markdown-reader.check"))

    static func platform() -> ReaderPlatform {
        ReaderPlatform(
            copyText: { text in
                checkPasteboard.clearContents()
                checkPasteboard.setString(text, forType: .string)
            },
            openExternal: { _ in false },
            reveal: { _ in },
            returnToTerminal: { _ in TerminalReturnResult(pane: .unavailable("check mode"), application: .failed("check mode")) }
        )
    }

    func run() async {
        let status: Int32
        switch mode {
        case .frames:
            status = await FrameService().run()
        case .exportImage(let input, let output, let width, let maxHeight, let appearance, let textSize):
            status = await exportImage(input: input, output: output, width: width, maxHeight: maxHeight, appearance: appearance, textSize: textSize)
        case .verify(let output):
            status = await Verification(windows: windows).run(output: output)
        case .measure(let corpus, let sizes, let output):
            status = await Measurement(windows: windows).run(corpus: corpus, sizes: sizes, output: output)
        case .present(let input, let width, let height, let appearance, let find, let source, let outline):
            await present(input: input, width: width, height: height, appearance: appearance, find: find, source: source, outline: outline)
            return
        case .returnCheck(let request):
            status = await returnCheck(request: request)
        case .usage(let text):
            FileHandle.standardError.write(Data("usage: MarkdownReader \(text)\n".utf8))
            status = 2
        case .application:
            status = 0
        }
        exit(status)
    }

    /// A window outside the visible screen area that hosts one page, so that WebKit lays it out
    /// at a known width without showing anything.
    static func offscreenWindow(page: WebPage, width: Double, height: Double = 1000) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: width, height: height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: AnyView(WebView(page).frame(width: width, height: height)))
        window.orderFrontRegardless()
        return window
    }

    static func reference(for path: String) throws -> (DocumentReference, Int?) {
        let target = try OpenIntake.classify(URL(fileURLWithPath: path))
        if case .stored(_, let request, _) = target { return (target.reference, request.revision) }
        return (target.reference, nil)
    }

    static func emit(_ object: [String: Any], to output: String?) {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        if let output {
            try? data.write(to: URL(fileURLWithPath: output))
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    static func pngData(_ data: Data) -> Data? {
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return data }
        guard let image = NSImage(data: data), let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
        return bitmap.representation(using: .png, properties: [:])
    }

    /// Opens a normal reader window in the requested state and prints its window number, so that
    /// a session with screen recording permission can capture the real window.
    func present(input: String, width: Double, height: Double, appearance: String?, find: String?, source: Bool, outline: Bool) async {
        if let appearance { NSApp.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua) }
        do {
            let (reference, revision) = try Self.reference(for: input)
            let model = windows.open(reference, revision: revision, origin: nil)
            guard let window = NSApp.windows.first(where: { $0.isVisible && $0.title != "" && $0.delegate === windows }) else { return }
            window.setContentSize(NSSize(width: width, height: height))
            let deadline = Date().addingTimeInterval(10)
            while model.phase != .ready, Date() < deadline { try? await Task.sleep(for: .milliseconds(50)) }
            model.outlineVisible = outline
            if source { await model.toggleSource() }
            if let find {
                model.showFind()
                model.findQuery = find
                await model.find()
            }
            Self.emit(["window": window.windowNumber, "title": window.title, "width": width, "height": height, "pid": Int(getpid())], to: nil)
        } catch {
            Self.emit(["ok": false, "error": String(describing: error)], to: nil)
            exit(1)
        }
    }

    /// Reads (does not accept) an open request, opens its document offscreen with the request's
    /// launch origin and the Mac platform operations, and runs Return to Rex once.
    func returnCheck(request: String) async -> Int32 {
        do {
            let target = try OpenIntake.classify(URL(fileURLWithPath: request))
            guard case .stored(_, let openRequest, _) = target else {
                Self.emit(["ok": false, "error": "not an open request"], to: nil)
                return 1
            }
            let model = ReaderModel(reference: target.reference, platform: MacPlatform.operations(), state: windows.state)
            let window = Self.offscreenWindow(page: model.page, width: 800)
            defer { window.close() }
            await model.open(revision: openRequest.revision, origin: openRequest.launchOrigin)
            guard model.returnLabel != nil else {
                Self.emit(["ok": false, "error": "the request carries no usable launch origin"], to: nil)
                return 1
            }
            await model.returnToTerminal()
            let result = model.lastReturn
            Self.emit([
                "ok": true,
                "label": model.returnLabel ?? "",
                "exact": openRequest.launchOrigin?.exact != nil,
                "helper": TerminalFocusHelper.fromBundle().map { ["node": $0.node.path, "helper": $0.helper.path] } ?? [:],
                "pane": result.map { String(describing: $0.pane) } ?? "",
                "application": result.map { String(describing: $0.application) } ?? "",
                "notice": model.notice?.text ?? "",
            ], to: nil)
            return 0
        } catch {
            Self.emit(["ok": false, "error": String(describing: error)], to: nil)
            return 1
        }
    }

    func exportImage(input: String, output: String, width: Double, maxHeight: Double, appearance: String?, textSize: Int?) async -> Int32 {
        if let appearance {
            NSApp.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua)
        }
        do {
            let (reference, revision) = try Self.reference(for: input)
            let model = ReaderModel(reference: reference, platform: windows.platform, state: windows.state)
            if let textSize { model.settings = PageSettings(textSize: textSize, wrapCode: false) }
            let window = Self.offscreenWindow(page: model.page, width: width)
            defer { window.close() }
            await model.open(revision: revision, origin: nil)
            if case .failed(let message) = model.phase {
                Self.emit(["ok": false, "error": message], to: nil)
                return 1
            }
            let fullHeight = (try? await model.page.callJavaScript("return document.documentElement.scrollHeight") as? Double) ?? 1000
            let height = min(max(fullHeight, 400), maxHeight)
            window.setContentSize(NSSize(width: width, height: height))
            (window.contentView as? NSHostingView<AnyView>)?.rootView = AnyView(WebView(model.page).frame(width: width, height: height))
            window.contentView?.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(300))
            let raw = try await model.page.exported(as: .image(region: .rect(CGRect(x: 0, y: 0, width: width, height: height)), snapshotWidth: width))
            guard let png = Self.pngData(raw) else {
                Self.emit(["ok": false, "error": "the exported image could not be encoded as PNG"], to: nil)
                return 1
            }
            try png.write(to: URL(fileURLWithPath: output))
            let size = NSImage(data: png)?.size ?? .zero
            Self.emit([
                "ok": true,
                "output": output,
                "bytes": png.count,
                "width": size.width,
                "height": size.height,
                "title": model.snapshot?.title ?? "",
                "summary": model.snapshot.map { Provenance.summary($0, rendered: model.rendered, latestRevision: model.latestRevision) } ?? "",
                "totalMilliseconds": model.timings?.totalMilliseconds ?? 0,
                "documentHeight": fullHeight,
                "clipped": fullHeight > maxHeight,
            ], to: nil)
            return 0
        } catch {
            Self.emit(["ok": false, "error": String(describing: error)], to: nil)
            return 1
        }
    }
}
