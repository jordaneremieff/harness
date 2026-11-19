import AppKit
import NativePane
import MacPlatform
import MarkdownCore
import ReaderFeature
import WebKit

/// Runs image export, the offscreen WebKit verification and measurements.
/// Text-size options are step indexes; ReaderModel sends their multipliers through the bridge.
@MainActor
struct CheckRunner {
    let mode: LaunchMode
    let windows: WindowManager
    private static var presentedWindow: NSWindow?

    /// Check modes never replace the user's clipboard.
    static let checkPasteboard = NSPasteboard(name: NSPasteboard.Name("local.harness.markdown-reader.check"))

    static func platform() -> ReaderPlatform {
        ReaderPlatform(
            copyText: { text in
                checkPasteboard.clearContents()
                checkPasteboard.setString(text, forType: .string)
            },
            openExternal: { _ in false },
            reveal: { _ in },
            returnToTerminal: { _ in TerminalReturnResult(pane: .unavailable("check mode"), application: .failed("check mode")) },
            readText: { checkPasteboard.string(forType: .string) }
        )
    }

    func run() async {
        let status: Int32
        switch mode {
        case .exportImage(let input, let output, let width, let maxHeight, let appearance, let textSize, let review):
            status = await exportImage(input: input, output: output, width: width, maxHeight: maxHeight, appearance: appearance, textSize: textSize, review: review)
        case .verify(let output):
            status = await Verification(windows: windows).run(output: output)
        case .measure(let corpus, let sizes, let shapes, let output):
            status = await Measurement(windows: windows).run(corpus: corpus, sizes: sizes, shapes: shapes, output: output)
        case .present(let input, let width, let height, let appearance, let find, let source, let outline, let embedded, let textSize, let review, let inspect):
            await present(input: input, width: width, height: height, appearance: appearance, find: find, source: source, outline: outline, embedded: embedded, textSize: textSize, review: review, inspect: inspect)
            return
        case .returnCheck(let request):
            status = await returnCheck(request: request)
        case .usage(let text):
            FileHandle.standardError.write(Data(TerminalText.line("usage: MarkdownReader \(text)").utf8))
            status = 2
        case .application, .pane, .editor:
            status = 0
        }
        exit(status)
    }

    /// WebKit needs an ordered window for layout, but a check must not activate the app.
    /// A panel that WebKit treats as the key window, as the pane's window is after a person clicks
    /// it, for checks that send real key and mouse events. It never becomes the key window of the
    /// system, so the person's keyboard and focus stay in their own windows while a check runs:
    /// their typing never reaches a check, and a check never takes their typing.
    final class FocusedPanel: NSPanel {
        override var isKeyWindow: Bool { true }
        override var canBecomeKey: Bool { false }
    }

    static func offscreenWindow(page: ReaderWebPage, width: Double, height: Double = 1000, focused: Bool = false) -> NSWindow {
        let window = (focused ? FocusedPanel.self : NSPanel.self).init(contentRect: NSRect(x: -20000, y: -20000, width: width, height: height), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.isExcludedFromWindowsMenu = true
        window.contentView = page.webView
        page.webView.frame = NSRect(x: 0, y: 0, width: width, height: height)
        page.webView.autoresizingMask = [.width, .height]
        page.webView.isInspectable = true
        window.orderFrontRegardless()
        return window
    }

    static func reference(for path: String) throws -> (DocumentReference, Int?, String?) {
        let target = try OpenIntake.classify(URL(fileURLWithPath: path))
        if case .stored(_, let request, _) = target { return (target.reference, request.revision, request.digest) }
        return (target.reference, nil, nil)
    }

    static func emit(_ object: [String: Any], to output: String?) {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        if let output { try? data.write(to: URL(fileURLWithPath: output)) }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    static func requireReady(_ model: ReaderModel) throws {
        if case .failed(let message) = model.phase { throw CheckError.unavailable(message) }
        if let failure = model.failure { throw CheckError.unavailable(failure) }
        guard model.phase == .ready, model.page.isReady else {
            throw CheckError.unavailable("The bundled reader page is not ready; no substitute page was loaded.")
        }
    }

    /// Waits for one display frame, or 60 ms when the window does not draw frames. WebKit
    /// delivers no animation frames to the off-screen windows that check modes use.
    static let settleFrame = "await Promise.race([new Promise(r => requestAnimationFrame(r)), new Promise(r => setTimeout(r, 60))]); return true;"

    static func preparePageForCheck(_ model: ReaderModel) async throws {
        try requireReady(model)
        _ = try await model.page.callJavaScript("document.documentElement.setAttribute('data-check-mode', ''); return true;")
    }

    enum CheckError: Error, CustomStringConvertible {
        case unavailable(String)
        var description: String { switch self { case .unavailable(let message): message } }
    }

    /// Presents the same page for a person's screen capture. Automated checks never call this.
    func present(input: String, width: Double, height: Double, appearance: String?, find: String?, source: Bool, outline: Bool, embedded: Bool, textSize: Int?, review: String?, inspect: String?) async {
        if let appearance { NSApp.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua) }
        do {
            var directory = ObjCBool(false)
            if FileManager.default.fileExists(atPath: input, isDirectory: &directory), directory.boolValue {
                throw CheckError.unavailable("Directory presentation requires the reader's Open command; --present accepts a document.")
            }
            let (reference, revision, digest) = try Self.reference(for: input)
            let model = ReaderModel(reference: reference, platform: windows.platform, state: windows.state)
            model.chrome = embedded ? "pane" : "window"
            if let textSize { model.settings = PageSettings(textSize: textSize, wrapCode: false) }
            let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: width, height: height), styleMask: embedded ? [.borderless] : [.titled, .closable, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = model.page.webView
            model.page.webView.autoresizingMask = [.width, .height]
            window.delegate = windows
            windows.adopt(window, model: model)
            Self.presentedWindow = window
            window.orderFrontRegardless()
            await model.open(revision: revision, digest: digest, origin: nil)
            try Self.requireReady(model)
            window.title = model.displayTitle
            if !outline { await model.sendCommand("toggleOutline") }
            if source { await model.toggleSource() }
            if let review { await model.reviewChanges(base: Int(review), target: model.snapshot?.revision) }
            if let inspect { await Self.inspect(model, inspect) }
            if let find { model.findQuery = find; await model.find() }
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            Self.emit(["window": window.windowNumber, "title": window.title, "width": width, "height": height, "pid": Int(getpid())], to: nil)
        } catch {
            Self.emit(["ok": false, "error": String(describing: error)], to: nil)
            exit(1)
        }
    }

    static func inspect(_ model: ReaderModel, _ option: String) async {
        let parts = option.split(separator: ":", maxSplits: 1).map(String.init)
        guard let number = parts.first.flatMap(Int.init) else { return }
        let zoom = parts.count > 1 && parts[1] == "actual" ? "actual" : "fit"
        await model.sendCommand("inspectImage", args: ["index": number - 1, "zoom": zoom])
    }

    /// Reads an open request without accepting it, then exercises its explicit return action.
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
            await model.open(revision: openRequest.revision, digest: openRequest.digest, origin: openRequest.launchOrigin)
            try await Self.preparePageForCheck(model)
            guard model.returnLabel != nil else {
                Self.emit(["ok": false, "error": "the request carries no usable launch origin"], to: nil)
                return 1
            }
            await model.returnToTerminal()
            let result = model.lastReturn
            let passed = result?.application == .activated && (openRequest.launchOrigin?.exact == nil || result?.pane == .focused)
            Self.emit([
                "ok": passed,
                "label": model.returnLabel ?? "",
                "exact": openRequest.launchOrigin?.exact != nil,
                "helper": TerminalFocusHelper.fromBundle().map { ["node": $0.node.path, "helper": $0.helper.path] } ?? [:],
                "pane": result.map { String(describing: $0.pane) } ?? "",
                "application": result.map { String(describing: $0.application) } ?? "",
                "notice": model.notice?.text ?? "",
            ], to: nil)
            return passed ? 0 : 1
        } catch {
            Self.emit(["ok": false, "error": String(describing: error)], to: nil)
            return 1
        }
    }

    func exportImage(input: String, output: String, width: Double, maxHeight: Double, appearance: String?, textSize: Int?, review: String?) async -> Int32 {
        if let appearance { NSApp.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua) }
        do {
            let (reference, revision, digest) = try Self.reference(for: input)
            let model = ReaderModel(reference: reference, platform: Self.platform(), state: windows.state)
            if let textSize { model.settings = PageSettings(textSize: textSize, wrapCode: false) }
            let window = Self.offscreenWindow(page: model.page, width: width)
            defer { window.close() }
            await model.open(revision: revision, digest: digest, origin: nil)
            try await Self.preparePageForCheck(model)
            if let review {
                await model.reviewChanges(base: Int(review), target: model.snapshot?.revision)
                guard model.review.shown != nil else {
                    throw CheckError.unavailable(model.review.failure ?? "The comparison did not appear.")
                }
            }
            let page = model.page
            let fullHeight = try await page.callJavaScript("return document.documentElement.scrollHeight") as? Double ?? 1000
            let height = min(max(fullHeight, 400), maxHeight)
            window.setContentSize(NSSize(width: width, height: height))
            window.contentView?.layoutSubtreeIfNeeded()
            _ = try await page.callJavaScript(Self.settleFrame)
            let configuration = WKSnapshotConfiguration()
            configuration.rect = CGRect(x: 0, y: 0, width: width, height: height)
            configuration.snapshotWidth = NSNumber(value: width)
            let image = try await page.webView.takeSnapshot(configuration: configuration)
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else {
                throw CheckError.unavailable("The exported image could not be encoded as PNG.")
            }
            try png.write(to: URL(fileURLWithPath: output))
            Self.emit([
                "ok": true, "output": output, "bytes": png.count,
                "width": image.size.width, "height": image.size.height,
                "title": model.snapshot?.title ?? "",
                "summary": model.snapshot.map { Provenance.summary($0, rendered: model.rendered, latestRevision: model.latestRevision) } ?? "",
                "totalMilliseconds": model.timings?.totalMilliseconds ?? 0,
                "review": model.review.shown.map { "revision \($0.base) to \($0.target): \($0.line)" } ?? "",
                "documentHeight": fullHeight, "clipped": fullHeight > maxHeight,
            ], to: nil)
            await model.close()
            return 0
        } catch {
            Self.emit(["ok": false, "error": String(describing: error)], to: nil)
            return 1
        }
    }
}
