import Testing
import Foundation
import AppKit
import EditorFeature
import MarkdownCore
@testable import MarkdownReader

@MainActor @Suite(.serialized) struct EditorWorkspaceLifecycle {
    private func directory() throws -> URL {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("editor-workspace-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    @Test func mirrorPreservesExactMixedEndingsAndUnicode() {
        let source = "# Exact\r\n\r\n日本語 **strong**\r🌱 cafe\u{301}\n"
        let mirror = MirrorText(source: source)
        let range = (source as NSString).range(of: "日本語")
        #expect(mirror.apply(edits: [.init(range: range, expected: "日本語", replacement: "中文")], expectedGeneration: 0))
        let expected = source.replacingOccurrences(of: "日本語", with: "中文")
        #expect(mirror.source.utf8.elementsEqual(expected.utf8))
        #expect(mirror.generation == 1)
        #expect(mirror.digest == Digest.sha256(Data(expected.utf8)))
    }

    @Test func mirrorRefusesStaleUnorderedOverlappingAndInexactEditsAtomically() {
        let source = "🌱 cafe\u{301}\r\nlast"
        let mirror = MirrorText(source: source)
        let start = MarkdownSourceEdit(range: NSRange(location: 0, length: 2), expected: "🌱", replacement: "x")
        #expect(!mirror.apply(edits: [start], expectedGeneration: 1))
        #expect(!mirror.apply(edits: [.init(range: NSRange(location: 1, length: 1), expected: "x", replacement: "y")], expectedGeneration: 0))
        #expect(!mirror.apply(edits: [.init(range: NSRange(location: 3, length: 5), expected: "café", replacement: "coffee")], expectedGeneration: 0))
        let later = MarkdownSourceEdit(range: NSRange(location: 3, length: 5), expected: "cafe\u{301}", replacement: "coffee")
        #expect(!mirror.apply(edits: [later, start], expectedGeneration: 0))
        #expect(!mirror.apply(edits: [start, start], expectedGeneration: 0))
        #expect(mirror.source.utf8.elementsEqual(source.utf8))
        #expect(mirror.generation == 0)
        #expect(mirror.apply(edits: [start, later], expectedGeneration: 0))
        #expect(mirror.source == "x coffee\r\nlast")
    }

    @Test func mirrorBoundsDoNotOverflowOrSplitSurrogates() {
        let mirror = MirrorText(source: "🌱", initialGeneration: UInt64.max)
        #expect(!mirror.apply(range: NSRange(location: 0, length: 0), replacement: "a", selection: nil, actionName: ""))
        #expect(!MirrorText.validRange(NSRange(location: Int.max, length: Int.max), source: "🌱"))
        mirror.select(NSRange(location: 1, length: 0))
        #expect(mirror.selectedRange == NSRange(location: 0, length: 0))
    }

    @Test func pageChangesRetainExactRecoveryAndResumeOneBuffer() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "before\r\n"))
        let document = try #require(workspace.active)
        let ack = try await workspace.receivePageChange(.init(baseGeneration: 0, generation: 1, origin: "person", edits: [
            .init(range: NSRange(location: 0, length: 6), expected: "before", replacement: "after 🌱")
        ]))
        #expect(ack.recoveryRetained)
        #expect(ack.generation == 1 && !ack.copied)
        #expect(document.session.record.source == "after 🌱\r\n")
        let saved = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(saved.source.utf8.elementsEqual(document.text.source.utf8))
        workspace.readActive(); workspace.editActive()
        #expect(workspace.active === document)
        #expect(await workspace.prepareToClose())
        workspace.resumeEdits()
        #expect(!workspace.closing)
        await workspace.closeViews()
    }

    @Test func refusedPageChangeLeavesMirrorAndRecoverySourceIntact() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "exact"))
        let document = try #require(workspace.active)
        for change in [
            WebPageChange(baseGeneration: 1, generation: 2, origin: "person", edits: [.init(range: NSRange(location: 0, length: 5), expected: "exact", replacement: "wrong")]),
            WebPageChange(baseGeneration: 0, generation: 1, origin: "person", edits: [.init(range: NSRange(location: 0, length: 5), expected: "other", replacement: "wrong")]),
            WebPageChange(baseGeneration: 0, generation: 3, origin: "person", edits: [.init(range: NSRange(location: 0, length: 5), expected: "exact", replacement: "wrong")])
        ] {
            do { _ = try await workspace.receivePageChange(change); Issue.record("Invalid page change was accepted") }
            catch { }
        }
        #expect(document.text.source == "exact" && document.text.generation == 0)
        #expect(document.session.record.source == "exact")
        await workspace.closeViews()
    }

    @Test func failedRecoveryKeepsTheDocumentOpen() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let blocked = root.appendingPathComponent("blocked")
        try Data("occupied".utf8).write(to: blocked)
        let workspace = EditorWorkspace(directory: blocked, store: nil)
        workspace.add(DraftRecord(source: "Retain this draft"))
        let document = try #require(workspace.active)
        #expect(!(await workspace.prepareToClose()))
        #expect(!workspace.closing)
        await workspace.closeActive()
        #expect(workspace.active === document)
        #expect(workspace.notice != nil)
        await workspace.closeViews()
    }

}
