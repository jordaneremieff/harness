import AppKit
import Testing
import ReaderFeature
@testable import MarkdownCore
@testable import MarkdownReader

@MainActor @Suite struct CheckModeBounds {
    @Test(arguments: [false, true])
    func checkOpenRetainsTheRequestDigestWithoutConsumingTheRequest(_ mismatched: Bool) async throws {
        let run = try PaneRun()
        defer { run.remove() }
        let store = try DirectoryStore(root: URL(fileURLWithPath: run.store))
        let revision = try store.loadRevision(run.document, revision: 1)
        let digest = mismatched ? "sha256:" + String(repeating: "0", count: 64) : revision.record.digest
        let request = OpenRequest(storeId: store.storeId, document: run.document, revision: 1, digest: digest)
        let path = store.root.appendingPathComponent("opens/check.json")
        try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(request).write(to: path)
        let (reference, number, pinnedDigest) = try CheckRunner.reference(for: path.path)
        #expect(number == 1)
        #expect(pinnedDigest == digest)
        if mismatched {
            let model = ReaderModel(reference: reference, platform: CheckRunner.platform(), state: ReadingStateStore(directory: nil))
            await model.open(revision: number, digest: pinnedDigest, origin: nil)
            if case .failed = model.phase {} else { Issue.record("A mismatched pinned digest reached the reader") }
            #expect(model.snapshot == nil)
            await model.close()
        } else {
            let loaded = try DocumentLoader.load(reference, revision: number, pinnedDigest: pinnedDigest)
            #expect(loaded.digest == digest)
        }
        #expect(FileManager.default.fileExists(atPath: path.path))
    }

    @Test(arguments: [-1, 0, 3, 4, 9, 99])
    func textSizeOptionsKeepTheirIndexAtTheNativeBoundary(_ index: Int) throws {
        guard case .present(_, _, _, _, _, _, _, _, let presented, _, _, _) = LaunchMode.parse(["--present", "--text-size", String(index), "document.md"]),
              case .exportImage(_, _, _, _, _, let exported, _, _, _, _) = LaunchMode.parse(["--export-image", "--out", "document.png", "--text-size", String(index), "document.md"]) else {
            Issue.record("The text-size option did not reach the check mode")
            return
        }
        #expect(presented == index && exported == index)
        let settings = PageSettings(textSize: try #require(presented), wrapCode: false)
        let clamped = min(max(index, 0), PageSettings.textSizes.count - 1)
        #expect(settings.textSize == clamped)
        #expect(settings.textSizeMultiplier == Double(PageSettings.textSizes[clamped]) / 16)
        #expect(PageSettings.textSizeMultipliers[clamped] == settings.textSizeMultiplier)
    }

    @Test func exportOptionsCarryTheDarkThemeTheControlToClickAndTheAnswer() {
        guard case .exportImage(_, _, _, _, _, _, _, let theme, let click, let answer) = LaunchMode.parse(["--export-image", "--out", "page.png", "--dark-theme", "mocha", "--click", "#b-view", "--answer", "answer.md", "document.md"]) else {
            Issue.record("The export options did not parse")
            return
        }
        #expect(theme == "mocha" && click == "#b-view" && answer == "answer.md")
    }

    @Test func nativePaperTakesTheBaseOfTheThemeInForce() {
        #expect(ReaderTheme.base(light: true, darkTheme: "mocha") == (239, 241, 245))
        #expect(ReaderTheme.base(light: false, darkTheme: "frappe") == (48, 52, 70))
        #expect(ReaderTheme.base(light: false, darkTheme: "macchiato") == (36, 39, 58))
        #expect(ReaderTheme.base(light: false, darkTheme: "mocha") == (30, 30, 46))
        #expect(ReaderTheme.appearance(for: "dark")?.name == .darkAqua)
        #expect(ReaderTheme.appearance(for: "light")?.name == .aqua)
        #expect(ReaderTheme.appearance(for: "system") == nil)
    }

    @Test func offscreenHostAttachesTheWebViewWithoutActivation() {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let page = ReaderWebPage(webRoot: root)
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let window = CheckRunner.offscreenWindow(page: page, width: 640, height: 480)
        defer { window.close() }
        #expect(window.contentView === page.webView)
        #expect(window.styleMask.contains(.nonactivatingPanel))
        #expect(!window.isKeyWindow)
        #expect(window.frame.maxX < 0 && window.frame.maxY < 0)
        #expect(page.webView.frame.size == NSSize(width: 640, height: 480))
        #expect(NSWorkspace.shared.frontmostApplication?.processIdentifier == front)
    }

    @Test func unloadedPageCannotPassAReadinessCheck() {
        let model = ReaderModel(reference: .file(path: "/unavailable-check-document.md"), platform: CheckRunner.platform(), state: ReadingStateStore(directory: nil))
        #expect(throws: CheckRunner.CheckError.self) { try CheckRunner.requireReady(model) }
        #expect(!model.page.isReady)
    }

    @Test func skippedIntegrationChecksAreNotPasses() {
        let check = Verification.Check(name: "find-moves-selection", pass: false, detail: "The bundled reader page is unavailable.", skipped: true)
        #expect(check.json["pass"] as? Bool == false)
        #expect(check.json["status"] as? String == "skipped")
        #expect(Set(Verification.pageCheckNames).count == Verification.pageCheckNames.count)
        for name in ["find-moves-selection", "code-copy-exact", "table-column-geometry", "reading-lock-blocks-edit", "bridge-typing-exact-line-endings"] {
            #expect(Verification.pageCheckNames.contains(name))
        }
    }

    @Test func positionChecksRequireReportedSourceCoordinates() {
        let point = ReadingPosition(blockStart: 42, offsetY: 12.5, revision: 1)
        #expect(Context.sameSourcePosition(point, ReadingPosition(blockStart: 42, offsetY: 12.5, revision: 2)))
        #expect(!Context.sameSourcePosition(point, ReadingPosition(blockStart: 43, offsetY: 12.5, revision: 1)))
        #expect(!Context.sameSourcePosition(point, ReadingPosition(blockStart: 42, offsetY: 14, revision: 1)))
        #expect(!Context.sameSourcePosition(point, nil))
        var incomplete = point
        incomplete.blockStart = nil
        #expect(!Context.sameSourcePosition(point, incomplete))
        incomplete = point
        incomplete.offsetY = nil
        #expect(!Context.sameSourcePosition(point, incomplete))
    }

    @Test func deadlineReportsTheLastStageWithoutWaitingForWork() async {
        let deadline = VerificationDeadline()
        let stage = await withCheckedContinuation { continuation in
            deadline.start(seconds: 0.01) { continuation.resume(returning: $0) }
            deadline.stage = "display overlap: waiting for superseded open"
        }
        #expect(stage == "display overlap: waiting for superseded open")
    }

    @Test func aCompletedCheckDisarmsItsDeadline() async {
        let first = VerificationDeadline()
        let second = VerificationDeadline()
        var expired = false
        first.start(seconds: 0.01) { _ in expired = true }
        first.stop()
        await withCheckedContinuation { continuation in
            second.start(seconds: 0.03) { _ in continuation.resume() }
        }
        #expect(!expired)
    }
}
