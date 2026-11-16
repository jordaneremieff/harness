import AppKit
import EditorFeature
import MacPlatform
import MarkdownCore
import SwiftUI

struct EditorRevisionCandidate: Sendable {
    let source: String
    let title: String
    let destination: EditDestination
    let resolver: any AssetResolving
    let label: String
    let baseSource: String
    let baseLabel: String
    let storedComparison: RevisionComparison?

    static func load(_ record: DraftRecord) throws -> Self {
        switch record.destination {
        case .file(let base):
            let file = try LocalFileSave.open(URL(fileURLWithPath: base.requestedPath))
            guard let baseSource = record.savedSource else { throw FileSaveError.invalid("The edit base is unavailable.") }
            return Self(source: file.source, title: record.title, destination: .file(file.base), resolver: DirectoryAssetResolver(directory: URL(fileURLWithPath: file.base.path).deletingLastPathComponent()), label: "Current file on disk", baseSource: baseSource, baseLabel: "Edit base · last saved source", storedComparison: nil)
        case .published(let base), .copy(let base):
            let copy: Bool = if case .copy = record.destination { true } else { false }
            let snapshot = try DocumentLoader.load(.stored(root: base.root, storeId: base.storeId, document: base.document), revision: copy ? base.revision : nil, pinnedDigest: copy ? base.digest : nil)
            guard let revision = snapshot.revision else { throw FileSaveError.invalid("The stored revision is unavailable.") }
            let selected = StoredEditBase(root: base.root, storeId: base.storeId, document: base.document, revision: revision, digest: snapshot.digest)
            let original = try DocumentLoader.load(.stored(root: base.root, storeId: base.storeId, document: base.document), revision: base.revision, pinnedDigest: base.digest)
            let comparison: RevisionComparison?
            if let before = original.record, let after = snapshot.record {
                comparison = RevisionDiff.compare(base: (before, original.source), target: (after, snapshot.source))
            } else { comparison = nil }
            return Self(source: snapshot.source, title: snapshot.title, destination: copy ? .copy(selected) : .published(selected), resolver: snapshot.resolver, label: copy ? "Copy source · pinned revision \(revision)" : "Current library revision \(revision)", baseSource: original.source, baseLabel: "Edit base · pinned revision \(base.revision)", storedComparison: comparison)
        case .scratchpad:
            throw FileSaveError.invalid("This scratchpad has no saved version. Its current text remains in recovery.")
        }
    }
}

@MainActor final class EditorRevisionReview: Identifiable {
    let id = UUID()
    let document: WorkingDocument
    let generation: UInt64
    let candidate: EditorRevisionCandidate
    let base: MarkdownEditorTextController
    let draft: MarkdownEditorTextController
    let latest: MarkdownEditorTextController

    init(document: WorkingDocument, candidate: EditorRevisionCandidate) {
        self.document = document; generation = document.text.generation; self.candidate = candidate
        base = MarkdownEditorTextController(source: candidate.baseSource)
        draft = MarkdownEditorTextController(source: document.text.source)
        latest = MarkdownEditorTextController(source: candidate.source)
        for controller in [base, draft, latest] {
            var presentation = document.presentation; presentation.mode = .raw
            controller.setPresentation(presentation)
            controller.textView.isEditable = false
        }
    }
}

struct EditorRevisionReviewView: View {
    enum Pair: String, CaseIterable { case baseDraft = "Base / Your Draft", baseCurrent = "Base / Current", draftCurrent = "Your Draft / Current" }
    @State private var pair = Pair.baseDraft
    let review: EditorRevisionReview
    let workspace: EditorWorkspace
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Review Saved Version").font(.title2)
            Text("Use Saved Version replaces the draft and resets undo. The previous draft stays as a separate recovery version.")
            Picker("Compare", selection: $pair) {
                ForEach(Pair.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented)
            if let comparison = review.candidate.storedComparison {
                Text("Base to current: \(comparison.addedLines) added lines, \(comparison.removedLines) removed lines.").font(.caption)
                ForEach(Array(comparison.limits.enumerated()), id: \.offset) { _, limit in Text(limit.description).font(.caption).foregroundStyle(.orange) }
            }
            HSplitView {
                VStack(alignment: .leading) {
                    Text(pair == .draftCurrent ? "Your draft · generation \(review.generation)" : review.candidate.baseLabel).font(.headline)
                    MarkdownEditorTextSurface(controller: pair == .draftCurrent ? review.draft : review.base)
                }.frame(minWidth: 240)
                VStack(alignment: .leading) {
                    Text(pair == .baseDraft ? "Your draft · generation \(review.generation)" : review.candidate.label).font(.headline)
                    MarkdownEditorTextSurface(controller: pair == .baseDraft ? review.draft : review.latest)
                }.frame(minWidth: 240)
            }.frame(minHeight: 300)
            HStack {
                Button("Keep Draft") { workspace.revisionReview = nil }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Create a Separate Copy") {
                    workspace.revisionReview = nil
                    Task { await workspace.duplicate(review.document) }
                }
                Button("Use Saved Version") { Task { await workspace.acceptRevision(review) } }
            }
        }.padding(18).frame(minWidth: 650, idealWidth: 1000, minHeight: 450, idealHeight: 700)
    }
}

extension EditorWorkspace {
    func reviewSavedVersion(_ document: WorkingDocument) async {
        guard allowAction("reviewing the saved version", document: document) else { return }
        guard !document.session.saving, document.session.record.pendingPublication == nil else {
            notice = "Resolve the pending save before replacing the draft."
            return
        }
        let generation = document.text.generation, record = document.session.record
        do {
            let candidate = try await Task.detached { try EditorRevisionCandidate.load(record) }.value
            guard active === document, generation == document.text.generation,
                  allowAction("reviewing the saved version", document: document) else { return }
            revisionReview = EditorRevisionReview(document: document, candidate: candidate)
        } catch { notice = "Saved version unavailable: \(error). Your draft remains unchanged." }
    }

    func acceptRevision(_ review: EditorRevisionReview) async {
        let document = review.document
        guard active === document, allowAction("replacing the draft", document: document),
              document.text.generation == review.generation, !document.session.saving,
              document.session.record.pendingPublication == nil else {
            notice = "The draft or save state changed. Review the saved version again before replacement."
            revisionReview = nil
            return
        }
        document.replacing = true; document.text.textView.isEditable = false
        defer { document.replacing = false; document.text.textView.isEditable = !closing }
        do {
            try await drafts.save(document.session.record.resumed())
            guard document.text.generation == review.generation,
                  document.text.replaceDocument(source: review.candidate.source) else {
                notice = "The draft changed before replacement. Its text remains unchanged."
                return
            }
            document.session.finishRevert(source: review.candidate.source, destination: review.candidate.destination)
            document.setResolver(review.candidate.resolver)
            document.observeBase()
            revisionReview = nil
            notice = "The saved version is open. The previous draft remains in recoverable drafts."
        } catch { notice = "The previous draft could not be retained. Replacement did not start: \(error)" }
    }
}
