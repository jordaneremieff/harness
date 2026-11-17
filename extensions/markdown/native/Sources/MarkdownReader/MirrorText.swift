import Foundation
import MarkdownCore
import ReaderFeature
import Observation

struct MirrorSnapshot: Sendable {
    let source: String
    let generation: UInt64
    let selectedRange: NSRange
    let hasMarkedText: Bool
}

/// Exact source retained by native code. Selection and composition are passive page state.
@MainActor @Observable final class MirrorText {
    private(set) var source: String
    private(set) var generation: UInt64
    private(set) var selectedRange = NSRange(location: 0, length: 0)
    var hasMarkedText = false
    @ObservationIgnored var onChange: ((MirrorSnapshot) -> Void)?

    init(source: String, initialGeneration: UInt64 = 0) {
        self.source = source; generation = initialGeneration
    }

    var snapshot: MirrorSnapshot {
        MirrorSnapshot(source: source, generation: generation, selectedRange: selectedRange, hasMarkedText: hasMarkedText)
    }
    var digest: String { Digest.sha256(Data(source.utf8)) }

    func select(_ range: NSRange) {
        guard Self.validRange(range, source: source) else { return }
        selectedRange = range
    }

    nonisolated static func validRange(_ range: NSRange, source: String) -> Bool {
        let units = source as NSString
        guard range.location >= 0, range.length >= 0, range.location <= units.length,
              range.length <= units.length - range.location else { return false }
        func boundary(_ index: Int) -> Bool {
            index == 0 || index == units.length || !(0xD800...0xDBFF).contains(units.character(at: index - 1)) || !(0xDC00...0xDFFF).contains(units.character(at: index))
        }
        return boundary(range.location) && boundary(range.location + range.length)
    }

    nonisolated static func applying(_ edits: [MarkdownSourceEdit], to source: String) -> String? {
        var mirror: ReaderSourceMirror
        do {
            mirror = try ReaderSourceMirror(source: source)
            var changes: [ReaderBridgeEdit] = []
            for edit in edits {
                let (end, overflow) = edit.range.location.addingReportingOverflow(edit.range.length)
                guard !overflow else { return nil }
                changes.append(.init(start: edit.range.location, end: end, text: edit.replacement, expected: edit.expected))
            }
            try mirror.apply(.init(baseGeneration: 0, generation: 1, origin: .person, edits: changes))
            return mirror.source
        } catch { return nil }
    }

    @discardableResult func apply(edits: [MarkdownSourceEdit], expectedGeneration: UInt64,
                                  selection: NSRange? = nil, actionName: String = "") -> Bool {
        guard expectedGeneration == generation, generation < UInt64(ReaderBridgeCodec.maxInteger),
              let result = Self.applying(edits, to: source),
              selection == nil || Self.validRange(selection!, source: result) else { return false }
        source = result; generation += 1
        selectedRange = selection ?? NSRange(location: min(selectedRange.location, source.utf16.count), length: 0)
        onChange?(snapshot)
        return true
    }

    @discardableResult func apply(range: NSRange, replacement: String, selection: NSRange?, actionName: String) -> Bool {
        guard Self.validRange(range, source: source) else { return false }
        return apply(edits: [.init(range: range, expected: (source as NSString).substring(with: range), replacement: replacement)],
                     expectedGeneration: generation, selection: selection, actionName: actionName)
    }

}
